/**
 * The structured-output primitive. pi-ai has no `response_format`/JSON-schema
 * mode, so schema-valid output is obtained one of two ways:
 *
 * - "tool" (default): a forced OpenAI tool call validated with TypeBox. Right for
 *   OpenAI-native local models (e.g. Qwen).
 * - "prompt-json": no tools at all — ask for a single JSON object in the text and
 *   parse it. Right for models with their OWN function-calling format (e.g.
 *   Gemma 4), where forcing an OpenAI tool sends off-distribution content the
 *   model has no native stop for and triggers a runaway generation.
 *
 * Two hard safety rails apply to every call: a finite `maxTokens` is ALWAYS sent
 * (pi-ai's provider drops the field when falsy, so omitting it removes the only
 * length cap and a degenerate local model OOMs the process), and a per-call
 * timeout aborts a hung stream. The single fragile cast (toolChoice rides on
 * OpenAICompletionsOptions, not the SimpleStreamOptions completeSimple types) is
 * localized here.
 */

import {
	type AssistantMessage,
	type Context,
	completeSimple,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type Static,
	type TextContent,
	type ThinkingLevel,
	type ToolCall,
	type TSchema,
} from "@earendil-works/pi-ai";
import type { OpenAICompletionsOptions } from "@earendil-works/pi-ai/openai-completions";
import { Compile } from "typebox/compile";

export type StructuredVia = "tool" | "prompt-json";

export class RoleOutputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RoleOutputError";
	}
}

export interface CallRoleOptions {
	apiKey: string;
	reasoning?: ThinkingLevel;
	signal?: AbortSignal;
	/** Reprompts before giving up. Default 2. */
	maxReprompts?: number;
	/** Per-call wall-clock cap (ms). Default 90000. */
	timeoutMs?: number;
	/**
	 * Output token cap. ALWAYS sent to the provider — this is the backstop that
	 * stops a runaway local model from OOMing the process. Default 1024.
	 */
	maxTokens?: number;
	/** Sampling temperature. Sent only when set; pass 0 for greedy/deterministic. */
	temperature?: number;
	/** Structured-output strategy. Default "tool". Use "prompt-json" for Gemma. */
	structuredVia?: StructuredVia;
	/** Observe every model message for usage/cost accounting. */
	onMessage?: (message: AssistantMessage) => void;
}

type ToolChoice = NonNullable<OpenAICompletionsOptions["toolChoice"]>;

function forcedToolChoice(model: Model<string>, toolName: string): ToolChoice {
	if (model.api === "anthropic-messages") {
		return { type: "tool", name: toolName } as unknown as ToolChoice;
	}
	return { type: "function", function: { name: toolName } };
}

function findToolCall(message: AssistantMessage, toolName: string): ToolCall | undefined {
	return message.content.find((b): b is ToolCall => b.type === "toolCall" && b.name === toolName);
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

function firstJsonObject(text: string): unknown {
	const start = text.indexOf("{");
	if (start === -1) return undefined;
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

/**
 * Extract the answer JSON from a reply. Harmony/channel reasoning models (this
 * local Gemma build) emit "<|channel>thought ... <channel|>" before the final
 * answer; the reasoning often echoes the schema, so parse only the tail AFTER the
 * last channel-close marker. Without a channel marker, parse the whole text.
 */
function extractJsonObject(text: string): unknown {
	const marker = "<channel|>";
	const closeIdx = text.lastIndexOf(marker);
	if (closeIdx !== -1) {
		return firstJsonObject(text.slice(closeIdx + marker.length));
	}
	return firstJsonObject(text);
}

export async function callRole<S extends TSchema>(
	model: Model<string>,
	context: Context,
	schema: S,
	toolName: string,
	description: string,
	opts: CallRoleOptions,
): Promise<Static<S>> {
	const validator = Compile(schema);
	const maxReprompts = opts.maxReprompts ?? 2;
	const timeoutMs = opts.timeoutMs ?? 90000;
	const maxTokens = opts.maxTokens ?? 1024;
	const via = opts.structuredVia ?? "tool";

	// Each call gets a fresh timeout-bound signal and an ALWAYS-set maxTokens so a
	// runaway local model is capped/aborted before it can OOM the process.
	const runComplete = async (ctx: Context, toolChoice?: ToolChoice): Promise<AssistantMessage> => {
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		if (opts.signal) {
			if (opts.signal.aborted) controller.abort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const options: SimpleStreamOptions & { toolChoice?: ToolChoice } = {
			apiKey: opts.apiKey,
			signal: controller.signal,
			timeoutMs,
			maxTokens,
		};
		if (opts.reasoning) options.reasoning = opts.reasoning;
		if (opts.temperature !== undefined) options.temperature = opts.temperature;
		if (toolChoice) options.toolChoice = toolChoice;
		try {
			return await completeSimple(model, ctx, options);
		} finally {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		}
	};

	const ensureOk = (message: AssistantMessage): void => {
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new RoleOutputError(`${toolName}: model ${message.stopReason}: ${message.errorMessage ?? "unknown"}`);
		}
	};

	const formatErrors = (value: unknown): string =>
		Array.from(validator.Errors(value))
			.slice(0, 5)
			.map((e) => e.message)
			.join("; ");

	if (via === "prompt-json") {
		const contract = `Respond with ONLY a single JSON object — no prose, no markdown code fence — for "${toolName}" (${description}) matching this JSON Schema:\n${JSON.stringify(schema)}`;
		const messages: Message[] = [...context.messages, { role: "user", content: contract, timestamp: Date.now() }];
		for (let attempt = 0; attempt <= maxReprompts; attempt++) {
			const message = await runComplete({ systemPrompt: context.systemPrompt, messages });
			opts.onMessage?.(message);
			ensureOk(message);
			const candidate = extractJsonObject(textOf(message));
			if (candidate !== undefined && validator.Check(candidate)) {
				return candidate as Static<S>;
			}
			const reason = candidate === undefined ? "no JSON object found in your reply" : formatErrors(candidate);
			messages.push({
				role: "user",
				content: `That was not valid (${reason}). Reply again with ONLY the JSON object.`,
				timestamp: Date.now(),
			});
		}
		throw new RoleOutputError(`${toolName}: no schema-valid JSON after ${maxReprompts + 1} attempts`);
	}

	// Forced-tool path (OpenAI-native models, e.g. Qwen).
	const tool = { name: toolName, description, parameters: schema };
	const messages: Message[] = [...context.messages];
	for (let attempt = 0; attempt <= maxReprompts; attempt++) {
		const message = await runComplete(
			{ systemPrompt: context.systemPrompt, messages, tools: [tool] },
			forcedToolChoice(model, toolName),
		);
		opts.onMessage?.(message);
		ensureOk(message);
		const call = findToolCall(message, toolName);
		if (call && validator.Check(call.arguments)) {
			return call.arguments as Static<S>;
		}
		const correction = call
			? `Your ${toolName} arguments did not match the required schema: ${formatErrors(call.arguments)}. Call ${toolName} again with corrected arguments.`
			: `You did not call ${toolName}. Call it now with the required arguments.`;
		messages.push({ role: "user", content: correction, timestamp: Date.now() });
	}

	// Fallback: ask for raw JSON without forcing the tool, then parse + validate.
	const fallbackMessages: Message[] = [
		...context.messages,
		{
			role: "user",
			content: `Respond with ONLY a JSON object matching the arguments of ${toolName}. No prose, no code fence.`,
			timestamp: Date.now(),
		},
	];
	const fallback = await runComplete({ systemPrompt: context.systemPrompt, messages: fallbackMessages });
	opts.onMessage?.(fallback);
	ensureOk(fallback);
	const candidate = extractJsonObject(textOf(fallback));
	if (candidate !== undefined && validator.Check(candidate)) {
		return candidate as Static<S>;
	}
	throw new RoleOutputError(
		`${toolName}: no schema-valid output after ${maxReprompts + 1} forced attempts and a text fallback`,
	);
}

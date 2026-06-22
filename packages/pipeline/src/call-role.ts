/**
 * The structured-output primitive. pi-ai has no `response_format`/JSON-schema
 * mode, so schema-valid output is obtained one of two ways:
 *
 * - "tool" (default): a forced OpenAI tool call validated with TypeBox. Right for
 *   OpenAI-native local models (e.g. Qwen).
 * - "prompt-json": no tools at all — ask for a single JSON object in the text and
 *   parse it. Right for models with their OWN function-calling format (e.g.
 *   Gemma), where forcing an OpenAI tool sends off-distribution content the model
 *   has no native stop for and triggers a runaway generation.
 *
 * Two hard safety rails apply to every call: a finite `maxTokens` is ALWAYS sent
 * (pi-ai's provider drops the field when falsy, so omitting it removes the only
 * length cap and a degenerate local model OOMs the process), and a per-call
 * timeout aborts a hung stream. toolChoice is carried on the options object even
 * though completeSimple's SimpleStreamOptions type does not list it (the
 * openai-completions provider reads it at runtime); that is localized here.
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

function forcedToolChoice(toolName: string): ToolChoice {
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
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		// Skip braces inside string literals (review findings carry code with `{`/`}`);
		// a brace-only scanner mis-closes on a lone `}` in a string value.
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
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

	// The temperature schedule across reprompts is strategy-specific:
	//
	// - prompt-json: ESCALATE toward 1 on each reprompt. At a fixed low temperature
	//   (esp. 0) a local model's reprompt attempts are near-deterministic, so output
	//   that fails to validate once fails every attempt; ramping makes the retry
	//   budget actually explore different completions. The first attempt stays at the
	//   caller's temperature (deterministic when 0); later attempts ramp toward 1.
	// - tool (forced OpenAI tool call): HOLD the caller's temperature on every
	//   attempt. A local model's forced-tool adherence DROPS as temperature rises, so
	//   escalating on reprompt — exactly when a clean tool call matters most — is
	//   counterproductive. Classification therefore stays deterministic at temp 0.
	const retryTemperature = (attempt: number): number | undefined => {
		const base = opts.temperature;
		if (via === "tool") return base;
		if (base === undefined) return attempt === 0 ? undefined : Math.min(1, attempt * 0.5);
		return Math.min(1, base + attempt * 0.5);
	};

	// Each call gets a fresh timeout-bound signal and an ALWAYS-set maxTokens so a
	// runaway local model is capped/aborted before it can OOM the process.
	const runComplete = async (
		ctx: Context,
		toolChoice?: ToolChoice,
		temperature?: number,
	): Promise<AssistantMessage> => {
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
		if (temperature !== undefined) options.temperature = temperature;
		if (toolChoice) options.toolChoice = toolChoice;
		try {
			return await completeSimple(model, ctx, options);
		} finally {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		}
	};

	// A failed response (error/aborted) is RETRYABLE within the attempt budget — a
	// local server can transiently abort or hiccup, and one such failure must not
	// kill the whole run. The exception is a caller-initiated cancellation
	// (opts.signal aborted), which is propagated immediately. Returns true when the
	// message failed (caller should retry); throws on real cancellation.
	const failedRetryable = (message: AssistantMessage): boolean => {
		if (message.stopReason !== "error" && message.stopReason !== "aborted") return false;
		if (opts.signal?.aborted === true) {
			throw new RoleOutputError(`${toolName}: model ${message.stopReason}: ${message.errorMessage ?? "cancelled"}`);
		}
		return true;
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
			const message = await runComplete(
				{ systemPrompt: context.systemPrompt, messages },
				undefined,
				retryTemperature(attempt),
			);
			opts.onMessage?.(message);
			if (failedRetryable(message)) continue; // transient failure: retry the same prompt
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
			forcedToolChoice(toolName),
			retryTemperature(attempt),
		);
		opts.onMessage?.(message);
		if (failedRetryable(message)) continue; // transient failure: retry the same prompt
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
	const fallback = await runComplete(
		{ systemPrompt: context.systemPrompt, messages: fallbackMessages },
		undefined,
		retryTemperature(maxReprompts + 1),
	);
	opts.onMessage?.(fallback);
	// failedRetryable still throws on a real cancellation; a transient failure here
	// just falls through to the schema check below (and the final throw).
	failedRetryable(fallback);
	const candidate = extractJsonObject(textOf(fallback));
	if (candidate !== undefined && validator.Check(candidate)) {
		return candidate as Static<S>;
	}
	throw new RoleOutputError(
		`${toolName}: no schema-valid output after ${maxReprompts + 1} forced attempts and a text fallback`,
	);
}

/**
 * The structured-output primitive. pi-ai has no `response_format`/JSON-schema
 * mode, so schema-valid output is obtained via a forced tool call validated with
 * TypeBox: force the tool, read the toolCall arguments (success is
 * stopReason === "toolUse"), validate, and on failure reprompt with the concrete
 * validation error, then fall back to raw-JSON-in-text. Double failure throws a
 * typed RoleOutputError the state machine routes to escalation.
 *
 * The single fragile cast (toolChoice rides on OpenAICompletionsOptions, not the
 * SimpleStreamOptions that completeSimple types) is localized here.
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
	/** Forced-tool reprompts before the text fallback. Default 2. */
	maxReprompts?: number;
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

export async function callRole<S extends TSchema>(
	model: Model<string>,
	context: Context,
	schema: S,
	toolName: string,
	description: string,
	opts: CallRoleOptions,
): Promise<Static<S>> {
	const validator = Compile(schema);
	const tool = { name: toolName, description, parameters: schema };
	const messages: Message[] = [...context.messages];
	const maxReprompts = opts.maxReprompts ?? 2;

	const buildOptions = (toolChoice?: ToolChoice): SimpleStreamOptions => {
		const options: SimpleStreamOptions & { toolChoice?: ToolChoice } = { apiKey: opts.apiKey, signal: opts.signal };
		if (opts.reasoning) options.reasoning = opts.reasoning;
		if (toolChoice) options.toolChoice = toolChoice;
		return options;
	};

	for (let attempt = 0; attempt <= maxReprompts; attempt++) {
		const ctx: Context = { systemPrompt: context.systemPrompt, messages, tools: [tool] };
		const message = await completeSimple(model, ctx, buildOptions(forcedToolChoice(model, toolName)));
		opts.onMessage?.(message);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new RoleOutputError(`${toolName}: model ${message.stopReason}: ${message.errorMessage ?? "unknown"}`);
		}
		const call = findToolCall(message, toolName);
		if (call && validator.Check(call.arguments)) {
			return call.arguments as Static<S>;
		}
		const correction = call
			? `Your ${toolName} arguments did not match the required schema: ${Array.from(validator.Errors(call.arguments))
					.slice(0, 5)
					.map((e) => e.message)
					.join("; ")}. Call ${toolName} again with corrected arguments.`
			: `You did not call ${toolName}. Call it now with the required arguments.`;
		messages.push({ role: "user", content: correction, timestamp: Date.now() });
	}

	// Fallback: ask for raw JSON without forcing the tool, then parse + validate.
	const fallbackCtx: Context = {
		systemPrompt: context.systemPrompt,
		messages: [
			...context.messages,
			{
				role: "user",
				content: `Respond with ONLY a JSON object matching the arguments of ${toolName}. No prose, no code fence.`,
				timestamp: Date.now(),
			},
		],
	};
	const fallback = await completeSimple(model, fallbackCtx, buildOptions());
	opts.onMessage?.(fallback);
	const candidate = firstJsonObject(textOf(fallback));
	if (candidate !== undefined && validator.Check(candidate)) {
		return candidate as Static<S>;
	}
	throw new RoleOutputError(
		`${toolName}: no schema-valid output after ${maxReprompts + 1} forced attempts and a text fallback`,
	);
}

/**
 * Role model construction + startup health-check. Phase 1 uses two local models,
 * both reached over the OpenAI-compatible /v1 transport (`api: "openai-completions"`).
 *
 * "OpenAI-compatible" here is about the HTTP transport only — NOT feature parity.
 * Qwen (implementer) supports native OpenAI tool calling; Gemma (reviewer) does
 * NOT (forcing a tool makes it run away), so Gate B drives Gemma via a plain chat
 * completion with JSON in the text rather than tools.
 *
 * Local models need an explicit `compat` block — localhost auto-detects to the
 * plain-OpenAI profile, which sends fields (max_completion_tokens, store,
 * tools[].strict) that llama.cpp may reject. They also require a non-empty
 * apiKey (the provider hard-throws without one) and get no env-key fallback.
 */

import { completeSimple, type Model } from "@earendil-works/pi-ai";
import type { ModelEndpoint, PipelineConfig } from "./config.ts";

export interface BuildModelOptions {
	/**
	 * Suppress a harmony/thinking model's reasoning channel. Gemma (this build)
	 * otherwise emits an unbounded `<|channel>thought` trace that loops and never
	 * reaches the answer, so a structured-output review never completes. Setting
	 * this makes the provider send `chat_template_kwargs.enable_thinking: false`
	 * (the model's chat template honors it), so it emits the answer JSON directly.
	 */
	suppressThinking?: boolean;
}

export function buildLocalModel(
	provider: string,
	ep: ModelEndpoint,
	opts: BuildModelOptions = {},
): Model<"openai-completions"> {
	return {
		id: ep.id,
		name: ep.id,
		api: "openai-completions",
		provider,
		// reasoning:true only enables the thinkingFormat code path; with no
		// reasoningEffort ever passed, enable_thinking resolves to false.
		reasoning: opts.suppressThinking === true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: ep.contextWindow,
		maxTokens: ep.maxTokens,
		baseUrl: ep.baseUrl,
		compat: {
			maxTokensField: "max_tokens",
			supportsStore: false,
			supportsStrictMode: false,
			supportsReasoningEffort: false,
			supportsDeveloperRole: false,
			supportsLongCacheRetention: false,
			...(opts.suppressThinking === true ? { thinkingFormat: "qwen-chat-template" as const } : {}),
		},
	};
}

/** The single field we read from a llama.cpp /props response. */
interface LlamaServerProps {
	default_generation_settings?: { n_ctx?: number };
}

/** Pick the live per-request context window from a /props body, else `fallback`. */
export function deriveContextWindow(props: unknown, fallback: number): number {
	const nCtx = (props as LlamaServerProps | null)?.default_generation_settings?.n_ctx;
	return typeof nCtx === "number" && Number.isFinite(nCtx) && nCtx > 0 ? nCtx : fallback;
}

/**
 * Query a llama.cpp server's /props for the real per-request context window
 * (which the server fixes at `-c / -np`). Best-effort: any failure returns
 * `fallback`, leaving a genuinely-down server for the health check to surface.
 * /props lives at the server root, not under the OpenAI /v1 path.
 */
export async function fetchContextWindow(baseUrl: string, fallback: number, signal?: AbortSignal): Promise<number> {
	const propsUrl = new URL("/props", baseUrl).toString();
	try {
		const res = await fetch(propsUrl, { signal });
		if (!res.ok) return fallback;
		return deriveContextWindow(await res.json(), fallback);
	} catch {
		return fallback;
	}
}

/**
 * Resolve each endpoint's contextWindow from its live server n_ctx so the client
 * always matches however llama.cpp was launched, instead of a hardcoded guess
 * that silently drifts. Per-endpoint best-effort: an unreachable server keeps
 * the configured fallback.
 */
export async function resolveServerContextWindows(
	config: PipelineConfig,
	signal?: AbortSignal,
): Promise<PipelineConfig> {
	const [qwen, gemma] = await Promise.all([
		fetchContextWindow(config.qwen.baseUrl, config.qwen.contextWindow, signal),
		fetchContextWindow(config.gemma.baseUrl, config.gemma.contextWindow, signal),
	]);
	return {
		...config,
		qwen: { ...config.qwen, contextWindow: qwen },
		gemma: { ...config.gemma, contextWindow: gemma },
	};
}

export interface RoleModels {
	qwen: Model<"openai-completions">;
	gemma: Model<"openai-completions">;
}

export function buildRoleModels(config: PipelineConfig): RoleModels {
	return {
		qwen: buildLocalModel("qwen-local", config.qwen),
		// Gemma (reviewer) is a thinking model whose reasoning channel loops on a
		// structured-output review; suppress it so it emits the verdict JSON directly.
		gemma: buildLocalModel("gemma-local", config.gemma, { suppressThinking: true }),
	};
}

export interface HealthTarget {
	label: string;
	model: Model<"openai-completions">;
	apiKey: string;
}

/** Ping each endpoint with a 1-token completion; throw fast on a down server. */
export async function healthCheck(targets: HealthTarget[], signal?: AbortSignal): Promise<void> {
	for (const target of targets) {
		let message: Awaited<ReturnType<typeof completeSimple>>;
		try {
			message = await completeSimple(
				target.model,
				{ messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
				{ apiKey: target.apiKey, maxTokens: 1, signal },
			);
		} catch (error) {
			throw new Error(
				`Health check failed for ${target.label} (${target.model.baseUrl}): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (message.stopReason === "error") {
			throw new Error(
				`Health check failed for ${target.label} (${target.model.baseUrl}): ${message.errorMessage ?? "unknown error"}`,
			);
		}
	}
}

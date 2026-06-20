/**
 * Role model construction + startup health-check. Phase 1: two local
 * OpenAI-compatible models only (Qwen implementer, Gemma reviewer).
 *
 * Local models need an explicit `compat` block — localhost auto-detects to the
 * plain-OpenAI profile, which sends fields (max_completion_tokens, store,
 * tools[].strict) that llama.cpp/vLLM may reject. They also require a non-empty
 * apiKey (the provider hard-throws without one) and get no env-key fallback.
 */

import { completeSimple, type Model } from "@earendil-works/pi-ai";
import type { ModelEndpoint, PipelineConfig } from "./config.ts";

export function buildLocalModel(provider: string, ep: ModelEndpoint): Model<"openai-completions"> {
	return {
		id: ep.id,
		name: ep.id,
		api: "openai-completions",
		provider,
		baseUrl: ep.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: ep.contextWindow,
		maxTokens: ep.maxTokens,
		compat: {
			maxTokensField: "max_tokens",
			supportsStore: false,
			supportsStrictMode: false,
			supportsReasoningEffort: false,
			supportsDeveloperRole: false,
			supportsLongCacheRetention: false,
		},
	};
}

export interface RoleModels {
	qwen: Model<"openai-completions">;
	gemma: Model<"openai-completions">;
}

export function buildRoleModels(config: PipelineConfig): RoleModels {
	return {
		qwen: buildLocalModel("qwen-local", config.qwen),
		gemma: buildLocalModel("gemma-local", config.gemma),
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

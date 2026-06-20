/**
 * Pipeline configuration. Local-only: two OpenAI-compatible endpoints
 * (Qwen implementer, Gemma reviewer).
 */

import { join } from "node:path";

export type SandboxMode = "none" | "os";

export interface ModelEndpoint {
	id: string;
	baseUrl: string;
	apiKey: string;
	contextWindow: number;
	maxTokens: number;
}

export interface PipelineCaps {
	/** Max implement→test rounds in Gate A. */
	gateA: number;
	/** Max review→revise rounds in Gate B. */
	gateB: number;
}

export interface PipelineConfig {
	repoRoot: string;
	runsDir: string;
	worktreesDir: string;
	baseRef: string;
	qwen: ModelEndpoint;
	gemma: ModelEndpoint;
	caps: PipelineCaps;
	sandbox: SandboxMode;
	implementerMaxTurns: number;
	commandTimeoutMs: number;
}

export interface PipelineConfigOverrides {
	runsDir?: string;
	worktreesDir?: string;
	baseRef?: string;
	qwen?: Partial<ModelEndpoint>;
	gemma?: Partial<ModelEndpoint>;
	caps?: Partial<PipelineCaps>;
	sandbox?: SandboxMode;
	implementerMaxTurns?: number;
	commandTimeoutMs?: number;
}

export function defaultConfig(repoRoot: string, overrides: PipelineConfigOverrides = {}): PipelineConfig {
	return {
		repoRoot,
		runsDir: overrides.runsDir ?? join(repoRoot, ".pi", "pipeline-runs"),
		worktreesDir: overrides.worktreesDir ?? join(repoRoot, ".pi", "pipeline-worktrees"),
		baseRef: overrides.baseRef ?? "HEAD",
		qwen: {
			id: overrides.qwen?.id ?? "Qwen3-Coder-Next",
			baseUrl: overrides.qwen?.baseUrl ?? "http://localhost:8081/v1",
			apiKey: overrides.qwen?.apiKey ?? "local",
			// Runtime n_ctx on the local server is ~24576; keep the window and the
			// per-turn output cap comfortably inside it.
			contextWindow: overrides.qwen?.contextWindow ?? 24576,
			maxTokens: overrides.qwen?.maxTokens ?? 8192,
		},
		gemma: {
			id: overrides.gemma?.id ?? "gemma-4-26B-A4B-it",
			baseUrl: overrides.gemma?.baseUrl ?? "http://localhost:8080/v1",
			apiKey: overrides.gemma?.apiKey ?? "local",
			contextWindow: overrides.gemma?.contextWindow ?? 131072,
			maxTokens: overrides.gemma?.maxTokens ?? 4096,
		},
		caps: {
			gateA: overrides.caps?.gateA ?? 4,
			gateB: overrides.caps?.gateB ?? 3,
		},
		sandbox: overrides.sandbox ?? "none",
		implementerMaxTurns: overrides.implementerMaxTurns ?? 30,
		commandTimeoutMs: overrides.commandTimeoutMs ?? 600000,
	};
}

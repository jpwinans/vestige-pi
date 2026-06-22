/**
 * Pipeline configuration. Local-only: two OpenAI-compatible endpoints
 * (Qwen implementer, Gemma reviewer).
 */

import { join } from "node:path";
import { type CompactionSettings, defaultCompactionSettings } from "./compaction.ts";

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
	/** Per-command cap (ms) for the implementer's bash tool, so a runaway command can't stall the run. */
	implementerBashTimeoutMs: number;
	/** Implementer auto-compaction (compact-and-continue when context nears the window). */
	compaction: CompactionSettings;
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
	implementerBashTimeoutMs?: number;
	compaction?: Partial<CompactionSettings>;
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
			// contextWindow is a fallback only: resolveServerContextWindows overrides
			// it from the live server n_ctx (-c / -np) at run start. This matches the
			// serve-coder.sh default (-c 98304 -np 1) for when /props is unreachable.
			contextWindow: overrides.qwen?.contextWindow ?? 98304,
			maxTokens: overrides.qwen?.maxTokens ?? 8192,
		},
		gemma: {
			id: overrides.gemma?.id ?? "gemma-4-26B-A4B-it",
			baseUrl: overrides.gemma?.baseUrl ?? "http://localhost:8080/v1",
			apiKey: overrides.gemma?.apiKey ?? "local",
			// Fallback only (see qwen above); matches serve-concurrent.sh (-c 65536 -np 1).
			contextWindow: overrides.gemma?.contextWindow ?? 65536,
			maxTokens: overrides.gemma?.maxTokens ?? 4096,
		},
		caps: {
			// Implement->test rounds. Local models often need several iterations to
			// land a green tree, so keep this generous.
			gateA: overrides.caps?.gateA ?? 8,
			gateB: overrides.caps?.gateB ?? 3,
		},
		sandbox: overrides.sandbox ?? "none",
		implementerMaxTurns: overrides.implementerMaxTurns ?? 30,
		commandTimeoutMs: overrides.commandTimeoutMs ?? 600000,
		// 120s per bash command: covers a scoped test/typecheck, kills the full
		// `npm test` suite a local model might run by mistake.
		implementerBashTimeoutMs: overrides.implementerBashTimeoutMs ?? 120000,
		compaction: { ...defaultCompactionSettings, ...overrides.compaction },
	};
}

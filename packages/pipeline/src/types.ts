/**
 * Orchestration-level types shared across stages (kept separate from schemas.ts
 * to avoid an orchestrator <-> stage import cycle).
 */

import type { DecisionEvent, Finding } from "./schemas.ts";

export type HumanDecision = "retry" | "abort";

export interface EscalationContext {
	reason: string;
	planSlug: string;
	summary: string;
	openFindings: Finding[];
}

export interface PipelineHooks {
	/** Stream decision events to a UI (TUI progress component / CLI logger). */
	onEvent?: (event: DecisionEvent) => void;
	/**
	 * Resolve a needs-human escalation. In the TUI this is a select dialog; when
	 * absent (headless), the run halts (abort).
	 */
	resolveHumanGate?: (ctx: EscalationContext) => Promise<HumanDecision>;
	/** Abort the whole run. */
	signal?: AbortSignal;
}

export type RunStatus = "done" | "failed" | "aborted";

export interface RunResult {
	status: RunStatus;
	runId: string;
	planSlug: string;
	runDir: string;
	smokePassed: boolean;
	reason?: string;
}

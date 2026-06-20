/**
 * Orchestration-level types shared across stages (kept separate from schemas.ts
 * to avoid an orchestrator <-> stage import cycle).
 */

import type { DecisionEvent, Finding } from "./schemas.ts";

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
	 * Notify the operator that the run has escalated (a cap or deadlock). Phase 1
	 * escalation always halts the run; this hook surfaces why (e.g. a TUI dialog).
	 */
	onEscalation?: (ctx: EscalationContext) => void | Promise<void>;
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

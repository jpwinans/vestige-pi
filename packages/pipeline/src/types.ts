/**
 * Orchestration-level types shared across stages (kept separate from schemas.ts
 * to avoid an orchestrator <-> stage import cycle).
 */

import type { DecisionEvent, Finding, Phase } from "./schemas.ts";

export interface EscalationContext {
	reason: string;
	planSlug: string;
	summary: string;
	openFindings: Finding[];
}

/**
 * A completed pipeline role-point, surfaced for live presentation (TUI native
 * transcript entry / CLI stdout line). Distinct from DecisionEvent (the audit
 * log): a turn carries the human-facing payload, not the journal record. The
 * implementer emits many of these per run; every other role emits one.
 */
export type PipelineTurn =
	| {
			role: "implementer";
			phase: Phase;
			attempt: number;
			text: string;
			tools: { name: string; args: Record<string, unknown> }[];
	  }
	| { role: "gate_a"; attempt: number; passed: boolean; summary: string }
	| { role: "gate_b"; attempt: number; verdict: "approve" | "request_changes"; findings: Finding[] }
	| { role: "revise"; attempt: number; fixed: number; defended: number; deferred: number }
	| { role: "red_check"; passed: boolean }
	| { role: "escalate"; reason: string }
	| { role: "done"; passed: boolean };

export interface PipelineHooks {
	/** Stream decision events to a UI (TUI progress component / CLI logger). */
	onEvent?: (event: DecisionEvent) => void;
	/**
	 * Notify the operator that the run has escalated (a cap or deadlock). Phase 1
	 * escalation always halts the run; this hook surfaces why (e.g. a TUI dialog).
	 */
	onEscalation?: (ctx: EscalationContext) => void | Promise<void>;
	/**
	 * Stream completed role-turns for live presentation (TUI native transcript
	 * entries / CLI lines). Additive to onEvent — onEvent stays the audit path.
	 */
	onTurn?: (turn: PipelineTurn) => void;
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

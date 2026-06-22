/**
 * Shared types and TypeBox schemas for the pipeline.
 *
 * Erasable-TypeScript only: phases and decision events are string-literal /
 * discriminated unions (no `enum`). Role outputs are TypeBox schemas validated
 * against either a forced tool call (OpenAI-native models like Qwen) or a JSON
 * object parsed from text (Gemma, prompt-json); pi-ai has no `response_format`.
 */

import { type Static, Type } from "@earendil-works/pi-ai";

/**
 * The phase labels carried in the decision log. `plan` is the setup stage (load,
 * health check, worktree creation) before implementation begins; the others are
 * the loop stages. The terminal outcome is carried by RunStatus, not a phase.
 */
export type Phase = "plan" | "red_check" | "implement" | "gate_a" | "gate_b" | "revise" | "escalate";

/** Machine-readable plan manifest (`plan.json`). */
export const PlanManifestSchema = Type.Object({
	slug: Type.String(),
	goal: Type.String(),
	commands: Type.Object({
		test: Type.String(),
		lint: Type.Optional(Type.String()),
		typecheck: Type.Optional(Type.String()),
		smoke: Type.Optional(Type.String()),
	}),
});
export type PlanManifest = Static<typeof PlanManifestSchema>;

export interface PlanTest {
	/** Repo-relative path the test is written to inside the worktree. */
	path: string;
	content: string;
}

/** In-memory plan after loading the plan directory. */
export interface Plan {
	slug: string;
	goal: string;
	spec: string;
	rubric: string[];
	tests: PlanTest[];
	commands: PlanManifest["commands"];
}

/**
 * A single Gate-B review finding (reviewer output). Deliberately flat with only
 * two required string fields and no literal-union enums — local models (the
 * weakest gate) degenerate on nested/enum-heavy schemas, so structure is kept
 * minimal for reliability. severity is an optional free string, normalized when
 * displayed.
 */
export const FindingSchema = Type.Object({
	rubricRef: Type.String({ description: "The rubric criterion this finding maps to" }),
	issue: Type.String({ description: "What is wrong, specifically" }),
	severity: Type.Optional(Type.String({ description: "blocker | major | minor" })),
	file: Type.Optional(Type.String()),
	line: Type.Optional(Type.Number()),
	suggestedFix: Type.Optional(Type.String()),
});

/**
 * Gemma's structured review verdict (Gate B). verdict is a free string (not a
 * literal union) for local-model reliability; it is normalized fail-closed in
 * gate-b (anything other than "approve" becomes request_changes).
 */
export const ReviewSchema = Type.Object({
	verdict: Type.String({ description: "approve | request_changes" }),
	findings: Type.Array(FindingSchema),
});
export type Review = Static<typeof ReviewSchema>;

/** A finding with an orchestrator-assigned id used by the revise protocol. */
export type Finding = Static<typeof FindingSchema> & { id: string };

/** Qwen's fix/defend/defer classification of the open findings (revise loop). */
export const ReviseSchema = Type.Object({
	decisions: Type.Array(
		Type.Object({
			findingId: Type.String(),
			action: Type.String({ description: "fix | defend | defer" }),
			rationale: Type.String({ description: "For defend: cite the constraint, test, or spec clause" }),
		}),
	),
});
export type ReviseDecisions = Static<typeof ReviseSchema>;

/** Append-only decision-log event, journaled before its side effect. */
export type DecisionEvent =
	| { type: "run_start"; runId: string; planSlug: string }
	| { type: "phase_enter"; phase: Phase; attempt: number }
	| { type: "red_check"; passed: boolean; exitCode: number }
	| { type: "implement"; attempt: number; stopReason: string }
	| { type: "gate_a"; attempt: number; passed: boolean; summary: string }
	| { type: "gate_b"; attempt: number; verdict: string; findingCount: number }
	| { type: "revise"; fixed: number; defended: number; deferred: number }
	| { type: "escalate"; reason: string }
	| { type: "done"; smokePassed: boolean }
	| { type: "usage"; role: string; model: string; tokens: number; costUsd: number }
	| { type: "error"; phase: Phase; message: string };

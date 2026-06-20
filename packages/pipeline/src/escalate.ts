/**
 * Escalation. Phase 1 has no Opus arbiter, so the ladder collapses to the human
 * gate: a cap or deadlock goes straight to the operator. In the TUI that is an
 * interactive dialog (hooks.resolveHumanGate); headless, the run halts (abort).
 */

import type { EscalationContext, HumanDecision, PipelineHooks } from "./types.ts";

export async function resolveEscalation(ctx: EscalationContext, hooks: PipelineHooks): Promise<HumanDecision> {
	if (hooks.resolveHumanGate) {
		return hooks.resolveHumanGate(ctx);
	}
	return "abort";
}

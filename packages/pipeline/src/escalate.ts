/**
 * Escalation. There is no automated arbiter in this pipeline, so a cap or
 * deadlock halts the run and notifies the operator (in the TUI, a dialog; when no
 * notification hook is supplied, the run simply halts).
 */

import type { EscalationContext, PipelineHooks } from "./types.ts";

export async function notifyEscalation(ctx: EscalationContext, hooks: PipelineHooks): Promise<void> {
	await hooks.onEscalation?.(ctx);
}

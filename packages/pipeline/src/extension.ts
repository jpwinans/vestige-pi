/**
 * Coding-agent extension: registers the /build slash command. Thin adapter that
 * runs the local pipeline out-of-band of the active agent loop and surfaces an
 * escalation (which halts the run) to the operator. The ONLY coding-agent-coupled
 * file in this package.
 */

import "@earendil-works/pi-ai";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "./config.ts";
import { runPipeline } from "./orchestrator.ts";
import type { DecisionEvent } from "./schemas.ts";
import type { EscalationContext } from "./types.ts";

function summarize(event: DecisionEvent): string {
	switch (event.type) {
		case "phase_enter":
			return `${event.phase} (attempt ${event.attempt})`;
		case "gate_a":
			return `gate A: ${event.passed ? "pass" : "fail"}`;
		case "gate_b":
			return `gate B: ${event.verdict} (${event.findingCount})`;
		default:
			return event.type;
	}
}

export default function buildExtension(pi: ExtensionAPI): void {
	pi.registerCommand("build", {
		description: "Run the local coding pipeline on a plan directory (Qwen implements, Gemma reviews)",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const planArg = args.trim();
			if (!planArg) {
				ctx.ui.notify("Usage: /build <plan-dir>", "error");
				return;
			}
			const planDir = resolve(ctx.cwd, planArg);
			const config = defaultConfig(ctx.cwd);
			const onEscalation = (escalation: EscalationContext): void => {
				ctx.ui.notify(`/build escalated and halted: ${escalation.summary}`, "error");
			};

			ctx.ui.setStatus("pipeline", "running /build...");
			try {
				const result = await runPipeline(planDir, config, {
					signal: ctx.signal,
					onEscalation,
					onEvent: (event) => ctx.ui.setStatus("pipeline", summarize(event)),
				});
				ctx.ui.notify(
					`/build ${result.status}: ${result.planSlug} — artifacts in ${result.runDir}`,
					result.status === "done" ? "info" : "error",
				);
			} finally {
				ctx.ui.setStatus("pipeline", undefined);
			}
		},
	});
}

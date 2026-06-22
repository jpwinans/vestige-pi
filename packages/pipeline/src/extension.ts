/**
 * Coding-agent extension: registers the /build slash command and a renderer that
 * draws each pipeline role-turn as a native-looking transcript message. Runs the
 * pipeline out-of-band of the active agent loop. The ONLY coding-agent-coupled
 * file in this package.
 *
 * Turns are delivered via pi.sendMessage with empty content (the payload rides in
 * details) so they render in the TUI without entering the host session's LLM
 * context; injection is gated on ctx.mode === "tui".
 */

import "@earendil-works/pi-ai";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { defaultConfig } from "./config.ts";
import { runPipeline } from "./orchestrator.ts";
import type { DecisionEvent } from "./schemas.ts";
import { makeTurnSink, PIPELINE_TURN_TYPE } from "./turn.ts";
import type { EscalationContext, PipelineTurn } from "./types.ts";

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

/** Map a finding's free-string severity (blocker/critical | major | minor) to a theme color. */
function severityColor(severity: string | undefined): "error" | "warning" | "muted" {
	const s = (severity ?? "").toLowerCase();
	if (s === "blocker" || s === "critical") return "error";
	if (s === "major") return "warning";
	return "muted";
}

/**
 * Render one pipeline turn as a pi-tui Component styled with the session theme.
 * Implementer turns mimic a native assistant message (no box); gate/verdict turns
 * are colored cards. Returning undefined falls back to pi's default box.
 */
const renderPipelineTurn: MessageRenderer<PipelineTurn> = (message, { expanded }, theme) => {
	const t = message.details;
	if (!t) return undefined;

	const card = (
		label: string,
		bg: "toolSuccessBg" | "toolErrorBg" | "customMessageBg",
	): { root: Container; box: Box } => {
		const box = new Box(1, 1, (x) => theme.bg(bg, x));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(label)), 0, 0));
		const root = new Container();
		root.addChild(new Spacer(1));
		root.addChild(box);
		return { root, box };
	};

	switch (t.role) {
		case "implementer": {
			const container = new Container();
			container.addChild(new Spacer(1));
			if (t.text.trim()) container.addChild(new Text(theme.fg("customMessageText", t.text), 0, 0));
			for (const tool of t.tools) {
				const args = JSON.stringify(tool.args).slice(0, 120);
				container.addChild(
					new Text(`${theme.fg("toolTitle", theme.bold(tool.name))} ${theme.fg("dim", args)}`, 0, 0),
				);
			}
			return container;
		}
		case "gate_a": {
			const { root, box } = card(
				`gate_a #${t.attempt} · ${t.passed ? "PASS" : "FAIL"}`,
				t.passed ? "toolSuccessBg" : "toolErrorBg",
			);
			box.addChild(new Spacer(1));
			box.addChild(new Text(theme.fg("text", t.summary), 0, 0));
			return root;
		}
		case "gate_b": {
			const approve = t.verdict === "approve";
			const { root, box } = card(
				`gate_b #${t.attempt} · ${approve ? "APPROVE" : "REQUEST_CHANGES"}`,
				approve ? "toolSuccessBg" : "toolErrorBg",
			);
			box.addChild(new Spacer(1));
			if (t.findings.length === 0) box.addChild(new Text(theme.fg("dim", "(no findings)"), 0, 0));
			for (const f of t.findings) {
				const loc = f.file ? ` ${f.file}${f.line != null ? `:${f.line}` : ""}` : "";
				box.addChild(
					new Text(
						theme.fg(severityColor(f.severity), `• [${f.rubricRef}] ${f.issue}`) + theme.fg("dim", loc),
						0,
						0,
					),
				);
				if (expanded && f.suggestedFix) box.addChild(new Text(theme.fg("dim", `    fix: ${f.suggestedFix}`), 0, 0));
			}
			return root;
		}
		case "revise": {
			const { root, box } = card(`revise #${t.attempt}`, "customMessageBg");
			box.addChild(new Spacer(1));
			box.addChild(
				new Text(
					theme.fg("customMessageText", `fixed ${t.fixed} · defended ${t.defended} · deferred ${t.deferred}`),
					0,
					0,
				),
			);
			return root;
		}
		case "red_check":
			return card(`red_check · ${t.passed ? "RED (good)" : "NOT RED"}`, t.passed ? "toolSuccessBg" : "toolErrorBg")
				.root;
		case "escalate": {
			const { root, box } = card("escalate · halted", "toolErrorBg");
			box.addChild(new Spacer(1));
			box.addChild(new Text(theme.fg("warning", t.reason), 0, 0));
			return root;
		}
		case "done":
			return card(`done · ${t.passed ? "PASS" : "FAIL"}`, t.passed ? "toolSuccessBg" : "toolErrorBg").root;
	}
};

export default function buildExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<PipelineTurn>(PIPELINE_TURN_TYPE, renderPipelineTurn);

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
			// Render native transcript turns only in the interactive TUI (not rpc/print).
			const interactive = ctx.mode === "tui";

			ctx.ui.setStatus("pipeline", "running /build...");
			try {
				const result = await runPipeline(planDir, config, {
					signal: ctx.signal,
					onEscalation,
					onEvent: (event) => ctx.ui.setStatus("pipeline", summarize(event)),
					onTurn: interactive ? makeTurnSink((message, options) => pi.sendMessage(message, options)) : undefined,
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

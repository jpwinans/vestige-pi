/**
 * Pure helpers for surfacing pipeline role-turns (no TUI / pi-tui dependency, so
 * fully unit-testable):
 * - describeImplementerTurn: extract the displayable text + tool-call summary
 *   from one implementer assistant message (thinking blocks dropped; tool RESULTS
 *   arrive as separate messages and are not part of this).
 * - formatTurnForCli: one-line (multi-line for findings) stdout rendering for the
 *   headless `pipeline run` path.
 * - makeTurnSink: adapt a turn to a pi custom message. content is empty on purpose
 *   so the turn does not enter the host session's LLM context (convertToLlm reads
 *   only content); the renderable payload rides in details, and display:true is
 *   required for the TUI to render it.
 */

import type { AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { PipelineTurn } from "./types.ts";

/** customType shared by the sink and the renderer registration. */
export const PIPELINE_TURN_TYPE = "pipeline-turn";

export function describeImplementerTurn(message: AssistantMessage): {
	text: string;
	tools: { name: string; args: Record<string, unknown> }[];
} {
	const text = message.content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n\n")
		.trim();
	const tools = message.content
		.filter((b): b is ToolCall => b.type === "toolCall")
		.map((b) => ({ name: b.name, args: b.arguments }));
	return { text, tools };
}

export function formatTurnForCli(turn: PipelineTurn): string {
	switch (turn.role) {
		case "implementer": {
			const body = turn.text ? ` ${turn.text.split("\n")[0]}` : " (tool-only)";
			const tools = turn.tools.map((t) => `\n     -> ${t.name}`).join("");
			return `   [${turn.phase} #${turn.attempt}]${body}${tools}`;
		}
		case "gate_a":
			return `   [gate_a #${turn.attempt}] ${turn.passed ? "PASS" : "FAIL"} - ${turn.summary}`;
		case "gate_b": {
			const head = `   [gate_b #${turn.attempt}] ${turn.verdict} (${turn.findings.length} findings)`;
			const lines = turn.findings.map((f) => {
				const sev = f.severity ? ` ${f.severity}` : "";
				const loc = f.file ? ` (${f.file}${f.line != null ? `:${f.line}` : ""})` : "";
				return `\n     - [${f.rubricRef}]${sev} ${f.issue}${loc}`;
			});
			return head + lines.join("");
		}
		case "revise":
			return `   [revise #${turn.attempt}] fixed ${turn.fixed} / defended ${turn.defended} / deferred ${turn.deferred}`;
		case "red_check":
			return `   [red_check] ${turn.passed ? "red (good)" : "NOT red"}`;
		case "escalate":
			return `   [escalate] ${turn.reason}`;
		case "done":
			return `   [done] smoke ${turn.passed ? "passed" : "not passed"}`;
	}
}

/** Adapter shape for pi.sendMessage, narrowed to the fields the sink uses. */
export type SendCustomMessage = (
	message: { customType: string; content: string; display: boolean; details: PipelineTurn },
	options: { triggerTurn: boolean },
) => void;

export function makeTurnSink(send: SendCustomMessage): (turn: PipelineTurn) => void {
	return (turn) =>
		send({ customType: PIPELINE_TURN_TYPE, content: "", display: true, details: turn }, { triggerTurn: false });
}

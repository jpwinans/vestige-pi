import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/schemas.ts";
import { describeImplementerTurn, formatTurnForCli, makeTurnSink, PIPELINE_TURN_TYPE } from "../src/turn.ts";
import type { PipelineTurn } from "../src/types.ts";

describe("describeImplementerTurn", () => {
	it("returns the joined, trimmed text and no tools for a text-only turn", () => {
		const result = describeImplementerTurn(fauxAssistantMessage([fauxText("  hello world  ")]));
		expect(result.text).toBe("hello world");
		expect(result.tools).toEqual([]);
	});

	it("joins multiple text blocks with a blank line", () => {
		const result = describeImplementerTurn(fauxAssistantMessage([fauxText("first"), fauxText("second")]));
		expect(result.text).toBe("first\n\nsecond");
	});

	it("returns empty text and the tool calls for a tool-only turn", () => {
		const result = describeImplementerTurn(
			fauxAssistantMessage([fauxToolCall("write", { path: "a.ts", content: "x" })]),
		);
		expect(result.text).toBe("");
		expect(result.tools).toEqual([{ name: "write", args: { path: "a.ts", content: "x" } }]);
	});

	it("preserves content order across mixed text and multiple tools", () => {
		const result = describeImplementerTurn(
			fauxAssistantMessage([
				fauxText("doing it"),
				fauxToolCall("edit", { path: "a.ts" }),
				fauxToolCall("bash", { command: "vitest" }),
			]),
		);
		expect(result.text).toBe("doing it");
		expect(result.tools).toEqual([
			{ name: "edit", args: { path: "a.ts" } },
			{ name: "bash", args: { command: "vitest" } },
		]);
	});

	it("ignores thinking blocks", () => {
		const result = describeImplementerTurn(
			fauxAssistantMessage([fauxThinking("secret reasoning"), fauxText("visible")]),
		);
		expect(result.text).toBe("visible");
		expect(result.tools).toEqual([]);
	});
});

const findings: Finding[] = [
	{ id: "f1", rubricRef: "R3", issue: "bar uses 8 cells", severity: "major", file: "bar.ts", line: 12 },
	{ id: "f2", rubricRef: "R5", issue: "tier casing" }, // no severity/file/line
];

describe("formatTurnForCli", () => {
	it("renders an implementer turn with phase, attempt, text, and tool names", () => {
		const line = formatTurnForCli({
			role: "implementer",
			phase: "implement",
			attempt: 2,
			text: "adding the bar renderer",
			tools: [{ name: "write", args: { path: "bar.ts" } }],
		});
		expect(line).toContain("implement");
		expect(line).toContain("2");
		expect(line).toContain("adding the bar renderer");
		expect(line).toContain("write");
	});

	it("renders a failing gate_a turn with the summary", () => {
		const line = formatTurnForCli({ role: "gate_a", attempt: 1, passed: false, summary: "1 failing test" });
		expect(line).toContain("gate_a");
		expect(line.toLowerCase()).toContain("fail");
		expect(line).toContain("1 failing test");
	});

	it("renders a gate_b turn with verdict, count, and each finding (tolerating missing fields)", () => {
		const line = formatTurnForCli({ role: "gate_b", attempt: 1, verdict: "request_changes", findings });
		expect(line).toContain("request_changes");
		expect(line).toContain("R3");
		expect(line).toContain("R5");
		expect(line).toContain("bar.ts");
		expect(line).toContain("tier casing");
	});

	it("renders revise counts", () => {
		const line = formatTurnForCli({ role: "revise", attempt: 1, fixed: 2, defended: 1, deferred: 0 });
		expect(line).toContain("2");
		expect(line).toContain("1");
		expect(line).toContain("0");
	});

	it("renders red_check, escalate, and done turns", () => {
		expect(formatTurnForCli({ role: "red_check", passed: true })).toContain("red_check");
		expect(formatTurnForCli({ role: "escalate", reason: "gate B cap exceeded" })).toContain("gate B cap exceeded");
		expect(formatTurnForCli({ role: "done", passed: true })).toContain("done");
	});
});

describe("makeTurnSink", () => {
	it("sends an empty-content, display:true custom message with the turn in details and no LLM turn", () => {
		const calls: {
			message: { customType: string; content: string; display: boolean; details: PipelineTurn };
			options: { triggerTurn: boolean };
		}[] = [];
		const sink = makeTurnSink((message, options) => calls.push({ message, options }));
		const turn: PipelineTurn = { role: "done", passed: true };
		sink(turn);

		expect(calls).toHaveLength(1);
		expect(calls[0].message.customType).toBe(PIPELINE_TURN_TYPE);
		expect(calls[0].message.content).toBe("");
		expect(calls[0].message.display).toBe(true);
		expect(calls[0].message.details).toBe(turn);
		expect(calls[0].options.triggerTurn).toBe(false);
	});
});

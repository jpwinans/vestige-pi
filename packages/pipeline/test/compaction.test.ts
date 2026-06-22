import { fauxAssistantMessage, fauxToolCall, type Message, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type CompactionSettings, compactMessages, findCutIndex } from "../src/compaction.ts";

const big = "x".repeat(600);

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}
function asst(text: string): Message {
	return fauxAssistantMessage(text, { stopReason: "stop" });
}
function asstCall(name: string, args: Record<string, unknown>, id = "t1"): Message {
	return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}
function toolRes(id: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function paired(messages: ReturnType<typeof user>[]): boolean {
	// every toolResult has its toolCall earlier in the SAME array, and no
	// assistant ends the array with an unmatched toolCall.
	const calls = new Set<string>();
	for (const m of messages) {
		if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall") calls.add(b.id);
		if (m.role === "toolResult" && !calls.has(m.toolCallId)) return false;
	}
	return true;
}

describe("findCutIndex", () => {
	// The real implementer transcript: ONE user message (the prompt) at index 0,
	// then assistant/toolResult turns. A cut must still be possible here.
	const singleUserTranscript = [
		user("task"), // 0 (the only user message)
		asstCall("read", { path: "a.ts" }, "t1"), // 1
		toolRes("t1", "small"), // 2
		asst("looking"), // 3
		asstCall("read", { path: "b.ts" }, "t2"), // 4
		toolRes("t2", big), // 5 big -> raw cut lands around here
		asst("done"), // 6
	];

	it("cuts at a non-toolResult boundary even when index 0 is the only user message", () => {
		const cut = findCutIndex(singleUserTranscript, 40);
		expect(cut).toBeGreaterThan(0);
		expect(singleUserTranscript[cut].role).not.toBe("toolResult");
	});

	it("never orphans a toolResult: the kept tail starts off a tool pair and head/tail each stay paired", () => {
		const cut = findCutIndex(singleUserTranscript, 40);
		const head = singleUserTranscript.slice(0, cut);
		const tail = singleUserTranscript.slice(cut);
		expect(tail[0].role).not.toBe("toolResult");
		expect(paired(head)).toBe(true);
		expect(paired(tail)).toBe(true);
	});

	it("keeps roughly keepRecentTokens in the tail", () => {
		const cut = findCutIndex(singleUserTranscript, 40);
		const tailTokens = singleUserTranscript.slice(cut).reduce((n, m) => n + JSON.stringify(m).length / 4, 0);
		expect(tailTokens).toBeGreaterThan(40);
	});

	it("returns -1 for an empty transcript", () => {
		expect(findCutIndex([], 40)).toBe(-1);
	});

	it("returns -1 when the whole transcript fits in keepRecentTokens (nothing to summarize)", () => {
		expect(findCutIndex([user("a"), asst("b")], 100000)).toBe(-1);
	});
});

const registrations: { unregister: () => void }[] = [];
afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

function faux(id: string) {
	const reg = registerFauxProvider({ models: [{ id, maxTokens: 256, contextWindow: 100000 }] });
	registrations.push(reg);
	return reg;
}

const settings: CompactionSettings = { enabled: true, reserveTokens: 1000, keepRecentTokens: 40 };

describe("compactMessages", () => {
	it("replaces the head with a plain user summary message and preserves the tail", async () => {
		const reg = faux("sum");
		reg.setResponses([fauxAssistantMessage("CONVERSATION SUMMARY", { stopReason: "stop" })]);
		const messages = [
			user("task"),
			asstCall("read", { path: "a.ts" }),
			toolRes("t1", "small"),
			asst("ok"),
			user(big),
			asst("done"),
		];
		const out = await compactMessages(messages, reg.getModel(), settings, "local");
		expect(out).not.toBeNull();
		if (!out) return;
		// summary rides in a USER message so the base Agent's defaultConvertToLlm keeps it
		expect(out.messages[0].role).toBe("user");
		expect(JSON.stringify(out.messages[0])).toContain("CONVERSATION SUMMARY");
		expect(out.summary).toBe("CONVERSATION SUMMARY");
		// the recent tail is preserved verbatim
		expect(out.messages.slice(1)).toEqual(messages.slice(4));
	});

	it("returns null when summarization fails, so the run proceeds uncompacted", async () => {
		const reg = faux("sum-fail");
		reg.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
		const messages = [
			user("task"),
			asst("a"),
			user("step2"),
			asstCall("read", {}),
			toolRes("t1", big),
			asst("after"),
		];
		expect(await compactMessages(messages, reg.getModel(), settings, "local")).toBeNull();
	});

	it("returns null without invoking the summarizer when nothing exceeds keepRecentTokens", async () => {
		const reg = faux("sum-none");
		reg.setResponses([fauxAssistantMessage("unused", { stopReason: "stop" })]);
		const messages = [user("a"), asst("b")]; // whole transcript fits in keepRecent -> cut -1
		expect(
			await compactMessages(messages, reg.getModel(), { ...settings, keepRecentTokens: 100000 }, "local"),
		).toBeNull();
		expect(reg.getPendingResponseCount()).toBe(1); // the scripted response was never consumed
	});
});

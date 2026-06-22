/**
 * Harness-grade compact-and-continue for the implementer's bare pi-agent-core
 * Agent loop (the base Agent has NO compaction; that lives in pi's harness, which
 * the implementer doesn't use). Hybrid approach:
 *
 * - REUSE the harness's message-level primitives verbatim (they operate on plain
 *   AgentMessage[] === pi-ai Message[]): estimateContextTokens / estimateTokens /
 *   shouldCompact / generateSummary / DEFAULT_COMPACTION_SETTINGS, imported from
 *   "@earendil-works/pi-agent-core/base".
 * - REIMPLEMENT only the two pieces the harness keys off UUID-bearing session
 *   entries (unavailable on a base Agent): cut-point selection (findCutIndex) and
 *   conversation replacement (compactMessages).
 *
 * Trap (documented loudly): the summary is injected as a plain USER message, NOT a
 * compactionSummary-role message. The base Agent uses defaultConvertToLlm, which
 * keeps only user/assistant/toolResult — a compactionSummary role would be
 * silently dropped, discarding the summary and corrupting context.
 */

// Import from the package ROOT, not the "/base" subpath: pi's jiti extension
// loader aliases this specifier to the workspace index.js file, so a subpath
// import resolves to "index.js/base" and fails to load. The root re-exports base.
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens, generateSummary } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

/**
 * AgentMessage (pi-ai Message plus pi's custom message variants, e.g. bash
 * execution) is the type of Agent.state.messages but is not publicly exported;
 * derive it from a harness function signature so our helpers accept it directly.
 */
type AgentMessage = Parameters<typeof estimateTokens>[0];

export interface CompactionSettings {
	/** Enable automatic compaction. */
	enabled: boolean;
	/** Tokens reserved for the summary prompt+output and the next turn's output. */
	reserveTokens: number;
	/** Approximate recent-context tokens to keep after compaction. */
	keepRecentTokens: number;
}

export const defaultCompactionSettings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };

const SUMMARY_PREFIX = "[Context compacted. Summary of the earlier conversation:]\n\n";
const SUMMARY_SUFFIX = "\n\n[End of summary — continue the task using the recent messages that follow.]";

/**
 * Choose the first message to KEEP: walk back from the end summing estimateTokens
 * until keepRecentTokens is reached, then snap to the nearest NON-toolResult
 * boundary at or before that point. The only base-Agent pairing constraint (its
 * defaultConvertToLlm keeps user/assistant/toolResult) is that the kept tail must
 * not start with an orphaned toolResult; cutting before an assistant (or user) is
 * safe — that assistant's toolCall stays paired with its following toolResults in
 * the tail, and the summarized head never ends on a dangling toolCall. Snapping to
 * a user message specifically would be wrong here: the implementer runs a single
 * prompt, so index 0 is the ONLY user message and a user-only snap could never cut.
 * Returns -1 when no safe cut leaves a non-empty head (empty input, or the whole
 * transcript fits in keepRecentTokens) — the caller then skips compaction.
 */
export function findCutIndex(messages: AgentMessage[], keepRecentTokens: number): number {
	if (messages.length === 0) return -1;
	let acc = 0;
	let rawCut = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		acc += estimateTokens(messages[i]);
		rawCut = i;
		if (acc >= keepRecentTokens) break;
	}
	for (let i = rawCut; i > 0; i--) {
		if (messages[i].role !== "toolResult") return i;
	}
	return -1;
}

/**
 * Summarize everything before the recent tail and return the replacement
 * conversation [summaryUserMessage, ...tail], or null when there is no safe cut or
 * the summarization call fails (caller proceeds uncompacted). previousSummary is
 * threaded so repeated compactions UPDATE the summary rather than re-deriving it.
 */
export async function compactMessages(
	messages: AgentMessage[],
	model: Model<string>,
	settings: CompactionSettings,
	apiKey: string,
	signal?: AbortSignal,
	previousSummary?: string,
): Promise<{ messages: AgentMessage[]; summary: string } | null> {
	const cut = findCutIndex(messages, settings.keepRecentTokens);
	if (cut <= 0) return null;
	const head = messages.slice(0, cut);
	const tail = messages.slice(cut);
	const result = await generateSummary(
		head,
		model,
		settings.reserveTokens,
		apiKey,
		undefined,
		signal,
		undefined,
		previousSummary,
		"off",
	);
	if (!result.ok) return null;
	const summary = result.value;
	const summaryMessage: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}` }],
		timestamp: Date.now(),
	};
	return { messages: [summaryMessage, ...tail], summary };
}

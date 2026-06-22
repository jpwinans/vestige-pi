/**
 * Stage 1 — the implementer (Qwen) as one pi-agent-core Agent loop confined to the
 * worktree by the SafetyGate beforeToolCall hook. Three robustness layers keep a
 * long or runaway run bounded:
 *   1. a streamFn that injects a finite per-turn maxTokens (bounds output);
 *   2. a turn cap via subscribe(turn_end)+abort (bounds loop length);
 *   3. harness-grade compact-and-continue (bounds context): a turn_end probe flags
 *      when context nears the window, prepareNextTurn summarizes the older history
 *      before the next request, and transformContext hard-truncates as a no-LLM
 *      last resort. The base Agent has no built-in compaction, so we add it.
 */

import {
	Agent,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	estimateContextTokens,
	shouldCompact,
} from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type Message, type Model, streamSimple } from "@earendil-works/pi-ai";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { type CompactionSettings, compactMessages, defaultCompactionSettings, findCutIndex } from "./compaction.ts";
import { buildImplementerSystemPrompt } from "./implementer-prompt.ts";

export interface ImplementerDeps {
	apiKey: string;
	maxTurns: number;
	beforeToolCall: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>;
	onMessage?: (message: AssistantMessage) => void;
	signal?: AbortSignal;
	/** Near-deterministic by default for reproducible edits. */
	temperature?: number;
	/** Auto-compaction settings; defaults to the harness defaults when omitted. */
	compaction?: CompactionSettings;
}

export interface ImplementResult {
	stopReason: string;
}

export async function runImplementer(
	model: Model<"openai-completions">,
	worktree: string,
	prompt: string,
	deps: ImplementerDeps,
): Promise<ImplementResult> {
	const tools = createCodingTools(worktree);
	const systemPrompt = buildImplementerSystemPrompt(worktree);
	const temperature = deps.temperature ?? 0.2;
	// reserveTokens must exceed the next turn's worst-case output (model.maxTokens,
	// injected per-turn by the streamFn) so a post-compaction request can't overflow.
	const base = deps.compaction ?? defaultCompactionSettings;
	const settings: CompactionSettings = { ...base, reserveTokens: Math.max(base.reserveTokens, model.maxTokens * 2) };

	// The Agent never forwards model.maxTokens to the wire (createLoopConfig omits
	// it; the provider drops a falsy max_tokens), so a single runaway turn is
	// unbounded and can OOM the process. Wrap streamSimple to ALWAYS inject a
	// finite per-turn cap (and a low temperature for reproducible edits).
	const agent = new Agent({
		initialState: { systemPrompt, model, thinkingLevel: "off", tools },
		getApiKey: () => deps.apiKey,
		beforeToolCall: deps.beforeToolCall,
		streamFn: (turnModel, context, options) =>
			streamSimple(turnModel, context, { ...options, maxTokens: turnModel.maxTokens, temperature }),
	});

	// Compaction hooks read agent.state.messages directly: the Agent's
	// prepareNextTurn wrapper passes only the abort signal, not the transcript.
	let needsCompaction = false;
	let previousSummary: string | undefined;
	if (settings.enabled) {
		agent.prepareNextTurn = async () => {
			if (!needsCompaction) return undefined;
			needsCompaction = false;
			try {
				const before = estimateContextTokens(agent.state.messages).tokens;
				const out = await compactMessages(
					agent.state.messages,
					model,
					settings,
					deps.apiKey,
					deps.signal,
					previousSummary,
				);
				if (!out) return undefined;
				// Skip a compaction that did not shrink the context (e.g. the recent tail
				// alone exceeds the budget, or the summary is larger than the head it
				// replaced). Applying it would waste tokens; the transformContext guard
				// is the last resort for that request.
				if (estimateContextTokens(out.messages).tokens >= before) return undefined;
				previousSummary = out.summary;
				// Write BOTH arrays: agent.state.messages has a copy-on-assign setter, so
				// this stores a slice of the compacted history for the public transcript,
				// while the returned context hands the running loop the original
				// out.messages reference. They then stay parallel via the loop's normal
				// dual-push, exactly like a non-compacted run.
				agent.state.messages = out.messages;
				return { context: { systemPrompt, messages: out.messages, tools } };
			} catch {
				return undefined; // never throw from a loop hook; proceed uncompacted
			}
		};
		// Last resort: a single huge tool result can jump past the hard limit before
		// prepareNextTurn summarizes. Drop history with NO model call (cannot 400)
		// right before the offending request. Ephemeral — guards only that request.
		agent.transformContext = async (msgs) => {
			try {
				if (estimateContextTokens(msgs).tokens <= model.contextWindow - settings.reserveTokens) return msgs;
				const cut = findCutIndex(msgs, settings.keepRecentTokens);
				if (cut <= 0) return msgs;
				const note: Message = {
					role: "user",
					content: [{ type: "text", text: "[Earlier conversation truncated to fit the context window.]" }],
					timestamp: Date.now(),
				};
				return [note, ...msgs.slice(cut)];
			} catch {
				return msgs;
			}
		};
	}

	// The Agent class exposes no turn cap, so cap by counting turns and aborting.
	let turns = 0;
	const onMessage = deps.onMessage;
	agent.subscribe((event) => {
		if (event.type === "turn_end") {
			turns += 1;
			if (turns >= deps.maxTurns) agent.abort();
			if (settings.enabled) {
				try {
					if (shouldCompact(estimateContextTokens(agent.state.messages).tokens, model.contextWindow, settings)) {
						needsCompaction = true;
					}
				} catch {
					// a probe failure must not break the loop
				}
			}
		}
		if (onMessage && event.type === "message_end" && event.message.role === "assistant") {
			onMessage(event.message);
		}
	});
	if (deps.signal) {
		deps.signal.addEventListener("abort", () => agent.abort(), { once: true });
	}

	await agent.prompt(prompt);
	const last = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
	return { stopReason: last && last.role === "assistant" ? last.stopReason : "unknown" };
}

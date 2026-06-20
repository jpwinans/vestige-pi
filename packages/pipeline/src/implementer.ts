/**
 * Stage 1 — the implementer (Qwen) as one pi-agent-core Agent loop confined to
 * the worktree by the SafetyGate beforeToolCall hook. Turn-capped via
 * shouldStopAfterTurn so a runaway local model can't loop forever.
 */

import { Agent, type BeforeToolCallContext, type BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createCodingTools } from "@earendil-works/pi-coding-agent";

const IMPLEMENTER_SYSTEM = [
	"You are an expert software engineer implementing a change against a written spec and a set of failing tests.",
	"Work inside the provided worktree only, using the file and bash tools.",
	"Make the failing tests pass without weakening them. Do NOT edit the test files. Keep changes focused on the spec.",
	"When you believe the implementation is complete and the tests will pass, stop.",
].join("\n");

export interface ImplementerDeps {
	apiKey: string;
	maxTurns: number;
	beforeToolCall: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>;
	onMessage?: (message: AssistantMessage) => void;
	signal?: AbortSignal;
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
	const agent = new Agent({
		initialState: { systemPrompt: IMPLEMENTER_SYSTEM, model, thinkingLevel: "off", tools },
		getApiKey: () => deps.apiKey,
		beforeToolCall: deps.beforeToolCall,
	});

	// The Agent class exposes no turn cap, so cap by counting turns and aborting.
	let turns = 0;
	const onMessage = deps.onMessage;
	agent.subscribe((event) => {
		if (event.type === "turn_end") {
			turns += 1;
			if (turns >= deps.maxTurns) agent.abort();
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

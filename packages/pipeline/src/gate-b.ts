/**
 * Gate B — the reviewer (Gemma). Reviews ONLY the non-testable layer against the
 * rubric. Gemma has no OpenAI tool-calling interface, so structured output is
 * obtained via the prompt-json path (no tools), greedy, with a bounded token cap.
 * The verdict is normalized fail-closed (anything but "approve" => request_changes).
 * Anti-rubber-stamp: a first-pass approve with zero findings on a substantive diff
 * is re-prompted once to name a concern or justify zero.
 */

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { callRole } from "./call-role.ts";
import { type Finding, type Plan, ReviewSchema } from "./schemas.ts";

const REVIEWER_SYSTEM = [
	"You are a skeptical senior code reviewer. You review ONLY the non-testable layer:",
	"spec conformance, design, edge cases the tests miss, readability, and safety.",
	"The automated tests and type/lint checks already passed — do not re-verify those.",
	"Default to finding concerns; a genuinely clean diff is rare. Tie every finding to a rubric criterion.",
].join("\n");

const REVIEW_DESCRIPTION = "the code review verdict and findings";

export interface GateBOptions {
	apiKey: string;
	signal?: AbortSignal;
	onMessage?: (message: AssistantMessage) => void;
	/**
	 * Output token cap for the review. Default 4096 — Gemma emits a verbose
	 * reasoning channel before the JSON answer, so the budget must cover both.
	 */
	maxTokens?: number;
}

export interface GateBResult {
	verdict: "approve" | "request_changes";
	findings: Finding[];
}

function buildReviewPrompt(plan: Plan, diff: string): string {
	const rubric = plan.rubric.map((criterion, i) => `${i + 1}. ${criterion}`).join("\n");
	return [
		"# Spec",
		plan.spec,
		"",
		"# Rubric (grade against each criterion)",
		rubric,
		"",
		"# Diff under review",
		"```diff",
		diff,
		"```",
		"",
		'Review the non-testable layer only. Give a verdict ("approve" or "request_changes") and a list of findings, each tied to a rubric criterion.',
	].join("\n");
}

function normalizeVerdict(verdict: string): "approve" | "request_changes" {
	// Fail-closed: only an explicit "approve" approves.
	return verdict.trim().toLowerCase() === "approve" ? "approve" : "request_changes";
}

export async function runGateB(
	model: Model<"openai-completions">,
	plan: Plan,
	diff: string,
	opts: GateBOptions,
): Promise<GateBResult> {
	const userPrompt = buildReviewPrompt(plan, diff);
	const callOpts = {
		apiKey: opts.apiKey,
		signal: opts.signal,
		onMessage: opts.onMessage,
		structuredVia: "prompt-json" as const,
		temperature: 0,
		maxTokens: opts.maxTokens ?? 4096,
	};

	let review = await callRole(
		model,
		{ systemPrompt: REVIEWER_SYSTEM, messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] },
		ReviewSchema,
		"review",
		REVIEW_DESCRIPTION,
		callOpts,
	);
	let verdict = normalizeVerdict(review.verdict);

	if (verdict === "approve" && review.findings.length === 0 && diff.trim().length > 0) {
		review = await callRole(
			model,
			{
				systemPrompt: REVIEWER_SYSTEM,
				messages: [
					{ role: "user", content: userPrompt, timestamp: Date.now() },
					{
						role: "user",
						content:
							"You approved with zero findings. Name at least one concrete concern tied to a rubric criterion, or explicitly justify why each rubric criterion is satisfied, then give your review again.",
						timestamp: Date.now(),
					},
				],
			},
			ReviewSchema,
			"review",
			REVIEW_DESCRIPTION,
			callOpts,
		);
		verdict = normalizeVerdict(review.verdict);
	}

	const findings: Finding[] = review.findings.map((finding, i) => ({ ...finding, id: `f${i + 1}` }));
	return { verdict, findings };
}

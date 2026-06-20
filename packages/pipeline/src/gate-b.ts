/**
 * Gate B — the reviewer (Gemma). Reviews ONLY the non-testable layer against the
 * rubric, emitting structured findings via a forced tool call. Anti-rubber-stamp:
 * a first-pass approve with zero findings on a substantive diff is re-prompted
 * once to name a concern or justify zero.
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

const REVIEW_TOOL_DESCRIPTION = "Return the structured review verdict and findings.";

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
		"Review the non-testable layer only, then call emit_review with your verdict and findings.",
	].join("\n");
}

export async function runGateB(
	model: Model<"openai-completions">,
	plan: Plan,
	diff: string,
	apiKey: string,
	signal?: AbortSignal,
	onMessage?: (message: AssistantMessage) => void,
): Promise<GateBResult> {
	const userPrompt = buildReviewPrompt(plan, diff);
	let review = await callRole(
		model,
		{ systemPrompt: REVIEWER_SYSTEM, messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] },
		ReviewSchema,
		"emit_review",
		REVIEW_TOOL_DESCRIPTION,
		{ apiKey, signal, onMessage },
	);

	if (review.verdict === "approve" && review.findings.length === 0 && diff.trim().length > 0) {
		review = await callRole(
			model,
			{
				systemPrompt: REVIEWER_SYSTEM,
				messages: [
					{ role: "user", content: userPrompt, timestamp: Date.now() },
					{
						role: "user",
						content:
							"You approved with zero findings. Name at least one concrete concern tied to a rubric criterion, or explicitly justify why each rubric criterion is satisfied, then call emit_review again.",
						timestamp: Date.now(),
					},
				],
			},
			ReviewSchema,
			"emit_review",
			REVIEW_TOOL_DESCRIPTION,
			{ apiKey, signal, onMessage },
		);
	}

	const findings: Finding[] = review.findings.map((finding, i) => ({ ...finding, id: `f${i + 1}` }));
	return { verdict: review.verdict, findings };
}

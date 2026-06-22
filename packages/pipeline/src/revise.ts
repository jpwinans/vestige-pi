/**
 * Revise loop — the disagreement protocol. The implementer classifies each
 * finding as fix / defend / defer. A defend must cite a test, spec clause, or
 * constraint; a bare defense is re-routed as still-open. Defers are written as
 * artifacts. The orchestrator then runs a repair pass for the fix + still-open
 * findings and re-runs Gate A then Gate B.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { callRole } from "./call-role.ts";
import { type Finding, ReviseSchema } from "./schemas.ts";

const DEFENSE_KEYWORDS = ["test", "spec", "constraint", "rubric", "requirement"];

function citesConstraint(rationale: string): boolean {
	const lower = rationale.toLowerCase();
	return rationale.trim().length >= 20 && DEFENSE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export interface ReviseClassification {
	toFix: Finding[];
	stillOpen: Finding[];
	deferred: Finding[];
	defended: number;
}

export async function classifyFindings(
	model: Model<"openai-completions">,
	findings: Finding[],
	apiKey: string,
	signal?: AbortSignal,
	onMessage?: (message: AssistantMessage) => void,
): Promise<ReviseClassification> {
	const prompt = [
		"You are the implementer responding to reviewer findings. For each finding, decide:",
		"- fix: you will change the code.",
		"- defend: the finding is wrong; you MUST cite the test, spec clause, or constraint that makes it wrong. A bare 'looks right' is not a defense.",
		"- defer: out of scope for this change; it will be tracked separately.",
		"",
		"Findings:",
		...findings.map(
			(finding) => `- ${finding.id} [${finding.severity ?? "?"}] (${finding.rubricRef}): ${finding.issue}`,
		),
		"",
		"Call emit_decisions with exactly one decision per finding id.",
	].join("\n");

	const result = await callRole(
		model,
		{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
		ReviseSchema,
		"emit_decisions",
		"Classify each finding as fix, defend, or defer with a rationale.",
		{ apiKey, signal, onMessage, temperature: 0 },
	);

	const byId = new Map(findings.map((finding) => [finding.id, finding]));
	const toFix: Finding[] = [];
	const stillOpen: Finding[] = [];
	const deferred: Finding[] = [];
	let defended = 0;
	const seen = new Set<string>();

	for (const decision of result.decisions) {
		const finding = byId.get(decision.findingId);
		if (!finding || seen.has(finding.id)) continue;
		seen.add(finding.id);
		const action = decision.action.trim().toLowerCase();
		if (action.startsWith("defer")) {
			deferred.push(finding);
		} else if (action.startsWith("defend")) {
			if (citesConstraint(decision.rationale)) defended += 1;
			else stillOpen.push(finding); // bare defense -> still open
		} else {
			toFix.push(finding); // "fix" or anything unrecognized -> fix
		}
	}
	// Anything the model failed to classify is treated as needing a fix.
	for (const finding of findings) {
		if (!seen.has(finding.id)) toFix.push(finding);
	}

	return { toFix, stillOpen, deferred, defended };
}

/** Persist findings to findings/<kind>/<id>.md as operator artifacts. */
async function writeFindings(runDir: string, kind: string, label: string, findings: Finding[]): Promise<void> {
	if (findings.length === 0) return;
	const dir = join(runDir, "findings", kind);
	await mkdir(dir, { recursive: true });
	for (const finding of findings) {
		const location = finding.file ? `File: ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
		const body = [
			`# ${label} finding ${finding.id}`,
			`Severity: ${finding.severity ?? "unspecified"}`,
			`Rubric: ${finding.rubricRef}`,
			location,
			"",
			finding.issue,
			finding.suggestedFix ? `\nSuggested fix: ${finding.suggestedFix}` : "",
		]
			.filter(Boolean)
			.join("\n");
		await writeFile(join(dir, `${finding.id}.md`), `${body}\n`, "utf-8");
	}
}

/** Findings the implementer punted as out of scope. */
export function writeDeferred(runDir: string, deferred: Finding[]): Promise<void> {
	return writeFindings(runDir, "deferred", "Deferred", deferred);
}

/** Non-blocking (minor) findings accepted when Gate B passed on severity. */
export function writeAccepted(runDir: string, accepted: Finding[]): Promise<void> {
	return writeFindings(runDir, "accepted", "Accepted (non-blocking)", accepted);
}

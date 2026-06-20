/**
 * The deterministic pipeline supervisor (Phase 1, local-only). A plain async
 * state machine sequences the stages; an LLM never decides control flow. Models
 * are called only at role-points (implement, review, classify). Every transition
 * and result is journaled to the decision log before its side effect.
 *
 * Phase 1 has no Anthropic leg: Stage 0 loads a human-authored plan (instead of
 * an Opus planning call) and escalation halts at the human (no Opus arbiter).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PipelineConfig } from "./config.ts";
import { DecisionLog, renderSummary } from "./decision-log.ts";
import { resolveEscalation } from "./escalate.ts";
import { redCheck, runGateA, runSmoke } from "./gate-a.ts";
import { runGateB } from "./gate-b.ts";
import { runImplementer } from "./implementer.ts";
import { buildRoleModels, healthCheck } from "./models.ts";
import { loadPlan } from "./plan-loader.ts";
import { classifyFindings, writeDeferred } from "./revise.ts";
import { makeSafetyGate } from "./safety-gate.ts";
import type { DecisionEvent, Finding, Plan } from "./schemas.ts";
import type { PipelineHooks, RunResult } from "./types.ts";
import {
	createWorktree,
	getDiff,
	pruneStaleWorktrees,
	removeWorktree,
	type Worktree,
	writePlanTests,
} from "./worktree.ts";

function generateRunId(slug: string): string {
	return `${slug}-${Date.now().toString(36)}`;
}

function buildImplementPrompt(plan: Plan): string {
	const testList = plan.tests.map((t) => `- ${t.path}`).join("\n");
	return [
		"# Spec",
		plan.spec,
		"",
		"# Failing tests to make pass (do not edit them)",
		testList,
		"",
		"Implement the change so these tests pass. Run them with the project's test command as you go.",
	].join("\n");
}

function buildRepairPrompt(plan: Plan, failureSummary: string): string {
	return [
		"The checks are still failing. Fix the implementation so they pass. Do not edit the tests.",
		"",
		"# Failures",
		failureSummary,
		"",
		`# Spec (reference)`,
		plan.spec,
	].join("\n");
}

function buildFindingsRepairPrompt(plan: Plan, findings: Finding[]): string {
	const list = findings
		.map(
			(f) =>
				`- [${f.severity}] (${f.rubricRef})${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : ""}: ${f.issue}`,
		)
		.join("\n");
	return [
		"Address these reviewer findings without breaking the passing tests:",
		"",
		list,
		"",
		"# Spec (reference)",
		plan.spec,
	].join("\n");
}

export async function runPipeline(
	planDir: string,
	config: PipelineConfig,
	hooks: PipelineHooks = {},
): Promise<RunResult> {
	const plan = await loadPlan(planDir);
	const runId = generateRunId(plan.slug);
	const runDir = join(config.runsDir, runId);
	await mkdir(runDir, { recursive: true });
	const log = await DecisionLog.open(join(runDir, "decision-log.jsonl"));
	const events: DecisionEvent[] = [];

	const emit = async (event: DecisionEvent): Promise<void> => {
		events.push(event);
		await log.append(event);
		hooks.onEvent?.(event);
	};

	const usageSink = (role: string, modelId: string) => (message: AssistantMessage) => {
		void emit({
			type: "usage",
			role,
			model: modelId,
			tokens: message.usage.totalTokens,
			costUsd: message.usage.cost.total,
		});
	};

	const escalateAndHalt = async (reason: string, openFindings: Finding[]): Promise<RunResult> => {
		await emit({ type: "phase_enter", phase: "escalate", attempt: 1 });
		const decision = await resolveEscalation(
			{ reason, planSlug: plan.slug, summary: `${reason}. Plan: ${plan.slug} — ${plan.goal}`, openFindings },
			hooks,
		);
		await emit({ type: "escalate", reason, humanDecision: decision });
		return { status: "failed", runId, planSlug: plan.slug, runDir, smokePassed: false, reason };
	};

	await writeFile(join(runDir, "spec.md"), plan.spec, "utf-8");
	await writeFile(join(runDir, "rubric.md"), plan.rubric.map((c) => `- ${c}`).join("\n"), "utf-8");

	const models = buildRoleModels(config);
	let worktree: Worktree | undefined;

	try {
		await emit({ type: "run_start", runId, planSlug: plan.slug });
		await healthCheck(
			[
				{ label: "qwen (implementer)", model: models.qwen, apiKey: config.qwen.apiKey },
				{ label: "gemma (reviewer)", model: models.gemma, apiKey: config.gemma.apiKey },
			],
			hooks.signal,
		);

		await pruneStaleWorktrees(config.repoRoot, hooks.signal);
		worktree = await createWorktree(config.repoRoot, config.worktreesDir, runId, config.baseRef, hooks.signal);
		const safetyGate = makeSafetyGate(worktree.path);

		// Stage 0 (Phase 1): plan is human-authored. Write tests and prove they fail red.
		await emit({ type: "phase_enter", phase: "red_check", attempt: 1 });
		await writePlanTests(worktree.path, plan.tests);
		const red = await redCheck(plan, worktree.path, config.commandTimeoutMs, hooks.signal);
		await emit({ type: "red_check", passed: red.passed, exitCode: red.exitCode });
		if (!red.passed) {
			return await escalateAndHalt("red-check failed: tests pass against the base tree (vacuous plan)", []);
		}

		// Gate A: implement -> test/lint/type, loop to green or cap.
		let gateASummary = "";
		let gateAPassed = false;
		for (let attempt = 1; attempt <= config.caps.gateA; attempt++) {
			await emit({ type: "phase_enter", phase: "implement", attempt });
			const prompt = attempt === 1 ? buildImplementPrompt(plan) : buildRepairPrompt(plan, gateASummary);
			const impl = await runImplementer(models.qwen, worktree.path, prompt, {
				apiKey: config.qwen.apiKey,
				maxTurns: config.implementerMaxTurns,
				beforeToolCall: safetyGate,
				onMessage: usageSink("implementer", models.qwen.id),
				signal: hooks.signal,
			});
			await emit({ type: "implement", attempt, stopReason: impl.stopReason });

			await emit({ type: "phase_enter", phase: "gate_a", attempt });
			const gateA = await runGateA(plan, worktree.path, config.commandTimeoutMs, hooks.signal);
			gateASummary = gateA.summary;
			await emit({ type: "gate_a", attempt, passed: gateA.passed, summary: gateA.summary });
			if (gateA.passed) {
				gateAPassed = true;
				break;
			}
		}
		if (!gateAPassed) {
			return await escalateAndHalt("gate A cap exceeded", []);
		}

		// Gate B: review -> revise, loop to approve or cap.
		let approved = false;
		for (let attempt = 1; attempt <= config.caps.gateB; attempt++) {
			await emit({ type: "phase_enter", phase: "gate_b", attempt });
			const diff = await getDiff(worktree.path, hooks.signal);
			const review = await runGateB(
				models.gemma,
				plan,
				diff,
				config.gemma.apiKey,
				hooks.signal,
				usageSink("reviewer", models.gemma.id),
			);
			await emit({ type: "gate_b", attempt, verdict: review.verdict, findingCount: review.findings.length });
			if (review.verdict === "approve") {
				approved = true;
				break;
			}

			await emit({ type: "phase_enter", phase: "revise", attempt });
			const classification = await classifyFindings(
				models.qwen,
				review.findings,
				config.qwen.apiKey,
				hooks.signal,
				usageSink("implementer", models.qwen.id),
			);
			await writeDeferred(runDir, classification.deferred);
			await emit({
				type: "revise",
				fixed: classification.toFix.length,
				defended: classification.defended,
				deferred: classification.deferred.length,
			});

			const toAddress = [...classification.toFix, ...classification.stillOpen];
			if (toAddress.length === 0) {
				if (attempt === config.caps.gateB) {
					return await escalateAndHalt("gate B cap exceeded with no actionable findings", review.findings);
				}
				continue;
			}

			const impl = await runImplementer(models.qwen, worktree.path, buildFindingsRepairPrompt(plan, toAddress), {
				apiKey: config.qwen.apiKey,
				maxTurns: config.implementerMaxTurns,
				beforeToolCall: safetyGate,
				onMessage: usageSink("implementer", models.qwen.id),
				signal: hooks.signal,
			});
			await emit({ type: "implement", attempt, stopReason: impl.stopReason });

			// Regression: a fix must not break Gate A.
			await emit({ type: "phase_enter", phase: "gate_a", attempt });
			const regression = await runGateA(plan, worktree.path, config.commandTimeoutMs, hooks.signal);
			await emit({ type: "gate_a", attempt, passed: regression.passed, summary: regression.summary });
			if (!regression.passed) {
				return await escalateAndHalt("revise broke Gate A", toAddress);
			}

			if (attempt === config.caps.gateB) {
				return await escalateAndHalt("gate B cap exceeded (unresolved findings)", review.findings);
			}
		}
		if (!approved) {
			return await escalateAndHalt("review not approved", []);
		}

		// Definition of Done: live-smoke through the real surface.
		const smoke = await runSmoke(plan, worktree.path, config.commandTimeoutMs, hooks.signal);
		await emit({ type: "done", smokePassed: smoke.passed });
		if (!smoke.passed) {
			return {
				status: "failed",
				runId,
				planSlug: plan.slug,
				runDir,
				smokePassed: false,
				reason: "live-smoke failed",
			};
		}
		return { status: "done", runId, planSlug: plan.slug, runDir, smokePassed: true };
	} catch (error) {
		const aborted = hooks.signal?.aborted === true;
		const message = error instanceof Error ? error.message : String(error);
		await emit({ type: "error", phase: "plan", message });
		return {
			status: aborted ? "aborted" : "failed",
			runId,
			planSlug: plan.slug,
			runDir,
			smokePassed: false,
			reason: message,
		};
	} finally {
		await writeFile(join(runDir, "summary.md"), renderSummary(plan.slug, events), "utf-8");
		if (worktree) {
			try {
				await removeWorktree(config.repoRoot, worktree, hooks.signal);
			} catch {
				// Best-effort cleanup; a stale worktree is pruned on the next run.
			}
		}
	}
}

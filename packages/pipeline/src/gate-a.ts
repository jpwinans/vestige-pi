/**
 * Gate A — the objective gate. Orchestrator-driven (not a model bash tool): runs
 * the plan's test/lint/typecheck commands via execCommand and decides pass/fail
 * from process exit codes, so the verdict is deterministic and stays out of the
 * model token budget. The same runner powers the Stage-0 red-check and the
 * Definition-of-Done live-smoke.
 *
 * Plan commands run through `bash -c` so configured commands may use shell syntax
 * (`npm run check`, `&&`, pipes). Git operations elsewhere use direct argv exec.
 */

import type { Plan } from "./schemas.ts";
import { execCommand } from "./vendor/exec.ts";

export interface CommandResult {
	name: string;
	passed: boolean;
	exitCode: number;
	output: string;
}

export interface GateAResult {
	passed: boolean;
	results: CommandResult[];
	summary: string;
}

async function run(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
	const result = await execCommand("bash", ["-c", command], cwd, { timeout: timeoutMs, signal });
	return { exitCode: result.code, output: `${result.stdout}${result.stderr}` };
}

function tail(text: string, max: number): string {
	return text.length <= max ? text : text.slice(text.length - max);
}

function distill(results: CommandResult[]): string {
	const failures = results.filter((r) => !r.passed);
	if (failures.length === 0) return "all checks passed";
	return failures.map((r) => `### ${r.name} failed (exit ${r.exitCode})\n${tail(r.output, 1500)}`).join("\n\n");
}

export async function runGateA(
	plan: Plan,
	worktree: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<GateAResult> {
	const steps: Array<{ name: string; command: string | undefined }> = [
		{ name: "test", command: plan.commands.test },
		{ name: "lint", command: plan.commands.lint },
		{ name: "typecheck", command: plan.commands.typecheck },
	];
	const results: CommandResult[] = [];
	for (const step of steps) {
		if (!step.command) continue;
		const { exitCode, output } = await run(step.command, worktree, timeoutMs, signal);
		results.push({ name: step.name, passed: exitCode === 0, exitCode, output });
	}
	const passed = results.length > 0 && results.every((r) => r.passed);
	return { passed, results, summary: distill(results) };
}

/** Red-check: the tests must FAIL against the unmodified tree (proves they test something). */
export async function redCheck(
	plan: Plan,
	worktree: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ passed: boolean; exitCode: number }> {
	const { exitCode } = await run(plan.commands.test, worktree, timeoutMs, signal);
	return { passed: exitCode !== 0, exitCode };
}

export async function runSmoke(
	plan: Plan,
	worktree: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ passed: boolean; output: string }> {
	if (!plan.commands.smoke) return { passed: true, output: "(no smoke command configured; skipped)" };
	const { exitCode, output } = await run(plan.commands.smoke, worktree, timeoutMs, signal);
	return { passed: exitCode === 0, output };
}

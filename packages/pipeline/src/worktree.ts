/**
 * Disposable git worktree lifecycle. No git-worktree primitive exists in pi, so
 * shell out via the vendored execCommand (array args, shell:false). Each run gets
 * a fresh worktree on a throwaway `pipeline/<runId>` branch; bash escapes inside
 * it are harmless because the tree is discarded at run end.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PlanTest } from "./schemas.ts";
import { type ExecResult, execCommand } from "./vendor/exec.ts";

const GIT_TIMEOUT_MS = 120000;

export interface Worktree {
	path: string;
	branch: string;
}

function git(args: string[], cwd: string, signal?: AbortSignal): Promise<ExecResult> {
	return execCommand("git", args, cwd, { signal, timeout: GIT_TIMEOUT_MS });
}

export async function pruneStaleWorktrees(repoRoot: string, signal?: AbortSignal): Promise<void> {
	await git(["worktree", "prune"], repoRoot, signal);
}

export async function createWorktree(
	repoRoot: string,
	worktreesDir: string,
	runId: string,
	baseRef: string,
	signal?: AbortSignal,
): Promise<Worktree> {
	await mkdir(worktreesDir, { recursive: true });
	const path = join(worktreesDir, runId);
	const branch = `pipeline/${runId}`;
	const result = await git(["worktree", "add", "-b", branch, path, baseRef], repoRoot, signal);
	if (result.code !== 0) {
		throw new Error(`git worktree add failed: ${(result.stderr || result.stdout).trim()}`);
	}
	return { path, branch };
}

export async function removeWorktree(repoRoot: string, worktree: Worktree, signal?: AbortSignal): Promise<void> {
	await git(["worktree", "remove", "--force", worktree.path], repoRoot, signal);
	await git(["branch", "-D", worktree.branch], repoRoot, signal);
}

/** Full diff of the worktree vs its base commit, including new files. */
export async function getDiff(worktreePath: string, signal?: AbortSignal): Promise<string> {
	await git(["add", "-A"], worktreePath, signal);
	const result = await git(["diff", "--cached"], worktreePath, signal);
	return result.stdout;
}

/** Write the plan's tests into the worktree at their mirrored repo-relative paths. */
export async function writePlanTests(worktreePath: string, tests: PlanTest[]): Promise<void> {
	for (const test of tests) {
		const full = join(worktreePath, test.path);
		await mkdir(dirname(full), { recursive: true });
		await writeFile(full, test.content, "utf-8");
	}
}

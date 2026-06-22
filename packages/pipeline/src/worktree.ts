/**
 * Disposable git worktree lifecycle. No git-worktree primitive exists in pi, so
 * shell out via the vendored execCommand (array args, shell:false). Each run gets
 * a fresh worktree on a throwaway `pipeline/<runId>` branch; bash escapes inside
 * it are harmless because the tree is discarded at run end.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
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

/**
 * Map each repo-relative dir that holds a node_modules (root = "") to a
 * {target, link} pair: an absolute symlink target in the main repo and the
 * matching path inside the worktree. Pure so the path logic is unit-testable.
 */
export function nodeModulesLinkSpecs(
	repoRoot: string,
	worktreePath: string,
	relDirs: string[],
): { target: string; link: string }[] {
	return relDirs.map((rel) => ({
		target: join(repoRoot, rel, "node_modules"),
		link: join(worktreePath, rel, "node_modules"),
	}));
}

/** Repo-relative dirs (root + each workspace package) that have a node_modules. */
async function discoverNodeModulesDirs(repoRoot: string): Promise<string[]> {
	const dirs: string[] = existsSync(join(repoRoot, "node_modules")) ? [""] : [];
	const packagesRoot = join(repoRoot, "packages");
	const entries = await readdir(packagesRoot, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "node_modules"))) {
			dirs.push(join("packages", entry.name));
		}
	}
	return dirs;
}

/**
 * Symlink the main repo's node_modules into the worktree. A git worktree checks
 * out only tracked files, so node_modules is absent — and the plan's gate commands
 * (vitest via ../../node_modules, npx biome/tsgo) would fail MODULE_NOT_FOUND.
 * node_modules is gitignored, so these symlinks never appear in getDiff and are
 * discarded with the worktree. Best-effort: a failed link is skipped.
 */
async function linkNodeModules(repoRoot: string, worktreePath: string): Promise<void> {
	const specs = nodeModulesLinkSpecs(repoRoot, worktreePath, await discoverNodeModulesDirs(repoRoot));
	for (const { target, link } of specs) {
		try {
			await mkdir(dirname(link), { recursive: true });
			await symlink(target, link, "dir");
		} catch {
			// already linked, or the package dir is absent in the worktree; skip.
		}
	}
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
	await linkNodeModules(repoRoot, path);
	return { path, branch };
}

export async function removeWorktree(repoRoot: string, worktree: Worktree, signal?: AbortSignal): Promise<void> {
	await git(["worktree", "remove", "--force", worktree.path], repoRoot, signal);
	await git(["branch", "-D", worktree.branch], repoRoot, signal);
}

/**
 * Full diff of the worktree vs its base commit, including new files. Excludes the
 * node_modules symlinks linkNodeModules creates: the repo's `node_modules/`
 * gitignore rule is directory-only and does not match a symlink, so without the
 * pathspec exclusion `git add -A` would stage them and they would pollute the
 * reviewer's diff.
 */
export async function getDiff(worktreePath: string, signal?: AbortSignal): Promise<string> {
	await git(["add", "-A"], worktreePath, signal);
	const result = await git(
		["diff", "--cached", "--", ".", ":(exclude)node_modules", ":(exclude,glob)**/node_modules"],
		worktreePath,
		signal,
	);
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

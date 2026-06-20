/**
 * Load a plan directory (authored by the build-plan skill) into the in-memory
 * Plan. Layout: plan.json (manifest), spec.md, rubric.md, tests/ (each test
 * mirrored at its repo-relative path). See .claude/skills/build-plan.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Compile } from "typebox/compile";
import { type Plan, PlanManifestSchema, type PlanTest } from "./schemas.ts";

const manifestValidator = Compile(PlanManifestSchema);

function parseRubric(raw: string): string[] {
	const items: string[] = [];
	for (const line of raw.split("\n")) {
		const match = line.match(/^\s*-\s*(?:\[[ xX]\]\s*)?(.+?)\s*$/);
		if (match?.[1]) items.push(match[1]);
	}
	return items;
}

async function collectTests(testsDir: string): Promise<PlanTest[]> {
	const out: PlanTest[] = [];
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				const content = await readFile(full, "utf-8");
				out.push({ path: relative(testsDir, full).split(sep).join("/"), content });
			}
		}
	};
	await walk(testsDir);
	return out;
}

export async function loadPlan(dir: string): Promise<Plan> {
	let manifestRaw: unknown;
	try {
		manifestRaw = JSON.parse(await readFile(join(dir, "plan.json"), "utf-8"));
	} catch (error) {
		throw new Error(
			`Cannot read ${join(dir, "plan.json")}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!manifestValidator.Check(manifestRaw)) {
		const errs = Array.from(manifestValidator.Errors(manifestRaw))
			.slice(0, 5)
			.map((e) => e.message);
		throw new Error(`Invalid plan.json: ${errs.join("; ")}`);
	}
	const manifest = manifestRaw;
	const spec = await readFile(join(dir, "spec.md"), "utf-8");
	const rubric = parseRubric(await readFile(join(dir, "rubric.md"), "utf-8"));
	const tests = await collectTests(join(dir, "tests"));
	if (tests.length === 0) throw new Error(`Plan has no tests under ${join(dir, "tests")}`);
	if (rubric.length === 0) throw new Error(`Plan rubric (${join(dir, "rubric.md")}) has no criteria`);
	return {
		slug: manifest.slug,
		goal: manifest.goal,
		spec,
		rubric,
		tests,
		commands: manifest.commands,
		liveSmokeSurface: manifest.liveSmokeSurface,
	};
}

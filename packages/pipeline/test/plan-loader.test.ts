import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlan } from "../src/plan-loader.ts";

function writePlanDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipe-plan-"));
	writeFileSync(
		join(dir, "plan.json"),
		JSON.stringify({
			slug: "demo",
			goal: "do x",
			commands: { test: "exit 1" },
		}),
	);
	writeFileSync(join(dir, "spec.md"), "# Spec\nbuild x");
	writeFileSync(join(dir, "rubric.md"), "- [ ] criterion one\n- criterion two\n");
	mkdirSync(join(dir, "tests", "packages", "x", "test"), { recursive: true });
	writeFileSync(join(dir, "tests", "packages", "x", "test", "a.test.ts"), "test contents");
	return dir;
}

describe("loadPlan", () => {
	it("loads a plan directory into the in-memory plan", async () => {
		const plan = await loadPlan(writePlanDir());
		expect(plan.slug).toBe("demo");
		expect(plan.rubric).toEqual(["criterion one", "criterion two"]);
		expect(plan.tests).toHaveLength(1);
		expect(plan.tests[0].path).toBe("packages/x/test/a.test.ts");
		expect(plan.commands.test).toBe("exit 1");
	});

	it("rejects an invalid plan.json", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pipe-bad-"));
		writeFileSync(join(dir, "plan.json"), JSON.stringify({ slug: "x" }));
		await expect(loadPlan(dir)).rejects.toThrow(/Invalid plan.json/);
	});
});

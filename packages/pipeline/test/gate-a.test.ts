import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redCheck, runGateA, runSmoke } from "../src/gate-a.ts";
import type { Plan } from "../src/schemas.ts";

const cwd = mkdtempSync(join(tmpdir(), "pipe-ga-"));

function plan(commands: Plan["commands"]): Plan {
	return { slug: "t", goal: "g", spec: "s", rubric: ["r"], tests: [], commands };
}

describe("gate A (deterministic, exit-code driven)", () => {
	it("passes when the test command exits 0", async () => {
		const result = await runGateA(plan({ test: "exit 0" }), cwd, 30000);
		expect(result.passed).toBe(true);
	});

	it("fails when the test command exits non-zero", async () => {
		const result = await runGateA(plan({ test: "exit 3" }), cwd, 30000);
		expect(result.passed).toBe(false);
		expect(result.summary).toContain("test failed");
	});

	it("red-check passes when tests fail against the base tree", async () => {
		const result = await redCheck(plan({ test: "exit 1" }), cwd, 30000);
		expect(result.passed).toBe(true);
	});

	it("red-check fails when tests already pass (vacuous)", async () => {
		const result = await redCheck(plan({ test: "exit 0" }), cwd, 30000);
		expect(result.passed).toBe(false);
	});

	it("skips smoke (pass) when no smoke command is configured", async () => {
		const result = await runSmoke(plan({ test: "exit 0" }), cwd, 30000);
		expect(result.passed).toBe(true);
	});
});

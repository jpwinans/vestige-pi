import { describe, expect, it } from "vitest";
import { hasBlockingFindings, isBlockingSeverity } from "../src/gate-b.ts";
import type { Finding } from "../src/schemas.ts";

const f = (severity: string | undefined): Finding => ({ id: "f1", rubricRef: "R1", issue: "x", severity });

describe("isBlockingSeverity", () => {
	it("treats blocker/major (and synonyms) as blocking, case-insensitively", () => {
		for (const s of ["blocker", "major", "critical", "high", "MAJOR", " Blocker "]) {
			expect(isBlockingSeverity(s)).toBe(true);
		}
	});
	it("treats minor/low/info and missing as non-blocking", () => {
		for (const s of ["minor", "low", "nit", "info", "trivial", "", undefined]) {
			expect(isBlockingSeverity(s)).toBe(false);
		}
	});
});

describe("hasBlockingFindings", () => {
	it("is false when every finding is minor", () => {
		expect(hasBlockingFindings([f("minor"), f("low")])).toBe(false);
	});
	it("is true when any finding is blocker/major", () => {
		expect(hasBlockingFindings([f("minor"), f("major")])).toBe(true);
	});
	it("is false for no findings", () => {
		expect(hasBlockingFindings([])).toBe(false);
	});
});

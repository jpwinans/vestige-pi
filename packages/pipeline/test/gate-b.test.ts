import { describe, expect, it } from "vitest";
import { gateBRoundDecision, hasBlockingFindings, isBlockingSeverity } from "../src/gate-b.ts";
import type { Finding } from "../src/schemas.ts";

const f = (severity: string | undefined): Finding => ({ id: "f1", rubricRef: "R1", issue: "x", severity });

describe("isBlockingSeverity", () => {
	it("treats blocker/major (and synonyms) as blocking, case-insensitively", () => {
		for (const s of ["blocker", "major", "critical", "high", "MAJOR", " Blocker "]) {
			expect(isBlockingSeverity(s)).toBe(true);
		}
	});
	it("treats explicit minor labels as non-blocking, case-insensitively", () => {
		for (const s of ["minor", "low", "nit", "info", "trivial", "cosmetic", "style", "MINOR", " minor "]) {
			expect(isBlockingSeverity(s)).toBe(false);
		}
	});
	it("treats missing, empty, or unrecognized severity as blocking (fail-closed)", () => {
		for (const s of [undefined, "", "   ", "unknown", "wat", "important"]) {
			expect(isBlockingSeverity(s)).toBe(true);
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
	it("treats an unlabeled finding as blocking (fail-closed)", () => {
		expect(hasBlockingFindings([f(undefined)])).toBe(true);
	});
});

describe("gateBRoundDecision", () => {
	it("accepts an approve verdict regardless of findings", () => {
		expect(gateBRoundDecision("approve", [], 1, 3)).toBe("accept");
		expect(gateBRoundDecision("approve", [f("blocker")], 1, 3)).toBe("accept");
	});
	it("accepts request_changes when no finding blocks (only minor)", () => {
		expect(gateBRoundDecision("request_changes", [f("minor"), f("low")], 1, 3)).toBe("accept");
	});
	it("revises a blocking finding while a review round is left to grade the fix", () => {
		expect(gateBRoundDecision("request_changes", [f("major")], 1, 3)).toBe("revise");
		expect(gateBRoundDecision("request_changes", [f("major")], 2, 3)).toBe("revise");
	});
	it("escalates instead of revising on the last allowed round (no wasted revise)", () => {
		expect(gateBRoundDecision("request_changes", [f("blocker")], 3, 3)).toBe("escalate_cap");
	});
	it("treats an unlabeled finding as blocking when deciding (fail-closed)", () => {
		expect(gateBRoundDecision("request_changes", [f(undefined)], 1, 3)).toBe("revise");
		expect(gateBRoundDecision("request_changes", [f(undefined)], 3, 3)).toBe("escalate_cap");
	});
});

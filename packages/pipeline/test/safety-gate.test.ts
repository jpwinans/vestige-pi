import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkToolCall, clampBashTimeout, makeSafetyGate } from "../src/safety-gate.ts";

function tmpWorktree(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pipe-wt-")));
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "a.ts"), "x");
	return dir;
}

describe("checkToolCall worktree jail", () => {
	it("allows an in-worktree relative path", () => {
		const wt = tmpWorktree();
		expect(checkToolCall("edit", { path: "src/a.ts" }, wt).block).toBe(false);
	});

	it("blocks an absolute path outside the worktree", () => {
		const wt = tmpWorktree();
		expect(checkToolCall("write", { path: "/etc/passwd" }, wt).block).toBe(true);
	});

	it("blocks ../ traversal", () => {
		const wt = tmpWorktree();
		expect(checkToolCall("read", { path: "../../escape.ts" }, wt).block).toBe(true);
	});

	it("blocks an in-worktree symlink that points outside (canonicalization)", () => {
		const wt = tmpWorktree();
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "pipe-out-")));
		writeFileSync(join(outside, "secret.txt"), "s");
		symlinkSync(outside, join(wt, "link"));
		expect(checkToolCall("read", { path: "link/secret.txt" }, wt).block).toBe(true);
	});

	it("default-denies unknown tools", () => {
		const wt = tmpWorktree();
		expect(checkToolCall("danger", { path: "src/a.ts" }, wt).block).toBe(true);
	});

	it("allows bash without path checking", () => {
		const wt = tmpWorktree();
		expect(checkToolCall("bash", { command: "ls" }, wt).block).toBe(false);
	});
});

describe("clampBashTimeout", () => {
	it("defaults to the cap when no timeout is given", () => {
		expect(clampBashTimeout(undefined, 120)).toBe(120);
	});
	it("keeps a smaller caller-provided timeout", () => {
		expect(clampBashTimeout(10, 120)).toBe(10);
	});
	it("caps an oversized timeout", () => {
		expect(clampBashTimeout(99999, 120)).toBe(120);
	});
	it("rejects non-positive / non-number timeouts", () => {
		expect(clampBashTimeout(0, 120)).toBe(120);
		expect(clampBashTimeout(-5, 120)).toBe(120);
		expect(clampBashTimeout("nope", 120)).toBe(120);
	});
});

describe("makeSafetyGate bash timeout enforcement", () => {
	it("injects a bounded timeout (seconds) into bash args so a runaway command can't stall the run", async () => {
		const gate = makeSafetyGate("/wt", 120);
		const args: { command: string; timeout?: number } = { command: "npm test" };
		const result = await gate({ toolCall: { name: "bash" }, args } as never);
		expect(result).toBeUndefined(); // allowed
		expect(args.timeout).toBe(120); // timeout was injected by reference
	});

	it("does not touch non-bash tool args", async () => {
		const gate = makeSafetyGate("/wt", 120);
		const args: Record<string, unknown> = { path: "src/a.ts" };
		await gate({ toolCall: { name: "read" }, args } as never);
		expect(args.timeout).toBeUndefined();
	});
});

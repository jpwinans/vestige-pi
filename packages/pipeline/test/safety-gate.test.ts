import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkToolCall } from "../src/safety-gate.ts";

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

import { describe, expect, it } from "vitest";
import { buildImplementerSystemPrompt } from "../src/implementer-prompt.ts";

describe("buildImplementerSystemPrompt", () => {
	it("anchors the implementer to the absolute worktree path", () => {
		const prompt = buildImplementerSystemPrompt("/repo/.pi/pipeline-worktrees/run1");
		expect(prompt).toContain("/repo/.pi/pipeline-worktrees/run1");
	});

	it("states that spec paths are relative to the worktree and forbids leaving it", () => {
		const prompt = buildImplementerSystemPrompt("/wt").toLowerCase();
		expect(prompt).toContain("relative");
		// must warn against operating on another directory / repository
		expect(prompt).toMatch(/do not|never|only/);
	});
});

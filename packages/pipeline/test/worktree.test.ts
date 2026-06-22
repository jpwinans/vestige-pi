import { describe, expect, it } from "vitest";
import { nodeModulesLinkSpecs } from "../src/worktree.ts";

describe("nodeModulesLinkSpecs", () => {
	it("maps each repo node_modules dir to a worktree-local symlink with absolute target", () => {
		const specs = nodeModulesLinkSpecs("/repo", "/repo/.pi/wt/run1", ["", "packages/coding-agent"]);
		expect(specs).toEqual([
			{ target: "/repo/node_modules", link: "/repo/.pi/wt/run1/node_modules" },
			{
				target: "/repo/packages/coding-agent/node_modules",
				link: "/repo/.pi/wt/run1/packages/coding-agent/node_modules",
			},
		]);
	});

	it("returns an empty list when there are no node_modules dirs", () => {
		expect(nodeModulesLinkSpecs("/repo", "/repo/wt", [])).toEqual([]);
	});
});

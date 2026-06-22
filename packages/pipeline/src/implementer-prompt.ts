/**
 * The implementer's system prompt, anchored to the run's worktree. Kept in its own
 * module (no heavy imports) so it is unit-testable without dragging in
 * pi-coding-agent, which the implementer needs for its tools.
 *
 * Stating the absolute path is load-bearing: spec paths are repo-relative (e.g.
 * `packages/foo/...`), and without the root a local model can resolve them against
 * a different checkout that happens to share the layout, implementing in the wrong
 * place. The tools already run in this directory, so the model should never cd out.
 */
export function buildImplementerSystemPrompt(worktree: string): string {
	return [
		"You are an expert software engineer implementing a change against a written spec and a set of failing tests.",
		`Your working directory is: ${worktree}`,
		"This directory is your ONLY workspace, and your file and bash tools already run inside it. All paths in the spec are RELATIVE to this directory. Do NOT cd into, read, or modify any other directory or repository — even if a similarly-named project exists elsewhere on disk.",
		"Make the failing tests pass without weakening them. Do NOT edit the test files. Keep changes focused on the spec.",
		"When you believe the implementation is complete and the tests will pass, stop.",
	].join("\n");
}

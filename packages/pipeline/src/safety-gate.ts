/**
 * SafetyGate: a beforeToolCall worktree jail for the implementer Agent. Default-
 * deny on unknown tools; for path-bearing tools, canonicalize both the resolved
 * path and the worktree root (closing the in-worktree symlink-escape gap that the
 * lexical resolvePath alone would miss), then require containment.
 *
 * Bash is allowed but not path-checked — Phase 1 relies on the disposable
 * worktree, not command-string parsing, for bash confinement. The gate also
 * bounds bash execution time (a local model can run a runaway command such as the
 * full `npm test` suite that never returns and stalls the whole pipeline).
 */

import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { canonicalizePath, getCwdRelativePath, resolvePath } from "./vendor/paths.ts";

// The implementer's toolset is exactly createCodingTools = read/bash/edit/write.
// Anything else is default-denied; the path-bearing tools are read/edit/write.
const ALLOWED_TOOLS = new Set(["read", "bash", "edit", "write"]);
const PATH_TOOLS = new Set(["read", "edit", "write"]);
const PATH_ARG_KEYS = ["path", "file", "filePath", "file_path"];

export interface GateDecision {
	block: boolean;
	reason?: string;
}

function firstPathArg(input: Record<string, unknown>): string | undefined {
	for (const key of PATH_ARG_KEYS) {
		const value = input[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

/** Pure policy check — unit-tested against concrete escape vectors. */
export function checkToolCall(toolName: string, input: Record<string, unknown>, worktree: string): GateDecision {
	if (!ALLOWED_TOOLS.has(toolName)) {
		return { block: true, reason: `Tool '${toolName}' is not allowed for the implementer` };
	}
	if (!PATH_TOOLS.has(toolName)) return { block: false };

	const rawPath = firstPathArg(input);
	if (rawPath === undefined) return { block: false };

	const worktreeReal = canonicalizePath(worktree);
	const resolvedReal = canonicalizePath(resolvePath(rawPath, worktree));
	if (getCwdRelativePath(resolvedReal, worktreeReal) === undefined) {
		return { block: true, reason: `Path escapes the run worktree: ${rawPath}` };
	}
	return { block: false };
}

/** Default per-command bash timeout cap (seconds) when none is configured. */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

/** Bounded bash timeout (seconds): keep a smaller caller value, else use the cap. */
export function clampBashTimeout(current: unknown, maxSeconds: number): number {
	return typeof current === "number" && current > 0 && current <= maxSeconds ? current : maxSeconds;
}

/**
 * Adapt the policy to the Agent's beforeToolCall hook. For bash, inject a bounded
 * `timeout` (seconds) into the validated args by reference — the agent loop passes
 * the same args object to the tool's execute (verified), and the bash tool honors
 * `args.timeout` — so a command without (or with an excessive) timeout is capped.
 */
export function makeSafetyGate(worktree: string, maxBashSeconds: number = DEFAULT_BASH_TIMEOUT_SECONDS) {
	return async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
		const input = (ctx.args ?? {}) as Record<string, unknown>;
		if (ctx.toolCall.name === "bash") {
			input.timeout = clampBashTimeout(input.timeout, maxBashSeconds);
		}
		const decision = checkToolCall(ctx.toolCall.name, input, worktree);
		return decision.block ? { block: true, reason: decision.reason } : undefined;
	};
}

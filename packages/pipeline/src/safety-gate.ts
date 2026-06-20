/**
 * SafetyGate: a beforeToolCall worktree jail for the implementer Agent. Default-
 * deny on unknown tools; for path-bearing tools, canonicalize both the resolved
 * path and the worktree root (closing the in-worktree symlink-escape gap that the
 * lexical resolvePath alone would miss), then require containment.
 *
 * Bash is allowed but not path-checked — Phase 1 relies on the disposable
 * worktree, not command-string parsing, for bash confinement.
 */

import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { canonicalizePath, getCwdRelativePath, resolvePath } from "./vendor/paths.ts";

const ALLOWED_TOOLS = new Set(["read", "edit", "write", "multiedit", "bash", "ls", "grep", "find"]);
const PATH_TOOLS = new Set(["read", "edit", "write", "multiedit", "ls"]);
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

export type SafetyAudit = (toolName: string, decision: GateDecision) => void;

/** Adapt the policy to the Agent's beforeToolCall hook. */
export function makeSafetyGate(worktree: string, audit?: SafetyAudit) {
	return async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
		const input = (ctx.args ?? {}) as Record<string, unknown>;
		const decision = checkToolCall(ctx.toolCall.name, input, worktree);
		audit?.(ctx.toolCall.name, decision);
		return decision.block ? { block: true, reason: decision.reason } : undefined;
	};
}

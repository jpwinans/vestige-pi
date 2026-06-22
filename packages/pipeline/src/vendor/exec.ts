/**
 * Vendored command execution.
 *
 * Adapted from packages/coding-agent/src/core/exec.ts (not exported from that
 * package's public entry point). Frozen copy: depend only on pi's public API,
 * vendor the few internals that are not exported. Kept self-contained — uses the
 * "close" event instead of the upstream waitForChildProcess helper.
 *
 * Provenance: packages/coding-agent/src/core/exec.ts @ main.
 */

import { spawn } from "node:child_process";

export interface ExecOptions {
	/** AbortSignal to cancel the command. */
	signal?: AbortSignal;
	/** Timeout in milliseconds. */
	timeout?: number;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Execute a command (array args, never a shell string) in `cwd` and resolve with
 * stdout/stderr/exit-code. Supports an AbortSignal and a timeout. Never rejects —
 * a spawn error resolves with code 1 so callers branch on the exit code.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (killed) return;
			killed = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
		};

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			if (options?.signal) options.signal.removeEventListener("abort", killProcess);
		};

		const settle = (code: number) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ stdout, stderr, code, killed });
		};

		if (options?.signal) {
			if (options.signal.aborted) killProcess();
			else options.signal.addEventListener("abort", killProcess, { once: true });
		}

		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(killProcess, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("error", () => settle(1));
		proc.on("close", (code) => settle(code ?? (killed ? 124 : 0)));
	});
}

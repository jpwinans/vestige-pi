#!/usr/bin/env node
/**
 * CLI entrypoint: `pipeline run <plan-dir>`. Headless driver over runPipeline.
 * Imports pi-ai first so the built-in API providers register before any model
 * call.
 */

import "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { defaultConfig } from "./config.ts";
import { runPipeline } from "./orchestrator.ts";
import type { DecisionEvent } from "./schemas.ts";
import { formatTurnForCli } from "./turn.ts";

function formatEvent(event: DecisionEvent): string {
	switch (event.type) {
		case "phase_enter":
			return `-> ${event.phase} (attempt ${event.attempt})`;
		case "red_check":
			return `   red-check: ${event.passed ? "red (good)" : "NOT red"} (exit ${event.exitCode})`;
		case "gate_a":
			return `   gate A attempt ${event.attempt}: ${event.passed ? "pass" : "fail"}`;
		case "gate_b":
			return `   gate B attempt ${event.attempt}: ${event.verdict} (${event.findingCount} findings)`;
		case "revise":
			return `   revise: ${event.fixed} fix / ${event.defended} defend / ${event.deferred} defer`;
		case "escalate":
			return `   escalate (halting): ${event.reason}`;
		case "done":
			return `   done: smoke ${event.smokePassed ? "passed" : "not passed"}`;
		case "error":
			return `   error: ${event.message}`;
		default:
			return `   ${event.type}`;
	}
}

function printUsage(): void {
	console.log("Usage: pipeline run <plan-dir>");
}

async function main(): Promise<void> {
	const [command, planArg] = process.argv.slice(2);
	if (command === "--help" || command === "help") {
		printUsage();
		return;
	}
	if (command !== "run" || !planArg) {
		printUsage();
		process.exitCode = 1;
		return;
	}
	const planDir = resolve(process.cwd(), planArg);
	const config = defaultConfig(process.cwd());
	// onEvent logs the FSM structure (phases, usage); onTurn adds the per-turn
	// content (implementer text + tool calls, reviewer findings).
	const result = await runPipeline(planDir, config, {
		onEvent: (event) => console.log(formatEvent(event)),
		onTurn: (turn) => console.log(formatTurnForCli(turn)),
	});
	console.log("");
	console.log(`${result.status.toUpperCase()}: ${result.planSlug} (run ${result.runId})`);
	if (result.reason) console.log(`Reason: ${result.reason}`);
	console.log(`Artifacts: ${result.runDir}`);
	process.exitCode = result.status === "done" ? 0 : 1;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

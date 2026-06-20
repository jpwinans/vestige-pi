/**
 * Append-only JSONL audit log: a versioned header line followed by one JSON
 * object per line, each event journaled before its side effect. It is the run's
 * audit trail and the source for the rendered summary.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DecisionEvent } from "./schemas.ts";

const LOG_VERSION = 1;

export class DecisionLog {
	private readonly path: string;
	private seq = 0;

	constructor(path: string) {
		this.path = path;
	}

	static async open(path: string): Promise<DecisionLog> {
		await mkdir(dirname(path), { recursive: true });
		const header = JSON.stringify({ type: "header", version: LOG_VERSION, timestamp: Date.now() });
		await appendFile(path, `${header}\n`);
		return new DecisionLog(path);
	}

	async append(event: DecisionEvent): Promise<void> {
		const line = JSON.stringify({ seq: this.seq++, timestamp: Date.now(), ...event });
		await appendFile(this.path, `${line}\n`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Read the events back (header skipped) for replay/summary. */
export async function readDecisionLog(path: string): Promise<DecisionEvent[]> {
	const raw = await readFile(path, "utf-8");
	const events: DecisionEvent[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || typeof parsed.type !== "string" || parsed.type === "header") continue;
		events.push(parsed as unknown as DecisionEvent);
	}
	return events;
}

/** Render a human-readable run summary (summary.md). */
export function renderSummary(slug: string, events: DecisionEvent[]): string {
	const gateA = events.filter((e) => e.type === "gate_a");
	const gateB = events.filter((e) => e.type === "gate_b");
	const escalations = events.filter((e) => e.type === "escalate");
	const usage = events.filter((e): e is Extract<DecisionEvent, { type: "usage" }> => e.type === "usage");
	const done = events.find((e): e is Extract<DecisionEvent, { type: "done" }> => e.type === "done");

	const tokensByRole = new Map<string, number>();
	for (const u of usage) {
		tokensByRole.set(u.role, (tokensByRole.get(u.role) ?? 0) + u.tokens);
	}

	const outcome = done ? (done.smokePassed ? "DONE (live-smoke passed)" : "DONE (smoke not passed)") : "not completed";
	const lines = [
		`# Pipeline run: ${slug}`,
		"",
		`- Outcome: ${outcome}`,
		`- Gate A rounds: ${gateA.length}`,
		`- Gate B rounds: ${gateB.length}`,
		`- Escalations: ${escalations.length}`,
		"",
		"## Tokens by role",
		...[...tokensByRole.keys()].map((role) => `- ${role}: ${tokensByRole.get(role) ?? 0} tokens`),
	];
	return `${lines.join("\n")}\n`;
}

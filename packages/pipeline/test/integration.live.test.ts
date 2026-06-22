/**
 * Live integration test against the local model servers (Qwen :8081, Gemma :8080).
 *
 * This is the layer the faux unit tests cannot cover: whether the LOCAL models
 * reliably emit valid structured output (Qwen via a forced tool, Gemma via
 * prompt-json — the named #1 risk) and that the real provider/compat wiring works
 * end to end.
 *
 * Gating follows the repo's local-LLM convention: it runs on a direct `vitest`
 * when both endpoints are reachable, and is skipped under `./test.sh` (which sets
 * PI_NO_LOCAL_LLM=1) or when the servers are down. Override endpoints/ids with
 * PIPELINE_QWEN_URL / PIPELINE_GEMMA_URL / PIPELINE_QWEN_ID / PIPELINE_GEMMA_ID.
 */

import { execSync } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { callRole } from "../src/call-role.ts";
import { runGateB } from "../src/gate-b.ts";
import { buildLocalModel, healthCheck } from "../src/models.ts";
import type { Plan } from "../src/schemas.ts";

const QWEN_URL = process.env.PIPELINE_QWEN_URL ?? "http://localhost:8081/v1";
const GEMMA_URL = process.env.PIPELINE_GEMMA_URL ?? "http://localhost:8080/v1";
const QWEN_ID = process.env.PIPELINE_QWEN_ID ?? "Qwen3-Coder-Next";
const GEMMA_ID = process.env.PIPELINE_GEMMA_ID ?? "gemma-4-26B-A4B-it";
const API_KEY = "local";
const TIMEOUT = 120000;

function reachable(baseUrl: string): boolean {
	try {
		// `-s` (not `-f`): a connection succeeds even if /models returns a non-2xx,
		// so this is a port-open probe, robust to server-specific endpoints.
		execSync(`curl -s -m 2 -o /dev/null ${baseUrl}/models`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const LIVE = !process.env.PI_NO_LOCAL_LLM && reachable(QWEN_URL) && reachable(GEMMA_URL);

const qwen = buildLocalModel("qwen-local", {
	id: QWEN_ID,
	baseUrl: QWEN_URL,
	apiKey: API_KEY,
	contextWindow: 262144,
	maxTokens: 16384,
});
const gemma = buildLocalModel("gemma-local", {
	id: GEMMA_ID,
	baseUrl: GEMMA_URL,
	apiKey: API_KEY,
	contextWindow: 131072,
	maxTokens: 2048,
});

const AnswerSchema = Type.Object({ answer: Type.String() });

describe.skipIf(!LIVE)("pipeline live integration (local Qwen + Gemma)", () => {
	it(
		"health-checks both local endpoints",
		async () => {
			await expect(
				healthCheck([
					{ label: "qwen", model: qwen, apiKey: API_KEY },
					{ label: "gemma", model: gemma, apiKey: API_KEY },
				]),
			).resolves.toBeUndefined();
		},
		TIMEOUT,
	);

	it(
		"callRole gets schema-valid forced-tool output from Qwen (OpenAI-native)",
		async () => {
			const result = await callRole(
				qwen,
				{
					messages: [
						{ role: "user", content: "Reply with the word pong in the answer field.", timestamp: Date.now() },
					],
				},
				AnswerSchema,
				"reply",
				"Return your reply in the answer field.",
				{ apiKey: API_KEY, maxTokens: 128, timeoutMs: 60000 },
			);
			expect(typeof result.answer).toBe("string");
			expect(result.answer.length).toBeGreaterThan(0);
		},
		TIMEOUT,
	);

	it(
		"callRole gets schema-valid prompt-json output from Gemma (no tools)",
		async () => {
			const result = await callRole(
				gemma,
				{
					messages: [
						{ role: "user", content: "Reply with the word pong in the answer field.", timestamp: Date.now() },
					],
				},
				AnswerSchema,
				"reply",
				"Return your reply in the answer field.",
				{ apiKey: API_KEY, structuredVia: "prompt-json", temperature: 0, maxTokens: 512, timeoutMs: 60000 },
			);
			expect(typeof result.answer).toBe("string");
			expect(result.answer.length).toBeGreaterThan(0);
		},
		TIMEOUT,
	);

	it(
		"Gate B produces a bounded structured review from Gemma",
		async () => {
			const plan: Plan = {
				slug: "live",
				goal: "Add an isEven(n) helper",
				spec: "Add `isEven(n: number): boolean` that returns true for even integers, including negatives.",
				rubric: ["isEven handles negative numbers correctly", "implementation does not use `any`"],
				tests: [],
				commands: { test: "true" },
			};
			const diff = [
				"```diff",
				"+export function isEven(n: number): boolean {",
				"+  return n % 2 === 1; // intentionally wrong: returns odd",
				"+}",
				"```",
			].join("\n");
			// Bounded maxTokens — the prompt-json path + finite cap means a misbehaving
			// model fails gracefully (RoleOutputError) instead of OOMing the process.
			const review = await runGateB(gemma, plan, diff, { apiKey: API_KEY, maxTokens: 4096 });
			expect(["approve", "request_changes"]).toContain(review.verdict);
			expect(Array.isArray(review.findings)).toBe(true);
		},
		TIMEOUT,
	);
});

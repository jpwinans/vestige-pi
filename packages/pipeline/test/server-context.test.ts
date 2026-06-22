import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalModel, deriveContextWindow, fetchContextWindow } from "../src/models.ts";

const endpoint = {
	id: "m",
	baseUrl: "http://localhost:8080/v1",
	apiKey: "local",
	contextWindow: 65536,
	maxTokens: 4096,
};

describe("buildLocalModel", () => {
	it("defaults to a non-reasoning model with no thinkingFormat", () => {
		const model = buildLocalModel("p", endpoint);
		expect(model.reasoning).toBe(false);
		expect(model.compat?.thinkingFormat).toBeUndefined();
	});

	it("suppressThinking enables the chat-template thinking control so enable_thinking can be sent false", () => {
		const model = buildLocalModel("p", endpoint, { suppressThinking: true });
		// reasoning:true only turns on the thinkingFormat code path; with no
		// reasoningEffort passed at call time, the provider sends enable_thinking:false.
		expect(model.reasoning).toBe(true);
		expect(model.compat?.thinkingFormat).toBe("qwen-chat-template");
	});
});

describe("deriveContextWindow", () => {
	it("reads default_generation_settings.n_ctx", () => {
		expect(deriveContextWindow({ default_generation_settings: { n_ctx: 98304 } }, 4096)).toBe(98304);
	});

	it("falls back when n_ctx is absent", () => {
		expect(deriveContextWindow({ default_generation_settings: {} }, 4096)).toBe(4096);
		expect(deriveContextWindow({}, 4096)).toBe(4096);
		expect(deriveContextWindow(null, 4096)).toBe(4096);
	});

	it("falls back on a non-positive or non-finite n_ctx", () => {
		expect(deriveContextWindow({ default_generation_settings: { n_ctx: 0 } }, 4096)).toBe(4096);
		expect(deriveContextWindow({ default_generation_settings: { n_ctx: -1 } }, 4096)).toBe(4096);
		expect(deriveContextWindow({ default_generation_settings: { n_ctx: Number.NaN } }, 4096)).toBe(4096);
	});
});

describe("fetchContextWindow", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("queries /props at the server root (not under /v1) and returns the live n_ctx", async () => {
		let requested = "";
		vi.stubGlobal("fetch", async (url: string) => {
			requested = url;
			return { ok: true, json: async () => ({ default_generation_settings: { n_ctx: 65536 } }) };
		});
		const ctx = await fetchContextWindow("http://localhost:8080/v1", 4096);
		expect(ctx).toBe(65536);
		expect(requested).toBe("http://localhost:8080/props");
	});

	it("falls back to the configured window when the server is unreachable", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("ECONNREFUSED");
		});
		expect(await fetchContextWindow("http://localhost:8081/v1", 24576)).toBe(24576);
	});

	it("falls back on a non-ok response", async () => {
		vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => ({}) }));
		expect(await fetchContextWindow("http://localhost:8081/v1", 24576)).toBe(24576);
	});
});

import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	Type,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { callRole, RoleOutputError } from "../src/call-role.ts";

const registrations: FauxProviderRegistration[] = [];

function faux(): FauxProviderRegistration {
	const registration = registerFauxProvider();
	registrations.push(registration);
	return registration;
}

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

const Schema = Type.Object({ answer: Type.String() });
const userMessage = { role: "user" as const, content: "go", timestamp: 1 };

describe("callRole", () => {
	it("returns validated args from a forced tool call", async () => {
		const reg = faux();
		reg.setResponses([fauxAssistantMessage([fauxToolCall("emit", { answer: "ok" })], { stopReason: "toolUse" })]);
		const result = await callRole(reg.getModel(), { messages: [userMessage] }, Schema, "emit", "desc", {
			apiKey: "local",
		});
		expect(result.answer).toBe("ok");
	});

	it("reprompts on invalid args, then accepts the corrected call", async () => {
		const reg = faux();
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("emit", { wrong: 1 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("emit", { answer: "fixed" })], { stopReason: "toolUse" }),
		]);
		const result = await callRole(reg.getModel(), { messages: [userMessage] }, Schema, "emit", "desc", {
			apiKey: "local",
		});
		expect(result.answer).toBe("fixed");
	});

	it("falls back to JSON-in-text when the model never calls the tool", async () => {
		const reg = faux();
		reg.setResponses([
			fauxAssistantMessage("no tool here"),
			fauxAssistantMessage("still none"),
			fauxAssistantMessage("nope"),
			fauxAssistantMessage('here you go: {"answer":"from-text"} done'),
		]);
		const result = await callRole(reg.getModel(), { messages: [userMessage] }, Schema, "emit", "desc", {
			apiKey: "local",
			maxReprompts: 2,
		});
		expect(result.answer).toBe("from-text");
	});

	it("retries a transient abort/error (not externally cancelled) and then succeeds", async () => {
		const reg = faux();
		reg.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request was aborted." }),
			fauxAssistantMessage([fauxToolCall("emit", { answer: "recovered" })], { stopReason: "toolUse" }),
		]);
		const result = await callRole(reg.getModel(), { messages: [userMessage] }, Schema, "emit", "desc", {
			apiKey: "local",
		});
		expect(result.answer).toBe("recovered");
	});

	it("prompt-json retries a transient abort then parses the next response", async () => {
		const reg = faux();
		reg.setResponses([
			fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted." }),
			fauxAssistantMessage('{"answer":"after-abort"}'),
		]);
		const result = await callRole(reg.getModel(), { messages: [userMessage] }, Schema, "emit", "desc", {
			apiKey: "local",
			structuredVia: "prompt-json",
		});
		expect(result.answer).toBe("after-abort");
	});

	it("does NOT retry when the caller's signal is aborted (real cancellation)", async () => {
		const reg = faux();
		reg.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted." })]);
		const controller = new AbortController();
		controller.abort();
		await expect(
			callRole(reg.getModel(), { messages: [userMessage] }, Schema, "emit", "desc", {
				apiKey: "local",
				signal: controller.signal,
			}),
		).rejects.toBeInstanceOf(RoleOutputError);
	});

	it("throws RoleOutputError after exhausting attempts and the fallback", async () => {
		const reg = faux();
		reg.setResponses([
			fauxAssistantMessage("nope"),
			fauxAssistantMessage("nope"),
			fauxAssistantMessage("nope"),
			fauxAssistantMessage("no json at all"),
		]);
		await expect(
			callRole(reg.getModel(), { messages: [userMessage] }, Schema, "emit", "desc", {
				apiKey: "local",
				maxReprompts: 2,
			}),
		).rejects.toBeInstanceOf(RoleOutputError);
	});

	it("escalates temperature on reprompt so deterministic retries diverge", async () => {
		const reg = faux();
		const temps: (number | undefined)[] = [];
		reg.setResponses([
			(_ctx, options) => {
				temps.push(options?.temperature);
				return fauxAssistantMessage("not json at all");
			},
			(_ctx, options) => {
				temps.push(options?.temperature);
				return fauxAssistantMessage('{"answer":"recovered"}');
			},
		]);
		const result = await callRole(reg.getModel(), { messages: [userMessage] }, Schema, "emit", "desc", {
			apiKey: "local",
			structuredVia: "prompt-json",
			temperature: 0,
		});
		expect(result.answer).toBe("recovered");
		expect(temps[0]).toBe(0); // first attempt stays deterministic
		expect(temps[1]).toBeGreaterThan(0); // reprompt diverges
	});

	it("prompt-json mode parses a JSON object from the text (no tools)", async () => {
		const reg = faux();
		reg.setResponses([fauxAssistantMessage('here you go: {"answer":"json-mode"}')]);
		const result = await callRole(reg.getModel(), { messages: [userMessage] }, Schema, "emit", "desc", {
			apiKey: "local",
			structuredVia: "prompt-json",
		});
		expect(result.answer).toBe("json-mode");
	});

	it("prompt-json mode parses JSON whose string values contain braces (review findings with code)", async () => {
		const reg = faux();
		// A lone "}" inside a string value mis-closes a brace-only scanner.
		reg.setResponses([fauxAssistantMessage('{"answer":"close the block with } then done"}')]);
		const result = await callRole(reg.getModel(), { messages: [userMessage] }, Schema, "emit", "desc", {
			apiKey: "local",
			structuredVia: "prompt-json",
		});
		expect(result.answer).toBe("close the block with } then done");
	});

	it("prompt-json mode extracts the answer after a closed harmony thought channel", async () => {
		const reg = faux();
		reg.setResponses([fauxAssistantMessage('<|channel>thought\n<channel|>{"answer":"after channel"}')]);
		const result = await callRole(reg.getModel(), { messages: [userMessage] }, Schema, "emit", "desc", {
			apiKey: "local",
			structuredVia: "prompt-json",
		});
		expect(result.answer).toBe("after channel");
	});

	it("prompt-json mode reprompts on invalid output then succeeds", async () => {
		const reg = faux();
		reg.setResponses([fauxAssistantMessage("no json here"), fauxAssistantMessage('{"answer":"fixed"}')]);
		const result = await callRole(reg.getModel(), { messages: [userMessage] }, Schema, "emit", "desc", {
			apiKey: "local",
			structuredVia: "prompt-json",
			maxReprompts: 2,
		});
		expect(result.answer).toBe("fixed");
	});
});

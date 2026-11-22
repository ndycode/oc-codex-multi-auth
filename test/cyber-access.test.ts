import { describe, expect, it } from "vitest";
import {
	classifyCyberAccessError,
	getCyberAccessPoolKey,
	normalizeCyberAccessProgram,
	peekServedCyberAccessProgram,
	stripDaybreakSelector,
} from "../lib/request/helpers/cyber-access.js";
import {
	getRequestedCyberAccessProgram,
	transformRequestForCodex,
} from "../lib/request/fetch-helpers.js";
import { normalizeModel } from "../lib/request/request-transformer.js";
import { getModelAccountPool, getModelAccountPoolMode } from "../lib/config.js";
import type { PluginConfig } from "../lib/types.js";

describe("Daybreak selector", () => {
	it.each([
		["gpt-6-sol-daybreak", "gpt-6-sol", true],
		["gpt-6-luna-daybreak-high", "gpt-6-luna-high", true],
		["gpt-6-sol", "gpt-6-sol", false],
		["gpt-daybreak-blue-latest", "gpt-daybreak-blue-latest", false],
		["-daybreak", "-daybreak", false],
	])("parses %s", (input, modelId, daybreak) => {
		expect(stripDaybreakSelector(input)).toEqual({ modelId, daybreak });
	});

	it("normalizes a selector to the base backend model", () => {
		expect(normalizeModel("openai/gpt-6-sol-daybreak")).toBe("gpt-6-sol");
		expect(normalizeModel("gpt-6-luna-daybreak-high")).toBe("gpt-6-luna");
		expect(normalizeModel("gpt-daybreak-blue-latest")).toBe("gpt-daybreak-blue-latest");
	});
});

describe("requested access program", () => {
	const noConfig = { global: {}, models: {} };

	it("reads the selector, config option, provider option and body in priority order", () => {
		expect(getRequestedCyberAccessProgram("gpt-6-sol-daybreak", { model: "x" }, noConfig)).toBe("daybreak_blue");
		expect(getRequestedCyberAccessProgram("gpt-6-sol", { model: "x" }, noConfig)).toBeUndefined();
		expect(getRequestedCyberAccessProgram(
			"gpt-6-sol",
			{ model: "x" },
			{ global: {}, models: { "gpt-6-sol": { options: { cyberAccessProgram: "daybreak_blue" } } } },
		)).toBe("daybreak_blue");
		expect(getRequestedCyberAccessProgram(
			"gpt-6-sol-daybreak",
			{ model: "x", providerOptions: { openai: { cyberAccessProgram: "standard" } } },
			noConfig,
		)).toBe("standard");
		expect(getRequestedCyberAccessProgram(
			"gpt-6-sol",
			{ model: "x", access_programs: { cyber: "DAYBREAK_RED" } },
			noConfig,
		)).toBe("daybreak_red");
		expect(normalizeCyberAccessProgram("bogus")).toBeUndefined();
	});

	it.each(["native", "legacy"] as const)("puts access_programs on the %s wire body", async (mode) => {
		const result = await transformRequestForCodex(
			{ body: JSON.stringify({ model: "openai/gpt-6-sol-daybreak", input: [{ type: "message", role: "user", content: "hi" }] }) },
			"https://example.com",
			noConfig,
			true,
			undefined,
			{ requestTransformMode: mode },
		);
		expect(result?.body.model).toBe("gpt-6-sol");
		expect(result?.requestedCyberAccessProgram).toBe("daybreak_blue");
		const wire = JSON.parse(result!.updatedInit.body as string);
		expect(wire.model).toBe("gpt-6-sol");
		expect(wire.access_programs).toEqual({ cyber: "daybreak_blue" });
	});

	it("keeps access_programs off a request that asked for none", async () => {
		const result = await transformRequestForCodex(
			{ body: JSON.stringify({ model: "gpt-6-sol", input: [] }) },
			"https://example.com",
			noConfig,
			true,
			undefined,
			{ requestTransformMode: "native" },
		);
		expect(result?.requestedCyberAccessProgram).toBeUndefined();
		expect(JSON.parse(result!.updatedInit.body as string).access_programs).toBeUndefined();
	});
});

describe("Daybreak pools and errors", () => {
	it("keys a Daybreak pool apart from the model's standard pool", () => {
		expect(getCyberAccessPoolKey("gpt-6-sol", "daybreak_blue")).toBe("gpt-6-sol-daybreak");
		expect(getCyberAccessPoolKey("gpt-6-sol", "daybreak_red")).toBe("gpt-6-sol-daybreak-red");
		expect(getCyberAccessPoolKey("gpt-6-sol", "standard")).toBe("gpt-6-sol");
		expect(getCyberAccessPoolKey("gpt-6-sol", undefined)).toBe("gpt-6-sol");
		const config = {
			modelAccountPools: { "gpt-6-sol-daybreak": ["acct-a"] },
			modelAccountPoolModes: { "gpt-6-sol-daybreak": "strict" },
		} as unknown as PluginConfig;
		expect(getModelAccountPool(config, getCyberAccessPoolKey("gpt-6-sol", "daybreak_blue"))).toEqual(["acct-a"]);
		expect(getModelAccountPoolMode(config, getCyberAccessPoolKey("gpt-6-sol", "daybreak_blue"))).toBe("strict");
		expect(getModelAccountPool(config, getCyberAccessPoolKey("gpt-6-sol", undefined))).toEqual([]);
	});

	it("classifies model-level and account-level refusals", () => {
		expect(classifyCyberAccessError(403, { detail: "Daybreak isn't available for this model. Turn off Daybreak or choose another model." })).toBe("model");
		expect(classifyCyberAccessError(400, { error: { code: "invalid_access_program" } })).toBe("model");
		expect(classifyCyberAccessError(403, { error: { code: "access_program_not_enabled" } })).toBe("account");
		expect(classifyCyberAccessError(429, { error: { code: "rate_limit_exceeded" } })).toBeUndefined();
	});

	it("peeks the served program and replays every byte", async () => {
		const created = `data: ${JSON.stringify({ type: "response.created", response: { access_programs: { cyber: "daybreak_blue" } } })}\n\n`;
		const rest = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`;
		const encoder = new TextEncoder();
		const source = new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(created.slice(0, 20)));
				controller.enqueue(encoder.encode(created.slice(20)));
				controller.enqueue(encoder.encode(rest));
				controller.close();
			},
		}), { status: 200, headers: { "x-test": "1" } });
		const peeked = await peekServedCyberAccessProgram(source);
		expect(peeked.served).toBe("daybreak_blue");
		expect(peeked.response.headers.get("x-test")).toBe("1");
		expect(await peeked.response.text()).toBe(created + rest);
	});

	it("reports null for a response without access_programs", async () => {
		const peeked = await peekServedCyberAccessProgram(new Response(
			`data: ${JSON.stringify({ type: "response.created", response: { access_programs: null } })}\n\n`,
		));
		expect(peeked.served).toBeNull();
	});
});

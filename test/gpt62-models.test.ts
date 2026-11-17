import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getModelFamily, MODEL_FAMILIES } from "../lib/prompts/codex.js";
import { getNormalizedModel } from "../lib/request/helpers/model-map.js";
import { normalizeModel, getReasoningConfig } from "../lib/request/request-transformer.js";
import { createCodexHeaders, transformRequestForCodex, DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN } from "../lib/request/fetch-helpers.js";
import { DEFAULT_CODEX_CLIENT_VERSION } from "../lib/request/helpers/user-agent.js";

const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

describe.each([
	["gpt-6.2-astra", "GPT 6.2 Astra (OAuth)", 272000, "gpt-6-astra"],
	["gpt-6.2-sol", "GPT 6.2 Sol (OAuth)", 500000, "gpt-6.1-sol"],
] as const)("%s release support", (model, displayName, context, predecessor) => {
	it("preserves model identity and separates prompt/rotation families", () => {
		expect(normalizeModel(displayName)).toBe(model);
		expect(MODEL_FAMILIES).toContain(model);
		for (const effort of efforts) {
			expect(getNormalizedModel(`${model}-${effort}`)).toBe(model);
			expect(normalizeModel(`openai/${model}-${effort}`)).toBe(model);
			expect(getModelFamily(`${model}-${effort}`)).toBe(model);
		}
	});
	it("uses the live catalog effort range and default", () => {
		expect(getReasoningConfig(model).effort).toBe("low");
		for (const effort of efforts) {
			expect(getReasoningConfig(model, { reasoningEffort: effort }).effort).toBe(effort === "ultra" ? "xhigh" : effort);
		}
		expect(getReasoningConfig(model, { reasoningEffort: "none" }).effort).toBe("low");
		expect(getReasoningConfig(model, { reasoningEffort: "minimal" }).effort).toBe("low");
	});
	it.each(["native", "legacy"] as const)("keeps the stateless lite contract in %s mode", async (mode) => {
		const result = await transformRequestForCodex(
			{ method: "POST" },
			"https://chatgpt.com/backend-api/codex/responses",
			{ global: {}, models: {} },
			true,
			{ model: `openai/${model}-ultra`, input: [], tools: [{ type: "function", name: "read_file" }], reasoning: { effort: "ultra" }, store: true, service_tier: "fast" },
			{ requestTransformMode: mode },
		);
		expect(result).toBeDefined();
		if (!result) throw new Error("Missing transformed request");
		const wire = JSON.parse(String(result.updatedInit.body));
		expect(wire.model).toBe(model);
		expect(wire.store).toBe(false);
		expect(wire.include).toContain("reasoning.encrypted_content");
		expect(wire.tools).toBeUndefined();
		expect(wire.input[0].type).toBe("additional_tools");
		expect(wire.reasoning.effort).toBe("xhigh");
		expect(wire.service_tier).toBe("priority");
		const headers = createCodexHeaders(result.updatedInit, "FAKE_ACCOUNT", "FAKE_TOKEN", { model });
		expect(headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
	});
	it("ships all verified presets and context limits", () => {
		const modern = JSON.parse(readFileSync("config/opencode-modern.json", "utf8")).provider.openai.models[model];
		const legacy = JSON.parse(readFileSync("config/opencode-legacy.json", "utf8")).provider.openai.models;
		expect(modern.limit).toEqual({ context, output: 128000 });
		expect(modern.options.reasoningEffort).toBe("low");
		expect(Object.keys(modern.variants)).toEqual(efforts);
		for (const effort of efforts) {
			expect(legacy[`${model}-${effort}`].options.reasoningEffort).toBe(effort);
			expect(legacy[`${model}-${effort}`].limit.context).toBe(context);
		}
	});
	it("has a predecessor fallback and meets the minimum client gate", () => {
		expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[model][0]).toBe(predecessor);
		expect(DEFAULT_CODEX_CLIENT_VERSION).toBe("0.166.0");
	});
});

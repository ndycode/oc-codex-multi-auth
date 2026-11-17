import { readFileSync } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { getNormalizedModel, MODEL_MAP } from "../lib/request/helpers/model-map.js";
import { getModelFamily, MODEL_FAMILIES } from "../lib/prompts/codex.js";
import { getReasoningConfig, normalizeModel } from "../lib/request/request-transformer.js";
import {
	DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN,
	resolveUnsupportedCodexFallbackModel,
} from "../lib/request/fetch-helpers.js";
import { usesResponsesLite } from "../lib/request/helpers/responses-lite.js";
import { getCodexCatalogEntry } from "../lib/request/helpers/codex-catalog.js";

const ASTRA = "gpt-6.2-astra";
const SOL = "gpt-6.2-sol";
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

const unsupported = (model: string) => ({
	error: {
		code: "model_not_supported_with_chatgpt_account",
		message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
	},
});

describe("GPT-6.2 Astra and Sol model support", () => {
	it("normalizes exact API ids, effort selectors, and the plugin bare alias", () => {
		for (const model of [ASTRA, SOL]) {
			expect(normalizeModel(model)).toBe(model);
			expect(getNormalizedModel(model)).toBe(model);
			for (const effort of EFFORTS) expect(normalizeModel(`${model}-${effort}`)).toBe(model);
		}
		expect(normalizeModel("gpt-6.2")).toBe(SOL);
		expect(normalizeModel("GPT 6.2 Astra (OAuth)")).toBe(ASTRA);
		expect(getModelFamily("gpt-6.2-sol-high")).toBe(SOL);
		expect(getModelFamily("gpt-6.2")).toBe(SOL);
	});

	it("does not expose the rejected none/minimal efforts", () => {
		for (const model of [ASTRA, SOL]) {
			expect(MODEL_MAP[`${model}-none`]).toBeUndefined();
			expect(MODEL_MAP[`${model}-minimal`]).toBeUndefined();
		}
	});

	it("registers isolated prompt families and the responses-lite catalog metadata", () => {
		expect(MODEL_FAMILIES).toContain(ASTRA);
		expect(MODEL_FAMILIES).toContain(SOL);
		for (const model of [ASTRA, SOL]) {
			expect(usesResponsesLite(model)).toBe(true);
			expect(getCodexCatalogEntry(model)).toMatchObject({
				serviceTiers: ["priority"],
				multiAgentReasoningEffort: "xhigh",
				defaultVerbosity: "low",
			});
		}
	});

	it("passes official reasoning levels and resolves ultra client-side", () => {
		for (const model of [ASTRA, SOL]) {
			expect(getReasoningConfig(model, { reasoningEffort: "max" }).effort).toBe("max");
			expect(getReasoningConfig(model, { reasoningEffort: "ultra" }).effort).toBe("xhigh");
			expect(getReasoningConfig(model, { reasoningEffort: "none" }).effort).toBe("low");
		}
	});

	describe("unsupported-model fallback", () => {
		afterEach(() => delete process.env.CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK);

		it("keeps Astra above Sol and retains the existing retry budget", () => {
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[ASTRA]).toEqual([
				SOL,
				"gpt-6.1-sol",
				"gpt-6-sol",
				"gpt-5.6-sol",
				"gpt-5.6-terra",
				"gpt-5.5",
				"gpt-6-luna",
			]);
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[SOL][0]).toBe("gpt-6.1-sol");
		});

		it("uses the shared GPT-6 opt-out switch", () => {
			const options = {
				requestedModel: ASTRA,
				errorBody: unsupported(ASTRA),
				attemptedModels: [ASTRA],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			};
			expect(resolveUnsupportedCodexFallbackModel(options)).toBe(SOL);
			process.env.CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK = "1";
			expect(resolveUnsupportedCodexFallbackModel(options)).toBeUndefined();
		});
	});

	it("ships all six client-side effort variants in both config templates", () => {
		const modern = JSON.parse(readFileSync("config/opencode-modern.json", "utf8")) as {
			provider: { openai: { models: Record<string, { variants?: Record<string, unknown> }> } };
		};
		const legacy = JSON.parse(readFileSync("config/opencode-legacy.json", "utf8")) as {
			provider: { openai: { models: Record<string, unknown> } };
		};
		for (const model of [ASTRA, SOL]) {
			expect(Object.keys(modern.provider.openai.models[model]?.variants ?? {})).toEqual([...EFFORTS]);
			expect(Object.keys(legacy.provider.openai.models).filter((id) => id.startsWith(`${model}-`))).toEqual(
				EFFORTS.map((effort) => `${model}-${effort}`),
			);
		}
	});
});

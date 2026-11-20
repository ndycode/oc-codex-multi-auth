import { afterEach, describe, expect, it, vi } from "vitest";
import { getModelFamily } from "../lib/prompts/codex.js";
import {
	normalizeModel,
	getReasoningConfig,
} from "../lib/request/request-transformer.js";
import {
	getNormalizedModel,
	isKnownModel,
	MODEL_MAP,
} from "../lib/request/helpers/model-map.js";
import { resolveUnsupportedCodexFallbackModel } from "../lib/request/fetch-helpers.js";

describe("GPT-5.5 activation", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("maps GPT-5.5 aliases to the public Codex model id", () => {
		expect(MODEL_MAP["gpt-5.5"]).toBe("gpt-5.5");
		expect(MODEL_MAP["gpt-5-xhigh"]).toBe("gpt-6-sol");
		expect(MODEL_MAP["gpt-5.5-fast"]).toBe("gpt-5.5");
		expect(MODEL_MAP["gpt-5.5-fast-high"]).toBe("gpt-5.5");
		expect(getNormalizedModel("gpt-5.5")).toBe("gpt-5.5");
		expect(getNormalizedModel("gpt-5-xhigh")).toBe("gpt-6-sol");
		expect(getNormalizedModel("gpt-5.5-fast-medium")).toBe("gpt-5.5");
		expect(isKnownModel("gpt-5.5")).toBe(true);
		expect(isKnownModel("gpt-5-xhigh")).toBe(true);
		expect(isKnownModel("gpt-5.5-fast")).toBe(true);
	});

	it("excludes GPT-5.5 Pro from the Codex-routable model map (ChatGPT-only per launch)", () => {
		expect(MODEL_MAP["gpt-5.5-pro"]).toBeUndefined();
		expect(MODEL_MAP["gpt-5.5-pro-high"]).toBeUndefined();
		expect(isKnownModel("gpt-5.5-pro")).toBe(false);
	});

	it("normalizes provider-prefixed model aliases", () => {
		expect(normalizeModel("openai/gpt-5.5")).toBe("gpt-5.5");
		expect(normalizeModel("openai/gpt-5.5-high")).toBe("gpt-5.5");
		expect(normalizeModel("openai/gpt-5.5-fast")).toBe("gpt-5.5");
		expect(normalizeModel("openai/gpt-5.5-fast-medium")).toBe("gpt-5.5");
		expect(normalizeModel("openai/gpt-5.5-pro-high")).toBe("gpt-5.5-pro-high");
	});

	it("uses the same reasoning rules as the prior latest general family", () => {
		expect(getReasoningConfig("gpt-5.5", { reasoningEffort: "none" }).effort).toBe(
			"none",
		);
		expect(getReasoningConfig("gpt-5.5", {}).effort).toBe("high");
	});

	it("routes GPT-5.5 prompts through the existing GPT-5.4 prompt family", () => {
		expect(getModelFamily("gpt-5.5")).toBe("gpt-5.4");
		expect(getModelFamily("gpt-5.5-high")).toBe("gpt-5.4");
		expect(getModelFamily("gpt-5.5-fast")).toBe("gpt-5.4");
	});

	it("auto-falls-back from GPT-5.5 to GPT-6 Sol even when the global policy is off", () => {
		const fallback = resolveUnsupportedCodexFallbackModel({
			requestedModel: "gpt-5.5-medium",
			errorBody: {
				detail:
					"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
			},
			attemptedModels: ["gpt-5.5"],
			fallbackOnUnsupportedCodexModel: false,
			fallbackToGpt52OnUnsupportedGpt53: false,
		});

		expect(fallback).toBe("gpt-6-sol");
	});

	it("still falls back from GPT-5.5 to GPT-6 Sol when explicit policy opt-in is set", () => {
		const fallback = resolveUnsupportedCodexFallbackModel({
			requestedModel: "gpt-5.5-medium",
			errorBody: {
				detail:
					"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
			},
			attemptedModels: ["gpt-5.5"],
			fallbackOnUnsupportedCodexModel: true,
			fallbackToGpt52OnUnsupportedGpt53: false,
		});

		expect(fallback).toBe("gpt-6-sol");
	});

	it("disables GPT-5.5 auto-fallback when CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1 is set", () => {
		vi.stubEnv("CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK", "1");

		const fallback = resolveUnsupportedCodexFallbackModel({
			requestedModel: "gpt-5.5-medium",
			errorBody: {
				detail:
					"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
			},
			attemptedModels: ["gpt-5.5"],
			fallbackOnUnsupportedCodexModel: false,
			fallbackToGpt52OnUnsupportedGpt53: false,
		});

		expect(fallback).toBeUndefined();
	});

	it("keeps explicit fallback enabled when the GPT-5.5 auto-fallback opt-out is set", () => {
		vi.stubEnv("CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK", "1");

		const fallback = resolveUnsupportedCodexFallbackModel({
			requestedModel: "gpt-5.5-medium",
			errorBody: {
				detail:
					"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
			},
			attemptedModels: ["gpt-5.5"],
			fallbackOnUnsupportedCodexModel: true,
			fallbackToGpt52OnUnsupportedGpt53: false,
		});

		expect(fallback).toBe("gpt-6-sol");
	});
});

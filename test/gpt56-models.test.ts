import { describe, it, expect } from "vitest";
import { getNormalizedModel, MODEL_MAP } from "../lib/request/helpers/model-map.js";
import {
	getEffortSuffix,
	stripEffortSuffix,
} from "../lib/request/helpers/effort-suffix.js";
import {
	extractCatalogInstructions,
	getModelFamily,
} from "../lib/prompts/codex.js";
import { normalizeModel, getReasoningConfig } from "../lib/request/request-transformer.js";
import { DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN } from "../lib/request/fetch-helpers.js";

/**
 * GPT-5.6 (Sol / Terra / Luna) support.
 *
 * Effort support mirrors openai/codex `codex-rs/models-manager/models.json`:
 * Sol and Terra expose low..max plus ultra; Luna stops at max. No tier accepts
 * `none` or `minimal`.
 */
describe("GPT-5.6 Model Support", () => {
	const TIERS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;

	describe("normalization", () => {
		it("normalizes each base tier", () => {
			for (const tier of TIERS) {
				expect(normalizeModel(tier)).toBe(tier);
				expect(getNormalizedModel(tier)).toBe(tier);
			}
		});

		it("normalizes shared effort variants for every tier", () => {
			for (const tier of TIERS) {
				for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
					expect(normalizeModel(`${tier}-${effort}`)).toBe(tier);
					expect(getNormalizedModel(`${tier}-${effort}`)).toBe(tier);
				}
			}
		});

		it("maps bare gpt-5.6 to the Sol flagship tier", () => {
			expect(normalizeModel("gpt-5.6")).toBe("gpt-5.6-sol");
			expect(getNormalizedModel("gpt-5.6")).toBe("gpt-5.6-sol");
		});

		it("strips a provider prefix", () => {
			expect(normalizeModel("openai/gpt-5.6-terra-high")).toBe("gpt-5.6-terra");
		});

		it("exposes -ultra aliases only for Sol and Terra", () => {
			expect(MODEL_MAP["gpt-5.6-sol-ultra"]).toBe("gpt-5.6-sol");
			expect(MODEL_MAP["gpt-5.6-terra-ultra"]).toBe("gpt-5.6-terra");
			expect(MODEL_MAP["gpt-5.6-luna-ultra"]).toBeUndefined();
		});

		it("never exposes none/minimal aliases for any tier", () => {
			for (const tier of TIERS) {
				expect(MODEL_MAP[`${tier}-none`]).toBeUndefined();
				expect(MODEL_MAP[`${tier}-minimal`]).toBeUndefined();
			}
		});
	});

	describe("model family", () => {
		it("gives each tier an isolated family", () => {
			expect(getModelFamily("gpt-5.6-sol")).toBe("gpt-5.6-sol");
			expect(getModelFamily("gpt-5.6-terra")).toBe("gpt-5.6-terra");
			expect(getModelFamily("gpt-5.6-luna")).toBe("gpt-5.6-luna");
		});

		it("routes bare gpt-5.6 to the Sol family", () => {
			expect(getModelFamily("gpt-5.6")).toBe("gpt-5.6-sol");
		});

		it("does not leak 5.6 into the 5.1 fallback family", () => {
			expect(getModelFamily("gpt-5.6-luna")).not.toBe("gpt-5.1");
		});
	});

	describe("reasoning effort", () => {
		it("passes max through on every tier", () => {
			for (const tier of TIERS) {
				expect(getReasoningConfig(tier, { reasoningEffort: "max" }).effort).toBe(
					"max",
				);
			}
		});

		// Codex rewrites Ultra -> Max client-side (codex-rs/core/src/client.rs
		// `reasoning_effort_for_request`), so ultra must never reach the backend.
		it("collapses ultra to max on Sol and Terra", () => {
			expect(
				getReasoningConfig("gpt-5.6-sol", { reasoningEffort: "ultra" }).effort,
			).toBe("max");
			expect(
				getReasoningConfig("gpt-5.6-terra", { reasoningEffort: "ultra" }).effort,
			).toBe("max");
		});

		it("collapses ultra to max on Luna, which has no ultra tier", () => {
			expect(
				getReasoningConfig("gpt-5.6-luna", { reasoningEffort: "ultra" }).effort,
			).toBe("max");
		});

		it("upgrades none to low, since no 5.6 tier accepts none", () => {
			for (const tier of TIERS) {
				expect(
					getReasoningConfig(tier, { reasoningEffort: "none" }).effort,
				).toBe("low");
			}
		});

		it("supports xhigh directly", () => {
			for (const tier of TIERS) {
				expect(
					getReasoningConfig(tier, { reasoningEffort: "xhigh" }).effort,
				).toBe("xhigh");
			}
		});

		it("downgrades max to xhigh on pre-5.6 models", () => {
			expect(getReasoningConfig("gpt-5.5", { reasoningEffort: "max" }).effort).toBe(
				"xhigh",
			);
			expect(getReasoningConfig("gpt-5.4", { reasoningEffort: "max" }).effort).toBe(
				"xhigh",
			);
		});

		it("steps ultra down to xhigh on pre-5.6 models", () => {
			expect(
				getReasoningConfig("gpt-5.4", { reasoningEffort: "ultra" }).effort,
			).toBe("xhigh");
		});

		it("does not send max to a model that only reaches high", () => {
			const effort = getReasoningConfig("gpt-5.1", {
				reasoningEffort: "max",
			}).effort;
			expect(effort).toBe("high");
		});
	});

	describe("effort suffix parsing", () => {
		it("reads the new suffixes", () => {
			expect(getEffortSuffix("gpt-5.6-sol-max")).toBe("max");
			expect(getEffortSuffix("gpt-5.6-sol-ultra")).toBe("ultra");
			expect(stripEffortSuffix("gpt-5.6-sol-max")).toBe("gpt-5.6-sol");
			expect(stripEffortSuffix("gpt-5.6-terra-ultra")).toBe("gpt-5.6-terra");
		});

		// `gpt-5.1-codex-max` is a model id that ends in `-max`, not a max-effort
		// request. Stripping it would silently reroute every Codex Max call.
		it("does not treat codex-max as a max-effort suffix", () => {
			expect(getEffortSuffix("gpt-5.1-codex-max")).toBeUndefined();
			expect(stripEffortSuffix("gpt-5.1-codex-max")).toBe("gpt-5.1-codex-max");
			expect(normalizeModel("gpt-5.1-codex-max")).toBe("gpt-5.1-codex-max");
		});

		it("still parses effort suffixes on codex ids", () => {
			expect(getEffortSuffix("gpt-5-codex-low")).toBe("low");
			expect(getEffortSuffix("gpt-5.1-codex-max-xhigh")).toBe("xhigh");
			expect(stripEffortSuffix("gpt-5.1-codex-max-xhigh")).toBe(
				"gpt-5.1-codex-max",
			);
		});
	});

	describe("catalog-sourced instructions", () => {
		// openai/codex ships no 5.6 prompt file. Each tier's base_instructions
		// lives in codex-rs/models-manager/models.json, and the tiers do not share
		// it. gpt_5_2_prompt.md would tell a 5.6 model it is "GPT-5.2".
		const catalog = JSON.stringify({
			models: [
				{ slug: "gpt-5.6-sol", base_instructions: "SOL PROMPT" },
				{ slug: "gpt-5.6-terra", base_instructions: "TERRA PROMPT" },
				{ slug: "gpt-5.6-luna", base_instructions: "" },
				{ slug: "gpt-5.5" },
			],
		});

		it("extracts base_instructions per slug", () => {
			expect(extractCatalogInstructions(catalog, "gpt-5.6-sol")).toBe("SOL PROMPT");
			expect(extractCatalogInstructions(catalog, "gpt-5.6-terra")).toBe(
				"TERRA PROMPT",
			);
		});

		it("returns null for a slug missing from the catalog", () => {
			expect(extractCatalogInstructions(catalog, "gpt-5.6-nope")).toBeNull();
		});

		it("returns null when the entry has no base_instructions", () => {
			expect(extractCatalogInstructions(catalog, "gpt-5.5")).toBeNull();
		});

		it("returns null for an empty base_instructions string", () => {
			expect(extractCatalogInstructions(catalog, "gpt-5.6-luna")).toBeNull();
		});

		it("returns null on malformed JSON rather than throwing", () => {
			expect(extractCatalogInstructions("{{{not json", "gpt-5.6-sol")).toBeNull();
			expect(extractCatalogInstructions("[]", "gpt-5.6-sol")).toBeNull();
		});
	});

	describe("unsupported-model fallback", () => {
		// 5.6 shipped as a limited preview; accounts outside it must degrade
		// rather than hard-fail.
		it("degrades down the 5.6 tiers and out to 5.5", () => {
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN["gpt-5.6-sol"]).toEqual([
				"gpt-5.6-terra",
				"gpt-5.6-luna",
				"gpt-5.5",
			]);
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN["gpt-5.6-luna"]).toEqual([
				"gpt-5.5",
			]);
		});
	});
});

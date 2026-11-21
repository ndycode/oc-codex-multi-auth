import { describe, it, expect } from "vitest";
import { getNormalizedModel, MODEL_MAP } from "../lib/request/helpers/model-map.js";
import { getModelFamily } from "../lib/prompts/codex.js";
import { normalizeModel, getReasoningConfig } from "../lib/request/request-transformer.js";

/**
 * Comprehensive test suite for GPT-5.4 model support
 * Tests cover model normalization, family detection, and reasoning configuration
 */
describe("GPT-5.4 Model Support", () => {
	const SNAPSHOT = "2026-03-05";

	describe("GPT-5.4 Model Normalization", () => {
		it("should normalize gpt-5.4 base model", () => {
			expect(normalizeModel("gpt-5.4")).toBe("gpt-5.4");
			expect(getNormalizedModel("gpt-5.4")).toBe("gpt-5.4");
		});

		it("should normalize all gpt-5.4 reasoning effort variants", () => {
			const variants = [
				"gpt-5.4-none",
				"gpt-5.4-low",
				"gpt-5.4-medium",
				"gpt-5.4-high",
				"gpt-5.4-xhigh",
			];

			for (const variant of variants) {
				expect(normalizeModel(variant)).toBe("gpt-5.4");
				expect(getNormalizedModel(variant)).toBe("gpt-5.4");
			}
		});

		it("should handle gpt-5.4 with provider prefix", () => {
			expect(normalizeModel("openai/gpt-5.4")).toBe("gpt-5.4");
			expect(normalizeModel("openai/gpt-5.4-high")).toBe("gpt-5.4");
		});

		it("should handle gpt-5.4 with space separator (verbose names)", () => {
			expect(normalizeModel("gpt 5.4")).toBe("gpt-5.4");
			expect(normalizeModel("gpt 5.4 high")).toBe("gpt-5.4");
		});

		it("should be case-insensitive for gpt-5.4", () => {
			expect(normalizeModel("GPT-5.4")).toBe("gpt-5.4");
			expect(normalizeModel("Gpt-5.4-High")).toBe("gpt-5.4");
			expect(getNormalizedModel("GPT-5.4-XHIGH")).toBe("gpt-5.4");
		});

		it("should handle gpt-5.4 in MODEL_MAP", () => {
			expect(MODEL_MAP["gpt-5.4"]).toBe("gpt-5.4");
			expect(MODEL_MAP["gpt-5.4-none"]).toBe("gpt-5.4");
			expect(MODEL_MAP["gpt-5.4-low"]).toBe("gpt-5.4");
			expect(MODEL_MAP["gpt-5.4-medium"]).toBe("gpt-5.4");
			expect(MODEL_MAP["gpt-5.4-high"]).toBe("gpt-5.4");
			expect(MODEL_MAP["gpt-5.4-xhigh"]).toBe("gpt-5.4");
			expect(MODEL_MAP[`gpt-5.4-${SNAPSHOT}`]).toBe("gpt-5.4");
			expect(MODEL_MAP[`gpt-5.4-${SNAPSHOT}-low`]).toBe("gpt-5.4");
		});

		it("should normalize GPT-5.4 snapshot aliases", () => {
			expect(normalizeModel(`gpt-5.4-${SNAPSHOT}`)).toBe("gpt-5.4");
			expect(normalizeModel(`gpt-5.4-${SNAPSHOT}-high`)).toBe("gpt-5.4");
			expect(getNormalizedModel(`gpt-5.4-${SNAPSHOT}-medium`)).toBe("gpt-5.4");
		});
	});

	describe("GPT-5.4 Pro Model Normalization", () => {
		it("should normalize gpt-5.4-pro base model", () => {
			expect(normalizeModel("gpt-5.4-pro")).toBe("gpt-5.4-pro");
			expect(getNormalizedModel("gpt-5.4-pro")).toBe("gpt-5.4-pro");
		});

		it("should normalize supported gpt-5.4-pro reasoning effort variants", () => {
			const variants = [
				"gpt-5.4-pro-medium",
				"gpt-5.4-pro-high",
				"gpt-5.4-pro-xhigh",
			];

			for (const variant of variants) {
				expect(normalizeModel(variant)).toBe("gpt-5.4-pro");
				expect(getNormalizedModel(variant)).toBe("gpt-5.4-pro");
			}
		});

		it("should not have MODEL_MAP entries for unsupported pro-none and pro-low", () => {
			expect(getNormalizedModel("gpt-5.4-pro-none")).toBeUndefined();
			expect(getNormalizedModel("gpt-5.4-pro-low")).toBeUndefined();
		});

		it("should handle gpt-5.4-pro with provider prefix", () => {
			expect(normalizeModel("openai/gpt-5.4-pro")).toBe("gpt-5.4-pro");
			expect(normalizeModel("openai/gpt-5.4-pro-high")).toBe("gpt-5.4-pro");
		});

		it("should handle gpt-5.4-pro with space separator", () => {
			expect(normalizeModel("gpt 5.4 pro")).toBe("gpt-5.4-pro");
			expect(normalizeModel("gpt 5.4 pro high")).toBe("gpt-5.4-pro");
		});

		it("should be case-insensitive for gpt-5.4-pro", () => {
			expect(normalizeModel("GPT-5.4-PRO")).toBe("gpt-5.4-pro");
			expect(normalizeModel("Gpt-5.4-Pro-High")).toBe("gpt-5.4-pro");
			expect(getNormalizedModel("GPT-5.4-PRO-XHIGH")).toBe("gpt-5.4-pro");
		});

		it("should handle gpt-5.4-pro in MODEL_MAP", () => {
			expect(MODEL_MAP["gpt-5.4-pro"]).toBe("gpt-5.4-pro");
			expect(MODEL_MAP["gpt-5.4-pro-none"]).toBeUndefined();
			expect(MODEL_MAP["gpt-5.4-pro-low"]).toBeUndefined();
			expect(MODEL_MAP["gpt-5.4-pro-medium"]).toBe("gpt-5.4-pro");
			expect(MODEL_MAP["gpt-5.4-pro-high"]).toBe("gpt-5.4-pro");
			expect(MODEL_MAP["gpt-5.4-pro-xhigh"]).toBe("gpt-5.4-pro");
			expect(MODEL_MAP[`gpt-5.4-pro-${SNAPSHOT}`]).toBe("gpt-5.4-pro");
			expect(MODEL_MAP[`gpt-5.4-pro-${SNAPSHOT}-high`]).toBe("gpt-5.4-pro");
		});

		it("should normalize GPT-5.4-pro snapshot aliases", () => {
			expect(normalizeModel(`gpt-5.4-pro-${SNAPSHOT}`)).toBe("gpt-5.4-pro");
			expect(normalizeModel(`gpt-5.4-pro-${SNAPSHOT}-high`)).toBe("gpt-5.4-pro");
			expect(getNormalizedModel(`gpt-5.4-pro-${SNAPSHOT}-medium`)).toBe("gpt-5.4-pro");
		});

		it("should prioritize -pro suffix over base model", () => {
			expect(normalizeModel("gpt-5.4-pro-high")).toBe("gpt-5.4-pro");
			expect(normalizeModel("gpt-5.4-high")).toBe("gpt-5.4");
		});
	});

	describe("GPT-5.4 Mini Model Normalization", () => {
		it("should normalize gpt-5.4-mini base model", () => {
			expect(normalizeModel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
			expect(getNormalizedModel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
		});

		it("should normalize all gpt-5.4-mini reasoning effort variants", () => {
			const variants = [
				"gpt-5.4-mini-none",
				"gpt-5.4-mini-low",
				"gpt-5.4-mini-medium",
				"gpt-5.4-mini-high",
				"gpt-5.4-mini-xhigh",
			];

			for (const variant of variants) {
				expect(normalizeModel(variant)).toBe("gpt-5.4-mini");
				expect(getNormalizedModel(variant)).toBe("gpt-5.4-mini");
			}
		});

		it("should handle gpt-5.4-mini with provider prefix", () => {
			expect(normalizeModel("openai/gpt-5.4-mini")).toBe("gpt-5.4-mini");
			expect(normalizeModel("openai/gpt-5.4-mini-high")).toBe("gpt-5.4-mini");
		});

		it("should handle gpt-5.4-mini with space separator", () => {
			expect(normalizeModel("gpt 5.4 mini")).toBe("gpt-5.4-mini");
			expect(normalizeModel("gpt 5.4 mini high")).toBe("gpt-5.4-mini");
		});

		it("should be case-insensitive for gpt-5.4-mini", () => {
			expect(normalizeModel("GPT-5.4-MINI")).toBe("gpt-5.4-mini");
			expect(normalizeModel("Gpt-5.4-Mini-High")).toBe("gpt-5.4-mini");
			expect(getNormalizedModel("GPT-5.4-MINI-XHIGH")).toBe("gpt-5.4-mini");
		});

		it("should handle gpt-5.4-mini in MODEL_MAP", () => {
			expect(MODEL_MAP["gpt-5.4-mini"]).toBe("gpt-5.4-mini");
			expect(MODEL_MAP["gpt-5.4-mini-none"]).toBe("gpt-5.4-mini");
			expect(MODEL_MAP["gpt-5.4-mini-low"]).toBe("gpt-5.4-mini");
			expect(MODEL_MAP["gpt-5.4-mini-medium"]).toBe("gpt-5.4-mini");
			expect(MODEL_MAP["gpt-5.4-mini-high"]).toBe("gpt-5.4-mini");
			expect(MODEL_MAP["gpt-5.4-mini-xhigh"]).toBe("gpt-5.4-mini");
			expect(MODEL_MAP[`gpt-5.4-mini-${SNAPSHOT}`]).toBe("gpt-5.4-mini");
			expect(MODEL_MAP[`gpt-5.4-mini-${SNAPSHOT}-low`]).toBe("gpt-5.4-mini");
		});

		it("should normalize GPT-5.4-mini snapshot aliases", () => {
			expect(normalizeModel(`gpt-5.4-mini-${SNAPSHOT}`)).toBe("gpt-5.4-mini");
			expect(normalizeModel(`gpt-5.4-mini-${SNAPSHOT}-high`)).toBe("gpt-5.4-mini");
			expect(getNormalizedModel(`gpt-5.4-mini-${SNAPSHOT}-medium`)).toBe("gpt-5.4-mini");
		});

		it("should prioritize -mini suffix over base gpt-5.4", () => {
			expect(normalizeModel("gpt-5.4-mini-high")).toBe("gpt-5.4-mini");
			expect(normalizeModel("gpt-5.4-high")).toBe("gpt-5.4");
			// Ensure mini is not confused with base model
			expect(normalizeModel("gpt-5.4-mini")).not.toBe("gpt-5.4");
		});
	});

	describe("GPT-5.4 Model Family Detection", () => {
		it("should detect gpt-5.4 model family", () => {
			expect(getModelFamily("gpt-5.4")).toBe("gpt-5.4");
			expect(getModelFamily("gpt-5.4-low")).toBe("gpt-5.4");
			expect(getModelFamily("gpt-5.4-high")).toBe("gpt-5.4");
			expect(getModelFamily("gpt-5.4-xhigh")).toBe("gpt-5.4");
		});

		it("should detect gpt-5.4 with space separator", () => {
			expect(getModelFamily("gpt 5.4")).toBe("gpt-5.4");
			expect(getModelFamily("gpt 5.4 high")).toBe("gpt-5.4");
		});

		it("should not confuse gpt-5.4-pro with base gpt-5.4", () => {
			expect(getModelFamily("gpt-5.4-pro")).toBe("gpt-5.4-pro");
			expect(getModelFamily("gpt 5.4 pro")).toBe("gpt-5.4-pro");
		});

		it("should isolate gpt-5.4-pro family from gpt-5.4 base family", () => {
			expect(getModelFamily("gpt-5.4")).toBe("gpt-5.4");
			expect(getModelFamily("gpt-5.4-pro")).toBe("gpt-5.4-pro");
			expect(getModelFamily(`gpt-5.4-${SNAPSHOT}`)).toBe("gpt-5.4");
			expect(getModelFamily(`gpt-5.4-pro-${SNAPSHOT}`)).toBe("gpt-5.4-pro");
		});

		it("should detect gpt-5.4-mini model family", () => {
			expect(getModelFamily("gpt-5.4-mini")).toBe("gpt-5.4-mini");
			expect(getModelFamily("gpt-5.4-mini-low")).toBe("gpt-5.4-mini");
			expect(getModelFamily("gpt-5.4-mini-high")).toBe("gpt-5.4-mini");
			expect(getModelFamily("gpt-5.4-mini-xhigh")).toBe("gpt-5.4-mini");
		});

		it("should detect gpt-5.4-mini with space separator", () => {
			expect(getModelFamily("gpt 5.4 mini")).toBe("gpt-5.4-mini");
			expect(getModelFamily("gpt 5.4 mini high")).toBe("gpt-5.4-mini");
		});

		it("should isolate gpt-5.4-mini family from gpt-5.4 and gpt-5.4-pro", () => {
			expect(getModelFamily("gpt-5.4-mini")).toBe("gpt-5.4-mini");
			expect(getModelFamily("gpt-5.4")).toBe("gpt-5.4");
			expect(getModelFamily("gpt-5.4-pro")).toBe("gpt-5.4-pro");
			// Ensure distinct families
			expect(getModelFamily("gpt-5.4-mini")).not.toBe("gpt-5.4");
			expect(getModelFamily("gpt-5.4-mini")).not.toBe("gpt-5.4-pro");
		});

		it("should not confuse gpt-5.4 with gpt-5.3 or gpt-5.2", () => {
			expect(getModelFamily("gpt-5.4")).not.toBe("gpt-5.2");
			expect(getModelFamily("gpt-5.4")).not.toBe("gpt-5.1");
			expect(getModelFamily("gpt-5.4")).not.toBe("gpt-5-codex");
		});
	});

	describe("GPT-5.4 Reasoning Configuration", () => {
		it("should support 'none' reasoning effort for gpt-5.4", () => {
			const config = getReasoningConfig("gpt-5.4", { reasoningEffort: "none" });
			expect(config.effort).toBe("none");
		});

		it("should support all reasoning effort levels for gpt-5.4", () => {
			const efforts = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

			for (const effort of efforts) {
				const config = getReasoningConfig("gpt-5.4", { reasoningEffort: effort });
				expect(config.effort).toBe(effort);
			}
		});

		it("should default to 'high' for gpt-5.4 when not specified", () => {
			const config = getReasoningConfig("gpt-5.4", {});
			expect(config.effort).toBe("high");
		});

		it("should support xhigh reasoning for gpt-5.4", () => {
			const config = getReasoningConfig("gpt-5.4", { reasoningEffort: "xhigh" });
			expect(config.effort).toBe("xhigh");
		});

		it("should support gpt-5.4-pro reasoning configuration", () => {
			const config = getReasoningConfig("gpt-5.4-pro", { reasoningEffort: "high" });
			expect(config.effort).toBe("high");
		});

		it("should coerce 'none' to 'medium' for gpt-5.4-pro (none→low→medium chain)", () => {
			const config = getReasoningConfig("gpt-5.4-pro", { reasoningEffort: "none" });
			expect(config.effort).not.toBe("none");
			expect(config.effort).toBe("medium");
		});

		it("should support xhigh reasoning for gpt-5.4-pro", () => {
			const config = getReasoningConfig("gpt-5.4-pro", { reasoningEffort: "xhigh" });
			expect(config.effort).toBe("xhigh");
		});

		it("should support gpt-5.4-mini reasoning configuration", () => {
			const config = getReasoningConfig("gpt-5.4-mini", { reasoningEffort: "high" });
			expect(config.effort).toBe("high");
		});

		it("should support all reasoning effort levels for gpt-5.4-mini", () => {
			const efforts = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

			for (const effort of efforts) {
				const config = getReasoningConfig("gpt-5.4-mini", { reasoningEffort: effort });
				expect(config.effort).toBe(effort);
			}
		});

		it("should default to 'high' for gpt-5.4-mini when not specified", () => {
			const config = getReasoningConfig("gpt-5.4-mini", {});
			expect(config.effort).toBe("high");
		});

		it("should support xhigh reasoning for gpt-5.4-mini", () => {
			const config = getReasoningConfig("gpt-5.4-mini", { reasoningEffort: "xhigh" });
			expect(config.effort).toBe("xhigh");
		});

		it("should handle reasoning summary for gpt-5.4", () => {
			const configs = [
				{ reasoningSummary: "auto" },
				{ reasoningSummary: "concise" },
				{ reasoningSummary: "detailed" },
			] as const;

			for (const userConfig of configs) {
				const config = getReasoningConfig("gpt-5.4", userConfig);
				expect(config.summary).toBe(userConfig.reasoningSummary);
			}
		});
	});

	describe("GPT-5.4 Edge Cases", () => {
		it("should handle gpt-5.4 with trailing whitespace", () => {
			expect(normalizeModel("gpt-5.4 ")).toBe("gpt-5.4");
			expect(normalizeModel(" gpt-5.4")).toBe("gpt-5.4");
			expect(normalizeModel(" gpt-5.4-high ")).toBe("gpt-5.4");
		});

		it("should handle gpt-5.4 with multiple spaces", () => {
			// Multiple spaces are not explicitly handled, falls back to default
			expect(normalizeModel("gpt  5.4")).toBe("gpt-6-sol");
			expect(normalizeModel("gpt   5.4   high")).toBe("gpt-6-sol");
		});

		it("should handle gpt-5.4 with underscore separator", () => {
			expect(normalizeModel("gpt_5_4")).toBe("gpt_5_4");
		});

		it("preserves unknown gpt-5.4x slugs", () => {
			expect(normalizeModel("gpt-5.40")).toBe("gpt-5.40");
			expect(normalizeModel("gpt-5.44")).toBe("gpt-5.44");
		});

		it("should handle empty/undefined model names defaulting to gpt-6-sol", () => {
			expect(normalizeModel(undefined)).toBe("gpt-6-sol");
			expect(normalizeModel("")).toBe("gpt-6-sol");
		});
	});

	describe("GPT-5.4 vs Other Models Priority", () => {
		it("should prioritize gpt-5.4 over gpt-5.3/gpt-5.2 in pattern matching", () => {
			expect(normalizeModel("gpt-5.4")).toBe("gpt-5.4");
			expect(normalizeModel("gpt-5.3")).toBe("gpt-5.3");
			expect(normalizeModel("gpt-5.2")).toBe("gpt-5.2");
		});

		it("should prioritize gpt-5.4-pro over gpt-5.4 when pro suffix present", () => {
			expect(normalizeModel("gpt-5.4-pro")).toBe("gpt-5.4-pro");
			expect(normalizeModel("gpt-5.4")).toBe("gpt-5.4");
		});

		it("should distinguish gpt-5.4 from gpt-5.4-pro-high", () => {
			expect(normalizeModel("gpt-5.4-pro-high")).toBe("gpt-5.4-pro");
			expect(normalizeModel("gpt-5.4-high")).toBe("gpt-5.4");
		});

		it("should distinguish gpt-5.4-mini from gpt-5.4 and gpt-5.4-pro", () => {
			expect(normalizeModel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
			expect(normalizeModel("gpt-5.4-mini-high")).toBe("gpt-5.4-mini");
			// Ensure mini is not confused with base or pro
			expect(normalizeModel("gpt-5.4-mini")).not.toBe("gpt-5.4");
			expect(normalizeModel("gpt-5.4-mini")).not.toBe("gpt-5.4-pro");
			expect(normalizeModel("gpt-5.4")).not.toBe("gpt-5.4-mini");
			expect(normalizeModel("gpt-5.4-pro")).not.toBe("gpt-5.4-mini");
		});

		it("should prioritize longer suffixes correctly (-pro > -mini > base)", () => {
			expect(normalizeModel("gpt-5.4-pro")).toBe("gpt-5.4-pro");
			expect(normalizeModel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
			expect(normalizeModel("gpt-5.4")).toBe("gpt-5.4");
			// Ensure pro doesn't match mini and vice versa
			expect(normalizeModel("gpt-5.4-pro")).not.toBe("gpt-5.4-mini");
			expect(normalizeModel("gpt-5.4-mini")).not.toBe("gpt-5.4-pro");
		});
	});

	describe("GPT-5.4 Integration with Existing Models", () => {
		it("should map legacy gpt-5 aliases to the latest GPT-5 model while preserving mini/nano variants", () => {
			expect(normalizeModel("gpt-5")).toBe("gpt-6-sol");
			expect(normalizeModel("gpt-5-mini")).toBe("gpt-6-luna");
			expect(normalizeModel("gpt-5-nano")).toBe("gpt-5.4-nano");
			expect(getNormalizedModel("gpt-5")).toBe("gpt-6-sol");
		});

		it("should coexist with gpt-5.2 model", () => {
			expect(normalizeModel("gpt-5.4")).toBe("gpt-5.4");
			expect(normalizeModel("gpt-5.2")).toBe("gpt-5.2");
			expect(getModelFamily("gpt-5.4")).toBe("gpt-5.4");
			expect(getModelFamily("gpt-5.2")).toBe("gpt-5.2");
		});

		it("should coexist with gpt-5.3-codex model", () => {
			expect(normalizeModel("gpt-5.4")).toBe("gpt-5.4");
			expect(normalizeModel("gpt-5.3-codex")).toBe("gpt-5.3-codex");
			expect(getModelFamily("gpt-5.4")).toBe("gpt-5.4");
			expect(getModelFamily("gpt-5.3-codex")).toBe("gpt-5-codex");
		});

		it("should coexist with gpt-5-codex model", () => {
			expect(normalizeModel("gpt-5.4")).toBe("gpt-5.4");
			expect(normalizeModel("gpt-5-codex")).toBe("gpt-5-codex");
			expect(getModelFamily("gpt-5.4")).toBe("gpt-5.4");
			expect(getModelFamily("gpt-5-codex")).toBe("gpt-5-codex");
		});

		it("should have same reasoning capabilities as gpt-5.2 (both support xhigh)", () => {
			const config54 = getReasoningConfig("gpt-5.4", { reasoningEffort: "xhigh" });
			const config52 = getReasoningConfig("gpt-5.2", { reasoningEffort: "xhigh" });
			expect(config54.effort).toBe("xhigh");
			expect(config52.effort).toBe("xhigh");
			expect(config54.effort).toBe(config52.effort);
		});

		it("should both support 'none' reasoning (gpt-5.4 and gpt-5.2 general)", () => {
			const config54 = getReasoningConfig("gpt-5.4", { reasoningEffort: "none" });
			const config52 = getReasoningConfig("gpt-5.2", { reasoningEffort: "none" });
			expect(config54.effort).toBe("none");
			expect(config52.effort).toBe("none");
		});

		it("should coexist with gpt-5.4-mini model", () => {
			expect(normalizeModel("gpt-5.4")).toBe("gpt-5.4");
			expect(normalizeModel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
			expect(getModelFamily("gpt-5.4")).toBe("gpt-5.4");
			expect(getModelFamily("gpt-5.4-mini")).toBe("gpt-5.4-mini");
		});

		it("should have same reasoning capabilities across gpt-5.4 variants", () => {
			const config54 = getReasoningConfig("gpt-5.4", { reasoningEffort: "xhigh" });
			const config54Mini = getReasoningConfig("gpt-5.4-mini", { reasoningEffort: "xhigh" });
			expect(config54.effort).toBe("xhigh");
			expect(config54Mini.effort).toBe("xhigh");
		});

		it("should not map gpt-5.4-mini to gpt-5.4 (distinct models)", () => {
			expect(normalizeModel("gpt-5.4-mini")).not.toBe("gpt-5.4");
			expect(normalizeModel("gpt-5.4-mini-high")).not.toBe("gpt-5.4");
			expect(getNormalizedModel("gpt-5.4-mini")).not.toBe("gpt-5.4");
		});
	});

	describe("GPT-5.4 Model Count", () => {
		it("should have all gpt-5.4 variants in MODEL_MAP", () => {
			const gpt54Variants = Object.keys(MODEL_MAP).filter(
				(key) => key.startsWith("gpt-5.4") && !key.includes("pro")
			);
			expect(gpt54Variants.length).toBeGreaterThanOrEqual(6); // base + 5 effort levels
		});

		it("should have all gpt-5.4-pro variants in MODEL_MAP", () => {
			const gpt54ProVariants = Object.keys(MODEL_MAP).filter((key) =>
				key.startsWith("gpt-5.4-pro")
			);
			expect(gpt54ProVariants.length).toBeGreaterThanOrEqual(6); // base + none/low/medium/high/xhigh
		});

		it("should have all gpt-5.4-mini variants in MODEL_MAP", () => {
			const gpt54MiniVariants = Object.keys(MODEL_MAP).filter((key) =>
				key.startsWith("gpt-5.4-mini")
			);
			expect(gpt54MiniVariants.length).toBeGreaterThanOrEqual(6); // base + none/low/medium/high/xhigh
		});

		it("should ensure all gpt-5.4 variants map to correct normalized name", () => {
			const gpt54Keys = Object.keys(MODEL_MAP).filter((key) =>
				key.startsWith("gpt-5.4")
			);

			for (const key of gpt54Keys) {
				const normalized = MODEL_MAP[key];
				expect(normalized).toMatch(/^gpt-5\.4(-pro|-mini|-nano)?$/);
			}
		});
	});
});

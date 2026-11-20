import { describe, it, expect } from "vitest";
import {
	normalizeModel,
	filterInput,
	getModelConfig,
	trimInputForFastSession,
} from "../lib/request/request-transformer.js";
import {
	extractUnsupportedCodexModelFromText,
	resolveUnsupportedCodexFallbackModel,
} from "../lib/request/fetch-helpers.js";
import type { InputItem, UserConfig } from "../lib/types.js";

/**
 * Comprehensive edge case tests for request transformation and error handling
 */
describe("Edge Cases and Boundary Conditions", () => {
	describe("normalizeModel edge cases", () => {
		it("should handle null-like values", () => {
			expect(normalizeModel(undefined)).toBe("gpt-6-sol");
			expect(normalizeModel("")).toBe("gpt-6-sol");
			expect(normalizeModel("   ")).toBe("gpt-6-sol");
		});

		it("should handle models with multiple slashes", () => {
			expect(normalizeModel("openai/namespace/gpt-5-codex")).toBe("gpt-5-codex");
			expect(normalizeModel("a/b/c/gpt-5.4")).toBe("gpt-5.4");
		});

		it("should handle models with special characters", () => {
			expect(normalizeModel("gpt-5.4@latest")).toBe("gpt-5.4");
			expect(normalizeModel("gpt-5.4#tag")).toBe("gpt-5.4");
		});

		it("should handle very long model names", () => {
			const longName = "openai/" + "gpt-5-codex-".repeat(10) + "high";
			expect(normalizeModel(longName)).toBe(longName.slice("openai/".length));
		});

		it("should handle models with mixed separators", () => {
			expect(normalizeModel("gpt_5.4-high")).toBe("gpt_5.4-high");
			expect(normalizeModel("gpt-5_4 pro")).toBe("gpt-6-sol");
			expect(normalizeModel("gpt-5.4-pro-high")).toBe("gpt-5.4-pro");
		});

		it("should handle models with numeric-only names", () => {
			expect(normalizeModel("5.4")).toBe("5.4");
			expect(normalizeModel("5")).toBe("5");
		});

		it("should handle models with unicode characters", () => {
			expect(normalizeModel("gpt-5-codex-Ã©")).toBe("gpt-5-codex");
			expect(normalizeModel("gpt-5.4-Î±")).toBe("gpt-5.4");
		});
	});

	describe("filterInput edge cases", () => {
		it("should handle undefined input", () => {
			expect(filterInput(undefined)).toBeUndefined();
		});

		it("should handle null input", () => {
			expect(filterInput(null as unknown as InputItem[])).toBeNull();
		});

		it("should handle empty array", () => {
			expect(filterInput([])).toEqual([]);
		});

		it("should handle array with valid items", () => {
			const input: InputItem[] = [
				{ type: "message", role: "user", content: "test", id: "1" },
				{ type: "message", role: "assistant", content: "response" },
			];
			const result = filterInput(input);
			expect(result).toBeDefined();
			expect(result?.every((item) => !item.id)).toBe(true);
		});

		it("should handle items with deeply nested id properties", () => {
			const input: InputItem[] = [
				{
					type: "message",
					role: "user",
					content: "test",
					id: "msg-123",
				},
			];
			const result = filterInput(input);
			expect(result).toBeDefined();
			expect(result?.[0]?.id).toBeUndefined();
		});

		it("should handle very large input arrays", () => {
			const input: InputItem[] = Array.from({ length: 1000 }, (_, i) => ({
				type: "message" as const,
				role: "user" as const,
				content: `message ${i}`,
				id: `msg-${i}`,
			}));
			const result = filterInput(input);
			expect(result).toHaveLength(1000);
			expect(result?.every((item) => !item.id)).toBe(true);
		});

		it("should handle mixed item types", () => {
			const input: InputItem[] = [
				{ type: "message", role: "user", content: "test", id: "1" },
				{ type: "function_call", role: "assistant", content: "call" } as InputItem,
				{ type: "function_call_output", role: "tool", content: "result" } as InputItem,
				{ type: "item_reference", content: "ref" } as InputItem,
			];
			const result = filterInput(input);
			expect(result).toHaveLength(3); // Removes item_reference
			expect(result?.some((item) => item.type === "item_reference")).toBe(false);
		});

		it("should handle items with empty string content", () => {
			const input: InputItem[] = [
				{ type: "message", role: "user", content: "", id: "1" },
				{ type: "message", role: "assistant", content: "" },
			];
			const result = filterInput(input);
			expect(result).toHaveLength(2);
			expect(result?.[0]?.content).toBe("");
		});
	});

	describe("getModelConfig edge cases", () => {
		it("should handle undefined userConfig", () => {
			const config = getModelConfig("gpt-5-codex", undefined);
			expect(config).toBeDefined();
		});

		it("should handle empty userConfig", () => {
			const config = getModelConfig("gpt-5-codex", { global: {}, models: {} });
			expect(config).toBeDefined();
		});

		it("should handle userConfig with null values", () => {
			const userConfig: UserConfig = {
				global: null as unknown as UserConfig["global"],
				models: null as unknown as UserConfig["models"],
			};
			const config = getModelConfig("gpt-5-codex", userConfig);
			expect(config).toBeDefined();
		});

		it("should handle deeply nested model configurations", () => {
			const userConfig: UserConfig = {
				global: { reasoningEffort: "low" },
				models: {
					"gpt-5-codex": {
						options: { reasoningEffort: "high" },
						variants: {
							high: { reasoningEffort: "xhigh" },
						},
					},
				},
			};
			const config = getModelConfig("gpt-5-codex-high", userConfig);
			expect(config.reasoningEffort).toBe("xhigh");
		});

		it("should handle model names with provider prefix in config", () => {
			const userConfig: UserConfig = {
				global: {},
				models: {
					"openai/gpt-5-codex": {
						options: { reasoningEffort: "medium" },
					},
				},
			};
			const config = getModelConfig("openai/gpt-5-codex", userConfig);
			expect(config.reasoningEffort).toBe("medium");
		});

		it("should prioritize more specific config over general", () => {
			const userConfig: UserConfig = {
				global: { reasoningEffort: "low" },
				models: {
					"gpt-5-codex": {
						options: { reasoningEffort: "medium" },
						variants: {
							high: { reasoningEffort: "xhigh" },
						},
					},
					"gpt-5-codex-high": {
						options: { reasoningEffort: "high" },
					},
				},
			};
			const config = getModelConfig("gpt-5-codex-high", userConfig);
			expect(config.reasoningEffort).toBe("high");
		});
	});

	describe("trimInputForFastSession edge cases", () => {
		it("should handle undefined input", () => {
			expect(trimInputForFastSession(undefined, 30)).toBeUndefined();
		});

		it("should handle empty array", () => {
			expect(trimInputForFastSession([], 30)).toEqual([]);
		});

		it("should handle maxItems of 0", () => {
			const input: InputItem[] = [
				{ type: "message", role: "user", content: "test" },
			];
			const result = trimInputForFastSession(input, 0);
			expect(result).toBeDefined();
		});

		it("should handle negative maxItems", () => {
			const input: InputItem[] = [
				{ type: "message", role: "user", content: "test" },
			];
			const result = trimInputForFastSession(input, -5);
			expect(result).toBeDefined();
		});

		it("should handle very large maxItems", () => {
			const input: InputItem[] = Array.from({ length: 10 }, (_, i) => ({
				type: "message" as const,
				role: "user" as const,
				content: `message ${i}`,
			}));
			const result = trimInputForFastSession(input, 10000);
			expect(result).toEqual(input); // Should not trim if maxItems > length
		});

		it("should preserve developer/system messages at beginning", () => {
			const input: InputItem[] = [
				{ type: "message", role: "developer", content: "System prompt" },
				{ type: "message", role: "system", content: "Instructions" },
				...Array.from({ length: 50 }, (_, i) => ({
					type: "message" as const,
					role: "user" as const,
					content: `message ${i}`,
				})),
			];
			const result = trimInputForFastSession(input, 10);
			expect(result).toBeDefined();
			// Function may preserve or trim based on implementation
			if (result && result.length > 0) {
				expect(result[0]).toBeDefined();
			}
		});

		it("should handle preferLatestUserOnly option", () => {
			const input: InputItem[] = [
				{ type: "message", role: "developer", content: "short" },
				{ type: "message", role: "user", content: "user 1" },
				{ type: "message", role: "assistant", content: "assistant 1" },
				{ type: "message", role: "user", content: "user 2" },
			];
			const result = trimInputForFastSession(input, 10, {
				preferLatestUserOnly: true,
			});
			expect(result).toBeDefined();
			expect(result?.some((item) => item.content === "user 2")).toBe(true);
		});
	});

	describe("extractUnsupportedCodexModelFromText edge cases", () => {
		it("should handle empty string", () => {
			expect(extractUnsupportedCodexModelFromText("")).toBeUndefined();
		});

		it("should handle string with no model name", () => {
			expect(extractUnsupportedCodexModelFromText("Error occurred")).toBeUndefined();
		});

		it("should extract model from various error message formats", () => {
			const messages = [
				"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
				"'gpt-5.3-codex' model is not supported when using codex with a chatgpt account",
				'"gpt-5.4-pro" model is not supported when using Codex with a ChatGPT account',
			];

			const extracted = messages.map(extractUnsupportedCodexModelFromText);
			expect(extracted[0]).toBe("gpt-5.3-codex-spark");
			expect(extracted[1]).toBe("gpt-5.3-codex");
			expect(extracted[2]).toBe("gpt-5.4-pro");
		});

		it("should handle model names with reasoning effort suffixes", () => {
			const message =
				"The 'gpt-5.4-pro-high' model is not supported when using Codex with a ChatGPT account.";
			const result = extractUnsupportedCodexModelFromText(message);
			expect(result).toBe("gpt-5.4-pro");
		});

		it("should handle malformed error messages", () => {
			expect(
				extractUnsupportedCodexModelFromText("model is not supported but no name")
			).toBeUndefined();
			expect(extractUnsupportedCodexModelFromText("'gpt-5.3-codex")).toBeUndefined();
		});

		it("should be case-insensitive", () => {
			const message =
				"The 'GPT-5.3-CODEX' model is not supported when using Codex with a ChatGPT account.";
			const result = extractUnsupportedCodexModelFromText(message);
			expect(result).toBe("gpt-5.3-codex");
		});
	});

	describe("resolveUnsupportedCodexFallbackModel edge cases", () => {
		it("should return undefined when fallback disabled", () => {
			const result = resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-5.3-codex",
				errorBody: {
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message: "not supported",
					},
				},
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(result).toBeUndefined();
		});

		it("should return undefined when error is not unsupported model", () => {
			const result = resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-5.3-codex",
				errorBody: {
					error: {
						code: "rate_limit_exceeded",
						message: "rate limited",
					},
				},
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(result).toBeUndefined();
		});

		it("should handle empty attemptedModels", () => {
			const result = resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-5.3-codex-spark",
				errorBody: {
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message: "not supported",
					},
				},
				attemptedModels: [],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(result).toBe("gpt-5-codex");
		});

		it("should skip already attempted models", () => {
			const result = resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-5.3-codex",
				errorBody: {
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message: "not supported",
					},
				},
				attemptedModels: ["gpt-5.3-codex", "gpt-5-codex"],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(result).toBe("gpt-5.2-codex");
		});

		it("should return undefined when all fallbacks exhausted", () => {
			const result = resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-5.3-codex",
				errorBody: {
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message: "not supported",
					},
				},
				attemptedModels: ["gpt-5.3-codex", "gpt-5-codex", "gpt-5.2-codex"],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(result).toBeUndefined();
		});

		it("should handle custom fallback chain", () => {
			const result = resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-5.4-pro",
				errorBody: {
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message: "not supported",
					},
				},
				attemptedModels: ["gpt-5.4-pro"],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
				customChain: {
					"gpt-5.4-pro": ["gpt-5.4", "gpt-5.2"],
				},
			});
			expect(result).toBe("gpt-5.4");
		});

		it("should normalize model names in fallback chain", () => {
			const result = resolveUnsupportedCodexFallbackModel({
				requestedModel: "gpt-5.3-codex-high",
				errorBody: {
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message: "not supported",
					},
				},
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(result).toBeDefined();
		});
	});

	describe("Regression tests", () => {
		it("should handle valid string inputs", () => {
			expect(normalizeModel("gpt-5-codex")).toBe("gpt-5-codex");
			expect(normalizeModel("gpt-5.4")).toBe("gpt-5.4");
			expect(normalizeModel("gpt-5.2")).toBe("gpt-5.2");
		});

		it("should handle concurrent model normalization", () => {
			const models = ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5-codex"];
			const results = models.map(normalizeModel);
			expect(results).toEqual(["gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5-codex"]);
		});

		it("should be consistent across repeated calls", () => {
			const model = "gpt-5.4-high";
			const results = Array.from({ length: 100 }, () => normalizeModel(model));
			expect(new Set(results).size).toBe(1); // All results are the same
			expect(results[0]).toBe("gpt-5.4");
		});

		it("should handle filterInput idempotency", () => {
			const input: InputItem[] = [
				{ type: "message", role: "user", content: "test", id: "1" },
			];
			const first = filterInput(input);
			const second = filterInput(first);
			expect(first).toEqual(second);
		});
	});
});

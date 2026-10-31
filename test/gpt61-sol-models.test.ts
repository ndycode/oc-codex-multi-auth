import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { getNormalizedModel, MODEL_MAP } from "../lib/request/helpers/model-map.js";
import {
	getModelFamily,
	MODEL_FAMILIES,
} from "../lib/prompts/codex.js";
import { normalizeModel, getReasoningConfig } from "../lib/request/request-transformer.js";
import {
	DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN,
	pickFallbackChainTarget,
	resolveUnsupportedCodexFallbackModel,
} from "../lib/request/fetch-helpers.js";
import { usesResponsesLite } from "../lib/request/helpers/responses-lite.js";
import { resolveClientIdentity } from "../lib/request/helpers/client-identity.js";

/**
 * GPT-6.1 Sol, added to the Codex catalog on main 2026-09-29 (openai/codex
 * b1e72963, PR #49318) as the new default catalog model — priority 1, ahead
 * of Astra. The same day openai-python #3986 (v3.21.0) and openai-node #2836
 * added `gpt-6.1-sol` to their ChatModel enums. Effort range, responses-lite
 * and plan coverage below are read from that catalog entry. It is the only
 * shipping 6.1: GPT-6.1 Astra was cancelled 2026-09-28 and never got an id.
 */
interface TemplateShape {
	provider: { openai: { models: Record<string, { variants?: Record<string, unknown> }> } };
}

const SOL61 = "gpt-6.1-sol";
const SOL61_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

const unsupported = (model: string) => ({
	error: {
		code: "model_not_supported_with_chatgpt_account",
		message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
	},
});

describe("GPT-6.1 Sol Model Support", () => {
	describe("normalization", () => {
		it("normalizes the canonical id and every catalog effort", () => {
			expect(normalizeModel(SOL61)).toBe(SOL61);
			expect(getNormalizedModel(SOL61)).toBe(SOL61);
			for (const effort of SOL61_EFFORTS) {
				expect(normalizeModel(`${SOL61}-${effort}`)).toBe(SOL61);
			}
		});

		// The catalog gives it low..ultra, the same envelope as gpt-6-sol.
		it("has no none/minimal alias", () => {
			expect(MODEL_MAP[`${SOL61}-none`]).toBeUndefined();
			expect(MODEL_MAP[`${SOL61}-minimal`]).toBeUndefined();
		});

		it("maps the bare gpt-6.1 selector to Sol, the only shipping 6.1", () => {
			expect(normalizeModel("gpt-6.1")).toBe(SOL61);
		});

		// The `.` after `6` is a word boundary, so the bare `gpt-6` catch-all
		// would claim `gpt-6.1*` spellings for Astra without an earlier branch.
		it("is not swallowed by the gpt-6 -> Astra catch-all", () => {
			expect(normalizeModel("GPT 6.1 Sol (OAuth)")).toBe(SOL61);
			expect(normalizeModel("openai/gpt-6.1-sol-high")).toBe(SOL61);
			expect(getModelFamily("GPT 6.1 Sol (Codex OAuth)")).toBe(SOL61);
			expect(getModelFamily("gpt-6.1-sol-ultra")).toBe(SOL61);
			expect(getModelFamily("gpt-6.1")).toBe(SOL61);
		});

		it("keeps the bare gpt-6 alias on Astra", () => {
			expect(normalizeModel("gpt-6")).toBe("gpt-6-astra");
			expect(getModelFamily("gpt-6")).toBe("gpt-6-astra");
		});
	});

	describe("model family", () => {
		it("gets its own isolated, registered family", () => {
			expect(getModelFamily(SOL61)).toBe(SOL61);
			expect(MODEL_FAMILIES).toContain(SOL61);
		});
	});

	describe("reasoning effort", () => {
		it("passes max and xhigh through", () => {
			expect(getReasoningConfig(SOL61, { reasoningEffort: "max" }).effort).toBe("max");
			expect(getReasoningConfig(SOL61, { reasoningEffort: "xhigh" }).effort).toBe("xhigh");
		});

		it("sends ultra as the catalog multi_agent_reasoning_effort (xhigh)", () => {
			expect(getReasoningConfig(SOL61, { reasoningEffort: "ultra" }).effort).toBe("xhigh");
		});

		it("floors none and minimal to low", () => {
			expect(getReasoningConfig(SOL61, { reasoningEffort: "none" }).effort).toBe("low");
			expect(getReasoningConfig(SOL61, { reasoningEffort: "minimal" }).effort).toBe("low");
		});
	});

	describe("wire shape", () => {
		it("uses the responses-lite path and the opencode originator", () => {
			expect(usesResponsesLite(SOL61)).toBe(true);
			expect(usesResponsesLite(`openai/${SOL61}-high`)).toBe(true);
			expect(resolveClientIdentity(SOL61).originator).toBe("opencode");
		});
	});

	describe("unsupported-model fallback", () => {
		afterEach(() => {
			delete process.env.CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK;
		});

		// The general order is astra > 6.1-sol > 6-sol > 5.6-sol > 5.6-terra >
		// 5.5 > 6-luna > 5.6-luna; this row is its tail after 6.1-sol.
		it("carries the general order's tail as its default chain", () => {
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[SOL61]).toEqual([
				"gpt-6-sol",
				"gpt-5.6-sol",
				"gpt-5.6-terra",
				"gpt-5.5",
				"gpt-6-luna",
				"gpt-5.6-luna",
			]);
		});

		it("is reachable from every other general entry point's chain", () => {
			const targets = Object.values(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN);
			for (const row of [
				"gpt-6-astra",
				"gpt-5.5",
				"gpt-6-luna",
				"gpt-5.6-luna",
			]) {
				expect(
					DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[row],
					row,
				).toContain(SOL61);
			}
			expect(targets.length).toBeGreaterThan(0);
		});

		// A custom chain keyed `gpt-6.1` must land on the same node the request
		// path normalized to (`gpt-6.1-sol`), or the user's row is silently
		// dropped and the default row picks the target instead.
		it("reads a custom chain keyed by the bare gpt-6.1 alias", () => {
			expect(
				pickFallbackChainTarget({
					currentModel: SOL61,
					attemptedModels: [SOL61],
					customChain: { "gpt-6.1": ["gpt-5.6-terra"] },
				}),
			).toBe("gpt-5.6-terra");
		});

		it("auto-falls-back without the global policy, and honors the GPT-6 opt-out", () => {
			const options = {
				requestedModel: SOL61,
				errorBody: unsupported(SOL61),
				attemptedModels: [SOL61],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			};
			expect(resolveUnsupportedCodexFallbackModel(options)).toBe("gpt-6-sol");

			process.env.CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK = "1";
			expect(resolveUnsupportedCodexFallbackModel(options)).toBeUndefined();
		});
	});

	describe("shipped config templates", () => {
		const read = (path: string) =>
			(JSON.parse(readFileSync(path, "utf8")) as TemplateShape).provider.openai.models;

		it("ships in the modern template with catalog-matching variants", () => {
			const models = read("config/opencode-modern.json");
			expect(Object.keys(models[SOL61]?.variants ?? {})).toEqual([...SOL61_EFFORTS]);
		});

		it("ships one legacy selector per catalog effort", () => {
			const ids = Object.keys(read("config/opencode-legacy.json"));
			expect(ids.filter((id) => id.startsWith(`${SOL61}-`))).toEqual(
				SOL61_EFFORTS.map((effort) => `${SOL61}-${effort}`),
			);
		});
	});
});

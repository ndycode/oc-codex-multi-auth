import { readFileSync } from "node:fs";
import { describe, expect, it, afterEach, vi } from "vitest";
import { getNormalizedModel, MODEL_MAP } from "../lib/request/helpers/model-map.js";
import { getModelFamily, MODEL_FAMILIES } from "../lib/prompts/codex.js";
import { getReasoningConfig, normalizeModel } from "../lib/request/request-transformer.js";
import {
	DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN,
	createCodexHeaders,
	resolveUnsupportedCodexFallbackModel,
	transformRequestForCodex,
} from "../lib/request/fetch-helpers.js";
import {
	RESPONSES_LITE_HEADER,
	RESPONSES_LITE_HEADER_VALUE,
	usesResponsesLite,
} from "../lib/request/helpers/responses-lite.js";
import { getCodexCatalogEntry } from "../lib/request/helpers/codex-catalog.js";
import { OPENAI_HEADERS } from "../lib/constants.js";

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

	it.each(["native", "legacy"] as const)(
		"serializes %s requests with the GPT-6.2 lite wire contract",
		async (requestTransformMode) => {
			if (requestTransformMode === "legacy") {
				// Legacy mode resolves the model-family prompt. Keep this test
				// deterministic and offline while still exercising the public
				// transform entry point and its prompt lookup path.
				vi.stubGlobal(
					"fetch",
					vi.fn(async (input: RequestInfo | URL) => {
						const url = String(input);
						if (url.includes("api.github.com/repos/openai/codex/releases")) {
							return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), {
								status: 200,
								headers: { "content-type": "application/json" },
							});
						}
						return new Response("You are Codex. ".repeat(32), {
							status: 200,
							headers: { etag: '"gpt62-test-prompt"' },
						});
					}),
				);
			}
			try {
				for (const model of [ASTRA, SOL]) {
					const transformed = await transformRequestForCodex(
						{ method: "POST" },
						"https://chatgpt.com/backend-api/codex/responses",
						{ global: {}, models: {} },
						true,
						{
							model: `openai/${model}-ultra`,
							input: [{ type: "message", role: "user", content: "hi" }],
							tools: [{ type: "function", name: "read_file" }],
							reasoning: { effort: "ultra" },
							store: true,
						},
						{ requestTransformMode },
					);
					expect(transformed).toBeDefined();

					const wire = JSON.parse(String(transformed?.updatedInit.body)) as {
						model: string;
						input?: Array<{ type?: string; role?: string; tools?: unknown[] }>;
						tools?: unknown;
						reasoning?: { effort?: string };
						store?: boolean;
						include?: string[];
					};
					expect(wire.model).toBe(model);
					expect(wire.tools).toBeUndefined();
					expect(wire.input?.[0]).toMatchObject({
						type: "additional_tools",
						role: "developer",
					});
					expect(wire.input?.[0]?.tools).toHaveLength(1);
					expect(wire.reasoning?.effort).toBe("xhigh");
					expect(wire.store).toBe(false);
					expect(wire.include).toContain("reasoning.encrypted_content");

					const headers = createCodexHeaders(
						transformed?.updatedInit,
						"acct",
						"token",
						{ model: wire.model },
					);
					expect(headers.get(RESPONSES_LITE_HEADER)).toBe(RESPONSES_LITE_HEADER_VALUE);
					expect(headers.get(OPENAI_HEADERS.ORIGINATOR)).toBe("opencode");
					expect(headers.get(OPENAI_HEADERS.ROUTING_HINT)).toBe(`model=${model}`);
				}
			} finally {
				if (requestTransformMode === "legacy") vi.unstubAllGlobals();
			}
		},
	);

	describe("unsupported-model fallback", () => {
		afterEach(() => delete process.env.CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK);

		it("keeps Astra above Sol and reaches the terminal Luna tier", () => {
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[ASTRA]).toEqual([
				SOL,
				"gpt-6.1-sol",
				"gpt-6-sol",
				"gpt-5.6-sol",
				"gpt-5.6-terra",
				"gpt-5.5",
				"gpt-6-luna",
				"gpt-5.6-luna",
			]);
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[SOL]).toEqual([
				"gpt-6.1-sol",
				"gpt-6-sol",
				"gpt-5.6-sol",
				"gpt-5.6-terra",
				"gpt-5.5",
				"gpt-6-luna",
				"gpt-5.6-luna",
			]);
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

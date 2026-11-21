import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { getNormalizedModel, MODEL_MAP } from "../lib/request/helpers/model-map.js";
import {
	extractCatalogInstructions,
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
import { MAX_QUOTA_FALLBACK_SWITCHES } from "../lib/constants.js";
import { resolveClientIdentity } from "../lib/request/helpers/client-identity.js";

/**
 * GPT-6 Sol and Luna, added to the Codex catalog on 2026-09-22
 * (openai/codex 49e95cc7). Effort ranges, `use_responses_lite` and the
 * `upgrade` targets below are read from that catalog entry.
 */
interface TemplateShape {
	provider: { openai: { models: Record<string, { variants?: Record<string, unknown> }> } };
}

const SOL = "gpt-6-sol";
const LUNA = "gpt-6-luna";
const BOTH = [SOL, LUNA] as const;
const SOL_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const LUNA_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Every general model still `visibility: "list"` in the catalog. */
const LIVE_GENERAL = [
	"gpt-6-astra",
	"gpt-6.1-sol",
	SOL,
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	LUNA,
	"gpt-5.6-luna",
	"gpt-5.5",
] as const;

const unsupported = (model: string) => ({
	error: {
		code: "model_not_supported_with_chatgpt_account",
		message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
	},
});

/** Walk the default chain the way the request path does: one hop per refusal. */
function walk(entry: string): string[] {
	const visited = [entry];
	for (let hop = 0; hop < 20; hop++) {
		const next = pickFallbackChainTarget({
			currentModel: visited[visited.length - 1] as string,
			attemptedModels: visited,
		});
		if (!next) break;
		visited.push(next);
	}
	return visited;
}

describe("GPT-6 Sol and Luna Model Support", () => {
	describe("normalization", () => {
		it("normalizes each canonical id and every catalog effort", () => {
			for (const effort of SOL_EFFORTS) {
				expect(normalizeModel(`${SOL}-${effort}`)).toBe(SOL);
			}
			for (const effort of LUNA_EFFORTS) {
				expect(normalizeModel(`${LUNA}-${effort}`)).toBe(LUNA);
			}
			for (const model of BOTH) {
				expect(normalizeModel(model)).toBe(model);
				expect(getNormalizedModel(model)).toBe(model);
			}
		});

		// The catalog stops Luna at `max`, same as gpt-5.6-luna.
		it("has no ultra alias for Luna and no none/minimal alias for either", () => {
			expect(MODEL_MAP[`${LUNA}-ultra`]).toBeUndefined();
			for (const model of BOTH) {
				expect(MODEL_MAP[`${model}-none`]).toBeUndefined();
				expect(MODEL_MAP[`${model}-minimal`]).toBeUndefined();
			}
		});

		// The bare `gpt-6` branch runs as a catch-all for every `gpt-6*` name, so
		// Sol and Luna must be matched before it or they silently become Astra.
		it("is not swallowed by the gpt-6 -> Astra catch-all", () => {
			expect(normalizeModel("GPT 6 Sol (OAuth)")).toBe(SOL);
			expect(normalizeModel("GPT 6 Luna (OAuth)")).toBe(LUNA);
			expect(normalizeModel("openai/gpt-6-luna-max")).toBe(LUNA);
			expect(getModelFamily("GPT 6 Sol (Codex OAuth)")).toBe(SOL);
			expect(getModelFamily("gpt-6-luna-high")).toBe(LUNA);
		});

		it("keeps the bare gpt-6 alias on Astra", () => {
			expect(normalizeModel("gpt-6")).toBe("gpt-6-astra");
			expect(getModelFamily("gpt-6")).toBe("gpt-6-astra");
		});
	});

	describe("model family", () => {
		it("gives each tier an isolated, registered family", () => {
			expect(getModelFamily(SOL)).toBe(SOL);
			expect(getModelFamily(LUNA)).toBe(LUNA);
			expect(MODEL_FAMILIES).toContain(SOL);
			expect(MODEL_FAMILIES).toContain(LUNA);
		});
	});

	describe("reasoning effort", () => {
		it("passes max and xhigh through", () => {
			for (const model of BOTH) {
				expect(getReasoningConfig(model, { reasoningEffort: "max" }).effort).toBe("max");
				expect(getReasoningConfig(model, { reasoningEffort: "xhigh" }).effort).toBe("xhigh");
			}
		});

		it("sends ultra as max, for Sol and for Luna which lacks ultra", () => {
			for (const model of BOTH) {
				expect(getReasoningConfig(model, { reasoningEffort: "ultra" }).effort).toBe("max");
			}
		});

		it("floors none and minimal to low", () => {
			for (const model of BOTH) {
				expect(getReasoningConfig(model, { reasoningEffort: "none" }).effort).toBe("low");
				expect(getReasoningConfig(model, { reasoningEffort: "minimal" }).effort).toBe("low");
			}
		});
	});

	describe("wire shape", () => {
		it("uses the responses-lite path and the opencode originator", () => {
			for (const model of BOTH) {
				expect(usesResponsesLite(model)).toBe(true);
				expect(usesResponsesLite(`openai/${model}-high`)).toBe(true);
				expect(resolveClientIdentity(model).originator).toBe("opencode");
			}
		});
	});

	describe("unsupported-model fallback", () => {
		afterEach(() => {
			delete process.env.CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK;
		});

		// The resolver reads the chain of the model it is CURRENTLY on, so a row
		// that is not consistent with the others dead-ends the walk early. Every
		// general entry point must reach every live general model below it.
		it("reaches every live general model from every general entry point", () => {
			for (const entry of LIVE_GENERAL) {
				const reached = new Set(walk(entry));
				for (const model of LIVE_GENERAL) {
					if (model === "gpt-6-astra" && entry !== model) continue;
					expect(reached.has(model), `${entry} never reaches ${model}`).toBe(true);
				}
			}
		});

		// index.ts caps quota hops per request at MAX_QUOTA_FALLBACK_SWITCHES. A
		// cap shorter than a row stops a quota-blocked walk before its tail.
		it("lets a quota-blocked request hop through every target of any default row", () => {
			for (const [model, targets] of Object.entries(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN)) {
				expect(targets.length, model).toBeLessThanOrEqual(MAX_QUOTA_FALLBACK_SWITCHES);
			}
		});

		// openai/codex #44250 removed gpt-5.2 from the catalog on 2026-09-09.
		it("no longer ends any default chain on gpt-5.2", () => {
			for (const targets of Object.values(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN)) {
				expect(targets).not.toContain("gpt-5.2");
			}
		});

		it("leads each retired id with the successor its catalog upgrade names", () => {
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN["gpt-5.4"]?.[0]).toBe(SOL);
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN["gpt-5.4-mini"]?.[0]).toBe(LUNA);
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN["gpt-5.5"]?.[0]).toBe(SOL);
		});

		// An entitlement 400 on a GPT-6 tier most likely means the account is
		// outside the GPT-6 rollout, so the sibling GPT-6 tier would fail too.
		it("crosses from each GPT-6 tier to its 5.6 counterpart first", () => {
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[SOL]?.[0]).toBe("gpt-5.6-sol");
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[LUNA]?.[0]).toBe("gpt-5.6-luna");
		});

		it("auto-falls-back without the global policy, and honors the GPT-6 opt-out", () => {
			const options = {
				requestedModel: SOL,
				errorBody: unsupported(SOL),
				attemptedModels: [SOL],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			};
			expect(resolveUnsupportedCodexFallbackModel(options)).toBe("gpt-5.6-sol");
			expect(
				resolveUnsupportedCodexFallbackModel({
					...options,
					requestedModel: LUNA,
					errorBody: unsupported(LUNA),
					attemptedModels: [LUNA],
				}),
			).toBe("gpt-5.6-luna");

			process.env.CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK = "1";
			expect(resolveUnsupportedCodexFallbackModel(options)).toBeUndefined();
		});
	});

	describe("shipped config templates", () => {
		const read = (path: string) =>
			(JSON.parse(readFileSync(path, "utf8")) as TemplateShape).provider.openai.models;

		it("ships both tiers in the modern template with catalog-matching variants", () => {
			const models = read("config/opencode-modern.json");
			expect(Object.keys(models[SOL]?.variants ?? {})).toEqual([...SOL_EFFORTS]);
			expect(Object.keys(models[LUNA]?.variants ?? {})).toEqual([...LUNA_EFFORTS]);
		});

		it("ships one legacy selector per catalog effort", () => {
			const ids = Object.keys(read("config/opencode-legacy.json"));
			expect(ids.filter((id) => id.startsWith(`${SOL}-`))).toEqual(
				SOL_EFFORTS.map((effort) => `${SOL}-${effort}`),
			);
			expect(ids.filter((id) => id.startsWith(`${LUNA}-`))).toEqual(
				LUNA_EFFORTS.map((effort) => `${LUNA}-${effort}`),
			);
		});
	});
});

// OpenAI docs: gpt-5.4 / gpt-5.4-mini retired from Codex with ChatGPT sign-in
// on 2026-08-31 (developers.openai.com/codex/models); gpt-5-codex and the
// gpt-5.1-codex family shut down 2026-07-23 (api/docs/deprecations).
describe("retired models", () => {
	const RETIRED = [
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.2",
		"gpt-5.3-codex",
		"gpt-5-codex",
		"gpt-5.1-codex",
		"gpt-5.1-codex-max",
		"gpt-5.1-codex-mini",
		"gpt-5.2-codex",
	] as const;
	const ownedByRetired = (id: string) =>
		RETIRED.some((base) => id === base || id.startsWith(`${base}-`)) &&
		// `gpt-5.4-nano` / `gpt-5.4-pro` are not on either deprecation list.
		!id.startsWith("gpt-5.4-nano") &&
		!id.startsWith("gpt-5.4-pro");

	it("ships no retired id in either template", () => {
		for (const path of ["config/opencode-modern.json", "config/opencode-legacy.json"]) {
			const ids = Object.keys(
				(JSON.parse(readFileSync(path, "utf8")) as TemplateShape).provider.openai.models,
			);
			expect(ids.filter(ownedByRetired), path).toEqual([]);
		}
	});

	// `gpt-5` / `gpt-5-<effort>` match the GPT-5.1 branch by spelling, which
	// allows "none", but resolve to gpt-6-sol, which rejects it.
	it("never sends none or minimal through a gpt-5 alias that resolves to Sol", () => {
		for (const alias of ["gpt-5", "gpt-5-none", "gpt-5-minimal", "gpt-5-low", "gpt-5-high"]) {
			expect(normalizeModel(alias)).toBe(SOL);
			for (const effort of ["none", "minimal"] as const) {
				expect(getReasoningConfig(alias, { reasoningEffort: effort }).effort, `${alias} ${effort}`).toBe("low");
			}
		}
	});

	it("never resolves a default or legacy alias onto a retired id", () => {
		expect(normalizeModel(undefined)).toBe(SOL);
		expect(normalizeModel("unknown-model")).toBe("unknown-model");
		expect(normalizeModel("gpt-5-mini")).toBe(LUNA);
	});

	// Hand-written configs that still name a retired id keep working: the id
	// routes as typed and the default chain rescues it.
	it("still routes a retired id a user typed by hand", () => {
		expect(normalizeModel("gpt-5.4-mini-high")).toBe("gpt-5.4-mini");
		expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN["gpt-5-codex"]?.length).toBeGreaterThan(0);
	});
});

describe("catalog instructions after openai/codex #43604", () => {
	// rust-v0.155.1 shape: no `base_instructions` on any entry, text in
	// `model_messages.instructions_template`. Reading only base_instructions
	// returned null for every model and served the legacy prompt file.
	it("reads instructions_template when base_instructions is absent", () => {
		const catalog = JSON.stringify({
			models: [
				{
					slug: SOL,
					model_messages: {
						instructions_template: "You are Codex, an agent based on GPT-6.",
						instructions_variables: null,
					},
				},
			],
		});
		expect(extractCatalogInstructions(catalog, SOL)).toBe(
			"You are Codex, an agent based on GPT-6.",
		);
	});

	// gpt-5.5 and gpt-5.4 carry `{{ personality }}` with personality_default "".
	// Codex substitutes the default when personality is off; so do we.
	it("renders the personality placeholder from personality_default", () => {
		const catalog = JSON.stringify({
			models: [
				{
					slug: "gpt-5.5",
					model_messages: {
						instructions_template: "Intro\n\n{{ personality }}\n\nRules",
						instructions_variables: {
							personality_default: "",
							personality_friendly: "# Personality\n\nWarm.",
						},
					},
				},
			],
		});
		expect(extractCatalogInstructions(catalog, "gpt-5.5")).toBe("Intro\n\n\n\nRules");
	});

	it("still prefers base_instructions on tags that predate the move", () => {
		const catalog = JSON.stringify({
			models: [
				{
					slug: "gpt-5.6-sol",
					base_instructions: "LEGACY",
					model_messages: { instructions_template: "TEMPLATE" },
				},
			],
		});
		expect(extractCatalogInstructions(catalog, "gpt-5.6-sol")).toBe("LEGACY");
	});

	// Valid JSON that is not an object used to throw on `.models`.
	it("returns null, not a throw, for a catalog that parses to a non-object", () => {
		for (const raw of ["null", "42", '"text"', "true", "[]", '{"models":null}', '{"models":[null,1]}']) {
			expect(() => extractCatalogInstructions(raw, SOL), raw).not.toThrow();
			expect(extractCatalogInstructions(raw, SOL), raw).toBeNull();
		}
	});

	it("returns null when neither source has text", () => {
		const catalog = JSON.stringify({
			models: [
				{ slug: SOL, base_instructions: "", model_messages: { instructions_template: "" } },
				{ slug: LUNA, model_messages: null },
			],
		});
		expect(extractCatalogInstructions(catalog, SOL)).toBeNull();
		expect(extractCatalogInstructions(catalog, LUNA)).toBeNull();
	});
});

import { readFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { getNormalizedModel, MODEL_MAP } from "../lib/request/helpers/model-map.js";
import {
	getEffortSuffix,
	stripEffortSuffix,
} from "../lib/request/helpers/effort-suffix.js";
import {
	extractCatalogInstructions,
	getModelFamily,
	MODEL_FAMILIES,
} from "../lib/prompts/codex.js";
import { normalizeModel, getReasoningConfig } from "../lib/request/request-transformer.js";
import { DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN } from "../lib/request/fetch-helpers.js";
import { usesResponsesLite } from "../lib/request/helpers/responses-lite.js";
import { resolveClientIdentity } from "../lib/request/helpers/client-identity.js";

/**
 * GPT-6 Astra (launched 2026-09-03) and the Daybreak cyber tiers.
 *
 * Effort support for Daybreak mirrors openai/codex
 * `codex-rs/models-manager/models.json`, where both tiers list low..ultra.
 * Astra's range comes from OpenAI's Codex model list, which shows Light
 * through Ultra; its API reference page stops at `max`, the same page-vs-
 * catalog split `gpt-5.6-sol` already has.
 */
interface TemplateShape {
	provider: { openai: { models: Record<string, unknown> } };
}

describe("GPT-6 Astra and Daybreak Model Support", () => {
	const ASTRA = "gpt-6-astra";
	const BLUE = "gpt-daybreak-blue-latest";
	const RED = "gpt-daybreak-red-latest";
	const CYBER = "gpt-5.6-cyber";
	const CYBER_TIERS = [BLUE, RED, CYBER] as const;
	const ALL = [ASTRA, BLUE, RED, CYBER] as const;
	const FULL_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

	describe("normalization", () => {
		it("normalizes each canonical id", () => {
			for (const model of ALL) {
				expect(normalizeModel(model)).toBe(model);
				expect(getNormalizedModel(model)).toBe(model);
			}
		});

		it("normalizes every effort variant, ultra included", () => {
			for (const model of ALL) {
				for (const effort of FULL_EFFORTS) {
					expect(normalizeModel(`${model}-${effort}`)).toBe(model);
					expect(getNormalizedModel(`${model}-${effort}`)).toBe(model);
				}
			}
		});

		it("maps the bare gpt-6 alias to Astra", () => {
			expect(normalizeModel("gpt-6")).toBe(ASTRA);
			expect(getNormalizedModel("gpt-6")).toBe(ASTRA);
		});

		// Astra Pro is press-reported for Pro/Business/Enterprise but absent from
		// OpenAI's Codex model list, so it is not a routable Codex slug. Emitting
		// it verbatim would 400; collapsing keeps the request alive on the tier
		// that does exist. Same treatment gpt-5.5-pro gets.
		it("collapses Astra Pro onto the base tier rather than emitting it", () => {
			expect(normalizeModel("gpt-6-astra-pro")).toBe(ASTRA);
			expect(normalizeModel("gpt-6-astra-pro-high")).toBe(ASTRA);
			expect(getNormalizedModel("gpt-6-astra-pro-ultra")).toBe(ASTRA);
		});

		// `gpt-5.6-cyber` carries "5.6" in its name, so every 5.6 branch that
		// runs before it would claim it and silently answer a security request
		// from Sol.
		it("does not let the bare gpt-5.6 branch swallow gpt-5.6-cyber", () => {
			expect(normalizeModel(CYBER)).toBe(CYBER);
			expect(normalizeModel("gpt-5.6-cyber-xhigh")).toBe(CYBER);
			expect(normalizeModel("GPT 5.6 Cyber (OAuth)")).toBe(CYBER);
			expect(getModelFamily(CYBER)).toBe("gpt-5.6-cyber");
			expect(getModelFamily("GPT 5.6 Cyber")).not.toBe("gpt-5.6-sol");
			// The sibling tiers must be unaffected by that new branch.
			expect(normalizeModel("gpt-5.6")).toBe("gpt-5.6-sol");
			expect(normalizeModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
		});

		it("accepts the Daybreak short forms without the -latest tail", () => {
			expect(normalizeModel("gpt-daybreak-blue")).toBe(BLUE);
			expect(normalizeModel("gpt-daybreak-red")).toBe(RED);
			expect(getNormalizedModel("gpt-daybreak-blue-xhigh")).toBe(BLUE);
			expect(getNormalizedModel("gpt-daybreak-red-max")).toBe(RED);
		});

		it("strips a provider prefix", () => {
			expect(normalizeModel("openai/gpt-6-astra-ultra")).toBe(ASTRA);
			expect(normalizeModel("openai/gpt-daybreak-red-latest-high")).toBe(RED);
		});

		it("resolves verbose display names through the pattern fallback", () => {
			expect(normalizeModel("GPT 6 Astra (OAuth)")).toBe(ASTRA);
			expect(normalizeModel("Daybreak Blue (OAuth)")).toBe(BLUE);
			expect(normalizeModel("Daybreak Red (OAuth)")).toBe(RED);
		});

		it("never exposes none/minimal aliases", () => {
			for (const model of ALL) {
				expect(MODEL_MAP[`${model}-none`]).toBeUndefined();
				expect(MODEL_MAP[`${model}-minimal`]).toBeUndefined();
			}
			expect(MODEL_MAP["gpt-6-astra-none"]).toBeUndefined();
		});

		it("does not claim gpt-7 or other future ids", () => {
			expect(getNormalizedModel("gpt-7")).toBeUndefined();
			expect(getNormalizedModel("gpt-7-astra")).toBeUndefined();
		});
	});

	describe("model family", () => {
		it("gives each model an isolated family", () => {
			expect(getModelFamily(ASTRA)).toBe("gpt-6-astra");
			expect(getModelFamily(BLUE)).toBe("gpt-daybreak-blue");
			expect(getModelFamily(RED)).toBe("gpt-daybreak-red");
			expect(getModelFamily(CYBER)).toBe("gpt-5.6-cyber");
		});

		it("registers the new families for per-family rotation state", () => {
			expect(MODEL_FAMILIES).toContain("gpt-6-astra");
			expect(MODEL_FAMILIES).toContain("gpt-daybreak-blue");
			expect(MODEL_FAMILIES).toContain("gpt-daybreak-red");
			expect(MODEL_FAMILIES).toContain("gpt-5.6-cyber");
		});

		it("routes bare gpt-6 to the Astra family", () => {
			expect(getModelFamily("gpt-6")).toBe("gpt-6-astra");
		});

		// The `codex` catch-all in getModelFamily matches any name containing
		// "codex" and runs before the 5.6 branches. Astra and Daybreak are
		// matched ahead of it so a display name carrying "Codex" cannot drag
		// them into the wrong prompt family.
		it("is not swallowed by the codex catch-all", () => {
			expect(getModelFamily("GPT 6 Astra (Codex OAuth)")).toBe("gpt-6-astra");
			expect(getModelFamily("Daybreak Red Codex")).toBe("gpt-daybreak-red");
		});

		it("keeps Astra out of the 5.6 and 5.1 families", () => {
			expect(getModelFamily(ASTRA)).not.toBe("gpt-5.6-sol");
			expect(getModelFamily(ASTRA)).not.toBe("gpt-5.1");
		});
	});

	describe("reasoning effort", () => {
		it("passes max through", () => {
			for (const model of ALL) {
				expect(getReasoningConfig(model, { reasoningEffort: "max" }).effort).toBe(
					"max",
				);
			}
		});

		// Codex rewrites Ultra -> Max client-side
		// (codex-rs/core/src/client.rs `reasoning_effort_for_request`), so ultra
		// must never reach the backend.
		// Codex resolves ultra to the catalog's multi_agent_reasoning_effort
		// (xhigh on Astra), falling back to max when a model has none.
		it("resolves ultra like codex-rs resolve_reasoning_effort", () => {
			for (const model of ALL) {
				expect(
					getReasoningConfig(model, { reasoningEffort: "ultra" }).effort,
				).toBe(model === ASTRA ? "xhigh" : "max");
			}
		});

		it("supports xhigh directly", () => {
			for (const model of ALL) {
				expect(
					getReasoningConfig(model, { reasoningEffort: "xhigh" }).effort,
				).toBe("xhigh");
			}
		});

		it("upgrades none and minimal to low, since neither is accepted", () => {
			for (const model of ALL) {
				expect(getReasoningConfig(model, { reasoningEffort: "none" }).effort).toBe(
					"low",
				);
				expect(
					getReasoningConfig(model, { reasoningEffort: "minimal" }).effort,
				).toBe("low");
			}
		});

		it("never emits none, minimal or ultra at any requested effort", () => {
			const requested = [
				"none",
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
				"ultra",
			] as const;
			for (const model of ALL) {
				for (const effort of requested) {
					const resolved = getReasoningConfig(model, {
						reasoningEffort: effort,
					}).effort;
					expect(resolved).not.toBe("none");
					expect(resolved).not.toBe("minimal");
					expect(resolved).not.toBe("ultra");
				}
			}
		});

		it("resolves effort through the bare gpt-6 alias too", () => {
			expect(getReasoningConfig("gpt-6", { reasoningEffort: "ultra" }).effort).toBe(
				"xhigh",
			);
			expect(getReasoningConfig("gpt-6", { reasoningEffort: "none" }).effort).toBe(
				"low",
			);
		});
	});

	describe("effort suffix parsing", () => {
		it("reads suffixes on the new ids", () => {
			expect(getEffortSuffix("gpt-6-astra-max")).toBe("max");
			expect(getEffortSuffix("gpt-6-astra-ultra")).toBe("ultra");
			expect(stripEffortSuffix("gpt-6-astra-max")).toBe(ASTRA);
			expect(stripEffortSuffix("gpt-daybreak-red-latest-ultra")).toBe(RED);
		});

		// The canonical Daybreak ids end in `-latest`, which is not an effort.
		it("does not treat the -latest tail as an effort suffix", () => {
			expect(getEffortSuffix(BLUE)).toBeUndefined();
			expect(stripEffortSuffix(BLUE)).toBe(BLUE);
		});
	});

	describe("responses-lite shaping", () => {

		// Both Daybreak entries are `use_responses_lite: true` in the catalog.
		it("puts every cyber tier on the lite path", () => {
			for (const model of CYBER_TIERS) {
				expect(usesResponsesLite(model)).toBe(true);
			}
			expect(usesResponsesLite("openai/gpt-daybreak-blue-xhigh")).toBe(true);
		});

		// Read from the catalog now, not inferred: gpt-6-astra is
		// `use_responses_lite: true`, `tool_mode: "code_mode_only"`.
		it("puts Astra on the lite path", () => {
			expect(usesResponsesLite(ASTRA)).toBe(true);
			expect(usesResponsesLite("gpt-6")).toBe(true);
			expect(usesResponsesLite("openai/gpt-6-astra-ultra")).toBe(true);
		});

		// 6.17.0 kept Astra behind CODEX_AUTH_ASTRA_RESPONSES_LITE because no
		// catalog entry existed to read `use_responses_lite` from. The entry
		// landed in openai/codex ed391d4d and confirmed the inference, so the
		// switch is gone and no env var may change the shaping decision.
		it("ignores the retired CODEX_AUTH_ASTRA_RESPONSES_LITE switch", () => {
			process.env.CODEX_AUTH_ASTRA_RESPONSES_LITE = "0";
			try {
				expect(usesResponsesLite(ASTRA)).toBe(true);
				expect(usesResponsesLite("gpt-6")).toBe(true);
			} finally {
				delete process.env.CODEX_AUTH_ASTRA_RESPONSES_LITE;
			}
		});
	});

	describe("client identity", () => {
		// Lite models present the host identity, the originator this plugin has
		// evidence of passing the newest tier with (#196).
		it("sends the opencode originator for the new lite models", () => {
			for (const model of ALL) {
				expect(resolveClientIdentity(model).originator).toBe("opencode");
			}
		});
	});

	describe("unsupported-model fallback", () => {
		it("degrades Astra through GPT-6.1 Sol, GPT-6 Sol and the 5.6 tiers to the gpt-5.6-luna terminal", () => {
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[ASTRA]).toEqual([
				"gpt-6.1-sol",
				"gpt-6-sol",
				"gpt-5.6-sol",
				"gpt-5.6-terra",
				"gpt-5.5",
				"gpt-6-luna",
				"gpt-5.6-luna",
			]);
		});

		// Degrading a cyber-specialty request onto a general model would answer
		// a security-research prompt with a model nobody asked for.
		it("gives the cyber tiers no fallback chain", () => {
			for (const model of CYBER_TIERS) {
				expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[model]).toBeUndefined();
			}
		});

		it("does not make Astra a fallback target of any other model", () => {
			for (const targets of Object.values(
				DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN,
			)) {
				expect(targets).not.toContain(ASTRA);
			}
		});
	});

	// The templates already exclude `gpt-5.3-codex-spark` because shipping an
	// entitlement-gated id to every user causes avoidable startup failures. All
	// three cyber tiers need Daybreak program approval, and Blue/Red are
	// `visibility: "hide"` in the catalog, so the same rule applies to them.
	describe("shipped config templates", () => {
		const templates = ["config/opencode-modern.json", "config/opencode-legacy.json"];

		it("ships Astra but no Daybreak-gated cyber tier", () => {
			for (const template of templates) {
				const ids = Object.keys(
					(JSON.parse(readFileSync(template, "utf8")) as TemplateShape).provider
						.openai.models,
				);
				expect(ids.some((id) => id.startsWith(ASTRA))).toBe(true);
				for (const id of ids) {
					expect(id).not.toContain("daybreak");
					expect(id).not.toContain("cyber");
				}
			}
		});

		it("still routes the gated ids even though they are unshipped", () => {
			for (const model of CYBER_TIERS) {
				expect(normalizeModel(model)).toBe(model);
			}
		});
	});

	describe("catalog-sourced instructions", () => {
		const catalog = JSON.stringify({
			models: [
				{ slug: BLUE, base_instructions: "BLUE PROMPT" },
				{ slug: RED, base_instructions: "RED PROMPT" },
			],
		});

		it("extracts base_instructions for the Daybreak slugs", () => {
			expect(extractCatalogInstructions(catalog, BLUE)).toBe("BLUE PROMPT");
			expect(extractCatalogInstructions(catalog, RED)).toBe("RED PROMPT");
		});

		// An entry with an empty `base_instructions` and no template must read
		// as absent so the model falls through to its prompt file rather than
		// being handed no instructions at all.
		it("treats an empty base_instructions with no template as absent", () => {
			const withAstra = JSON.stringify({
				models: [{ slug: ASTRA, base_instructions: "" }],
			});
			expect(extractCatalogInstructions(withAstra, ASTRA)).toBeNull();
			expect(extractCatalogInstructions(catalog, ASTRA)).toBeNull();
		});
	});
});

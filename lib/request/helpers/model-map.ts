/**
 * Model Configuration Map
 *
 * Maps model config IDs to their normalized API model names.
 * Only includes exact config IDs that OpenCode will pass to the plugin.
 */

/**
 * Map of config model IDs to normalized API model names
 *
 * Key: The model ID as specified in opencode.json config
 * Value: The normalized model name to send to the API
 */
const DATED_ALIAS_EFFORT_SUFFIXES = [
	"",
	"-none",
	"-low",
	"-medium",
	"-high",
	"-xhigh",
] as const;
const GPT_54_SNAPSHOT_DATE = "2026-03-05" as const;
const GPT_55_REJECTED_DATED_RELEASE_ID = "gpt-5.5-20260423" as const;
export const GPT_55_MODEL_ID = "gpt-5.5" as const;

export const GPT_56_SOL_MODEL_ID = "gpt-5.6-sol" as const;
export const GPT_56_TERRA_MODEL_ID = "gpt-5.6-terra" as const;
export const GPT_56_LUNA_MODEL_ID = "gpt-5.6-luna" as const;

/** GPT-6 Astra, OpenAI's frontier model as of the 2026-09-03 launch. */
export const GPT_6_ASTRA_MODEL_ID = "gpt-6-astra" as const;

/**
 * GPT-6 Sol and Luna, added to the Codex catalog on 2026-09-22
 * (openai/codex 49e95cc7). Sol is the "workhorse model for coding"; Luna is
 * the "fast and affordable model for easier tasks". The catalog makes them
 * the named `upgrade` target of every older general model: gpt-5.5,
 * gpt-5.6-sol, gpt-5.6-terra and retired gpt-5.4 -> gpt-6-sol, gpt-5.6-luna
 * and retired gpt-5.4-mini -> gpt-6-luna.
 */
export const GPT_6_SOL_MODEL_ID = "gpt-6-sol" as const;
export const GPT_6_LUNA_MODEL_ID = "gpt-6-luna" as const;

/**
 * GPT-6.1 Sol, "the latest workhorse model for coding and everyday work",
 * added to the Codex model catalog on 2026-09-29 (openai/codex b1e72963,
 * PR #49318) as the new default catalog model — priority 1, ahead of Astra.
 * The same day the openai-python (#3986, v3.21.0) and openai-node (#2836)
 * SDKs added `gpt-6.1-sol` to their ChatModel enums for Chat Completions
 * and Responses.
 *
 * Its catalog entry is `use_responses_lite: true`,
 * `tool_mode: "code_mode_only"`, `multi_agent_version: "v2"`, and it lists
 * every plan Astra does including the new `promax` tier. GPT-6.1 Astra was
 * cancelled on 2026-09-28 and never got a
 * model id. `minimal_client_version` is 0.153.0 and no released tag carries
 * the entry yet (rust-v0.159.0 predates the commit; it lands with the next
 * release), so catalog-sourced instructions fall back to the prompt file
 * until then.
 */
export const GPT_61_SOL_MODEL_ID = "gpt-6.1-sol" as const;

/** GPT-6.1 Terra is a distinct responses-lite model with low..ultra efforts. */
export const GPT_61_TERRA_MODEL_ID = "gpt-6.1-terra" as const;

/**
 * Daybreak cyber tiers, verified in the Codex model catalog
 * (openai/codex `codex-rs/models-manager/models.json`, rust-v0.153.0+):
 * `gpt-daybreak-blue-latest` (`model_specialty: cyber`, defensive) and
 * `gpt-daybreak-red-latest` (cyber-permissive, for authorized research).
 *
 * Both carry `visibility: "hide"`, so Codex does not list them in its model
 * picker. They are opt-in ids, never a default and never a fallback target.
 */
export const DAYBREAK_BLUE_MODEL_ID = "gpt-daybreak-blue-latest" as const;
export const DAYBREAK_RED_MODEL_ID = "gpt-daybreak-red-latest" as const;

/**
 * `gpt-5.6-cyber`, OpenAI's published alias for the purpose-trained security
 * models ("for approved defenders conducting advanced, authorized
 * vulnerability research, exploit validation, and security testing").
 *
 * Named for the 5.6 generation, not GPT-6, and Daybreak-gated like the two
 * `-latest` tiers. It has no entry in the Codex catalog under this slug — only
 * the Daybreak aliases it fronts do.
 */
export const GPT_56_CYBER_MODEL_ID = "gpt-5.6-cyber" as const;

/**
 * Effort suffixes each GPT-5.6 tier accepts, per the Codex model catalog
 * (openai/codex `codex-rs/models-manager/models.json`).
 *
 * Sol and Terra both expose `max` and `ultra`; Luna stops at `max`. None of the
 * three accept `none` or `minimal`. Press coverage claiming `max`/`ultra` are
 * Sol-exclusive contradicts the catalog — the catalog wins.
 */
const LOW_TO_ULTRA_EFFORT_SUFFIXES = [
	"",
	"-low",
	"-medium",
	"-high",
	"-xhigh",
	"-max",
	"-ultra",
] as const;
const GPT_56_SOL_TERRA_EFFORT_SUFFIXES = LOW_TO_ULTRA_EFFORT_SUFFIXES;
const GPT_56_LUNA_EFFORT_SUFFIXES = [
	"",
	"-low",
	"-medium",
	"-high",
	"-xhigh",
	"-max",
] as const;

function expandDatedAliases(prefix: string, target: string): Record<string, string> {
	return Object.fromEntries(
		DATED_ALIAS_EFFORT_SUFFIXES.map((suffix) => [`${prefix}${suffix}`, target]),
	);
}

/**
 * Expand `<prefix><suffix>` keys onto `target`.
 *
 * Use when the selector a user types is an alias for a different canonical id
 * (for example `gpt-6-astra-pro-high` -> `gpt-6-astra`).
 */
function expandAliasEfforts(
	prefix: string,
	target: string,
	suffixes: readonly string[],
): Record<string, string> {
	return Object.fromEntries(
		suffixes.map((suffix) => [`${prefix}${suffix}`, target]),
	);
}

function expandEffortAliases(
	target: string,
	suffixes: readonly string[],
): Record<string, string> {
	return expandAliasEfforts(target, target, suffixes);
}

export const MODEL_MAP: Record<string, string> = {
	// ============================================================================
	// GPT-6 Astra (frontier family, launched 2026-09-03)
	//
	// Opt-in only, exactly like the 5.6 tiers below: `gpt-5` and normalizeModel's
	// default still resolve to 5.5/5.4. Astra rolled out first to a limited set
	// of organizations (OpenAI's Daybreak Access program) and only then to Plus/
	// Pro/Business/Enterprise, so making it a default would 400 every account
	// still outside the rollout.
	//
	// Efforts are low/medium/high/xhigh/max/ultra per OpenAI's Codex model list
	// (developers.openai.com/codex/models lists Astra with Light through Ultra).
	// The API reference page for `gpt-6-astra` says only "`reasoning.effort`
	// supports `low`, `medium`, `high`, `xhigh`, and `max`" — but that is not a
	// contradiction: `ultra` is a Codex client-side tier that is rewritten to
	// `max` before the request leaves the client, so it has no reason to appear
	// in an API reference at all. `gpt-5.6-sol` shows exactly the same split
	// (its API page omits ultra while the catalog grants it).
	//
	// `-none` and `-minimal` are intentionally absent: Astra accepts neither.
	// ============================================================================
	...expandEffortAliases(GPT_6_ASTRA_MODEL_ID, LOW_TO_ULTRA_EFFORT_SUFFIXES),
	// Plugin-side convenience alias. OpenAI does not publish a bare `gpt-6`
	// alias, so this is ours. It stays on Astra, the frontier tier, now that
	// Sol and Luna exist too: re-pointing it would silently downgrade anyone
	// who already selected it.
	"gpt-6": GPT_6_ASTRA_MODEL_ID,

	// ============================================================================
	// GPT-6 Sol / Luna (added to the Codex catalog 2026-09-22)
	//
	// Both are `visibility: "list"` and name every plan Astra does, plus
	// `ent26`. Efforts per the catalog: Sol low..ultra, Luna low..max, the
	// same split as the 5.6 Sol/Luna pair. Neither accepts `none`/`minimal`.
	// ============================================================================
	...expandEffortAliases(GPT_6_SOL_MODEL_ID, LOW_TO_ULTRA_EFFORT_SUFFIXES),
	...expandEffortAliases(GPT_6_LUNA_MODEL_ID, GPT_56_LUNA_EFFORT_SUFFIXES),
	// "GPT-6 Astra Pro" appears in launch-day press but is very likely not a
	// model id at all: `/api/docs/models/gpt-6-astra-pro` 404s while the real
	// `gpt-5.5-pro` and `gpt-5.4-pro` pages both 200, and it appears in neither
	// the `ChatModel` nor `ResponsesOnlyModel` enum of the OpenAPI spec added by
	// the SDK PR whose whole purpose was enumerating the new Astra ids
	// (openai/openai-python#3791) — an enum that does list `gpt-5.5-pro`.
	// Most plausibly it is shorthand for "Astra, on the Pro plan". Map it to
	// the real tier anyway so a user who typed it after reading the press gets
	// a working request instead of an unknown slug on the wire.
	...expandAliasEfforts(
		"gpt-6-astra-pro",
		GPT_6_ASTRA_MODEL_ID,
		LOW_TO_ULTRA_EFFORT_SUFFIXES,
	),

	// ============================================================================
	// GPT-6.1 Sol (added to the Codex catalog 2026-09-29 as the default model)
	//
	// `visibility: "list"` and listed for every plan, so it is safe as a
	// fallback target the moment an account's catalog refreshes. Efforts per
	// the catalog: low..ultra, the same split as gpt-6-sol. Neither `none` nor
	// `minimal` is accepted.
	// ============================================================================
	...expandEffortAliases(GPT_61_SOL_MODEL_ID, LOW_TO_ULTRA_EFFORT_SUFFIXES),
	// Bare `gpt-6.1` mirrors `gpt-5.6` -> Sol.
	"gpt-6.1": GPT_61_SOL_MODEL_ID,
	...expandEffortAliases(GPT_61_TERRA_MODEL_ID, LOW_TO_ULTRA_EFFORT_SUFFIXES),

	// ============================================================================
	// Cyber tiers (Daybreak-gated)
	//
	// Blue is the defensive-security tier; Red is the cyber-permissive tier for
	// authorized security research; `gpt-5.6-cyber` is OpenAI's published alias
	// fronting them. All three are opt-in ids a user must type, and none is ever
	// a fallback target — degrading a cyber-specialty request onto a general
	// model would silently change the model's behavior.
	//
	// Deliberately absent from the shipped config templates. All three need
	// Daybreak program approval, and Blue/Red are `visibility: "hide"` in the
	// catalog, so listing them in every user's model picker would produce the
	// avoidable startup failures the templates already keep
	// `gpt-5.3-codex-spark` out for. Entitled users add them by hand.
	// ============================================================================
	...expandEffortAliases(DAYBREAK_BLUE_MODEL_ID, LOW_TO_ULTRA_EFFORT_SUFFIXES),
	...expandEffortAliases(DAYBREAK_RED_MODEL_ID, LOW_TO_ULTRA_EFFORT_SUFFIXES),
	// Efforts are not published for the alias; it inherits the range of the
	// tiers it fronts, both of which the catalog gives low..ultra.
	...expandEffortAliases(GPT_56_CYBER_MODEL_ID, LOW_TO_ULTRA_EFFORT_SUFFIXES),
	// Short forms, since the canonical ids carry a `-latest` tail.
	...expandAliasEfforts(
		"gpt-daybreak-blue",
		DAYBREAK_BLUE_MODEL_ID,
		LOW_TO_ULTRA_EFFORT_SUFFIXES,
	),
	...expandAliasEfforts(
		"gpt-daybreak-red",
		DAYBREAK_RED_MODEL_ID,
		LOW_TO_ULTRA_EFFORT_SUFFIXES,
	),

	// ============================================================================
	// GPT-5.6 Models (Sol / Terra / Luna)
	//
	// Opt-in only: the legacy `gpt-5` alias and normalizeModel's default both
	// still resolve to the 5.5/5.4 families. GPT-5.6 shipped as a limited
	// preview, so accounts outside it would fail on every request if these
	// became the default. Users select `gpt-5.6-*` explicitly; the unsupported
	// -model fallback chain then degrades to 5.5 if the account lacks access.
	//
	// `-none` and `-minimal` are intentionally absent: no 5.6 tier accepts them.
	// `-ultra` is absent for Luna: the catalog stops that tier at `max`.
	// ============================================================================
	...expandEffortAliases(GPT_56_SOL_MODEL_ID, GPT_56_SOL_TERRA_EFFORT_SUFFIXES),
	...expandEffortAliases(GPT_56_TERRA_MODEL_ID, GPT_56_SOL_TERRA_EFFORT_SUFFIXES),
	...expandEffortAliases(GPT_56_LUNA_MODEL_ID, GPT_56_LUNA_EFFORT_SUFFIXES),
	// Bare `gpt-5.6` is the flagship alias, mirroring how OpenAI's API docs
	// reference `gpt-5.6` on the Sol model page.
	"gpt-5.6": GPT_56_SOL_MODEL_ID,

	// ============================================================================
	// GPT-5 Codex Models (canonical stable family)
	// ============================================================================
	"gpt-5-codex": "gpt-5-codex",
	"gpt-5-codex-none": "gpt-5-codex",
	"gpt-5-codex-minimal": "gpt-5-codex",
	"gpt-5-codex-low": "gpt-5-codex",
	"gpt-5-codex-medium": "gpt-5-codex",
	"gpt-5-codex-high": "gpt-5-codex",
	"gpt-5-codex-xhigh": "gpt-5-codex",

	// ============================================================================
	// GPT-5.3 Codex Spark Models (distinct backend model; does NOT support "none")
	// ============================================================================
	"gpt-5.3-codex-spark": "gpt-5.3-codex-spark",
	"gpt-5.3-codex-spark-low": "gpt-5.3-codex-spark",
	"gpt-5.3-codex-spark-medium": "gpt-5.3-codex-spark",
	"gpt-5.3-codex-spark-high": "gpt-5.3-codex-spark",
	"gpt-5.3-codex-spark-xhigh": "gpt-5.3-codex-spark",
	// "-none" is intentionally absent: gpt-5.3-codex-spark rejects reasoning effort "none"

	// ============================================================================
	// GPT-5.3 Codex Models (distinct backend model; does NOT support "none")
	// ============================================================================
	"gpt-5.3-codex": "gpt-5.3-codex",
	"gpt-5.3-codex-low": "gpt-5.3-codex",
	"gpt-5.3-codex-medium": "gpt-5.3-codex",
	"gpt-5.3-codex-high": "gpt-5.3-codex",
	"gpt-5.3-codex-xhigh": "gpt-5.3-codex",
	// "-none" is intentionally absent: gpt-5.3-codex rejects reasoning effort "none"

	// ============================================================================
	// GPT-5.1 Codex Models (legacy aliases)
	// ============================================================================
	"gpt-5.1-codex": "gpt-5-codex",
	"gpt-5.1-codex-low": "gpt-5-codex",
	"gpt-5.1-codex-medium": "gpt-5-codex",
	"gpt-5.1-codex-high": "gpt-5-codex",

	// ============================================================================
	// GPT-5.1 Codex Max Models
	// ============================================================================
	"gpt-5.1-codex-max": "gpt-5.1-codex-max",
	"gpt-5.1-codex-max-low": "gpt-5.1-codex-max",
	"gpt-5.1-codex-max-medium": "gpt-5.1-codex-max",
	"gpt-5.1-codex-max-high": "gpt-5.1-codex-max",
	"gpt-5.1-codex-max-xhigh": "gpt-5.1-codex-max",

	// ============================================================================
	// GPT-5.5 Models (latest general-purpose family)
	//
	// GPT-5.5 Pro is intentionally NOT mapped here: per OpenAI's 2026-04-23
	// launch announcement, GPT-5.5 Pro ships to ChatGPT only, not to Codex.
	// Attempting to route `gpt-5.5-pro*` through the Codex OAuth pipeline
	// produces `model_not_supported_with_chatgpt_account` on every account.
	// ============================================================================
	"gpt-5.5": GPT_55_MODEL_ID,
	"gpt-5.5-none": GPT_55_MODEL_ID,
	"gpt-5.5-low": GPT_55_MODEL_ID,
	"gpt-5.5-medium": GPT_55_MODEL_ID,
	"gpt-5.5-high": GPT_55_MODEL_ID,
	"gpt-5.5-xhigh": GPT_55_MODEL_ID,
	"gpt-5.5-fast": GPT_55_MODEL_ID,
	"gpt-5.5-fast-none": GPT_55_MODEL_ID,
	"gpt-5.5-fast-low": GPT_55_MODEL_ID,
	"gpt-5.5-fast-medium": GPT_55_MODEL_ID,
	"gpt-5.5-fast-high": GPT_55_MODEL_ID,
	"gpt-5.5-fast-xhigh": GPT_55_MODEL_ID,
	...expandDatedAliases(GPT_55_REJECTED_DATED_RELEASE_ID, GPT_55_MODEL_ID),

	// ============================================================================
	// GPT-5.4 Models (legacy latest general-purpose family)
	// ============================================================================
	"gpt-5.4": "gpt-5.4",
	"gpt-5.4-none": "gpt-5.4",
	"gpt-5.4-low": "gpt-5.4",
	"gpt-5.4-medium": "gpt-5.4",
	"gpt-5.4-high": "gpt-5.4",
	"gpt-5.4-xhigh": "gpt-5.4",
	"gpt-5.4-fast": "gpt-5.4",
	...expandDatedAliases(`gpt-5.4-${GPT_54_SNAPSHOT_DATE}`, "gpt-5.4"),

	// ============================================================================
	// GPT-5.4 Pro Models (optional/manual config)
	// ============================================================================
	"gpt-5.4-pro": "gpt-5.4-pro",
	"gpt-5.4-pro-medium": "gpt-5.4-pro",
	"gpt-5.4-pro-high": "gpt-5.4-pro",
	"gpt-5.4-pro-xhigh": "gpt-5.4-pro",
	...expandDatedAliases(`gpt-5.4-pro-${GPT_54_SNAPSHOT_DATE}`, "gpt-5.4-pro"),

	// ============================================================================
	// GPT-5.4 Mini Models (latest efficient family)
	// ============================================================================
	"gpt-5.4-mini": "gpt-5.4-mini",
	"gpt-5.4-mini-none": "gpt-5.4-mini",
	"gpt-5.4-mini-low": "gpt-5.4-mini",
	"gpt-5.4-mini-medium": "gpt-5.4-mini",
	"gpt-5.4-mini-high": "gpt-5.4-mini",
	"gpt-5.4-mini-xhigh": "gpt-5.4-mini",
	"gpt-5.4-mini-fast": "gpt-5.4-mini",
	...expandDatedAliases(`gpt-5.4-mini-${GPT_54_SNAPSHOT_DATE}`, "gpt-5.4-mini"),

	// ============================================================================
	// GPT-5.4 Nano Models (lightweight efficient family)
	// ============================================================================
	"gpt-5.4-nano": "gpt-5.4-nano",
	"gpt-5.4-nano-none": "gpt-5.4-nano",
	"gpt-5.4-nano-low": "gpt-5.4-nano",
	"gpt-5.4-nano-medium": "gpt-5.4-nano",
	"gpt-5.4-nano-high": "gpt-5.4-nano",
	"gpt-5.4-nano-xhigh": "gpt-5.4-nano",
	...expandDatedAliases(`gpt-5.4-nano-${GPT_54_SNAPSHOT_DATE}`, "gpt-5.4-nano"),

	// ============================================================================
	// GPT-5.2 Models (supports none/low/medium/high/xhigh per OpenAI API docs)
	// ============================================================================
	"gpt-5.2": "gpt-5.2",
	"gpt-5.2-none": "gpt-5.2",
	"gpt-5.2-low": "gpt-5.2",
	"gpt-5.2-medium": "gpt-5.2",
	"gpt-5.2-high": "gpt-5.2",
	"gpt-5.2-xhigh": "gpt-5.2",

	// ============================================================================
	// GPT-5.2 Codex Models (distinct backend model; does NOT support "none")
	// ============================================================================
	"gpt-5.2-codex": "gpt-5.2-codex",
	"gpt-5.2-codex-low": "gpt-5.2-codex",
	"gpt-5.2-codex-medium": "gpt-5.2-codex",
	"gpt-5.2-codex-high": "gpt-5.2-codex",
	"gpt-5.2-codex-xhigh": "gpt-5.2-codex",
	// "-none" is intentionally absent: gpt-5.2-codex rejects reasoning effort "none"

	// ============================================================================
	// GPT-5.1 Codex Mini Models
	// ============================================================================
	"gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
	"gpt-5.1-codex-mini-medium": "gpt-5.1-codex-mini",
	"gpt-5.1-codex-mini-high": "gpt-5.1-codex-mini",

	// ============================================================================
	// GPT-5.1 General Purpose Models (supports none/low/medium/high per OpenAI API docs)
	// ============================================================================
	"gpt-5.1": "gpt-5.1",
	"gpt-5.1-none": "gpt-5.1",
	"gpt-5.1-low": "gpt-5.1",
	"gpt-5.1-medium": "gpt-5.1",
	"gpt-5.1-high": "gpt-5.1",
	"gpt-5.1-chat-latest": "gpt-5.1",

	// ============================================================================
	// GPT-5 Codex alias (legacy/case variants)
	// ============================================================================
	"gpt_5_codex": "gpt-5-codex",

	// ============================================================================
	// GPT-5 Codex Mini Models (LEGACY - maps to gpt-5.1-codex-mini)
	// ============================================================================
	"codex-mini-latest": "gpt-5.1-codex-mini",
	"gpt-5-codex-mini": "gpt-5.1-codex-mini",
	"gpt-5-codex-mini-medium": "gpt-5.1-codex-mini",
	"gpt-5-codex-mini-high": "gpt-5.1-codex-mini",

	// ============================================================================
	// GPT-5 General Purpose Models (LEGACY - maps to gpt-6-sol)
	//
	// Was gpt-5.5, which OpenAI's Codex model docs retire from Codex with
	// ChatGPT sign-in on 2026-10-14, naming gpt-6-sol as the replacement on
	// paid plans. gpt-6-sol rejects none/minimal; the effort clamp floors both
	// to low.
	// ============================================================================
	"gpt-5": GPT_6_SOL_MODEL_ID,
	"gpt-5-none": GPT_6_SOL_MODEL_ID,
	"gpt-5-minimal": GPT_6_SOL_MODEL_ID,
	"gpt-5-low": GPT_6_SOL_MODEL_ID,
	"gpt-5-medium": GPT_6_SOL_MODEL_ID,
	"gpt-5-high": GPT_6_SOL_MODEL_ID,
	"gpt-5-xhigh": GPT_6_SOL_MODEL_ID,
	// gpt-5.4-mini retired from Codex on 2026-08-31; OpenAI's Codex model docs
	// name gpt-6-luna as its replacement.
	"gpt-5-mini": GPT_6_LUNA_MODEL_ID,
	"gpt-5-nano": "gpt-5.4-nano",
};

/**
 * Get normalized model name from config ID
 *
 * @param modelId - Model ID from config (e.g., "gpt-5.1-codex-low")
 * @returns Normalized model name (e.g., "gpt-5.1-codex") or undefined if not found
 */
export function getNormalizedModel(modelId: string): string | undefined {
	try {
		if (Object.hasOwn(MODEL_MAP, modelId)) {
			return MODEL_MAP[modelId];
		}

		const lowerModelId = modelId.toLowerCase();
		const match = Object.keys(MODEL_MAP).find(
			(key) => key.toLowerCase() === lowerModelId,
		);

		return match ? MODEL_MAP[match] : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Check if a model ID is in the model map
 *
 * @param modelId - Model ID to check
 * @returns True if model is in the map
 */
export function isKnownModel(modelId: string): boolean {
	return getNormalizedModel(modelId) !== undefined;
}

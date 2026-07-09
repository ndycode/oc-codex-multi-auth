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

/**
 * Effort suffixes each GPT-5.6 tier accepts, per the Codex model catalog
 * (openai/codex `codex-rs/models-manager/models.json`).
 *
 * Sol and Terra both expose `max` and `ultra`; Luna stops at `max`. None of the
 * three accept `none` or `minimal`. Press coverage claiming `max`/`ultra` are
 * Sol-exclusive contradicts the catalog — the catalog wins.
 */
const GPT_56_SOL_TERRA_EFFORT_SUFFIXES = [
	"",
	"-low",
	"-medium",
	"-high",
	"-xhigh",
	"-max",
	"-ultra",
] as const;
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

function expandEffortAliases(
	target: string,
	suffixes: readonly string[],
): Record<string, string> {
	return Object.fromEntries(
		suffixes.map((suffix) => [`${target}${suffix}`, target]),
	);
}

export const MODEL_MAP: Record<string, string> = {
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
	// GPT-5 General Purpose Models (LEGACY - maps to gpt-5.5 latest)
	// ============================================================================
	"gpt-5": GPT_55_MODEL_ID,
	"gpt-5-none": GPT_55_MODEL_ID,
	"gpt-5-minimal": GPT_55_MODEL_ID,
	"gpt-5-low": GPT_55_MODEL_ID,
	"gpt-5-medium": GPT_55_MODEL_ID,
	"gpt-5-high": GPT_55_MODEL_ID,
	"gpt-5-xhigh": GPT_55_MODEL_ID,
	"gpt-5-mini": "gpt-5.4-mini",
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

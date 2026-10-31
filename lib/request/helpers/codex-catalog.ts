/**
 * Per-model request metadata mirrored from the upstream Codex model catalog
 * (openai/codex `codex-rs/models-manager/models.json`, rust-v0.166.0).
 *
 * Only the fields that change what goes on the wire are mirrored here:
 *
 * - `serviceTiers` / `defaultServiceTier`: the tiers the model advertises and
 *   the tier Codex sends when the user has not chosen one
 *   (`ModelInfo::service_tier_for_request`, `tui/src/service_tier_resolution.rs`).
 * - `multiAgentReasoningEffort`: what `ultra` resolves to on the wire
 *   (`protocol/src/openai_models/reasoning_effort.rs`). When unset, `ultra`
 *   resolves to `max`.
 * - `defaultVerbosity`: `text.verbosity` when neither the host nor the config
 *   sets one (`core/src/client.rs`, `model_verbosity.or(default_verbosity)`).
 *
 * Keyed by canonical model id (the output of `normalizeModel`). Models absent
 * from the upstream catalog (retired or plugin-only ids) have no entry and
 * keep the plugin's historical defaults.
 */
import {
	DAYBREAK_BLUE_MODEL_ID,
	DAYBREAK_RED_MODEL_ID,
	GPT_55_MODEL_ID,
	GPT_56_LUNA_MODEL_ID,
	GPT_56_SOL_MODEL_ID,
	GPT_56_TERRA_MODEL_ID,
	GPT_6_ASTRA_MODEL_ID,
	GPT_6_LUNA_MODEL_ID,
	GPT_6_SOL_MODEL_ID,
	GPT_61_SOL_MODEL_ID,
	GPT_61_TERRA_MODEL_ID,
} from "./model-map.js";

/** Request value Codex sends for its "Fast" tier. */
export const SERVICE_TIER_PRIORITY = "priority" as const;
/** Request value that is always allowed, even without catalog support. */
export const SERVICE_TIER_FLEX = "flex" as const;

export interface CodexCatalogEntry {
	serviceTiers: readonly string[];
	defaultServiceTier?: string;
	multiAgentReasoningEffort?: "xhigh";
	defaultVerbosity: "low" | "medium" | "high";
}

const FAST: readonly string[] = [SERVICE_TIER_PRIORITY];

export const CODEX_MODEL_CATALOG: Readonly<Record<string, CodexCatalogEntry>> = {
	[GPT_6_ASTRA_MODEL_ID]: { serviceTiers: FAST, multiAgentReasoningEffort: "xhigh", defaultVerbosity: "low" },
	[GPT_61_SOL_MODEL_ID]: { serviceTiers: FAST, multiAgentReasoningEffort: "xhigh", defaultVerbosity: "low" },
	[GPT_61_TERRA_MODEL_ID]: { serviceTiers: FAST, multiAgentReasoningEffort: "xhigh", defaultVerbosity: "low" },
	[GPT_6_SOL_MODEL_ID]: { serviceTiers: FAST, defaultServiceTier: SERVICE_TIER_PRIORITY, defaultVerbosity: "low" },
	[GPT_6_LUNA_MODEL_ID]: { serviceTiers: FAST, defaultServiceTier: SERVICE_TIER_PRIORITY, defaultVerbosity: "low" },
	[GPT_56_SOL_MODEL_ID]: { serviceTiers: FAST, defaultVerbosity: "low" },
	[GPT_56_TERRA_MODEL_ID]: { serviceTiers: FAST, defaultVerbosity: "low" },
	[GPT_56_LUNA_MODEL_ID]: { serviceTiers: FAST, defaultVerbosity: "low" },
	[DAYBREAK_BLUE_MODEL_ID]: { serviceTiers: [], defaultVerbosity: "low" },
	[DAYBREAK_RED_MODEL_ID]: { serviceTiers: [], defaultVerbosity: "high" },
	[GPT_55_MODEL_ID]: { serviceTiers: FAST, defaultVerbosity: "low" },
};

export function getCodexCatalogEntry(model: string | undefined): CodexCatalogEntry | undefined {
	if (!model) return undefined;
	return CODEX_MODEL_CATALOG[model];
}

/**
 * Normalize a user/host service-tier value to the request value.
 * `fast` is Codex's UI name for `priority`. `default`/`standard` mean the user
 * explicitly chose standard processing; they return `"default"` so callers can
 * tell "opted out" apart from "unset".
 */
export function normalizeServiceTier(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "fast") return SERVICE_TIER_PRIORITY;
	if (normalized === "standard") return "default";
	return normalized;
}

/**
 * Resolve the `service_tier` to put on the wire for `model`, mirroring
 * `ModelInfo::service_tier_for_request`:
 *
 * - an explicit `default` (or `auto`, which Codex never sends) omits the field;
 * - `flex` is always allowed;
 * - any other tier must be advertised by the model's catalog entry;
 * - with no explicit choice, the catalog's default tier applies.
 */
export function resolveServiceTierForModel(
	model: string | undefined,
	requested: unknown,
): string | undefined {
	const tier = normalizeServiceTier(requested);
	const entry = getCodexCatalogEntry(model);
	if (tier === undefined) return entry?.defaultServiceTier;
	if (tier === "default" || tier === "auto") return undefined;
	if (tier === SERVICE_TIER_FLEX) return tier;
	return entry?.serviceTiers.includes(tier) ? tier : undefined;
}

/** `x-codex-routing-hint` value Codex sends on every ChatGPT-backend request. */
export function buildRoutingHint(model: string, serviceTier: string | undefined): string {
	return serviceTier ? `model=${model};tier=${serviceTier}` : `model=${model}`;
}

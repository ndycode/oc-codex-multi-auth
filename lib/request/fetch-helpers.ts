/**
 * Helper functions for the custom fetch implementation
 * These functions break down the complex fetch logic into manageable, testable units
 */

import type { Auth, OpencodeClient } from "@opencode-ai/sdk";
import {
	coordinatePersistedRefresh,
	type PersistedRefreshIdentity,
} from "../storage/coordinated-refresh.js";
import { logRequest, logError, logWarn, maskString } from "../logger.js";
import {
	ensureInstructionIdentity,
	getCodexInstructions,
	getModelFamily,
} from "../prompts/codex.js";
import {
	transformRequestBody,
	normalizeModel,
	upsertBackendModelIdentityMessage,
	clampReasoningForModel,
	getModelConfig,
} from "./request-transformer.js";
import {
	SERVICE_TIER_PRIORITY,
	buildRoutingHint,
	getCodexCatalogEntry,
	resolveServiceTierForModel,
} from "./helpers/codex-catalog.js";
import {
	DAYBREAK_BLUE_MODEL_ID,
	DAYBREAK_RED_MODEL_ID,
	GPT_55_MODEL_ID,
	GPT_56_CYBER_MODEL_ID,
	GPT_56_LUNA_MODEL_ID,
	GPT_56_SOL_MODEL_ID,
	GPT_56_TERRA_MODEL_ID,
	GPT_6_ASTRA_MODEL_ID,
	GPT_6_LUNA_MODEL_ID,
	GPT_6_SOL_MODEL_ID,
	GPT_61_SOL_MODEL_ID,
	GPT_62_ASTRA_MODEL_ID,
	GPT_62_SOL_MODEL_ID,
} from "./helpers/model-map.js";
import { stripEffortSuffix } from "./helpers/effort-suffix.js";
import {
	RESPONSES_LITE_HEADER,
	RESPONSES_LITE_HEADER_VALUE,
	shapeBodyForModel,
	usesResponsesLite,
} from "./helpers/responses-lite.js";
import { ensureFunctionToolStrictFalse } from "./helpers/tool-utils.js";
import { resolveClientIdentity } from "./helpers/client-identity.js";
import { convertSseToJson, ensureContentType, readBoundedResponseText } from "./response-handler.js";
import type { OAuthAuthDetails, UserConfig, RequestBody } from "../types.js";
import {
	CodexAuthError,
	StorageTransactionContentionError,
} from "../errors.js";
import {
	DEACTIVATED_WORKSPACE_ERROR_CODE,
	isInvalidatedAuthTokenMessage,
} from "../error-sentinels.js";
import {
	getQuotaExhaustedResetAtMs,
	isQuotaWindowDisabled,
	MAX_QUOTA_RESET_HORIZON_MS,
	parseCodexQuotaWindows,
} from "../quota-windows.js";
import { isRecord } from "../utils.js";
import {
        CODEX_BASE_URL,
        HTTP_STATUS,
        OPENAI_HEADERS,
        OPENAI_HEADER_VALUES,
        URL_PATHS,
        ERROR_MESSAGES,
        LOG_STAGES,
} from "../constants.js";

export interface RateLimitInfo {
        retryAfterMs: number;
        code?: string;
}

export interface EntitlementError {
        isEntitlement: true;
        code: string;
        message: string;
}

/**
 * Build an AbortError for caller-cancellation during retry/backoff waits.
 *
 * The request retry loop (index.ts) awaits sleeps that watch the caller
 * AbortSignal. A bare `new Error("Aborted")` surfaced as an opaque, unnamed
 * error and dropped `signal.reason` (issue #176). This mirrors the fetch-path
 * behavior and the `isAbortError` convention in lib/codex-usage.ts: when the
 * signal carries an Error reason it is propagated as-is; otherwise a fresh
 * Error named "AbortError" is returned (carrying a string reason if present).
 */
export function createAbortError(signal?: AbortSignal | null): Error {
        const reason = signal?.reason;
        if (reason instanceof Error) {
                // Preserve the original message/stack, but ensure the result is
                // recognizable as an abort by isAbortError (lib/codex-usage.ts checks
                // name === "AbortError"). A caller may abort with a generic Error.
                if (reason.name !== "AbortError") {
                        reason.name = "AbortError";
                }
                return reason;
        }
        const err = new Error(
                typeof reason === "string" && reason.length > 0 ? reason : "Aborted",
        );
        err.name = "AbortError";
        return err;
}

const CODEX_BASE_URL_OBJECT = new URL(CODEX_BASE_URL);
const CODEX_BASE_PATH_PREFIX = CODEX_BASE_URL_OBJECT.pathname.endsWith("/")
	? CODEX_BASE_URL_OBJECT.pathname.slice(0, -1)
	: CODEX_BASE_URL_OBJECT.pathname;

const CHATGPT_CODEX_UNSUPPORTED_MODEL_CODE = "model_not_supported_with_chatgpt_account";
const CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN =
	/model is not supported when using codex with a chatgpt account/i;
const NORMALIZED_UNSUPPORTED_MODEL_PATTERN =
	/the model ['"]([^'"]+)['"] is not currently available for this chatgpt account/i;
export const DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN: Record<string, string[]> = {
	// GPT-6.2 rows follow the same general ladder and end at the terminal Luna
	// tier. Astra has eight fallback targets, so MAX_QUOTA_FALLBACK_SWITCHES
	// must allow eight hops for a fully blocked request to reach the terminal.
	[GPT_62_ASTRA_MODEL_ID]: [
		GPT_62_SOL_MODEL_ID,
		GPT_61_SOL_MODEL_ID,
		GPT_6_SOL_MODEL_ID,
		GPT_56_SOL_MODEL_ID,
		GPT_56_TERRA_MODEL_ID,
		GPT_55_MODEL_ID,
		GPT_6_LUNA_MODEL_ID,
		GPT_56_LUNA_MODEL_ID,
	],
	[GPT_62_SOL_MODEL_ID]: [
		GPT_61_SOL_MODEL_ID,
		GPT_6_SOL_MODEL_ID,
		GPT_56_SOL_MODEL_ID,
		GPT_56_TERRA_MODEL_ID,
		GPT_55_MODEL_ID,
		GPT_6_LUNA_MODEL_ID,
		GPT_56_LUNA_MODEL_ID,
	],
	// The general rows follow one order, most capable first:
	//
	//   gpt-6-astra > gpt-6.1-sol > gpt-6-sol > gpt-5.6-sol > gpt-5.6-terra
	//     > gpt-5.5 > gpt-6-luna > gpt-5.6-luna
	//
	// and each row is that order's tail after its own model. The resolver walks
	// the chain of whichever model it is CURRENTLY on, so a row that is not a
	// suffix of the others dead-ends the walk early. Every walk ends on the
	// terminal, `gpt-5.6-luna`, whose row lists everything else (minus Astra),
	// so every entry point reaches every live general model.
	//
	// The terminal is `gpt-5.6-luna`, not `gpt-5.5`: OpenAI's Codex model docs
	// say GPT-5.5 retires from Codex with ChatGPT sign-in on 2026-10-14. 5.6
	// Luna is listed for every plan and has no retirement date. `gpt-5.2`, the
	// terminal before that, left the catalog in openai/codex #44250.
	//
	// A GPT-6 tier crosses to the matching 5.6 tier before its GPT-6 sibling:
	// Sol and Luna joined the catalog on 2026-09-22 (openai/codex 49e95cc7), so
	// an entitlement 400 on one GPT-6 tier most likely means the account is not
	// in the GPT-6 rollout yet, and the sibling would fail the same way.
	//
	// Astra is never a target: it is the frontier tier, so nothing degrades
	// into it. The Daybreak tiers are absent entirely. They are cyber-specialty
	// models (`model_specialty: "cyber"`); silently degrading a Daybreak request
	// onto a general model would answer a security-research prompt with a model
	// that was never asked for. They fail loudly instead.
	[GPT_6_ASTRA_MODEL_ID]: [
		GPT_61_SOL_MODEL_ID,
		GPT_6_SOL_MODEL_ID,
		GPT_56_SOL_MODEL_ID,
		GPT_56_TERRA_MODEL_ID,
		GPT_55_MODEL_ID,
		GPT_6_LUNA_MODEL_ID,
		GPT_56_LUNA_MODEL_ID,
	],
	// GPT-6.1 Sol sits directly under Astra: OpenAI markets it as "near-Astra
	// performance", and it became the default catalog model on 2026-09-29
	// (openai/codex b1e72963). Its row is the general order's tail after it.
	[GPT_61_SOL_MODEL_ID]: [
		GPT_6_SOL_MODEL_ID,
		GPT_56_SOL_MODEL_ID,
		GPT_56_TERRA_MODEL_ID,
		GPT_55_MODEL_ID,
		GPT_6_LUNA_MODEL_ID,
		GPT_56_LUNA_MODEL_ID,
	],
	[GPT_6_SOL_MODEL_ID]: [
		GPT_56_SOL_MODEL_ID,
		GPT_56_TERRA_MODEL_ID,
		GPT_55_MODEL_ID,
		GPT_6_LUNA_MODEL_ID,
		GPT_56_LUNA_MODEL_ID,
	],
	[GPT_56_SOL_MODEL_ID]: [
		GPT_56_TERRA_MODEL_ID,
		GPT_55_MODEL_ID,
		GPT_6_LUNA_MODEL_ID,
		GPT_56_LUNA_MODEL_ID,
	],
	[GPT_56_TERRA_MODEL_ID]: [GPT_55_MODEL_ID, GPT_6_LUNA_MODEL_ID, GPT_56_LUNA_MODEL_ID],
	// The catalog names `gpt-6-sol` as gpt-5.5's `upgrade`, so its row leads
	// with it rather than being a plain suffix. `gpt-6.1-sol` follows as the
	// remaining live general above 5.5 in the order, keeping the invariant
	// that every entry point reaches every live general model.
	[GPT_55_MODEL_ID]: [
		GPT_6_SOL_MODEL_ID,
		GPT_61_SOL_MODEL_ID,
		GPT_56_SOL_MODEL_ID,
		GPT_56_TERRA_MODEL_ID,
		GPT_6_LUNA_MODEL_ID,
		GPT_56_LUNA_MODEL_ID,
	],
	// The two Luna tiers end the order, so both rows go up after trying each
	// other: a walk hops between them, and whichever row it is on then has to
	// list the rest, or the walk dead-ends. gpt-5.6-luna leads with gpt-6-luna,
	// its catalog `upgrade`. The warm ping starts at gpt-6-luna and reaches 7
	// models, exactly WARM_ATTEMPT_HARD_CEILING (lib/accounts/warm-request.ts).
	[GPT_6_LUNA_MODEL_ID]: [
		GPT_56_LUNA_MODEL_ID,
		GPT_61_SOL_MODEL_ID,
		GPT_6_SOL_MODEL_ID,
		GPT_56_SOL_MODEL_ID,
		GPT_56_TERRA_MODEL_ID,
		GPT_55_MODEL_ID,
	],
	[GPT_56_LUNA_MODEL_ID]: [
		GPT_6_LUNA_MODEL_ID,
		GPT_61_SOL_MODEL_ID,
		GPT_6_SOL_MODEL_ID,
		GPT_56_SOL_MODEL_ID,
		GPT_56_TERRA_MODEL_ID,
		GPT_55_MODEL_ID,
	],

	// Retired ids lead with the successor OpenAI names for them: gpt-5.4 ->
	// gpt-6-sol, gpt-5.4-mini -> gpt-6-luna (Codex models docs; both retired
	// from Codex on 2026-08-31). `gpt-5.4-mini` has since left the catalog
	// entirely (#44250), but Codex keeps migrating saved selections of it to
	// Luna, so this row keeps doing the same. Each row ends on the terminal.
	"gpt-5.4": [GPT_6_SOL_MODEL_ID, GPT_56_TERRA_MODEL_ID, GPT_56_LUNA_MODEL_ID],
	"gpt-5.4-mini": [GPT_6_LUNA_MODEL_ID, GPT_56_LUNA_MODEL_ID],
	// `gpt-5.4-nano` never had a catalog entry, so no upgrade directive to
	// follow; it takes the budget line like its mini sibling.
	"gpt-5.4-nano": [GPT_6_LUNA_MODEL_ID, GPT_56_LUNA_MODEL_ID],
	// GPT-5.4 Pro has no catalog entry either; it inherits the 5.4 line's
	// successor rather than degrading onto retired gpt-5.4 first.
	"gpt-5.4-pro": [GPT_6_SOL_MODEL_ID, GPT_56_TERRA_MODEL_ID, GPT_56_LUNA_MODEL_ID],
	// gpt-5-codex was shut down on 2026-07-23 (API deprecations page); a
	// hand-typed selection still gets a way out.
	"gpt-5-codex": [GPT_56_TERRA_MODEL_ID, GPT_56_LUNA_MODEL_ID],
	// gpt-5.1-codex-max and gpt-5.1-codex-mini went down in the same 2026-07-23
	// API shutdown and are still routed when typed by hand. The docs name
	// gpt-5.6-sol as the max successor and gpt-5.6-terra as the mini successor
	// (docs/configuration.md); both rows end on the terminal so a blocked
	// successor still walks out like every other retired-model row.
	"gpt-5.1-codex-max": [
		GPT_56_SOL_MODEL_ID,
		GPT_56_TERRA_MODEL_ID,
		GPT_56_LUNA_MODEL_ID,
	],
	"gpt-5.1-codex-mini": [GPT_56_TERRA_MODEL_ID, GPT_56_LUNA_MODEL_ID],
	// Legacy selectors normalize to `gpt-5-codex` before lookup during the
	// request path. Keep these historical entries for direct helper callers and
	// custom-chain documentation; the canonical `gpt-5-codex` edge above is the
	// runtime path for default OpenCode selectors.
	"gpt-5.3-codex-spark": ["gpt-5-codex", "gpt-5.3-codex", "gpt-5.2-codex"],
	"gpt-5.3-codex": ["gpt-5-codex", "gpt-5.2-codex"],
	"gpt-5.2-codex": ["gpt-5-codex"],
	"gpt-5.1-codex": ["gpt-5-codex"],
};

const DEFAULT_AUTO_FALLBACK_ENTRY_OPT_OUT_ENV: Record<string, string> = {
	[GPT_55_MODEL_ID]: "CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK",
	"gpt-5-codex": "CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK",
	// GPT-5.6 shipped as a limited preview, so entitlement 400s on these
	// default selectors are expected for most accounts. Auto-degrading down the
	// tier chain (sol -> terra -> luna -> gpt-5.5) keeps the documented preview
	// behavior without requiring `unsupportedCodexPolicy: "fallback"` (#196).
	[GPT_56_SOL_MODEL_ID]: "CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK",
	[GPT_56_TERRA_MODEL_ID]: "CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK",
	[GPT_56_LUNA_MODEL_ID]: "CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK",
	// Every GPT-6 tier is mid-rollout, so the same reasoning applies one
	// generation up. One switch covers the generation, like the 5.6 one.
	[GPT_6_ASTRA_MODEL_ID]: "CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK",
	[GPT_6_SOL_MODEL_ID]: "CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK",
	[GPT_6_LUNA_MODEL_ID]: "CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK",
	[GPT_61_SOL_MODEL_ID]: "CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK",
	[GPT_62_ASTRA_MODEL_ID]: "CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK",
	[GPT_62_SOL_MODEL_ID]: "CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK",
};

/**
 * Models the default auto-fallback may keep degrading *from* after it has
 * already hopped off an entry model.
 *
 * Entry models (those in DEFAULT_AUTO_FALLBACK_ENTRY_OPT_OUT_ENV) resolve
 * themselves, so only non-entry intermediates need listing, and only those that
 * own a row in DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN: membership here gates
 * *whether* auto-fallback is allowed to continue, but the resolver still reads
 * `chain[currentModel]`, so a member with no row of its own returns undefined
 * either way.
 */
const DEFAULT_AUTO_FALLBACK_CONTINUATION_MODELS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
]);

function resolveAutoFallbackEntryModel(
	currentModel: string,
	attempted: Set<string>,
): string | undefined {
	if (DEFAULT_AUTO_FALLBACK_ENTRY_OPT_OUT_ENV[currentModel] !== undefined) {
		return currentModel;
	}
	if (!DEFAULT_AUTO_FALLBACK_CONTINUATION_MODELS.has(currentModel)) {
		return undefined;
	}
	for (const model of attempted) {
		if (DEFAULT_AUTO_FALLBACK_ENTRY_OPT_OUT_ENV[model] !== undefined) {
			return model;
		}
	}
	return undefined;
}

export interface UnsupportedCodexModelInfo {
	isUnsupported: boolean;
	code?: string;
	message?: string;
	unsupportedModel?: string;
}

export interface ResolveUnsupportedCodexFallbackOptions {
	requestedModel: string | undefined;
	errorBody: unknown;
	attemptedModels?: Iterable<string>;
	fallbackOnUnsupportedCodexModel: boolean;
	fallbackToGpt52OnUnsupportedGpt53: boolean;
	customChain?: Record<string, string[]>;
}

function canonicalizeModelName(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const trimmed = model.trim().toLowerCase();
	if (!trimmed) return undefined;
	const stripped = trimmed.includes("/")
		? (trimmed.split("/").pop() ?? trimmed)
		: trimmed;
	const withoutEffort = stripEffortSuffix(stripped);

	// Keep legacy alias distinctions (for example gpt-5.3-codex-spark vs gpt-5.3-codex)
	// while collapsing rejected dated GPT-5.5 release aliases onto the public Codex ids.
	// `gpt-5.5-pro*` also collapses here: GPT-5.5 Pro is ChatGPT-only per the
	// 2026-04-23 launch, so anything still typed as Pro is treated as a 5.5 request
	// so the gpt-5.5 -> gpt-5.4 fallback chain can rescue it.
	if (
		withoutEffort === "gpt-5.5" ||
		withoutEffort === "gpt-5.5-20260423" ||
		withoutEffort === "gpt-5.5-fast" ||
		withoutEffort === "gpt-5.5-pro" ||
		withoutEffort === "gpt-5.5-pro-20260423"
	) {
		return GPT_55_MODEL_ID;
	}

	// Bare `gpt-5.6` is the Sol flagship alias (see MODEL_MAP). The request path
	// normalizes it before dispatch, but direct helper callers and custom chains
	// keyed as `gpt-5.6` need the same collapse for chain lookups to work.
	if (withoutEffort === "gpt-5.6") {
		return GPT_56_SOL_MODEL_ID;
	}

	// Same collapse for the GPT-6 aliases: bare `gpt-6`, and `gpt-6-astra-pro`,
	// which is not a Codex-routable id and rides the base tier's chain.
	if (
		withoutEffort === "gpt-6" ||
		withoutEffort === "gpt-6-astra-pro"
	) {
		return GPT_6_ASTRA_MODEL_ID;
	}

	// Bare `gpt-6.1` collapses onto Sol (Terra has its own id), so a custom
	// chain or attempted list keyed that way resolves to the same node.
	if (withoutEffort === "gpt-6.1") {
		return GPT_61_SOL_MODEL_ID;
	}

	// Bare `gpt-6.2` is the plugin's Sol convenience alias. The official API
	// ids are the explicit `-astra` and `-sol` forms.
	if (withoutEffort === "gpt-6.2") {
		return GPT_62_SOL_MODEL_ID;
	}

	// Daybreak short forms collapse onto the catalog's `-latest` slugs so a
	// custom chain keyed either way resolves to the same node.
	if (withoutEffort === "gpt-daybreak-blue") {
		return DAYBREAK_BLUE_MODEL_ID;
	}
	if (withoutEffort === "gpt-daybreak-red") {
		return DAYBREAK_RED_MODEL_ID;
	}

	// `gpt-5.6-cyber` must not fall into the bare `gpt-5.6` -> Sol collapse
	// above; it is its own Daybreak-gated id with no chain of its own.
	if (withoutEffort === GPT_56_CYBER_MODEL_ID) {
		return GPT_56_CYBER_MODEL_ID;
	}

	return withoutEffort;
}

function normalizeFallbackChain(
	customChain: Record<string, string[]> | undefined,
): Record<string, string[]> {
	// Null-prototype: both the keys written here and the keys read out of it are
	// caller-controlled. A `customChain` entry named `__proto__` reassigns a
	// plain object's prototype instead of adding a row, and a lookup for
	// `constructor` returns an inherited member rather than `undefined`.
	const normalized: Record<string, string[]> = Object.create(null);
	for (const [key, values] of Object.entries(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN)) {
		const normalizedKey = canonicalizeModelName(key);
		if (!normalizedKey) continue;
		normalized[normalizedKey] = values
			.map((value) => canonicalizeModelName(value))
			.filter((value): value is string => !!value);
	}

	if (!customChain) {
		return normalized;
	}

	for (const [key, values] of Object.entries(customChain)) {
		const normalizedKey = canonicalizeModelName(key);
		if (!normalizedKey || !Array.isArray(values)) continue;
		const normalizedValues = values
			.map((value) => canonicalizeModelName(value))
			.filter((value): value is string => !!value);
		if (normalizedValues.length > 0) {
			normalized[normalizedKey] = normalizedValues;
		}
	}

	return normalized;
}

export function extractUnsupportedCodexModelFromText(bodyText: string): string | undefined {
	const directMatch = bodyText.match(
		/['"]([^'"]+)['"]\s+model is not supported when using codex with a chatgpt account/i,
	);
	if (directMatch?.[1]) {
		return canonicalizeModelName(directMatch[1]);
	}
	const normalizedMatch = bodyText.match(NORMALIZED_UNSUPPORTED_MODEL_PATTERN);
	if (normalizedMatch?.[1]) {
		return canonicalizeModelName(normalizedMatch[1]);
	}
	return undefined;
}

/**
 * Both unsupported-model wordings the verdict can legitimately fire on: the
 * raw upstream ChatGPT phrasing AND the phrasing this plugin itself emits in
 * normalizeErrorPayload. A peer plugin/proxy, or a re-normalized payload
 * flowing back through handleErrorResponse, only carries the normalized
 * wording â€” gating the verdict on the upstream phrasing alone let those
 * errors sail past the fallback resolver.
 */
function isUnsupportedCodexModelMessage(text: string): boolean {
	return (
		CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN.test(text) ||
		NORMALIZED_UNSUPPORTED_MODEL_PATTERN.test(text)
	);
}

function isUnsupportedCodexModelForChatGpt(status: number, bodyText: string): boolean {
	if (status !== HTTP_STATUS.BAD_REQUEST) return false;
	if (!bodyText) return false;
	return isUnsupportedCodexModelMessage(bodyText);
}

export function getUnsupportedCodexModelInfo(
	errorBody: unknown,
): UnsupportedCodexModelInfo {
	if (!isRecord(errorBody)) {
		return { isUnsupported: false };
	}

	const directDetail =
		typeof errorBody.detail === "string" ? errorBody.detail : undefined;
	const maybeError = errorBody.error;
	if (!isRecord(maybeError)) {
		const unsupportedModel = directDetail
			? extractUnsupportedCodexModelFromText(directDetail)
			: undefined;
		return {
			isUnsupported: directDetail
				? isUnsupportedCodexModelMessage(directDetail)
				: false,
			message: directDetail,
			unsupportedModel: unsupportedModel ?? undefined,
		};
	}

	const code = typeof maybeError.code === "string" ? maybeError.code : undefined;
	const message =
		typeof maybeError.message === "string" ? maybeError.message : undefined;
	const unsupportedModelFromPayload =
		typeof maybeError.unsupported_model === "string"
			? maybeError.unsupported_model
			: undefined;
	const unsupportedModel = unsupportedModelFromPayload
		? canonicalizeModelName(unsupportedModelFromPayload)
		: extractUnsupportedCodexModelFromText(message ?? "");
	const isUnsupported =
		code === CHATGPT_CODEX_UNSUPPORTED_MODEL_CODE ||
		(message ? isUnsupportedCodexModelMessage(message) : false);

	return {
		isUnsupported,
		code,
		message,
		unsupportedModel: unsupportedModel ?? undefined,
	};
}

/**
 * Whether the default auto-fallback (the one that does NOT require
 * `unsupportedCodexPolicy: "fallback"`) currently applies to `currentModel`.
 *
 * Exported so a caller degrading for a reason OTHER than an entitlement 400 â€”
 * notably a fully quota-blocked pool â€” gates on exactly the same entry models
 * and opt-out env vars instead of inventing a second policy.
 */
export function isDefaultAutoFallbackModel(
	currentModel: string,
	attemptedModels?: Iterable<string>,
): boolean {
	const attempted = new Set<string>();
	for (const model of attemptedModels ?? []) {
		const normalized = canonicalizeModelName(model);
		if (normalized) attempted.add(normalized);
	}
	const entryModel = resolveAutoFallbackEntryModel(
		canonicalizeModelName(currentModel) ?? currentModel,
		attempted,
	);
	const optOutEnv = entryModel
		? DEFAULT_AUTO_FALLBACK_ENTRY_OPT_OUT_ENV[entryModel]
		: undefined;
	return !!optOutEnv && process.env[optOutEnv] !== "1";
}

export interface PickFallbackChainTargetOptions {
	currentModel: string;
	attemptedModels?: Iterable<string>;
	customChain?: Record<string, string[]>;
	fallbackToGpt52OnUnsupportedGpt53?: boolean;
}

/**
 * Walk the fallback chain and return the next model worth trying.
 *
 * This is the single chain-walking policy: both the entitlement fallback and
 * the quota/rate-limit fallback go through it, so the two can never drift.
 * It decides only what comes NEXT in the chain â€” whether degrading is allowed
 * at all is the caller's gate.
 */
export function pickFallbackChainTarget(
	options: PickFallbackChainTargetOptions,
): string | undefined {
	const currentModel = canonicalizeModelName(options.currentModel);
	if (!currentModel) return undefined;

	const attempted = new Set<string>();
	for (const model of options.attemptedModels ?? []) {
		const normalized = canonicalizeModelName(model);
		if (normalized) attempted.add(normalized);
	}

	const chain = normalizeFallbackChain(options.customChain);
	const targets = chain[currentModel] ?? [];
	// `Array.isArray`, not just a length check. `currentModel` comes from the
	// caller's `body.model`, so it can be any `Object.prototype` member name. On
	// a plain object `chain["constructor"]` returns the Object constructor: a
	// truthy non-array whose `.length` is 1, so an emptiness check passes it
	// through and the `for...of` below throws `targets is not iterable` inside
	// the request path. The chain is null-prototype now as well; this guard also
	// covers a `customChain` value that is not an array.
	if (!Array.isArray(targets) || targets.length === 0) return undefined;

	for (const target of targets) {
		if (!options.fallbackToGpt52OnUnsupportedGpt53 &&
			currentModel === "gpt-5.3-codex" &&
			target === "gpt-5.2-codex") {
			continue;
		}
		if (target === currentModel) continue;
		if (attempted.has(target)) continue;
		return target;
	}

	return undefined;
}

export function resolveUnsupportedCodexFallbackModel(
	options: ResolveUnsupportedCodexFallbackOptions,
): string | undefined {
	const unsupported = getUnsupportedCodexModelInfo(options.errorBody);
	if (!unsupported.isUnsupported) return undefined;

	const requestedModel = canonicalizeModelName(options.requestedModel);
	const currentModel = requestedModel ?? unsupported.unsupportedModel;
	if (!currentModel) return undefined;

	const attempted = new Set<string>();
	for (const model of options.attemptedModels ?? []) {
		const normalized = canonicalizeModelName(model);
		if (normalized) attempted.add(normalized);
	}

	// The backend gates some public selector ids per account/workspace. When the
	// selected id is a default UI selector, auto-fallback prevents exhausting every
	// pooled account with the same unsupported-model response. Continuation models
	// such as `gpt-5.4` only auto-fallback when the attempted set proves the chain
	// started from a default entry point; direct user selection remains strict.
	const autoFallbackEntryModel = resolveAutoFallbackEntryModel(
		currentModel,
		attempted,
	);
	const autoFallbackOptOutEnv = autoFallbackEntryModel
		? DEFAULT_AUTO_FALLBACK_ENTRY_OPT_OUT_ENV[autoFallbackEntryModel]
		: undefined;
	const shouldAutoFallbackForDefaultSelector =
		!!autoFallbackOptOutEnv && process.env[autoFallbackOptOutEnv] !== "1";

	if (
		!options.fallbackOnUnsupportedCodexModel &&
		!shouldAutoFallbackForDefaultSelector
	) {
		return undefined;
	}

	return pickFallbackChainTarget({
		currentModel,
		attemptedModels: attempted,
		customChain: options.customChain,
		fallbackToGpt52OnUnsupportedGpt53: options.fallbackToGpt52OnUnsupportedGpt53,
	});
}

/**
 * Returns true when the legacy `gpt-5.3-codex -> gpt-5.2-codex` edge is available.
 */
export function shouldFallbackToGpt52OnUnsupportedGpt53(
	requestedModel: string | undefined,
	errorBody: unknown,
): boolean {
	if (canonicalizeModelName(requestedModel) !== "gpt-5.3-codex") {
		return false;
	}

	return (
		resolveUnsupportedCodexFallbackModel({
			requestedModel,
			errorBody,
			// Skip the canonical `gpt-5-codex` step and probe whether the legacy
			// gpt-5.2 edge is still active under current policy/toggles.
			attemptedModels: ["gpt-5-codex"],
			fallbackOnUnsupportedCodexModel: true,
			fallbackToGpt52OnUnsupportedGpt53: true,
		}) === "gpt-5.2-codex"
	);
}

/**
 * Checks if an error code indicates an entitlement/subscription issue
 * These errors should NOT be treated as rate limits because:
 * 1. They won't resolve by waiting
 * 2. They won't resolve by switching accounts (all accounts likely have same issue)
 * 3. User needs to upgrade their subscription
 */
export function isEntitlementError(code: string, bodyText: string): boolean {
        const haystack = `${code} ${bodyText}`.toLowerCase();
        // "usage_not_included" means the subscription doesn't include this feature
        // This is different from "usage_limit_reached" which is a temporary quota limit
        return /usage_not_included|not.included.in.your.plan|subscription.does.not.include/i.test(haystack);
}

/**
 * Creates a user-friendly entitlement error response
 */
export function createEntitlementErrorResponse(_bodyText: string): Response {
        const message = 
                "This model is not included in your ChatGPT subscription. " +
                "Please check that your account or workspace has access to Codex models (Plus/Pro/Business/Enterprise). " +
                "If you recently subscribed or switched workspaces, try logging out and back in with `opencode auth login`.";
        
        const payload = {
                error: {
                        message,
                        type: "entitlement_error",
                        code: "usage_not_included",
                },
        };

        return new Response(JSON.stringify(payload), {
                status: 403, // Forbidden - not a rate limit
                statusText: "Forbidden",
                headers: { "content-type": "application/json; charset=utf-8" },
        });
}

export interface ErrorHandlingResult {
        response: Response;
        rateLimit?: RateLimitInfo;
        errorBody?: unknown;
        retryAsServerError?: boolean;
        /**
         * Whether this response's `x-codex-*` quota headers describe the account's
         * real quota state. See {@link isQuotaHeaderAuthority}.
         */
        quotaHeadersAuthoritative?: boolean;
}

export interface ErrorHandlingOptions {
	requestCorrelationId?: string;
	threadId?: string;
}

export interface ErrorDiagnostics {
	requestId?: string;
	cfRay?: string;
	correlationId?: string;
	threadId?: string;
	httpStatus?: number;
}

function getStructuredErrorCode(errorBody: unknown): string | undefined {
	if (!isRecord(errorBody)) return undefined;

	const directCode = errorBody.code;
	if (typeof directCode === "string" && directCode.trim()) return directCode.trim();

	const detail = errorBody.detail;
	if (isRecord(detail)) {
		const detailCode = detail.code;
		if (typeof detailCode === "string" && detailCode.trim()) return detailCode.trim();
	}

	const nestedError = errorBody.error;
	if (isRecord(nestedError)) {
		const nestedCode = nestedError.code ?? nestedError.type;
		if (typeof nestedCode === "string" && nestedCode.trim()) return nestedCode.trim();
	}

	return undefined;
}

function getStructuredErrorMessage(errorBody: unknown): string | undefined {
	if (typeof errorBody === "string") return errorBody.trim() || undefined;
	if (!isRecord(errorBody)) return undefined;

	const nestedError = errorBody.error;
	if (isRecord(nestedError) && typeof nestedError.message === "string" && nestedError.message.trim()) {
		return nestedError.message;
	}

	const directMessage = errorBody.message;
	if (typeof directMessage === "string" && directMessage.trim()) return directMessage;

	const detail = errorBody.detail;
	if (typeof detail === "string" && detail.trim()) return detail;
	if (isRecord(detail) && typeof detail.message === "string" && detail.message.trim()) {
		return detail.message;
	}

	return undefined;
}

/**
 * Auth error codes the Codex/OpenAI backend uses for a specifically invalidated
 * or revoked OAuth token. Kept deliberately narrow: generic codes like
 * `unauthorized` (permission-denied) or `invalid_api_key` (wrong key) are
 * excluded so the status-less code/message fallback cannot cool down a healthy
 * account on a non-token error. HTTP 401 remains the primary signal; these are
 * only a fallback for paths that carry a structured code but no status. Distinct
 * from rate limits (429) and entitlement gates (403/`model_not_supported_*`),
 * which have their own rotation/fallback paths.
 */
const INVALIDATED_AUTH_TOKEN_CODE_PATTERN =
	/^(?:invalid_token|invalid_grant|token_expired|token_revoked)$/i;

/**
 * Detects the "authentication token invalidated" failure on the *request* path
 * (as opposed to the token-refresh path in {@link refreshAndUpdateToken}).
 *
 * The backend returns HTTP 401 with a body like
 * "Your authentication token has been invalidated. Please try signing in
 * again." When the access token presented for a request is rejected, the owning
 * account must be cooled down and the request rotated to the next healthy
 * account â€” otherwise persisted family routing keeps pinning every request to
 * the dead account slot (issue #171).
 *
 * Driven primarily by the HTTP 401 status; the structured code and message are
 * fallbacks for paths (probe/exception) that only carry an error string.
 */
export function isInvalidatedAuthTokenError(errorBody: unknown, status?: number): boolean {
	if (status === HTTP_STATUS.UNAUTHORIZED) return true;
	const code = getStructuredErrorCode(errorBody);
	if (code && INVALIDATED_AUTH_TOKEN_CODE_PATTERN.test(code)) return true;
	return isInvalidatedAuthTokenMessage(getStructuredErrorMessage(errorBody));
}

function isServerOverloadedError(errorBody: unknown): boolean {
	if (!isRecord(errorBody)) return false;

	const maybeError = errorBody.error;
	if (!isRecord(maybeError)) return false;
	const code = typeof maybeError.code === "string" ? maybeError.code : undefined;
	const type = typeof maybeError.type === "string" ? maybeError.type : undefined;
	const maybeMessage = typeof maybeError.message === "string"
		? maybeError.message.toLowerCase()
		: "";

	if (code === "server_is_overloaded") {
		return true;
	}

	if (type === "service_unavailable_error") {
		return true;
	}

	if (code === "server_error" && type === "server_error") {
		return true;
	}

	const maybeContext = maybeError.context;
	return (
		isRecord(maybeContext) &&
		typeof maybeContext.type === "string" &&
		maybeContext.type === "service_unavailable_error" &&
		/overloaded|try again later/.test(maybeMessage)
	);
}

export function isDeactivatedWorkspaceError(errorBody: unknown, status?: number): boolean {
	if (status !== undefined && status !== 402) return false;
	const code = getStructuredErrorCode(errorBody);
	return code === DEACTIVATED_WORKSPACE_ERROR_CODE;
}

/**
 * Determines if the current auth token needs to be refreshed
 * @param auth - Current authentication state
 * @param skewMs - Refresh this many ms before actual expiry (clamped to >= 0)
 * @returns True if token is expired, invalid, or expires within `skewMs`
 */
export function shouldRefreshToken(auth: Auth, skewMs = 0): boolean {
	if (auth.type !== "oauth") return true;
	if (!auth.access) return true;

	// Non-finite input is corrupt state, not a policy decision. NaN skew made
	// `expires <= now + NaN` permanently false (an expired token was used
	// forever); Infinity skew made it permanently true (a refresh on every
	// request). A non-finite expiry means the stored credential is unreadable
	// â€” refreshing is the repair path.
	if (!Number.isFinite(auth.expires)) return true;
	const safeSkewMs = Number.isFinite(skewMs)
		? Math.max(0, Math.floor(skewMs))
		: 0;
	return auth.expires <= Date.now() + safeSkewMs;
}

/**
 * Refreshes the OAuth token and updates stored credentials
 * @param currentAuth - Current auth state
 * @param client - Opencode client for updating stored credentials
 * @returns Updated auth (throws on failure)
 */
export async function refreshAndUpdateToken(
	currentAuth: OAuthAuthDetails,
	client: OpencodeClient | undefined,
	identity: Omit<PersistedRefreshIdentity, "refreshToken"> = {},
): Promise<OAuthAuthDetails> {
	const refreshToken = currentAuth.refresh;
	let refreshResult: Awaited<ReturnType<typeof coordinatePersistedRefresh>>;
	try {
		refreshResult = await coordinatePersistedRefresh({ ...identity, refreshToken });
	} catch (error) {
		if (error instanceof StorageTransactionContentionError) {
			throw new CodexAuthError(error.message, {
				cause: error,
				retryable: true,
				refreshFailureReason: "storage_contention",
			});
		}
		throw error;
	}

	if (refreshResult.type === "failed") {
		// Distinguish transient failures (network blip / upstream 5xx) from
		// genuine auth invalidation. Transient failures must NOT count toward
		// permanent account removal â€” the credentials are still valid.
		const reason = refreshResult.reason;
		const statusCode =
			typeof refreshResult.statusCode === "number"
				? refreshResult.statusCode
				: undefined;
		const isTransient =
			reason === "network_error" ||
			reason === "invalid_response" ||
			(reason === "http_error" &&
				statusCode !== undefined &&
				statusCode >= 500);
		throw new CodexAuthError(ERROR_MESSAGES.TOKEN_REFRESH_FAILED, {
			retryable: isTransient,
			refreshFailureReason: reason,
			statusCode,
		});
	}

	const currentScope = currentAuth.scope;
	const nextScope = refreshResult.scope ?? currentScope;

	await client?.auth.set({
		path: { id: "openai" },
		body: {
			type: "oauth",
			access: refreshResult.access,
			refresh: refreshResult.refresh,
			expires: refreshResult.expires,
			scope: nextScope,
			multiAccount: true,
		} as Parameters<OpencodeClient["auth"]["set"]>[0]["body"],
	});

	currentAuth.access = refreshResult.access;
	currentAuth.refresh = refreshResult.refresh;
	currentAuth.expires = refreshResult.expires;
	currentAuth.scope = nextScope;

	return currentAuth;
}

/**
 * Extracts URL string from various request input types
 * @param input - Request input (string, URL, or Request object)
 * @returns URL string
 */
export function extractRequestUrl(input: Request | string | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

/**
 * Rewrites OpenAI API URLs to Codex backend URLs
 * @param url - Original URL
 * @returns Rewritten URL for Codex backend
 */
export function rewriteUrlForCodex(url: string): string {
	const parsedUrl = new URL(url);
	// A path that is already Codex-shaped must not be rewritten again:
	// `/responses` is a substring of `/codex/responses`, so the naive replace
	// produced `/backend-api/codex/codex/responses` for already-prefixed input
	// (e.g. a caller passing a Codex URL straight through, or a double pass of
	// this helper).
	const rewrittenPath = parsedUrl.pathname.includes(URL_PATHS.CODEX_RESPONSES)
		? parsedUrl.pathname
		: parsedUrl.pathname.includes(URL_PATHS.RESPONSES)
			? parsedUrl.pathname.replace(
					URL_PATHS.RESPONSES,
					URL_PATHS.CODEX_RESPONSES,
				)
			: parsedUrl.pathname;
	const normalizedPath =
		rewrittenPath === CODEX_BASE_PATH_PREFIX ||
		rewrittenPath.startsWith(`${CODEX_BASE_PATH_PREFIX}/`)
			? rewrittenPath
			: `${CODEX_BASE_PATH_PREFIX}${rewrittenPath.startsWith("/") ? rewrittenPath : `/${rewrittenPath}`}`;

	parsedUrl.protocol = CODEX_BASE_URL_OBJECT.protocol;
	parsedUrl.username = "";
	parsedUrl.password = "";
	parsedUrl.host = CODEX_BASE_URL_OBJECT.host;
	parsedUrl.pathname = normalizedPath;

	return parsedUrl.toString();
}

/**
 * Transforms request body and logs the transformation
 * Fetches model-specific Codex instructions based on the request model
 *
 * @param init - Request init options
 * @param url - Request URL
 * @param userConfig - User configuration
 * @param codexMode - Enable CODEX_MODE (bridge prompt instead of tool remap)
 * @param parsedBody - Pre-parsed body to avoid double JSON.parse (optional)
 * @param options - Transform overrides: `requestTransformMode` (`native` | `legacy`),
 *   `fastSession`, `fastSessionStrategy`, and `fastSessionMaxInputItems`
 * @returns Transformed body and updated init, or undefined if no body
 */
/**
 * The service tier the user or host asked for, before per-model filtering.
 * Precedence: the body's `service_tier` (the host's `serviceTier` provider
 * option), then `providerOptions.openai.serviceTier`×^÷¶‰Ëkºwµç[Ù[
ÜšYÚ[˜[[Ù[
NÂ‚BBX›ÙK›[Ù[H›Ü›X[^™Y[Ù[Â‚BBX›ÙKš[œİXİ[ÛœÈH[œİ\™R[œİXİ[Û’Y[]J‚BBBX›ÙKš[œİXİ[ÛœË‚BBB[›Ü›X[^™Y[Ù[‚BBJNÂ‚BBX›ÙKš[œ]H\Ù\˜XÚÙ[™[Ù[Y[]SY\ÜØYÙJ›ÙKš[œ]›Ü›X[^™Y[Ù[
NÂ‚BBKËÈ˜]]™H[ÙHÙY\ÈHÜİ	ÜÈY™›Ü]İ[\Y\ÈB‚BBKËÈ˜[Z[HÛ[\ÈYØXŞH[ÙHÙ\Îˆ[˜X\ÈHÛY[\ÚYHY\‚‚BBKËÈÙ[\ÈX^[™›Û™XØX^ØYÚİ\ÈÚ]B‚BBKËÈ˜[Z[HXØÙ\ËˆÚ]İ]\ËHY˜][[ÙH]HÜİ‚BBKËÈ˜\šX[	ÜÈ[˜XÛˆHÚ\™H™\˜˜][K‚‚BBZYˆ
›ÙKœ™X\ÛÛš[™ÏË™Y™›Ü
HÂ‚BBBX›ÙKœ™X\ÛÛš[™ÈHÛ[\™X\ÛÛš[™Ñ›Ü“[Ù[
›ÙKœ™X\ÛÛš[™Ë›Ü›X[^™Y[Ù[
NÂ‚BB_B‚BBX\TÙ\šXÙUY\Š›ÙK™\]Y\İYÙ\šXÙUY\ŠNÂ‚BBKËÈÛÙ^[Ø^\ÈÙ[™ÈHØ][ÙÈY˜][İ™\˜›ÜÚ]HÚ[ˆ›İ[™Â‚BBKËÈÚÜÙHÛ™H
ÛÜ™KÜÜ˜ËØÛY[œœÊNÈ˜]]™H[ÙHÙ\ÈHØ[YH˜]\‚‚BBKËÈ[ˆX]š[™ÈH˜XÚÙ[™È]ÈİÛˆY˜][‚‚BBXÛÛœİY˜][™\˜›ÜÚ]HHÙ]ÛÙ^Ø][ÙÑ[J›Ü›X[^™Y[Ù[
OË™Y˜][™\˜›ÜÚ]NÂ‚BBZYˆ
Y˜][™\˜›ÜÚ]H	‰ˆX›ÙK^Ë™\˜›ÜÚ]JHÂ‚BBBX›ÙK^HÈ‹‹˜›ÙK^™\˜›ÜÚ]NˆY˜][™\˜›ÜÚ]HNÂ‚BB_B‚‚BBKËÈ˜]]™H[ÙH\ÈHYÚ\ˆ˜[œÙ›Ü›K›İH\Üİ›İYÚˆB‚BBKËÈİ][\ÜËÜš]˜XŞH[˜\šX[È\HÛˆU‘T–HÛÙ^X›İ[™™\]Y\İ‚‚BBKËÈHÚ]Ô˜XÚÙ[™™\]Z\™\ÈİÜ™OY˜[ÙH[™H[˜Ü\Y\™X\ÛÛš[™Â‚BBKËÈ[˜ÛYK[™Û›Üš[™ÈH›ÙH]ÛZ]È
ÜˆÛÛ˜YXİÊH[HZ]\‚‚BBKËÈÈ\İ™X[HÜˆÚ[[HİÜ™\ÈH™\]Y\İÙ\™\‹\ÚYK‚‚BBX›ÙKœİÜ™HH˜[ÙNÂ‚BBXÛÛœİ[˜ÛYHH\œ˜^Kš\Ğ\œ˜^J›ÙKš[˜ÛYJHÈË‹‹˜›ÙKš[˜ÛYWHˆ×NÂ‚BBZYˆ
Z[˜ÛYKš[˜ÛY\Êœ™X\ÛÛš[™Ë™[˜Ü\YØÛÛ[ŠJHÂ‚BBBZ[˜ÛYKœ\Ú
œ™X\ÛÛš[™Ë™[˜Ü\YØÛÛ[ŠNÂ‚BB_B‚BBX›ÙKš[˜ÛYHH[˜ÛYNÂ‚‚BB[ÙÔ™\]Y\İ
Ñ×ÔÕQÑTËQ•T—ÕS”Ñ“Ô“KÂ‚BBB]\›‚BBB[ÜšYÚ[˜[[Ù[‚BBB[›Ü›X[^™Y[Ù[‚BBBZ\ÕÛÛÎˆHX›ÙKÛÛË‚BBBZ\Ò[œ]ˆHX›ÙKš[œ]‚BBBZ[œ][™İˆ›ÙKš[œ]Ë›[™İ‚BBB\™\]Y\İ˜[œÙ›Ü›S[ÙK‚BBBX›ÙNˆ›ÙH\È[šÛ›İÛˆ\È™XÛÜ™İš[™Ë[šÛ›İÛ‹‚BB_JNÂ‚‚BBKËÈ›ÙXİ^\ÈÛ\ÜÚXÎÈ]H\ÈHÙ\šX[^™K][YHšY]È
ÙYHÚ\P›ÙQ›Ü“[Ù[
K‚‚BB\™]\›ˆÂ‚BBBX›ÙK‚BBB]\]Y[š]ˆÂ‚BBBBK‹‹Š[š]ÏÈßJK‚BBBBX›ÙNˆ”ÓÓ‹œİš[™ÚYJÚ\P›ÙQ›Ü“[Ù[
›ÙJJK‚BBB_K‚BBB\™\]Y\İYÙ\šXÙUY\‹‚BB_NÂ‚B_B‚‚BKËÈ›Ü›X[^™H[Ù[š\œİÈ]\›Z[™HÚXÚ[œİXİ[ÛœÈÈ™]Ú‚BKËÈ\È[œİ\™\ÈÙHÙ]HÛÜœ™Xİ[Ù[\ÜXÚYšXÈ›Û\‚BXÛÛœİ›Ü›X[^™Y[Ù[H›Ü›X[^™S[Ù[
ÜšYÚ[˜[[Ù[
NÂ‚BXÛÛœİ[Ù[˜[Z[HHÙ][Ù[˜[Z[J›Ü›X[^™Y[Ù[
NÂ‚‚BKËÈÙÈÜšYÚ[˜[™\]Y\İ‚B[ÙÔ™\]Y\İ
Ñ×ÔÕQÑTË‘Q“Ô‘WÕS”Ñ“Ô“KÂ‚BB]\›‚BB[ÜšYÚ[˜[[Ù[‚BB[[Ù[ˆ›ÙK›[Ù[‚BBZ\ÕÛÛÎˆHX›ÙKÛÛË‚BBZ\Ò[œ]ˆHX›ÙKš[œ]‚BBZ[œ][™İˆ›ÙKš[œ]Ë›[™İ‚BBXÛÙ^[ÙK‚BB\™\]Y\İ˜[œÙ›Ü›S[ÙK‚BBX›ÙNˆ›ÙH\È[šÛ›İÛˆ\È™XÛÜ™İš[™Ë[šÛ›İÛ‹‚B_JNÂ‚‚BKËÈ™]Ú[Ù[\ÜXÚYšXÈÛÙ^[œİXİ[ÛœÈ
ØXÚY\ˆ[Ù[˜[Z[JB‚BXÛÛœİÛÙ^[œİXİ[ÛœÈH]ØZ]Ù]ÛÙ^[œİXİ[ÛœÊ›Ü›X[^™Y[Ù[
NÂ‚‚BKËÈ˜[œÙ›Ü›H™\]Y\İ›ÙB‚BXÛÛœİ˜[œÙ›Ü›YY›ÙHH]ØZ]˜[œÙ›Ü›T™\]Y\İ›ÙJ‚BBX›ÙK‚BBXÛÙ^[œİXİ[ÛœË‚BB]\Ù\ÛÛ™šYË‚BBXÛÙ^[ÙK‚BB[Ü[ÛœÏË™˜\İÙ\ÜÚ[ÛˆÏÈ˜[ÙK‚BB[Ü[ÛœÏË™˜\İÙ\ÜÚ[Û”İ˜]YŞHÏÈšXœšY‹‚BB[Ü[ÛœÏË™˜\İÙ\ÜÚ[Û“X^[œ]][\ÈÏÈÌ‚BJNÂ‚BX\TÙ\šXÙUY\Š˜[œÙ›Ü›YY›ÙK™\]Y\İYÙ\šXÙUY\ŠNÂ‚‚BKËÈÙÈ˜[œÙ›Ü›YY™\]Y\İ‚B[ÙÔ™\]Y\İ
Ñ×ÔÕQÑTËQ•T—ÕS”Ñ“Ô“KÂ‚BB]\›‚BB[ÜšYÚ[˜[[Ù[‚BB[›Ü›X[^™Y[Ù[ˆ˜[œÙ›Ü›YY›ÙK›[Ù[‚BB[[Ù[˜[Z[K‚BBZ\ÕÛÛÎˆH]˜[œÙ›Ü›YY›ÙKÛÛË‚BBZ\Ò[œ]ˆH]˜[œÙ›Ü›YY›ÙKš[œ]‚BBZ[œ][™İˆ˜[œÙ›Ü›YY›ÙKš[œ]Ë›[™İ‚BB\™X\ÛÛš[™Îˆ˜[œÙ›Ü›YY›ÙKœ™X\ÛÛš[™È\È[šÛ›İÛ‹‚BB]^™\˜›ÜÚ]Nˆ˜[œÙ›Ü›YY›ÙK^Ë™\˜›ÜÚ]K‚BBZ[˜ÛYNˆ˜[œÙ›Ü›YY›ÙKš[˜ÛYK‚BB\™\]Y\İ˜[œÙ›Ü›S[ÙK‚BBX›ÙNˆ˜[œÙ›Ü›YY›ÙH\È[šÛ›İÛˆ\È™XÛÜ™İš[™Ë[šÛ›İÛ‹‚B_JNÂ‚‚BBKËÈ˜[œÙ›Ü›YY›ÙXİ^\ÈÛ\ÜÚXÈÛÈH[œİ\ÜY[[Ù[˜[˜XÚÈØ[‚‚BBKËÈ™K\Ù\šX[^™H]›ÜˆH›Û‹[]H[Ù[ˆ]HÚ\[™È\[œÈ\™K\‚‚BBKËÈ][\YØZ[œİH[Ù[XİX[H™Z[™ÈÙ[‚‚BB\™]\›ˆÂ‚BBBX›ÙNˆ˜[œÙ›Ü›YY›ÙK‚BBB]\]Y[š]ˆÂ‚BBBBK‹‹Š[š]ÏÈßJK‚BBBBX›ÙNˆ”ÓÓ‹œİš[™ÚYJÚ\P›ÙQ›Ü“[Ù[
˜[œÙ›Ü›YY›ÙJJK‚BBB_K‚BBB\™\]Y\İYÙ\šXÙUY\‹‚BB_NÂ‚_HØ]Ú
JHÂ‚B[ÙÑ\œ›ÜŠ	ÑT”“Ô—ÓQTÔĞQÑTË”‘TUQTÕÔT”ÑWÑT”“ÔŸXJNÂ‚B\™]\›ˆ[™Yš[™YÂ‚_BŸB‚‹ÊŠ‚ˆ
ˆÜ™X]\ÈXY\œÈ›ÜˆÛÙ^TH™\]Y\İÂˆ
ˆ\˜[H[š]H™\]Y\İ[š]Ü[ÛœÂˆ
ˆ\˜[HXØÛİ[YHÚ]ÔXØÛİ[Qˆ
ˆ\˜[HXØÙ\ÜÕÚÙ[ˆHĞ]]XØÙ\ÜÈÚÙ[‚ˆ
ˆ\˜[HÜÈHÜ[Û˜[\˜[Y]\œÈ[˜ÛY[™È[Ù[›Û\ØXÚRÙ^K[™Ü™Ø[š^˜][Û’Yˆ
ˆ™]\›œÈXY\œÈØš™XİÚ][™\]Z\™YÛÙ^XY\œÂˆ
‹Â™^Ü[˜İ[ÛˆÜ™X]PÛÙ^XY\œÊˆ[š]ˆ™\]Y\İ[š][™Yš[™YˆXØÛİ[Yˆİš[™ËˆXØÙ\ÜÕÚÙ[ˆİš[™ËˆÜÏÎˆÂˆ[Ù[Îˆİš[™ÎÂˆ›Û\ØXÚRÙ^OÎˆİš[™ÎÂˆÜ™Ø[š^˜][Û’YÎˆİš[™ÎÂˆÊŠˆ™\ÛÛ™YÙ\šXÙWİY\˜ÛˆHÚ\™K›ÜˆXÛÙ^\›İ][™ËZ[ˆ
‹ÂˆÙ\šXÙUY\Îˆİš[™ÎÂˆÊŠˆİXÚŞK\›İ][™ÈÚÙ[ˆØ\\™YX\›Y\ˆ[ˆHØ[YH\›‹ˆ
‹Âˆ\›”İ]OÎˆİš[™ÎÂˆKŠNˆXY\œÈÂ‚XÛÛœİXY\œÈH™]ÈXY\œÊ[š]ËšXY\œÈÏÈßJNÂ‚ZXY\œË™[]JX\KZÙ^HŠNÈËÈ™[[İ™H[H^\İ[™ÈTHÙ^B‚ZXY\œËœÙ]
]]Üš^˜][Ûˆ‹™X\™\ˆ	ØXØÙ\ÜÕÚÙ[ŸX
NÂ‚ZXY\œËœÙ]
ÔSRWÒPQT”ËPĞÓÕS•ÒQXØÛİ[Y
NÂ‚ZXY\œËœÙ]
ÔSRWÒPQT”Ë‘UKÔSRWÒPQT—ÕSQTË‘UWÔ‘TÔÓ”ÑTÊNÂ‚‚KËÈÔMK‹ÔMˆ\İ˜H[™H^Xœ™XZÈY\œÈ\™HÙ\™Yİ™\ˆB‚KËÈ™\ÜÛœÙ\Ë[]H]‚‚ZYˆ
\Ù\Ô™\ÜÛœÙ\Ó]JÜÏË›[Ù[
JHÂ‚BZXY\œËœÙ]
‘TÔÓ”ÑT×ÓUWÒPQT‹‘TÔÓ”ÑT×ÓUWÒPQT—ÕSQJNÂ‚_H[ÙHÂ‚BZXY\œË™[]J‘TÔÓ”ÑT×ÓUWÒPQTŠNÂ‚_B‚‚KËÈÜšYÚ[˜]Üˆ[™PH]\İYÜ™YNˆH˜XÚÙ[™]˜[X]\È[Ù[[][Y[‚KËÈ\ˆÜšYÚ[˜]Üˆ[™™XYÈHÛY[™\œÚ[Ûˆœ›ÛHHPH›ÙXİÚÙ[‹‚‚KËÈÜMKˆY\œÈY˜][ÈHÜİ
Ü[˜ÛÙJHY[]H8 %HÛ™HZ[‚‚KËÈÜ[˜ÛÙH\ÜÙ\ÈÛÛÚ]ÛˆXØÛİ[È]™Z™XİÛÙ^ØÛWÜœØ
ÌNMŠNÂ‚KËÈ]™\][™È[ÙHÙY\ÈHÛÙ^ÓHY[]Hœ›ÛHˆÌNNKˆHÜİ	ÜÂ‚KËÈİÛˆPH
Ú[ˆH[[YH[š™XİYÛ™JHÙY\ÈHY™\\ÙYÜ[˜ÛÙB‚KËÈ™\œÚ[Ûˆ[ˆŞ[˜ÈÚ]H™X[ÜİZ[‚‚XÛÛœİÜİ\Ù\YÙ[HXY\œË™Ù]
\Ù\‹XYÙ[ŠHÏÈ[™Yš[™YÂ‚XÛÛœİY[]HH™\ÛÛ™PÛY[Y[]JÜÏË›[Ù[Üİ\Ù\YÙ[
NÂ‚ZXY\œËœÙ]
ÔSRWÒPQT”Ë“Ô’QÒSUÔ‹Y[]K›ÜšYÚ[˜]ÜŠNÂ‚ZYˆ
›ØÙ\ÜË™[‹ÓÑVĞUUÑTĞP“WĞÓÑVÕTÑT—ĞQÑS•OOHŒHŠHÂ‚BZXY\œËœÙ]
\Ù\‹XYÙ[‹Y[]K\Ù\YÙ[
NÂ‚_B‚KËÈÛÙ^	ÜÈ›İšY\ˆÛÛ™šYÈÙ[™È™\œÚ[ÛˆÛY[™\œÚ[Û˜Ûˆ]™\B‚KËÈ™\]Y\İ
ÛÙ^\œËÛ[Ù[\›İšY\‹Z[™›ÊKˆÛ›HYX[š[™Ù[Ú[ˆÛZ[Z[™Â‚KËÈHÛÙ^ÓHY[]NÈZ[ˆÜ[˜ÛÙHÙ\È›İÙ[™]‚‚XÛÛœİÛÙ^™\œÚ[ÛˆB‚BZY[]K›ÜšYÚ[˜]ÜˆOOHÔSRWÒPQT—ÕSQTË“Ô’QÒSUÔ—ĞÓÑV‚BBOÈ×˜ÛÙ^ØÛWÜœ×ÊÊÊKË™^XÊY[]K\Ù\YÙ[
OË–ÌWB‚BBNˆ[™Yš[™YÂ‚ZYˆ
ÛÙ^™\œÚ[ÛŠHXY\œËœÙ]
ÔSRWÒPQT”Ë•‘T”ÒSÓ‹ÛÙ^™\œÚ[ÛŠNÂ‚Y[ÙHXY\œË™[]JÔSRWÒPQT”Ë•‘T”ÒSÓŠNÂ‚‚KËÈÛÙ^Ù[™ÈXÛÙ^\›İ][™ËZ[ˆ[Ù[OÛYÏ–ÎİY\OY\—XÛˆ]™\B‚KËÈÚ]ÔX˜XÚÙ[™™\]Y\İ
ÛÙ^\œËØÛÜ™KÜÜ˜ËØÛY[œœÂ‚KËÈZ[Ü›İ][™×Ú[ÚXY\˜
K‚‚ZYˆ
ÜÏË›[Ù[
HÂ‚BZXY\œËœÙ]
ÔSRWÒPQT”Ë”“ÕUS‘×ÒS•Z[›İ][™Ò[
ÜË›[Ù[ÜËœÙ\šXÙUY\ŠJNÂ‚_H[ÙHÂ‚BZXY\œË™[]JÔSRWÒPQT”Ë”“ÕUS‘×ÒS•
NÂ‚_B‚ZYˆ
ÜÏË\›”İ]JHXY\œËœÙ]
ÔSRWÒPQT”Ë•T“—ÔÕUKÜË\›”İ]JNÂ‚Y[ÙHXY\œË™[]JÔSRWÒPQT”Ë•T“—ÔÕUJNÂ‚ˆËÈÛÙ^ŒMˆÙ[™ÈÙ\ÜÚ[Û‹ZYØ™XYZY
ÛÙ^X\KÜÜ˜ËÜ™\]Y\İËÂˆËÈXY\œËœœÊNÈH[™\œØÛÜ™YÙ\ÜÚ[Û—ÚYØÛÛ™\œØ][Û—ÚYZ\ˆ\ÈBˆËÈ™KSX^KLŒˆ›Ü›Kİ[Ù[[Û™ÜÚYH›Üˆ˜XÚÙ[™È]Ù^HÛˆ]‚ˆÛÛœİØXÚRÙ^HHÜÏËœ›Û\ØXÚRÙ^NÂˆ›Üˆ
ÛÛœİ˜[YHÙˆÂˆÔSRWÒPQT”ËÓÓ•‘T”ĞUSÓ—ÒQˆÔSRWÒPQT”Ë”ÑTÔÒSÓ—ÒQˆÔSRWÒPQT”Ë”ÑTÔÒSÓ—ÒQÕŒ‹ˆÔSRWÒPQT”Ë•‘PQÒQˆJHÂˆYˆ
ØXÚRÙ^JHXY\œËœÙ]
˜[YKØXÚRÙ^JNÂˆ[ÙHXY\œË™[]J˜[YJNÂˆB‚ˆËÈ\İ™X[HÛÙ^™]™\ˆÙ[™ÈÜ[˜ZK[Ü™Ø[š^˜][Û˜ÛˆÚ]ÔPÛÙ^ˆËÈ™\]Y\İÈ8 %ÛÜšÜÜXÙH›İ][™È\ÈØ\œšYY[\™[HHÚ]ÜXXØÛİ[ZY‚ˆËÈ[›š[™È[ˆÜ™ÈØ[ˆÚYH˜XÚÙ[™	ÜÈ[][Y[]˜[X][ÛˆÈBˆËÈÛÜšÜÜXÙHİ]ÚYHH[Z]Y™]šY]È[™[ˆİ\Ú\ÙKY[]YˆËÈXØÛİ[
ÜMK‹\ÛÛÌNMŠKˆYØXŞH™Z]š[Üˆİ^\ÈÜZ[ˆ›Üˆ][K[Ü™ÂˆËÈÙ]\È]™[YYÛˆ]‚ˆÛÛœİÜ™Ø[š^˜][Û’YHÜÏË›Ü™Ø[š^˜][Û’YÂˆYˆ
ˆÜ™Ø[š^˜][Û’Y	‰‚ˆ›ØÙ\ÜË™[‹ÓÑVĞUUÔÑS‘ÓÔ‘ĞS’VUSÓ—ÒPQTˆOOHŒH‚ˆ
HÂˆXY\œËœÙ]
ÔSRWÒPQT”Ë“Ô‘ĞS’VUSÓ—ÒQÜ™Ø[š^˜][Û’Y
NÂˆH[ÙHÂˆXY\œË™[]JÔSRWÒPQT”Ë“Ô‘ĞS’VUSÓ—ÒQ
NÂˆB‚ˆXY\œËœÙ]
˜XØÙ\‹^Ù]™[\İ™X[HŠNÂˆ™]\›ˆXY\œÎÂŸB‚‹ÊŠ‚ˆ
ˆ[™\È\œ›Üˆ™\ÜÛœÙ\Èœ›ÛHHÛÙ^TBˆ
ˆ\˜[H™\ÜÛœÙHH\œ›Üˆ™\ÜÛœÙHœ›ÛHTBˆ
ˆ\˜[HÜ[ÛœÈHXYÛ›ÜİXËY^˜Xİ[ÛˆÜ[ÛœÈ\ÙYÈ[œšXÚH\œ›Ü‚ˆ
ˆ™]\›œÈ[ˆ\œ›Ü’[™[™Ô™\İ[[™[™ÈH
ÜÜÚX›H™[X\Y
H™\ÜÛœÙKˆ
ˆ\œÙY˜]K[[Z][™›Ë[™HXÛÙY\œ›Üˆ›ÙBˆ
‹Â™^Ü\Ş[˜È[˜İ[Ûˆ[™Q\œ›Ü”™\ÜÛœÙJˆ™\ÜÛœÙNˆ™\ÜÛœÙKˆÜ[ÛœÏÎˆ\œ›Ü’[™[™ÓÜ[ÛœËŠNˆ›ÛZ\ÙO\œ›Ü’[™[™Ô™\İ[ˆÂˆÛÛœİ›ÙU^H]ØZ]ØY™T™XY›ÙJ™\ÜÛœÙJNÂˆÛÛœİX\YHX\\ØYÙS[Z]Ú]›ÙJ™\ÜÛœÙK›ÙU^
NÂˆˆËÈ[][Y[\œ›ÜœÈ™]\›ˆH™XYK]Ë]\ÙH™\ÜÛœÙHÚ]Èİ]\ÂˆYˆ
X\Y	‰ˆX\Yœİ]\ÈOOHÔÕUTË‘“Ô’QSŠHÂˆ™]\›ˆÈ™\ÜÛœÙNˆX\Y˜]S[Z]ˆ[™Yš[™Y\œ›Ü›ÙNˆ[™Yš[™YNÂˆBˆˆÛÛœİš[˜[™\ÜÛœÙHHX\YÏÈ™\ÜÛœÙNÂ‚ˆ]\œ›Ü›ÙNˆ[šÛ›İÛÂˆHÂˆ\œ›Ü›ÙHH›ÙU^È”ÓÓ‹œ\œÙJ›ÙU^
Hˆ[™Yš[™YÂˆHØ]ÚÂˆ\œ›Ü›ÙHHÈY\ÜØYÙNˆ›ÙU^NÂˆB‚ˆÛÛœİXYÛ›ÜİXÜÈH^˜Xİ\œ›Ü‘XYÛ›ÜİXÜÊš[˜[™\ÜÛœÙKÜ[ÛœÊNÂˆÛÛœİ›Ü›X[^™Y\œ›ÜˆH›Ü›X[^™Q\œ›Ü”^[ØY
ˆ\œ›Ü›ÙKˆ›ÙU^ˆš[˜[™\ÜÛœÙKœİ]\Õ^ˆš[˜[™\ÜÛœÙKœİ]\ËˆXYÛ›ÜİXÜËˆ
NÂˆÛÛœİ\œ›Ü”™\ÜÛœÙHH[œİ\™RœÛÛ‘\œ›Ü”™\ÜÛœÙJš[˜[™\ÜÛœÙK›Ü›X[^™Y\œ›ÜŠNÂˆÛÛœİ™]P\ÔÙ\™\‘\œ›ÜˆH\ÔÙ\™\“İ™\›ØYY\œ›ÜŠ›Ü›X[^™Y\œ›ÜŠNÂˆËÈXÚYHÛ˜ÙKœ›ÛHHØ[YHİ™\›ØY™\™XİHØ[\ˆœ˜[˜Ú\ÈÛ‹ÛÂˆËÈH\˜X›H›ØÚÈ[™H™]KXY\ˆ[^HØ[ˆ™]™\ˆ\ØYÜ™YHX›İ]ˆËÈÚ]\ˆ\ÙHXY\œÈYX[ˆ[][™Ë‚ˆÛÛœİ][İRXY\œĞ]]Üš]]]™HH\Ô][İRXY\]]Üš]Jˆš[˜[™\ÜÛœÙKœİ]\Ëˆ™]P\ÔÙ\™\‘\œ›Ü‹ˆ
NÂˆÛÛœİ˜]S[Z]H^˜Xİ˜]S[Z][™›Ñœ›ÛP›ÙJˆš[˜[™\ÜÛœÙKˆ›ÙU^ˆ][İRXY\œĞ]]Üš]]]™Kˆ
NÂ‚ˆYˆ
š[˜[™\ÜÛœÙKœİ]\ÈOOHÔÕUTË•SUUÔ’V‘Q
HÂˆÙÕØ\›ŠÛÙ^\İ™X[H™]\›™YH[˜]]Üš^™Y‹XYÛ›ÜİXÜÊNÂˆB‚ˆÙÔ™\]Y\İ
Ñ×ÔÕQÑTË‘T”“Ô—Ô‘TÔÓ”ÑKÂˆİ]\Îˆš[˜[™\ÜÛœÙKœİ]\Ëˆİ]\Õ^ˆš[˜[™\ÜÛœÙKœİ]\Õ^ˆXYÛ›ÜİXÜËˆJNÂ‚ˆ™]\›ˆÂ‚B\™\ÜÛœÙNˆ\œ›Ü”™\ÜÛœÙK‚B\˜]S[Z]‚BY\œ›Ü›ÙNˆ›Ü›X[^™Y\œ›Ü‹‚B\™]P\ÔÙ\™\‘\œ›Ü‹‚B\][İRXY\œĞ]]Üš]]]™Nˆ][İRXY\œĞ]]Üš]]]™H	‰ˆ˜]S[Z]OOH[™Yš[™Y‚_NÂŸB‚‹ÊŠ‚ˆ
ˆ[™\ÈİXØÙ\ÜÙ[™\ÜÛœÙ\Èœ›ÛHHÛÙ^TBˆ
ˆÛÛ™\ÈÔÑHÈ”ÓÓˆ›Üˆ›Û‹\İ™X[Z[™È™\]Y\İÈ
Ù[™\˜]U^
Bˆ
ˆ\ÜÙ\È›İYÚÔÑH›Üˆİ™X[Z[™È™\]Y\İÈ
İ™X[U^
Bˆ
ˆ\˜[H™\ÜÛœÙHHİXØÙ\ÜÈ™\ÜÛœÙHœ›ÛHTBˆ
ˆ\˜[H\Ôİ™X[Z[™ÈHÚ]\ˆ\È\ÈHİ™X[Z[™È™\]Y\İ
İ™X[O]YH[ˆ›ÙJBˆ
ˆ\˜[HÜ[ÛœÈHÜ[Û˜[İ™X[Tİ[[Y[İ]\Ø
[\‹XÚ[šÈØ\
H[™ˆ
ˆX^İ™X[Q\˜][Û“\Ø
İ[ÜİZXY\œÈXY[™JHİ™\œšY\Âˆ
ˆ™]\›œÈ›ØÙ\ÜÙY™\ÜÛœÙH
ÔÑx¡¤’”ÓÓˆ›Üˆ›Û‹\İ™X[Z[™Ëİ™X[H›Üˆİ™X[Z[™ÊBˆ
‹Â™^Ü\Ş[˜È[˜İ[Ûˆ[™TİXØÙ\ÜÔ™\ÜÛœÙJˆ™\ÜÛœÙNˆ™\ÜÛœÙKˆ\Ôİ™X[Z[™Îˆ›ÛÛX[‹ˆÜ[ÛœÏÎˆÈİ™X[Tİ[[Y[İ]\ÏÎˆ[X™\ÈX^İ™X[Q\˜][Û“\ÏÎˆ[X™\ˆKŠNˆ›ÛZ\ÙO™\ÜÛœÙOˆÂˆËÈÚXÚÈ›Üˆ\™XØ][ÛˆXY\œÈ
‘ÈNM
BˆÛÛœİ\™XØ][ÛˆH™\ÜÛœÙKšXY\œË™Ù]
‘\™XØ][ÛˆŠNÂˆÛÛœİİ[œÙ]H™\ÜÛœÙKšXY\œË™Ù]
”İ[œÙ]ŠNÂˆYˆ
\™XØ][Ûˆİ[œÙ]
HÂˆÙÕØ\›ŠTH\™XØ][Ûˆ›İXÙXÈ\™XØ][Û‹İ[œÙ]JNÂˆB‚ˆÛÛœİ™\ÜÛœÙRXY\œÈH[œİ\™PÛÛ[\J™\ÜÛœÙKšXY\œÊNÂ‚‚KËÈ›Üˆ›Û‹\İ™X[Z[™È™\]Y\İÈ
Ù[™\˜]U^
KÛÛ™\ÔÑHÈ”ÓÓ‚‚ZYˆ
Z\Ôİ™X[Z[™ÊHÂ‚B\™]\›ˆ]ØZ]ÛÛ™\ÜÙUÒœÛÛŠ™\ÜÛœÙK™\ÜÛœÙRXY\œËÜ[ÛœÊNÂ‚_B‚‚KËÈ›Üˆİ™X[Z[™È™\]Y\İÈ
İ™X[U^
K™]\›ˆİ™X[H\ËZ\Â‚\™]\›ˆ™]È™\ÜÛœÙJ™\ÜÛœÙK˜›ÙKÂ‚B\İ]\Îˆ™\ÜÛœÙKœİ]\Ë‚B\İ]\Õ^ˆ™\ÜÛœÙKœİ]\Õ^‚BZXY\œÎˆ™\ÜÛœÙRXY\œË‚_JNÂŸB‚‹ÊŠ‚ˆ
ˆ™XY[ˆ\œ›Ü‹ÙXYÛ›ÜİXÈ›ÙH[™\ˆH\™]HØ\[™Hİ[[Y[İ]ˆ
ˆ[ˆ[ˆ]›İYÚHÙÙÙ\‰ÜÈÙXÜ™]X\ÚÚ[™Ë‚ˆ
‚ˆ
ˆHÛÛÛ™J
K^

XØ\È[˜›İ[™Y
HMLPˆ\œ›Üˆ›ÙHÜZÙYHX\ˆ
ˆHŒÌPŠH[™Y›ÈXY[™H
H›ÙH]š\Y›Ü™]™\ˆ[™ÈHÚÛBˆ
ˆ\œ›Üˆ]8 %Hİ[XXÚ[™\HÛ›H^\İÈÛˆHÔÑH]
Kˆ[™H˜]Âˆ
ˆ^›İÙY[È\œ›Ü‹›Y\ÜØYÙX™\˜˜][KÛÈH™]™\œÙK\›ŞHSYÙBˆ
ˆÚ][\›˜[TÈÜˆ[ˆXÚÙY™X\™\˜ØÚËJ˜ÚÙ[ˆXZÙYÈHÛY[‚ˆ
ˆH›İ[™Y™XY\ˆØ[˜Ù[ÈHİ™X[H]HØ\ÛÈ˜XÚÜ™\Üİ\™H™XXÚ\Âˆ
ˆHÛØÚÙ][™X\ÚÔİš[™È\ÈHØ[YH™YXİ[ÛˆH™\]Y\İÙÙÙ\ˆ\Ù\Ë‚ˆ
‹Â˜\Ş[˜È[˜İ[ÛˆØY™T™XY›ÙJ™\ÜÛœÙNˆ™\ÜÛœÙJNˆ›ÛZ\ÙOİš[™ÏˆÂˆHÂˆÛÛœİ^H]ØZ]™XY›İ[™Y™\ÜÛœÙU^
™\ÜÛœÙK˜ÛÛ™J
JNÂˆ™]\›ˆX\ÚÔİš[™Ê^
NÂˆHØ]ÚÂˆ™]\›ˆˆÂˆBŸB‚™[˜İ[ÛˆX\\ØYÙS[Z]Ú]›ÙJ™\ÜÛœÙNˆ™\ÜÛœÙK›ÙU^ˆİš[™ÊNˆ™\ÜÛœÙH[ÂˆYˆ
™\ÜÛœÙKœİ]\ÈOOHÔÕUTË““ÕÑ“ÕS‘
H™]\›ˆ[ÂˆYˆ
X›ÙU^
H™]\›ˆ[Â‚‚[]ÛÙHHˆÂ‚]HÂ‚BXÛÛœİ\œÙYH”ÓÓ‹œ\œÙJ›ÙU^
H\ÈÈ\œ›ÜÎˆÈÛÙOÎˆİš[™È[X™\È\OÎˆİš[™ÈHNÂ‚BXÛÙHH
\œÙYË™\œ›ÜË˜ÛÙHÏÈ\œÙYË™\œ›ÜË\HÏÈˆŠKÔİš[™Ê
NÂ‚_HØ]ÚÂ‚BXÛÙHHˆÂ‚_B‚‚KËÈÚXÚÈ›Üˆ[][Y[\œ›ÜœÈš\œİH\ÙHÚİ[“Õ™H™X]Y\È˜]H[Z]Â‚ZYˆ
\Ñ[][Y[\œ›ÜŠÛÙK›ÙU^
JHÂ‚B\™]\›ˆÜ™X]Q[][Y[\œ›Ü”™\ÜÛœÙJ›ÙU^
NÂ‚_B‚‚XÛÛœİ^\İXÚÈH	ØÛÙ_H	Ø›ÙU^XÓİÙ\Ø\ÙJ
NÂ‚ZYˆ
Kİ\ØYÙWÛ[Z]Ü™XXÚY˜]WÛ[Z]Ù^ÙYYY\ØYÙH[Z]ÚK\İ
^\İXÚÊJHÂ‚B\™]\›ˆ[Â‚_B‚ˆÛÛœİXY\œÈH™]ÈXY\œÊ™\ÜÛœÙKšXY\œÊNÂˆ™]\›ˆ™]È™\ÜÛœÙJ›ÙU^Âˆİ]\ÎˆÔÕUTË•Ó×ÓPS–WÔ‘TUQTÕËˆİ]\Õ^ˆ•ÛÈX[H™\]Y\İÈ‹ˆXY\œËˆJNÂŸB‚‹ÊŠ‚ˆ
ˆÚ]\ˆHXÛÙ^J˜][İHXY\œÈÛˆ[ˆ\œ›Üˆ™\ÜÛœÙHX^H™H\İY\Âˆ
ˆHXØÛİ[	ÜÈ™X[][İHİ]K‚ˆ
‚ˆ
ˆ^H\™H™[Y]˜X›HÛ›HÚ[ˆH˜XÚÙ[™ÙZYÚY\È™\H™\]Y\İYØZ[œİˆ
ˆH][İH[™™Y\ÙY]›ÜˆH\ØYÙH[Z]8 %K[˜ÛY[™ÈH]ˆ
ˆX\\ØYÙS[Z]Ú]›ÙX™[X\Yˆ]™\Hİ\ˆ\œ›ÜˆÛ\ÜÈØ[ˆXÚÈHİ[Bˆ
ˆÛ˜\Úİ[Û™ÜÚYH[ˆ[œ™[]Y˜Z[\™Nˆ[][Y[\œ›ÜœÈ
\ÜİY\ÈÌM‹ÈÌMÊKˆ
ˆ]]˜Z[\™\Ë^[™\İ™X[Hİ™\›ØYÈ™\ÜÙY\\ÈHKˆXİ[™ÈÛ‚ˆ
ˆ]XÚÈ\ÈÚ]›ØÚÙYX[HXØÛİ[È›Üˆİ\œË‚ˆ
‚ˆ
ˆ]™\HÛÛœİ[Y\ˆÙˆÜÙHXY\œÈ›İ]\È›İYÚ\È™YXØ]KÛÈH[Bˆ
ˆ]™\È[ˆ^XİHÛ™HXÙH[œİXYÙˆ™Z[™È™KY\š]™Y\ˆØ[Ú]K‚ˆ
‹Â™[˜İ[Ûˆ\Ô][İRXY\]]Üš]Jˆİ]\Îˆ[X™\‹ˆ\ÔÙ\™\“İ™\›ØYˆ›ÛÛX[‹ŠNˆ›ÛÛX[ˆÂˆ™]\›ˆİ]\ÈOOHÔÕUTË•Ó×ÓPS–WÔ‘TUQTÕÈ	‰ˆZ\ÔÙ\™\“İ™\›ØYÂŸB‚™[˜İ[Ûˆ^˜Xİ˜]S[Z][™›Ñœ›ÛP›ÙJˆ™\ÜÛœÙNˆ™\ÜÛœÙKˆ›ÙU^ˆİš[™Ëˆ][İRXY\œĞ]]Üš]]]™Nˆ›ÛÛX[‹ŠNˆ˜]S[Z][™›È[™Yš[™YÂˆÛÛœİ\Ôİ]\Ô˜]S[Z]Bˆ™\ÜÛœÙKœİ]\ÈOOHÔÕUTË•Ó×ÓPS–WÔ‘TUQTÕÎÂˆÛÛœİ\œÙY\œ›Ü›ÙHH\œÙTİXİ\™Y\œ›Ü›ÙJ›ÙU^
NÂˆÛÛœİ\œÙYH\œÙT˜]S[Z]›ÙJ\œÙY\œ›Ü›ÙJNÂˆÛÛœİ\ÔÙ\™\“İ™\›ØYH\ÔÙ\™\“İ™\›ØYY\œ›ÜŠ\œÙY\œ›Ü›ÙJNÂ‚ˆYˆ
\ÔÙ\™\“İ™\›ØY	‰ˆZ\Ôİ]\Ô˜]S[Z]
HÂˆ™]\›ˆ[™Yš[™YÂˆB‚ˆÛÛœİ^\İXÚÈH	Ü\œÙYË˜ÛÙHÏÈˆŸH	Ø›ÙU^XÓİÙ\Ø\ÙJ
NÂˆˆËÈ[][Y[\œ›ÜœÈÚİ[›İ™H™X]Y\È˜]H[Z]ÂˆYˆ
\Ñ[][Y[\œ›ÜŠ\œÙYË˜ÛÙHÏÈˆ‹›ÙU^
JHÂˆ™]\›ˆ[™Yš[™YÂˆBˆˆÛÛœİ\Ô˜]S[Z]Bˆ\Ôİ]\Ô˜]S[Z]ˆ\ÔÙ\™\“İ™\›ØYˆİ\ØYÙWÛ[Z]Ü™XXÚY˜]WÛ[Z]Ù^ÙYYY˜]WÛ[Z]\ØYÙH[Z]ÚK\İ
ˆ^\İXÚËˆ
NÂˆYˆ
Z\Ô˜]S[Z]
H™]\›ˆ[™Yš[™YÂ‚ˆËÈH[˜Ø\Y^]\İY]Ú[™İÈ™\Ù]šY\ÈÛˆHØ[YH]]Üš]H[H\ÂˆËÈH\˜X›H›ØÚÎˆÛˆ[Hİ]\Èİ\ˆ[ˆHÙ[Z[™HHHİ[BˆËÈ\ÙY\\˜Ù[ˆLÛİ[İ\Ú\ÙH™XÛÛYH[ˆİ\œË[Û™Ë[˜Ø\X›BˆËÈ™]PY\“\Ø[™œ™Y^™HHXØÛİ[›İYÚX\šÔ˜]S[Z]YÚ]™X\ÛÛ˜ˆËÈ8 %H^Xİ›ØÚÈHØ[\‹\ÚYHØ]HØ\ÈYYÈ™]™[‚ˆÛÛœİ™]PY\“\ÈBˆ\œÙT™]PY\“\Ê™\ÜÛœÙK\œÙY][İRXY\œĞ]]Üš]]]™JHÏÈŒÂ‚ˆ™]\›ˆÈ™]PY\“\ËÛÙNˆ\œÙYË˜ÛÙHNÂŸB‚š[\™˜XÙH˜]S[Z]\œ›Ü›ÙHÂ‚Y\œ›ÜÎˆÂ‚BXÛÙOÎˆİš[™È[X™\Â‚B]\OÎˆİš[™ÎÂ‚BXÛÛ^ÎˆÂ‚BB]\OÎˆİš[™ÎÂ‚B_NÂ‚B\™\Ù]×Ø]Îˆ[X™\Â‚B\™\Ù]Ø]Îˆ[X™\Â‚B\™]WØY\—Û\ÏÎˆ[X™\Â‚B\™]WØY\Îˆ[X™\Â‚_NÂŸB‚™[˜İ[Ûˆ\œÙT˜]S[Z]›ÙJ‚\\œÙY›ÙNˆ˜]S[Z]\œ›Ü›ÙH[™Yš[™YŠNˆÈÛÙOÎˆİš[™ÎÈ\OÎˆİš[™ÎÈÛÛ^\OÎˆİš[™ÎÈ™\Ù]Ğ]Îˆ[X™\È™]PY\“\ÏÎˆ[X™\ˆH[™Yš[™YÂ‚ZYˆ
\\œÙY›ÙJH™]\›ˆ[™Yš[™YÂ‚XÛÛœİ\œ›ÜˆH\œÙY›ÙK™\œ›ÜˆÏÈßNÂ‚XÛÛœİÛÙHH
\œ›Ü‹˜ÛÙHÏÈ\œ›Ü‹\HÏÈˆŠKÔİš[™Ê
NÂ‚XÛÛœİ\HH\[Ùˆ\œ›Ü‹\HOOHœİš[™ÈˆÈ\œ›Ü‹\Hˆ[™Yš[™YÂ‚XÛÛœİÛÛ^\HH\[Ùˆ\œ›Ü‹˜ÛÛ^Ë\HOOHœİš[™ÈˆÈ\œ›Ü‹˜ÛÛ^\Hˆ[™Yš[™YÂ‚XÛÛœİ™\Ù]Ğ]HÓ[X™\Š\œ›Ü‹œ™\Ù]×Ø]ÏÈ\œ›Ü‹œ™\Ù]Ø]
NÂ‚KËÈ™]WØY\—Û\Ø\ÈZ[\ÙXÛÛ™ÎÈ™]WØY\˜\ÈÙXÛÛ™ËˆÙY\Z\‚‚KËÈØØ[\È\İ[˜İˆÛÛ\Ú[™È[H[™™YY[™ÈH™\İ[›İYÚ‚KËÈ›Ü›X[^™T™]PY\‰ÜÈL›ÛÚÜÈZÙHÙXÛÛ™Èˆ]\š\İXÈ\›™YB‚KËÈİX‹\ÙXÛÛ™™]WØY\—Û\Ø
K™ËˆL
H[ÈH][K[Z[]H˜XÚÛÙ™‹‚‚XÛÛœİ™]PY\“\Ô˜]ÈHÓ[X™\Š\œ›Ü‹œ™]WØY\—Û\ÊNÂ‚XÛÛœİ™]PY\”ÙXÛÛ™ÈHÓ[X™\Š\œ›Ü‹œ™]WØY\ŠNÂ‚XÛÛœİ™]PY\“\ÈB‚B\™]PY\“\Ô˜]ÈOOH[™Yš[™Y‚BBOÈ™]PY\“\Ô˜]Â‚BBNˆ™]PY\”ÙXÛÛ™ÈOOH[™Yš[™Y‚BBBOÈ™]PY\”ÙXÛÛ™È
ˆL‚BBBNˆ[™Yš[™YÂ‚\™]\›ˆÈÛÙK\KÛÛ^\K™\Ù]Ğ]™]PY\“\ÈNÂŸB‚™[˜İ[Ûˆ\œÙTİXİ\™Y\œ›Ü›ÙJ›ÙNˆİš[™ÊNˆ˜]S[Z]\œ›Ü›ÙH[™Yš[™YÂ‚ZYˆ
X›ÙJH™]\›ˆ[™Yš[™YÂ‚]HÂ‚B\™]\›ˆ”ÓÓ‹œ\œÙJ›ÙJH\È˜]S[Z]\œ›Ü›ÙNÂ‚_HØ]ÚÂ‚B\™]\›ˆ[™Yš[™YÂ‚_BŸB‚\H\œ›Ü”^[ØYHÂˆ\œ›ÜˆÂˆY\ÜØYÙNˆİš[™ÎÂˆ\OÎˆİš[™ÎÂˆÛÙOÎˆİš[™È[X™\ÂˆÛÛ^ÎˆÂˆ\OÎˆİš[™ÎÂˆNÂˆ[œİ\ÜYÛ[Ù[Îˆİš[™ÎÂˆXYÛ›ÜİXÜÏÎˆ\œ›Ü‘XYÛ›ÜİXÜÎÂˆNÂŸNÂ‚‹ÊŠ‚ˆ
ˆ\\ˆ›İ[™›Üˆ^][™È[ˆ\œ›Ü‹›Y\ÜØYÙXˆH˜]ËX›ÙH˜[˜XÚÂˆ
ˆ™[İÈ\ÙYÈXÚÈHÚÛH\İ™X[H›ÙH™\˜˜][H8 %H][KZ[™™YRĞ‚ˆ
ˆS\œ›ÜˆYÙK[˜Ø]YZY\İš[™ÈÜˆ›İ\È›İHY\ÜØYÙK‚ˆ
‹Â˜ÛÛœİPVÑT”“Ô—ÓQTÔĞQÑWĞÒT”ÈH—ÌÂ‚‹ÊŠ‚ˆ
ˆ›][ˆ[™›İ[™^\İ[™Y›Üˆ\œ›Ü‹›Y\ÜØYÙXˆ\İ™X[H›ÙY\È\™Bˆ
ˆ][K[[™H[™\˜š]˜\š[H\™ÙK[™™Z]\ˆ›Ü\H™[Û™ÜÈ[ˆHšY[ˆ
ˆ]Ø[\œÈ™[™\ˆ[™ÙÈ™\˜˜][KˆH›İ[™Y™XY\İ™X[HØ\ÈBˆ
ˆÛİ\˜ÙNÈ\ÈØ\ÈÚ]İ\š]™\È›Ü›X[^˜][Û‹‚ˆ
‹Â™[˜İ[ÛˆÑ\œ›Ü“Y\ÜØYÙU^
^ˆİš[™ÊNˆİš[™ÈÂˆÛÛœİ›Ü›X[^™YH^œ™\XÙJ×ÊËÙËˆŠKš[J
NÂˆYˆ
›Ü›X[^™Y›[™İHPVÑT”“Ô—ÓQTÔĞQÑWĞÒT”ÊH™]\›ˆ›Ü›X[^™YÂˆ™]\›ˆ	Û›Ü›X[^™YœÛXÙJPVÑT”“Ô—ÓQTÔĞQÑWĞÒT”Ê_x )–İ[˜Ø]YXÂŸB‚™[˜İ[Ûˆ›Ü›X[^™Q\œ›Ü”^[ØY
ˆ\œ›Ü›ÙNˆ[šÛ›İÛ‹ˆ›ÙU^ˆİš[™Ëˆİ]\Õ^ˆİš[™Ëˆİ]\Îˆ[X™\‹ˆXYÛ›ÜİXÜÏÎˆ\œ›Ü‘XYÛ›ÜİXÜËŠNˆ\œ›Ü”^[ØYÂ‚ZYˆ
\ÑXXİ]˜]YÛÜšÜÜXÙQ\œ›ÜŠ\œ›Ü›ÙKİ]\ÊJHÂ‚BXÛÛœİ^[ØYˆ\œ›Ü”^[ØYHÂ‚BBY\œ›ÜˆÂ‚BBB[Y\ÜØYÙN‚‚BBBBH•HÙ[XİYÚ]ÔÛÜšÜÜXÙH\ÈXXİ]˜]Yˆ\ÈÛÜšÜÜXÙH[HÚİ[™H™[[İ™Yœ›ÛH›İ][ÛˆÜˆ™KX]]Üš^™Y™Y›Ü™H™]Z[™Ëˆ‹‚BBB]\NˆÛÜšÜÜXÙWÙXXİ]˜]Y‹‚BBBXÛÙNˆPPÕUUQÕÓÔ’ÔÔPÑWÑT”“Ô—ĞÓÑK‚BB_K‚B_NÂ‚BZYˆ
XYÛ›ÜİXÜÈ	‰ˆØš™XİšÙ^\ÊXYÛ›ÜİXÜÊK›[™İˆ
HÂ‚BB\^[ØY™\œ›Ü‹™XYÛ›ÜİXÜÈHXYÛ›ÜİXÜÎÂ‚B_B‚B\™]\›ˆ^[ØYÂ‚_B‚ˆYˆ
\Õ[œİ\ÜYÛÙ^[Ù[›ÜÚ]Ü
İ]\Ë›ÙU^
JHÂˆÛÛœİ[œİ\ÜY[Ù[B‚BBY^˜Xİ[œİ\ÜYÛÙ^[Ù[œ›ÛU^
›ÙU^
HÏÈœ™\]Y\İY[Ù[Â‚BBBXÛÛœİ^[ØYˆ\œ›Ü”^[ØYHÂ‚BBBBBY\œ›ÜˆÂ‚BBBBBBB[Y\ÜØYÙN‚‚BBBBBBBBBXH[Ù[	Éİ[œİ\ÜY[Ù[IÈ\È›İİ\œ™[H]˜Z[X›H›Üˆ\ÈÚ]ÔXØÛİ[Ú[ˆ\Ú[™ÈÛÙ^Ğ]]ˆ
Â‚BBBBBBBBBH•\È\È[ˆXØÛİ[İÛÜšÜÜXÙH[][Y[Ø]K›İH[\Ü˜\H˜]H[Z]ˆˆ
Â‚BBBBBBBBBH‘Y˜][ÜMKˆY\œËÜMKK[™ÜMKXÛÙ^Ù[XİÜœÈ]]ËYYÜ˜YHİÛˆZ\ˆ˜[˜XÚÈÚZ[œÈˆ
Â‚BBBBBBBBBHŠÜİ]šXHÓÑVĞUUÑTĞP“WÑÔM—ĞUU×ÑSPÒËÑÔMKĞÓÑVLJKˆˆ
Â‚BBBBBBBBBH•H	ÙÜMKIÈ
]\İÙ[™\˜[
K	ÙÜMKXÛÙ^	È
Ø[›ÛšXØ[
KÜˆYØXŞH[X\Ù\ÈZÙH	ÙÜMKŒËXÛÙ^	ËÉÙÜMKŒ‹XÛÙ^	ËÜˆ[˜X›H]]ÛX]XÈ˜[˜XÚÈšXHˆ
Â‚BBBBBBBBBIİ[œİ\ÜYÛÙ^ÛXŞNˆ™˜[˜XÚÈˆ
ÜˆÓÑVĞUUÕS”ÕTÔ•QÓSÑSÔÓPÖOY˜[˜XÚÊKˆ	È
Â‚BBBBBBBBBHŠYØXŞNˆÓÑVĞUUÑSPÒ×ÕS”ÕTÔ•QÓSÑSLHÜˆ˜[˜XÚÓÛ•[œİ\ÜYÛÙ^[Ù[
Kˆ‹‚BBBBBBB]\Nˆ™[][Y[Ù\œ›Üˆ‹‚BBBBBBBXÛÙNˆÒUÔĞÓÑVÕS”ÕTÔ•QÓSÑSĞÓÑK‚BBBBBBB][œİ\ÜYÛ[Ù[ˆ[œİ\ÜY[Ù[‚BBBBB_K‚BBB_NÂˆYˆ
XYÛ›ÜİXÜÈ	‰ˆØš™XİšÙ^\ÊXYÛ›ÜİXÜÊK›[™İˆ
HÂˆ^[ØY™\œ›Ü‹™XYÛ›ÜİXÜÈHXYÛ›ÜİXÜÎÂˆBˆ™]\›ˆ^[ØYÂˆB‚ˆYˆ
\Ô™XÛÜ™
\œ›Ü›ÙJJHÂˆÛÛœİX^X™Q\œ›ÜˆH\œ›Ü›ÙK™\œ›ÜÂˆYˆ
\Ô™XÛÜ™
X^X™Q\œ›ÜŠH	‰ˆ\[ÙˆX^X™Q\œ›Ü‹›Y\ÜØYÙHOOHœİš[™ÈŠHÂˆÛÛœİ^[ØYˆ\œ›Ü”^[ØYHÂˆ\œ›ÜˆÂˆY\ÜØYÙNˆÑ\œ›Ü“Y\ÜØYÙU^
X^X™Q\œ›Ü‹›Y\ÜØYÙJKˆKˆNÂˆYˆ
\[ÙˆX^X™Q\œ›Ü‹\HOOHœİš[™ÈŠHÂˆ^[ØY™\œ›Ü‹\HHX^X™Q\œ›Ü‹\NÂˆBˆYˆ
\[ÙˆX^X™Q\œ›Ü‹˜ÛÙHOOHœİš[™Èˆ\[ÙˆX^X™Q\œ›Ü‹˜ÛÙHOOH›[X™\ˆŠHÂˆ^[ØY™\œ›Ü‹˜ÛÙHHX^X™Q\œ›Ü‹˜ÛÙNÂˆBˆYˆ
ˆ\Ô™XÛÜ™
X^X™Q\œ›Ü‹˜ÛÛ^
H	‰‚ˆ\[ÙˆX^X™Q\œ›Ü‹˜ÛÛ^\HOOHœİš[™È‚ˆ
HÂˆ^[ØY™\œ›Ü‹˜ÛÛ^HÈ\NˆX^X™Q\œ›Ü‹˜ÛÛ^\HNÂˆBˆYˆ
XYÛ›ÜİXÜÈ	‰ˆØš™XİšÙ^\ÊXYÛ›ÜİXÜÊK›[™İˆ
HÂˆ^[ØY™\œ›Ü‹™XYÛ›ÜİXÜÈHXYÛ›ÜİXÜÎÂˆBˆYˆ
İ]\ÈOOHÔÕUTË•SUUÔ’V‘Q
HÂˆ^[ØY™\œ›Ü‹›Y\ÜØYÙHH	Ü^[ØY™\œ›Ü‹›Y\ÜØYÙ_H
[ˆÜ[˜ÛÙH]]ÙÚ[—Yˆ\È\œÚ\İÊXÂˆBˆ™]\›ˆ^[ØYÂˆB‚ˆYˆ
\[Ùˆ\œ›Ü›ÙK›Y\ÜØYÙHOOHœİš[™ÈŠHÂˆÛÛœİ^[ØYˆ\œ›Ü”^[ØYHÈ\œ›ÜˆÈY\ÜØYÙNˆÑ\œ›Ü“Y\ÜØYÙU^
\œ›Ü›ÙK›Y\ÜØYÙJHHNÂˆYˆ
XYÛ›ÜİXÜÈ	‰ˆØš™XİšÙ^\ÊXYÛ›ÜİXÜÊK›[™İˆ
HÂˆ^[ØY™\œ›Ü‹™XYÛ›ÜİXÜÈHXYÛ›ÜİXÜÎÂˆBˆYˆ
İ]\ÈOOHÔÕUTË•SUUÔ’V‘Q
HÂˆ^[ØY™\œ›Ü‹›Y\ÜØYÙHH	Ü^[ØY™\œ›Ü‹›Y\ÜØYÙ_H
[ˆÜ[˜ÛÙH]]ÙÚ[—Yˆ\È\œÚ\İÊXÂˆBˆ™]\›ˆ^[ØYÂˆB‚ˆËÈ˜\İTK\İ[H›ÙY\ÈØ\œHH[X[‹\™XYX›H\œ›ÜˆÛˆBˆËÈÜ[]™[]Z[šY[
İš[™ËÜˆH™XÛÜ™Û[™ÂˆËÈY\ÜØYÙKØÛÙKİ\JKˆÚ]İ]\Èœ˜[˜Ú^Hİ\™˜XÙY\ÂˆËÈH˜]È”ÓÓˆİš[™ÈÙˆHÚÛH›ÙK‚ˆÛÛœİ]Z[H\œ›Ü›ÙK™]Z[ÂˆÛÛœİ]Z[Y\ÜØYÙHBˆ\[Ùˆ]Z[OOHœİš[™È‚ˆÈ]Z[ˆˆ\Ô™XÛÜ™
]Z[
H	‰ˆ\[Ùˆ]Z[›Y\ÜØYÙHOOHœİš[™È‚ˆÈ]Z[›Y\ÜØYÙBˆˆ[™Yš[™YÂˆYˆ
\[Ùˆ]Z[Y\ÜØYÙHOOHœİš[™Èˆ	‰ˆ]Z[Y\ÜØYÙKš[J
JHÂˆÛÛœİ^[ØYˆ\œ›Ü”^[ØYHÂˆ\œ›ÜˆÈY\ÜØYÙNˆÑ\œ›Ü“Y\ÜØYÙU^
]Z[Y\ÜØYÙJHKˆNÂˆYˆ
\Ô™XÛÜ™
]Z[
JHÂˆYˆ
\[Ùˆ]Z[\HOOHœİš[™ÈŠHÂˆ^[ØY™\œ›Ü‹\HH]Z[\NÂˆBˆYˆ
ˆ\[Ùˆ]Z[˜ÛÙHOOHœİš[™Èˆˆ\[Ùˆ]Z[˜ÛÙHOOH›[X™\ˆ‚ˆ
HÂˆ^[ØY™\œ›Ü‹˜ÛÙHH]Z[˜ÛÙNÂˆBˆBˆYˆ
XYÛ›ÜİXÜÈ	‰ˆØš™XİšÙ^\ÊXYÛ›ÜİXÜÊK›[™İˆ
HÂˆ^[ØY™\œ›Ü‹™XYÛ›ÜİXÜÈHXYÛ›ÜİXÜÎÂˆBˆYˆ
İ]\ÈOOHÔÕUTË•SUUÔ’V‘Q
HÂˆ^[ØY™\œ›Ü‹›Y\ÜØYÙHH	Ü^[ØY™\œ›Ü‹›Y\ÜØYÙ_H
[ˆÜ[˜ÛÙH]]ÙÚ[—Yˆ\È\œÚ\İÊXÂˆBˆ™]\›ˆ^[ØYÂˆBˆB‚ˆÛÛœİš[[YYH›ÙU^š[J
NÂˆYˆ
š[[YY
HÂˆÛÛœİ^[ØYˆ\œ›Ü”^[ØYHÈ\œ›ÜˆÈY\ÜØYÙNˆÑ\œ›Ü“Y\ÜØYÙU^
š[[YY
HHNÂˆYˆ
XYÛ›ÜİXÜÈ	‰ˆØš™XİšÙ^\ÊXYÛ›ÜİXÜÊK›[™İˆ
HÂˆ^[ØY™\œ›Ü‹™XYÛ›ÜİXÜÈHXYÛ›ÜİXÜÎÂˆBˆYˆ
İ]\ÈOOHÔÕUTË•SUUÔ’V‘Q
HÂˆ^[ØY™\œ›Ü‹›Y\ÜØYÙHH	Ü^[ØY™\œ›Ü‹›Y\ÜØYÙ_H
[ˆÜ[˜ÛÙH]]ÙÚ[—Yˆ\È\œÚ\İÊXÂˆBˆ™]\›ˆ^[ØYÂˆB‚ˆYˆ
İ]\Õ^
HÂˆÛÛœİ^[ØYˆ\œ›Ü”^[ØYHÈ\œ›ÜˆÈY\ÜØYÙNˆÑ\œ›Ü“Y\ÜØYÙU^
İ]\Õ^
HHNÂˆYˆ
XYÛ›ÜİXÜÈ	‰ˆØš™XİšÙ^\ÊXYÛ›ÜİXÜÊK›[™İˆ
HÂˆ^[ØY™\œ›Ü‹™XYÛ›ÜİXÜÈHXYÛ›ÜİXÜÎÂˆBˆYˆ
İ]\ÈOOHÔÕUTË•SUUÔ’V‘Q
HÂˆ^[ØY™\œ›Ü‹›Y\ÜØYÙHH	Ü^[ØY™\œ›Ü‹›Y\ÜØYÙ_H
[ˆÜ[˜ÛÙH]]ÙÚ[—Yˆ\È\œÚ\İÊXÂˆBˆ™]\›ˆ^[ØYÂˆB‚ˆÛÛœİ^[ØYˆ\œ›Ü”^[ØYHÈ\œ›ÜˆÈY\ÜØYÙNˆ”™\]Y\İ˜Z[YˆHNÂˆYˆ
XYÛ›ÜİXÜÈ	‰ˆØš™XİšÙ^\ÊXYÛ›ÜİXÜÊK›[™İˆ
HÂˆ^[ØY™\œ›Ü‹™XYÛ›ÜİXÜÈHXYÛ›ÜİXÜÎÂˆBˆYˆ
İ]\ÈOOHÔÕUTË•SUUÔ’V‘Q
HÂˆ^[ØY™\œ›Ü‹›Y\ÜØYÙHH	Ü^[ØY™\œ›Ü‹›Y\ÜØYÙ_H
[ˆÜ[˜ÛÙH]]ÙÚ[—Yˆ\È\œÚ\İÊXÂˆBˆ™]\›ˆ^[ØYÂŸB‚™[˜İ[Ûˆ[œİ\™RœÛÛ‘\œ›Ü”™\ÜÛœÙJ™\ÜÛœÙNˆ™\ÜÛœÙK^[ØYˆ\œ›Ü”^[ØY
Nˆ™\ÜÛœÙHÂˆÛÛœİXY\œÈH™]ÈXY\œÊ™\ÜÛœÙKšXY\œÊNÂˆXY\œËœÙ]
˜ÛÛ[]\H‹˜\XØ][Û‹ÚœÛÛÈÚ\œÙ]]]‹NŠNÂˆ™]\›ˆ™]È™\ÜÛœÙJ”ÓÓ‹œİš[™ÚYJ^[ØY
KÂˆİ]\Îˆ™\ÜÛœÙKœİ]\Ëˆİ]\Õ^ˆ™\ÜÛœÙKœİ]\Õ^ˆXY\œË‚_JNÂŸB‚™[˜İ[Ûˆ\œÙT™]PY\“\Êˆ™\ÜÛœÙNˆ™\ÜÛœÙKˆ\œÙY›ÙNˆÈ™\Ù]Ğ]Îˆ[X™\È™]PY\“\ÏÎˆ[X™\ˆH[™Yš[™Yˆ\İ^]\İYÚ[™İÜÎˆ›ÛÛX[‹ŠNˆ[X™\ˆ[ÂˆËÈHÚ[™İÈH˜XÚÙ[™™\ÜÈ\È[HÜ[
\ÙY\\˜Ù[HL
BˆËÈİ]˜[šÜÈ]™\Hİ\ˆÚYÛ˜[[™\È[X™\˜][H[˜Ø\Yˆ]È™\Ù]ˆËÈ\ÈHX\›Y\İ[ÛY[HXØÛİ[Ø[ˆÙ\™HYØZ[ÈH™]KXY\˜ˆËÈÙˆÌÈÜˆHÛÛÛ™\ˆZ™\Ù]Ûİ[\İ]HXØÛİ[˜XÚÈ[ÂˆËÈ›İ][ÛˆÈ˜Z[YØZ[ˆ
\ÜİYHÌŒN
KˆÛ›HÛ›İ\ˆ]Ú[ˆHØ[\‚ˆËÈØ^\ÈÜÙHXY\œÈ\™H]]Üš]]]™H›Üˆ\È™\ÜÛœÙK‚ˆYˆ
\İ^]\İYÚ[™İÜÊHÂˆÛÛœİ^]\İY™\Ù]]\ÈHÙ]][İQ^]\İY™\Ù]]\Ê™\ÜÛœÙKšXY\œÊNÂˆYˆ
^]\İY™\Ù]]\ÈOOH[™Yš[™Y
HÂˆÛÛœİ[HH^]\İY™\Ù]]\ÈH]K››İÊ
NÂˆYˆ
[Hˆ
H™]\›ˆ[NÂˆBˆB‚ˆYˆ
\œÙY›ÙOËœ™]PY\“\ÈOOH[™Yš[™Y
HÂˆËÈ[™XYH›Ü›X[^™YÈZ[\ÙXÛÛ™È[ˆ\œÙT˜]S[Z]›ÙH
\ÈšY[ˆËÈ\ÙY™\˜˜][KÙXÛÛ™ÈšY[ÛÛ™\YšXH
ŒL
KˆÈ“Õ\ÜÂˆËÈ›İYÚHL›ÛÚÜÈZÙHÙXÛÛ™Èˆ]\š\İXËÚXÚÛİ[ˆËÈZ\Ë\ØØ[HHÙ[Z[™HİX‹\ÙXÛÛ™˜[YH[ÈZ[]\ËˆØ\]HZ[‹‚ˆÛÛœİ\ÈH\œÙY›ÙKœ™]PY\“\ÎÂˆYˆ
[X™\‹š\Ñš[š]J\ÊH	‰ˆ\Èˆ
HÂˆËÈ›ÛÜˆ][\ÎˆHİX‹[\È˜[YHZÙH™]WØY\—Û\ÎˆBˆËÈ›ÛÜ™YÈ›İÙY[ÈX\šÔ˜]S[Z]YÚ]™X\ÛÛŠ
KˆËÈÚ\™HH™\›È[^HYX[œÈÚ[™İÈ[\ÙYˆ[™SUTÂˆËÈ^\İ[™È˜]K[[Z]›ØÚÜÈ8 %HÜİ[HHÛİ[ÛX\‚ˆËÈ]™\H›ØÚÈÛˆHXØÛİ[‚ˆ™]\›ˆX]›Z[ŠX]›X^
KX]™›ÛÜŠ\ÊJKPVÔ‘U–WÑSVWÓTÊNÂˆBˆB‚ˆËÈHXY\ˆ]ÈZ\œ›ÜˆH›ÙHšY[ÈX›İ™H[™Ù]HØ[YHK[Z[‚ˆËÈØ\ˆ[ˆİ™\œÚ^™YÜˆ›Ùİ\È™]KXY\˜]\İ›İœ™Y^™H[ˆXØÛİ[ˆËÈ˜\ˆ\İHØ\H›ÙH][™›Ü˜Ù\ËˆH™\Ù]X]]È™[İÈ\™BˆËÈ[X™\˜][H[˜Ø\Y8 %][İHÚ[™İÜÈYÚ][X][H™\Ù]İ\œÈİ]‚ˆÛÛœİ™]PY\“\ÒXY\ˆH™\ÜÛœÙKšXY\œË™Ù]
œ™]KXY\‹[\ÈŠNÂˆYˆ
™]PY\“\ÒXY\ŠHÂˆÛÛœİ\œÙYH[X™\‹œ\œÙR[
™]PY\“\ÒXY\‹L
NÂˆYˆ
S[X™\‹š\Ó˜SŠ\œÙY
H	‰ˆ\œÙYˆ
HÂˆ™]\›ˆX]›Z[Š\œÙYPVÔ‘U–WÑSVWÓTÊNÂˆBˆB‚ˆÛÛœİ™]PY\’XY\ˆH™\ÜÛœÙKšXY\œË™Ù]
œ™]KXY\ˆŠNÂˆYˆ
™]PY\’XY\ŠHÂˆÛÛœİ\œÙYH[X™\‹œ\œÙR[
™]PY\’XY\‹L
NÂˆYˆ
S[X™\‹š\Ó˜SŠ\œÙY
H	‰ˆ\œÙYˆ
HÂˆ™]\›ˆX]›Z[Š\œÙY
ˆLPVÔ‘U–WÑSVWÓTÊNÂˆBˆËÈ‘ÈÌŒÌH[ÛÈ\›Z]È[ˆXœÛÛ]HY]BˆËÈ
”™]KPY\ˆÙYŒHØİŒNHÎŒŒÓUŠKˆ\œÙR[Û‚ˆËÈÛ™H\È˜S‹ÛÈÛ›HH›Û‹[[Y\šXÈœ˜[˜Ú™XXÚ\ÂˆËÈ]Kœ\œÙH8 %H[Y\šXËX][›Û‹\ÜÚ]]™H˜[YH
™YØ]]™JBˆËÈÙY\È]È^\İ[™ÈšYÛ›Ü™H[™˜[›İYÚˆ™\™XİˆBˆËÈ\İİ[œ\œÙXX›H]HZÙ]Ú\ÙH˜[È›İYÚ˜]\ˆ[‚ˆËÈX[Y˜Xİ\š[™ÈH[^NÈ]\™H]\ÈÙ]HØ[YHK[Z[ˆØ\‚ˆYˆ
[X™\‹š\Ó˜SŠ\œÙY
JHÂˆÛÛœİ]S\ÈH]Kœ\œÙJ™]PY\’XY\ŠNÂˆYˆ
S[X™\‹š\Ó˜SŠ]S\ÊJHÂˆÛÛœİ[HH]S\ÈH]K››İÊ
NÂˆYˆ
[Hˆ
HÂˆ™]\›ˆX]›Z[ŠˆX]™›ÛÜŠ[JKˆPVÔ‘U–WÑSVWÓTËˆ
NÂˆBˆBˆBˆB‚ˆËÈ›ÈÚ[™İÈÛZ[YY^]\İ[Û‹ÛÈ\È\È[ˆÜ™[˜\H›İH˜]\‚ˆËÈ[ˆHÜ[][İNˆHÛÛÛ™\İ™\Ù]\ÈHšYÚÛ™HÈØZ]›Ü‹‚ˆÛÛœİ›İÈH]K››İÊ
NÂˆÛÛœİ™\Ù]Ø[™Y]\Îˆ[X™\–×HH×NÂ‚ˆËÈ™XYHÛÙ^Ú[™İÜÈ›İYÚHÚ\™Y\œÙ\ˆ˜]\ˆ[ˆBˆËÈ™\Ù]X]XY\ˆ[Û™KÛÈHHØ\œZ[™ÈÛ›H\™\Ù]XY\‹\ÙXÛÛ™ØˆËÈÜˆ[ˆTÓÈ\™\Ù]X]›ÙXÙ\ÈHØ[™Y]H[œİXYÙˆ˜[[™È˜XÚÈÂˆËÈHŒÈY˜][ˆÚ[™İÜÈH[ˆ\ÈİÚ]ÚYÙ™ˆ\™HÚÚ\YˆZ\‚ˆËÈ™\Ù]Ø^\È›İ[™ÈX›İ]Ú[ˆ\È™\]Y\İØ[ˆÛÈ›İYÚ‚ˆËÂˆËÈ\È\ÈHÙXÛÛ™[˜Ø\Y™XYÙˆHØ[YHXÛÙ^J˜XY\œËÛÈ]ˆËÈZÙ\ÈHØ[YH]]Üš]HØ]H\ÈH^]\İY]Ú[™İÈÚÜİ]X›İ™N‚ˆËÈİ\Ú\ÙH[ˆ[\İYÛ˜\ÚİØ[ÜÈİ˜ZYÚ˜XÚÈ[ˆ›İYÚBˆËÈ›Ü™[˜\H›İHˆÛÜˆ[™›ÙXÙ\ÈH™\Hİ\œË[Û™È[^HBˆËÈÚÜİ]Ø\ÈØ]YÈ™]™[ˆHÙ[™\šXÈ\˜][[Z]\™\Ù]ˆËÈXY\ˆ[™H›ÙH™\Ù]×Ø]Ú]ÛˆHØ[YH[˜Ø\Y[^H]ˆËÈ[™ZÙHHØ[YHØ]NˆÛˆ[Hİ]\Èİ\ˆ[ˆHÙ[Z[™HH^BˆËÈ\™H[\İYXÚÙ\Ë[™Û›Üš[™ÈÛ™H[™ÈHİ[HÜˆÜİ[BˆËÈ˜[YH[ˆ[˜Ø\Y][K^YX\ˆ›ØÚÈ›İYÚX\šÔ˜]S[Z]YÚ]™X\ÛÛ‹‚ˆYˆ
\İ^]\İYÚ[™İÜÊHÂˆ›Üˆ
ÛÛœİÚ[™İÈÙˆ\œÙPÛÙ^][İUÚ[™İÜÊ™\ÜÛœÙKšXY\œË›İÊJHÂˆYˆ
\Ô][İUÚ[™İÑ\ØX›Y
Ú[™İÊJHÛÛ[YNÂˆÛÛœİ™\Ù]]\ÈHÚ[™İËœ™\Ù]]\ÎÂˆYˆ
\[Ùˆ™\Ù]]\ÈOOH›[X™\ˆˆS[X™\‹š\Ñš[š]J™\Ù]]\ÊJHÛÛ[YNÂˆÛÛœİ[HH™\Ù]]\ÈH›İÎÂˆYˆ
[Hˆ
H™\Ù]Ø[™Y]\Ëœ\Ú
[JNÂˆB‚ˆÛÛœİ™\Ù]]XY\œÈHÈ\˜][[Z]\™\Ù]—NÂˆ›Üˆ
ÛÛœİXY\ˆÙˆ™\Ù]]XY\œÊHÂˆÛÛœİ˜[YHH™\ÜÛœÙKšXY\œË™Ù]
XY\ŠNÂˆYˆ
]˜[YJHÛÛ[YNÂˆÛÛœİ\œÙYH[X™\‹œ\œÙR[
˜[YKL
NÂˆYˆ
S[X™\‹š\Ó˜SŠ\œÙY
H	‰ˆ\œÙYˆ
HÂˆËÈHLŒL\ØÜš[Z[˜]ÜˆÙY\È\ØÚÙXÛÛ™ÂˆËÈ\İ[˜İœ›ÛH\ØÚZ[\ÙXÛÛ™ÎÈ›\[™ÈÜ‚ˆËÈ›Ü[™È]Z\Ë\ØØ[\È]™\H˜[YHHL‚ˆÛÛœİ[Y\İ[\Bˆ\œÙYLÌÌÌÈ\œÙY
ˆLˆ\œÙYÂˆÛÛœİ[HH[Y\İ[\H›İÎÂˆËÈØ[YHPVÔUSÕWÔ‘TÑUÒÔ’V“Ó—ÓTÈİX\™BˆËÈXÛÙ^Jˆ\œÙ\ˆ\Y\È[ˆÚ][”™\Ù]Üš^›Û‚ˆËÈÚ]İ]]HÜİ[H\˜][[Z]\™\Ù]Ü›İBˆËÈH[Û›İÛšXËY™™Xİ]™[KY›Ü™]™\ˆ\œÚ\İYˆËÈ›ØÚÈ]›È]\ˆHÛİ[ÚÜ[‹‚ˆYˆ
[Hˆ	‰ˆ[HHPVÔUSÕWÔ‘TÑUÒÔ’V“Ó—ÓTÊHÂˆ™\Ù]Ø[™Y]\Ëœ\Ú
[JNÂˆBˆBˆB‚ˆYˆ
\œÙY›ÙOËœ™\Ù]Ğ]
HÂˆÛÛœİ[Y\İ[\Bˆ\œÙY›ÙKœ™\Ù]Ğ]LÌÌÌˆÈ\œÙY›ÙKœ™\Ù]Ğ]
ˆLˆˆ\œÙY›ÙKœ™\Ù]Ğ]ÂˆÛÛœİ[HH[Y\İ[\H›İÎÂˆYˆ
[Hˆ	‰ˆ[HHPVÔUSÕWÔ‘TÑUÒÔ’V“Ó—ÓTÊHÂˆ™\Ù]Ø[™Y]\Ëœ\Ú
[JNÂˆBˆBˆB‚ˆYˆ
™\Ù]Ø[™Y]\Ë›[™İˆ
HÂˆ™]\›ˆX]›Z[Š‹‹œ™\Ù]Ø[™Y]\ÊNÂˆB‚ˆ™]\›ˆ[ÂŸB‚˜ÛÛœİPVÔ‘U–WÑSVWÓTÈHH
ˆŒ
ˆLÂ‚™[˜İ[ÛˆÓ[X™\Š˜[YNˆ[šÛ›İÛŠNˆ[X™\ˆ[™Yš[™YÂˆYˆ
˜[YHOOH[˜[YHOOH[™Yš[™Y
H™]\›ˆ[™Yš[™YÂˆÛÛœİ\œÙYH[X™\Š˜[YJNÂˆ™]\›ˆ[X™\‹š\Ñš[š]J\œÙY
HÈ\œÙYˆ[™Yš[™YÂŸB‚™[˜İ[Ûˆ^˜Xİ\œ›Ü‘XYÛ›ÜİXÜÊˆ™\ÜÛœÙNˆ™\ÜÛœÙKˆÜ[ÛœÏÎˆ\œ›Ü’[™[™ÓÜ[ÛœËŠNˆ\œ›Ü‘XYÛ›ÜİXÜÈ[™Yš[™YÂˆÛÛœİ™\]Y\İYBˆ™\ÜÛœÙKšXY\œË™Ù]
\™\]Y\İZYŠHÏÂˆ™\ÜÛœÙKšXY\œË™Ù]
œ™\]Y\İZYŠHÏÂˆ™\ÜÛœÙKšXY\œË™Ù]
›Ü[˜ZK\™\]Y\İZYŠHÏÂˆ™\ÜÛœÙKšXY\œË™Ù]
[Ü[˜ZK\™\]Y\İZYŠHÏÂˆ[™Yš[™YÂˆÛÛœİÙ”˜^HH™\ÜÛœÙKšXY\œË™Ù]
˜Ù‹\˜^HŠHÏÈ[™Yš[™YÂ‚ˆÛÛœİXYÛ›ÜİXÜÎˆ\œ›Ü‘XYÛ›ÜİXÜÈHÂˆİ]\Îˆ™\ÜÛœÙKœİ]\Ëˆ™\]Y\İYˆÙ”˜^KˆÛÜœ™[][Û’YˆÜ[ÛœÏËœ™\]Y\İÛÜœ™[][Û’Yˆ™XYYˆÜ[ÛœÏË™XYYˆNÂ‚ˆ›Üˆ
ÛÛœİÚÙ^K˜[YWHÙˆØš™Xİ™[šY\ÊXYÛ›ÜİXÜÊJHÂˆYˆ
˜[YHOOH[™Yš[™Y˜[YHOOHˆŠHÂˆ[]HXYÛ›ÜİXÜÖÚÙ^H\ÈÙ^[Ùˆ\œ›Ü‘XYÛ›ÜİXÜ×NÂˆBˆB‚ˆ™]\›ˆØš™XİšÙ^\ÊXYÛ›ÜİXÜÊK›[™İˆÈXYÛ›ÜİXÜÈˆ[™Yš[™YÂŸB
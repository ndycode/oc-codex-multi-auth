/**
 * Helper functions for the custom fetch implementation
 * These functions break down the complex fetch logic into manageable, testable units
 */

import type { Auth, OpencodeClient } from "@opencode-ai/sdk";
import { queuedRefresh } from "../refresh-queue.js";
import { logRequest, logError, logWarn } from "../logger.js";
import {
	ensureInstructionIdentity,
	getCodexInstructions,
	getModelFamily,
} from "../prompts/codex.js";
import {
	transformRequestBody,
	normalizeModel,
	upsertBackendModelIdentityMessage,
} from "./request-transformer.js";
import {
	GPT_55_MODEL_ID,
	GPT_56_LUNA_MODEL_ID,
	GPT_56_SOL_MODEL_ID,
	GPT_56_TERRA_MODEL_ID,
} from "./helpers/model-map.js";
import { stripEffortSuffix } from "./helpers/effort-suffix.js";
import {
	RESPONSES_LITE_HEADER,
	RESPONSES_LITE_HEADER_VALUE,
	shapeBodyForModel,
	usesResponsesLite,
} from "./helpers/responses-lite.js";
import { buildCodexUserAgent } from "./helpers/user-agent.js";
import { convertSseToJson, ensureContentType } from "./response-handler.js";
import type { OAuthAuthDetails, UserConfig, RequestBody } from "../types.js";
import { CodexAuthError } from "../errors.js";
import {
	DEACTIVATED_WORKSPACE_ERROR_CODE,
	isInvalidatedAuthTokenMessage,
} from "../error-sentinels.js";
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
	// GPT-5.6 shipped as a limited preview. Accounts outside it get
	// `model_not_supported_with_chatgpt_account`, so degrade down the 5.6 tiers
	// and then out to the generally-available 5.5 family.
	[GPT_56_SOL_MODEL_ID]: [
		GPT_56_TERRA_MODEL_ID,
		GPT_56_LUNA_MODEL_ID,
		GPT_55_MODEL_ID,
	],
	[GPT_56_TERRA_MODEL_ID]: [GPT_56_LUNA_MODEL_ID, GPT_55_MODEL_ID],
	[GPT_56_LUNA_MODEL_ID]: [GPT_55_MODEL_ID],
	[GPT_55_MODEL_ID]: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
	"gpt-5.4": ["gpt-5.4-mini", "gpt-5.4-nano"],
	"gpt-5.4-mini": ["gpt-5.4-nano"],
	"gpt-5.4-pro": ["gpt-5.4"],
	"gpt-5-codex": ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
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
};

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

	return withoutEffort;
}

function normalizeFallbackChain(
	customChain: Record<string, string[]> | undefined,
): Record<string, string[]> {
	const normalized: Record<string, string[]> = {};
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

function isUnsupportedCodexModelForChatGpt(status: number, bodyText: string): boolean {
	if (status !== HTTP_STATUS.BAD_REQUEST) return false;
	if (!bodyText) return false;
	return CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN.test(bodyText);
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
				? CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN.test(directDetail)
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
		(message ? CHATGPT_CODEX_UNSUPPORTED_MODEL_PATTERN.test(message) : false);

	return {
		isUnsupported,
		code,
		message,
		unsupportedModel: unsupportedModel ?? undefined,
	};
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

	const chain = normalizeFallbackChain(options.customChain);
	const targets = chain[currentModel] ?? [];
	if (targets.length === 0) return undefined;

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
 * account — otherwise persisted family routing keeps pinning every request to
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
 * @returns True if token is expired or invalid
 */
export function shouldRefreshToken(auth: Auth, skewMs = 0): boolean {
	if (auth.type !== "oauth") return true;
	if (!auth.access) return true;

	const safeSkewMs = Math.max(0, Math.floor(skewMs));
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
	client: OpencodeClient,
): Promise<OAuthAuthDetails> {
	const refreshToken = currentAuth.refresh;
	const refreshResult = await queuedRefresh(refreshToken);

	if (refreshResult.type === "failed") {
		// Distinguish transient failures (network blip / upstream 5xx) from
		// genuine auth invalidation. Transient failures must NOT count toward
		// permanent account removal — the credentials are still valid.
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

	await client.auth.set({
		path: { id: "openai" },
		body: {
			type: "oauth",
			access: refreshResult.access,
			refresh: refreshResult.refresh,
			expires: refreshResult.expires,
			scope: nextScope,
			multiAccount: true,
		} as Parameters<typeof client.auth.set>[0]["body"],
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
	const rewrittenPath = parsedUrl.pathname.includes(URL_PATHS.RESPONSES)
		? parsedUrl.pathname.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES)
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
 * @returns Transformed body and updated init, or undefined if no body
 */
export async function transformRequestForCodex(
	init: RequestInit | undefined,
	url: string,
	userConfig: UserConfig,
	codexMode = true,
	parsedBody?: Record<string, unknown>,
	options?: {
		requestTransformMode?: "native" | "legacy";
		fastSession?: boolean;
		fastSessionStrategy?: "hybrid" | "always";
		fastSessionMaxInputItems?: number;
	},
): Promise<{ body: RequestBody; updatedInit: RequestInit } | undefined> {
	const hasParsedBody =
		parsedBody !== undefined &&
		parsedBody !== null &&
		typeof parsedBody === "object" &&
		Object.keys(parsedBody).length > 0;
	if (!init?.body && !hasParsedBody) return undefined;

	try {
		// Use pre-parsed body if provided, otherwise parse from init.body
		let body: RequestBody;
		if (hasParsedBody) {
			body = parsedBody as RequestBody;
		} else {
			if (typeof init?.body !== "string") return undefined;
			body = JSON.parse(init.body) as RequestBody;
		}
		const originalModel = body.model;
		const requestTransformMode = options?.requestTransformMode ?? "legacy";

		if (requestTransformMode === "native") {
			logRequest(LOG_STAGES.BEFORE_TRANSFORM, {
				url,
				originalModel,
				model: originalModel,
				hasTools: !!body.tools,
				hasInput: !!body.input,
				inputLength: body.input?.length,
				requestTransformMode,
				body: body as unknown as Record<string, unknown>,
			});

			const normalizedModel = normalizeModel(originalModel);
			body.model = normalizedModel;
			body.instructions = ensureInstructionIdentity(
				body.instructions,
				normalizedModel,
			);
			body.input = upsertBackendModelIdentityMessage(body.input, normalizedModel);

			logRequest(LOG_STAGES.AFTER_TRANSFORM, {
				url,
				originalModel,
				normalizedModel,
				hasTools: !!body.tools,
				hasInput: !!body.input,
				inputLength: body.input?.length,
				requestTransformMode,
				body: body as unknown as Record<string, unknown>,
			});

			// `body` stays classic; lite is a serialize-time view (see shapeBodyForModel).
			return {
				body,
				updatedInit: {
					...(init ?? {}),
					body: JSON.stringify(shapeBodyForModel(body)),
				},
			};
		}

		// Normalize model first to determine which instructions to fetch
		// This ensures we get the correct model-specific prompt
		const normalizedModel = normalizeModel(originalModel);
		const modelFamily = getModelFamily(normalizedModel);

		// Log original request
		logRequest(LOG_STAGES.BEFORE_TRANSFORM, {
			url,
			originalModel,
			model: body.model,
			hasTools: !!body.tools,
			hasInput: !!body.input,
			inputLength: body.input?.length,
			codexMode,
			requestTransformMode,
			body: body as unknown as Record<string, unknown>,
		});

		// Fetch model-specific Codex instructions (cached per model family)
		const codexInstructions = await getCodexInstructions(normalizedModel);

		// Transform request body
		const transformedBody = await transformRequestBody(
			body,
			codexInstructions,
			userConfig,
			codexMode,
			options?.fastSession ?? false,
			options?.fastSessionStrategy ?? "hybrid",
			options?.fastSessionMaxInputItems ?? 30,
		);

		// Log transformed request
		logRequest(LOG_STAGES.AFTER_TRANSFORM, {
			url,
			originalModel,
			normalizedModel: transformedBody.model,
			modelFamily,
			hasTools: !!transformedBody.tools,
			hasInput: !!transformedBody.input,
			inputLength: transformedBody.input?.length,
			reasoning: transformedBody.reasoning as unknown,
			textVerbosity: transformedBody.text?.verbosity,
			include: transformedBody.include,
			requestTransformMode,
			body: transformedBody as unknown as Record<string, unknown>,
		});

			// `transformedBody` stays classic so the unsupported-model fallback can
			// re-serialize it for a non-lite model. Lite shaping happens here, per
			// attempt, against the model actually being sent.
			return {
				body: transformedBody,
				updatedInit: {
					...(init ?? {}),
					body: JSON.stringify(shapeBodyForModel(transformedBody)),
				},
			};
	} catch (e) {
		logError(`${ERROR_MESSAGES.REQUEST_PARSE_ERROR}`, e);
		return undefined;
	}
}

/**
 * Creates headers for Codex API requests
 * @param init - Request init options
 * @param accountId - ChatGPT account ID
 * @param accessToken - OAuth access token
 * @param opts - Optional parameters including model, promptCacheKey, and organizationId
 * @returns Headers object with all required Codex headers
 */
export function createCodexHeaders(
    init: RequestInit | undefined,
    accountId: string,
    accessToken: string,
    opts?: { model?: string; promptCacheKey?: string; organizationId?: string },
): Headers {
	const headers = new Headers(init?.headers ?? {});
	headers.delete("x-api-key"); // Remove any existing API key
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);

	// GPT-5.6 models are served over the responses-lite path.
	if (usesResponsesLite(opts?.model)) {
		headers.set(RESPONSES_LITE_HEADER, RESPONSES_LITE_HEADER_VALUE);
	} else {
		headers.delete(RESPONSES_LITE_HEADER);
	}

	// The backend reads the client version from the User-Agent product token
	// and gates preview tiers on the catalog's `minimal_client_version`
	// (0.144.0 for gpt-5.6-*). The host runtime's UA fails that gate even
	// though we already declare `originator: codex_cli_rs`, so send the Codex
	// CLI identity the originator claims (#196).
	if (process.env.CODEX_AUTH_DISABLE_CODEX_USER_AGENT !== "1") {
		headers.set("user-agent", buildCodexUserAgent());
	}

    const cacheKey = opts?.promptCacheKey;
    if (cacheKey) {
        headers.set(OPENAI_HEADERS.CONVERSATION_ID, cacheKey);
        headers.set(OPENAI_HEADERS.SESSION_ID, cacheKey);
    } else {
        headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
        headers.delete(OPENAI_HEADERS.SESSION_ID);
    }

    // Upstream Codex never sends `openai-organization` on ChatGPT-Codex
    // requests — workspace routing is carried entirely by `chatgpt-account-id`.
    // Pinning an org can shift the backend's entitlement evaluation to a
    // workspace outside a limited preview and 400 an otherwise-entitled
    // account (gpt-5.6-sol, #196). Legacy behavior stays opt-in for multi-org
    // setups that relied on it.
    const organizationId = opts?.organizationId;
    if (
        organizationId &&
        process.env.CODEX_AUTH_SEND_ORGANIZATION_HEADER === "1"
    ) {
        headers.set(OPENAI_HEADERS.ORGANIZATION_ID, organizationId);
    } else {
        headers.delete(OPENAI_HEADERS.ORGANIZATION_ID);
    }

    headers.set("accept", "text/event-stream");
    return headers;
}

/**
 * Handles error responses from the Codex API
 * @param response - Error response from API
 * @returns Original response or mapped retryable response
 */
export async function handleErrorResponse(
        response: Response,
        options?: ErrorHandlingOptions,
): Promise<ErrorHandlingResult> {
        const bodyText = await safeReadBody(response);
        const mapped = mapUsageLimit404WithBody(response, bodyText);
        
        // Entitlement errors return a ready-to-use Response with 403 status
        if (mapped && mapped.status === HTTP_STATUS.FORBIDDEN) {
                return { response: mapped, rateLimit: undefined, errorBody: undefined };
        }
        
        const finalResponse = mapped ?? response;
        const rateLimit = extractRateLimitInfoFromBody(finalResponse, bodyText);

        let errorBody: unknown;
        try {
                errorBody = bodyText ? JSON.parse(bodyText) : undefined;
        } catch {
                errorBody = { message: bodyText };
        }

        const diagnostics = extractErrorDiagnostics(finalResponse, options);
        const normalizedError = normalizeErrorPayload(
                errorBody,
                bodyText,
                finalResponse.statusText,
                finalResponse.status,
                diagnostics,
        );
        const errorResponse = ensureJsonErrorResponse(finalResponse, normalizedError);
        const retryAsServerError = isServerOverloadedError(normalizedError);

        if (finalResponse.status === HTTP_STATUS.UNAUTHORIZED) {
                logWarn("Codex upstream returned 401 Unauthorized", diagnostics);
        }

        logRequest(LOG_STAGES.ERROR_RESPONSE, {
                status: finalResponse.status,
                statusText: finalResponse.statusText,
                diagnostics,
        });

        return {
		response: errorResponse,
		rateLimit,
		errorBody: normalizedError,
		retryAsServerError,
	};
}

/**
 * Handles successful responses from the Codex API
 * Converts SSE to JSON for non-streaming requests (generateText)
 * Passes through SSE for streaming requests (streamText)
 * @param response - Success response from API
 * @param isStreaming - Whether this is a streaming request (stream=true in body)
 * @returns Processed response (SSE→JSON for non-streaming, stream for streaming)
 */
export async function handleSuccessResponse(
    response: Response,
    isStreaming: boolean,
    options?: { streamStallTimeoutMs?: number },
): Promise<Response> {
    // Check for deprecation headers (RFC 8594)
    const deprecation = response.headers.get("Deprecation");
    const sunset = response.headers.get("Sunset");
    if (deprecation || sunset) {
        logWarn(`API deprecation notice`, { deprecation, sunset });
    }

    const responseHeaders = ensureContentType(response.headers);

	// For non-streaming requests (generateText), convert SSE to JSON
	if (!isStreaming) {
		return await convertSseToJson(response, responseHeaders, options);
	}

	// For streaming requests (streamText), return stream as-is
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders,
	});
}

async function safeReadBody(response: Response): Promise<string> {
        try {
                return await response.clone().text();
        } catch {
                return "";
        }
}

function mapUsageLimit404WithBody(response: Response, bodyText: string): Response | null {
        if (response.status !== HTTP_STATUS.NOT_FOUND) return null;
        if (!bodyText) return null;

	let code = "";
	try {
		const parsed = JSON.parse(bodyText) as { error?: { code?: string | number; type?: string } };
		code = (parsed?.error?.code ?? parsed?.error?.type ?? "").toString();
	} catch {
		code = "";
	}

	// Check for entitlement errors first - these should NOT be treated as rate limits
	if (isEntitlementError(code, bodyText)) {
		return createEntitlementErrorResponse(bodyText);
	}

	const haystack = `${code} ${bodyText}`.toLowerCase();
	if (!/usage_limit_reached|rate_limit_exceeded|usage limit/i.test(haystack)) {
		return null;
	}

        const headers = new Headers(response.headers);
        return new Response(bodyText, {
                status: HTTP_STATUS.TOO_MANY_REQUESTS,
                statusText: "Too Many Requests",
                headers,
        });
}

function extractRateLimitInfoFromBody(
        response: Response,
        bodyText: string,
): RateLimitInfo | undefined {
        const isStatusRateLimit =
                response.status === HTTP_STATUS.TOO_MANY_REQUESTS;
        const parsedErrorBody = parseStructuredErrorBody(bodyText);
        const parsed = parseRateLimitBody(parsedErrorBody);
        const isServerOverload = isServerOverloadedError(parsedErrorBody);

        if (isServerOverload && !isStatusRateLimit) {
                return undefined;
        }

        const haystack = `${parsed?.code ?? ""} ${bodyText}`.toLowerCase();
        
        // Entitlement errors should not be treated as rate limits
        if (isEntitlementError(parsed?.code ?? "", bodyText)) {
                return undefined;
        }
        
        const isRateLimit =
                isStatusRateLimit ||
                isServerOverload ||
                /usage_limit_reached|rate_limit_exceeded|rate_limit|usage limit/i.test(
                        haystack,
                );
        if (!isRateLimit) return undefined;

        const retryAfterMs =
                parseRetryAfterMs(response, parsed) ?? 60000;

        return { retryAfterMs, code: parsed?.code };
}

interface RateLimitErrorBody {
	error?: {
		code?: string | number;
		type?: string;
		context?: {
			type?: string;
		};
		resets_at?: number;
		reset_at?: number;
		retry_after_ms?: number;
		retry_after?: number;
	};
}

function parseRateLimitBody(
	parsedBody: RateLimitErrorBody | undefined,
): { code?: string; type?: string; contextType?: string; resetsAt?: number; retryAfterMs?: number } | undefined {
	if (!parsedBody) return undefined;
	const error = parsedBody.error ?? {};
	const code = (error.code ?? error.type ?? "").toString();
	const type = typeof error.type === "string" ? error.type : undefined;
	const contextType = typeof error.context?.type === "string" ? error.context.type : undefined;
	const resetsAt = toNumber(error.resets_at ?? error.reset_at);
	// `retry_after_ms` is milliseconds; `retry_after` is seconds. Keep their
	// scales distinct: collapsing them and feeding the result through
	// normalizeRetryAfter's <1000 "looks like seconds" heuristic turned a
	// sub-second `retry_after_ms` (e.g. 500) into a multi-minute backoff.
	const retryAfterMsRaw = toNumber(error.retry_after_ms);
	const retryAfterSeconds = toNumber(error.retry_after);
	const retryAfterMs =
		retryAfterMsRaw !== undefined
			? retryAfterMsRaw
			: retryAfterSeconds !== undefined
				? retryAfterSeconds * 1000
				: undefined;
	return { code, type, contextType, resetsAt, retryAfterMs };
}

function parseStructuredErrorBody(body: string): RateLimitErrorBody | undefined {
	if (!body) return undefined;
	try {
		return JSON.parse(body) as RateLimitErrorBody;
	} catch {
		return undefined;
	}
}

type ErrorPayload = {
        error: {
                message: string;
                type?: string;
                code?: string | number;
                context?: {
                        type?: string;
                };
                unsupported_model?: string;
                diagnostics?: ErrorDiagnostics;
        };
};

function normalizeErrorPayload(
        errorBody: unknown,
        bodyText: string,
        statusText: string,
        status: number,
        diagnostics?: ErrorDiagnostics,
): ErrorPayload {
	if (isDeactivatedWorkspaceError(errorBody, status)) {
		const payload: ErrorPayload = {
			error: {
				message:
					"The selected ChatGPT workspace is deactivated. This workspace entry should be removed from rotation or re-authorized before retrying.",
				type: "workspace_deactivated",
				code: DEACTIVATED_WORKSPACE_ERROR_CODE,
			},
		};
		if (diagnostics && Object.keys(diagnostics).length > 0) {
			payload.error.diagnostics = diagnostics;
		}
		return payload;
	}

        if (isUnsupportedCodexModelForChatGpt(status, bodyText)) {
                const unsupportedModel =
			extractUnsupportedCodexModelFromText(bodyText) ?? "requested model";
				const payload: ErrorPayload = {
						error: {
								message:
										`The model '${unsupportedModel}' is not currently available for this ChatGPT account when using Codex OAuth. ` +
										"This is an account/workspace entitlement gate, not a temporary rate limit. " +
										"Default gpt-5.6 tiers, gpt-5.5, and gpt-5-codex selectors auto-degrade down their fallback chains " +
										"(opt out via CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK/GPT55/CODEX=1). " +
										"Try 'gpt-5.5' (latest general), 'gpt-5-codex' (canonical), or legacy aliases like 'gpt-5.3-codex'/'gpt-5.2-codex', or enable automatic fallback via " +
										'unsupportedCodexPolicy: "fallback" (or CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback). ' +
										"(Legacy: CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=1 or fallbackOnUnsupportedCodexModel).",
								type: "entitlement_error",
								code: CHATGPT_CODEX_UNSUPPORTED_MODEL_CODE,
								unsupported_model: unsupportedModel,
						},
				};
                if (diagnostics && Object.keys(diagnostics).length > 0) {
                        payload.error.diagnostics = diagnostics;
                }
                return payload;
        }

        if (isRecord(errorBody)) {
                const maybeError = errorBody.error;
                if (isRecord(maybeError) && typeof maybeError.message === "string") {
                        const payload: ErrorPayload = {
                                error: {
                                        message: maybeError.message,
                                },
                        };
                        if (typeof maybeError.type === "string") {
                                payload.error.type = maybeError.type;
                        }
                        if (typeof maybeError.code === "string" || typeof maybeError.code === "number") {
                                payload.error.code = maybeError.code;
                        }
                        if (
                                isRecord(maybeError.context) &&
                                typeof maybeError.context.type === "string"
                        ) {
                                payload.error.context = { type: maybeError.context.type };
                        }
                        if (diagnostics && Object.keys(diagnostics).length > 0) {
                                payload.error.diagnostics = diagnostics;
                        }
                        if (status === HTTP_STATUS.UNAUTHORIZED) {
                                payload.error.message = `${payload.error.message} (run \`opencode auth login\` if this persists)`;
                        }
                        return payload;
                }

                if (typeof errorBody.message === "string") {
                        const payload: ErrorPayload = { error: { message: errorBody.message } };
                        if (diagnostics && Object.keys(diagnostics).length > 0) {
                                payload.error.diagnostics = diagnostics;
                        }
                        if (status === HTTP_STATUS.UNAUTHORIZED) {
                                payload.error.message = `${payload.error.message} (run \`opencode auth login\` if this persists)`;
                        }
                        return payload;
                }
        }

        const trimmed = bodyText.trim();
        if (trimmed) {
                const payload: ErrorPayload = { error: { message: trimmed } };
                if (diagnostics && Object.keys(diagnostics).length > 0) {
                        payload.error.diagnostics = diagnostics;
                }
                if (status === HTTP_STATUS.UNAUTHORIZED) {
                        payload.error.message = `${payload.error.message} (run \`opencode auth login\` if this persists)`;
                }
                return payload;
        }

        if (statusText) {
                const payload: ErrorPayload = { error: { message: statusText } };
                if (diagnostics && Object.keys(diagnostics).length > 0) {
                        payload.error.diagnostics = diagnostics;
                }
                if (status === HTTP_STATUS.UNAUTHORIZED) {
                        payload.error.message = `${payload.error.message} (run \`opencode auth login\` if this persists)`;
                }
                return payload;
        }

        const payload: ErrorPayload = { error: { message: "Request failed" } };
        if (diagnostics && Object.keys(diagnostics).length > 0) {
                payload.error.diagnostics = diagnostics;
        }
        if (status === HTTP_STATUS.UNAUTHORIZED) {
                payload.error.message = `${payload.error.message} (run \`opencode auth login\` if this persists)`;
        }
        return payload;
}

function ensureJsonErrorResponse(response: Response, payload: ErrorPayload): Response {
        const headers = new Headers(response.headers);
        headers.set("content-type", "application/json; charset=utf-8");
        return new Response(JSON.stringify(payload), {
                status: response.status,
                statusText: response.statusText,
                headers,
	});
}

function parseRetryAfterMs(
        response: Response,
        parsedBody?: { resetsAt?: number; retryAfterMs?: number },
): number | null {
        if (parsedBody?.retryAfterMs !== undefined) {
                // Already normalized to milliseconds in parseRateLimitBody (ms field
                // used verbatim, seconds field converted via *1000). Do NOT pass
                // through a <1000 "looks like seconds" heuristic, which would
                // mis-scale a genuine sub-second value into minutes. Cap at 5 min.
                const ms = parsedBody.retryAfterMs;
                if (Number.isFinite(ms) && ms > 0) {
                        return Math.min(Math.floor(ms), MAX_RETRY_DELAY_MS);
                }
        }

        // The header paths mirror the body fields above and get the same 5-min
        // cap: an oversized or bogus `retry-after` must not freeze an account
        // far past the cap the body path enforces. The reset-at paths below are
        // deliberately uncapped — quota windows legitimately reset hours out.
        const retryAfterMsHeader = response.headers.get("retry-after-ms");
        if (retryAfterMsHeader) {
                const parsed = Number.parseInt(retryAfterMsHeader, 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                        return Math.min(parsed, MAX_RETRY_DELAY_MS);
                }
        }

        const retryAfterHeader = response.headers.get("retry-after");
        if (retryAfterHeader) {
                const parsed = Number.parseInt(retryAfterHeader, 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                        return Math.min(parsed * 1000, MAX_RETRY_DELAY_MS);
                }
        }

        const resetAtHeaders = [
                "x-codex-primary-reset-at",
                "x-codex-secondary-reset-at",
                "x-ratelimit-reset",
        ];
        const now = Date.now();
        const resetCandidates: number[] = [];
        for (const header of resetAtHeaders) {
                const value = response.headers.get(header);
                if (!value) continue;
                const parsed = Number.parseInt(value, 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                        const timestamp =
                                parsed < 10_000_000_000 ? parsed * 1000 : parsed;
                        const delta = timestamp - now;
                        if (delta > 0) resetCandidates.push(delta);
                }
        }

        if (parsedBody?.resetsAt) {
                const timestamp =
                        parsedBody.resetsAt < 10_000_000_000
                                ? parsedBody.resetsAt * 1000
                                : parsedBody.resetsAt;
                const delta = timestamp - now;
                if (delta > 0) resetCandidates.push(delta);
        }

        if (resetCandidates.length > 0) {
                return Math.min(...resetCandidates);
        }

        return null;
}

const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

function toNumber(value: unknown): number | undefined {
        if (value === null || value === undefined) return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
}

function extractErrorDiagnostics(
        response: Response,
        options?: ErrorHandlingOptions,
): ErrorDiagnostics | undefined {
        const requestId =
                response.headers.get("x-request-id") ??
                response.headers.get("request-id") ??
                response.headers.get("openai-request-id") ??
                response.headers.get("x-openai-request-id") ??
                undefined;
        const cfRay = response.headers.get("cf-ray") ?? undefined;

        const diagnostics: ErrorDiagnostics = {
                httpStatus: response.status,
                requestId,
                cfRay,
                correlationId: options?.requestCorrelationId,
                threadId: options?.threadId,
        };

        for (const [key, value] of Object.entries(diagnostics)) {
                if (value === undefined || value === "") {
                        delete diagnostics[key as keyof ErrorDiagnostics];
                }
        }

        return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

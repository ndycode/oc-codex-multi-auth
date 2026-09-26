/**
 * OpenAI ChatGPT (Codex) OAuth Authentication Plugin for opencode
 *
 * COMPLIANCE NOTICE:
 * This plugin uses OpenAI's official OAuth authentication flow (the same method
 * used by OpenAI's official Codex CLI at https://github.com/openai/codex).
 *
 * INTENDED USE: Personal development and coding assistance with your own
 * ChatGPT Plus/Pro subscription.
 *
 * NOT INTENDED FOR: Commercial resale, multi-user services, high-volume
 * automated extraction, or any use that violates OpenAI's Terms of Service.
 *
 * Users are responsible for ensuring their usage complies with:
 * - OpenAI Terms of Use: https://openai.com/policies/terms-of-use/
 * - OpenAI Usage Policies: https://openai.com/policies/usage-policies/
 *
 * For production applications, use the OpenAI Platform API: https://platform.openai.com/
 *
 * @license MIT (see LICENSE file)
 * @author ndycode
 * @repository https://github.com/ndycode/oc-codex-multi-auth

 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { watchFile, unwatchFile } from "node:fs";
import { consumeLastWrittenAccountsDigest } from "./lib/storage/load-save.js";
import { subscribeToStoragePathChanges } from "./lib/storage/state.js";
import { isKeychainOptInEnabled } from "./lib/storage/keychain.js";
import { AnyAccountStorageSchema } from "./lib/schemas.js";
import { registerCleanup, unregisterCleanup } from "./lib/shutdown.js";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import {
        type AuthorizationInputParseResult,
        createAuthorizationFlow,
        exchangeAuthorizationCode,
        parseAuthorizationInput,
        REDIRECT_URI,
} from "./lib/auth/auth.js";
import { formatPlanType } from "./lib/auth/plan-tier.js";
import {
	startLoopbackFlow,
	type LoopbackFlowUnavailable,
} from "./lib/auth/loopback-flow.js";
import {
	buildDeviceCodeInstructions,
	completeDeviceCodeSession,
	createDeviceCodeSession,
} from "./lib/auth/device-code.js";
import {
	applyAccountSelectionFallbacks,
	persistResolvedAccountSelection,
	persistAccountPool,
	resolveAndPersistAccountSelection,
	resolveAccountSelection,
	type AccountSelectionResult,
	type TokenSuccessWithAccount,
} from "./lib/auth/login-runner.js";
import {
	coordinateFlaggedPersistedRefresh,
	coordinatePersistedRefresh,
} from "./lib/storage/coordinated-refresh.js";
import { promptAddAnotherAccount, promptLoginMode } from "./lib/cli.js";
import {
	getCodexMode,
	getRequestTransformMode,
	getFastSession,
	getFastSessionStrategy,
	getFastSessionMaxInputItems,
	getRetryProfile,
	getRetryBudgetOverrides,
	getRateLimitToastDebounceMs,
	getRetryAllAccountsMaxRetries,
	getRetryAllAccountsMaxWaitMs,
	getRetryAllAccountsRateLimited,
	getFallbackToGpt52OnUnsupportedGpt53,
	getUnsupportedCodexPolicy,
	getUnsupportedCodexFallbackChain,
	getTokenRefreshSkewMs,
	getSessionRecovery,
	getAutoResume,
	getAutoUpdate,
	getToastDurationMs,
	getAccountToastsEnabled,
	getPerProjectAccounts,
	getEmptyResponseMaxRetries,
	getEmptyResponseRetryDelayMs,
	getPidOffsetEnabled,
	getRotationStrategy,
	getModelAccountPool,
	getModelAccountPoolMode,
	getFetchTimeoutMs,
	getStreamStallTimeoutMs,
	getCodexTuiV2,
	getCodexTuiColorProfile,
	getCodexTuiGlyphMode,
	getBeginnerSafeMode,
	getCodexTuiMaskEmail,
	getQuotaDisplay,
	loadPluginConfig,
} from "./lib/config.js";
import {
        AUTH_LABELS,
        CODEX_BASE_URL,
        DUMMY_API_KEY,
        LOG_STAGES,
        PLUGIN_NAME,
        PROVIDER_ID,
        ACCOUNT_LIMITS,
        MAX_QUOTA_FALLBACK_SWITCHES,
} from "./lib/constants.js";
import {
	initLogger,
	logRequest,
	logDebug,
	logInfo,
	logWarn,
	logError,
	setCorrelationId,
	clearCorrelationId,
} from "./lib/logger.js";
import { createQuotaMonitor } from "./lib/quota-notifications.js";
import { checkAndNotify } from "./lib/auto-update-checker.js";
import { describePluginOrigin, getPluginOrigin, recordPluginOrigin } from "./lib/plugin-origin.js";
import { handleContextOverflow } from "./lib/context-overflow.js";
import {
	AccountManager,
	type AccountSelectionExplainability,
	type ManagedAccount,
        extractAccountEmail,
        extractAccountId,
        formatAccountLabel,
        formatWaitTime,
        sanitizeEmail,
        shouldUpdateAccountIdFromToken,
        resolveRequestAccountId,
        parseRateLimitReason,
	lookupCodexCliTokensByEmail,
} from "./lib/accounts.js";
import {
	getModelPoolAccountKey,
	matchesModelPoolAccountKey,
	type ModelPoolAccount,
} from "./lib/accounts/pool-identity.js";
import {
	formatSeatSuffix,
	maskIdentityValue,
	resolveDisplayEmail,
	seatIsDisclosable,
} from "./lib/account-display.js";
import { extractAccountUserId } from "./lib/auth/token-utils.js";
import { CodexAuthError } from "./lib/errors.js";
import {
	getStoragePath,
	loadAccounts,
	withAccountStorageTransaction,
	clearAccounts,
	setStoragePath,
	loadFlaggedAccounts,
	withFlaggedAccountStorageTransaction,
	clearFlaggedAccounts,
	StorageError,
	formatStorageErrorHint,
	type AccountStorageV3,
	type FlaggedAccountMetadataV1,
} from "./lib/storage.js";
import { getWorkspaceIdentityKey } from "./lib/storage/identity.js";
import {
	createCodexHeaders,
	extractRequestUrl,
        handleErrorResponse,
        handleSuccessResponse,
	isDeactivatedWorkspaceError,
	isInvalidatedAuthTokenError,
	createAbortError,
	getUnsupportedCodexModelInfo,
	resolveUnsupportedCodexFallbackModel,
	isDefaultAutoFallbackModel,
	pickFallbackChainTarget,
        refreshAndUpdateToken,
        rewriteUrlForCodex,
	shouldRefreshToken,
	transformRequestForCodex,
} from "./lib/request/fetch-helpers.js";
import { shapeBodyForModel } from "./lib/request/helpers/responses-lite.js";
import {
	DEACTIVATED_WORKSPACE_ERROR_CODE,
	isDeactivatedWorkspaceErrorMessage,
	isInvalidatedAuthTokenMessage,
} from "./lib/error-sentinels.js";
import {
	applyFastSessionDefaults,
	clampReasoningForModel,
	upsertBackendModelIdentityMessage,
} from "./lib/request/request-transformer.js";
import {
	getRateLimitBackoff,
	RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS,
	resetRateLimitBackoff,
} from "./lib/request/rate-limit-backoff.js";
import { isEmptyResponse } from "./lib/request/response-handler.js";
import { getCircuitBreaker } from "./lib/circuit-breaker.js";
import {
	RetryBudgetTracker,
	resolveRetryBudgetLimits,
	type RetryBudgetClass,
} from "./lib/request/retry-budget.js";
import { addJitter } from "./lib/rotation.js";
import { setUiRuntimeOptions, type UiRuntimeOptions } from "./lib/ui/runtime.js";
import { formatUiBadge, formatUiHeader, formatUiItem, formatUiKeyValue, formatUiSection } from "./lib/ui/format.js";
import {
	buildBeginnerChecklist,
	recommendBeginnerNextAction,
	summarizeBeginnerAccounts,
	type BeginnerAccountSnapshot,
	type BeginnerDiagnosticSeverity,
	type BeginnerRuntimeSnapshot,
} from "./lib/ui/beginner.js";
import {
	getModelFamily,
	getCodexInstructions,
	MODEL_FAMILIES,
	prewarmCodexInstructions,
	type ModelFamily,
} from "./lib/prompts/codex.js";
import { prewarmOpenCodeCodexPrompt } from "./lib/prompts/opencode-codex.js";
import type {
	OAuthAuthDetails,
	RequestBody,
	TokenResult,
	UserConfig,
} from "./lib/types.js";
import {
	createSessionRecoveryHook,
	isRecoverableError,
	detectErrorType,
	getRecoveryToastContent,
} from "./lib/recovery.js";
import {
	matchesWorkspaceIdentity,
	upsertFlaggedAccountRecord,
	createRetryBudgetUsage,
	serializeSelectionExplainability,
	formatRoutingValue,
	formatExplainabilitySummary,
	type RoutingVisibilitySnapshot,
	type RuntimeMetrics,
} from "./lib/runtime.js";
import {
	createToolRegistry,
	type ToolContext,
} from "./lib/tools/index.js";
import {
	createUsageAccountFingerprint,
	fetchCodexUsage,
	formatUsageLimitSummary,
	formatUsageLimitTitle,
	hasUsageWindow,
	parseCodexUsagePayload,
	type CodexUsageSummary,
} from "./lib/codex-usage.js";
import { getQuotaExhaustedResetAtMs } from "./lib/quota-windows.js";
import {
	clearTuiQuotaSnapshot,
	parseTuiQuotaSnapshotFromHeaders,
	writeTuiQuotaSnapshot,
} from "./lib/tui-quota-cache.js";

/**
 * IPv6 loopback literal. WHATWG URL parsing compresses every equivalent
 * spelling (`0:0:0:0:0:0:0:1` -> `::1`), so only the canonical form is listed.
 */
const LOOPBACK_GATEWAY_HOSTS = new Set(["::1"]);
const IPV4_LITERAL_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/**
 * IPv4-mapped IPv6, which WHATWG serializes in hex rather than dotted form:
 * `::ffff:127.0.0.1` -> `::ffff:7f00:1`, `::ffff:127.1.1.1` -> `::ffff:7f01:101`.
 * The high byte of the first group is the first IPv4 octet.
 */
const IPV4_MAPPED_PATTERN = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/;

/**
 * Cleartext HTTP is only safe for a peer that cannot leave the host, so the check
 * is deliberately restricted to *literal* loopback addresses. Hostnames such as
 * `localhost` are rejected even though they usually resolve to 127.0.0.1: a host
 * file or resolver can point them at a remote peer, which would leak the ChatGPT
 * OAuth access token over the wire.
 *
 * The whole 127.0.0.0/8 range is accepted, not just 127.0.0.1 — running several
 * local services on 127.0.0.2, 127.0.1.1, and friends is a common pattern, and
 * every address in the block is equally unroutable.
 */
function isLoopbackGatewayHost(hostname: string): boolean {
	const ipv4 = IPV4_LITERAL_PATTERN.exec(hostname);
	if (ipv4) {
		const octets = ipv4.slice(1).map((part) => Number(part));
		if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return false;
		return octets[0] === 127;
	}
	const mapped = IPV4_MAPPED_PATTERN.exec(hostname);
	if (mapped?.[1]) {
		// `::ffff:7f00:2` is 127.0.0.2 — just as unroutable as the dotted
		// spelling, so rejecting it would be an inconsistency, not a safeguard.
		return Number.parseInt(mapped[1], 16) >>> 8 === 0x7f;
	}
	return LOOPBACK_GATEWAY_HOSTS.has(hostname);
}

/** Stable per-seat identity used only for in-memory traversal diagnostics. */
function getAccountDiagnosticsKey(account: ManagedAccount): string {
	return JSON.stringify([
		getModelPoolAccountKey(account) ?? "unresolved",
		account.organizationId ?? null,
		account.email ?? null,
		account.addedAt,
	]);
}

/** Configured pool keys matching no live account (typo, or account removed). */
function countUnresolvedPoolKeys(
	accounts: readonly ModelPoolAccount[],
	poolKeys: readonly string[],
): number {
	return poolKeys.filter(
		(key) => !accounts.some((account) => matchesModelPoolAccountKey(account, key)),
	).length;
}

function invalidBaseURL(reason: string): Error {
	return new Error(
		`[oc-codex-multi-auth] OPENAI_BASE_URL is invalid: ${reason}. Fix the value, or unset ` +
			"CODEX_AUTH_ALLOW_OPENAI_BASE_URL to fall back to the default ChatGPT Codex endpoint.",
	);
}

function resolveOpenAIBaseURL(): string | undefined {
	if (process.env.CODEX_AUTH_ALLOW_OPENAI_BASE_URL !== "1") return undefined;
	const raw = process.env.OPENAI_BASE_URL?.trim();
	if (!raw) return undefined;

	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		// `new URL()` throws a bare `TypeError: Invalid URL` that names neither the
		// plugin nor the variable, which is useless when it surfaces out of the
		// auth loader. A scheme-less value such as `gateway.example/v1` is the
		// common way to hit this. The value itself is NOT echoed: it can carry a
		// token in a query string, and this message reaches a toast.
		throw invalidBaseURL(
			"the value is not a valid absolute URL (an explicit https:// or http:// scheme is required)",
		);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw invalidBaseURL("it must use http:// or https://");
	}
	if (parsed.username || parsed.password) {
		throw invalidBaseURL("it must not embed credentials");
	}
	if (parsed.search || parsed.hash || raw.includes("?") || raw.includes("#")) {
		throw invalidBaseURL("it must not include a query string or fragment");
	}
	const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (parsed.protocol === "http:" && !isLoopbackGatewayHost(hostname)) {
		throw invalidBaseURL(
			`https:// is required for non-loopback host "${hostname}" so the ChatGPT OAuth ` +
				"access token is never sent in cleartext",
		);
	}
	return parsed.toString().replace(/\/+$/, "");
}

/**
 * OpenAI Codex OAuth authentication plugin for opencode
 *
 * This plugin enables opencode to use OpenAI's Codex backend via ChatGPT Plus/Pro
 * OAuth authentication, allowing users to leverage their ChatGPT subscription
 * instead of OpenAI Platform API credits.
 *
 * @example
 * ```json
 * {
 *   "plugin": ["oc-codex-multi-auth"],

 *   "model": "openai/gpt-5-codex"
 * }
 * ```
 */
 
export const OpenAIOAuthPlugin: Plugin = async ({ client }: PluginInput) => createPluginRuntime({ client });

/**
 * Shared request/account runtime; V2 has no V1 client or host auth.json.
 *
 * Not exported: V1 hosts call every function this module exports as a plugin,
 * so an exported factory would boot a second runtime beside the real one. The
 * V2 entry receives it through `setup` instead.
 */
async function createPluginRuntime({ client, directory = process.cwd() }: {
	client?: PluginInput["client"];
	directory?: string;
}): Promise<Hooks> {
	initLogger(client ?? {});
	let customBaseURLWarningShown = false;
	let customBaseURLErrorShown = false;
	let cachedAccountManager: AccountManager | null = null;
	let accountManagerPromise: Promise<AccountManager> | null = null;
	let loaderMutex: Promise<void> | null = null;
	let startupPrewarmTriggered = false;
	let startupOriginRecorded = false;
	let startupPreflightShown = false;
	let beginnerSafeModeEnabled = false;
	const MIN_BACKOFF_MS = 100;
	// An all-accounts rate-limit wait can run for days, and the local accounts
	// file is its only wake-up. A quota reset granted server-side leaves that file
	// untouched, so such a wait would be slept straight through. Long waits
	// therefore re-probe upstream: first after a minute, doubling to a quarter
	// hour, so a multi-day sleep costs a handful of usage requests rather than one
	// per countdown tick.
	const UPSTREAM_REPROBE_MIN_WAIT_MS = 60_000;
	const UPSTREAM_REPROBE_FIRST_DELAY_MS = 60_000;
	const UPSTREAM_REPROBE_MAX_DELAY_MS = 15 * 60_000;

	const runtimeMetrics: RuntimeMetrics = {
		startedAt: Date.now(),
		totalRequests: 0,
		successfulRequests: 0,
		failedRequests: 0,
		rateLimitedResponses: 0,
		serverErrors: 0,
		networkErrors: 0,
		authRefreshFailures: 0,
		emptyResponseRetries: 0,
		accountRotations: 0,
		cumulativeLatencyMs: 0,
		retryBudgetExhaustions: 0,
		retryBudgetUsage: createRetryBudgetUsage(),
		retryBudgetLimits: resolveRetryBudgetLimits("balanced"),
		retryProfile: "balanced",
		lastRetryBudgetExhaustedClass: null,
		lastRetryBudgetReason: null,
		lastRequestAt: null,
		lastError: null,
		lastErrorCategory: null,
		promptCacheEnabledRequests: 0,
		promptCacheMissingRequests: 0,
		lastPromptCacheKey: null,
		lastSelectedAccountIndex: null,
		lastQuotaKey: null,
		lastSelectionSnapshot: null,
	};

	const buildRoutingVisibilitySnapshot = (
		options: {
			modelFamily?: ModelFamily | null;
			effectiveModel?: string | null;
			quotaKey?: string | null;
			selectedAccountIndex?: number | null;
			selectionExplainability?: AccountSelectionExplainability[];
		} = {},
	): RoutingVisibilitySnapshot => {
		const snapshot = runtimeMetrics.lastSelectionSnapshot;
		const rawSelectedAccountIndex =
			options.selectedAccountIndex ??
			snapshot?.selectedAccountIndex ??
			runtimeMetrics.lastSelectedAccountIndex;
		return {
			requestedModel: snapshot?.requestedModel ?? null,
			effectiveModel:
				options.effectiveModel ?? snapshot?.effectiveModel ?? snapshot?.model ?? null,
			modelFamily: options.modelFamily ?? snapshot?.family ?? null,
			quotaKey: options.quotaKey ?? snapshot?.quotaKey ?? runtimeMetrics.lastQuotaKey,
			selectedAccountIndex:
				rawSelectedAccountIndex === null || rawSelectedAccountIndex === undefined
					? null
					: rawSelectedAccountIndex + 1,
			zeroBasedSelectedAccountIndex: rawSelectedAccountIndex ?? null,
			lastErrorCategory: runtimeMetrics.lastErrorCategory,
			fallbackApplied: snapshot?.fallbackApplied ?? false,
			fallbackFrom: snapshot?.fallbackFrom ?? null,
			fallbackTo: snapshot?.fallbackTo ?? null,
			fallbackReason: snapshot?.fallbackReason ?? null,
			accountPoolMode: snapshot?.accountPoolMode ?? null,
			configuredAccountPoolSize: snapshot?.configuredAccountPoolSize ?? 0,
			selectionExplainability: serializeSelectionExplainability(
				options.selectionExplainability ?? snapshot?.explainability ?? [],
			),
		};
	};

	const buildJsonAccountIdentity = (
		index: number,
		options: {
			includeSensitive?: boolean;
			account?: {
				email?: string;
				accountId?: string;
				accountUserId?: string;
				accountLabel?: string;
				accountTags?: string[];
				accountNote?: string;
			};
			label?: string;
			peerAccounts?: readonly ({ accountUserId?: string } | undefined)[];
		} = {},
	): Record<string, unknown> => {
		const includeSensitive = options.includeSensitive ?? false;
		const accountUserId = options.account?.accountUserId?.trim() || undefined;
		return {
			index: index + 1,
			zeroBasedIndex: index,
			...(includeSensitive
				? {
						label:
							options.label ??
							formatCommandAccountLabel(options.account, index, {
								peerAccounts: options.peerAccounts,
							}),
						email: options.account?.email ?? null,
						accountId: options.account?.accountId ?? null,
					}
				: {}),
			// Members of one Business workspace share `accountId`, so the seat is
			// the field a JSON consumer can tell them apart by. It rides in both
			// modes - the member id masked when sensitive output is off, and the
			// suffix withheld when the id is too short to excerpt without
			// disclosing it - under the same field names the standalone CLI emits.
			accountUserId: maskIdentityValue(accountUserId, includeSensitive) ?? null,
			seatSuffix: seatIsDisclosable(accountUserId, includeSensitive)
				? (formatSeatSuffix(
						accountUserId,
						options.peerAccounts?.map((peer) => peer?.accountUserId),
					) ?? null)
				: null,
		};
	};

	const appendRoutingVisibilityText = (
		lines: string[],
		routing: RoutingVisibilitySnapshot,
		options: { includeExplainability?: boolean } = {},
	): void => {
		lines.push("Routing visibility:");
		lines.push(`  Requested model: ${formatRoutingValue(routing.requestedModel)}`);
		lines.push(`  Effective model: ${formatRoutingValue(routing.effectiveModel)}`);
		lines.push(`  Model family: ${formatRoutingValue(routing.modelFamily)}`);
		lines.push(`  Quota key: ${formatRoutingValue(routing.quotaKey)}`);
		lines.push(
			`  Selected account: ${
				routing.selectedAccountIndex === null
					? "-"
					: String(routing.selectedAccountIndex)
			}`,
		);
		lines.push(
			`  Last error category: ${formatRoutingValue(routing.lastErrorCategory)}`,
		);
		lines.push(`  Fallback applied: ${formatRoutingValue(routing.fallbackApplied)}`);
		lines.push(`  Fallback from: ${formatRoutingValue(routing.fallbackFrom)}`);
		lines.push(`  Fallback to: ${formatRoutingValue(routing.fallbackTo)}`);
		lines.push(`  Fallback reason: ${formatRoutingValue(routing.fallbackReason)}`);
		lines.push(`  Account pool: ${formatRoutingValue(routing.accountPoolMode)}`);
		lines.push(`  Configured pool size: ${routing.configuredAccountPoolSize}`);
		if (options.includeExplainability) {
			lines.push("  Selection explainability:");
			if (routing.selectionExplainability.length === 0) {
				lines.push("    - none");
			} else {
				for (const entry of routing.selectionExplainability) {
					lines.push(`    - ${formatExplainabilitySummary(entry)}`);
				}
			}
		}
	};

	const appendRoutingVisibilityUi = (
		ui: UiRuntimeOptions,
		lines: string[],
		routing: RoutingVisibilitySnapshot,
		options: { includeExplainability?: boolean } = {},
	): void => {
		lines.push(...formatUiSection(ui, "Routing visibility"));
		lines.push(
			formatUiKeyValue(
				ui,
				"Requested model",
				formatRoutingValue(routing.requestedModel),
				"muted",
			),
		);
		lines.push(
			formatUiKeyValue(
				ui,
				"Effective model",
				formatRoutingValue(routing.effectiveModel),
				"muted",
			),
		);
		lines.push(
			formatUiKeyValue(
				ui,
				"Model family",
				formatRoutingValue(routing.modelFamily),
				"muted",
			),
		);
		lines.push(
			formatUiKeyValue(ui, "Quota key", formatRoutingValue(routing.quotaKey), "muted"),
		);
		lines.push(
			formatUiKeyValue(
				ui,
				"Selected account",
				routing.selectedAccountIndex === null
					? "-"
					: String(routing.selectedAccountIndex),
				routing.selectedAccountIndex === null ? "muted" : "accent",
			),
		);
		lines.push(
			formatUiKeyValue(
				ui,
				"Last error category",
				formatRoutingValue(routing.lastErrorCategory),
				routing.lastErrorCategory ? "warning" : "muted",
			),
		);
		lines.push(
			formatUiKeyValue(
				ui,
				"Fallback applied",
				formatRoutingValue(routing.fallbackApplied),
				routing.fallbackApplied ? "accent" : "muted",
			),
		);
		lines.push(
			formatUiKeyValue(
				ui,
				"Fallback from",
				formatRoutingValue(routing.fallbackFrom),
				"muted",
			),
		);
		lines.push(
			formatUiKeyValue(
				ui,
				"Fallback to",
				formatRoutingValue(routing.fallbackTo),
				"muted",
			),
		);
		lines.push(
			formatUiKeyValue(
				ui,
				"Fallback reason",
				formatRoutingValue(routing.fallbackReason),
				routing.fallbackReason ? "warning" : "muted",
			),
		);
		lines.push(
			formatUiKeyValue(
				ui,
				"Account pool",
				formatRoutingValue(routing.accountPoolMode),
				routing.accountPoolMode === "general-fallback" ||
					routing.accountPoolMode === "strict-unavailable"
					? "warning"
					: "muted",
			),
		);
		lines.push(
			formatUiKeyValue(
				ui,
				"Configured pool size",
				String(routing.configuredAccountPoolSize),
				"muted",
			),
		);
		if (options.includeExplainability) {
			lines.push("");
			lines.push(...formatUiSection(ui, "Selection explainability"));
			if (routing.selectionExplainability.length === 0) {
				lines.push(formatUiItem(ui, "none", "muted"));
			} else {
				for (const entry of routing.selectionExplainability) {
					lines.push(formatUiItem(ui, formatExplainabilitySummary(entry)));
				}
			}
		}
	};

		const listenerUnavailableMessage = (): string =>
			`OAuth callback server failed to start on localhost loopback port 1455. ` +
			`Retry with "${AUTH_LABELS.OAUTH_DEVICE_CODE}" or "${AUTH_LABELS.OAUTH_MANUAL}".`;

		const callbackCancelledMessage = (): string =>
			`OAuth callback timed out or was cancelled. ` +
			`If you are on SSH, WSL, or a headless machine, retry with "${AUTH_LABELS.OAUTH_DEVICE_CODE}" or "${AUTH_LABELS.OAUTH_MANUAL}".`;

		// The login is still live when this fires: the listener is bound and
		// waiting, so opening the URL printed above finishes it. That is the
		// whole recovery path on a host with no opener on PATH.
		const browserOpenFailedMessage = (): string =>
			`Could not launch your default browser. Open the OAuth URL above in any browser to finish signing in; ` +
			`this login is still waiting on the localhost callback. ` +
			`"${AUTH_LABELS.OAUTH_MANUAL_BROWSER}" does the same thing without trying to launch a browser, ` +
			`and "${AUTH_LABELS.OAUTH_DEVICE_CODE}" or "${AUTH_LABELS.OAUTH_MANUAL}" avoid the callback entirely.`;

		const unavailableMessage = (
			lifecycle: LoopbackFlowUnavailable["lifecycle"],
		): string => {
			switch (lifecycle) {
				case "listener_unavailable":
					return listenerUnavailableMessage();
				default: {
					const unreachable: never = lifecycle;
					return unreachable;
				}
			}
		};

		/**
		 * Every accepted paste must carry this attempt's `state`, a raw code
		 * included.
		 *
		 * That comparison is the manual flow's only in-plugin binding between
		 * the pasted value and this login. Accepting a bare code delegates the
		 * binding entirely to the authorization server's PKCE enforcement, and
		 * hands anything a user is talked into pasting to
		 * `exchangeAuthorizationCode` with this attempt's verifier — which is
		 * the shape of the attack the state check exists to stop. The raw
		 * branch of `parseAuthorizationInput` also returns the whole trimmed
		 * input as the code, so a noisy paste would be forwarded verbatim.
		 */
		const manualInputRejection = (
			parsed: AuthorizationInputParseResult,
			expectedState: string,
		): string | undefined => {
			if (!parsed.code) {
				return "No authorization code found. Paste the full callback URL (e.g., http://localhost:1455/auth/callback?code=...&state=...). If browser callback keeps failing, retry with Device Code.";
			}
			switch (parsed.source) {
				case "raw":
					return "That is a bare authorization code. This flow needs the full callback URL, including the state parameter (e.g., http://localhost:1455/auth/callback?code=...&state=...), which is what ties the code to this login attempt. If needed, retry with Device Code.";
				case "url":
				case "query":
				case "fragment":
					if (!parsed.state) {
						return "That callback URL carries no OAuth state, so it cannot be matched to this login attempt. Paste the complete callback URL including its state parameter, or retry with Device Code.";
					}
					if (parsed.state !== expectedState) {
						return "OAuth state mismatch. Restart login and paste the callback URL generated for this login attempt, or retry with Device Code.";
					}
					return undefined;
				default: {
					const unreachable: never = parsed;
					return unreachable;
				}
			}
		};

		const buildManualOAuthFlow = (
			pkce: { verifier: string },
			url: string,
			expectedState: string,
			replaceAll: boolean,
		) => ({
			url,
			method: "code" as const,
			instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
			validate: (input: string): string | undefined =>
				manualInputRejection(parseAuthorizationInput(input), expectedState),
			callback: async (input: string) => {
				const parsed = parseAuthorizationInput(input);
				const rejection = manualInputRejection(parsed, expectedState);
				if (rejection !== undefined || !parsed.code) {
					return {
						type: "failed" as const,
						reason: "invalid_response" as const,
						message: rejection ?? "Missing authorization code",
					};
				}
				const tokens = await exchangeAuthorizationCode(
					parsed.code,
					pkce.verifier,
					REDIRECT_URI,
				);
				if (tokens?.type === "success") {
					const resolved = await resolveAndPersistAccountSelection(tokens, {
						persistSelections: persistAuthenticatedSelections,
						replaceAll,
					});
					return resolved.primary;
				}
				return tokens?.type === "failed"
					? tokens
					: { type: "failed" as const };
			},
		});

		const runOAuthFlow = async (
			forceNewLogin: boolean = false,
		): Promise<TokenResult> => {
			const session = await startLoopbackFlow({
				openBrowser: true,
				forceNewLogin,
			});
			if (session.type === "unavailable") {
				const message = unavailableMessage(session.lifecycle);
				logWarn(`\n[${PLUGIN_NAME}] ${message}\n`);
				return {
					type: "failed" as const,
					reason: "invalid_response" as const,
					message,
				};
			}
			logInfo(`OAuth URL: ${session.url}`);
			// Printed first, so the recovery instruction points at a URL the
			// user can already see. The session stays open either way.
			if (!session.browserOpened) {
				logWarn(`\n[${PLUGIN_NAME}] ${browserOpenFailedMessage()}\n`);
			}
			const result = await session.waitAndExchange();
			if (result.type === "cancelled") {
				return {
					type: "failed" as const,
					reason: "unknown" as const,
					message: callbackCancelledMessage(),
				};
			}
			return result;
		};

        const showToast = async (
                message: string,
                variant: "info" | "success" | "warning" | "error" = "success",
                options?: { title?: string; duration?: number },
        ): Promise<void> => {
                try {
                        await client?.tui.showToast({
                                body: {
                                        message,
                                        variant,
                                        ...(options?.title && { title: options.title }),
                                        ...(options?.duration && { duration: options.duration }),
                                },
                        });
                } catch {
                        // Ignore when TUI is not available.
                }
        };

		type TuiQuotaAccount = Parameters<typeof createUsageAccountFingerprint>[0] & {
			index: number;
			email?: string;
			accountLabel?: string;
		};

		const clearPromptQuotaCache = async (): Promise<void> => {
			try {
				await clearTuiQuotaSnapshot();
			} catch (error) {
				logDebug(
					`[${PLUGIN_NAME}] Failed to clear TUI quota cache: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		};

		const recordPromptQuotaHeaders = async (
			response: Response,
			account: TuiQuotaAccount,
			accountCount: number,
			peerAccounts: readonly ({ accountUserId?: string } | undefined)[],
		): Promise<void> => {
			try {
				const snapshot = parseTuiQuotaSnapshotFromHeaders(response.headers, {
					fingerprint: createUsageAccountFingerprint(account),
					accountIndex: account.index + 1,
					accountCount,
					accountEmail: account.email?.trim() || undefined,
					accountLabel: formatAccountLabel(account, account.index, {
						peerAccounts,
					}),
				});
				if (!snapshot) return;
				await writeTuiQuotaSnapshot(snapshot);
			} catch (error) {
				logDebug(
					`[${PLUGIN_NAME}] Failed to record TUI quota headers: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		};

		/**
		 * Take an account out of rotation whenever the backend reports one of its
		 * quota windows as fully spent (issue #218).
		 *
		 * Codex carries `x-codex-*-used-percent` and the matching reset time on a
		 * served request and on a refused one alike, so the moment an account hits
		 * 0% left we can record it instead of rediscovering it with a failed request
		 * on every subsequent prompt. The block lands on the persisted
		 * account-wide `quotaExhaustedUntil` field, so it is remembered across
		 * restarts and clears itself once the window rolls over.
		 *
		 * Call this only for responses whose headers are authoritative: one the
		 * backend served, or one it refused for a confirmed usage limit. Every other
		 * error class — entitlement (issues #16/#17), auth, 5xx, or an upstream
		 * overload dressed up as a 429 — can echo a stale quota snapshot next to an
		 * unrelated failure, and writing that echo locked healthy accounts out for
		 * hours. `handleErrorResponse` makes that call once and reports it back as
		 * `quotaHeadersAuthoritative`.
		 *
		 * The resulting gap is deliberate: an account that really is spent but gets
		 * a 5xx stays selectable until its next genuine 429, which costs one wasted
		 * request — cheaper than a false multi-hour block on a healthy account.
		 *
		 * @returns true when the headers report a spent window, whether or not the
		 *   stored block moved. Callers use it to stop retrying this account.
		 */
		const applyQuotaExhaustion = (
			manager: AccountManager,
			headers: Headers,
			account: ManagedAccount,
			family: ModelFamily,
			model: string | null | undefined,
		): boolean => {
			try {
				const resetAtMs = getQuotaExhaustedResetAtMs(headers);
				if (resetAtMs === undefined) return false;
				if (!manager.markQuotaExhausted(account, resetAtMs, family, model)) return true;
				account.lastSwitchReason = "rate-limit";
				manager.saveToDiskDebounced();
				logWarn(
					`Account ${account.index + 1} has no shared subscription quota left; skipping it for ${formatWaitTime(resetAtMs - Date.now())}.`,
				);
				return true;
			} catch (error) {
				logDebug(
					`[${PLUGIN_NAME}] Failed to apply quota exhaustion: ${error instanceof Error ? error.message : String(error)}`,
				);
				return false;
			}
		};

		const resolveActiveIndex = (
				storage: {
						activeIndex: number;
						activeIndexByFamily?: Partial<Record<ModelFamily, number>>;
						accounts: unknown[];
				},
				family: ModelFamily = "codex",
		): number => {
				const total = storage.accounts.length;
				if (total === 0) return 0;
		const rawCandidate = storage.activeIndexByFamily?.[family] ?? storage.activeIndex;
		const raw = Number.isFinite(rawCandidate) ? rawCandidate : 0;
		return Math.max(0, Math.min(raw, total - 1));
		};

	const backfillHostOpenAIAuthFromPool = async (): Promise<void> => {
		const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
		type HostAuthEntry = {
			type?: unknown;
			access?: unknown;
			refresh?: unknown;
			expires?: unknown;
			scope?: unknown;
		};
		type HostAuthStore = Record<string, HostAuthEntry>;

		let authStore: HostAuthStore = {};
		try {
			const authRaw = await readFile(authPath, "utf8");
			const parsed = JSON.parse(authRaw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				authStore = parsed as HostAuthStore;
			}
		} catch (error) {
			const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
			if (errorCode !== "ENOENT") {
				logWarn(
					`[${PLUGIN_NAME}] Failed to read host auth store for OpenAI backfill: ${
						(error as Error)?.message ?? String(error)
					}`,
				);
				return;
			}
		}

		const existing = authStore[PROVIDER_ID];
		const hasExistingOAuth =
			existing?.type === "oauth" &&
			typeof existing.access === "string" &&
			existing.access.trim().length > 0 &&
			typeof existing.refresh === "string" &&
			existing.refresh.trim().length > 0 &&
			typeof existing.expires === "number" &&
			Number.isFinite(existing.expires);
		if (hasExistingOAuth) {
			return;
		}

		const storage = await loadAccounts();
		if (!storage || storage.accounts.length === 0) {
			return;
		}

		const hasUsableTokens = (
			account: (typeof storage.accounts)[number] | undefined,
		): boolean =>
			typeof account?.accessToken === "string" &&
			account.accessToken.trim().length > 0 &&
			typeof account?.refreshToken === "string" &&
			account.refreshToken.trim().length > 0 &&
			typeof account?.expiresAt === "number" &&
			Number.isFinite(account.expiresAt);

		const activeIndex = resolveActiveIndex(storage, "codex");
		const activeAccount = storage.accounts[activeIndex];
		const candidate = hasUsableTokens(activeAccount)
			? activeAccount
			: storage.accounts.find(hasUsableTokens);
		if (!candidate || !hasUsableTokens(candidate)) {
			return;
		}

		authStore[PROVIDER_ID] = {
			type: "oauth",
			access: candidate.accessToken,
			refresh: candidate.refreshToken,
			expires: candidate.expiresAt,
			// Carry the pool's scope across so the restored host credential is not
			// scope-less on the next load; a scope-less fallback used to be read as
			// "no scopes granted" (issue #213).
			...(candidate.oauthScope ? { scope: candidate.oauthScope } : {}),
		};

		try {
			await mkdir(join(homedir(), ".local", "share", "opencode"), { recursive: true });
			await writeFile(authPath, `${JSON.stringify(authStore, null, 2)}\n`, "utf8");
			logInfo(
				`[${PLUGIN_NAME}] Restored missing host OpenAI auth entry from stored account pool`,
			);
		} catch (error) {
			logWarn(
				`[${PLUGIN_NAME}] Failed to backfill host OpenAI auth entry: ${
					(error as Error)?.message ?? String(error)
				}`,
			);
		}
	};

	const hydrateEmails = async (
			storage: AccountStorageV3 | null,
	): Promise<AccountStorageV3 | null> => {
                if (!storage) return storage;
                const skipHydrate =
                        process.env.VITEST_WORKER_ID !== undefined ||
                        process.env.NODE_ENV === "test" ||
                        process.env.OPENCODE_SKIP_EMAIL_HYDRATE === "1";
                if (skipHydrate) return storage;

                let accountsCopy = storage.accounts.map((account) =>
                        account ? { ...account } : account,
                );
                const accountsToHydrate = accountsCopy.filter(
                        (account) => account && !account.email,
                );
                if (accountsToHydrate.length === 0) return storage;

                let changed = false;
                // Record hydrated field updates keyed by the account's ORIGINAL
                // refresh token (captured before the network call) so we can
                // re-apply them onto a freshly-loaded snapshot inside a storage
                // transaction — avoiding a lost-update race with concurrent saves.
                type HydrationUpdate = {
                                accountId?: string;
                                accountIdSource?: "token";
                                email?: string;
                                accessToken?: string;
                                expiresAt?: number;
                                oauthScope?: string;
                                refreshToken?: string;
                                // Carried so the deferred merge below can tell this rotation
                                // apart from one a concurrent process committed later.
                                tokenRotatedAt?: number;
                };
                const hydrationUpdates = new Map<string, HydrationUpdate>();
                // Keyed by stable workspace identity rather than by refresh token, for
                // accounts whose token the coordinator rotated on disk mid-loop.
                const hydrationUpdatesByIdentity = new Map<string, HydrationUpdate>();
                // process in chunks of 3 to avoid auth0 rate limits (429) on startup
                const chunkSize = 3;
                for (let i = 0; i < accountsToHydrate.length; i += chunkSize) {
                        const chunk = accountsToHydrate.slice(i, i + chunkSize);
                        await Promise.all(
                                chunk.map(async (account) => {
                                const originalRefreshToken = account.refreshToken;
                                try {
										const refreshed = await coordinatePersistedRefresh(account);
                                        if (refreshed.type !== "success") return;
                                        const update = hydrationUpdates.get(originalRefreshToken) ?? {};
                                        const id = extractAccountId(refreshed.access);
                                        const email = sanitizeEmail(extractAccountEmail(refreshed.access, refreshed.idToken));
                                        if (
                                                id &&
                                                id !== account.accountId &&
                                                shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId)
                                        ) {
                                                account.accountId = id;
                                                account.accountIdSource = "token";
                                                update.accountId = id;
                                                update.accountIdSource = "token";
                                                changed = true;
                                        }
                                        if (email && email !== account.email) {
                                                account.email = email;
                                                update.email = email;
                                                changed = true;
                                        }
					if (refreshed.access && refreshed.access !== account.accessToken) {
						account.accessToken = refreshed.access;
						update.accessToken = refreshed.access;
						changed = true;
					}
					if (typeof refreshed.expires === "number" && refreshed.expires !== account.expiresAt) {
						account.expiresAt = refreshed.expires;
						update.expiresAt = refreshed.expires;
						changed = true;
					}
					if (refreshed.scope && refreshed.scope !== account.oauthScope) {
						account.oauthScope = refreshed.scope;
						update.oauthScope = refreshed.scope;
						changed = true;
					}
                                        if (refreshed.refresh && refreshed.refresh !== account.refreshToken) {
                                                account.refreshToken = refreshed.refresh;
                                                update.refreshToken = refreshed.refresh;
                                                changed = true;
                                        }
                                        const rotatedAt = refreshed.rotatedAt ?? account.tokenRotatedAt;
                                        if (typeof rotatedAt === "number") {
                                                account.tokenRotatedAt = rotatedAt;
                                                update.tokenRotatedAt = rotatedAt;
                                        }
										if (Object.keys(update).length > 0) {
											hydrationUpdates.set(originalRefreshToken, update);
											// The coordinator has already committed the rotated token to
											// disk, so matching this update by refresh token alone would
											// miss this account and — worse — hit any SIBLING whose token
											// was rotated in place to the same value. Siblings can belong
											// to distinct orgs, so that would hand one workspace another
											// workspace's access token. Register the update under this
											// account's stable workspace identity instead; that key is
											// built from org/account/member ids and does not rotate.
											const identityKey = getWorkspaceIdentityKey(account);
											if (!identityKey.startsWith("refreshToken:")) {
												hydrationUpdatesByIdentity.set(identityKey, update);
											}
										}
				} catch {
					logWarn(`[${PLUGIN_NAME}] Failed to hydrate email for account`);
				}
                        })
                );
                }

                if (changed) {
                        // Persist under the storage lock against a fresh snapshot so a
                        // concurrent save during the (potentially multi-second) hydration
                        // network loop is not clobbered. Match accounts by their original
                        // refresh token.
                        await withAccountStorageTransaction(async (current, persist) => {
                                if (!current) return;
                                for (const acc of current.accounts) {
                                        // Identity first: it survives a rotation the coordinator already
                                        // committed. The refresh-token key is the fallback for records
                                        // that carry no org/account/member id at all.
                                        const identityKey = getWorkspaceIdentityKey(acc);
                                        const update =
                                                (identityKey.startsWith("refreshToken:")
                                                        ? undefined
                                                        : hydrationUpdatesByIdentity.get(identityKey)) ??
                                                hydrationUpdates.get(acc.refreshToken);
                                        if (!update) continue;
                                        if (update.accountId !== undefined) acc.accountId = update.accountId;
                                        if (update.accountIdSource !== undefined) acc.accountIdSource = update.accountIdSource;
                                        if (update.email !== undefined) acc.email = update.email;
                                        if (update.oauthScope !== undefined) acc.oauthScope = update.oauthScope;
                                        // The credential triple is single-use. This transaction runs after
                                        // the whole (multi-second) hydration loop, so a concurrent process
                                        // may have rotated the account in the meantime; writing our older
                                        // tuple back would restore a consumed token and cost a re-login.
                                        const updateRotatedAt = update.tokenRotatedAt ?? 0;
                                        const diskRotatedAt = acc.tokenRotatedAt ?? 0;
                                        if (updateRotatedAt >= diskRotatedAt) {
                                                if (update.accessToken !== undefined) acc.accessToken = update.accessToken;
                                                if (update.expiresAt !== undefined) acc.expiresAt = update.expiresAt;
                                                // Apply the rotated refresh token LAST so the map key
                                                // (original token) still matches above.
                                                if (update.refreshToken !== undefined) acc.refreshToken = update.refreshToken;
                                                if (update.tokenRotatedAt !== undefined) acc.tokenRotatedAt = update.tokenRotatedAt;
                                        }
                                }
                                await persist(current);
                                // Return what actually landed on disk, not the in-memory copy: a
                                // credential we declined to write above must not resurface through
                                // the returned storage either.
                                accountsCopy = current.accounts.map((acc) => ({ ...acc }));
                        });
                        storage.accounts = accountsCopy;
                }
                return storage;
        };

		const getRateLimitResetTimeForFamily = (
				account: { rateLimitResetTimes?: Record<string, number | undefined> },
				now: number,
				family: ModelFamily,
		): number | null => {
				const times = account.rateLimitResetTimes;
				if (!times) return null;

				let minReset: number | null = null;
				const prefix = `${family}:`;
				for (const [key, value] of Object.entries(times)) {
						if (typeof value !== "number") continue;
						if (value <= now) continue;
						if (key !== family && !key.startsWith(prefix)) continue;
						if (minReset === null || value < minReset) {
								minReset = value;
						}
				}

				return minReset;
		};

		const formatRateLimitEntry = (
				account: { rateLimitResetTimes?: Record<string, number | undefined> },
				now: number,
				family: ModelFamily = "codex",
		): string | null => {
				const resetAt = getRateLimitResetTimeForFamily(account, now, family);
				if (typeof resetAt !== "number") return null;
				const remaining = resetAt - now;
				if (remaining <= 0) return null;
				return `resets in ${formatWaitTime(remaining)}`;
		};

		// Account-wide subscription-quota exhaustion is a DIFFERENT block from the
		// per-family rate limits above: it lives on its own field and is reported
		// with its own label so a spent weekly quota is never shown as a transient
		// 429 ("rate limit").
		const getQuotaExhaustedUntil = (
				account: { quotaExhaustedUntil?: number },
				now: number,
		): number | null => {
				const until = account.quotaExhaustedUntil;
				if (typeof until !== "number" || !Number.isFinite(until) || until <= now) {
						return null;
				}
				return until;
		};

		const formatQuotaExhaustionEntry = (
				account: { quotaExhaustedUntil?: number },
				now: number,
		): string | null => {
				const until = getQuotaExhaustedUntil(account, now);
				if (until === null) return null;
				return `quota exhausted, resets in ${formatWaitTime(until - now)}`;
		};

		const applyUiRuntimeFromConfig = (
			pluginConfig: ReturnType<typeof loadPluginConfig>,
		): UiRuntimeOptions => {
			return setUiRuntimeOptions({
				v2Enabled: getCodexTuiV2(pluginConfig),
				colorProfile: getCodexTuiColorProfile(pluginConfig),
				glyphMode: getCodexTuiGlyphMode(pluginConfig),
			});
		};

		const resolveUiRuntime = (): UiRuntimeOptions => {
			return applyUiRuntimeFromConfig(loadPluginConfig());
		};

		const resolveMaskEmail = (): boolean => {
			return getCodexTuiMaskEmail(loadPluginConfig());
		};

		const getStatusMarker = (
			ui: UiRuntimeOptions,
			status: "ok" | "warning" | "error",
		): string => {
			if (!ui.v2Enabled) {
				if (status === "ok") return "âœ“";
				if (status === "warning") return "!";
				return "âœ—";
			}
			if (status === "ok") return ui.theme.glyphs.check;
			if (status === "warning") return "!";
			return ui.theme.glyphs.cross;
		};

		const formatAccountIdForDisplay = (accountId: string | undefined): string | null => {
			const normalized = accountId?.trim();
			if (!normalized) return null;
			if (normalized.length <= 14) return normalized;
			return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`;
		};

		const formatCommandAccountLabel = (
			account: {
				email?: string;
				accountId?: string;
				accountUserId?: string;
				accountLabel?: string;
				accountTags?: string[];
				accountNote?: string;
			} | undefined,
			index: number,
			options: {
				maskEmail?: boolean;
				peerAccounts?: readonly ({ accountUserId?: string } | undefined)[];
				omitSeat?: boolean;
			} = {},
		): string => {
			const email = resolveDisplayEmail(account?.email, options.maskEmail ?? false);
			const workspace = account?.accountLabel?.trim();
			const accountId = formatAccountIdForDisplay(account?.accountId);
			// `omitSeat` is for a caller that renders the seat itself in a place
			// a long email cannot push it out of - a table column of its own.
			// Leaving it in the label too would print the seat twice.
			const seat = options.omitSeat
				? undefined
				: formatSeatSuffix(
						account?.accountUserId,
						options.peerAccounts?.map((peer) => peer?.accountUserId),
					);
			const tags =
				Array.isArray(account?.accountTags)
					? account.accountTags
							.filter((tag): tag is string => typeof tag === "string")
							.map((tag) => tag.trim().toLowerCase())
							.filter((tag) => tag.length > 0)
					: [];
			const details: string[] = [];
			if (email) details.push(email);
			if (workspace) details.push(`workspace:${workspace}`);
			if (accountId) details.push(`id:${accountId}`);
			if (seat) details.push(`seat:${seat}`);
			if (tags.length > 0) details.push(`tags:${tags.join(",")}`);

			if (details.length === 0) {
				return `Account ${index + 1}`;
			}

			return `Account ${index + 1} (${details.join(", ")})`;
		};

		const normalizeAccountTags = (raw: string): string[] => {
			return Array.from(
				new Set(
					raw
						.split(",")
						.map((entry) => entry.trim().toLowerCase())
						.filter((entry) => entry.length > 0),
				),
			);
		};

		const supportsInteractiveMenus = (): boolean => {
			if (process.env.FORCE_INTERACTIVE_MODE === "1") return true;
			if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
			if (process.env.OPENCODE_TUI === "1") return false;
			if (process.env.OPENCODE_DESKTOP === "1") return false;
			if (process.env.TERM_PROGRAM === "opencode") return false;
			if (process.env.ELECTRON_RUN_AS_NODE === "1") return false;
			return true;
		};

		const promptAccountIndexSelection = async (
			ui: UiRuntimeOptions,
			storage: AccountStorageV3,
			title: string,
		): Promise<number | null> => {
			if (!supportsInteractiveMenus()) return null;
			try {
				const { select } = await import("./lib/ui/select.js");
				const maskEmail = resolveMaskEmail();
				const selected = await select<number>(
					storage.accounts.map((account, index) => ({
						label: formatCommandAccountLabel(account, index, {
							maskEmail,
							peerAccounts: storage.accounts,
						}),
						value: index,
					})),
					{
						message: title,
						subtitle: "Select account index",
						help: "Up/Down select | Enter confirm | Esc cancel",
						clearScreen: true,
						variant: ui.v2Enabled ? "codex" : "legacy",
						theme: ui.theme,
					},
				);
				return typeof selected === "number" ? selected : null;
			} catch {
				return null;
			}
		};

		const toBeginnerAccountSnapshots = (
			storage: AccountStorageV3,
			activeIndex: number,
			now: number,
		): BeginnerAccountSnapshot[] => {
			return storage.accounts.map((account, index) => ({
				index,
				label: formatCommandAccountLabel(account, index, {
					peerAccounts: storage.accounts,
				}),
				accountLabel: account.accountLabel,
				enabled: account.enabled !== false,
				isActive: index === activeIndex,
				rateLimitedUntil: getRateLimitResetTimeForFamily(account, now, "codex"),
				coolingDownUntil:
					typeof account.coolingDownUntil === "number"
						? account.coolingDownUntil
						: null,
			}));
		};

		const getBeginnerRuntimeSnapshot = (): BeginnerRuntimeSnapshot => ({
			totalRequests: runtimeMetrics.totalRequests,
			failedRequests: runtimeMetrics.failedRequests,
			rateLimitedResponses: runtimeMetrics.rateLimitedResponses,
			authRefreshFailures: runtimeMetrics.authRefreshFailures,
			serverErrors: runtimeMetrics.serverErrors,
			networkErrors: runtimeMetrics.networkErrors,
			lastErrorCategory: runtimeMetrics.lastErrorCategory,
			promptCacheEnabledRequests: runtimeMetrics.promptCacheEnabledRequests,
			promptCacheMissingRequests: runtimeMetrics.promptCacheMissingRequests,
			lastPromptCacheKey: runtimeMetrics.lastPromptCacheKey,
		});

		const formatDoctorSeverity = (
			ui: UiRuntimeOptions,
			severity: BeginnerDiagnosticSeverity,
		): string => {
			if (severity === "ok") return formatUiBadge(ui, "ok", "success");
			if (severity === "warning") return formatUiBadge(ui, "warning", "warning");
			return formatUiBadge(ui, "error", "danger");
		};

		const formatDoctorSeverityText = (
			severity: BeginnerDiagnosticSeverity,
		): string => {
			if (severity === "ok") return "[ok]";
			if (severity === "warning") return "[warning]";
			return "[error]";
		};

		type SetupWizardChoice =
			| "checklist"
			| "next"
			| "add-account"
			| "health"
			| "switch"
			| "label"
			| "doctor"
			| "dashboard"
			| "metrics"
			| "backup"
			| "safe-mode"
			| "help"
			| "exit";

		const buildSetupChecklistState = async () => {
			const storage = await loadAccounts();
			const now = Date.now();
			const activeIndex =
				storage && storage.accounts.length > 0
					? resolveActiveIndex(storage, "codex")
					: 0;
			const snapshots = storage
				? toBeginnerAccountSnapshots(storage, activeIndex, now)
				: [];
			const runtime = getBeginnerRuntimeSnapshot();
			const checklist = buildBeginnerChecklist(snapshots, now);
			const summary = summarizeBeginnerAccounts(snapshots, now);
			const nextAction = recommendBeginnerNextAction({
				accounts: snapshots,
				now,
				runtime,
			});

			return {
				now,
				storage,
				activeIndex,
				snapshots,
				runtime,
				checklist,
				summary,
				nextAction,
			};
		};

		const renderSetupChecklistOutput = (
			ui: UiRuntimeOptions,
			state: Awaited<ReturnType<typeof buildSetupChecklistState>>,
		): string => {
			if (ui.v2Enabled) {
				const lines: string[] = [
					...formatUiHeader(ui, "Setup checklist"),
					formatUiKeyValue(ui, "Accounts", String(state.summary.total)),
					formatUiKeyValue(
						ui,
						"Healthy",
						String(state.summary.healthy),
						state.summary.healthy > 0 ? "success" : "warning",
					),
					formatUiKeyValue(
						ui,
						"Blocked",
						String(state.summary.blocked),
						state.summary.blocked > 0 ? "warning" : "muted",
					),
					"",
				];
				for (const item of state.checklist) {
					const marker = item.done
						? getStatusMarker(ui, "ok")
						: getStatusMarker(ui, "warning");
					lines.push(
						formatUiItem(
							ui,
							`${marker} ${item.label} - ${item.detail}`,
							item.done ? "success" : "warning",
						),
					);
					if (item.command) {
						lines.push(`  ${formatUiKeyValue(ui, "command", item.command, "muted")}`);
					}
				}
				lines.push("");
				lines.push(...formatUiSection(ui, "Recommended next step"));
				lines.push(formatUiItem(ui, state.nextAction, "accent"));
				lines.push(formatUiItem(ui, "Guided wizard: codex-setup --wizard", "muted"));
				return lines.join("\n");
			}

			const lines: string[] = [
				"Setup Checklist:",
				`Accounts: ${state.summary.total}`,
				`Healthy accounts: ${state.summary.healthy}`,
				`Blocked accounts: ${state.summary.blocked}`,
				"",
			];
			for (const item of state.checklist) {
				const marker = item.done ? "[x]" : "[ ]";
				lines.push(`${marker} ${item.label} - ${item.detail}`);
				if (item.command) lines.push(`    command: ${item.command}`);
			}
			lines.push("");
			lines.push(`Recommended next step: ${state.nextAction}`);
			lines.push("Guided wizard: codex-setup --wizard");
			return lines.join("\n");
		};

		const runSetupWizard = async (
			ui: UiRuntimeOptions,
			state: Awaited<ReturnType<typeof buildSetupChecklistState>>,
		): Promise<string> => {
			if (!supportsInteractiveMenus()) {
				return [
					ui.v2Enabled
						? formatUiItem(
								ui,
								"Interactive wizard mode is unavailable in this session.",
								"warning",
						  )
						: "Interactive wizard mode is unavailable in this session.",
					ui.v2Enabled
						? formatUiItem(ui, "Showing checklist view instead.", "muted")
						: "Showing checklist view instead.",
					"",
					renderSetupChecklistOutput(ui, state),
				].join("\n");
			}

			try {
				const { select } = await import("./lib/ui/select.js");
				const labels: Record<Exclude<SetupWizardChoice, "exit">, string> = {
					checklist: "Show setup checklist",
					next: "Show best next action",
					"add-account": "Add account now",
					health: "Run health check",
					switch: "Switch active account",
					label: "Set account label",
					doctor: "Run doctor diagnostics",
					dashboard: "Open live dashboard",
					metrics: "Open runtime metrics",
					backup: "Backup accounts",
					"safe-mode": "Enable beginner safe mode",
					help: "Open command help",
				};
				const commandMap: Record<Exclude<SetupWizardChoice, "checklist" | "next" | "exit">, string> = {
					"add-account": "opencode auth login",
					health: "codex-health",
					switch: "codex-switch index=2",
					label: "codex-label index=2 label=\"Work\"",
					doctor: "codex-doctor",
					dashboard: "codex-dashboard",
					metrics: "codex-metrics",
					backup: "codex-export <path>",
					"safe-mode": "set CODEX_AUTH_BEGINNER_SAFE_MODE=1",
					help: "codex-help",
				};

				const choice = await select<SetupWizardChoice>(
					[
						{ label: "Setup wizard", value: "exit", kind: "heading" },
						{ label: labels.checklist, value: "checklist", color: "cyan" },
						{ label: labels.next, value: "next", color: "green" },
						{ label: labels["add-account"], value: "add-account", color: "cyan" },
						{ label: labels.health, value: "health", color: "cyan" },
						{ label: labels.switch, value: "switch", color: "cyan" },
						{ label: labels.label, value: "label", color: "cyan" },
						{ label: labels.doctor, value: "doctor", color: "yellow" },
						{ label: labels.dashboard, value: "dashboard", color: "cyan" },
						{ label: labels.metrics, value: "metrics", color: "cyan" },
						{ label: labels.backup, value: "backup", color: "yellow" },
						{ label: labels["safe-mode"], value: "safe-mode", color: "yellow" },
						{ label: labels.help, value: "help", color: "cyan" },
						{ label: "", value: "exit", separator: true },
						{ label: "Exit wizard", value: "exit", color: "red" },
					],
					{
						message: "Beginner setup wizard",
						subtitle: `Accounts: ${state.summary.total} | Healthy: ${state.summary.healthy} | Blocked: ${state.summary.blocked}`,
						help: "Up/Down select | Enter confirm | Esc exit",
						clearScreen: true,
						variant: ui.v2Enabled ? "codex" : "legacy",
						theme: ui.theme,
					},
				);

				if (!choice || choice === "exit") {
					return ui.v2Enabled
						? [
								...formatUiHeader(ui, "Setup wizard"),
								"",
								formatUiItem(ui, "Wizard closed.", "muted"),
								formatUiItem(ui, `Next: ${state.nextAction}`, "accent"),
						  ].join("\n")
						: `Setup wizard closed.\n\nNext: ${state.nextAction}`;
				}

				if (choice === "checklist") {
					return renderSetupChecklistOutput(ui, state);
				}
				if (choice === "next") {
					return ui.v2Enabled
						? [
								...formatUiHeader(ui, "Setup wizard"),
								"",
								formatUiItem(ui, "Best next action", "accent"),
								formatUiItem(ui, state.nextAction, "success"),
						  ].join("\n")
						: `Best next action:\n${state.nextAction}`;
				}

				const command = commandMap[choice];
				const selectedLabel = labels[choice];
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Setup wizard"),
						"",
						formatUiItem(ui, `Selected: ${selectedLabel}`, "accent"),
						formatUiItem(ui, `Run: ${command}`, "success"),
						formatUiItem(ui, "Run codex-setup --wizard again to choose another step.", "muted"),
					].join("\n");
				}
				return [
					"Setup wizard:",
					`Selected: ${selectedLabel}`,
					`Run: ${command}`,
					"",
					"Run codex-setup --wizard again to choose another step.",
				].join("\n");
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return [
					ui.v2Enabled
						? formatUiItem(ui, `Wizard failed to open: ${reason}`, "warning")
						: `Wizard failed to open: ${reason}`,
					ui.v2Enabled
						? formatUiItem(ui, "Showing checklist view instead.", "muted")
						: "Showing checklist view instead.",
					"",
					renderSetupChecklistOutput(ui, state),
				].join("\n");
			}
		};

		const runStartupPreflight = async (): Promise<void> => {
			if (startupPreflightShown) return;
			startupPreflightShown = true;
			try {
				const state = await buildSetupChecklistState();
				const message =
					`Codex preflight: healthy ${state.summary.healthy}/${state.summary.total}, ` +
					`blocked ${state.summary.blocked}, rate-limited ${state.summary.rateLimited}. ` +
					`Next: ${state.nextAction}`;
				await showToast(message, state.summary.healthy > 0 ? "info" : "warning");
				logInfo(message);
			} catch (error) {
				logDebug(
					`[${PLUGIN_NAME}] Startup preflight skipped: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		};

		const invalidateAccountManagerCache = (clearedSnapshots?: Readonly<AccountStorageV3["accounts"]>): void => {
			// Retire before flushing: keep disk membership authoritative while
			// publishing queued rate-limit evidence through the volatile merge.
			const previous = cachedAccountManager;
			cachedAccountManager = null;
			accountManagerPromise = null;
			if (previous) {
				previous.disposeShutdownHandler(false, clearedSnapshots);
				void previous
					.flushPendingSave()
					.catch((error: unknown) => {
						logWarn(
							`Failed to flush pending save while invalidating account manager: ${error instanceof Error ? error.message : String(error)}`,
						);
					});
			}
		};

		/**
		 * `loadAccounts()` reports a read or parse failure the same way it reports
		 * an absent file - by returning null - and a null load builds a manager
		 * holding zero accounts. Installing that over a working pool makes this
		 * process answer "No Codex accounts configured" while the accounts file on
		 * disk is intact, which cross-process lock contention makes reachable.
		 *
		 * Emptying the pool for real always goes through an explicit action
		 * (`codex-remove`, logout, a storage-mode switch); each installs its own
		 * manager rather than arriving here, so refusing the shrink costs a genuine
		 * deletion nothing.
		 */
		const isUntrustworthyEmptyReload = (
			incumbent: AccountManager | null,
			reloaded: AccountManager,
		): boolean =>
			incumbent !== null &&
			incumbent !== reloaded &&
			reloaded.getAccountCount() === 0 &&
			incumbent.getAccountCount() > 0;

		const EMPTY_RELOAD_RETRY_DELAY_MS = 2000;
		const EMPTY_RELOAD_MAX_RETRIES = 3;
		let emptyReloadRetries = 0;
		let emptyReloadRetryTimer: ReturnType<typeof setTimeout> | undefined;
		const cancelEmptyReloadRetry = (): void => {
			clearTimeout(emptyReloadRetryTimer);
			emptyReloadRetryTimer = undefined;
			emptyReloadRetries = 0;
		};
		const scheduleEmptyReloadRetry = (retry: () => Promise<void>): void => {
			if (emptyReloadRetries >= EMPTY_RELOAD_MAX_RETRIES) {
				emptyReloadRetries = 0;
				return;
			}
			emptyReloadRetries += 1;
			clearTimeout(emptyReloadRetryTimer);
			emptyReloadRetryTimer = setTimeout(() => {
				emptyReloadRetryTimer = undefined;
				void retry();
			}, EMPTY_RELOAD_RETRY_DELAY_MS);
			emptyReloadRetryTimer.unref();
		};

		const reloadCachedAccountManager = async (): Promise<void> => {
			if (!cachedAccountManager) return;
			const previous = cachedAccountManager;
			// Flush the outgoing manager's pending debounced save BEFORE reading
			// fresh disk state. Otherwise a queued save from `previous` can fire
			// after this reload and silently overwrite the single-use refresh
			// tokens codex-health/codex-refresh just persisted via
			// withAccountStorageTransaction — a lost-update on rotated credentials.
			// Mirrors invalidateAccountManagerCache above.
			try {
				await previous.flushPendingSave();
			} catch (error) {
				logWarn(
					`Failed to flush pending save while reloading account manager: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			try {
				const reloadedManager = await AccountManager.loadFromDisk();
				if (isUntrustworthyEmptyReload(previous, reloadedManager)) {
					reloadedManager.disposeShutdownHandler();
					logWarn(
						`[${PLUGIN_NAME}] Account reload returned no accounts while ${previous.getAccountCount()} are held; keeping the loaded pool and retrying`,
					);
					scheduleEmptyReloadRetry(reloadCachedAccountManager);
					return;
				}
				cancelEmptyReloadRetry();
				cachedAccountManager = reloadedManager;
				accountManagerPromise = Promise.resolve(reloadedManager);
				// Dispose only after the replacement is installed so we never leak
				// the outgoing manager's shutdown handler on every reload, and so a
				// load failure leaves the working manager intact.
				previous.disposeShutdownHandler();
			} catch (error) {
				logWarn(
					`Failed to reload account manager: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		};

		/**
		 * Refills the cache after the fetch path refused an empty reload.
		 * `reloadCachedAccountManager` cannot serve here - it compares against
		 * the cached incumbent, which is exactly what is missing - so the
		 * incumbent the refusing request kept serving is passed in instead.
		 */
		const repopulateAccountManagerCache = async (incumbent: AccountManager): Promise<void> => {
			try {
				const reloaded = await AccountManager.loadFromDisk();
				if (cachedAccountManager) {
					// Another actor repopulated first; the late load is stale and
					// retires for the same reason the fetch path retires it.
					if (cachedAccountManager !== reloaded) reloaded.disposeShutdownHandler();
					return;
				}
				if (isUntrustworthyEmptyReload(incumbent, reloaded)) {
					reloaded.disposeShutdownHandler();
					scheduleEmptyReloadRetry(() => repopulateAccountManagerCache(incumbent));
					return;
				}
				cancelEmptyReloadRetry();
				cachedAccountManager = reloaded;
				accountManagerPromise = Promise.resolve(reloaded);
			} catch (error) {
				logWarn(
					`Failed to reload account manager: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		};

		let watchedAccountsPath: string | undefined;
		let observedAccountsDigest: string | undefined;
		let accountsReloadTimer: ReturnType<typeof setTimeout> | undefined;
		let accountsWatcherDisposed = false;
		let accountsWatchGeneration = 0;
		let unsubscribeAccountsPath: (() => void) | undefined;

		const stopAccountsWatcher = (): void => {
			accountsWatchGeneration += 1;
			if (watchedAccountsPath) unwatchFile(watchedAccountsPath, onAccountsStatChanged);
			watchedAccountsPath = undefined;
			observedAccountsDigest = undefined;
			clearTimeout(accountsReloadTimer);
			accountsReloadTimer = undefined;
		};
		const disposeAccountsWatcher = (): void => {
			accountsWatcherDisposed = true;
			unsubscribeAccountsPath?.();
			stopAccountsWatcher();
			cancelEmptyReloadRetry();
			unregisterCleanup(disposeAccountsWatcher);
		};
		const readAccountsFileState = async (
			path: string,
		): Promise<{ digest: string; accountCount: number } | undefined> => {
			try {
				const content = await readFile(path, "utf8");
				const data = JSON.parse(content) as unknown;
				if (!AnyAccountStorageSchema.safeParse(data).success) return;
				// Counted off the raw document rather than the parsed union so the
				// count is the same for every storage version.
				const accounts = (data as { accounts?: unknown }).accounts;
				return {
					digest: createHash("sha256").update(content).digest("hex"),
					accountCount: Array.isArray(accounts) ? accounts.length : 0,
				};
			} catch {
				return;
			}
		};
		const reloadForExternalAccountsChange = async (path: string, generation: number, attempt = 0, retired?: AccountManager): Promise<void> => {
			const observed = await readAccountsFileState(path);
			if (generation !== accountsWatchGeneration || !observed || path !== getStoragePath()) return;
			const digest = observed.digest;
			if (digest === consumeLastWrittenAccountsDigest(path)) return;
			const retryLater = (): void => {
				if (attempt < 2 && generation === accountsWatchGeneration && !accountsWatcherDisposed) {
					accountsReloadTimer = setTimeout(() => {
						accountsReloadTimer = undefined;
						void reloadForExternalAccountsChange(path, generation, attempt + 1, retired);
					}, 1500);
					accountsReloadTimer.unref();
				}
			};
			const previous = cachedAccountManager;
			try {
				// A null cache means an invalidation retired the incumbent; the
				// reload still must adopt the external change. Bailing here would
				// strand it: onAccountsFileChanged already marked this digest
				// observed, and an in-flight load started before the write can
				// still resolve and install a pre-change snapshot whose
				// full-membership save then deletes the imported accounts.
				if (previous) {
					if (previous !== retired) {
						previous.disposeShutdownHandler(true);
						retired = previous;
					}
					await previous.flushPendingSave();
				}
				const reloaded = await AccountManager.loadFromDisk();
				if (generation !== accountsWatchGeneration || accountsWatcherDisposed || path !== getStoragePath()) {
					reloaded.disposeShutdownHandler();
					return;
				}
				// The file this reload observed carried accounts but the load
				// produced none, so `loadAccounts()` failed to read it rather than
				// the accounts having gone away - a failure it reports as an empty
				// result, never as a throw, so the catch below cannot see it.
				// Adopting it would answer "No Codex accounts configured" against an
				// intact file; the retired incumbent still serves its accounts until
				// a retry lands a real one.
				if (observed.accountCount > 0 && reloaded.getAccountCount() === 0) {
					reloaded.disposeShutdownHandler();
					logWarn(
						`[${PLUGIN_NAME}] Externally changed accounts file holds ${observed.accountCount} account(s) but loaded as empty; keeping the current pool and retrying`,
					);
					retryLater();
					return;
				}
				const outgoing = cachedAccountManager;
				if (outgoing && outgoing !== retired) {
					// Another actor replaced the cached manager while this reload
					// was in flight (concurrent fetch reload or tool mutation).
					// Retire the incumbent with the same external-reload
					// semantics, or its queued membership save can clobber the
					// external change this reload is about to adopt.
					outgoing.disposeShutdownHandler(true);
					retired = outgoing;
				}
				cachedAccountManager = reloaded;
				accountManagerPromise = Promise.resolve(reloaded);
				observedAccountsDigest = digest;
			} catch {
				logWarn("Could not reload externally updated account storage");
				retryLater();
				return;
			}
			logDebug("Reloaded cached account manager after external accounts file change");
		};
		const onAccountsFileChanged = async (): Promise<void> => {
			if (accountsWatcherDisposed) return;
			if (watchedAccountsPath !== getStoragePath()) {
				await ensureAccountsWatcher();
				return;
			}
			const path = watchedAccountsPath;
			if (!path) return;
			const generation = accountsWatchGeneration;
			const observed = await readAccountsFileState(path);
			if (generation !== accountsWatchGeneration || !observed || observed.digest === observedAccountsDigest) return;
			const digest = observed.digest;
			observedAccountsDigest = digest;
			clearTimeout(accountsReloadTimer);
			accountsReloadTimer = undefined;
			if (digest === consumeLastWrittenAccountsDigest(path)) return;
			accountsReloadTimer = setTimeout(() => {
				accountsReloadTimer = undefined;
				void reloadForExternalAccountsChange(path, generation);
			}, 500);
			accountsReloadTimer.unref();
		};
		const onAccountsStatChanged = (): void => {
			void onAccountsFileChanged();
		};
		const ensureAccountsWatcher = async (): Promise<void> => {
			if (accountsWatcherDisposed) return;
			const path = getStoragePath();
			if (path === watchedAccountsPath) return;
			stopAccountsWatcher();
			if (isKeychainOptInEnabled()) return;
			unsubscribeAccountsPath ??= subscribeToStoragePathChanges(() => {
				void ensureAccountsWatcher();
			});
			watchedAccountsPath = path;
			const generation = accountsWatchGeneration;
			const initial = await readAccountsFileState(path);
			if (generation !== accountsWatchGeneration) return;
			observedAccountsDigest = initial?.digest;
			// Stat polling follows the path across the storage writer's temp-file rename.
			watchFile(path, { interval: 1500, persistent: false }, onAccountsStatChanged);
			unregisterCleanup(disposeAccountsWatcher);
			registerCleanup(disposeAccountsWatcher);
		};

		const persistAuthenticatedSelections = async (
			results: TokenSuccessWithAccount[],
			replaceAll: boolean,
		): Promise<void> => {
			try {
				await persistAccountPool(results, replaceAll);
				invalidateAccountManagerCache();
			} catch (err) {
				const storagePath = getStoragePath();
				const errorCode = (err as NodeJS.ErrnoException)?.code || "UNKNOWN";
				const hint =
					err instanceof StorageError
						? err.hint
						: formatStorageErrorHint(err, storagePath);
				logError(
					`[${PLUGIN_NAME}] Failed to persist account: [${errorCode}] ${(err as Error)?.message ?? String(err)}`,
				);
				await showToast(hint, "error", {
					title: "Account Persistence Failed",
					duration: 10000,
				});
			}
		};

		// Created here, after `invalidateAccountManagerCache`, because the
		// monitor refreshes access tokens unattended. A refresh rotates the
		// single-use refresh token durably on disk, so the cached
		// AccountManager holding the old one must be dropped or its debounced
		// save clobbers the rotation (see `reloadCachedAccountManager` above).
		const quotaMonitor = createQuotaMonitor({
			onCredentialsPersisted: invalidateAccountManagerCache,
		});

        // Event handler for session recovery and account selection
        const eventHandler = async (input: { event: { type: string; properties?: unknown } }) => {
          try {
                const { event } = input;
                if (event.type === "server.instance.disposed") {
                        quotaMonitor.dispose();
						disposeAccountsWatcher();
						await cachedAccountManager?.flushPendingSave();
						cachedAccountManager?.disposeShutdownHandler();
                        return;
                }
                // Handle TUI account selection events
                // Accepts generic selection events with an index property
                if (
                        event.type === "account.select" ||
                        event.type === "openai.account.select"
                ) {
                        const props = event.properties as { index?: number; accountIndex?: number; provider?: string };
                        // Filter by provider if specified
                        if (props.provider && props.provider !== "openai" && props.provider !== PROVIDER_ID) {
                                return;
                        }

                        const index = props.index ?? props.accountIndex;
                        if (typeof index === "number") {
                                const storage = await loadAccounts();
                                if (!storage || index < 0 || index >= storage.accounts.length) {
                                        return;
                                }

                                const now = Date.now();
                                const account = storage.accounts[index];
								if (!account) return;
								const identityKey = getWorkspaceIdentityKey(account);
								await withAccountStorageTransaction(async (current, persist) => {
									if (!current) return;
									const currentIndex = current.accounts.findIndex(
										(candidate) => getWorkspaceIdentityKey(candidate) === identityKey,
									);
									const currentAccount = current.accounts[currentIndex];
									if (!currentAccount || currentIndex < 0) return;
									currentAccount.lastUsed = now;
									currentAccount.lastSwitchReason = "rotation";
									current.activeIndex = currentIndex;
									current.activeIndexByFamily = current.activeIndexByFamily ?? {};
									for (const family of MODEL_FAMILIES) {
										current.activeIndexByFamily[family] = currentIndex;
									}
									await persist(current);
								});
								await clearPromptQuotaCache();

								// Reload manager from disk so we don't overwrite newer rotated
								// refresh tokens with stale in-memory state.
								await reloadCachedAccountManager();

                                await showToast(`Switched to account ${index + 1}`, "info");
                        }
                }
          } catch (error) {
                logDebug(`[${PLUGIN_NAME}] Event handler error: ${error instanceof Error ? error.message : String(error)}`);
          }
        };

		// Initialize runtime UI settings once on plugin load; auth/tools refresh this dynamically.
		resolveUiRuntime();

		// Build the shared ToolContext consumed by every codex-* tool factory.
		// Mutable refs proxy plugin-closure `let` bindings so tool writes to
		// `.current` propagate to the outer closure without exposing the raw
		// variables (RC-1 Phase 2; see lib/tools/index.ts).
		const ctx: ToolContext = {
			cachedAccountManagerRef: {
				get current() {
					return cachedAccountManager;
				},
				set current(value) {
					cachedAccountManager = value;
				},
			},
			accountManagerPromiseRef: {
				get current() {
					return accountManagerPromise;
				},
				set current(value) {
					accountManagerPromise = value;
				},
			},
			reloadCachedAccountManager,
			runtimeMetrics,
			beginnerSafeModeRef: {
				get current() {
					return beginnerSafeModeEnabled;
				},
			},
			resolveUiRuntime,
			getStatusMarker,
			formatCommandAccountLabel,
			resolveMaskEmail,
			normalizeAccountTags,
			supportsInteractiveMenus,
			promptAccountIndexSelection,
			resolveActiveIndex,
			getRateLimitResetTimeForFamily,
			formatRateLimitEntry,
			formatQuotaExhaustionEntry,
			buildJsonAccountIdentity,
			buildRoutingVisibilitySnapshot,
			appendRoutingVisibilityText,
			appendRoutingVisibilityUi,
			toBeginnerAccountSnapshots,
			getBeginnerRuntimeSnapshot,
			formatDoctorSeverity,
			formatDoctorSeverityText,
			buildSetupChecklistState,
			renderSetupChecklistOutput,
			runSetupWizard,
			invalidateAccountManagerCache,
			upsertFlaggedAccountRecord,
		};

	const startupPluginConfig = loadPluginConfig();
	const startupPerProjectAccounts = getPerProjectAccounts(startupPluginConfig);
	setStoragePath(startupPerProjectAccounts ? directory : null);
	if (client) await backfillHostOpenAIAuthFromPool();
	quotaMonitor.start();

        return {
                event: eventHandler,
                auth: {
			provider: PROVIDER_ID,
			/**
			 * Loader function that configures OAuth authentication and request handling
			 *
			 * This function:
                         * 1. Validates OAuth authentication
                         * 2. Loads multi-account pool from disk (fallback to current auth)
                         * 3. Loads user configuration from opencode.json
                         * 4. Fetches Codex system instructions from GitHub (cached)
                         * 5. Returns SDK configuration with custom fetch implementation
			 *
			 * @param getAuth - Function to retrieve current auth state
			 * @param provider - Provider configuration from opencode.json
			 * @returns SDK configuration object or empty object for non-OAuth auth
			 */
			async loader(getAuth: () => Promise<Auth>, provider: unknown) {
				const auth = await getAuth();
				const pluginConfig = loadPluginConfig();
				let openAIBaseURL: string | undefined;
				try {
					openAIBaseURL = resolveOpenAIBaseURL();
				} catch (err) {
					// Fail closed rather than silently falling back to the default
					// endpoint: the operator asked for a gateway, so quietly bypassing
					// it would send ChatGPT traffic somewhere they did not choose.
					// Surface the reason the same way storage failures are surfaced.
					const message = err instanceof Error ? err.message : String(err);
					if (!customBaseURLErrorShown) {
						customBaseURLErrorShown = true;
						await showToast(message, "error");
					}
					throw err;
				}
				if (openAIBaseURL && !customBaseURLWarningShown) {
					customBaseURLWarningShown = true;
					logWarn("Routing ChatGPT OAuth inference through OPENAI_BASE_URL", {
						origin: new URL(openAIBaseURL).origin,
					});
				}
				applyUiRuntimeFromConfig(pluginConfig);
				let perProjectAccounts = getPerProjectAccounts(pluginConfig);
				let storageTransition: Promise<void> | undefined;
				const activeFetches = new Set<Promise<void>>();
				setStoragePath(perProjectAccounts ? directory : null);
				const authFallback = auth.type === "oauth" ? (auth as OAuthAuthDetails) : undefined;

				// Prefer multi-account auth metadata when available, but still handle
				// plain OAuth credentials (for OpenCode versions that inject internal
				// Codex auth first and omit the multiAccount marker).
				const authWithMulti = authFallback as (OAuthAuthDetails & { multiAccount?: boolean }) | undefined;
				if (authWithMulti && !authWithMulti.multiAccount) {
					logDebug(
						`[${PLUGIN_NAME}] Auth is missing multiAccount marker; continuing with single-account compatibility mode`,
					);
				}
				if (!authFallback) {
					logDebug(
						`[${PLUGIN_NAME}] Host auth is ${auth.type}; attempting stored Codex account compatibility mode`,
					);
				}

				// Acquire mutex for thread-safe initialization
				// Use while loop to handle multiple concurrent waiters correctly
				while (loaderMutex) {
					await loaderMutex;
				}

				let resolveMutex: (() => void) | undefined;
				loaderMutex = new Promise<void>((resolve) => {
					resolveMutex = resolve;
				});
				try {
					if (!accountManagerPromise) {
						// Evict the cached promise if the load rejects. Without this a
						// transient read failure — a momentary Windows file lock, a
						// partially-written save — parks a rejected promise here and
						// every later request re-awaits it, so the plugin keeps failing
						// long after the cause is gone and only an opencode restart
						// clears it. The guard keeps a concurrent reload's newer promise
						// from being dropped. The current call still rejects; only the
						// next one gets a fresh attempt.
						const pending = AccountManager.loadFromDisk(authFallback);
						accountManagerPromise = pending;
						void pending.catch(() => {
							if (accountManagerPromise === pending) {
								accountManagerPromise = null;
							}
						});
					}
					const loadedManager = await accountManagerPromise;
					if (cachedAccountManager && cachedAccountManager !== loadedManager) {
						// An external reload replaced the cache while this load was
						// in flight. The loaded snapshot is stale; retiring it keeps
						// its debounced save from writing full membership over the
						// successor's state.
						loadedManager.disposeShutdownHandler();
					} else {
						cachedAccountManager = loadedManager;
					}
					const accountManager = cachedAccountManager ?? loadedManager;
					await ensureAccountsWatcher();
					const refreshToken = authFallback?.refresh ?? "";
					const needsPersist =
						refreshToken &&
						!accountManager.hasRefreshToken(refreshToken);
					if (needsPersist) {
						await accountManager.saveToDisk();
					}

					const accountCount = accountManager.getAccountCount();
					const storagePath = getStoragePath();
					logDebug(
						`[${PLUGIN_NAME}] Loader auth bootstrap`,
						{
							authType: auth.type,
							authHasRefresh: !!authFallback?.refresh,
							authHasMultiAccount: !!authWithMulti?.multiAccount,
							accountCount,
							storagePath,
						},
					);
					if (accountCount === 0) {
						logWarn(
							`[${PLUGIN_NAME}] No Codex accounts available (run opencode auth login)`,
						);
					}
				// Extract user configuration (global + per-model options)
				const providerConfig = provider as
					| { options?: Record<string, unknown>; models?: UserConfig["models"] }
					| undefined;
				const userConfig: UserConfig = {
					global: providerConfig?.options || {},
					models: providerConfig?.models || {},
				};

				const sessionRecoveryEnabled = getSessionRecovery(pluginConfig);
				beginnerSafeModeEnabled = getBeginnerSafeMode(pluginConfig);
				const initialRetryProfile = beginnerSafeModeEnabled ? "conservative" : getRetryProfile(pluginConfig);
				runtimeMetrics.retryProfile = initialRetryProfile;
				runtimeMetrics.retryBudgetLimits = resolveRetryBudgetLimits(
					initialRetryProfile,
					beginnerSafeModeEnabled ? {} : getRetryBudgetOverrides(pluginConfig),
				);
				const autoResumeEnabled = getAutoResume(pluginConfig);
				const autoUpdateEnabled = getAutoUpdate(pluginConfig);
				if (getFastSession(pluginConfig)) {
					logDebug("Fast session mode enabled", {
						reasoningEffort: "none/low",
						reasoningSummary: "auto",
						textVerbosity: "low",
						fastSessionStrategy: getFastSessionStrategy(pluginConfig),
						fastSessionMaxInputItems: getFastSessionMaxInputItems(pluginConfig),
					});
				}
				if (getBeginnerSafeMode(pluginConfig)) {
					logInfo("Beginner safe mode enabled", {
						retryProfile: "conservative",
						retryAllAccountsRateLimited: false,
						retryAllAccountsMaxRetries: Math.min(1, getRetryAllAccountsMaxRetries(pluginConfig)),
					});
				}

				const underTestRunner =
					process.env.VITEST === "true" || process.env.NODE_ENV === "test";
				const prewarmEnabled =
					process.env.CODEX_AUTH_PREWARM !== "0" && !underTestRunner;

				if (!startupPrewarmTriggered && prewarmEnabled && getRequestTransformMode(pluginConfig) === "legacy") {
					startupPrewarmTriggered = true;
					const configuredModels = Object.keys(userConfig.models ?? {});
					prewarmCodexInstructions(configuredModels);
					if (getCodexMode(pluginConfig)) {
						prewarmOpenCodeCodexPrompt();
					}
				}

				const recoveryHook = sessionRecoveryEnabled && client
					? createSessionRecoveryHook(
							{ client, directory },
							{ sessionRecovery: true, autoResume: autoResumeEnabled }
						)
					: null;

			const pluginOrigin = getPluginOrigin();
			if (pluginOrigin && !startupOriginRecorded) {
				startupOriginRecorded = true;
				if (pluginOrigin.isLocalCheckout) {
					logInfo(`Running from ${describePluginOrigin(pluginOrigin)}`);
				}
				if (!underTestRunner) {
					recordPluginOrigin(pluginOrigin).catch((err) => {
						logDebug(`Failed to record plugin origin: ${err instanceof Error ? err.message : String(err)}`);
					});
				}
			}

			checkAndNotify(async (message, variant) => {
				await showToast(message, variant);
			}, {
				autoUpdate: autoUpdateEnabled,
				localCheckout: pluginOrigin?.isLocalCheckout ?? false,
			}).catch((err) => {
				logDebug(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
			});
			await runStartupPreflight();


				// Return SDK configuration
				return {
					apiKey: DUMMY_API_KEY,
					baseURL: openAIBaseURL ?? CODEX_BASE_URL,
					/**
					 * Custom fetch implementation for Codex API
					 *
					 * Handles:
					 * - Token refresh when expired
					 * - URL rewriting for Codex backend
					 * - Request body transformation
					 * - OAuth header injection
					 * - SSE to JSON conversion for non-tool requests
					 * - Error handling and logging
					 *
					 * @param input - Request URL or Request object
					 * @param init - Request options
					 * @returns Response from Codex API
					 */
					async fetch(
						input: Request | string | URL,
						init?: RequestInit,
					): Promise<Response> {
						let finishFetch: (() => void) | undefined;
						let pendingFetch: Promise<void> | undefined;
						try {
							const pluginConfig = loadPluginConfig();
							const currentPerProjectAccounts = getPerProjectAccounts(pluginConfig);
							while (storageTransition) await storageTransition;
							if (currentPerProjectAccounts !== perProjectAccounts) {
								storageTransition = (async () => {
									await Promise.all(activeFetches);
									// Drain the old pool's pending write before changing the global path.
									await cachedAccountManager?.flushPendingSave();
									setStoragePath(currentPerProjectAccounts ? directory : null);
									invalidateAccountManagerCache();
									perProjectAccounts = currentPerProjectAccounts;
								})().finally(() => { storageTransition = undefined; });
								await storageTransition;
							}
							pendingFetch = new Promise<void>((resolve) => { finishFetch = resolve; });
							activeFetches.add(pendingFetch);
							if (!accountManagerPromise) {
								const pending = AccountManager.loadFromDisk();
								accountManagerPromise = pending;
								void pending.catch(() => {
									if (accountManagerPromise === pending) accountManagerPromise = null;
								});
							}
						if (!cachedAccountManager) {
							const loadedManager = await accountManagerPromise;
							if (cachedAccountManager && cachedAccountManager !== loadedManager) {
								// External reload won the race while this load was in
								// flight: adopt the cache and retire the stale load.
								loadedManager.disposeShutdownHandler();
							} else if (!cachedAccountManager) {
								cachedAccountManager = loadedManager;
							}
						}
							const codexMode = getCodexMode(pluginConfig);
							const requestTransformMode = getRequestTransformMode(pluginConfig);
							const fastSessionEnabled = getFastSession(pluginConfig);
							const fastSessionStrategy = getFastSessionStrategy(pluginConfig);
							const fastSessionMaxInputItems = getFastSessionMaxInputItems(pluginConfig);
							const beginnerSafeMode = getBeginnerSafeMode(pluginConfig);
							beginnerSafeModeEnabled = beginnerSafeMode;
							const maskEmailEnabled = getCodexTuiMaskEmail(pluginConfig);
							const retryProfile = beginnerSafeMode ? "conservative" : getRetryProfile(pluginConfig);
							const retryBudgetOverrides = beginnerSafeMode ? {} : getRetryBudgetOverrides(pluginConfig);
							const retryBudgetLimits = resolveRetryBudgetLimits(retryProfile, retryBudgetOverrides);
							runtimeMetrics.retryProfile = retryProfile;
							runtimeMetrics.retryBudgetLimits = { ...retryBudgetLimits };
							const tokenRefreshSkewMs = getTokenRefreshSkewMs(pluginConfig);
							const rateLimitToastDebounceMs = getRateLimitToastDebounceMs(pluginConfig);
							const retryAllAccountsRateLimited = beginnerSafeMode ? false : getRetryAllAccountsRateLimited(pluginConfig);
							const retryAllAccountsMaxWaitMs = getRetryAllAccountsMaxWaitMs(pluginConfig);
							const retryAllAccountsMaxRetries = beginnerSafeMode
								? Math.min(1, getRetryAllAccountsMaxRetries(pluginConfig))
								: getRetryAllAccountsMaxRetries(pluginConfig);
							const unsupportedCodexPolicy = getUnsupportedCodexPolicy(pluginConfig);
							const fallbackOnUnsupportedCodexModel = unsupportedCodexPolicy === "fallback";
							const fallbackToGpt52OnUnsupportedGpt53 = getFallbackToGpt52OnUnsupportedGpt53(pluginConfig);
							const unsupportedCodexFallbackChain = getUnsupportedCodexFallbackChain(pluginConfig);
							const toastDurationMs = getToastDurationMs(pluginConfig);
							const accountToastsEnabled = getAccountToastsEnabled(pluginConfig);
							const fetchTimeoutMs = getFetchTimeoutMs(pluginConfig);
							const streamStallTimeoutMs = getStreamStallTimeoutMs(pluginConfig);
							const emptyResponseMaxRetries = getEmptyResponseMaxRetries(pluginConfig);
							const emptyResponseRetryDelayMs = getEmptyResponseRetryDelayMs(pluginConfig);
							const pidOffsetEnabled = getPidOffsetEnabled(pluginConfig);
							const rotationStrategy = getRotationStrategy(pluginConfig);
							const effectiveUserConfig = fastSessionEnabled ? applyFastSessionDefaults(userConfig) : userConfig;
							let accountManager = cachedAccountManager;

                                                // Step 1: Extract and rewrite URL for Codex backend
                                                const originalUrl = extractRequestUrl(input);
								const url = openAIBaseURL ? originalUrl : rewriteUrlForCodex(originalUrl);

							// Step 3: Transform request body with model-specific Codex instructions
							// Instructions are fetched per model family (codex-max, codex, gpt-5.4, etc.)
							// Capture original stream value before transformation
							// generateText() sends no stream field, streamText() sends stream=true
								const normalizeRequestInit = async (
									requestInput: Request | string | URL,
									requestInit: RequestInit | undefined,
								): Promise<RequestInit | undefined> => {
									if (requestInit) return requestInit;
									if (!(requestInput instanceof Request)) return requestInit;

									const method = requestInput.method || "GET";
									const normalized: RequestInit = {
										method,
										headers: new Headers(requestInput.headers),
									};

									if (method !== "GET" && method !== "HEAD") {
										try {
											const bodyText = await requestInput.clone().text();
											if (bodyText) {
												normalized.body = bodyText;
											}
										} catch {
											// Body may be unreadable; proceed without it.
										}
									}

									return normalized;
								};

								const parseRequestBodyFromInit = async (
									body: unknown,
								): Promise<Record<string, unknown>> => {
									if (!body) return {};

									try {
										if (typeof body === "string") {
											return JSON.parse(body) as Record<string, unknown>;
										}

										if (body instanceof Uint8Array) {
											return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
										}

										if (body instanceof ArrayBuffer) {
											return JSON.parse(new TextDecoder().decode(new Uint8Array(body))) as Record<string, unknown>;
										}

										if (ArrayBuffer.isView(body)) {
											const view = new Uint8Array(
												body.buffer,
												body.byteOffset,
												body.byteLength,
											);
											return JSON.parse(new TextDecoder().decode(view)) as Record<string, unknown>;
										}

										if (typeof Blob !== "undefined" && body instanceof Blob) {
											return JSON.parse(await body.text()) as Record<string, unknown>;
										}
									} catch {
										logWarn("Failed to parse request body, using empty object");
									}

									return {};
								};

								const baseInit = await normalizeRequestInit(input, init);
								const originalBody = await parseRequestBodyFromInit(baseInit?.body);
								const isStreaming = originalBody.stream === true;
								const parsedBody =
									Object.keys(originalBody).length > 0 ? originalBody : undefined;

								const transformation = await transformRequestForCodex(
									baseInit,
									url,
									effectiveUserConfig,
									codexMode,
									parsedBody,
									{
									fastSession: fastSessionEnabled,
									fastSessionStrategy,
									fastSessionMaxInputItems,
									requestTransformMode,
								},
							);
										let requestInit = transformation?.updatedInit ?? baseInit;
										let transformedBody: RequestBody | undefined = transformation?.body;
										const promptCacheKey = transformedBody?.prompt_cache_key;
										let model = transformedBody?.model;
										const requestedModel = model ?? null;
										let modelFamily = model ? getModelFamily(model) : "gpt-5.4";
										let quotaKey = model ? `${modelFamily}:${model}` : modelFamily;
										let fallbackApplied = false;
										let fallbackFrom: string | null = null;
										let fallbackTo: string | null = null;
										let fallbackReason: string | null = null;
						const threadIdCandidate =
							(process.env.CODEX_THREAD_ID ?? promptCacheKey ?? "")
								.toString()
								.trim() || undefined;
							const requestCorrelationId = setCorrelationId(
								threadIdCandidate ? `${threadIdCandidate}:${Date.now()}` : undefined,
							);
							runtimeMetrics.lastRequestAt = Date.now();
							runtimeMetrics.lastPromptCacheKey = promptCacheKey ?? null;
							if (promptCacheKey) {
								runtimeMetrics.promptCacheEnabledRequests++;
							} else {
								runtimeMetrics.promptCacheMissingRequests++;
							}
							const retryBudget = new RetryBudgetTracker(retryBudgetLimits);
							const consumeRetryBudget = (
								bucket: RetryBudgetClass,
								reason: string,
								waitMs?: number,
							): boolean => {
								// Pass the wait so the charge scales with how long the retry
								// blocks. Metrics follow the tracker's own counter rather than
								// assuming one unit, or a free sub-second wait would report
								// budget it never spent.
								const usedBefore = retryBudget.getUsage()[bucket];
								const granted =
									waitMs === undefined
										? retryBudget.consume(bucket)
										: retryBudget.consumeWait(bucket, waitMs);
								if (granted) {
									runtimeMetrics.retryBudgetUsage[bucket] +=
										retryBudget.getUsage()[bucket] - usedBefore;
									return true;
								}
								runtimeMetrics.retryBudgetExhaustions += 1;
								runtimeMetrics.lastRetryBudgetExhaustedClass = bucket;
								runtimeMetrics.lastRetryBudgetReason = reason;
								runtimeMetrics.lastErrorCategory = "retry-budget";
								runtimeMetrics.lastError = `Retry budget exhausted (${bucket}): ${reason}`;
								logWarn(`Retry budget exhausted for ${bucket}`, {
									reason,
									profile: retryProfile,
									limits: retryBudget.getLimits(),
									usage: retryBudget.getUsage(),
								});
								return false;
							};

					const abortSignal = requestInit?.signal ?? init?.signal ?? null;
					// Surface caller-cancellation during retry/backoff waits as a proper
					// AbortError (name set) carrying the caller abort reason, mirroring the
					// fetch path (Aborted by user) and lib/codex-usage.ts isAbortError. A bare
					// new Error("Aborted") was opaque and dropped abortSignal.reason (#176).
					const abortError = (): Error => createAbortError(abortSignal);
					const sleep = (ms: number): Promise<void> =>
						new Promise((resolve, reject) => {
							if (abortSignal?.aborted) {
								reject(abortError());
								return;
							}

							const timeout = setTimeout(() => {
								cleanup();
								resolve();
							}, ms);

							const onAbort = () => {
								cleanup();
								reject(abortError());
							};

							const cleanup = () => {
								clearTimeout(timeout);
								abortSignal?.removeEventListener("abort", onAbort);
							};

							abortSignal?.addEventListener("abort", onAbort, { once: true });
						});

					const sleepWithCountdown = async (
						totalMs: number,
						message: string,
						intervalMs: number = 5000,
						probeUpstream?: () => Promise<boolean>,
					): Promise<void> => {
						const startTime = Date.now();
						const endTime = startTime + totalMs;
						let probeDelayMs = UPSTREAM_REPROBE_FIRST_DELAY_MS;
						let nextProbeAt =
							probeUpstream && totalMs >= UPSTREAM_REPROBE_MIN_WAIT_MS
								? startTime + probeDelayMs
								: Number.POSITIVE_INFINITY;

						while (Date.now() < endTime) {
							if (cachedAccountManager !== accountManager) return;
							if (abortSignal?.aborted) {
								throw abortError();
							}

							if (probeUpstream && Date.now() >= nextProbeAt) {
								if (await probeUpstream()) return;
								if (cachedAccountManager !== accountManager) return;
								if (abortSignal?.aborted) {
									throw abortError();
								}
								probeDelayMs = Math.min(probeDelayMs * 2, UPSTREAM_REPROBE_MAX_DELAY_MS);
								// Measured from the end of the probe, so a slow usage
								// request cannot schedule the next one in the past and
								// collapse the countdown sleep below to zero.
								nextProbeAt = Date.now() + probeDelayMs;
							}

							const remaining = Math.max(0, endTime - Date.now());
							const waitLabel = formatWaitTime(remaining);
							await showToast(
								`${message} (${waitLabel} remaining)`,
								"warning",
								{ duration: Math.min(intervalMs + 1000, toastDurationMs) },
							);

							const sleepTime = Math.min(intervalMs, remaining, nextProbeAt - Date.now());
							if (sleepTime > 0) {
								await sleep(sleepTime);
							} else {
								continue;
							}
						}
					};

					/**
					 * True when an all-accounts wait can stop early.
					 *
					 * `runNow` refreshes `/wham/usage` for every account and persists
					 * whatever it finds, so a reset that never touched local disk
					 * becomes visible here. Persisting a recovery also drops the cached
					 * manager, which is what makes the enclosing retry loop re-resolve
					 * one that no longer reports a block.
					 */
					const probeUpstreamBlockLifted = async (): Promise<boolean> => {
						try {
							await quotaMonitor.runNow();
						} catch (error) {
							logDebug(
								`[${PLUGIN_NAME}] Upstream quota re-probe failed: ${
									error instanceof Error ? error.message : String(error)
								}`,
							);
							return false;
						}
						if (cachedAccountManager !== accountManager) return true;
						const manager = accountManager;
						if (!manager) return false;
						return manager.getMinWaitTimeForFamily(modelFamily, model) === 0;
					};

							let allRateLimitedRetries = 0;
							let emptyResponseRetries = 0;
							const attemptedUnsupportedFallbackModels = new Set<string>();
							if (model) {
								attemptedUnsupportedFallbackModels.add(model);
							}

							// Degrading the model mid-request touches several coupled pieces:
							// the attempted-model set, the routing snapshot, the model's own
							// instructions, the reasoning clamp (only the 5.6 tiers accept
							// `max`, so an un-clamped sol -> gpt-5.5 hop turns a graceful
							// fallback into a hard 400) and the per-model body shape. Both the
							// entitlement fallback and the quota fallback go through here so
							// the two can never drift apart on any of them.
							const applyModelFallback = async (
								previousModel: string,
								target: string,
								reason: string,
							): Promise<void> => {
								attemptedUnsupportedFallbackModels.add(previousModel);
								attemptedUnsupportedFallbackModels.add(target);

								model = target;
								modelFamily = getModelFamily(model);
								quotaKey = `${modelFamily}:${model}`;
								fallbackApplied = true;
								fallbackFrom = previousModel;
								fallbackTo = model;
								fallbackReason = reason;
								const fallbackInstructions = await getCodexInstructions(model);

								if (transformedBody && typeof transformedBody === "object") {
									transformedBody = {
										...transformedBody,
										model,
										instructions: fallbackInstructions,
										input: upsertBackendModelIdentityMessage(
											transformedBody.input,
											model,
										),
									};
								} else {
									let fallbackBody: Record<string, unknown> = {
										model,
										instructions: fallbackInstructions,
									};
									if (requestInit?.body && typeof requestInit.body === "string") {
										try {
											const parsed = JSON.parse(requestInit.body) as Record<string, unknown>;
											fallbackBody = {
												...parsed,
												model,
												instructions: fallbackInstructions,
											};
											if (Array.isArray(fallbackBody.input)) {
												fallbackBody.input = upsertBackendModelIdentityMessage(
													fallbackBody.input,
													model,
												);
											}
										} catch {
											// Keep minimal fallback body if parsing fails.
										}
									}
									transformedBody = fallbackBody as RequestBody;
								}

								const clampedReasoning = clampReasoningForModel(
									transformedBody.reasoning,
									model,
								);
								if (clampedReasoning !== transformedBody.reasoning) {
									transformedBody = {
										...transformedBody,
										reasoning: clampedReasoning,
									};
								}

								requestInit = {
									...(requestInit ?? {}),
									body: JSON.stringify(shapeBodyForModel(transformedBody)),
								};
								if (runtimeMetrics.lastSelectionSnapshot) {
									runtimeMetrics.lastSelectionSnapshot = {
										...runtimeMetrics.lastSelectionSnapshot,
										family: modelFamily,
										model: model ?? null,
										requestedModel,
										effectiveModel: model ?? null,
										quotaKey,
										fallbackApplied,
										fallbackFrom,
										fallbackTo,
										fallbackReason,
									};
								}
							};

							// A degraded model must not degrade again without bound, even if a
							// custom chain is cyclic. See MAX_QUOTA_FALLBACK_SWITCHES.
							let quotaFallbackSwitches = 0;

							while (true) {
						if (cachedAccountManager && cachedAccountManager !== accountManager) {
							accountManager = cachedAccountManager;
						} else if (!cachedAccountManager) {
							// Reload through the shared accountManagerPromise so
							// concurrent requests (and the startup path above)
							// share one load. Racing independent loadFromDisk()
							// calls here can orphan the slower manager while an
							// in-flight request still holds it, and an orphaned
							// manager is never retired, so its next save would
							// write full membership and drop externally imported
							// accounts.
							if (accountManagerPromise === null) {
								const pending = AccountManager.loadFromDisk();
								accountManagerPromise = pending;
								void pending.catch(() => {
									if (accountManagerPromise === pending) accountManagerPromise = null;
								});
							}
						const loading: Promise<AccountManager> = accountManagerPromise;
						const reloaded = await loading;
						if (cachedAccountManager) {
							if (cachedAccountManager !== reloaded) {
								// The cache was repopulated while this load was in
								// flight (external reload after an invalidation).
								// The loaded manager is stale; retire it so its
								// debounced save cannot write full membership over
								// accounts imported after its snapshot was taken.
								reloaded.disposeShutdownHandler();
							}
							accountManager = cachedAccountManager;
						} else if (accountManager && isUntrustworthyEmptyReload(accountManager, reloaded)) {
							// The incumbent this request holds still has accounts, so
							// the empty result is a failed `loadAccounts()` read rather
							// than a real removal (same refusal as
							// reloadCachedAccountManager). Keep serving the incumbent
							// and drop the resolved promise so the next pass re-reads
							// disk instead of adopting this same empty manager.
							reloaded.disposeShutdownHandler();
							if (accountManagerPromise === loading) accountManagerPromise = null;
							logWarn(
								`[${PLUGIN_NAME}] Account reload returned no accounts while ${accountManager.getAccountCount()} are held; keeping the loaded pool and retrying`,
							);
							const incumbent = accountManager;
							scheduleEmptyReloadRetry(() => repopulateAccountManagerCache(incumbent));
						} else {
							cachedAccountManager = reloaded;
							accountManager = reloaded;
						}
						}
						const accountCount = accountManager.getAccountCount();
						const attempted = new Set<number>();
						// Diagnostics for the terminal error message below. The composite key keeps
						// legacy Business seats distinct and can also be compared with snapshots
						// after a mid-traversal account removal.
						// Deliberately scoped to this traversal: a fallback restart re-enters
						// the loop with a different model, and the message names that model.
						const fetchedAccountKeys = new Set<string>();
						const unsupportedAccountKeys = new Set<string>();
						let restartAccountTraversalWithFallback = false;
						let restartAccountTraversalAfterWorkspaceDeactivation = false;
						const preferredAccountIds = getModelAccountPool(pluginConfig, model);
						const accountPoolMode = getModelAccountPoolMode(pluginConfig, model);
						const strictAccountPool =
							preferredAccountIds.length > 0 && accountPoolMode === "strict";

			while (attempted.size < Math.max(1, accountCount)) {
				const selectionExplainability = accountManager.getSelectionExplainability(
					modelFamily,
					model,
					Date.now(),
				);
				runtimeMetrics.lastSelectionSnapshot = {
					timestamp: Date.now(),
					family: modelFamily,
					model: model ?? null,
					requestedModel,
					effectiveModel: model ?? null,
					selectedAccountIndex: null,
					quotaKey,
					explainability: selectionExplainability,
					fallbackApplied,
					fallbackFrom,
					fallbackTo,
					fallbackReason,
					configuredAccountPoolSize: preferredAccountIds.length,
					accountPoolMode: strictAccountPool ? "strict" : undefined,
				};
				const account = accountManager.getAccountForStrategy(
					rotationStrategy,
					modelFamily,
					model,
					{ pidOffsetEnabled },
					preferredAccountIds,
					accountPoolMode,
					attempted,
				);
				if (!account || attempted.has(account.index)) {
					break;
				}
							attempted.add(account.index);
							// Hybrid's last-resort result is not necessarily eligible. Requests
							// must honor active blocks rather than sending it upstream anyway.
							if (selectionExplainability.some((entry) => entry.index === account.index && !entry.eligible)) {
								continue;
							}
							runtimeMetrics.lastSelectedAccountIndex = account.index;
							runtimeMetrics.lastQuotaKey = quotaKey;
							if (runtimeMetrics.lastSelectionSnapshot) {
								runtimeMetrics.lastSelectionSnapshot = {
									...runtimeMetrics.lastSelectionSnapshot,
									requestedModel,
									effectiveModel: model ?? null,
									selectedAccountIndex: account.index,
									quotaKey,
									fallbackApplied,
									fallbackFrom,
									fallbackTo,
					fallbackReason,
					accountPoolMode:
						strictAccountPool
							? "strict"
							: preferredAccountIds.length === 0
							? "general"
							: preferredAccountIds.some((key) =>
									matchesModelPoolAccountKey(account, key),
								)
								? "preferred"
								: "general-fallback",
					configuredAccountPoolSize: preferredAccountIds.length,
				};
							}
							// Log account selection for debugging rotation
							logDebug(
								`Using account ${account.index + 1}/${accountCount}: ${account.email ?? "unknown"} for ${modelFamily}`,
							);

											let accountAuth = accountManager.toAuthDetails(account) as OAuthAuthDetails;
								try {
						if (shouldRefreshToken(accountAuth, tokenRefreshSkewMs)) {
							accountAuth = (await refreshAndUpdateToken(
								accountAuth,
								client,
								{
									organizationId: account.organizationId,
									accountId: account.accountId,
									accountUserId: account.accountUserId,
								},
							)) as OAuthAuthDetails;
							accountManager.updateFromAuth(account, accountAuth);
							accountManager.clearAuthFailures(account);
							accountManager.saveToDiskDebounced();
						}
			} catch (err) {
				logDebug(`[${PLUGIN_NAME}] Auth refresh failed for account: ${(err as Error)?.message ?? String(err)}`);
				if (
					!consumeRetryBudget(
						"authRefresh",
						`Auth refresh failed for account ${account.index + 1}`,
					)
				) {
					return new Response(
						JSON.stringify({
							error: {
								message:
									"Auth refresh retry budget exhausted for this request. Try again or switch accounts.",
							},
						}),
						{
							status: 503,
							headers: {
								"content-type": "application/json; charset=utf-8",
							},
						},
					);
				}
				runtimeMetrics.authRefreshFailures++;
				runtimeMetrics.failedRequests++;
				runtimeMetrics.accountRotations++;
				runtimeMetrics.lastError = (err as Error)?.message ?? String(err);
				runtimeMetrics.lastErrorCategory = "auth-refresh";

				// Transient refresh failures (network blip / upstream 5xx) must NOT
				// count toward disabling an account. Cool it down and rotate instead.
				const isTransientRefreshFailure =
					err instanceof CodexAuthError && err.retryable === true;
				if (isTransientRefreshFailure) {
					const cooledCount = accountManager.markAccountsWithRefreshTokenCoolingDown(
						account.refreshToken,
						ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
						"auth-failure",
					);
					if (cooledCount <= 0) {
						accountManager.markAccountCoolingDown(
							account,
							ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
							"auth-failure",
						);
					}
					accountManager.saveToDiskDebounced();
					logWarn(
						`[${PLUGIN_NAME}] Transient auth refresh failure for account ${account.index + 1} (${err.refreshFailureReason ?? "unknown"}${err.statusCode ? ` ${err.statusCode}` : ""}); cooling down without disabling.`,
					);
					continue;
				}

				const failures = await accountManager.incrementAuthFailures(account);
				const accountLabel = formatAccountLabel(account, account.index, {
					maskEmail: maskEmailEnabled,
					peerAccounts: accountManager.getAccountsSnapshot(),
				});
				
				if (failures >= ACCOUNT_LIMITS.MAX_AUTH_FAILURES_BEFORE_REMOVAL) {
					const disabledCount = accountManager.disableAccountsWithSameRefreshToken(account);
					if (disabledCount > 0) {
						accountManager.saveToDiskDebounced();
						await showToast(
							disabledCount > 1
								? `Disabled ${disabledCount} accounts after ${failures} auth failures; credentials retained. Run 'opencode auth login' to repair.`
								: `Disabled ${accountLabel} after ${failures} auth failures; credentials retained. Run 'opencode auth login' to repair.`,
							"error",
							{ duration: toastDurationMs * 2 },
						);
						continue;
					}
				}
				
				const cooledCount = accountManager.markAccountsWithRefreshTokenCoolingDown(
					account.refreshToken,
					ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
					"auth-failure",
				);
				if (cooledCount <= 0) {
					accountManager.markAccountCoolingDown(
						account,
						ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
						"auth-failure",
					);
				}
				accountManager.saveToDiskDebounced();
				continue;
			}

				const hadAccountId = !!account.accountId;
					const tokenAccountId = extractAccountId(accountAuth.access);
					const accountId = resolveRequestAccountId(
						account.accountId,
						account.accountIdSource,
						tokenAccountId,
					);
						if (!accountId) {
							accountManager.markAccountCoolingDown(
								account,
								ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
								"auth-failure",
							);
							accountManager.saveToDiskDebounced();
							continue;
						}
											account.accountId = accountId;
											if (!hadAccountId && tokenAccountId && accountId === tokenAccountId) {
												account.accountIdSource = account.accountIdSource ?? "token";
											}
											account.email =
												extractAccountEmail(accountAuth.access) ?? account.email;
											// Keep the persisted active identity in step with the account used
											// for this request so the TUI quota cache accepts the next real
											// response-header snapshot instead of filtering it as stale.
											accountManager.saveToDiskDebounced();

											if (
												accountToastsEnabled &&
												accountCount > 1 &&
												accountManager.shouldShowAccountToast(
													account.index,
													rateLimitToastDebounceMs,
												)
											) {
												const accountLabel = formatAccountLabel(account, account.index, {
													maskEmail: maskEmailEnabled,
													peerAccounts: accountManager.getAccountsSnapshot(),
												});
												await showToast(
													`Using ${accountLabel} (${account.index + 1}/${accountCount})`,
													"info",
												);
												accountManager.markToastShown(account.index);
											}

								const headers = createCodexHeaders(
									requestInit,
									accountId,
									accountAuth.access,
									{
										model,
										promptCacheKey,
										organizationId: account.organizationId,
									},
								);

								// Consume a token before making the request for proactive rate limiting
								const tokenConsumed = accountManager.consumeToken(account, modelFamily, model);
								if (!tokenConsumed) {
									// Local (in-memory, per-process) proactive limiter is depleted for
									// this account. The rotation selectors are token-bucket-aware, so
									// they will not re-select this account until a token refills — no
									// synthetic rate-limit window is written. Crucially we do NOT call
									// recordRateLimit() here: that records a server-429-style health
									// penalty and would mis-attribute a purely-local throttle as an
									// upstream rejection. We also must not persist any local-limiter
									// state (rateLimitResetTimes is written to the shared accounts file
									// and would spuriously rate-limit healthy accounts in other
									// processes). Just account the rotation and move on.
									runtimeMetrics.accountRotations++;
									runtimeMetrics.lastError =
										`Local token bucket depleted for account ${account.index + 1} (${modelFamily}${model ? `:${model}` : ""})`;
									runtimeMetrics.lastErrorCategory = "rate-limit-local";
									logWarn(
										`Skipping account ${account.index + 1}: local token bucket depleted for ${modelFamily}${model ? `:${model}` : ""}`,
									);
									// Skip THIS account and rotate to the next one. The selector's
									// token-bucket awareness guarantees it advances to an account with
									// quota (or returns null so the wait/retry path engages via the
									// token-refill wait in getMinWaitTimeForFamily). `break` would
									// abandon every other healthy account.
									continue;
								}

							// RC-8: per-(account, family) circuit-breaker key. The breaker gates
							// upstream calls so that repeated failures short-circuit to the
							// rotation path instead of hammering a degraded endpoint.
							const stableWorkspaceIdentity =
								account.accountId || account.accountUserId || account.organizationId
									? getWorkspaceIdentityKey(account)
									: undefined;
							const breakerOwner = stableWorkspaceIdentity
								? `identity-${createHash("sha256")
										.update(stableWorkspaceIdentity)
										.digest("hex")
										.slice(0, 16)}`
								: `index-${account.index}`;
							const circuitBreakerKey = `${accountId}:${breakerOwner}:${modelFamily}`;
							const circuitBreaker = getCircuitBreaker(circuitBreakerKey);

							while (true) {
								let response: Response;
								const fetchStart = performance.now();

								// RC-8: consult the breaker BEFORE firing upstream. When the gate is
								// closed every call passes through unchanged. When the gate denies
								// (open within cooldown, or half-open with a probe already in
								// flight) we short-circuit to the rotation path instead of
								// retrying here. We classify the short-circuit as `circuit-open`
								// so observability traces and the runtime metrics agree with the
								// `CircuitOpenError` type exported from `lib/errors.ts`.
								const breakerCheck = circuitBreaker.canAttempt();
								if (!breakerCheck.allowed) {
									const shortCircuitMessage = `Circuit ${breakerCheck.state} for ${circuitBreakerKey}`;
									logWarn(
										`[circuit-breaker] ${shortCircuitMessage} (reason=${breakerCheck.reason ?? "denied"}). Rotating account.`,
									);
									accountManager.refundToken(account, modelFamily, model);
									runtimeMetrics.accountRotations++;
									runtimeMetrics.lastError = shortCircuitMessage;
									runtimeMetrics.lastErrorCategory = "circuit-open";
									break;
								}

								// Merge user AbortSignal with timeout (Node 18 compatible - no AbortSignal.any)
								const fetchController = new AbortController();
								const requestTimeoutMs = fetchTimeoutMs;
								const fetchTimeoutId = setTimeout(
									() => fetchController.abort(new Error("Request timeout")),
									requestTimeoutMs,
								);

								const onUserAbort = abortSignal
									? () => fetchController.abort(abortSignal.reason ?? new Error("Aborted by user"))
									: null;

								if (abortSignal?.aborted) {
								clearTimeout(fetchTimeoutId);
								fetchController.abort(abortSignal.reason ?? new Error("Aborted by user"));
							} else if (abortSignal && onUserAbort) {
								abortSignal.addEventListener("abort", onUserAbort, { once: true });
							}

							try {
								// Request metrics are tracked at the fetch boundary, so retries and
								// account rotation are counted consistently. These increments are
								// in-memory only and run on Node's single-threaded event loop, so no
								// filesystem locking or token-redaction concerns are introduced here.
								runtimeMetrics.totalRequests++;
								fetchedAccountKeys.add(getAccountDiagnosticsKey(account));
								response = await fetch(url, {
									...requestInit,
									headers,
									signal: fetchController.signal,
									...(openAIBaseURL ? { redirect: "manual" as const } : {}),
								});
							} catch (networkError) {
								if (abortSignal?.aborted && fetchController.signal.aborted) {
									accountManager.refundToken(account, modelFamily, model);
									if (networkError instanceof Error) {
										throw networkError;
									}
									throw new Error(String(networkError));
								}
								const errorMsg = networkError instanceof Error ? networkError.message : String(networkError);
								logWarn(`Network error for account ${account.index + 1}: ${errorMsg}`);
								if (
									!consumeRetryBudget(
										"network",
										`Network error on account ${account.index + 1}: ${errorMsg}`,
									)
								) {
									accountManager.refundToken(account, modelFamily, model);
									return new Response(
										JSON.stringify({
											error: {
												message:
													"Network retry budget exhausted for this request. Try again in a moment.",
											},
										}),
										{
											status: 503,
											headers: {
												"content-type": "application/json; charset=utf-8",
											},
										},
									);
								}
								runtimeMetrics.failedRequests++;
								runtimeMetrics.networkErrors++;
								runtimeMetrics.accountRotations++;
								runtimeMetrics.lastError = errorMsg;
								runtimeMetrics.lastErrorCategory = "network";
								accountManager.refundToken(account, modelFamily, model);
								accountManager.recordFailure(account, modelFamily, model);
								// RC-8: network failures feed the breaker so a degraded upstream
								// trips the gate for this (account, family) key after N hits
								// inside the failure window.
								circuitBreaker.recordFailure();
								break;
							} finally {
								clearTimeout(fetchTimeoutId);
								if (abortSignal && onUserAbort) {
									abortSignal.removeEventListener("abort", onUserAbort);
								}
							}
							const fetchLatencyMs = Math.round(performance.now() - fetchStart);

							// `redirect: "manual"` hands back the raw 3xx instead of following it,
							// so it has to be rejected explicitly. Left alone it would reach
							// ensureContentType/convertSseToJson as an empty-bodied "success" and
							// be reported as a content-type or empty-response error that says
							// nothing about the redirect. Only the Location *origin* is logged;
							// the full target can carry credentials in its query string.
							if (openAIBaseURL && response.status >= 300 && response.status < 400) {
								let redirectTarget = "an unparseable location";
								const location = response.headers.get("location");
								if (location) {
									try {
										redirectTarget = new URL(location, url).origin;
									} catch {
										// keep the placeholder
									}
								} else {
									redirectTarget = "no location header";
								}
								logWarn(
									`OPENAI_BASE_URL gateway attempted a redirect (${response.status}) to ${redirectTarget}`,
									{ origin: new URL(openAIBaseURL).origin },
								);
								accountManager.refundToken(account, modelFamily, model);
								return new Response(
									JSON.stringify({
										error: {
											message:
												`The OPENAI_BASE_URL gateway responded with a ${response.status} redirect to ` +
												`${redirectTarget}. Redirects are not followed, because the ChatGPT OAuth ` +
												"access token must never be replayed to an endpoint that was not explicitly " +
												"configured. Point OPENAI_BASE_URL at the final endpoint instead.",
										},
									}),
									{
										status: 502,
										headers: {
											"content-type": "application/json; charset=utf-8",
										},
									},
								);
							}

							logRequest(LOG_STAGES.RESPONSE, {
								status: response.status,
								ok: response.ok,
								statusText: response.statusText,
								latencyMs: fetchLatencyMs,
								headers: Object.fromEntries(response.headers.entries()),
							});
							// The TUI snapshot and the durable rotation block read the same
							// `x-codex-*` headers, so they share one authority decision — gating
							// only the block would leave the status line reporting "0% left" for
							// an account the router considers healthy.
							const recordQuotaHeaders = (): boolean => {
								void recordPromptQuotaHeaders(
									response,
									account,
									accountCount,
									accountManager.getAccountsSnapshot(),
								);
								return applyQuotaExhaustion(
									accountManager,
									response.headers,
									account,
									modelFamily,
									model,
								);
							};

							if (response.ok) {
								recordQuotaHeaders();
							} else {
									const contextOverflowResult = await handleContextOverflow(response, model);
									if (contextOverflowResult.handled) {
										return contextOverflowResult.response;
									}

					const {
						response: errorResponse,
						rateLimit,
						errorBody,
						retryAsServerError,
						quotaHeadersAuthoritative,
					} = await handleErrorResponse(response, {
						requestCorrelationId,
						threadId: threadIdCandidate,
					});
					const quotaExhausted =
						quotaHeadersAuthoritative === true && recordQuotaHeaders();

			const workspaceDeactivated = isDeactivatedWorkspaceError(errorBody, response.status);
				if (workspaceDeactivated) {
					const accountLabel = formatAccountLabel(account, account.index, {
						maskEmail: maskEmailEnabled,
						peerAccounts: accountManager.getAccountsSnapshot(),
					});
					accountManager.refundToken(account, modelFamily, model);
					accountManager.recordFailure(account, modelFamily, model);
				account.lastSwitchReason = "rotation";
				runtimeMetrics.failedRequests++;
				runtimeMetrics.accountRotations++;
				runtimeMetrics.lastError = `Deactivated workspace on ${accountLabel}`;
				runtimeMetrics.lastErrorCategory = "workspace-deactivated";

				try {
					const flaggedRecord: FlaggedAccountMetadataV1 = {
						...account,
						flaggedAt: Date.now(),
						flaggedReason: "workspace-deactivated",
						lastError: DEACTIVATED_WORKSPACE_ERROR_CODE,
					};
					await withFlaggedAccountStorageTransaction(async (current, persist) => {
						const nextStorage: typeof current = {
							...current,
							accounts: current.accounts.map((flagged) => ({ ...flagged })),
						};
						upsertFlaggedAccountRecord(nextStorage.accounts, flaggedRecord);
						await persist(nextStorage);
					});
				} catch (flagError) {
					logWarn(
						`Failed to persist deactivated workspace flag for ${accountLabel}: ${flagError instanceof Error ? flagError.message : String(flagError)}`,
					);
				}

					// Disable ONLY the deactivated workspace, scoped by workspace
					// identity (org/account id). A single multi-org OAuth login
					// produces sibling accounts that share one refresh token but are
					// independently valid; disabling all refresh-token siblings here
					// would silently drop still-valid workspaces from rotation. The
					// refresh token itself is still good, so siblings must survive.
					const disabledCount = accountManager.disableAccountsByWorkspaceIdentity(account);
					if (disabledCount > 0) {
						accountManager.saveToDiskDebounced();
						restartAccountTraversalAfterWorkspaceDeactivation = true;
						const removalMessage = disabledCount > 1
							? `Workspace deactivated. Disabled ${disabledCount} related entries; credentials retained.`
							: `Workspace deactivated. Disabled ${accountLabel}; credentials retained.`;
						await showToast(
							removalMessage,
							"warning",
							{ duration: toastDurationMs },
						);
						break;
					}

					accountManager.markAccountCoolingDown(
						account,
						ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
						"auth-failure",
					);
					accountManager.saveToDiskDebounced();
					break;
				}

			const unsupportedModelInfo = getUnsupportedCodexModelInfo(errorBody);
			if (unsupportedModelInfo.isUnsupported) {
				unsupportedAccountKeys.add(getAccountDiagnosticsKey(account));
			}
			const hasRemainingAccounts = attempted.size < Math.max(1, accountCount);

			// Entitlements can differ by account/workspace, so try remaining
			// accounts before degrading the model via fallback.
			if (unsupportedModelInfo.isUnsupported && hasRemainingAccounts) {
				const blockedModel =
					unsupportedModelInfo.unsupportedModel ?? model ?? "requested model";
				accountManager.refundToken(account, modelFamily, model);
				accountManager.recordFailure(account, modelFamily, model);
				account.lastSwitchReason = "rotation";
				runtimeMetrics.lastError = `Unsupported model on account ${account.index + 1}: ${blockedModel}`;
				runtimeMetrics.lastErrorCategory = "unsupported-model";
				logWarn(
					`Model ${blockedModel} is unsupported for account ${account.index + 1}. Trying next account/workspace before fallback.`,
					{
						unsupportedCodexPolicy,
						requestedModel: blockedModel,
						effectiveModel: blockedModel,
						fallbackApplied: false,
						fallbackReason: "retry-unsupported-model-entitlement",
					},
				);
				break;
			}

			const fallbackModel = resolveUnsupportedCodexFallbackModel({
				requestedModel: model,
				errorBody,
				attemptedModels: attemptedUnsupportedFallbackModels,
				fallbackOnUnsupportedCodexModel,
				fallbackToGpt52OnUnsupportedGpt53,
				customChain: unsupportedCodexFallbackChain,
			});

			if (fallbackModel) {
				const previousModel = model ?? "gpt-5-codex";
				const previousModelFamily = modelFamily;
				accountManager.refundToken(account, previousModelFamily, previousModel);
				await applyModelFallback(
					previousModel,
					fallbackModel,
					"fallback-unsupported-model-entitlement",
				);
				runtimeMetrics.lastError = `Model fallback: ${previousModel} -> ${model}`;
				runtimeMetrics.lastErrorCategory = "model-fallback";
				logWarn(
					`Model ${previousModel} is unsupported for this ChatGPT account. Falling back to ${model}.`,
					{
						unsupportedCodexPolicy,
						requestedModel: previousModel,
						effectiveModel: model,
						fallbackApplied: true,
						fallbackReason: "fallback-unsupported-model-entitlement",
					},
				);
				await showToast(
					`Model ${previousModel} is not available for this account. Retrying with ${model}.`,
					"warning",
					{ duration: toastDurationMs },
				);
				restartAccountTraversalWithFallback = true;
				break;
			}

			if (unsupportedModelInfo.isUnsupported && !fallbackOnUnsupportedCodexModel) {
				const blockedModel =
					unsupportedModelInfo.unsupportedModel ?? model ?? "requested model";
				fallbackApplied = false;
				fallbackFrom = blockedModel;
				fallbackTo = null;
				fallbackReason = "blocked-unsupported-model-entitlement";
				if (runtimeMetrics.lastSelectionSnapshot) {
					runtimeMetrics.lastSelectionSnapshot = {
						...runtimeMetrics.lastSelectionSnapshot,
						requestedModel,
						effectiveModel: model ?? null,
						quotaKey,
						fallbackApplied,
						fallbackFrom,
						fallbackTo,
						fallbackReason,
					};
				}
				runtimeMetrics.lastError = `Unsupported model (strict): ${blockedModel}`;
				runtimeMetrics.lastErrorCategory = "unsupported-model";
				logWarn(
					`Model ${blockedModel} is unsupported for this ChatGPT account. Strict policy blocks automatic fallback.`,
					{
						unsupportedCodexPolicy,
						requestedModel: blockedModel,
						effectiveModel: blockedModel,
						fallbackApplied: false,
						fallbackReason: "blocked-unsupported-model-entitlement",
					},
				);
				await showToast(
					`Model ${blockedModel} is not available for this account. Strict policy blocked automatic fallback.`,
					"warning",
					{ duration: toastDurationMs },
				);
			}

			if (recoveryHook && errorBody && isRecoverableError(errorBody)) {
					const errorType = detectErrorType(errorBody);
					const toastContent = getRecoveryToastContent(errorType);
					await showToast(
						`${toastContent.title}: ${toastContent.message}`,
						"warning",
						{ duration: toastDurationMs },
					);
						logDebug(`[${PLUGIN_NAME}] Recoverable error detected: ${errorType}`);
					}

					// Handle 5xx server errors, and exact overload payloads flagged by
					// handleErrorResponse, by rotating to another account.
					if (retryAsServerError || (response.status >= 500 && response.status < 600)) {
						if (retryAsServerError && rateLimit) {
							accountManager.markRateLimitedWithReason(
								account,
								rateLimit.retryAfterMs,
								modelFamily,
								parseRateLimitReason(rateLimit.code),
								model,
							);
							account.lastSwitchReason = "rate-limit";
							accountManager.saveToDiskDebounced();
						}
						const retryableServerLabel =
							retryAsServerError && response.status < 500
								? `Retryable server overload (HTTP ${response.status})`
								: `Server error ${response.status}`;
						logWarn(
							`${retryableServerLabel} for account ${account.index + 1}. Rotating to next account.`,
						);
						runtimeMetrics.failedRequests++;
						runtimeMetrics.serverErrors++;
						runtimeMetrics.accountRotations++;
						runtimeMetrics.lastError = retryableServerLabel;
						runtimeMetrics.lastErrorCategory = "server";
						accountManager.refundToken(account, modelFamily, model);
						accountManager.recordFailure(account, modelFamily, model);
						// RC-8: 5xx responses are treated the same as network failures by
						// the breaker — they indicate an upstream fault rather than a
						// client-side classifier decision (401/403/404/429 are handled
						// upstream and do not feed the breaker).
						circuitBreaker.recordFailure();
						if (
							!consumeRetryBudget(
								"server",
								`Server error ${response.status} on account ${account.index + 1}`,
							)
						) {
							return errorResponse;
						}
						break;
					}

					if (rateLimit) {
																														runtimeMetrics.rateLimitedResponses++;
																														const { attempt, delayMs } = getRateLimitBackoff(
																															account.index,
																															quotaKey,
																															rateLimit.retryAfterMs,
																														);
																														const waitLabel = formatWaitTime(delayMs);

																														// A spent window will still be spent in a second, and the block
																														// just written for it is monotonic — a short retry that happened
																														// to succeed could not walk it back, so the account would serve
																														// traffic while rotation still considers it blocked. Rotate.
																														if (
																															!quotaExhausted &&
																															delayMs <= RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS &&
																															consumeRetryBudget(
																																"rateLimitShort",
																																`Short 429 retry for account ${account.index + 1} after ${delayMs}ms`,
																															)
																														) {
																																if (
																																	accountManager.shouldShowAccountToast(
																																		account.index,
																																		rateLimitToastDebounceMs,
																																		)
																																) {
																									await showToast(
																										`Rate limited. Retrying in ${waitLabel} (attempt ${attempt})...`,
																										"warning",
																										{ duration: toastDurationMs },
																									);
																																			accountManager.markToastShown(account.index);
								}

															await sleep(addJitter(Math.max(MIN_BACKOFF_MS, delayMs), 0.2));
															continue;
																																}

				// Authoritative subscription exhaustion already has its own block.
				// Do not duplicate its reset as a model/family transient 429; retain
				// any genuine transient state written by other in-flight requests.
				if (!quotaExhausted) {
					accountManager.markRateLimitedWithReason(
						account,
						delayMs,
						modelFamily,
						parseRateLimitReason(rateLimit.code),
						model,
					);
				}
				accountManager.recordRateLimit(account, modelFamily, model);
				account.lastSwitchReason = "rate-limit";
				runtimeMetrics.accountRotations++;
				runtimeMetrics.lastErrorCategory = "rate-limit";
				accountManager.saveToDiskDebounced();
						logWarn(
							`Rate limited. Rotating account ${account.index + 1} (${account.email ?? "unknown"}).`,
						);

																														if (
																															accountManager.getAccountCount() > 1 &&
																															accountManager.shouldShowAccountToast(
																																account.index,
																																rateLimitToastDebounceMs,
																																)
																														) {
																									await showToast(
																										`Rate limited. Switching accounts (retry in ${waitLabel}).`,
																										"warning",
																										{ duration: toastDurationMs },
																									);
																																	accountManager.markToastShown(account.index);
																																}
																														break;
																													}
																													// A 401 token-invalidated response means the access token presented for
																													// THIS account was rejected by the backend even though the proactive
																													// refresh above either ran or judged the token still fresh. Without an
																													// explicit handler the 401 fell straight through to `return errorResponse`
																													// below, so persisted family routing kept pinning every request to the dead
																													// account slot instead of failing over (issue #171). Treat it as an
																				// account-health failure: cool the refresh-token group down (or disable it
																													// past the failure threshold) and rotate to the next healthy account.
																													//
																													// Note: 401s intentionally do NOT feed the circuit breaker — the breaker
																													// guards against upstream faults (network / 5xx), not client-side auth
																													// decisions (see the 5xx handler above).
																													if (isInvalidatedAuthTokenError(errorBody, response.status)) {
																														const accountLabel = formatAccountLabel(account, account.index, {
																															maskEmail: maskEmailEnabled,
																															peerAccounts: accountManager.getAccountsSnapshot(),
																														});
																														accountManager.refundToken(account, modelFamily, model);
																														accountManager.recordFailure(account, modelFamily, model);
																														account.lastSwitchReason = "rotation";
																														runtimeMetrics.failedRequests++;
																														runtimeMetrics.accountRotations++;
																														runtimeMetrics.lastError = `Auth token invalidated on ${accountLabel}`;
																														runtimeMetrics.lastErrorCategory = "auth-invalidated";

																														const failures = await accountManager.incrementAuthFailures(account);
																				if (failures >= ACCOUNT_LIMITS.MAX_AUTH_FAILURES_BEFORE_REMOVAL) {
																					const disabledCount =
																						accountManager.disableAccountsWithSameRefreshToken(account);
																					if (disabledCount > 0) {
																						accountManager.saveToDiskDebounced();
																						await showToast(
																							disabledCount > 1
																								? `Disabled ${disabledCount} accounts after ${failures} auth-token failures; credentials retained. Run 'opencode auth login' to repair.`
																								: `Disabled ${accountLabel} after ${failures} auth-token failures; credentials retained. Run 'opencode auth login' to repair.`,
																							"error",
																							{ duration: toastDurationMs * 2 },
																						);
																						break;
																					}
																				}

																				// Below the disable threshold (or the group was already disabled): cool the
																														// account's whole refresh-token group down so selection skips it, then
																														// rotate to the next healthy account instead of returning the 401.
																														const cooledCount = accountManager.markAccountsWithRefreshTokenCoolingDown(
																															account.refreshToken,
																															ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
																															"auth-failure",
																														);
																														if (cooledCount <= 0) {
																															accountManager.markAccountCoolingDown(
																																account,
																																ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
																																"auth-failure",
																															);
																														}
																														accountManager.saveToDiskDebounced();
																														logWarn(
																															accountCount > 1
																																? `Auth token invalidated for account ${account.index + 1}. Cooling down and rotating to next account.`
																																: `Auth token invalidated for account ${account.index + 1}. Cooling down; no other account available.`,
																														);
																														if (
																															accountCount > 1 &&
																															accountManager.shouldShowAccountToast(account.index, rateLimitToastDebounceMs)
																														) {
																															await showToast(
																																`Account ${account.index + 1} sign-in expired. Switching accounts.`,
																																"warning",
																																{ duration: toastDurationMs },
																															);
																															accountManager.markToastShown(account.index);
																														}
																														break;
																													}

																													runtimeMetrics.failedRequests++;
																													runtimeMetrics.lastError = `HTTP ${response.status}`;
																													runtimeMetrics.lastErrorCategory = "http";
																													return errorResponse;
																											}

					resetRateLimitBackoff(account.index, quotaKey);
					runtimeMetrics.cumulativeLatencyMs += fetchLatencyMs;
					let successResponse: Response;
					try {
						successResponse = await handleSuccessResponse(response, isStreaming, {
							streamStallTimeoutMs,
						});
					} catch (streamError) {
						// A stream stall or SSE-parse failure happened AFTER a token was
						// consumed (line ~token-consume above). Without this catch the
						// exception escaped both loops, leaking the consumed token and
						// skipping account rotation. Refund, mark the breaker/account
						// failed, and rotate to the next account.
						accountManager.refundToken(account, modelFamily, model);
						accountManager.recordFailure(account, modelFamily, model);
						circuitBreaker.recordFailure();
						account.lastSwitchReason = "rotation";
						runtimeMetrics.failedRequests++;
						runtimeMetrics.accountRotations++;
						runtimeMetrics.lastError =
							streamError instanceof Error ? streamError.message : String(streamError);
						runtimeMetrics.lastErrorCategory = "stream";
						logWarn(
							`Stream/response handling failed for account ${account.index + 1}: ${runtimeMetrics.lastError}. Rotating.`,
						);
						// Account for the server-class retry budget, then rotate.
						consumeRetryBudget("server", "Stream/response handling failure");
						break;
					}

					if (!successResponse.ok) {
						runtimeMetrics.failedRequests++;
						runtimeMetrics.lastError = `HTTP ${successResponse.status}`;
						runtimeMetrics.lastErrorCategory = "http";
						return successResponse;
					}

					if (!isStreaming && emptyResponseMaxRetries > 0) {
						const clonedResponse = successResponse.clone();
						try {
							const bodyText = await clonedResponse.text();
							const parsedBody = bodyText ? JSON.parse(bodyText) as unknown : null;
							if (isEmptyResponse(parsedBody)) {
								if (
									emptyResponseRetries < emptyResponseMaxRetries &&
									consumeRetryBudget(
										"emptyResponse",
										`Empty response retry ${emptyResponseRetries + 1}/${emptyResponseMaxRetries}`,
									)
								) {
									emptyResponseRetries++;
									runtimeMetrics.emptyResponseRetries++;
									logWarn(`Empty response received (attempt ${emptyResponseRetries}/${emptyResponseMaxRetries}). Retrying...`);
									await showToast(
										`Empty response. Retrying (${emptyResponseRetries}/${emptyResponseMaxRetries})...`,
										"warning",
										{ duration: toastDurationMs },
									);
									await sleep(addJitter(emptyResponseRetryDelayMs, 0.2));
									// Re-issue against the SAME account by re-entering the inner
									// request loop. Using `break` here exited to account rotation,
									// which is a no-op for single-account pools and surfaced a
									// misleading "all accounts failed" 503 instead of retrying.
									continue;
								}
								logWarn(`Empty response after ${emptyResponseMaxRetries} retries. Returning as-is.`);
							}
						} catch {
							// Intentionally empty: non-JSON response bodies should be returned as-is
						}
					}

					accountManager.recordSuccess(account, modelFamily, model);
					// A successful request proves the account's credentials are good
					// again, so reset the auth-failure counter that a prior 401
					// token-invalidated response (or refresh failure) may have bumped.
					// Otherwise stale counts could accumulate across requests and
					// eventually remove a now-healthy account.
					accountManager.clearAuthFailures(account);
					// RC-8: closes a half-open gate or prunes the failure window so a
					// sequence of successes keeps the breaker healthy.
					circuitBreaker.recordSuccess();
					runtimeMetrics.successfulRequests++;
					runtimeMetrics.lastError = null;
					runtimeMetrics.lastErrorCategory = null;
						return successResponse;
																								}
						if (restartAccountTraversalWithFallback) {
							break;
						}
						if (restartAccountTraversalAfterWorkspaceDeactivation) {
							break;
						}
						}

						if (restartAccountTraversalWithFallback) {
							continue;
						}
						if (restartAccountTraversalAfterWorkspaceDeactivation) {
							continue;
						}

						// Shared by both terminal messages below: how many distinct accounts
						// this traversal actually sent upstream, and how many of those the
						// backend rejected as not entitled to the model.
						const attemptedCount = fetchedAccountKeys.size;
						const unsupportedCount = unsupportedAccountKeys.size;

						if (strictAccountPool) {
							const poolWaitMs = accountManager.getMinWaitTimeForFamily(
								modelFamily,
								model,
								preferredAccountIds,
							);
							const effectiveModel = model ?? requestedModel ?? "requested model";
							const accountSnapshot = accountManager.getAccountsSnapshot();
							const poolAccounts = accountSnapshot.filter((account) =>
								preferredAccountIds.some((key) =>
									matchesModelPoolAccountKey(account, key),
								),
							);
							const poolAccountCount = poolAccounts.length;
							const unresolvedKeyCount = countUnresolvedPoolKeys(
								accountSnapshot,
								preferredAccountIds,
							);
							const unavailableCount = poolAccounts.filter(
								(account) => !fetchedAccountKeys.has(getAccountDiagnosticsKey(account)),
							).length;
							const waitDetail =
								poolWaitMs > 0
									? ` Try again in ${formatWaitTime(poolWaitMs)}.`
									: " Check the pooled accounts with `codex-health`.";
							const attemptDetail =
								unsupportedCount > 0
									? ` The model was unsupported on ${unsupportedCount} of ${attemptedCount} attempted pooled account(s).`
									: attemptedCount > 0
										? ` ${attemptedCount} pooled account(s) were attempted without success.`
										: "";
							const unresolvedDetail =
								unresolvedKeyCount > 0
									? ` ${unresolvedKeyCount} configured pool key(s) matched no known account.`
									: "";
							const unavailableDetail =
								unavailableCount > 0
									? ` ${unavailableCount} pooled account(s) were never attempted (rate-limited, cooling down, or disabled).`
									: "";
							const message =
								`Strict account pool unavailable for ${effectiveModel}. ` +
								`${preferredAccountIds.length} configured pool key(s) resolved to ${poolAccountCount} account(s).` +
								attemptDetail +
								unresolvedDetail +
								unavailableDetail +
								waitDetail;
							if (runtimeMetrics.lastSelectionSnapshot) {
								runtimeMetrics.lastSelectionSnapshot = {
									...runtimeMetrics.lastSelectionSnapshot,
									accountPoolMode: "strict-unavailable",
								};
							}
							runtimeMetrics.failedRequests++;
							runtimeMetrics.lastError = message;
							runtimeMetrics.lastErrorCategory = "strict-pool-unavailable";
							return new Response(
								JSON.stringify({
									error: {
										code: "strict_pool_unavailable",
										message,
									},
								}),
								{
									status: poolWaitMs > 0 ? 429 : 503,
									headers: {
										"content-type": "application/json; charset=utf-8",
									},
								},
							);
						}

								const waitMs = accountManager.getMinWaitTimeForFamily(modelFamily, model);
								const count = accountManager.getAccountCount();
								// Counted over the accounts that are still live rather than as
								// `count - attemptedCount`: an account removed mid-traversal was
								// genuinely attempted but is no longer one of the `count`
								// configured accounts, and that arithmetic would hide a live
								// account that never got a turn.
								const unavailableCount = accountManager
									.getAccountsSnapshot()
									.filter(
										(account) =>
											!fetchedAccountKeys.has(getAccountDiagnosticsKey(account)),
									).length;

								const enabledSelection = count > 0 ? accountManager
									.getSelectionExplainability(modelFamily, model)
									.filter((entry) => entry.enabled) : [];
								const upstreamBlocked = enabledSelection.length > 0 && enabledSelection.every(
									(entry) => entry.rateLimitedUntil !== undefined || entry.quotaExhaustedUntil !== undefined,
								);

								// Every enabled account has an active upstream block. Before waiting out a
								// block that can run for days (`retryAllAccountsMaxRetries`
								// defaults to Infinity), degrade to the next chain model that is
								// actually usable right now. Gated exactly like the entitlement
								// auto-fallback -- same default-selector entry models, same
								// opt-out env vars -- even when an entry ID was selected directly.
								// Local token depletion and auth cooldown alone never trigger it.
								// An account-wide quota block fails the eligibility test
								// on every candidate, so it correctly falls through to the wait.
								if (
									upstreamBlocked &&
									waitMs > 0 &&
									count > 0 &&
									model &&
									quotaFallbackSwitches < MAX_QUOTA_FALLBACK_SWITCHES &&
									isDefaultAutoFallbackModel(
										model,
										attemptedUnsupportedFallbackModels,
									)
								) {
									const rejected = new Set<string>();
									let usableFallback: string | undefined;
									while (true) {
										const candidate = pickFallbackChainTarget({
											currentModel: model,
											attemptedModels: new Set([
												...attemptedUnsupportedFallbackModels,
												...rejected,
											]),
											customChain: unsupportedCodexFallbackChain,
											fallbackToGpt52OnUnsupportedGpt53,
										});
										if (!candidate || rejected.has(candidate)) break;
										// Only degrade to a model some account can serve NOW,
										// otherwise the hop just moves the same block sideways.
										const candidatePool = getModelAccountPool(pluginConfig, candidate);
										const strictCandidatePool = candidatePool.length > 0 &&
											getModelAccountPoolMode(pluginConfig, candidate) === "strict";
										const candidateAccounts = accountManager.getAccountsSnapshot();
										const candidateEligible = accountManager.getSelectionExplainability(
											getModelFamily(candidate), candidate,
										).some((entry) => entry.eligible && (!strictCandidatePool ||
											candidateAccounts.some((account) => account.index === entry.index &&
												candidatePool.some((key) => matchesModelPoolAccountKey(account, key)))));
									// A preferred pool may spill into general accounts; a strict
									// pool must contain an eligible member. This does not select
									// an account or advance any rotation cursor.
										if (candidateEligible) {
											usableFallback = candidate;
											break;
										}
										rejected.add(candidate);
									}

									if (usableFallback) {
										const previousModel = model;
										quotaFallbackSwitches++;
										await applyModelFallback(
											previousModel,
											usableFallback,
											"fallback-quota-exhausted",
										);
										runtimeMetrics.lastError = `Model fallback: ${previousModel} -> ${model}`;
										runtimeMetrics.lastErrorCategory = "model-fallback";
										logWarn(
											`All ${count} account(s) are rate-limited or out of quota for ${previousModel}. Falling back to ${model}.`,
											{
												requestedModel: previousModel,
												effectiveModel: model,
												fallbackApplied: true,
												fallbackReason: "fallback-quota-exhausted",
											},
										);
										continue;
									}
								}

								if (
									retryAllAccountsRateLimited &&
									count > 0 &&
									waitMs > 0 &&
									(retryAllAccountsMaxWaitMs === 0 ||
										waitMs <= retryAllAccountsMaxWaitMs) &&
									allRateLimitedRetries < retryAllAccountsMaxRetries &&
									consumeRetryBudget(
										"rateLimitGlobal",
										`All accounts rate-limited wait ${waitMs}ms`,
										waitMs,
									)
								) {
									const countdownMessage = `All ${count} account(s) rate-limited. Waiting`;
									await sleepWithCountdown(
										addJitter(waitMs, 0.2),
										countdownMessage,
										undefined,
										probeUpstreamBlockLifted,
									);
									allRateLimitedRetries++;
									continue;
								}

								const waitLabel = waitMs > 0 ? formatWaitTime(waitMs) : "a bit";
								// `runtimeMetrics` is plugin-scoped, so `lastErrorCategory` alone
								// can still hold "unsupported-model" from an *earlier* request.
								// Require an unsupported response from this traversal as well, or
								// a request that never reached an account renders "0 of 0".
								const wasEntitlementExhaustion =
									unsupportedCount > 0 &&
									runtimeMetrics.lastErrorCategory === "unsupported-model";
								const entitlementModel =
									typeof runtimeMetrics.lastError === "string"
										? runtimeMetrics.lastError.replace(
												/^Unsupported model.*?:\s*/i,
												"",
											).trim()
										: "";
								const entitlementDetail =
									entitlementModel.length > 0
										? ` The backend rejected '${entitlementModel}' as not entitled for Codex OAuth on ${unsupportedCount} of ${attemptedCount} attempted account(s).${unavailableCount > 0 ? ` ${unavailableCount} configured account(s) were unavailable or excluded.` : ""}`
										: "";
								const message =
									count === 0
										? "No Codex accounts configured. Run `opencode auth login`."
										: waitMs > 0
											? `All ${count} account(s) are rate-limited. Try again in ${waitLabel} or add another account with \`opencode auth login\`.`
											: wasEntitlementExhaustion
												? `No selectable account succeeded for the requested model across ${count} configured account(s).${entitlementDetail} Codex model access is account/workspace gated; default gpt-5.6-sol/terra/luna selectors auto-fallback down the 5.6 tiers to gpt-5.5, and gpt-5.5/gpt-5-codex through the GPT-5.4 family when possible. Set \`unsupportedCodexPolicy: "fallback"\` for the full manual fallback chain, or see \`codex-health\` for per-account details.`
												: `All ${count} account(s) failed (server errors or auth issues). Check account health with \`codex-health\`.`;
								runtimeMetrics.failedRequests++;
								runtimeMetrics.lastError = message;
								runtimeMetrics.lastErrorCategory =
									waitMs > 0
										? "rate-limit"
										: wasEntitlementExhaustion
											? "unsupported-model"
											: "account-failure";
								return new Response(JSON.stringify({ error: { message } }), {
									status: waitMs > 0 ? 429 : 503,
											headers: {
												"content-type": "application/json; charset=utf-8",
											},
										});
									}
						} finally {
							if (pendingFetch) activeFetches.delete(pendingFetch);
							finishFetch?.();
							clearCorrelationId();
						}
										},
                                };
				} finally {
					resolveMutex?.();
					loaderMutex = null;
				}
                        },
				methods: [
					{
						label: AUTH_LABELS.OAUTH,
						type: "oauth" as const,
						authorize: async (inputs?: Record<string, string>) => {
							const authPluginConfig = loadPluginConfig();
							applyUiRuntimeFromConfig(authPluginConfig);
							const authPerProjectAccounts = getPerProjectAccounts(authPluginConfig);
							setStoragePath(authPerProjectAccounts ? directory : null);

							const accounts: TokenSuccessWithAccount[] = [];
							// Programmatic input, not a menu choice: a headless caller or
							// script passes it to say "never launch a browser". Ignoring it
							// would silently do the opposite — enter the multi-account loop,
							// try to launch a browser, and bind port 1455 — and would also
							// drop the replaceAll semantics the manual path carries.
							const noBrowser =
								inputs?.noBrowser === "true" ||
								inputs?.["no-browser"] === "true";
							const explicitLoginMode =
								inputs?.loginMode === "fresh" || inputs?.loginMode === "add"
									? inputs.loginMode
									: null;

							let startFresh = explicitLoginMode === "fresh";
							let refreshAccountIndex: number | undefined;

							const clampActiveIndices = (storage: AccountStorageV3): void => {
								const count = storage.accounts.length;
								if (count === 0) {
									storage.activeIndex = 0;
									storage.activeIndexByFamily = {};
									return;
								}
								storage.activeIndex = Math.max(0, Math.min(storage.activeIndex, count - 1));
								storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
								for (const family of MODEL_FAMILIES) {
									const raw = storage.activeIndexByFamily[family];
									const candidate =
										typeof raw === "number" && Number.isFinite(raw) ? raw : storage.activeIndex;
									storage.activeIndexByFamily[family] = Math.max(0, Math.min(candidate, count - 1));
								}
							};

							const isFlaggableFailure = (failure: Extract<TokenResult, { type: "failed" }>): boolean => {
								if (failure.reason === "missing_refresh") return true;
								if (failure.statusCode === 401) return true;
								if (failure.statusCode !== 400) return false;
								const message = (failure.message ?? "").toLowerCase();
								return (
									message.includes("invalid_grant") ||
									message.includes("invalid refresh") ||
									message.includes("token has been revoked")
								);
							};

							const authQuotaDisplay = getQuotaDisplay(authPluginConfig);
							const formatCodexQuotaLine = (usage: CodexUsageSummary): string => {
								const parts: string[] = [];
								for (const window of [usage.primary, usage.secondary]) {
									if (!hasUsageWindow(window)) continue;
									parts.push(
										`${formatUsageLimitTitle(window.windowMinutes)} ${formatUsageLimitSummary(window, authQuotaDisplay)}`,
									);
								}
								if (hasUsageWindow(usage.codeReview)) {
									parts.push(
										`Code review ${formatUsageLimitSummary(usage.codeReview, authQuotaDisplay)}`,
									);
								}
								for (const limit of usage.additionalLimits) {
									if (hasUsageWindow(limit.window)) {
										parts.push(
											`${limit.name} ${formatUsageLimitSummary(limit.window, authQuotaDisplay)}`,
										);
									}
								}
								const planLabel = formatPlanType(usage.planType);
								if (planLabel) parts.push(`plan:${planLabel}`);
								if (usage.credits) parts.push(`credits:${usage.credits}`);
								return parts.length > 0 ? parts.join(", ") : "quota unavailable";
							};

							const runAccountCheck = async (deepProbe: boolean): Promise<void> => {
								const loadedStorage = await hydrateEmails(await loadAccounts());
								const workingStorage = loadedStorage
									? {
										...loadedStorage,
										accounts: loadedStorage.accounts.map((account) => ({ ...account })),
										activeIndexByFamily: loadedStorage.activeIndexByFamily
											? { ...loadedStorage.activeIndexByFamily }
											: {},
									}
									: { version: 3 as const, accounts: [], activeIndex: 0, activeIndexByFamily: {} };

								if (workingStorage.accounts.length === 0) {
									console.log("\nNo accounts to check.\n");
									return;
								}

								let storageChanged = false;
								let flaggedChanged = false;
								const flaggedUpdates = new Map<string, FlaggedAccountMetadataV1>();
								const removeFromActive = new Set<string>();
								const total = workingStorage.accounts.length;
								let ok = 0;
								let disabled = 0;
								let errors = 0;
								const maskEmailEnabled = getCodexTuiMaskEmail(loadPluginConfig());

								console.log(
									`\nChecking ${deepProbe ? "full account health" : "quotas"} for all accounts...\n`,
								);

								for (let i = 0; i < total; i += 1) {
									const account = workingStorage.accounts[i];
									if (!account) continue;
									const label =
										account.accountLabel?.trim() ||
										resolveDisplayEmail(account.email, maskEmailEnabled) ||
										`Account ${i + 1}`;
									if (account.enabled === false) {
										disabled += 1;
										console.log(`[${i + 1}/${total}] ${label}: DISABLED`);
										continue;
									}

									try {
										// If we already have a valid cached access token, don't force-refresh.
										// This avoids flagging accounts where the refresh token has been burned
										// but the access token is still valid (same behavior as Codex CLI).
										const nowMs = Date.now();
										let accessToken: string | null = null;
										let tokenAccountId: string | undefined = undefined;
										let authDetail = "OK";
										if (
											account.accessToken &&
											(typeof account.expiresAt !== "number" ||
												!Number.isFinite(account.expiresAt) ||
												account.expiresAt > nowMs)
										) {
											accessToken = account.accessToken;
											authDetail = "OK (cached access)";

											tokenAccountId = extractAccountId(account.accessToken);
											if (
												tokenAccountId &&
												shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId) &&
												tokenAccountId !== account.accountId
											) {
												account.accountId = tokenAccountId;
												account.accountIdSource = "token";
												storageChanged = true;
											}

										}

										// If Codex CLI has a valid cached access token for this email, use it
										// instead of forcing a refresh.
										if (!accessToken) {
											const cached = await lookupCodexCliTokensByEmail(account.email);
											if (
												cached &&
												(typeof cached.expiresAt !== "number" ||
													!Number.isFinite(cached.expiresAt) ||
													cached.expiresAt > nowMs)
											) {
												accessToken = cached.accessToken;
												authDetail = "OK (Codex CLI cache)";

												if (cached.refreshToken && cached.refreshToken !== account.refreshToken) {
													account.refreshToken = cached.refreshToken;
													storageChanged = true;
												}
												if (cached.accessToken && cached.accessToken !== account.accessToken) {
													account.accessToken = cached.accessToken;
													storageChanged = true;
												}
												if (cached.expiresAt !== account.expiresAt) {
													account.expiresAt = cached.expiresAt;
													storageChanged = true;
												}

												const hydratedEmail = sanitizeEmail(
													extractAccountEmail(cached.accessToken),
												);
												if (hydratedEmail && hydratedEmail !== account.email) {
													account.email = hydratedEmail;
													storageChanged = true;
												}

												tokenAccountId = extractAccountId(cached.accessToken);
												if (
													tokenAccountId &&
													shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId) &&
													tokenAccountId !== account.accountId
												) {
													account.accountId = tokenAccountId;
													account.accountIdSource = "token";
													storageChanged = true;
												}
											}
										}

										if (!accessToken) {
											const refreshResult = await coordinatePersistedRefresh(account);
											if (refreshResult.type !== "success") {
												errors += 1;
												const message =
													refreshResult.message ?? refreshResult.reason ?? "refresh failed";
												console.log(`[${i + 1}/${total}] ${label}: ERROR (${message})`);
												if (deepProbe && isFlaggableFailure(refreshResult)) {
													const flaggedRecord: FlaggedAccountMetadataV1 = {
														...account,
														flaggedAt: Date.now(),
														flaggedReason: "token-invalid",
														lastError: message,
													};
													flaggedUpdates.set(
														getWorkspaceIdentityKey(flaggedRecord),
														flaggedRecord,
													);
													removeFromActive.add(getWorkspaceIdentityKey(account));
													flaggedChanged = true;
												}
												continue;
											}

											accessToken = refreshResult.access;
											authDetail = "OK";
											if (refreshResult.refresh !== account.refreshToken) {
												account.refreshToken = refreshResult.refresh;
												storageChanged = true;
											}
											// Carry the coordinator's rotation stamp onto the working
											// copy so the merge below can tell this snapshot's token
											// apart from one a concurrent process rotated later.
											if (
												typeof refreshResult.rotatedAt === "number" &&
												refreshResult.rotatedAt !== account.tokenRotatedAt
											) {
												account.tokenRotatedAt = refreshResult.rotatedAt;
												storageChanged = true;
											}
											if (refreshResult.access && refreshResult.access !== account.accessToken) {
												account.accessToken = refreshResult.access;
												storageChanged = true;
											}
											if (
												typeof refreshResult.expires === "number" &&
												refreshResult.expires !== account.expiresAt
											) {
												account.expiresAt = refreshResult.expires;
												storageChanged = true;
											}
											if (refreshResult.scope && refreshResult.scope !== account.oauthScope) {
												account.oauthScope = refreshResult.scope;
												storageChanged = true;
											}
											const hydratedEmail = sanitizeEmail(
												extractAccountEmail(refreshResult.access, refreshResult.idToken),
											);
											if (hydratedEmail && hydratedEmail !== account.email) {
												account.email = hydratedEmail;
												storageChanged = true;
											}
											tokenAccountId = extractAccountId(refreshResult.access);
											if (
												tokenAccountId &&
												shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId) &&
												tokenAccountId !== account.accountId
											) {
												account.accountId = tokenAccountId;
												account.accountIdSource = "token";
												storageChanged = true;
											}
										}

										if (!accessToken) {
											throw new Error("Missing access token after refresh");
										}

										if (deepProbe) {
											ok += 1;
											// Both read from the probed token, so the pair is the seat
											// the credential actually belongs to. The workspace id
											// alone repeats across every member of a Business
											// workspace and cannot confirm which seat answered.
											const tokenSeat = formatSeatSuffix(
												extractAccountUserId(accessToken),
												workingStorage.accounts.map(
													(peer) => peer?.accountUserId,
												),
											);
											const identity = [
												tokenAccountId ? `id:${tokenAccountId.slice(-6)}` : undefined,
												tokenSeat ? `seat:${tokenSeat}` : undefined,
											].filter((part): part is string => part !== undefined);
											const detail =
												identity.length > 0
													? `${authDetail} (${identity.join(", ")})`
													: authDetail;
											console.log(`[${i + 1}/${total}] ${label}: ${detail}`);
											continue;
										}

										try {
											const requestAccountId =
												resolveRequestAccountId(
													account.accountId,
													account.accountIdSource,
													tokenAccountId,
												) ??
												tokenAccountId ??
												account.accountId;

											if (!requestAccountId) {
												throw new Error("Missing accountId for quota probe");
											}

											const payload = await fetchCodexUsage({
												accountId: requestAccountId,
												accessToken,
												organizationId: account.organizationId,
												normalizeAccountErrors: true,
											});
											const usage = parseCodexUsagePayload(payload, authQuotaDisplay);
											ok += 1;
											console.log(
												`[${i + 1}/${total}] ${label}: ${formatCodexQuotaLine(usage)}`,
											);
										} catch (error) {
											errors += 1;
											const message = error instanceof Error ? error.message : String(error);
											if (isDeactivatedWorkspaceErrorMessage(message)) {
												const flaggedRecord: FlaggedAccountMetadataV1 = {
													...account,
													flaggedAt: Date.now(),
													flaggedReason: "workspace-deactivated",
													lastError: message,
												};
												flaggedUpdates.set(
													getWorkspaceIdentityKey(flaggedRecord),
													flaggedRecord,
												);
												removeFromActive.add(getWorkspaceIdentityKey(account));
												flaggedChanged = true;
											} else if (isInvalidatedAuthTokenMessage(message)) {
												// The cached access token probed OK locally but the backend
												// rejected it (401 invalidated). Surface it so `codex-doctor
												// --fix` repairs the active routing instead of leaving a dead
												// slot selected (issue #171).
												const flaggedRecord: FlaggedAccountMetadataV1 = {
													...account,
													flaggedAt: Date.now(),
													flaggedReason: "token-invalid",
													lastError: message,
												};
												flaggedUpdates.set(
													getWorkspaceIdentityKey(flaggedRecord),
													flaggedRecord,
												);
												removeFromActive.add(getWorkspaceIdentityKey(account));
												flaggedChanged = true;
											}
											console.log(
												`[${i + 1}/${total}] ${label}: ERROR (${message.slice(0, 160)})`,
											);
										}
									} catch (error) {
										errors += 1;
										const message = error instanceof Error ? error.message : String(error);
										console.log(`[${i + 1}/${total}] ${label}: ERROR (${message.slice(0, 120)})`);
									}
								}

								if (removeFromActive.size > 0) {
									workingStorage.accounts = workingStorage.accounts.filter(
										(account) => !removeFromActive.has(getWorkspaceIdentityKey(account)),
									);
									clampActiveIndices(workingStorage);
									storageChanged = true;
								}

								if (storageChanged) {
									// Persist under the storage lock against a fresh snapshot so
									// concurrent saves during the (long) health-check network loop
									// are not clobbered. Re-apply this run's per-account quota/state
									// updates by workspace identity and re-apply removals.
									const workingByIdentity = new Map(
										workingStorage.accounts.map((account) => [
											getWorkspaceIdentityKey(account),
											account,
										]),
									);
									await withAccountStorageTransaction(async (current, persist) => {
										if (!current) {
											// No on-disk state to merge into; fall back to the working copy.
											await persist(workingStorage);
											return;
										}
										const merged: typeof current.accounts = [];
										for (const acc of current.accounts) {
											const identity = getWorkspaceIdentityKey(acc);
											if (removeFromActive.has(identity)) continue;
											const updated = workingByIdentity.get(identity);
											if (updated) {
												// Carry forward ONLY the token/identity fields this health
												// check refreshes. Labels, tags, notes, and rate-limit /
												// cooldown state stay as the fresh snapshot has them so a
												// concurrent edit during the network loop is not reverted.
												acc.accountId = updated.accountId;
												acc.accountIdSource = updated.accountIdSource;
												acc.oauthScope = updated.oauthScope;
												acc.email = updated.email;
												// The credential triple is single-use and must only move
												// backwards-in-time never. `workingStorage` was snapshotted
												// before the (multi-second) network loop, so its token can
												// already be consumed: a sibling's refresh rotates every
												// record sharing that token *on disk*, and a concurrent
												// process can rotate it too. Writing the stale token back
												// would resurrect a dead credential and cost the user a
												// re-login with `refresh_token_reused`.
												const workingRotatedAt = updated.tokenRotatedAt ?? 0;
												const diskRotatedAt = acc.tokenRotatedAt ?? 0;
												if (workingRotatedAt >= diskRotatedAt) {
													acc.refreshToken = updated.refreshToken;
													acc.accessToken = updated.accessToken;
													acc.expiresAt = updated.expiresAt;
													acc.tokenRotatedAt = updated.tokenRotatedAt;
												}
											}
											merged.push(acc);
										}
										current.accounts = merged;
										clampActiveIndices(current);
										await persist(current);
									});
									invalidateAccountManagerCache();
								}
								if (flaggedChanged) {
									await withFlaggedAccountStorageTransaction(async (current, persist) => {
										const nextStorage: typeof current = {
											...current,
											accounts: current.accounts.map((flagged) => ({ ...flagged })),
										};
										for (const flaggedRecord of flaggedUpdates.values()) {
											upsertFlaggedAccountRecord(nextStorage.accounts, flaggedRecord);
										}
										await persist(nextStorage);
									});
								}

								console.log("");
								console.log(`Results: ${ok} ok, ${errors} error, ${disabled} disabled`);
								if (removeFromActive.size > 0) {
									console.log(
										`Moved ${removeFromActive.size} account(s) to flagged pool.`,
									);
								}
								console.log("");
							};

							const verifyFlaggedAccounts = async (): Promise<void> => {
								const flaggedStorage = await loadFlaggedAccounts();
								if (flaggedStorage.accounts.length === 0) {
									console.log("\nNo flagged accounts to verify.\n");
									return;
								}

								console.log("\nVerifying flagged accounts...\n");
								const maskEmailEnabled = getCodexTuiMaskEmail(loadPluginConfig());
							const remaining: FlaggedAccountMetadataV1[] = [];
							const restored: TokenSuccessWithAccount[] = [];
							const processedIdentityKeys = new Set(
								flaggedStorage.accounts.map((account) => getWorkspaceIdentityKey(account)),
							);
							const processedRefreshTokens = new Set(
								flaggedStorage.accounts.map((account) => account.refreshToken),
							);
							// Only a record we positively restored may be deleted below. A record
							// can *look* processed without having been restored — its token can be
							// rotated in place by a sibling's refresh, so neither replacement
							// lookup finds it — and dropping that record would erase the account
							// from flagged-accounts.json with no trace anywhere.
							const restoredIdentityKeys = new Set<string>();
							const restoredRefreshTokens = new Set<string>();

								for (let i = 0; i < flaggedStorage.accounts.length; i += 1) {
									const flagged = flaggedStorage.accounts[i];
									if (!flagged) continue;
									const label =
										flagged.accountLabel?.trim() ||
										resolveDisplayEmail(flagged.email, maskEmailEnabled) ||
										`Flagged ${i + 1}`;
									if (flagged.flaggedReason === "workspace-deactivated") {
										console.log(
											`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: STILL FLAGGED (workspace deactivated)`,
										);
										remaining.push(flagged);
										continue;
									}
									try {
										const cached = await lookupCodexCliTokensByEmail(flagged.email);
										const now = Date.now();
										if (
											cached &&
											typeof cached.expiresAt === "number" &&
											Number.isFinite(cached.expiresAt) &&
											cached.expiresAt > now
										) {
											const refreshToken =
												typeof cached.refreshToken === "string" && cached.refreshToken.trim()
													? cached.refreshToken.trim()
													: flagged.refreshToken;
										const resolved = applyAccountSelectionFallbacks(
											resolveAccountSelection({
												type: "success",
												access: cached.accessToken,
												refresh: refreshToken,
												expires: cached.expiresAt,
												multiAccount: true,
											}),
											{
												accountIdOverride: flagged.accountId,
												accountIdSource: flagged.accountIdSource ?? "manual",
												organizationIdOverride: flagged.organizationId,
												accountLabel: flagged.accountLabel,
											},
										);
										restored.push(...resolved.variantsForPersistence);
										restoredIdentityKeys.add(getWorkspaceIdentityKey(flagged));
										restoredRefreshTokens.add(flagged.refreshToken);
										console.log(
												`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: RESTORED (Codex CLI cache)`,
										);
											continue;
										}

										const refreshResult = await coordinateFlaggedPersistedRefresh(flagged);
										if (refreshResult.type !== "success") {
											console.log(
												`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: STILL FLAGGED (${refreshResult.message ?? refreshResult.reason ?? "refresh failed"})`,
											);
											remaining.push(flagged);
											continue;
										}

									const resolved = applyAccountSelectionFallbacks(
										resolveAccountSelection(refreshResult),
										{
											accountIdOverride: flagged.accountId,
											accountIdSource: flagged.accountIdSource ?? "manual",
											organizationIdOverride: flagged.organizationId,
											accountLabel: flagged.accountLabel,
										},
									);
									restored.push(...resolved.variantsForPersistence);
									processedRefreshTokens.add(refreshResult.refresh);
									restoredIdentityKeys.add(getWorkspaceIdentityKey(flagged));
									restoredRefreshTokens.add(flagged.refreshToken);
									console.log(`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: RESTORED`);
									} catch (error) {
										const message = error instanceof Error ? error.message : String(error);
										console.log(
											`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: ERROR (${message.slice(0, 120)})`,
										);
										remaining.push({
											...flagged,
											lastError: message,
										});
									}
								}

								if (restored.length > 0) {
									await persistAccountPool(restored, false);
									invalidateAccountManagerCache();
								}

							const remainingByIdentity = new Map(
								remaining.map((account) => [getWorkspaceIdentityKey(account), account]),
							);
							const remainingByRefreshToken = new Map(
								remaining.map((account) => [account.refreshToken, account]),
							);
							await withFlaggedAccountStorageTransaction(async (current, persist) => {
								current.accounts = current.accounts.flatMap((account) => {
									const identityKey = getWorkspaceIdentityKey(account);
									const processed =
										processedIdentityKeys.has(identityKey) ||
										processedRefreshTokens.has(account.refreshToken);
									if (!processed) return [account];
									const replacement =
										remainingByIdentity.get(identityKey) ??
										remainingByRefreshToken.get(account.refreshToken);
									if (replacement) {
										return [{ ...account, lastError: replacement.lastError }];
									}
									// Drop only what was positively restored. Anything else that
									// merely looks processed is kept: a stale flagged entry is
									// recoverable, a silently deleted account is not.
									const wasRestored =
										restoredIdentityKeys.has(identityKey) ||
										restoredRefreshTokens.has(account.refreshToken);
									return wasRestored ? [] : [account];
								});
								await persist(current);
							});

								console.log("");
								console.log(`Results: ${restored.length} restored, ${remaining.length} still flagged`);
								console.log("");
							};

							if (!explicitLoginMode) {
								while (true) {
									const loadedStorage = await hydrateEmails(await loadAccounts());
									const workingStorage = loadedStorage
										? {
											...loadedStorage,
											accounts: loadedStorage.accounts.map((account) => ({ ...account })),
											activeIndexByFamily: loadedStorage.activeIndexByFamily
												? { ...loadedStorage.activeIndexByFamily }
												: {},
										}
										: { version: 3 as const, accounts: [], activeIndex: 0, activeIndexByFamily: {} };
									const flaggedStorage = await loadFlaggedAccounts();

									if (workingStorage.accounts.length === 0 && flaggedStorage.accounts.length === 0) {
										break;
									}

									const now = Date.now();
									const activeIndex = resolveActiveIndex(workingStorage, "codex");
									const existingAccounts = workingStorage.accounts.map((account, index) => {
										let status: "active" | "ok" | "rate-limited" | "cooldown" | "disabled";
										if (account.enabled === false) {
											status = "disabled";
										} else if (
											typeof account.coolingDownUntil === "number" &&
											account.coolingDownUntil > now
										) {
											status = "cooldown";
										} else if (formatRateLimitEntry(account, now)) {
											status = "rate-limited";
										} else if (index === activeIndex) {
											status = "active";
										} else {
											status = "ok";
										}
										return {
											accountId: account.accountId,
											accountUserId: account.accountUserId,
											accountLabel: account.accountLabel,
											email: account.email,
											index,
											addedAt: account.addedAt,
											lastUsed: account.lastUsed,
											status,
											isCurrentAccount: index === activeIndex,
											enabled: account.enabled !== false,
										};
									});

									const maskEmailEnabled = getCodexTuiMaskEmail(loadPluginConfig());
									const menuResult = await promptLoginMode(existingAccounts, {
										flaggedCount: flaggedStorage.accounts.length,
										maskEmail: maskEmailEnabled,
									});

									if (menuResult.mode === "cancel") {
										return {
											url: "",
											instructions: "Authentication cancelled",
											method: "auto",
											callback: () =>
												Promise.resolve({
													type: "failed" as const,
												}),
										};
									}

									if (menuResult.mode === "check") {
										await runAccountCheck(false);
										continue;
									}
									if (menuResult.mode === "deep-check") {
										await runAccountCheck(true);
										continue;
									}
									if (menuResult.mode === "verify-flagged") {
										await verifyFlaggedAccounts();
										continue;
									}

									if (menuResult.mode === "manage") {
										if (typeof menuResult.deleteAccountIndex === "number") {
										const target = workingStorage.accounts[menuResult.deleteAccountIndex];
										if (target) {
											const identityKey = getWorkspaceIdentityKey(target);
											await withAccountStorageTransaction(async (current, persist) => {
												if (!current) return;
												const currentIndex = current.accounts.findIndex(
													(candidate) => getWorkspaceIdentityKey(candidate) === identityKey,
												);
												if (currentIndex < 0) return;
												current.accounts.splice(currentIndex, 1);
												clampActiveIndices(current);
												await persist(current);
											});
											await withFlaggedAccountStorageTransaction(async (current, persist) => {
												current.accounts = current.accounts.filter(
													(flagged) => !matchesWorkspaceIdentity(flagged, identityKey),
												);
												await persist(current);
											});
												invalidateAccountManagerCache();
												console.log(`\nDeleted ${resolveDisplayEmail(target.email, maskEmailEnabled) ?? `Account ${menuResult.deleteAccountIndex + 1}`}.\n`);
											}
											continue;
										}

										if (typeof menuResult.toggleAccountIndex === "number") {
										const target = workingStorage.accounts[menuResult.toggleAccountIndex];
										if (target) {
											const identityKey = getWorkspaceIdentityKey(target);
											let enabled = target.enabled !== false;
											await withAccountStorageTransaction(async (current, persist) => {
												const currentTarget = current?.accounts.find(
													(candidate) => getWorkspaceIdentityKey(candidate) === identityKey,
												);
												if (!current || !currentTarget) return;
												currentTarget.enabled = currentTarget.enabled === false;
												enabled = currentTarget.enabled;
												await persist(current);
											});
											invalidateAccountManagerCache();
											console.log(
												`\n${resolveDisplayEmail(target.email, maskEmailEnabled) ?? `Account ${menuResult.toggleAccountIndex + 1}`} ${enabled ? "enabled" : "disabled"}.\n`,
												);
											}
											continue;
										}

										if (typeof menuResult.refreshAccountIndex === "number") {
											refreshAccountIndex = menuResult.refreshAccountIndex;
											startFresh = false;
											break;
										}

										continue;
									}

									if (menuResult.mode === "fresh") {
										startFresh = true;
										if (menuResult.deleteAll) {
											await clearAccounts();
											await clearFlaggedAccounts();
											invalidateAccountManagerCache();
											console.log("\nDeleted all accounts. Starting fresh.\n");
										}
										break;
									}

									startFresh = false;
									break;
								}
							}

							const latestStorage = await loadAccounts();
							const existingCount = latestStorage?.accounts.length ?? 0;
							const requestedCount = Number.parseInt(inputs?.accountCount ?? "1", 10);
							const normalizedRequested = Number.isFinite(requestedCount) ? requestedCount : 1;
							const availableSlots =
								refreshAccountIndex !== undefined
									? 1
									: startFresh
										? ACCOUNT_LIMITS.MAX_ACCOUNTS
										: ACCOUNT_LIMITS.MAX_ACCOUNTS - existingCount;

							if (availableSlots <= 0) {
								return {
									url: "",
									instructions: "Account limit reached. Remove an account or start fresh.",
									method: "auto",
									callback: () =>
										Promise.resolve({
											type: "failed" as const,
										}),
								};
							}

							let targetCount = Math.max(1, Math.min(normalizedRequested, availableSlots));
							if (refreshAccountIndex !== undefined) {
								targetCount = 1;
							}
							if (noBrowser) {
								targetCount = 1;
								// Paste-the-code, not the loopback listener: this is the one
								// path that needs neither a browser on this host nor a
								// reachable localhost:1455 from wherever the browser runs.
								const { pkce, state, url } = await createAuthorizationFlow();
								return buildManualOAuthFlow(pkce, url, state, startFresh);
							}

							const explicitCountProvided =
								typeof inputs?.accountCount === "string" && inputs.accountCount.trim().length > 0;

							while (accounts.length < targetCount) {
								logInfo(`=== OpenAI OAuth (Account ${accounts.length + 1}) ===`);
								const forceNewLogin = accounts.length > 0 || refreshAccountIndex !== undefined;
								const result = await runOAuthFlow(forceNewLogin);

								let selection: AccountSelectionResult | null = null;
								let resolved: TokenSuccessWithAccount | null = null;
								if (result.type === "success") {
									selection = resolveAccountSelection(result);
									resolved = selection.primary;
									const email = extractAccountEmail(resolved.access, resolved.idToken);
									const accountId = resolved.accountIdOverride ?? extractAccountId(resolved.access);
									const label = resolved.accountLabel ?? email ?? accountId ?? "Unknown account";
									logInfo(`Authenticated as: ${label}`);

									const isDuplicate = accounts.some(
										(account) =>
											(accountId &&
												(account.accountIdOverride ?? extractAccountId(account.access)) === accountId) ||
											(email && extractAccountEmail(account.access, account.idToken) === email),
									);

									if (isDuplicate) {
										logWarn(`WARNING: duplicate account login detected (${label}). Existing entry will be updated.`);
									}
								}

								if (result.type === "failed") {
									if (accounts.length === 0) {
										return {
											url: "",
											instructions: result.message ?? "Authentication failed.",
											method: "auto",
											callback: () => Promise.resolve(result),
										};
									}
									logWarn(`[${PLUGIN_NAME}] Skipping failed account ${accounts.length + 1}`);
									break;
								}

								if (!selection || !resolved) {
									continue;
								}

								accounts.push(resolved);
								await showToast(`Account ${accounts.length} authenticated`, "success");

								const isFirstAccount = accounts.length === 1;
								await persistResolvedAccountSelection(selection, {
									persistSelections: persistAuthenticatedSelections,
									replaceAll: isFirstAccount && startFresh,
								});

								if (accounts.length >= ACCOUNT_LIMITS.MAX_ACCOUNTS) {
									break;
								}

								if (
									!explicitCountProvided &&
									refreshAccountIndex === undefined &&
									accounts.length < availableSlots &&
									accounts.length >= targetCount
								) {
									const addMore = await promptAddAnotherAccount(accounts.length);
									if (addMore) {
										targetCount = Math.min(targetCount + 1, availableSlots);
										continue;
									}
									break;
								}
							}

							const primary = accounts[0];
							if (!primary) {
								return {
									url: "",
									instructions: "Authentication cancelled",
									method: "auto",
									callback: () =>
										Promise.resolve({
											type: "failed" as const,
										}),
								};
							}

							let actualAccountCount = accounts.length;
							try {
								const finalStorage = await loadAccounts();
								if (finalStorage) {
									actualAccountCount = finalStorage.accounts.length;
								}
							} catch (err) {
								logWarn(
									`[${PLUGIN_NAME}] Failed to load final account count: ${(err as Error)?.message ?? String(err)}`,
								);
							}

							return {
								url: "",
								instructions: `Multi-account setup complete (${actualAccountCount} account(s)).`,
								method: "auto",
								callback: () => Promise.resolve(primary),
							};
						},
					},
					{
						label: AUTH_LABELS.OAUTH_MANUAL_BROWSER,
						type: "oauth" as const,
						authorize: async () => {
							// Must happen BEFORE the callback persists, to ensure correct
							// storage location: OpenCode invokes callback() separately from
							// authorize(), so the path has to be pinned here.
							const manualBrowserPluginConfig = loadPluginConfig();
							applyUiRuntimeFromConfig(manualBrowserPluginConfig);
							const manualBrowserPerProjectAccounts = getPerProjectAccounts(manualBrowserPluginConfig);
							setStoragePath(manualBrowserPerProjectAccounts ? directory : null);

							const session = await startLoopbackFlow({ openBrowser: false });
							if (session.type === "unavailable") {
								const message = unavailableMessage(session.lifecycle);
								logWarn(`\n[${PLUGIN_NAME}] ${message}\n`);
								return {
									url: "",
									instructions: message,
									method: "auto" as const,
									callback: () =>
										Promise.resolve({
											type: "failed" as const,
											reason: "invalid_response" as const,
											message,
										}),
								};
							}

							return {
								url: session.url,
								instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL_BROWSER,
								method: "auto" as const,
								callback: async () => {
									const result = await session.waitAndExchange();
									if (result.type === "cancelled") {
										return {
											type: "failed" as const,
											reason: "unknown" as const,
											message: callbackCancelledMessage(),
										};
									}
									if (result.type !== "success") {
										return result;
									}
									const resolved = await resolveAndPersistAccountSelection(result, {
										persistSelections: persistAuthenticatedSelections,
										replaceAll: false,
									});
									return resolved.primary;
								},
							};
						},
					},
					{
						label: AUTH_LABELS.OAUTH_DEVICE_CODE,
						type: "oauth" as const,
						authorize: async () => {
							const devicePluginConfig = loadPluginConfig();
							applyUiRuntimeFromConfig(devicePluginConfig);
							const devicePerProjectAccounts = getPerProjectAccounts(devicePluginConfig);
							setStoragePath(devicePerProjectAccounts ? directory : null);

							const started = await createDeviceCodeSession();
							if (started.type === "failed") {
								return {
									url: "",
									instructions: started.failure.message ?? "Device code login could not be started.",
									method: "auto" as const,
									callback: () => Promise.resolve(started.failure),
								};
							}

							return {
								url: started.session.verificationUrl,
								instructions: buildDeviceCodeInstructions(started.session),
								method: "auto" as const,
								callback: async () => {
									const result = await completeDeviceCodeSession(started.session);
									if (result.type !== "success") {
										return result;
									}

									const selection = await resolveAndPersistAccountSelection(result, {
										persistSelections: persistAuthenticatedSelections,
										replaceAll: false,
									});
									return selection.primary;
								},
							};
						},
					},

					{
						label: AUTH_LABELS.OAUTH_MANUAL,
						type: "oauth" as const,
						authorize: async () => {
							// Must happen BEFORE the callback persists, to ensure correct
							// storage location: OpenCode invokes callback() separately from
							// authorize(), so the path has to be pinned here.
							const manualPluginConfig = loadPluginConfig();
							applyUiRuntimeFromConfig(manualPluginConfig);
							const manualPerProjectAccounts = getPerProjectAccounts(manualPluginConfig);
							setStoragePath(manualPerProjectAccounts ? directory : null);

							const { pkce, state, url } = await createAuthorizationFlow();
							return buildManualOAuthFlow(pkce, url, state, false);
						},
					},
				],
                },
                tool: createToolRegistry(ctx),
	};
};

export const OpenAIAuthPlugin = OpenAIOAuthPlugin;

export default {
	id: "oc-codex-multi-auth",
	server: OpenAIOAuthPlugin,
	/** V2 loads the same package through setup instead of the V1 server hook. */
	async setup(context: import("@opencode/plugin").Plugin.Context) {
		const { setupV2 } = await import("./lib/opencode-v2.js");
		return setupV2(context, createPluginRuntime);
	},
};

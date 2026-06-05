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
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import {
        createAuthorizationFlow,
        exchangeAuthorizationCode,
        parseAuthorizationInput,
        REDIRECT_URI,
} from "./lib/auth/auth.js";
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
import { queuedRefresh } from "./lib/refresh-queue.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
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
	getPerProjectAccounts,
	getEmptyResponseMaxRetries,
	getEmptyResponseRetryDelayMs,
	getPidOffsetEnabled,
	getFetchTimeoutMs,
	getStreamStallTimeoutMs,
	getCodexTuiV2,
	getCodexTuiColorProfile,
	getCodexTuiGlyphMode,
	getBeginnerSafeMode,
	getCodexTuiMaskEmail,
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
import { checkAndNotify } from "./lib/auto-update-checker.js";
import { handleContextOverflow } from "./lib/context-overflow.js";
import {
	AccountManager,
	type AccountSelectionExplainability,
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
import { resolveDisplayEmail } from "./lib/account-display.js";
import {
	getStoragePath,
	loadAccounts,
	saveAccounts,
	clearAccounts,
	setStoragePath,
	loadFlaggedAccounts,
	saveFlaggedAccounts,
	withFlaggedAccountStorageTransaction,
	clearFlaggedAccounts,
	getWorkspaceIdentityKey,
	StorageError,
	formatStorageErrorHint,
	type AccountStorageV3,
	type FlaggedAccountMetadataV1,
} from "./lib/storage.js";
import {
	createCodexHeaders,
	extractRequestUrl,
        handleErrorResponse,
        handleSuccessResponse,
	isDeactivatedWorkspaceError,
	getUnsupportedCodexModelInfo,
	resolveUnsupportedCodexFallbackModel,
        refreshAndUpdateToken,
        rewriteUrlForCodex,
	shouldRefreshToken,
	transformRequestForCodex,
} from "./lib/request/fetch-helpers.js";
import {
	createDeactivatedWorkspaceError,
	DEACTIVATED_WORKSPACE_ERROR_CODE,
	isDeactivatedWorkspaceErrorMessage,
} from "./lib/error-sentinels.js";
import {
	applyFastSessionDefaults,
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
import { createUsageAccountFingerprint } from "./lib/codex-usage.js";
import {
	clearTuiQuotaSnapshot,
	parseTuiQuotaSnapshotFromHeaders,
	writeTuiQuotaSnapshot,
} from "./lib/tui-quota-cache.js";

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
 
export const OpenAIOAuthPlugin: Plugin = async ({ client }: PluginInput) => {
	initLogger(client);
	let cachedAccountManager: AccountManager | null = null;
	let accountManagerPromise: Promise<AccountManager> | null = null;
	let loaderMutex: Promise<void> | null = null;
	let startupPrewarmTriggered = false;
	let startupPreflightShown = false;
	let beginnerSafeModeEnabled = false;
	const MIN_BACKOFF_MS = 100;

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
				accountLabel?: string;
				accountTags?: string[];
				accountNote?: string;
			};
			label?: string;
		} = {},
	): Record<string, unknown> => ({
		index: index + 1,
		zeroBasedIndex: index,
		...(options.includeSensitive
			? {
					label:
						options.label ?? formatCommandAccountLabel(options.account, index),
					email: options.account?.email ?? null,
					accountId: options.account?.accountId ?? null,
				}
			: {}),
	});

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

		const buildManualOAuthFlow = (
			pkce: { verifier: string },
			url: string,
			expectedState: string,
			replaceAll: boolean,
		) => ({
                url,
                method: "code" as const,
                instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
                validate: (input: string): string | undefined => {
                        const parsed = parseAuthorizationInput(input);
                        if (!parsed.code) {
                                return "No authorization code found. Paste the full callback URL (e.g., http://localhost:1455/auth/callback?code=...). If browser callback keeps failing, retry with Device Code.";
                        }
                        if (!parsed.state) {
                                return "Missing OAuth state. Paste the full callback URL including both code and state parameters. If needed, retry with Device Code.";
                        }
                        if (parsed.state !== expectedState) {
                                return "OAuth state mismatch. Restart login and paste the callback URL generated for this login attempt, or retry with Device Code.";
                        }
                        return undefined;
                },
                callback: async (input: string) => {
                        const parsed = parseAuthorizationInput(input);
                        if (!parsed.code || !parsed.state) {
                                return {
                                        type: "failed" as const,
                                        reason: "invalid_response" as const,
                                        message: "Missing authorization code or OAuth state",
                                };
                        }
                        if (parsed.state !== expectedState) {
                                return {
                                        type: "failed" as const,
                                        reason: "invalid_response" as const,
                                        message: "OAuth state mismatch. Restart login and try again, or retry with Device Code.",
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
			const { pkce, state, url } = await createAuthorizationFlow({ forceNewLogin });
			logInfo(`OAuth URL: ${url}`);

			let serverInfo: Awaited<ReturnType<typeof startLocalOAuthServer>> | null = null;
			try {
				serverInfo = await startLocalOAuthServer({ state });
			} catch (err) {
				logDebug(`[${PLUGIN_NAME}] Failed to start OAuth server: ${(err as Error)?.message ?? String(err)}`);
				serverInfo = null;
			}
			openBrowserUrl(url);

			if (!serverInfo || !serverInfo.ready) {
				serverInfo?.close();
				const message =
					`OAuth callback server failed to start on localhost loopback port 1455. ` +
					`Retry with "${AUTH_LABELS.OAUTH_DEVICE_CODE}" or "${AUTH_LABELS.OAUTH_MANUAL}".`;
				logWarn(`\n[${PLUGIN_NAME}] ${message}\n`);
				return {
					type: "failed" as const,
					reason: "invalid_response" as const,
					message,
				};
			}

			const result = await serverInfo.waitForCode(state);
			serverInfo.close();

			if (!result) {
				return {
					type: "failed" as const,
					reason: "unknown" as const,
					message:
						`OAuth callback timed out or was cancelled. ` +
						`If you are on SSH, WSL, or a headless machine, retry with "${AUTH_LABELS.OAUTH_DEVICE_CODE}" or "${AUTH_LABELS.OAUTH_MANUAL}".`,
				};
			}

			return await exchangeAuthorizationCode(
				result.code,
				pkce.verifier,
				REDIRECT_URI,
			);
		};

        const showToast = async (
                message: string,
                variant: "info" | "success" | "warning" | "error" = "success",
                options?: { title?: string; duration?: number },
        ): Promise<void> => {
                try {
                        await client.tui.showToast({
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
		): Promise<void> => {
			try {
				const snapshot = parseTuiQuotaSnapshotFromHeaders(response.headers, {
					fingerprint: createUsageAccountFingerprint(account),
					accountIndex: account.index + 1,
					accountCount,
					accountEmail: account.email?.trim() || undefined,
					accountLabel: formatAccountLabel(account, account.index),
				});
				if (!snapshot) return;
				await writeTuiQuotaSnapshot(snapshot);
			} catch (error) {
				logDebug(
					`[${PLUGIN_NAME}] Failed to record TUI quota headers: ${error instanceof Error ? error.message : String(error)}`,
				);
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

                const accountsCopy = storage.accounts.map((account) =>
                        account ? { ...account } : account,
                );
                const accountsToHydrate = accountsCopy.filter(
                        (account) => account && !account.email,
                );
                if (accountsToHydrate.length === 0) return storage;

                let changed = false;
                // process in chunks of 3 to avoid auth0 rate limits (429) on startup
                const chunkSize = 3;
                for (let i = 0; i < accountsToHydrate.length; i += chunkSize) {
                        const chunk = accountsToHydrate.slice(i, i + chunkSize);
                        await Promise.all(
                                chunk.map(async (account) => {
                                try {
                                        const refreshed = await queuedRefresh(account.refreshToken);
                                        if (refreshed.type !== "success") return;
                                        const id = extractAccountId(refreshed.access);
                                        const email = sanitizeEmail(extractAccountEmail(refreshed.access, refreshed.idToken));
                                        if (
                                                id &&
                                                id !== account.accountId &&
                                                shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId)
                                        ) {
                                                account.accountId = id;
                                                account.accountIdSource = "token";
                                                changed = true;
                                        }
                                        if (email && email !== account.email) {
                                                account.email = email;
                                                changed = true;
                                        }
					if (refreshed.access && refreshed.access !== account.accessToken) {
						account.accessToken = refreshed.access;
						changed = true;
					}
					if (typeof refreshed.expires === "number" && refreshed.expires !== account.expiresAt) {
						account.expiresAt = refreshed.expires;
						changed = true;
					}
					if (refreshed.scope && refreshed.scope !== account.oauthScope) {
						account.oauthScope = refreshed.scope;
						changed = true;
					}
                                        if (refreshed.refresh && refreshed.refresh !== account.refreshToken) {
                                                account.refreshToken = refreshed.refresh;
                                                changed = true;
                                        }
				} catch {
					logWarn(`[${PLUGIN_NAME}] Failed to hydrate email for account`);
				}
                        })
                );
                }

                if (changed) {
                        storage.accounts = accountsCopy;
                        await saveAccounts(storage);
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
				accountLabel?: string;
				accountTags?: string[];
				accountNote?: string;
			} | undefined,
			index: number,
			options: { maskEmail?: boolean } = {},
		): string => {
			const email = resolveDisplayEmail(account?.email, options.maskEmail ?? false);
			const workspace = account?.accountLabel?.trim();
			const accountId = formatAccountIdForDisplay(account?.accountId);
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
			if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
			if (process.env.OPENCODE_TUI === "1") return false;
			if (process.env.OPENCODE_DESKTOP === "1") return false;
			if (process.env.TERM_PROGRAM === "opencode") return false;
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
						label: formatCommandAccountLabel(account, index, { maskEmail }),
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
				label: formatCommandAccountLabel(account, index),
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

		const invalidateAccountManagerCache = (): void => {
			cachedAccountManager = null;
			accountManagerPromise = null;
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

        // Event handler for session recovery and account selection
        const eventHandler = async (input: { event: { type: string; properties?: unknown } }) => {
          try {
                const { event } = input;
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
                                if (account) {
                                        account.lastUsed = now;
                                        account.lastSwitchReason = "rotation";
                                }
                                storage.activeIndex = index;
                                storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
                                for (const family of MODEL_FAMILIES) {
                                        storage.activeIndexByFamily[family] = index;
                                }

                                await saveAccounts(storage);
								await clearPromptQuotaCache();

                                // Reload manager from disk so we don't overwrite newer rotated
                                // refresh tokens with stale in-memory state.
                                if (cachedAccountManager) {
                                        const reloadedManager = await AccountManager.loadFromDisk();
                                        cachedAccountManager = reloadedManager;
                                        accountManagerPromise = Promise.resolve(reloadedManager);
                                }

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
	setStoragePath(startupPerProjectAccounts ? process.cwd() : null);
	await backfillHostOpenAIAuthFromPool();

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
				applyUiRuntimeFromConfig(pluginConfig);
				const perProjectAccounts = getPerProjectAccounts(pluginConfig);
				setStoragePath(perProjectAccounts ? process.cwd() : null);
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
						accountManagerPromise = AccountManager.loadFromDisk(authFallback);
					}
					let accountManager = await accountManagerPromise;
					cachedAccountManager = accountManager;
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

				// Load plugin configuration and determine CODEX_MODE
				// Priority: CODEX_MODE env var > config file > default (true)
				const codexMode = getCodexMode(pluginConfig);
				const requestTransformMode = getRequestTransformMode(pluginConfig);
				const useLegacyRequestTransform = requestTransformMode === "legacy";
				const fastSessionEnabled = getFastSession(pluginConfig);
				const fastSessionStrategy = getFastSessionStrategy(pluginConfig);
				const fastSessionMaxInputItems = getFastSessionMaxInputItems(pluginConfig);
				const beginnerSafeMode = getBeginnerSafeMode(pluginConfig);
				beginnerSafeModeEnabled = beginnerSafeMode;
				const maskEmailEnabled = getCodexTuiMaskEmail(pluginConfig);
				const retryProfile = beginnerSafeMode
					? "conservative"
					: getRetryProfile(pluginConfig);
				const retryBudgetOverrides = beginnerSafeMode
					? {}
					: getRetryBudgetOverrides(pluginConfig);
				const retryBudgetLimits = resolveRetryBudgetLimits(
					retryProfile,
					retryBudgetOverrides,
				);
				runtimeMetrics.retryProfile = retryProfile;
				runtimeMetrics.retryBudgetLimits = { ...retryBudgetLimits };
				const tokenRefreshSkewMs = getTokenRefreshSkewMs(pluginConfig);
				const rateLimitToastDebounceMs = getRateLimitToastDebounceMs(pluginConfig);
				const retryAllAccountsRateLimited = beginnerSafeMode
					? false
					: getRetryAllAccountsRateLimited(pluginConfig);
				const retryAllAccountsMaxWaitMs = getRetryAllAccountsMaxWaitMs(pluginConfig);
				const retryAllAccountsMaxRetries = beginnerSafeMode
					? Math.min(1, getRetryAllAccountsMaxRetries(pluginConfig))
					: getRetryAllAccountsMaxRetries(pluginConfig);
				const unsupportedCodexPolicy = getUnsupportedCodexPolicy(pluginConfig);
				const fallbackOnUnsupportedCodexModel = unsupportedCodexPolicy === "fallback";
				const fallbackToGpt52OnUnsupportedGpt53 =
					getFallbackToGpt52OnUnsupportedGpt53(pluginConfig);
				const unsupportedCodexFallbackChain =
					getUnsupportedCodexFallbackChain(pluginConfig);
				const toastDurationMs = getToastDurationMs(pluginConfig);
				const fetchTimeoutMs = getFetchTimeoutMs(pluginConfig);
				const streamStallTimeoutMs = getStreamStallTimeoutMs(pluginConfig);

				const sessionRecoveryEnabled = getSessionRecovery(pluginConfig);
				const autoResumeEnabled = getAutoResume(pluginConfig);
				const autoUpdateEnabled = getAutoUpdate(pluginConfig);
				const emptyResponseMaxRetries = getEmptyResponseMaxRetries(pluginConfig);
				const emptyResponseRetryDelayMs = getEmptyResponseRetryDelayMs(pluginConfig);
				const pidOffsetEnabled = getPidOffsetEnabled(pluginConfig);
				const effectiveUserConfig = fastSessionEnabled
					? applyFastSessionDefaults(userConfig)
					: userConfig;
				if (fastSessionEnabled) {
					logDebug("Fast session mode enabled", {
						reasoningEffort: "none/low",
						reasoningSummary: "auto",
						textVerbosity: "low",
						fastSessionStrategy,
						fastSessionMaxInputItems,
					});
				}
				if (beginnerSafeMode) {
					logInfo("Beginner safe mode enabled", {
						retryProfile,
						retryAllAccountsRateLimited,
						retryAllAccountsMaxRetries,
					});
				}

				const prewarmEnabled =
					process.env.CODEX_AUTH_PREWARM !== "0" &&
					process.env.VITEST !== "true" &&
					process.env.NODE_ENV !== "test";

				if (!startupPrewarmTriggered && prewarmEnabled && useLegacyRequestTransform) {
					startupPrewarmTriggered = true;
					const configuredModels = Object.keys(userConfig.models ?? {});
					prewarmCodexInstructions(configuredModels);
					if (codexMode) {
						prewarmOpenCodeCodexPrompt();
					}
				}

				const recoveryHook = sessionRecoveryEnabled
					? createSessionRecoveryHook(
							{ client, directory: process.cwd() },
							{ sessionRecovery: true, autoResume: autoResumeEnabled }
						)
					: null;

			checkAndNotify(async (message, variant) => {
				await showToast(message, variant);
			}, { autoUpdate: autoUpdateEnabled }).catch((err) => {
				logDebug(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
			});
			await runStartupPreflight();


				// Return SDK configuration
				return {
					apiKey: DUMMY_API_KEY,
					baseURL: CODEX_BASE_URL,
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
						try {
							if (cachedAccountManager && cachedAccountManager !== accountManager) {
								accountManager = cachedAccountManager;
							}

                                                // Step 1: Extract and rewrite URL for Codex backend
                                                const originalUrl = extractRequestUrl(input);
                                                const url = rewriteUrlForCodex(originalUrl);

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
							): boolean => {
								if (retryBudget.consume(bucket)) {
									runtimeMetrics.retryBudgetUsage[bucket] += 1;
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
					const sleep = (ms: number): Promise<void> =>
						new Promise((resolve, reject) => {
							if (abortSignal?.aborted) {
								reject(new Error("Aborted"));
								return;
							}

							const timeout = setTimeout(() => {
								cleanup();
								resolve();
							}, ms);

							const onAbort = () => {
								cleanup();
								reject(new Error("Aborted"));
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
					): Promise<void> => {
						const startTime = Date.now();
						const endTime = startTime + totalMs;
						
						while (Date.now() < endTime) {
							if (abortSignal?.aborted) {
								throw new Error("Aborted");
							}
							
							const remaining = Math.max(0, endTime - Date.now());
							const waitLabel = formatWaitTime(remaining);
							await showToast(
								`${message} (${waitLabel} remaining)`,
								"warning",
								{ duration: Math.min(intervalMs + 1000, toastDurationMs) },
							);
							
							const sleepTime = Math.min(intervalMs, remaining);
							if (sleepTime > 0) {
								await sleep(sleepTime);
							} else {
								break;
							}
						}
					};

							let allRateLimitedRetries = 0;
							let emptyResponseRetries = 0;
							const attemptedUnsupportedFallbackModels = new Set<string>();
							if (model) {
								attemptedUnsupportedFallbackModels.add(model);
							}

							while (true) {
						let accountCount = accountManager.getAccountCount();
						const attempted = new Set<number>();
						let restartAccountTraversalWithFallback = false;
						let restartAccountTraversalAfterWorkspaceDeactivation = false;

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
				};
				const account = accountManager.getCurrentOrNextForFamilyHybrid(modelFamily, model, { pidOffsetEnabled });
				if (!account || attempted.has(account.index)) {
					break;
				}
							attempted.add(account.index);
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
				const failures = await accountManager.incrementAuthFailures(account);
				const accountLabel = formatAccountLabel(account, account.index, {
					maskEmail: maskEmailEnabled,
				});
				
				if (failures >= ACCOUNT_LIMITS.MAX_AUTH_FAILURES_BEFORE_REMOVAL) {
					const removedCount = accountManager.removeAccountsWithSameRefreshToken(account);
					if (removedCount <= 0) {
						logWarn(
							`[${PLUGIN_NAME}] Expected grouped account removal after auth failures, but removed ${removedCount}.`,
						);
						const cooledCount = accountManager.markAccountsWithRefreshTokenCoolingDown(
							account.refreshToken,
							ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
							"auth-failure",
						);
						if (cooledCount <= 0) {
							logWarn(
								`[${PLUGIN_NAME}] Unable to apply auth-failure cooldown; no live account found for refresh token.`,
							);
						}
						accountManager.saveToDiskDebounced();
						continue;
					}
					accountManager.saveToDiskDebounced();
					const removalMessage = removedCount > 1
						? `Removed ${removedCount} accounts (same refresh token) after ${failures} consecutive auth failures. Run 'opencode auth login' to re-add.`
						: `Removed ${accountLabel} after ${failures} consecutive auth failures. Run 'opencode auth login' to re-add.`;
					await showToast(
						removalMessage,
						"error",
						{ duration: toastDurationMs * 2 },
					);
					// Restart traversal: clear attempted and refresh accountCount to avoid skipping healthy accounts
					attempted.clear();
					accountCount = accountManager.getAccountCount();
					continue;
				}
				
				accountManager.markAccountCoolingDown(
								account,
								ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
								"auth-failure",
							);
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
												accountCount > 1 &&
												accountManager.shouldShowAccountToast(
													account.index,
													rateLimitToastDebounceMs,
												)
											) {
												const accountLabel = formatAccountLabel(account, account.index, {
													maskEmail: maskEmailEnabled,
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
									accountManager.recordRateLimit(account, modelFamily, model);
									runtimeMetrics.accountRotations++;
									runtimeMetrics.lastError =
										`Local token bucket depleted for account ${account.index + 1} (${modelFamily}${model ? `:${model}` : ""})`;
									runtimeMetrics.lastErrorCategory = "rate-limit-local";
									logWarn(
										`Skipping account ${account.index + 1}: local token bucket depleted for ${modelFamily}${model ? `:${model}` : ""}`,
									);
									break;
								}

							// RC-8: per-(account, family) circuit-breaker key. The breaker gates
							// upstream calls so that repeated failures short-circuit to the
							// rotation path instead of hammering a degraded endpoint.
							const circuitBreakerKey = `${accountId}:${modelFamily}`;
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
								response = await fetch(url, {
									...requestInit,
									headers,
									signal: fetchController.signal,
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

							logRequest(LOG_STAGES.RESPONSE, {
								status: response.status,
								ok: response.ok,
								statusText: response.statusText,
								latencyMs: fetchLatencyMs,
								headers: Object.fromEntries(response.headers.entries()),
							});
							void recordPromptQuotaHeaders(response, account, accountCount);

								if (!response.ok) {
									const contextOverflowResult = await handleContextOverflow(response, model);
									if (contextOverflowResult.handled) {
										return contextOverflowResult.response;
									}

					const { response: errorResponse, rateLimit, errorBody, retryAsServerError } =
						await handleErrorResponse(response, {
							requestCorrelationId,
							threadId: threadIdCandidate,
						});

			const workspaceDeactivated = isDeactivatedWorkspaceError(errorBody, response.status);
				if (workspaceDeactivated) {
					const accountLabel = formatAccountLabel(account, account.index, {
						maskEmail: maskEmailEnabled,
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

					// Keep deactivated workspace cleanup aligned with the existing
					// refresh-token removal path. saveToDiskDebounced reuses the
					// storage temp-file + EPERM/EBUSY retry path covered in
					// test/storage.test.ts, and surfaced persistence failures stay
					// sanitized by the redaction checks in test/login-runner.test.ts.
					const removedCount = accountManager.removeAccountsWithSameRefreshToken(account);
					if (removedCount > 0) {
						accountManager.saveToDiskDebounced();
						restartAccountTraversalAfterWorkspaceDeactivation = true;
						const removalMessage = removedCount > 1
							? `Workspace deactivated. Removed ${removedCount} related entries from rotation and switching accounts.`
							: `Workspace deactivated. Removed ${accountLabel} from rotation and switching accounts.`;
						await showToast(
							removalMessage,
							"warning",
							{ duration: toastDurationMs },
						);
						break;
					}

					logWarn(
						`[${PLUGIN_NAME}] Expected grouped account removal after workspace deactivation, but removed ${removedCount}.`,
					);
					accountManager.markAccountCoolingDown(
						account,
						ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
						"auth-failure",
					);
					accountManager.saveToDiskDebounced();
					break;
				}

			const unsupportedModelInfo = getUnsupportedCodexModelInfo(errorBody);
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
				attemptedUnsupportedFallbackModels.add(previousModel);
				attemptedUnsupportedFallbackModels.add(fallbackModel);
				accountManager.refundToken(account, previousModelFamily, previousModel);

				model = fallbackModel;
				modelFamily = getModelFamily(model);
				quotaKey = `${modelFamily}:${model}`;
				fallbackApplied = true;
				fallbackFrom = previousModel;
				fallbackTo = model;
				fallbackReason = "fallback-unsupported-model-entitlement";
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

				requestInit = {
					...(requestInit ?? {}),
					body: JSON.stringify(transformedBody),
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

																														if (
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

				accountManager.markRateLimitedWithReason(
					account,
					delayMs,
					modelFamily,
					parseRateLimitReason(rateLimit.code),
					model,
				);
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
																													runtimeMetrics.failedRequests++;
																													runtimeMetrics.lastError = `HTTP ${response.status}`;
																													runtimeMetrics.lastErrorCategory = "http";
																													return errorResponse;
																											}

					resetRateLimitBackoff(account.index, quotaKey);
					runtimeMetrics.cumulativeLatencyMs += fetchLatencyMs;
					const successResponse = await handleSuccessResponse(response, isStreaming, {
						streamStallTimeoutMs,
					});

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
									accountManager.refundToken(account, modelFamily, model);
									accountManager.recordFailure(account, modelFamily, model);
									await sleep(addJitter(emptyResponseRetryDelayMs, 0.2));
									break;
								}
								logWarn(`Empty response after ${emptyResponseMaxRetries} retries. Returning as-is.`);
							}
						} catch {
							// Intentionally empty: non-JSON response bodies should be returned as-is
						}
					}

					accountManager.recordSuccess(account, modelFamily, model);
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

										const waitMs = accountManager.getMinWaitTimeForFamily(modelFamily, model);
										const count = accountManager.getAccountCount();

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
									)
								) {
									const countdownMessage = `All ${count} account(s) rate-limited. Waiting`;
									await sleepWithCountdown(addJitter(waitMs, 0.2), countdownMessage);
									allRateLimitedRetries++;
									continue;
								}

								const waitLabel = waitMs > 0 ? formatWaitTime(waitMs) : "a bit";
								const wasEntitlementExhaustion =
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
										? ` The backend rejected '${entitlementModel}' as not entitled for Codex OAuth on every pooled account.`
										: "";
								const message =
									count === 0
										? "No Codex accounts configured. Run `opencode auth login`."
										: waitMs > 0
											? `All ${count} account(s) are rate-limited. Try again in ${waitLabel} or add another account with \`opencode auth login\`.`
											: wasEntitlementExhaustion
												? `All ${count} account(s) returned 'model not supported' for the requested model.${entitlementDetail} Codex model access is account/workspace gated; default gpt-5.5/gpt-5-codex selectors auto-fallback through the GPT-5.4 family when possible. Set \`unsupportedCodexPolicy: "fallback"\` for the full manual fallback chain, or see \`codex-health\` for per-account details.`
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
							setStoragePath(authPerProjectAccounts ? process.cwd() : null);

							const accounts: TokenSuccessWithAccount[] = [];
							const noBrowser =
								inputs?.noBrowser === "true" ||
								inputs?.["no-browser"] === "true";
							const useManualMode = noBrowser;
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

							type CodexQuotaWindow = {
								usedPercent?: number;
								windowMinutes?: number;
								resetAtMs?: number;
							};

							type CodexQuotaSnapshot = {
								status: number;
								planType?: string;
								activeLimit?: number;
								primary: CodexQuotaWindow;
								secondary: CodexQuotaWindow;
							};

							const parseFiniteNumberHeader = (headers: Headers, name: string): number | undefined => {
								const raw = headers.get(name);
								if (!raw) return undefined;
								const parsed = Number(raw);
								return Number.isFinite(parsed) ? parsed : undefined;
							};

							const parseFiniteIntHeader = (headers: Headers, name: string): number | undefined => {
								const raw = headers.get(name);
								if (!raw) return undefined;
								const parsed = Number.parseInt(raw, 10);
								return Number.isFinite(parsed) ? parsed : undefined;
							};

							const parseResetAtMs = (headers: Headers, prefix: string): number | undefined => {
								const resetAfterSeconds = parseFiniteIntHeader(
									headers,
									`${prefix}-reset-after-seconds`,
								);
								if (
									typeof resetAfterSeconds === "number" &&
									Number.isFinite(resetAfterSeconds) &&
									resetAfterSeconds > 0
								) {
									return Date.now() + resetAfterSeconds * 1000;
								}

								const resetAtRaw = headers.get(`${prefix}-reset-at`);
								if (!resetAtRaw) return undefined;

								const trimmed = resetAtRaw.trim();
								if (/^\d+$/.test(trimmed)) {
									const parsedNumber = Number.parseInt(trimmed, 10);
									if (Number.isFinite(parsedNumber) && parsedNumber > 0) {
										// Upstream sometimes returns seconds since epoch.
										return parsedNumber < 10_000_000_000 ? parsedNumber * 1000 : parsedNumber;
									}
								}

								const parsedDate = Date.parse(trimmed);
								return Number.isFinite(parsedDate) ? parsedDate : undefined;
							};

							const hasCodexQuotaHeaders = (headers: Headers): boolean => {
								const keys = [
									"x-codex-primary-used-percent",
									"x-codex-primary-window-minutes",
									"x-codex-primary-reset-at",
									"x-codex-primary-reset-after-seconds",
									"x-codex-secondary-used-percent",
									"x-codex-secondary-window-minutes",
									"x-codex-secondary-reset-at",
									"x-codex-secondary-reset-after-seconds",
								];
								return keys.some((key) => headers.get(key) !== null);
							};

							const parseCodexQuotaSnapshot = (headers: Headers, status: number): CodexQuotaSnapshot | null => {
								if (!hasCodexQuotaHeaders(headers)) return null;

								const primaryPrefix = "x-codex-primary";
								const secondaryPrefix = "x-codex-secondary";
								const primary: CodexQuotaWindow = {
									usedPercent: parseFiniteNumberHeader(headers, `${primaryPrefix}-used-percent`),
									windowMinutes: parseFiniteIntHeader(headers, `${primaryPrefix}-window-minutes`),
									resetAtMs: parseResetAtMs(headers, primaryPrefix),
								};
								const secondary: CodexQuotaWindow = {
									usedPercent: parseFiniteNumberHeader(headers, `${secondaryPrefix}-used-percent`),
									windowMinutes: parseFiniteIntHeader(headers, `${secondaryPrefix}-window-minutes`),
									resetAtMs: parseResetAtMs(headers, secondaryPrefix),
								};

								const planTypeRaw = headers.get("x-codex-plan-type");
								const planType = planTypeRaw && planTypeRaw.trim() ? planTypeRaw.trim() : undefined;
								const activeLimit = parseFiniteIntHeader(headers, "x-codex-active-limit");

								return { status, planType, activeLimit, primary, secondary };
							};

							const formatQuotaWindowLabel = (windowMinutes: number | undefined): string => {
								if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
									return "quota";
								}
								if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
								if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
								return `${windowMinutes}m`;
							};

							const formatResetAt = (resetAtMs: number | undefined): string | undefined => {
								if (!resetAtMs || !Number.isFinite(resetAtMs) || resetAtMs <= 0) return undefined;
								const date = new Date(resetAtMs);
								if (!Number.isFinite(date.getTime())) return undefined;

								const now = new Date();
								const sameDay =
									now.getFullYear() === date.getFullYear() &&
									now.getMonth() === date.getMonth() &&
									now.getDate() === date.getDate();

								const time = date.toLocaleTimeString(undefined, {
									hour: "2-digit",
									minute: "2-digit",
									hour12: false,
								});

								if (sameDay) return time;
								const day = date.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
								return `${time} on ${day}`;
							};

							const formatCodexQuotaLine = (snapshot: CodexQuotaSnapshot): string => {
								const summarizeWindow = (label: string, window: CodexQuotaWindow): string => {
									const used = window.usedPercent;
									const left =
										typeof used === "number" && Number.isFinite(used)
											? Math.max(0, Math.min(100, Math.round(100 - used)))
											: undefined;
									const reset = formatResetAt(window.resetAtMs);
									let summary = label;
									if (left !== undefined) summary = `${summary} ${left}% left`;
									if (reset) summary = `${summary} (resets ${reset})`;
									return summary;
								};

								const primaryLabel = formatQuotaWindowLabel(snapshot.primary.windowMinutes);
								const secondaryLabel = formatQuotaWindowLabel(snapshot.secondary.windowMinutes);
								const parts = [
									summarizeWindow(primaryLabel, snapshot.primary),
									summarizeWindow(secondaryLabel, snapshot.secondary),
								];
								if (snapshot.planType) parts.push(`plan:${snapshot.planType}`);
								if (typeof snapshot.activeLimit === "number" && Number.isFinite(snapshot.activeLimit)) {
									parts.push(`active:${snapshot.activeLimit}`);
								}
								if (snapshot.status === 429) parts.push("rate-limited");
								return parts.join(", ");
							};

							const fetchCodexQuotaSnapshot = async (params: {
								accountId: string;
								accessToken: string;
								organizationId: string | undefined;
							}): Promise<CodexQuotaSnapshot> => {
								const QUOTA_PROBE_MODELS = ["gpt-5.4", "gpt-5-codex", "gpt-5.3-codex", "gpt-5.2-codex"];
								let lastError: Error | null = null;

								for (const model of QUOTA_PROBE_MODELS) {
									try {
										const instructions = await getCodexInstructions(model);
										const probeBody: RequestBody = {
											model,
											stream: true,
											store: false,
											include: ["reasoning.encrypted_content"],
											instructions,
											input: [
												{
													type: "message",
													role: "user",
													content: [{ type: "input_text", text: "quota ping" }],
												},
											],
											reasoning: { effort: "none", summary: "auto" },
											text: { verbosity: "low" },
										};

										const headers = createCodexHeaders(undefined, params.accountId, params.accessToken, {
											model,
											organizationId: params.organizationId,
										});
								headers.set("content-type", "application/json");

										const controller = new AbortController();
										const timeout = setTimeout(() => controller.abort(), 15_000);
										let response: Response;
										try {
											response = await fetch(`${CODEX_BASE_URL}/codex/responses`, {
												method: "POST",
												headers,
												body: JSON.stringify(probeBody),
												signal: controller.signal,
											});
										} finally {
											clearTimeout(timeout);
										}

										const snapshot = parseCodexQuotaSnapshot(response.headers, response.status);
										if (snapshot) {
											// We only need headers; cancel the SSE stream immediately.
											try {
												await response.body?.cancel();
											} catch {
												// Ignore cancellation failures.
											}
											return snapshot;
										}

										if (!response.ok) {
											const bodyText = await response.text().catch(() => "");
											let errorBody: unknown = undefined;
											try {
												errorBody = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
											} catch {
												errorBody = { error: { message: bodyText } };
											}

											const unsupportedInfo = getUnsupportedCodexModelInfo(errorBody);
											if (unsupportedInfo.isUnsupported) {
												lastError = new Error(
													unsupportedInfo.message ?? `Model '${model}' unsupported for this account`,
												);
												continue;
											}

											const message =
												(typeof (errorBody as { error?: { message?: unknown } })?.error?.message === "string"
													? (errorBody as { error?: { message?: string } }).error?.message
													: bodyText) || `HTTP ${response.status}`;
											if (isDeactivatedWorkspaceError(errorBody, response.status)) {
												throw createDeactivatedWorkspaceError();
											}
											throw new Error(message);
										}

										lastError = new Error("Codex response did not include quota headers");
									} catch (error) {
										lastError = error instanceof Error ? error : new Error(String(error));
										if (isDeactivatedWorkspaceErrorMessage(lastError.message)) {
											throw lastError;
										}
									}
								}

								throw lastError ?? new Error("Failed to fetch quotas");
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
											const refreshResult = await queuedRefresh(account.refreshToken);
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
											const detail =
												tokenAccountId
													? `${authDetail} (id:${tokenAccountId.slice(-6)})`
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

											const snapshot = await fetchCodexQuotaSnapshot({
												accountId: requestAccountId,
												accessToken,
												organizationId: account.organizationId,
											});
											ok += 1;
											console.log(
												`[${i + 1}/${total}] ${label}: ${formatCodexQuotaLine(snapshot)}`,
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
									await saveAccounts(workingStorage);
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
										console.log(
												`[${i + 1}/${flaggedStorage.accounts.length}] ${label}: RESTORED (Codex CLI cache)`,
										);
											continue;
										}

										const refreshResult = await queuedRefresh(flagged.refreshToken);
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

								await saveFlaggedAccounts({
									version: 1,
									accounts: remaining,
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
												workingStorage.accounts.splice(menuResult.deleteAccountIndex, 1);
												clampActiveIndices(workingStorage);
												await saveAccounts(workingStorage);
												await saveFlaggedAccounts({
													version: 1,
													accounts: flaggedStorage.accounts.filter(
														(flagged) =>
															!matchesWorkspaceIdentity(
																flagged,
																getWorkspaceIdentityKey(target),
															),
													),
												});
												invalidateAccountManagerCache();
												console.log(`\nDeleted ${resolveDisplayEmail(target.email, maskEmailEnabled) ?? `Account ${menuResult.deleteAccountIndex + 1}`}.\n`);
											}
											continue;
										}

										if (typeof menuResult.toggleAccountIndex === "number") {
											const target = workingStorage.accounts[menuResult.toggleAccountIndex];
											if (target) {
												target.enabled = target.enabled === false ? true : false;
												await saveAccounts(workingStorage);
												invalidateAccountManagerCache();
												console.log(
													`\n${resolveDisplayEmail(target.email, maskEmailEnabled) ?? `Account ${menuResult.toggleAccountIndex + 1}`} ${target.enabled === false ? "disabled" : "enabled"}.\n`,
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
							if (useManualMode) {
								targetCount = 1;
							}

							if (useManualMode) {
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
						label: AUTH_LABELS.OAUTH_DEVICE_CODE,
						type: "oauth" as const,
						authorize: async () => {
							const devicePluginConfig = loadPluginConfig();
							applyUiRuntimeFromConfig(devicePluginConfig);
							const devicePerProjectAccounts = getPerProjectAccounts(devicePluginConfig);
							setStoragePath(devicePerProjectAccounts ? process.cwd() : null);

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
                                                        // Initialize storage path for manual OAuth flow
                                                        // Must happen BEFORE persistAccountPool to ensure correct storage location
                                                        const manualPluginConfig = loadPluginConfig();
							applyUiRuntimeFromConfig(manualPluginConfig);
                                                        const manualPerProjectAccounts = getPerProjectAccounts(manualPluginConfig);
							setStoragePath(manualPerProjectAccounts ? process.cwd() : null);

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

export default OpenAIOAuthPlugin;

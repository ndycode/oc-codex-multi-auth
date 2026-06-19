/**
 * `codex-doctor` tool — beginner-friendly diagnostics with optional auto-fix.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import {
	getStoragePath,
	loadAccounts,
	saveAccounts,
} from "../storage.js";
import { AccountManager } from "../accounts.js";
import { queuedRefresh } from "../refresh-queue.js";
import { MODEL_FAMILIES } from "../prompts/codex.js";
import {
	clearRefreshedAccountsStaleState,
	findDisabledTokenSourceDuplicates,
} from "../accounts/stale-state.js";
import { clearTuiQuotaSnapshot } from "../tui-quota-cache.js";
import {
	buildBeginnerDoctorFindings,
	formatPromptCacheSnapshot,
	recommendBeginnerNextAction,
	summarizeBeginnerAccounts,
} from "../ui/beginner.js";
import {
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
	formatUiSection,
} from "../ui/format.js";
import {
	normalizeToolOutputFormat,
	renderJsonOutput,
	type RoutingVisibilitySnapshot,
} from "../runtime.js";
import type { ToolContext } from "./index.js";

export function createCodexDoctorTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		resolveActiveIndex,
		toBeginnerAccountSnapshots,
		getBeginnerRuntimeSnapshot,
		buildRoutingVisibilitySnapshot,
		appendRoutingVisibilityText,
		appendRoutingVisibilityUi,
		formatDoctorSeverity,
		formatDoctorSeverityText,
		runtimeMetrics,
		cachedAccountManagerRef,
		accountManagerPromiseRef,
	} = ctx;
	return tool({
		description: "Run beginner-friendly diagnostics with clear fixes.",
		args: {
			deep: tool.schema
				.boolean()
				.optional()
				.describe("Include technical snapshot details (default: false)."),
			fix: tool.schema
				.boolean()
				.optional()
				.describe(
					"Apply safe automated fixes (refresh tokens and switch to healthiest eligible account).",
				),
			format: tool.schema
				.string()
				.optional()
				.describe('Output format: "text" (default) or "json".'),
		},
		async execute({
			deep,
			fix,
			format,
		}: { deep?: boolean; fix?: boolean; format?: string } = {}) {
			const ui = resolveUiRuntime();
			const outputFormat = normalizeToolOutputFormat(format);
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
			const summary = summarizeBeginnerAccounts(snapshots, now);
			const findings = buildBeginnerDoctorFindings({
				accounts: snapshots,
				now,
				runtime,
			});
			const nextAction = recommendBeginnerNextAction({
				accounts: snapshots,
				now,
				runtime,
			});

			// Surface disabled token-source duplicates that shadow an enabled,
			// org-backed account by email (issue #171). These appear when a
			// re-login mints a token-source entry instead of updating the org
			// account; harmless for rotation but they pollute diagnostics. We flag
			// rather than auto-remove because the only link between the two is
			// email, and email-only merges must not blindly collapse multi-org
			// accounts (#64).
			const disabledTokenSourceDuplicates = storage
				? findDisabledTokenSourceDuplicates(storage.accounts)
				: [];
			if (disabledTokenSourceDuplicates.length > 0) {
				findings.push({
					severity: "warning",
					code: "disabled-token-source-duplicate",
					summary: `${disabledTokenSourceDuplicates.length} disabled duplicate account entry(ies) shadow a real account.`,
					action: `Remove the leftover entry(ies) with \`codex-remove\` (slots: ${disabledTokenSourceDuplicates
						.map((index) => index + 1)
						.join(", ")}).`,
				});
			}
			let routingVisibility: RoutingVisibilitySnapshot | null = null;
			const appliedFixes: string[] = [];
			const fixErrors: string[] = [];

			if (fix && storage && storage.accounts.length > 0) {
				let changedByRefresh = false;
				let refreshedCount = 0;
				const refreshedAccounts: typeof storage.accounts = [];
				const reloginNeeded: number[] = [];
				for (let accountIndex = 0; accountIndex < storage.accounts.length; accountIndex++) {
					const account = storage.accounts[accountIndex];
					if (!account) continue;
					// Skip intentionally-disabled accounts: refreshing them is wrong
					// (e.g. the disabled token-source duplicate would get a spurious
					// "re-login" directive when its dead token fails, when the correct
					// remedy is `codex-remove`), and stale-state must never be cleared
					// on an entry the user disabled on purpose.
					if (account.enabled === false) continue;
					try {
						const refreshResult = await queuedRefresh(account.refreshToken);
						if (refreshResult.type === "success") {
							account.refreshToken = refreshResult.refresh;
							account.accessToken = refreshResult.access;
							account.expiresAt = refreshResult.expires;
							changedByRefresh = true;
							refreshedCount += 1;
							refreshedAccounts.push(account);
						} else {
							// A failed refresh (vs. a thrown error) means the stored
							// credential is genuinely dead — re-login is required. Surface
							// it explicitly so an all-dark pool with expired tokens does not
							// fail silently (issue #171: "surface this state"). We do NOT
							// clear stale state for these accounts: they really are blocked.
							const detail =
								refreshResult.message ?? refreshResult.reason ?? "token refresh failed";
							reloginNeeded.push(accountIndex + 1);
							fixErrors.push(
								`Account ${accountIndex + 1}: ${detail} — run \`opencode auth login\` to re-authenticate.`,
							);
						}
					} catch (error) {
						fixErrors.push(
							error instanceof Error ? error.message : String(error),
						);
					}
				}

				// A successful refresh proves the credential is alive, so clear any
				// stale cooldown / rate-limit state that would otherwise keep the
				// recovered account out of rotation (issue #171). Without this, the
				// auto-switch below finds no eligible account and the dead routing
				// persists across restarts. The summary is computed here but only
				// reported after saveAccounts succeeds, so we never tell the user a
				// fix landed while the on-disk state still carries the stale block.
				let staleSummary = { cooldownsCleared: 0, rateLimitKeysCleared: 0 };
				if (refreshedAccounts.length > 0) {
					staleSummary = clearRefreshedAccountsStaleState(refreshedAccounts);
					if (staleSummary.cooldownsCleared > 0 || staleSummary.rateLimitKeysCleared > 0) {
						changedByRefresh = true;
					}
				}

				if (changedByRefresh) {
					try {
						await saveAccounts(storage);
						// Only report applied fixes once the write to disk has actually
						// succeeded, otherwise a failed persist would still print
						// "Cleared ..." and mislead the user into thinking it landed.
						if (refreshedCount > 0) {
							appliedFixes.push(
								`Refreshed ${refreshedCount} account token(s).`,
							);
						}
						if (staleSummary.cooldownsCleared > 0) {
							appliedFixes.push(
								`Cleared cooldown on ${staleSummary.cooldownsCleared} recovered account(s).`,
							);
						}
						if (staleSummary.rateLimitKeysCleared > 0) {
							appliedFixes.push(
								`Cleared ${staleSummary.rateLimitKeysCleared} stale rate-limit marker(s).`,
							);
						}
					} catch (error) {
						fixErrors.push(
							`Failed to persist refresh updates: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				}

				// Stale TUI quota cache can reference an account index/count that no
				// longer matches the pool, making diagnostics misleading (#171).
				// Only clear it when the repair actually changed account state, so a
				// run where every refresh failed does not report a phantom fix.
				if (changedByRefresh) {
					try {
						await clearTuiQuotaSnapshot();
						appliedFixes.push("Cleared stale TUI quota cache.");
					} catch (error) {
						// On Windows this can fail with EBUSY (not ENOENT) if the TUI
						// process holds the cache file open; surface it rather than throw.
						fixErrors.push(
							`Failed to clear TUI quota cache: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				}

				// Surface a clear next step when one or more accounts could not be
				// refreshed: the credential is dead and only re-login fixes it. Without
				// this the user sees no eligible account but no cause (issue #171).
				if (reloginNeeded.length > 0) {
					// Re-login is a MANUAL action, not an applied fix — keep it in fixErrors
					// so JSON consumers reading autoFix.appliedFixes are not misled.
					fixErrors.push(
						`${reloginNeeded.length} account(s) need re-login (slots: ${reloginNeeded.join(", ")}). Run \`opencode auth login\`.`,
					);
				}

				try {
					const managerForFix = await AccountManager.loadFromDisk();
					const explainability = managerForFix.getSelectionExplainability(
						"codex",
						undefined,
						Date.now(),
					);
					const eligible = explainability
						.filter((entry) => entry.eligible)
						.sort((a, b) => {
							if (b.healthScore !== a.healthScore)
								return b.healthScore - a.healthScore;
							return b.tokensAvailable - a.tokensAvailable;
						});
					const best = eligible[0];
					if (best) {
						const currentActive = resolveActiveIndex(storage, "codex");
						if (best.index !== currentActive) {
							storage.activeIndex = best.index;
							storage.activeIndexByFamily =
								storage.activeIndexByFamily ?? {};
							for (const family of MODEL_FAMILIES) {
								storage.activeIndexByFamily[family] = best.index;
							}
							await saveAccounts(storage);
							appliedFixes.push(
								`Switched active account to ${best.index + 1} (best eligible).`,
							);
						}
					} else {
						appliedFixes.push(
							"No eligible account available for auto-switch.",
						);
					}
				} catch (error) {
					fixErrors.push(
						`Auto-switch evaluation failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}

				if (cachedAccountManagerRef.current) {
					const reloadedManager = await AccountManager.loadFromDisk();
					cachedAccountManagerRef.current = reloadedManager;
					accountManagerPromiseRef.current =
						Promise.resolve(reloadedManager);
				}
			}
			if (deep) {
				const managerForRouting =
					cachedAccountManagerRef.current ??
					(await AccountManager.loadFromDisk());
				const routingFamily =
					runtimeMetrics.lastSelectionSnapshot?.family ?? "codex";
				const routingModel =
					runtimeMetrics.lastSelectionSnapshot?.effectiveModel ??
					runtimeMetrics.lastSelectionSnapshot?.model ??
					null;
				const routingExplainability =
					managerForRouting.getSelectionExplainability(
						routingFamily,
						routingModel ?? undefined,
						Date.now(),
					);
				const routingActiveIndex =
					storage && storage.accounts.length > 0
						? resolveActiveIndex(storage, routingFamily)
						: null;
				routingVisibility = buildRoutingVisibilitySnapshot({
					modelFamily: routingFamily,
					effectiveModel: routingModel,
					quotaKey: routingModel
						? `${routingFamily}:${routingModel}`
						: routingFamily,
					selectedAccountIndex: routingActiveIndex,
					selectionExplainability: routingExplainability,
				});
			}
			if (outputFormat === "json") {
				return renderJsonOutput({
					summary: {
						totalAccounts: summary.total,
						healthyAccounts: summary.healthy,
						blockedAccounts: summary.blocked,
						failureRatePercent:
							runtime.totalRequests > 0
								? Math.round(
										(runtime.failedRequests / runtime.totalRequests) * 100,
									)
								: 0,
					},
					findings: findings.map((finding) => ({
						severity: finding.severity,
						summary: finding.summary,
						action: finding.action,
					})),
					recommendedNextAction: nextAction,
					autoFix: fix
						? {
								appliedFixes,
								errors: fixErrors,
							}
						: null,
					technicalSnapshot: deep
						? {
								storagePath: getStoragePath(),
								runtimeFailures: {
									failedRequests: runtime.failedRequests,
									rateLimitedResponses: runtime.rateLimitedResponses,
									authRefreshFailures: runtime.authRefreshFailures,
									serverErrors: runtime.serverErrors,
									networkErrors: runtime.networkErrors,
								},
								promptCache: {
									enabledRequests: runtime.promptCacheEnabledRequests,
									missingRequests: runtime.promptCacheMissingRequests,
									lastPromptCacheKey: runtime.lastPromptCacheKey,
									summary: formatPromptCacheSnapshot(runtime),
								},
								routingVisibility,
							}
						: null,
				});
			}

			if (ui.v2Enabled) {
				const lines: string[] = [
					...formatUiHeader(ui, "Codex doctor"),
					formatUiKeyValue(ui, "Accounts", String(summary.total)),
					formatUiKeyValue(
						ui,
						"Healthy",
						String(summary.healthy),
						summary.healthy > 0 ? "success" : "warning",
					),
					formatUiKeyValue(
						ui,
						"Blocked",
						String(summary.blocked),
						summary.blocked > 0 ? "warning" : "muted",
					),
					formatUiKeyValue(
						ui,
						"Failure rate",
						runtime.totalRequests > 0
							? `${Math.round(
									(runtime.failedRequests / runtime.totalRequests) * 100,
								)}%`
							: "0%",
					),
					"",
					...formatUiSection(ui, "Findings"),
				];

				for (const finding of findings) {
					const tone =
						finding.severity === "ok"
							? "success"
							: finding.severity === "warning"
								? "warning"
								: "danger";
					lines.push(
						formatUiItem(
							ui,
							`${formatDoctorSeverity(ui, finding.severity)} ${finding.summary}`,
							tone,
						),
					);
					lines.push(
						`  ${formatUiKeyValue(ui, "fix", finding.action, "muted")}`,
					);
				}

				lines.push("");
				lines.push(...formatUiSection(ui, "Recommended next step"));
				lines.push(formatUiItem(ui, nextAction, "accent"));
				if (fix) {
					lines.push("");
					lines.push(...formatUiSection(ui, "Auto-fix"));
					if (appliedFixes.length === 0) {
						lines.push(
							formatUiItem(ui, "No safe fixes were applied.", "muted"),
						);
					} else {
						for (const entry of appliedFixes) {
							lines.push(formatUiItem(ui, entry, "success"));
						}
					}
					for (const error of fixErrors) {
						lines.push(formatUiItem(ui, error, "warning"));
					}
				}

				if (deep) {
					lines.push("");
					lines.push(...formatUiSection(ui, "Technical snapshot"));
					lines.push(
						formatUiKeyValue(ui, "Storage", getStoragePath(), "muted"),
					);
					lines.push(
						formatUiKeyValue(
							ui,
							"Runtime failures",
							`failed=${runtime.failedRequests}, rateLimited=${runtime.rateLimitedResponses}, authRefreshFailed=${runtime.authRefreshFailures}, server=${runtime.serverErrors}, network=${runtime.networkErrors}`,
							"muted",
						),
					);
					lines.push(
						formatUiKeyValue(
							ui,
							"Prompt cache",
							formatPromptCacheSnapshot(runtime),
							"muted",
						),
					);
					if (routingVisibility) {
						lines.push("");
						appendRoutingVisibilityUi(ui, lines, routingVisibility, {
							includeExplainability: true,
						});
					}
				}

				return lines.join("\n");
			}

			const lines: string[] = [
				"Codex Doctor:",
				`Accounts: ${summary.total} (healthy=${summary.healthy}, blocked=${summary.blocked})`,
				`Failure rate: ${runtime.totalRequests > 0 ? Math.round((runtime.failedRequests / runtime.totalRequests) * 100) : 0}%`,
				"",
				"Findings:",
			];
			for (const finding of findings) {
				lines.push(
					`  ${formatDoctorSeverityText(finding.severity)} ${finding.summary}`,
				);
				lines.push(`      fix: ${finding.action}`);
			}
			lines.push("");
			lines.push(`Recommended next step: ${nextAction}`);
			if (fix) {
				lines.push("");
				lines.push("Auto-fix:");
				if (appliedFixes.length === 0) {
					lines.push("  - No safe fixes were applied.");
				} else {
					for (const entry of appliedFixes) {
						lines.push(`  - ${entry}`);
					}
				}
				for (const error of fixErrors) {
					lines.push(`  - warning: ${error}`);
				}
			}
			if (deep) {
				lines.push("");
				lines.push("Technical snapshot:");
				lines.push(`  Storage: ${getStoragePath()}`);
				lines.push(
					`  Runtime failures: failed=${runtime.failedRequests}, rateLimited=${runtime.rateLimitedResponses}, authRefreshFailed=${runtime.authRefreshFailures}, server=${runtime.serverErrors}, network=${runtime.networkErrors}`,
				);
				lines.push(`  Prompt cache: ${formatPromptCacheSnapshot(runtime)}`);
				if (routingVisibility) {
					appendRoutingVisibilityText(lines, routingVisibility, {
						includeExplainability: true,
					});
				}
			}
			return lines.join("\n");
		},
	});
}

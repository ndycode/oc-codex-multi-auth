/**
 * `codex-doctor` tool — beginner-friendly diagnostics with optional auto-fix.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import {
	getStoragePath,
	loadAccounts,
	withAccountStorageTransaction,
	type AccountStorageV3,
} from "../storage.js";
import { AccountManager } from "../accounts.js";
import { MODEL_FAMILIES } from "../prompts/codex.js";
import {
	clearRefreshedAccountsStaleState,
	findDisabledAccountsWithFreshCredential,
	findDisabledTokenSourceDuplicates,
} from "../accounts/stale-state.js";
import { clearTuiQuotaSnapshot } from "../tui-quota-cache.js";
import {
	buildBeginnerDoctorFindings,
	formatPromptCacheSnapshot,
	recommendBeginnerNextAction,
	summarizeBeginnerAccounts,
	type BeginnerAccountSummary,
	type BeginnerDiagnosticFinding,
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
import {
	buildRefreshInputs,
	findAccountIndexByIdentity,
	refreshAndPersistAccount,
	type RefreshAccountIdentity,
} from "./refresh-account.js";
import type { ToolContext } from "./index.js";

interface DoctorDiagnostics {
	storage: AccountStorageV3 | null;
	activeIndex: number;
	snapshots: ReturnType<ToolContext["toBeginnerAccountSnapshots"]>;
	runtime: ReturnType<ToolContext["getBeginnerRuntimeSnapshot"]>;
	summary: BeginnerAccountSummary;
	findings: BeginnerDiagnosticFinding[];
	nextAction: string;
}

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

	async function loadDiagnostics(
		extraFindings: BeginnerDiagnosticFinding[] = [],
	): Promise<DoctorDiagnostics> {
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
		// A user-disabled account that absorbed a fresh enabled re-login stays
		// disabled (fail-closed) but is otherwise invisible to diagnostics (#171).
		const disabledWithFreshCredential = storage
			? findDisabledAccountsWithFreshCredential(storage.accounts)
			: [];
		if (disabledWithFreshCredential.length > 0) {
			findings.push({
				severity: "warning",
				code: "disabled-account-fresh-credential",
				summary: `${disabledWithFreshCredential.length} disabled account(s) hold a fresh login credential.`,
				action: `A recent re-login landed on a disabled slot; re-enable it in oc-codex-multi-auth-accounts.json if intended (slots: ${disabledWithFreshCredential
					.map((index) => index + 1)
					.join(", ")}).`,
			});
		}
		findings.push(...extraFindings);

		return { storage, activeIndex, snapshots, runtime, summary, findings, nextAction };
	}

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
			const appliedFixes: string[] = [];
			const fixErrors: string[] = [];
			const extraFindings: BeginnerDiagnosticFinding[] = [];
			let routingVisibility: RoutingVisibilitySnapshot | null = null;
			let diagnostics = await loadDiagnostics();

			if (fix && diagnostics.storage && diagnostics.storage.accounts.length > 0) {
				const refreshResults: Array<{
					index: number;
					identity: RefreshAccountIdentity;
				}> = [];
				const reloginNeeded: number[] = [];
				let verificationFailures = 0;
				const inputs = buildRefreshInputs(diagnostics.storage.accounts);

				for (const input of inputs) {
					if (!input) continue;
					const outcome = await refreshAndPersistAccount(input);
					if (outcome.status === "refreshed") {
						refreshResults.push({
							index: outcome.index,
							identity: outcome.result.identity,
						});
					} else if (outcome.status === "skipped") {
						// Skip intentionally-disabled accounts: refreshing them is wrong
						// (e.g. the disabled token-source duplicate would get a spurious
						// "re-login" directive when its dead token fails, when the correct
						// remedy is `codex-remove`), and stale-state must never be cleared
						// on an entry the user disabled on purpose.
					} else {
						verificationFailures += 1;
						reloginNeeded.push(outcome.index + 1);
						fixErrors.push(
							`Account ${outcome.index + 1}: ${outcome.error} — run \`opencode auth login\` to re-authenticate.`,
						);
					}
				}

				if (verificationFailures > 0) {
					extraFindings.push({
						severity: "error",
						code: "refresh-verification-failed",
						summary: `${verificationFailures} account(s) failed refresh-token verification.`,
						action: `Re-authenticate the affected account(s) with \`opencode auth login\` (slots: ${reloginNeeded.join(", ")}).`,
					});
				}

				if (refreshResults.length > 0) {
					appliedFixes.push(
						`Refreshed and persisted ${refreshResults.length} account token(s).`,
					);

					// A successful refresh proves the credential is alive, so clear any
					// stale cooldown / rate-limit state that would otherwise keep the
					// recovered account out of rotation (issue #171). Apply this to a
					// fresh storage snapshot so non-credential state written by other
					// processes is preserved.
					try {
						const staleSummary = await withAccountStorageTransaction(
							async (current, persist) => {
								if (!current) {
									throw new Error("Account storage is unavailable");
								}
								const refreshedRecords = [];
								for (const refreshed of refreshResults) {
									const idx = findAccountIndexByIdentity(
										current.accounts,
										refreshed.identity,
									);
									const record = idx >= 0 ? current.accounts[idx] : undefined;
									if (record && record.enabled !== false) {
										refreshedRecords.push(record);
									}
								}
								const summary = clearRefreshedAccountsStaleState(refreshedRecords);
								if (
									summary.cooldownsCleared > 0 ||
									summary.rateLimitKeysCleared > 0
								) {
									await persist(current);
								}
								return summary;
							},
						);
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
							`Failed to persist stale-state repairs: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}

					// Stale TUI quota cache can reference an account index/count that no
					// longer matches the pool, making diagnostics misleading (#171).
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
						const switched = await withAccountStorageTransaction(
							async (current, persist) => {
								if (!current) return false;
								const currentActive = resolveActiveIndex(current, "codex");
								if (best.index === currentActive) return false;
								current.activeIndex = best.index;
								current.activeIndexByFamily =
									current.activeIndexByFamily ?? {};
								for (const family of MODEL_FAMILIES) {
									current.activeIndexByFamily[family] = best.index;
								}
								await persist(current);
								return true;
							},
						);
						if (switched) {
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

				// The initial diagnostics snapshot was taken before token verification.
				// Reload after fixes so the reported health never contradicts live
				// refresh results (e.g. "8 healthy" alongside eight invalid tokens).
				diagnostics = await loadDiagnostics(extraFindings);
				if (verificationFailures > 0 && diagnostics.summary.healthy > 0) {
					diagnostics.summary.healthy = Math.max(
						0,
						diagnostics.summary.healthy - verificationFailures,
					);
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
					diagnostics.storage && diagnostics.storage.accounts.length > 0
						? resolveActiveIndex(diagnostics.storage, routingFamily)
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

			const { runtime, summary, findings, nextAction } = diagnostics;
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

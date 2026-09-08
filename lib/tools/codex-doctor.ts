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
	findDisabledAccountsWithFreshCredential,
	findDisabledTokenSourceDuplicates,
	findConflictingBusinessMemberCredentials,
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
	findAccountIndexByIdentity,
	type RefreshAccountIdentity,
} from "./refresh-account.js";
import { repairDoctorAccounts } from "./doctor-repair.js";
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
		reloadCachedAccountManager,
	} = ctx;

	async function loadDiagnostics(
		extraFindings: BeginnerDiagnosticFinding[] = [],
		verificationFailureIdentities: RefreshAccountIdentity[] = [],
	): Promise<DoctorDiagnostics> {
		const storage = await loadAccounts();
		const now = Date.now();
		const activeIndex =
			storage && storage.accounts.length > 0
				? resolveActiveIndex(storage, "codex")
				: 0;
		const failedIndices = new Set(
			verificationFailureIdentities
				.map((identity) => findAccountIndexByIdentity(storage?.accounts ?? [], identity))
				.filter((index) => index >= 0),
		);
		const snapshots = storage
			? toBeginnerAccountSnapshots(storage, activeIndex, now)
				.map((snapshot) => ({
					...snapshot,
					refreshVerificationFailed: failedIndices.has(snapshot.index),
				}))
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
		const businessMemberConflicts = storage
			? findConflictingBusinessMemberCredentials(storage.accounts)
			: [];
		if (businessMemberConflicts.length > 0) {
			findings.push({
				severity: "error",
				code: "business-member-credential-conflict",
				summary: `${businessMemberConflicts.length} Business member group(s) use one OAuth credential under different emails.`,
				action: `Remove and re-login the affected slots separately (${businessMemberConflicts
					.map((indices) => indices.map((index) => index + 1).join("/"))
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
				const repair = await repairDoctorAccounts(diagnostics.storage.accounts);
				const { reloginNeeded, verificationFailureIdentities } = repair;
				appliedFixes.push(...repair.appliedFixes);
				fixErrors.push(...repair.fixErrors);

				if (verificationFailureIdentities.length > 0) {
					extraFindings.push({
						severity: "error",
						code: "refresh-verification-failed",
						summary: `${verificationFailureIdentities.length} account(s) failed refresh-token verification.`,
						action: `Re-authenticate the affected account(s) with \`opencode auth login\` (slots: ${reloginNeeded.join(", ")}).`,
					});
				}

				if (repair.refreshedCount > 0) {
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
					const bestAccount = best
						? managerForFix.getAccountsSnapshot()[best.index]
						: undefined;
					if (best && bestAccount) {
						const bestIdentity: RefreshAccountIdentity = {
							organizationId: bestAccount.organizationId,
							accountId: bestAccount.accountId,
							accountUserId: bestAccount.accountUserId,
							refreshToken: bestAccount.refreshToken,
						};
						const switchResult = await withAccountStorageTransaction(
							async (current, persist) => {
								if (!current) return "missing";
								const freshBestIndex = findAccountIndexByIdentity(
									current.accounts,
									bestIdentity,
								);
								if (freshBestIndex < 0) return "missing";
								const currentActive = resolveActiveIndex(current, "codex");
								if (freshBestIndex === currentActive) return "unchanged";
								current.activeIndex = freshBestIndex;
								current.activeIndexByFamily =
									current.activeIndexByFamily ?? {};
								for (const family of MODEL_FAMILIES) {
									current.activeIndexByFamily[family] = freshBestIndex;
								}
								await persist(current);
								return "switched";
							},
						);
						if (switchResult === "switched") {
							appliedFixes.push(
								`Switched active account to ${best.index + 1} (best eligible).`,
							);
						} else if (switchResult === "missing") {
							fixErrors.push(
								"Selected account changed during auto-switch; no switch was applied.",
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

				await reloadCachedAccountManager();

				// The initial diagnostics snapshot was taken before token verification.
				// Reload after fixes so the reported health never contradicts live
				// refresh results (e.g. "8 healthy" alongside eight invalid tokens).
				diagnostics = await loadDiagnostics(
					extraFindings,
					verificationFailureIdentities,
				);
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

/**
 * `codex-dashboard` tool — live dashboard of accounts, retry, refresh queue.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts } from "../storage.js";
import { AccountManager } from "../accounts.js";
import { getRefreshQueueMetrics } from "../refresh-queue.js";
import { recommendBeginnerNextAction } from "../ui/beginner.js";
import {
	formatUiBadge,
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
	formatUiSection,
} from "../ui/format.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
import type { ToolContext } from "./index.js";

export function createCodexDashboardTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		resolveActiveIndex,
		formatCommandAccountLabel,
		resolveMaskEmail,
		buildJsonAccountIdentity,
		buildRoutingVisibilitySnapshot,
		appendRoutingVisibilityText,
		appendRoutingVisibilityUi,
		toBeginnerAccountSnapshots,
		getBeginnerRuntimeSnapshot,
		runtimeMetrics,
		beginnerSafeModeRef,
		cachedAccountManagerRef,
	} = ctx;
	return tool({
		description:
			"Show a live Codex dashboard: account eligibility, retry budgets, and refresh queue health.",
		args: {
			format: tool.schema
				.string()
				.optional()
				.describe('Output format: "text" (default) or "json".'),
			includeSensitive: tool.schema
				.boolean()
				.optional()
				.describe(
					"Include raw account labels, emails, and account IDs in JSON output. Defaults to false.",
				),
		},
		async execute({
			format,
			includeSensitive,
		}: {
			format?: string;
			includeSensitive?: boolean;
		} = {}) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const outputFormat = normalizeToolOutputFormat(format);
			const includeSensitiveOutput = includeSensitive === true;
			const storage = await loadAccounts();
			const beginnerSafeModeEnabled = beginnerSafeModeRef.current;
			if (!storage || storage.accounts.length === 0) {
				if (outputFormat === "json") {
					return renderJsonOutput({
						message:
							"No Codex accounts configured. Run: opencode auth login",
						accountCount: 0,
						selectionLens: null,
						retryProfile: runtimeMetrics.retryProfile,
						beginnerSafeMode: beginnerSafeModeEnabled,
						retryBudgetUsage: { ...runtimeMetrics.retryBudgetUsage },
						refreshQueue: { ...getRefreshQueueMetrics() },
						routingVisibility: buildRoutingVisibilitySnapshot(),
						accountEligibility: [],
						recommendedNextAction: "Run opencode auth login",
						lastError:
							runtimeMetrics.lastError === null
								? null
								: {
										message: runtimeMetrics.lastError,
										category: runtimeMetrics.lastErrorCategory,
									},
					});
				}
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Codex dashboard"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			const now = Date.now();
			const refreshMetrics = getRefreshQueueMetrics();
			const family = runtimeMetrics.lastSelectionSnapshot?.family ?? "codex";
			const model =
				runtimeMetrics.lastSelectionSnapshot?.effectiveModel ??
				runtimeMetrics.lastSelectionSnapshot?.model ??
				undefined;
			const manager =
				cachedAccountManagerRef.current ?? (await AccountManager.loadFromDisk());
			const explainability = manager.getSelectionExplainability(
				family,
				model,
				now,
			);
			const selectionLabel = model ? `${family}:${model}` : family;
			const routingVisibility = buildRoutingVisibilitySnapshot({
				modelFamily: family,
				effectiveModel: model ?? null,
				quotaKey: model ? `${family}:${model}` : family,
				selectedAccountIndex: resolveActiveIndex(storage, family),
				selectionExplainability: explainability,
			});
			const recommendedNextAction = recommendBeginnerNextAction({
				accounts: toBeginnerAccountSnapshots(
					storage,
					resolveActiveIndex(storage, "codex"),
					now,
				),
				now,
				runtime: getBeginnerRuntimeSnapshot(),
			});
			if (outputFormat === "json") {
				return renderJsonOutput({
					accountCount: storage.accounts.length,
					selectionLens: selectionLabel,
					retryProfile: runtimeMetrics.retryProfile,
					beginnerSafeMode: beginnerSafeModeEnabled,
					retryBudgetUsage: { ...runtimeMetrics.retryBudgetUsage },
					refreshQueue: { ...refreshMetrics },
					routingVisibility,
					accountEligibility: explainability.map((entry) => ({
						...buildJsonAccountIdentity(entry.index, {
							includeSensitive: includeSensitiveOutput,
							account: storage.accounts[entry.index],
						}),
						eligible: entry.eligible,
						healthScore: entry.healthScore,
						tokensAvailable: entry.tokensAvailable,
						reasons: [...entry.reasons],
					})),
					recommendedNextAction,
					lastError:
						runtimeMetrics.lastError === null
							? null
							: {
									message: runtimeMetrics.lastError,
									category: runtimeMetrics.lastErrorCategory,
								},
				});
			}

			if (ui.v2Enabled) {
				const lines: string[] = [
					...formatUiHeader(ui, "Codex dashboard"),
					formatUiKeyValue(ui, "Accounts", String(storage.accounts.length)),
					formatUiKeyValue(ui, "Selection lens", selectionLabel, "muted"),
					formatUiKeyValue(
						ui,
						"Retry profile",
						runtimeMetrics.retryProfile,
						"muted",
					),
					formatUiKeyValue(
						ui,
						"Beginner safe mode",
						beginnerSafeModeEnabled ? "on" : "off",
						beginnerSafeModeEnabled ? "accent" : "muted",
					),
					formatUiKeyValue(
						ui,
						"Retry usage",
						`A${runtimeMetrics.retryBudgetUsage.authRefresh} N${runtimeMetrics.retryBudgetUsage.network} S${runtimeMetrics.retryBudgetUsage.server} RS${runtimeMetrics.retryBudgetUsage.rateLimitShort} RG${runtimeMetrics.retryBudgetUsage.rateLimitGlobal} E${runtimeMetrics.retryBudgetUsage.emptyResponse}`,
						"muted",
					),
					formatUiKeyValue(
						ui,
						"Refresh queue",
						`pending=${refreshMetrics.pending}, success=${refreshMetrics.succeeded}, failed=${refreshMetrics.failed}`,
						"muted",
					),
					"",
				];
				appendRoutingVisibilityUi(ui, lines, routingVisibility);
				lines.push("");
				lines.push(...formatUiSection(ui, "Account eligibility"));

				for (const entry of explainability) {
					const label = formatCommandAccountLabel(
						storage.accounts[entry.index],
						entry.index,
						{ maskEmail },
					);
					const state = entry.eligible
						? formatUiBadge(ui, "eligible", "success")
						: formatUiBadge(ui, "blocked", "warning");
					lines.push(
						formatUiItem(
							ui,
							`${label} ${state} health=${Math.round(entry.healthScore)} tokens=${entry.tokensAvailable.toFixed(1)} reasons=${entry.reasons.join(", ")}`,
						),
					);
				}

				lines.push("");
				lines.push(...formatUiSection(ui, "Recommended next step"));
				lines.push(formatUiItem(ui, recommendedNextAction, "accent"));

				if (runtimeMetrics.lastError) {
					lines.push("");
					lines.push(...formatUiSection(ui, "Last error"));
					lines.push(
						formatUiItem(ui, runtimeMetrics.lastError, "danger"),
					);
					if (runtimeMetrics.lastErrorCategory) {
						lines.push(
							formatUiKeyValue(
								ui,
								"Category",
								runtimeMetrics.lastErrorCategory,
								"warning",
							),
						);
					}
				}

				return lines.join("\n");
			}

			const lines: string[] = [
				"Codex Dashboard:",
				`Accounts: ${storage.accounts.length}`,
				`Selection lens: ${selectionLabel}`,
				`Retry profile: ${runtimeMetrics.retryProfile}`,
				`Beginner safe mode: ${beginnerSafeModeEnabled ? "on" : "off"}`,
				`Retry usage: auth=${runtimeMetrics.retryBudgetUsage.authRefresh}, network=${runtimeMetrics.retryBudgetUsage.network}, server=${runtimeMetrics.retryBudgetUsage.server}, short429=${runtimeMetrics.retryBudgetUsage.rateLimitShort}, global429=${runtimeMetrics.retryBudgetUsage.rateLimitGlobal}, empty=${runtimeMetrics.retryBudgetUsage.emptyResponse}`,
				`Refresh queue: pending=${refreshMetrics.pending}, success=${refreshMetrics.succeeded}, failed=${refreshMetrics.failed}`,
			];
			lines.push("");
			appendRoutingVisibilityText(lines, routingVisibility);
			lines.push("");
			lines.push("Account eligibility:");

			for (const entry of explainability) {
				const label = formatCommandAccountLabel(
					storage.accounts[entry.index],
					entry.index,
					{ maskEmail },
				);
				lines.push(
					`  - ${label}: ${entry.eligible ? "eligible" : "blocked"} | health=${Math.round(entry.healthScore)} | tokens=${entry.tokensAvailable.toFixed(1)} | reasons=${entry.reasons.join(", ")}`,
				);
			}

			lines.push("");
			lines.push(`Recommended next step: ${recommendedNextAction}`);

			if (runtimeMetrics.lastError) {
				lines.push("");
				lines.push(`Last error: ${runtimeMetrics.lastError}`);
				if (runtimeMetrics.lastErrorCategory) {
					lines.push(`Category: ${runtimeMetrics.lastErrorCategory}`);
				}
			}

			return lines.join("\n");
		},
	});
}

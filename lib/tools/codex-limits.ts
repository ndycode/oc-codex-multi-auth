/**
 * `codex-limits` tool — show Codex usage limits per account.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts } from "../storage.js";
import {
	deduplicateUsageAccountIndices,
	ensureCodexUsageAccessToken,
	fetchCodexUsage,
	formatResetCredits,
	formatSpendableUsageCredits,
	formatUsageLimitSummary,
	formatUsageLimitTitle,
	formatUsagePoolSummary,
	getUsageQuotaExhaustedResetAtMs,
	getUsageAccountDedupeKey,
	hasUsageWindow,
	parseCodexUsagePayload,
	persistUsageQuotaExhaustion,
	persistUsageQuotaRecovery,
	isUsageQuotaRecovered,
	resolveCodexUsageAccountId,
	summarizeUsagePool,
	type UsagePoolMember,
} from "../codex-usage.js";
import { formatPlanMultiplier } from "../plan-allotment.js";
import { creditsLedger, getCreditsAccountKey } from "../codex-credits.js";
import { getQuotaDisplay, loadPluginConfig } from "../config.js";
import { PLUGIN_NAME } from "../constants.js";
import { logWarn } from "../logger.js";
import {
	formatUiBadge,
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
} from "../ui/format.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
import { formatPlanType } from "../auth/plan-tier.js";
import {
	TOOL_INCLUDE_SENSITIVE_DESCRIPTION,
	TOOL_OUTPUT_FORMAT_DESCRIPTION,
	TOOL_OUTPUT_FORMAT_VALUES,
} from "./args.js";
import { sanitizeToolErrorMessage, withToolErrorEnvelope } from "./output.js";
import type { ToolContext } from "./index.js";

/**
 * `Pro (20x)` - the plan, and what one of its seats is worth beside the others.
 *
 * The ratio is appended only when the plan states one. Free, Go and Enterprise
 * publish no per-seat figure, and rendering `1x` for them would assert a
 * baseline OpenAI never set.
 */
function formatPlanWithAllotment(
	planType: string | null | undefined,
): string | undefined {
	const label = formatPlanType(planType);
	if (!label) return undefined;
	const multiplier = formatPlanMultiplier(planType);
	return multiplier ? `${label} (${multiplier})` : label;
}

/**
 * Build the `codex-limits` tool.
 *
 * The tool fetches and renders Codex usage quotas for each unique account.
 * Accounts are deduplicated by workspace identity via
 * {@link getUsageAccountDedupeKey} so distinct workspaces are shown separately,
 * while the active-account marker is only applied when an account matches both
 * the active refresh token and the active workspace dedupe key.
 *
 * @param ctx - Shared {@link ToolContext} providing UI runtime and account helpers.
 * @returns The `codex-limits` {@link ToolDefinition}.
 */
export function createCodexLimitsTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		resolveActiveIndex,
		formatCommandAccountLabel,
		resolveMaskEmail,
		buildJsonAccountIdentity,
		invalidateAccountManagerCache,
	} = ctx;
	const definition = tool({
		// Agent-facing: the rendered text below is already the full report, so
		// the description forbids the summarization that tends to drop the
		// banked-reset and 5-hour columns the user came here for.
		description:
			"Show live 5-hour and weekly Codex usage limits for all accounts. Report the result in full: keep one row per reported account and every field the output emits — 5-hour limit, weekly limit, code review, each additional limit under its rendered name, plan, credits, and banked resets (`Resets: N banked`) — plus the closing Pool total when present. Preserve account errors and unavailable-data messages; do not invent missing fields or treat absent reset data as zero. Do not collapse rows into a shorter table or omit an emitted field. Banked resets are redeemable with codex-reset.",
		args: {
			format: tool.schema
				.enum(TOOL_OUTPUT_FORMAT_VALUES)
				.optional()
				.describe(TOOL_OUTPUT_FORMAT_DESCRIPTION),
			includeSensitive: tool.schema
				.boolean()
				.optional()
				.describe(TOOL_INCLUDE_SENSITIVE_DESCRIPTION),
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
			const quotaDisplay = getQuotaDisplay(loadPluginConfig());
			const outputFormat = normalizeToolOutputFormat(format);
			const includeSensitiveOutput = includeSensitive === true;
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (outputFormat === "json") {
					return renderJsonOutput({
						message:
							"No Codex accounts configured. Run: opencode auth login",
						totalAccounts: 0,
						uniqueCredentialCount: 0,
						activeIndex: null,
						// Same shape as a populated pool: `null` when nothing is readable.
						pool: null,
						accounts: [],
					});
				}
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Codex limits"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			const uniqueIndices = deduplicateUsageAccountIndices(storage);

			const lines: string[] = ui.v2Enabled
				? [...formatUiHeader(ui, "Codex limits"), ""]
				: [
						`Codex limits (${uniqueIndices.length} account${uniqueIndices.length === 1 ? "" : "s"}):`,
						"",
					];
			const activeIndex = resolveActiveIndex(storage, "codex");
			const activeRefreshToken =
				typeof activeIndex === "number" &&
				activeIndex >= 0 &&
				activeIndex < storage.accounts.length
					? storage.accounts[activeIndex]?.refreshToken?.trim() || undefined
					: undefined;
			const activeAccount =
				typeof activeIndex === "number" &&
				activeIndex >= 0 &&
				activeIndex < storage.accounts.length
					? storage.accounts[activeIndex]
					: undefined;
			const activeUsageKey = activeAccount
				? getUsageAccountDedupeKey(activeAccount)
				: undefined;
			// If the active account index isn't in uniqueIndices, the active
			// account was dropped from the usage list — e.g. it is an earlier
			// occurrence of a workspace whose freshest (last) occurrence was kept,
			// or it is disabled. Warn so the missing `[active]` marker is
			// diagnosable. The key-based match below recovers the marker onto the
			// surviving workspace entry.
			if (
				typeof activeIndex === "number" &&
				activeIndex >= 0 &&
				activeIndex < storage.accounts.length &&
				!uniqueIndices.includes(activeIndex)
			) {
				logWarn(
					`[${PLUGIN_NAME}] active account index ${activeIndex} was deduplicated out of the usage list; matching the active workspace by identity instead.`,
				);
			}
			// Only accounts that answered contribute to the pool total. An
			// account that failed to report is left out entirely rather than
			// counted as full or as empty, since either would state capacity
			// nobody measured.
			const poolMembers: UsagePoolMember[] = [];
			let storageChanged = false;
			let quotaExhaustionPersistedOrKnown = false;
			const jsonAccounts: Array<Record<string, unknown>> = [];

			for (const i of uniqueIndices) {
				const account = storage.accounts[i];
				if (!account) continue;
				const accountUsageKey = getUsageAccountDedupeKey(account);
				// Match the active account by workspace identity first: two entries
				// for the same workspace can carry different refresh tokens (e.g. a
				// re-issued token after re-add), so an exact token match alone would
				// drop the `[active]` marker. Fall back to refresh-token equality for
				// accounts that have no workspace identity (token-only dedupe key).
				const sharesActiveCredential = activeUsageKey
					? accountUsageKey === activeUsageKey
					: !!activeRefreshToken &&
						account.refreshToken === activeRefreshToken;
				const displayIndex =
					sharesActiveCredential && typeof activeIndex === "number"
						? activeIndex
						: i;
				const displayAccount = storage.accounts[displayIndex];
				if (sharesActiveCredential && !displayAccount) {
					logWarn(
						`[${PLUGIN_NAME}] active account entry missing for index ${displayIndex}, falling back to account ${i}`,
					);
				}
				const effectiveDisplayAccount = displayAccount ?? account;
				const label = formatCommandAccountLabel(
					effectiveDisplayAccount,
					displayIndex,
					{ peerAccounts: storage.accounts },
				);
				const displayLabel = formatCommandAccountLabel(
					effectiveDisplayAccount,
					displayIndex,
					{ maskEmail, peerAccounts: storage.accounts },
				);
				const isActive = i === activeIndex || sharesActiveCredential;
				const activeSuffix = isActive
					? ui.v2Enabled
						? ` ${formatUiBadge(ui, "active", "accent")}`
						: " [active]"
					: "";

				try {
					const credentials = await ensureCodexUsageAccessToken({
						storage,
						account,
					});
					storageChanged = storageChanged || credentials.persisted;
					const effectiveAccount = sharesActiveCredential
						? effectiveDisplayAccount
						: account;
					const accountId = resolveCodexUsageAccountId({
						account: effectiveAccount,
						accessToken: credentials.accessToken,
					});
					if (!accountId) {
						throw new Error("Missing account id");
					}

					const payload = await fetchCodexUsage({
						accountId,
						accessToken: credentials.accessToken,
						organizationId: effectiveAccount.organizationId,
					});
					const usage = parseCodexUsagePayload(payload, quotaDisplay);
					creditsLedger.record(getCreditsAccountKey(effectiveAccount), usage.creditsBalance);
					const creditsLine = formatSpendableUsageCredits(usage.creditsBalance);
					const quotaExhaustedResetAtMs = getUsageQuotaExhaustedResetAtMs(
						[usage.primary, usage.secondary],
					);
					if (quotaExhaustedResetAtMs !== undefined) {
						try {
							storageChanged =
								(await persistUsageQuotaExhaustion(
									account,
									quotaExhaustedResetAtMs,
								)) || storageChanged;
							// The block can already have been persisted by another process.
							// Reload this process's AccountManager either way so its next
							// rotation observes the on-disk block.
							quotaExhaustionPersistedOrKnown = true;
							// Do this before fetching usage for another account: a cached
							// manager can still have a debounced save with stale rotation
							// state that would otherwise overwrite this durable block.
							invalidateAccountManagerCache();
						} catch (error) {
							logWarn(
								`[${PLUGIN_NAME}] Failed to persist exhausted usage quota: ${
									error instanceof Error ? error.message : String(error)
								}`,
							);
						}
					}
					if (isUsageQuotaRecovered([usage.primary, usage.secondary])) {
						try {
							if (await persistUsageQuotaRecovery(account)) {
								storageChanged = true;
								quotaExhaustionPersistedOrKnown = true;
								invalidateAccountManagerCache();
							}
						} catch {
							logWarn("Failed to persist recovered usage quota");
						}
					}
					poolMembers.push({
						planType: usage.planType,
						primary: usage.primary,
						secondary: usage.secondary,
					});
					jsonAccounts.push({
						...buildJsonAccountIdentity(displayIndex, {
							includeSensitive: includeSensitiveOutput,
							account: effectiveDisplayAccount,
							label,
							peerAccounts: storage.accounts,
						}),
						isActive,
						sharesActiveCredential,
						planType: usage.planType,
						planMultiplier: formatPlanMultiplier(usage.planType) ?? null,
						credits: usage.credits,
						resetCredits: usage.resetCredits,
						limits: usage.limits,
					});

					if (ui.v2Enabled) {
						lines.push(formatUiItem(ui, displayLabel, "normal", activeSuffix));
						for (const window of [usage.primary, usage.secondary]) {
							if (!hasUsageWindow(window)) continue;
							lines.push(
								`  ${formatUiKeyValue(ui, formatUsageLimitTitle(window.windowMinutes), formatUsageLimitSummary(window, quotaDisplay), "muted")}`,
							);
						}
						if (hasUsageWindow(usage.codeReview)) {
							lines.push(
								`  ${formatUiKeyValue(ui, "Code review", formatUsageLimitSummary(usage.codeReview, quotaDisplay), "muted")}`,
							);
						}
						for (const limit of usage.additionalLimits) {
							lines.push(
								`  ${formatUiKeyValue(ui, limit.name, formatUsageLimitSummary(limit.window, quotaDisplay), "muted")}`,
							);
						}
						const planLabel = formatPlanWithAllotment(usage.planType);
						if (planLabel) {
							lines.push(
								`  ${formatUiKeyValue(ui, "Plan", planLabel, "muted")}`,
							);
						}
						if (creditsLine) {
							lines.push(
								`  ${formatUiKeyValue(ui, "Credits", creditsLine, "muted")}`,
							);
						}
						// Always report the banked-reset reading when the server
						// stated it — including `0 banked`. Missing data stays absent.
						if (usage.resetCredits) {
							lines.push(
								`  ${formatUiKeyValue(ui, "Resets", formatResetCredits(usage.resetCredits), "muted")}`,
							);
						}
					} else {
						lines.push(`${displayLabel}${activeSuffix}:`);
						for (const window of [usage.primary, usage.secondary]) {
							if (!hasUsageWindow(window)) continue;
							lines.push(
								`  ${formatUsageLimitTitle(window.windowMinutes)}: ${formatUsageLimitSummary(window, quotaDisplay)}`,
							);
						}
						if (hasUsageWindow(usage.codeReview)) {
							lines.push(
								`  Code review: ${formatUsageLimitSummary(usage.codeReview, quotaDisplay)}`,
							);
						}
						for (const limit of usage.additionalLimits) {
							lines.push(
								`  ${limit.name}: ${formatUsageLimitSummary(limit.window, quotaDisplay)}`,
							);
						}
						const planLabel = formatPlanWithAllotment(usage.planType);
						if (planLabel) {
							lines.push(`  Plan: ${planLabel}`);
						}
						if (creditsLine) {
							lines.push(`  Credits: ${creditsLine}`);
						}
						// Always report the banked-reset reading when the server
						// stated it — including `0 banked`. Missing data stays absent.
						if (usage.resetCredits) {
							lines.push(
								`  Resets: ${formatResetCredits(usage.resetCredits)}`,
							);
						}
					}
				} catch (error) {
					// Upstream usage-endpoint errors can carry account-identifying or
					// credential-shaped text — mask and truncate before output.
					const message = sanitizeToolErrorMessage(
						error instanceof Error ? error.message : String(error),
					);
					jsonAccounts.push({
						...buildJsonAccountIdentity(displayIndex, {
							includeSensitive: includeSensitiveOutput,
							account: effectiveDisplayAccount,
							label,
							peerAccounts: storage.accounts,
						}),
						isActive,
						sharesActiveCredential,
						error: message,
					});
					if (ui.v2Enabled) {
						lines.push(formatUiItem(ui, displayLabel, "normal", activeSuffix));
						lines.push(
							`  ${formatUiKeyValue(ui, "Error", message, "danger")}`,
						);
					} else {
						lines.push(`${displayLabel}${activeSuffix}:`);
						lines.push(`  Error: ${message}`);
					}
				}

				lines.push("");
			}

			if (storageChanged || quotaExhaustionPersistedOrKnown) {
				invalidateAccountManagerCache();
			}
			const pool = summarizeUsagePool(poolMembers);
			if (outputFormat === "json") {
				return renderJsonOutput({
					totalAccounts: storage.accounts.length,
					uniqueCredentialCount: uniqueIndices.length,
					activeIndex: activeIndex + 1,
					// Both percentages are stated so a consumer never has to
					// know which way `quotaDisplay` was pointing to read them.
					pool: pool
						? {
								leftPercent: pool.leftPercent,
								usedPercent: 100 - pool.leftPercent,
								allotment: pool.allotment,
								countedAccounts: pool.countedAccounts,
							}
						: null,
					accounts: jsonAccounts,
				});
			}

			while (lines.length > 0 && lines[lines.length - 1] === "") {
				lines.pop();
			}

			if (pool) {
				lines.push("");
				const summary = formatUsagePoolSummary(pool, quotaDisplay);
				lines.push(
					ui.v2Enabled
						? formatUiKeyValue(ui, "Pool", summary, "muted")
						: `Pool: ${summary}`,
				);
			}

			return lines.join("\n");
		},
	});
	return withToolErrorEnvelope("codex-limits", definition);
}

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
	formatUsageLimitSummary,
	formatUsageLimitTitle,
	getUsageAccountDedupeKey,
	hasUsageWindow,
	parseCodexUsagePayload,
	resolveCodexUsageAccountId,
} from "../codex-usage.js";
import { PLUGIN_NAME } from "../constants.js";
import { logWarn } from "../logger.js";
import {
	formatUiBadge,
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
} from "../ui/format.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
import type { ToolContext } from "./index.js";

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
		buildJsonAccountIdentity,
		invalidateAccountManagerCache,
	} = ctx;
	return tool({
		description:
			"Show live 5-hour and weekly Codex usage limits for all accounts.",
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
			let storageChanged = false;
			const jsonAccounts: Array<Record<string, unknown>> = [];

			for (const i of uniqueIndices) {
				const account = storage.accounts[i];
				if (!account) continue;
				const accountUsageKey = getUsageAccountDedupeKey(account);
				const sharesActiveCredential =
					!!activeRefreshToken &&
					account.refreshToken === activeRefreshToken &&
					!!activeUsageKey &&
					accountUsageKey === activeUsageKey;
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
					const usage = parseCodexUsagePayload(payload);
					jsonAccounts.push({
						...buildJsonAccountIdentity(displayIndex, {
							includeSensitive: includeSensitiveOutput,
							account: effectiveDisplayAccount,
							label,
						}),
						isActive,
						sharesActiveCredential,
						planType: usage.planType,
						credits: usage.credits,
						limits: usage.limits,
					});

					if (ui.v2Enabled) {
						lines.push(formatUiItem(ui, `${label}${activeSuffix}`));
						lines.push(
							`  ${formatUiKeyValue(ui, formatUsageLimitTitle(usage.primary.windowMinutes), formatUsageLimitSummary(usage.primary), "muted")}`,
						);
						lines.push(
							`  ${formatUiKeyValue(ui, formatUsageLimitTitle(usage.secondary.windowMinutes), formatUsageLimitSummary(usage.secondary), "muted")}`,
						);
						if (hasUsageWindow(usage.codeReview)) {
							lines.push(
								`  ${formatUiKeyValue(ui, "Code review", formatUsageLimitSummary(usage.codeReview), "muted")}`,
							);
						}
						for (const limit of usage.additionalLimits) {
							lines.push(
								`  ${formatUiKeyValue(ui, limit.name, formatUsageLimitSummary(limit.window), "muted")}`,
							);
						}
						if (usage.planType) {
							lines.push(
								`  ${formatUiKeyValue(ui, "Plan", usage.planType, "muted")}`,
							);
						}
						if (usage.credits) {
							lines.push(
								`  ${formatUiKeyValue(ui, "Credits", usage.credits, "muted")}`,
							);
						}
					} else {
						lines.push(`${label}${activeSuffix}:`);
						lines.push(
							`  ${formatUsageLimitTitle(usage.primary.windowMinutes)}: ${formatUsageLimitSummary(usage.primary)}`,
						);
						lines.push(
							`  ${formatUsageLimitTitle(usage.secondary.windowMinutes)}: ${formatUsageLimitSummary(usage.secondary)}`,
						);
						if (hasUsageWindow(usage.codeReview)) {
							lines.push(
								`  Code review: ${formatUsageLimitSummary(usage.codeReview)}`,
							);
						}
						for (const limit of usage.additionalLimits) {
							lines.push(
								`  ${limit.name}: ${formatUsageLimitSummary(limit.window)}`,
							);
						}
						if (usage.planType) {
							lines.push(`  Plan: ${usage.planType}`);
						}
						if (usage.credits) {
							lines.push(`  Credits: ${usage.credits}`);
						}
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					jsonAccounts.push({
						...buildJsonAccountIdentity(displayIndex, {
							includeSensitive: includeSensitiveOutput,
							account: effectiveDisplayAccount,
							label,
						}),
						isActive,
						sharesActiveCredential,
						error: message.slice(0, 160),
					});
					if (ui.v2Enabled) {
						lines.push(formatUiItem(ui, `${label}${activeSuffix}`));
						lines.push(
							`  ${formatUiKeyValue(ui, "Error", message.slice(0, 160), "danger")}`,
						);
					} else {
						lines.push(`${label}${activeSuffix}:`);
						lines.push(`  Error: ${message.slice(0, 160)}`);
					}
				}

				lines.push("");
			}

			if (storageChanged) {
				invalidateAccountManagerCache();
			}
			if (outputFormat === "json") {
				return renderJsonOutput({
					totalAccounts: storage.accounts.length,
					uniqueCredentialCount: uniqueIndices.length,
					activeIndex: activeIndex + 1,
					accounts: jsonAccounts,
				});
			}

			while (lines.length > 0 && lines[lines.length - 1] === "") {
				lines.pop();
			}

			return lines.join("\n");
		},
	});
}

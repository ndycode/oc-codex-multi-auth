/**
 * `codex-health` tool — verify refresh tokens for all accounts.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts } from "../storage.js";
import { queuedRefresh } from "../refresh-queue.js";
import {
	findDisabledTokenSourceDuplicates,
	findStaleRecoverableAccounts,
} from "../accounts/stale-state.js";
import { formatUiHeader, formatUiItem, paintUiText } from "../ui/format.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
import type { ToolContext } from "./index.js";

export function createCodexHealthTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		formatCommandAccountLabel,
		resolveMaskEmail,
		getStatusMarker,
		buildJsonAccountIdentity,
	} = ctx;
	return tool({
		description:
			"Check health of all Codex accounts by validating refresh tokens.",
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
			if (!storage || storage.accounts.length === 0) {
				if (outputFormat === "json") {
					return renderJsonOutput({
						message:
							"No Codex accounts configured. Run: opencode auth login",
						totalAccounts: 0,
						healthyCount: 0,
						unhealthyCount: 0,
						accounts: [],
					});
				}
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Health check"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			const results: string[] = ui.v2Enabled
				? []
				: [`Health Check (${storage.accounts.length} accounts):`, ""];
			const jsonAccounts: Array<Record<string, unknown>> = [];

			let healthyCount = 0;
			let unhealthyCount = 0;

			for (let i = 0; i < storage.accounts.length; i++) {
				const account = storage.accounts[i];
				if (!account) continue;

				const label = formatCommandAccountLabel(account, i);
				const displayLabel = formatCommandAccountLabel(account, i, { maskEmail });
				try {
					const refreshResult = await queuedRefresh(account.refreshToken);
					if (refreshResult.type === "success") {
						jsonAccounts.push({
							...buildJsonAccountIdentity(i, {
								includeSensitive: includeSensitiveOutput,
								account,
								label,
							}),
							status: "healthy",
						});
						results.push(
							`  ${getStatusMarker(ui, "ok")} ${displayLabel}: Healthy`,
						);
						healthyCount++;
					} else {
						jsonAccounts.push({
							...buildJsonAccountIdentity(i, {
								includeSensitive: includeSensitiveOutput,
								account,
								label,
							}),
							status: "unhealthy",
							error: refreshResult.message ?? refreshResult.reason,
						});
						results.push(
							`  ${getStatusMarker(ui, "error")} ${displayLabel}: Token refresh failed`,
						);
						unhealthyCount++;
					}
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					jsonAccounts.push({
						...buildJsonAccountIdentity(i, {
							includeSensitive: includeSensitiveOutput,
							account,
							label,
						}),
						status: "unhealthy",
						error: errorMsg.slice(0, 120),
					});
					results.push(
						`  ${getStatusMarker(ui, "error")} ${displayLabel}: Error - ${errorMsg.slice(0, 120)}`,
					);
					unhealthyCount++;
				}
			}

			results.push("");
			results.push(
				`Summary: ${healthyCount} healthy, ${unhealthyCount} unhealthy`,
			);

			// Surface recoverable stale state and disabled token-source duplicates
			// (issue #171). codex-health is read-only, so it points the user at the
			// repair (`codex-doctor --fix` / `codex-remove`) rather than mutating.
			const staleRecoverable = findStaleRecoverableAccounts(storage.accounts);
			const duplicateSlots = findDisabledTokenSourceDuplicates(storage.accounts);
			const staleSlots = staleRecoverable.map((index) => index + 1);
			const dupSlots = duplicateSlots.map((index) => index + 1);
			if (staleSlots.length > 0) {
				results.push(
					`Stale state: ${staleSlots.length} account(s) blocked by a stale cooldown/rate-limit (slots: ${staleSlots.join(", ")}). Run \`codex-doctor --fix\`.`,
				);
			}
			if (dupSlots.length > 0) {
				results.push(
					`Duplicates: ${dupSlots.length} disabled duplicate entry(ies) shadow a real account (slots: ${dupSlots.join(", ")}). Remove with \`codex-remove\`.`,
				);
			}
			if (outputFormat === "json") {
				return renderJsonOutput({
					totalAccounts: storage.accounts.length,
					healthyCount,
					unhealthyCount,
					staleRecoverableSlots: staleSlots,
					disabledDuplicateSlots: dupSlots,
					accounts: jsonAccounts,
				});
			}

			if (ui.v2Enabled) {
				return [
					...formatUiHeader(ui, "Health check"),
					"",
					...results.map((line) => paintUiText(ui, line, "normal")),
				].join("\n");
			}

			return results.join("\n");
		},
	});
}

/**
 * `codex-warm` tool — prime every account's usage window (issue #182).
 *
 * Sends one lightweight authenticated request to each enabled account so its
 * rolling usage window starts immediately, instead of only when rotation
 * eventually lands on it. This lets users "send a hi to each account" at the
 * start of a session to stagger the ~5h quota windows.
 *
 * The decision/iteration logic lives in the pure {@link warmAccounts}
 * orchestrator; this tool supplies the real network adapter (`warmOne`) by
 * composing proven primitives:
 *   1. ensureCodexUsageAccessToken — refresh the OAuth token if near expiry
 *   2. resolveCodexUsageAccountId   — derive the chatgpt-account-id
 *   3. warmAccountWindow            — send a minimal billable POST /codex/responses
 *      that actually starts the rolling usage window
 *
 * A read-only GET /wham/usage does NOT open the window (it only reports
 * server-side windows that already exist), so warming must send a genuine
 * inference request. The warm ping is deliberately tiny (reasoning effort
 * "none", verbosity "low", no stored conversation) to keep the quota cost
 * negligible.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts, type AccountMetadataV3, type AccountStorageV3 } from "../storage.js";
import {
	ensureCodexUsageAccessToken,
	resolveCodexUsageAccountId,
} from "../codex-usage.js";
import { warmAccountWindow } from "../accounts/warm-request.js";
import { warmAccounts, type WarmOutcome } from "../accounts/warm.js";
import { logWarn } from "../logger.js";
import {
	formatUiHeader,
	formatUiItem,
	paintUiText,
} from "../ui/format.js";
import type { ToolContext } from "./index.js";

/**
 * Build the real per-account warm function. Exported for testing so the
 * adapter can be exercised against injected fakes without a live network.
 */
export function createWarmOne(
	storage: AccountStorageV3,
): (account: AccountMetadataV3) => Promise<WarmOutcome> {
	return async (account: AccountMetadataV3): Promise<WarmOutcome> => {
		const { accessToken } = await ensureCodexUsageAccessToken({ storage, account });
		const accountId = resolveCodexUsageAccountId({ account, accessToken });
		if (!accountId) {
			return {
				status: "failed",
				detail: "could not resolve account id (re-login may be required)",
			};
		}
		await warmAccountWindow({
			accountId,
			accessToken,
			organizationId: account.organizationId,
		});
		return { status: "warmed" };
	};
}

export function createCodexWarmTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		formatCommandAccountLabel,
		resolveMaskEmail,
		getStatusMarker,
	} = ctx;
	return tool({
		description:
			"Warm up all accounts by sending one lightweight request to each, starting their usage windows so weekly/5h quotas stagger instead of expiring together.",
		args: {},
		async execute() {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Warm accounts"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			const warmOne = createWarmOne(storage);
			const summary = await warmAccounts(storage.accounts, warmOne);

			const lines: string[] = ui.v2Enabled
				? []
				: [`Warming ${summary.total} account(s):`, ""];

			for (const result of summary.results) {
				const account = storage.accounts[result.index];
				const label = formatCommandAccountLabel(account, result.index, {
					maskEmail,
				});
				if (result.status === "warmed") {
					lines.push(`  ${getStatusMarker(ui, "ok")} ${label}: Window started`);
				} else if (result.status === "skipped") {
					lines.push(
						`  ${getStatusMarker(ui, "warning")} ${label}: Skipped (${result.detail ?? "disabled"})`,
					);
				} else {
					const detail = (result.detail ?? "unknown error").slice(0, 120);
					lines.push(`  ${getStatusMarker(ui, "error")} ${label}: Failed - ${detail}`);
				}
			}

			if (summary.failedCount > 0) {
				logWarn("codex-warm completed with failures", {
					warmed: summary.warmedCount,
					failed: summary.failedCount,
					skipped: summary.skippedCount,
				});
			}

			lines.push("");
			lines.push(
				`Summary: ${summary.warmedCount} warmed, ${summary.failedCount} failed, ${summary.skippedCount} skipped`,
			);

			if (ui.v2Enabled) {
				return [
					...formatUiHeader(ui, "Warm accounts"),
					"",
					...lines.map((line) => paintUiText(ui, line, "normal")),
				].join("\n");
			}
			return lines.join("\n");
		},
	});
}

/**
 * `codex-refresh` tool — manually refresh OAuth tokens for all accounts.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts } from "../storage.js";
import { AccountManager } from "../accounts.js";
import { formatUiHeader, formatUiItem, paintUiText } from "../ui/format.js";
import {
	buildRefreshInputs,
	refreshAndPersistAccount,
} from "./refresh-account.js";
import type { ToolContext } from "./index.js";

export function createCodexRefreshTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		formatCommandAccountLabel,
		resolveMaskEmail,
		getStatusMarker,
		cachedAccountManagerRef,
		accountManagerPromiseRef,
	} = ctx;
	return tool({
		description:
			"Manually refresh OAuth tokens for all accounts to verify they're still valid.",
		args: {},
		async execute() {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Refresh accounts"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			const results: string[] = ui.v2Enabled
				? []
				: [`Refreshing ${storage.accounts.length} account(s):`, ""];

			let refreshedCount = 0;
			let failedCount = 0;
			let skippedCount = 0;
			const inputs = buildRefreshInputs(storage.accounts);

			for (let i = 0; i < inputs.length; i++) {
				const input = inputs[i];
				const account = storage.accounts[i];
				if (!input || !account) continue;
				const label = formatCommandAccountLabel(account, i, { maskEmail });
				const outcome = await refreshAndPersistAccount(input);

				if (outcome.status === "refreshed") {
					results.push(`  ${getStatusMarker(ui, "ok")} ${label}: Refreshed`);
					refreshedCount++;
				} else if (outcome.status === "skipped") {
					results.push(
						`  ${getStatusMarker(ui, "warning")} ${label}: Skipped (disabled)`,
					);
					skippedCount++;
				} else {
					results.push(
						`  ${getStatusMarker(ui, "error")} ${label}: Failed - ${outcome.error}`,
					);
					failedCount++;
				}
			}

			if (cachedAccountManagerRef.current) {
				const reloadedManager = await AccountManager.loadFromDisk();
				cachedAccountManagerRef.current = reloadedManager;
				accountManagerPromiseRef.current = Promise.resolve(reloadedManager);
			}
			results.push("");
			if (skippedCount > 0) {
				results.push(
					`Summary: ${refreshedCount} refreshed, ${failedCount} failed, ${skippedCount} skipped`,
				);
			} else {
				results.push(
					`Summary: ${refreshedCount} refreshed, ${failedCount} failed`,
				);
			}
			if (ui.v2Enabled) {
				return [
					...formatUiHeader(ui, "Refresh accounts"),
					"",
					...results.map((line) => paintUiText(ui, line, "normal")),
				].join("\n");
			}
			return results.join("\n");
		},
	});
}

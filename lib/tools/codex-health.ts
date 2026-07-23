/**
 * `codex-health` tool — verify refresh tokens for all accounts.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts } from "../storage.js";
import { AccountManager } from "../accounts.js";
import {
	findDisabledAccountsWithFreshCredential,
	findDisabledTokenSourceDuplicates,
	findStaleRecoverableAccounts,
} from "../accounts/stale-state.js";
import { formatUiHeader, formatUiItem, paintUiText } from "../ui/format.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
import {
	buildRefreshInputs,
	refreshAndPersistAccount,
} from "./refresh-account.js";
import type { ToolContext } from "./index.js";

export function createCodexHealthTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		formatCommandAccountLabel,
		resolveMaskEmail,
		getStatusMarker,
		buildJsonAccountIdentity,
		cachedAccountManagerRef,
		accountManagerPromiseRef,
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
						skippedCount: 0,
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
			let skippedCount = 0;
			const inputs = buildRefreshInputs(storage.accounts);

			for (let i = 0; i < inputs.length; i++) {
				const input = inputs[i];
				const account = storage.accounts[i];
				if (!input || !account) continue;

				const label = formatCommandAccountLabel(account, i);
				const displayLabel = formatCommandAccountLabel(account, i, { maskEmail });
				const outcome = await refreshAndPersistAccount(input);

				if (outcome.status === "refreshed") {
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
				} else if (outcome.status === "skipped") {
					jsonAccounts.push({
						...buildJsonAccountIdentity(i, {
							includeSensitive: includeSensitiveOutput,
							account,
							label,
						}),
						status: "skipped",
						error: "Account is disabled",
					});
					results.push(
						`  ${getStatusMarker(ui, "warning")} ${displayLabel}: Skipped (disabled)`,
					);
					skippedCount++;
				} else {
					jsonAccounts.push({
						...buildJsonAccountIdentity(i, {
							includeSensitive: includeSensitiveOutput,
							account,
							label,
						}),
						status: "unhealthy",
						error: outcome.error,
					});
					results.push(
						`  ${getStatusMarker(ui, "error")} ${displayLabel}: ${outcome.error}`,
					);
					unhealthyCount++;
				}
			}

			if (cachedAccountManagerRef.current) {
				const reloadedManager = await AccountManager.loadFromDisk();
				cachedAccountManagerRef.current = reloadedManager;
				accountManagerPromiseRef.current = Promise.resolve(reloadedManager);
			}

			results.push("");
			results.push(
				`Summary: ${healthyCount} healthy, ${unhealthyCount} unhealthy, ${skippedCount} skipped`,
			);

			// Surface recoverable stale state and disabled token-source duplicates
			// (issue #171). Token verification is destructive to single-use refresh
			// tokens, but this tool persists rotations before reporting health.
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
			const absorbedSlots = findDisabledAccountsWithFreshCredential(
				storage.accounts,
			).map((index) => index + 1);
			if (absorbedSlots.length > 0) {
				results.push(
					`Disabled w/ fresh login: ${absorbedSlots.length} disabled account(s) hold a fresh credential (slots: ${absorbedSlots.join(", ")}) - a recent re-login landed on a disabled slot. Re-enable in oc-codex-multi-auth-accounts.json if intended.`,
				);
			}
			if (outputFormat === "json") {
				return renderJsonOutput({
					totalAccounts: storage.accounts.length,
					healthyCount,
					unhealthyCount,
					skippedCount,
					staleRecoverableSlots: staleSlots,
					disabledDuplicateSlots: dupSlots,
					disabledWithFreshCredentialSlots: absorbedSlots,
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

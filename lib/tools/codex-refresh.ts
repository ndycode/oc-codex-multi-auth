/**
 * `codex-refresh` tool — manually refresh OAuth tokens for all accounts.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts, withAccountStorageTransaction } from "../storage.js";
import { AccountManager } from "../accounts.js";
import { queuedRefresh } from "../refresh-queue.js";
import { formatUiHeader, formatUiItem, paintUiText } from "../ui/format.js";
import type { ToolContext } from "./index.js";

/**
 * Identity used to re-locate an account in a freshly re-read storage
 * snapshot after a (possibly slow, network-bound) refresh completes.
 * Captured BEFORE the refresh mutates the local copy's refreshToken, so the
 * refreshToken here is the pre-refresh value -- which is what the on-disk
 * record will still show for legacy accounts that have no organizationId/
 * accountId of their own.
 */
interface RefreshAccountIdentity {
	organizationId?: string;
	accountId?: string;
	refreshToken: string;
}

interface RefreshOutcome {
	identity: RefreshAccountIdentity;
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
}

/**
 * Finds the index of the account matching `identity` in `accounts`, using
 * the same organizationId -> accountId -> refreshToken priority order the
 * storage layer's dedup/identity helpers use elsewhere (see
 * `lib/storage/identity.ts`). Kept local rather than importing the shared
 * helper because the barrel does not currently re-export it.
 */
function findAccountIndexByIdentity(
	accounts: RefreshAccountIdentity[],
	identity: RefreshAccountIdentity,
): number {
	const organizationId = identity.organizationId?.trim();
	if (organizationId) {
		const idx = accounts.findIndex(
			(a) => a.organizationId?.trim() === organizationId,
		);
		if (idx >= 0) return idx;
	}
	const accountId = identity.accountId?.trim();
	if (accountId) {
		const idx = accounts.findIndex((a) => a.accountId?.trim() === accountId);
		if (idx >= 0) return idx;
	}
	const refreshToken = identity.refreshToken?.trim();
	if (refreshToken) {
		const idx = accounts.findIndex(
			(a) => a.refreshToken?.trim() === refreshToken,
		);
		if (idx >= 0) return idx;
	}
	return -1;
}

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
			// Collected here, applied to a freshly re-read snapshot in a single
			// transaction after all (network-bound, multi-second) refreshes
			// complete -- see the module doc comment on RefreshOutcome. Holding
			// the storage lock across queuedRefresh calls would block every
			// other tool/rotation for the full duration of this loop, and
			// mutating `storage` in place and saving it at the end (the old
			// behavior) silently clobbered any rate-limit/cooldown/activeIndex
			// state a concurrent rotation persisted while this loop was running.
			const refreshedAccounts: RefreshOutcome[] = [];

			for (let i = 0; i < storage.accounts.length; i++) {
				const account = storage.accounts[i];
				if (!account) continue;
				const label = formatCommandAccountLabel(account, i, { maskEmail });
				const identity: RefreshAccountIdentity = {
					organizationId: account.organizationId,
					accountId: account.accountId,
					refreshToken: account.refreshToken,
				};

				try {
					const refreshResult = await queuedRefresh(account.refreshToken);
					if (refreshResult.type === "success") {
						refreshedAccounts.push({
							identity,
							refreshToken: refreshResult.refresh,
							accessToken: refreshResult.access,
							expiresAt: refreshResult.expires,
						});
						results.push(`  ${getStatusMarker(ui, "ok")} ${label}: Refreshed`);
						refreshedCount++;
					} else {
						results.push(
							`  ${getStatusMarker(ui, "error")} ${label}: Failed - ${refreshResult.message ?? refreshResult.reason}`,
						);
						failedCount++;
					}
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					results.push(
						`  ${getStatusMarker(ui, "error")} ${label}: Error - ${errorMsg.slice(0, 120)}`,
					);
					failedCount++;
				}
			}

			if (refreshedAccounts.length > 0) {
				await withAccountStorageTransaction(async (current, persist) => {
					if (!current) return;
					for (const outcome of refreshedAccounts) {
						const idx = findAccountIndexByIdentity(
							current.accounts,
							outcome.identity,
						);
						if (idx < 0) continue; // Account removed concurrently; nothing to apply.
						const target = current.accounts[idx];
						if (!target) continue;
						target.refreshToken = outcome.refreshToken;
						target.accessToken = outcome.accessToken;
						target.expiresAt = outcome.expiresAt;
					}
					await persist(current);
				});
			}

			if (cachedAccountManagerRef.current) {
				const reloadedManager = await AccountManager.loadFromDisk();
				cachedAccountManagerRef.current = reloadedManager;
				accountManagerPromiseRef.current = Promise.resolve(reloadedManager);
			}
			results.push("");
			results.push(
				`Summary: ${refreshedCount} refreshed, ${failedCount} failed`,
			);
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

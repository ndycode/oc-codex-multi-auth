import { withAccountStorageTransaction, type AccountMetadataV3 } from "../storage.js";
import { clearRefreshedAccountsStaleState } from "../accounts/stale-state.js";
import {
	buildRefreshInputs,
	findAccountIndexByIdentity,
	refreshAndPersistAccount,
	type RefreshAccountIdentity,
} from "./refresh-account.js";

export async function repairDoctorAccounts(accounts: AccountMetadataV3[]) {
	const refreshedAccounts: {
		readonly identity: RefreshAccountIdentity;
		readonly staleState: Pick<AccountMetadataV3, "coolingDownUntil" | "cooldownReason" | "rateLimitResetTimes" | "quotaExhaustedUntil">;
	}[] = [];
	const verificationFailureIdentities: RefreshAccountIdentity[] = [];
	const reloginNeeded: number[] = [];
	const appliedFixes: string[] = [];
	const fixErrors: string[] = [];

	for (const input of buildRefreshInputs(accounts)) {
		const account = accounts[input.index];
		if (!account) continue;
		const staleState = {
			coolingDownUntil: account.coolingDownUntil,
			cooldownReason: account.cooldownReason,
			rateLimitResetTimes: { ...account.rateLimitResetTimes },
			quotaExhaustedUntil: account.quotaExhaustedUntil,
		};
		const outcome = await refreshAndPersistAccount(input);
		switch (outcome.status) {
			case "refreshed":
				refreshedAccounts.push({
					identity: { ...outcome.result.identity, refreshToken: outcome.result.refreshToken },
					staleState,
				});
				break;
			case "skipped":
				break;
			case "failed":
				verificationFailureIdentities.push(outcome.identity);
				reloginNeeded.push(outcome.index + 1);
				// Upstream errors can echo arbitrary credential material, even without token labels.
				fixErrors.push(`Account ${outcome.index + 1}: refresh verification or credential persistence failed — run \`opencode auth login\` to re-authenticate.`);
				break;
			default: {
				const exhaustive: never = outcome;
				return exhaustive;
			}
		}
	}

	if (refreshedAccounts.length > 0) {
		appliedFixes.push(`Refreshed and persisted ${refreshedAccounts.length} account token(s).`);
		try {
			const staleSummary = await withAccountStorageTransaction(async (current, persist) => {
				if (!current) throw new Error("Account storage is unavailable");
				const refreshedRecords: AccountMetadataV3[] = [];
				for (const { identity, staleState } of refreshedAccounts) {
					const index = findAccountIndexByIdentity(current.accounts, identity);
					const record = current.accounts[index];
					if (!record || record.enabled === false) continue;
					// A concurrent health update is newer evidence than this repair's snapshot.
					const stateUnchanged = record.coolingDownUntil === staleState.coolingDownUntil &&
						record.cooldownReason === staleState.cooldownReason &&
						record.quotaExhaustedUntil === staleState.quotaExhaustedUntil &&
						Object.keys({ ...record.rateLimitResetTimes, ...staleState.rateLimitResetTimes }).every(
							(key) => record.rateLimitResetTimes?.[key] === staleState.rateLimitResetTimes?.[key],
						);
					if (stateUnchanged) refreshedRecords.push(record);
				}
				const hasStaleState = refreshedRecords.some((record) =>
					record.coolingDownUntil !== undefined || record.cooldownReason !== undefined ||
					record.quotaExhaustedUntil !== undefined ||
					Object.keys(record.rateLimitResetTimes ?? {}).length > 0,
				);
				const summary = clearRefreshedAccountsStaleState(refreshedRecords);
				if (hasStaleState) await persist(current);
				return summary;
			});
			if (staleSummary.cooldownsCleared > 0) {
				appliedFixes.push(`Cleared cooldown on ${staleSummary.cooldownsCleared} recovered account(s).`);
			}
			if (staleSummary.rateLimitKeysCleared > 0) {
				appliedFixes.push(`Cleared ${staleSummary.rateLimitKeysCleared} stale rate-limit marker(s).`);
			}
			if (staleSummary.quotaExhaustionsCleared > 0) {
				appliedFixes.push(`Cleared quota-exhaustion state on ${staleSummary.quotaExhaustionsCleared} recovered account(s).`);
			}
		} catch {
			fixErrors.push("Failed to persist stale-state repairs.");
		}
	}

	return { refreshedCount: refreshedAccounts.length, verificationFailureIdentities, reloginNeeded, appliedFixes, fixErrors };
}

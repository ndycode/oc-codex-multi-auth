/**
 * Rotation + rate-limit + cooldown surface for {@link AccountManager}.
 *
 * Pure logic module: all state mutations land on a shared {@link AccountState}
 * reference. Integrates with the health and token-bucket trackers in
 * `lib/rotation.ts` (note: that file is the hybrid selection algorithm; this
 * module is the manager-facing wrapper that wires it to `AccountState`).
 */

import type { ModelFamily } from "../prompts/codex.js";
import {
	getHealthTracker,
	getTokenTracker,
	selectHybridAccount,
	type AccountWithMetrics,
	type HybridSelectionOptions,
} from "../rotation.js";
import type { CooldownReason } from "../storage.js";
import { nowMs } from "../utils.js";
import {
	clearExpiredRateLimits,
	getQuotaKey,
	isRateLimitedForFamily,
	type RateLimitReason,
} from "./rate-limits.js";
import type { AccountState, ManagedAccount } from "./state.js";

export class AccountRotation {
	constructor(private readonly state: AccountState) {}

	/**
	 * Whether an account can serve a request for this (family, model) right now:
	 * enabled, not rate-limited (real server 429s tracked in rateLimitResetTimes),
	 * not cooling down, AND its in-memory local token bucket has a token.
	 *
	 * The token-bucket check is what keeps a locally-depleted account out of
	 * selection. It is intentionally evaluated here (in-memory, per-process)
	 * rather than by writing a synthetic window into the persisted
	 * rateLimitResetTimes — that would leak a per-process proactive-limiter
	 * signal into the cross-process accounts file and spuriously rate-limit
	 * server-healthy accounts in other processes.
	 */
	private isSelectable(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): boolean {
		if (account.enabled === false) return false;
		clearExpiredRateLimits(account);
		if (isRateLimitedForFamily(account, family, model)) return false;
		if (this.state.isAccountCoolingDown(account)) return false;
		const quotaKey = model ? `${family}:${model}` : family;
		return getTokenTracker().hasToken(account.index, quotaKey);
	}

	private getPreferredSelectableIndices(
		accountIds: readonly string[] | undefined,
		family: ModelFamily,
		model?: string | null,
	): ReadonlySet<number> | null {
		if (!accountIds?.length) return null;
		const preferredIds = new Set(accountIds);
		const indices = this.state.accounts
			.filter(
				(account) =>
					account.accountId !== undefined &&
					preferredIds.has(account.accountId) &&
					this.isSelectable(account, family, model),
			)
			.map((account) => account.index);
		return indices.length > 0 ? new Set(indices) : null;
	}

	private isInSelectionPool(
		account: ManagedAccount,
		preferredIndices: ReadonlySet<number> | null,
	): boolean {
		return preferredIndices === null || preferredIndices.has(account.index);
	}

	getCurrentOrNextForFamily(
		family: ModelFamily,
		model?: string | null,
		preferredAccountIds?: readonly string[],
	): ManagedAccount | null {
		const count = this.state.accounts.length;
		if (count === 0) return null;
		const preferredIndices = this.getPreferredSelectableIndices(
			preferredAccountIds,
			family,
			model,
		);

		const cursor = this.state.cursorByFamily[family];

		for (let i = 0; i < count; i++) {
			const idx = (cursor + i) % count;
			const account = this.state.accounts[idx];
			if (!account) continue;
			if (!this.isInSelectionPool(account, preferredIndices)) continue;
			if (!this.isSelectable(account, family, model)) continue;

			this.state.cursorByFamily[family] = (idx + 1) % count;
			this.state.currentAccountIndexByFamily[family] = idx;
			account.lastUsed = nowMs();
			return account;
		}

		return null;
	}

	getNextForFamily(family: ModelFamily, model?: string | null): ManagedAccount | null {
		const count = this.state.accounts.length;
		if (count === 0) return null;

		const cursor = this.state.cursorByFamily[family];

		for (let i = 0; i < count; i++) {
			const idx = (cursor + i) % count;
			const account = this.state.accounts[idx];
			if (!account) continue;
			if (!this.isSelectable(account, family, model)) continue;

			this.state.cursorByFamily[family] = (idx + 1) % count;
			account.lastUsed = nowMs();
			return account;
		}

		return null;
	}

	getCurrentOrNextForFamilyHybrid(
		family: ModelFamily,
		model?: string | null,
		options?: HybridSelectionOptions,
		preferredAccountIds?: readonly string[],
	): ManagedAccount | null {
		const count = this.state.accounts.length;
		if (count === 0) return null;
		const preferredIndices = this.getPreferredSelectableIndices(
			preferredAccountIds,
			family,
			model,
		);

		const currentIndex = this.state.currentAccountIndexByFamily[family];
		if (currentIndex >= 0 && currentIndex < count) {
			const currentAccount = this.state.accounts[currentIndex];
			if (currentAccount) {
				if (currentAccount.enabled === false) {
					// Fall through to hybrid selection.
				} else if (
					this.isInSelectionPool(currentAccount, preferredIndices) &&
					this.isSelectable(currentAccount, family, model)
				) {
					currentAccount.lastUsed = nowMs();
					return currentAccount;
				}
			}
		}

		const quotaKey = model ? `${family}:${model}` : family;
		const healthTracker = getHealthTracker();
		const tokenTracker = getTokenTracker();

		const accountsWithMetrics: AccountWithMetrics[] = this.state.accounts
			.map((account): AccountWithMetrics | null => {
				if (!account) return null;
				if (account.enabled === false) return null;
				if (!this.isInSelectionPool(account, preferredIndices)) return null;
				return {
					index: account.index,
					isAvailable: this.isSelectable(account, family, model),
					lastUsed: account.lastUsed,
				};
			})
			.filter((a): a is AccountWithMetrics => a !== null);

		const selected = selectHybridAccount(
			accountsWithMetrics,
			healthTracker,
			tokenTracker,
			quotaKey,
			{},
			options,
		);
		if (!selected) return null;

		const account = this.state.accounts[selected.index];
		if (!account) return null;

		this.state.currentAccountIndexByFamily[family] = account.index;
		this.state.cursorByFamily[family] = (account.index + 1) % count;
		account.lastUsed = nowMs();
		return account;
	}

	/**
	 * Drain-first ("sticky") selection for issue #183.
	 *
	 * Stays on the current account for the family while it remains healthy
	 * (not disabled, not rate-limited for this family/model, not cooling down).
	 * When the current account is unavailable, it picks the *lowest-indexed*
	 * available account rather than spreading load. This concentrates traffic
	 * on as few accounts as possible so the remaining accounts keep their
	 * quota in reserve — staggering weekly-quota cooldowns instead of
	 * exhausting every account simultaneously (the round-robin failure mode the
	 * issue describes).
	 *
	 * Returns null when no account is available (every account disabled,
	 * rate-limited, or cooling down), matching the other selectors' contract so
	 * the request loop's wait/retry logic is unchanged.
	 */
	getCurrentOrNextForFamilySticky(
		family: ModelFamily,
		model?: string | null,
		preferredAccountIds?: readonly string[],
	): ManagedAccount | null {
		const count = this.state.accounts.length;
		if (count === 0) return null;
		const preferredIndices = this.getPreferredSelectableIndices(
			preferredAccountIds,
			family,
			model,
		);

		// Prefer the account we are already pinned to while it still has quota.
		const currentIndex = this.state.currentAccountIndexByFamily[family];
		if (currentIndex >= 0 && currentIndex < count) {
			const currentAccount = this.state.accounts[currentIndex];
			if (
				currentAccount &&
				this.isInSelectionPool(currentAccount, preferredIndices) &&
				this.isSelectable(currentAccount, family, model)
			) {
				currentAccount.lastUsed = nowMs();
				return currentAccount;
			}
		}

		// Current account exhausted: pick the lowest-indexed available account so
		// load concentrates rather than spreads.
		for (let idx = 0; idx < count; idx++) {
			const account = this.state.accounts[idx];
			if (!account) continue;
			if (!this.isInSelectionPool(account, preferredIndices)) continue;
			if (!this.isSelectable(account, family, model)) continue;

			this.state.currentAccountIndexByFamily[family] = idx;
			this.state.cursorByFamily[family] = (idx + 1) % count;
			account.lastUsed = nowMs();
			return account;
		}

		return null;
	}

	recordSuccess(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): void {
		const quotaKey = model ? `${family}:${model}` : family;
		getHealthTracker().recordSuccess(account.index, quotaKey);
	}

	recordRateLimit(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): void {
		const quotaKey = model ? `${family}:${model}` : family;
		getHealthTracker().recordRateLimit(account.index, quotaKey);
		getTokenTracker().drain(account.index, quotaKey);
	}

	recordFailure(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): void {
		const quotaKey = model ? `${family}:${model}` : family;
		getHealthTracker().recordFailure(account.index, quotaKey);
	}

	consumeToken(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): boolean {
		const quotaKey = model ? `${family}:${model}` : family;
		return getTokenTracker().tryConsume(account.index, quotaKey);
	}

	/**
	 * Refund a token consumed within the refund window (30 seconds).
	 * Use this when a request fails due to network errors (not rate limits).
	 * @returns true if refund was successful, false if no valid consumption found
	 */
	refundToken(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): boolean {
		const quotaKey = model ? `${family}:${model}` : family;
		return getTokenTracker().refundToken(account.index, quotaKey);
	}

	markRateLimited(
		account: ManagedAccount,
		retryAfterMs: number,
		family: ModelFamily,
		model?: string | null,
	): void {
		this.markRateLimitedWithReason(account, retryAfterMs, family, "unknown", model);
	}

	markRateLimitedWithReason(
		account: ManagedAccount,
		retryAfterMs: number,
		family: ModelFamily,
		reason: RateLimitReason,
		model?: string | null,
	): void {
		const retryMs = Math.max(0, Math.floor(retryAfterMs));
		const resetAt = nowMs() + retryMs;

		const baseKey = getQuotaKey(family);
		account.rateLimitResetTimes[baseKey] = resetAt;

		if (model) {
			const modelKey = getQuotaKey(family, model);
			account.rateLimitResetTimes[modelKey] = resetAt;
		}

		account.lastRateLimitReason = reason;
	}

	markAccountCoolingDown(
		account: ManagedAccount,
		cooldownMs: number,
		reason: CooldownReason,
	): void {
		const ms = Math.max(0, Math.floor(cooldownMs));
		account.coolingDownUntil = nowMs() + ms;
		account.cooldownReason = reason;
	}

	/**
	 * Mark every in-memory account sharing a refresh token as cooling down.
	 * @returns Number of live accounts updated.
	 */
	markAccountsWithRefreshTokenCoolingDown(
		refreshToken: string,
		cooldownMs: number,
		reason: CooldownReason,
	): number {
		const matches = this.state.accounts.filter(
			(account) => account.refreshToken === refreshToken,
		);
		for (const account of matches) {
			this.markAccountCoolingDown(account, cooldownMs, reason);
		}
		return matches.length;
	}

	getMinWaitTimeForFamily(family: ModelFamily, model?: string | null): number {
		const now = nowMs();
		const enabledAccounts = this.state.accounts.filter(
			(account) => account.enabled !== false,
		);
		const available = enabledAccounts.filter((account) =>
			this.isSelectable(account, family, model),
		);
		if (available.length > 0) return 0;
		if (enabledAccounts.length === 0) return 0;

		const waitTimes: number[] = [];
		const baseKey = getQuotaKey(family);
		const modelKey = model ? getQuotaKey(family, model) : null;
		const tokenQuotaKey = model ? `${family}:${model}` : family;
		const tokenTracker = getTokenTracker();

		for (const account of enabledAccounts) {
			const baseResetAt = account.rateLimitResetTimes[baseKey];
			if (typeof baseResetAt === "number") {
				waitTimes.push(Math.max(0, baseResetAt - now));
			}

			if (modelKey) {
				const modelResetAt = account.rateLimitResetTimes[modelKey];
				if (typeof modelResetAt === "number") {
					waitTimes.push(Math.max(0, modelResetAt - now));
				}
			}

			if (typeof account.coolingDownUntil === "number") {
				waitTimes.push(Math.max(0, account.coolingDownUntil - now));
			}

			// An account blocked only by a depleted local token bucket becomes
			// available again after refill; include that wait so a fully
			// token-depleted pool waits for refill instead of returning 0 (503).
			if (account.enabled !== false) {
				const tokenWait = tokenTracker.msUntilToken(account.index, tokenQuotaKey);
				if (tokenWait > 0 && Number.isFinite(tokenWait)) {
					waitTimes.push(tokenWait);
				}
			}
		}

		return waitTimes.length > 0 ? Math.min(...waitTimes) : 0;
	}
}

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
		strictPreferredPool = false,
	): ReadonlySet<number> | null {
		if (!accountIds?.length) return null;
		const preferredIds = new Set(accountIds);
		const indices = this.state.accounts
			.filter(
				(account) =>
					account &&
					account.accountId !== undefined &&
					preferredIds.has(account.accountId) &&
					this.isSelectable(account, family, model),
			)
			.map((account) => account.index);
		return indices.length > 0
			? new Set(indices)
			: strictPreferredPool
				? new Set<number>()
				: null;
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
		strictPreferredPool = false,
		excludedIndices?: ReadonlySet<number>,
	): ManagedAccount | null {
		const count = this.state.accounts.length;
		if (count === 0) return null;
		const preferredIndices = this.getPreferredSelectableIndices(
			preferredAccountIds,
			family,
			model,
			strictPreferredPool,
		);

		const cursor = this.state.cursorByFamily[family];

		for (let i = 0; i < count; i++) {
			const idx = (cursor + i) % count;
			const account = this.state.accounts[idx];
			if (!account) continue;
			if (excludedIndices?.has(account.index)) continue;
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
		strictPreferredPool = false,
		excludedIndices?: ReadonlySet<number>,
	): ManagedAccount | null {
		const count = this.state.accounts.length;
		if (count === 0) return null;
		const preferredIndices = this.getPreferredSelectableIndices(
			preferredAccountIds,
			family,
			model,
			strictPreferredPool,
		);

		const currentIndex = this.state.currentAccountIndexByFamily[family];
		if (currentIndex >= 0 && currentIndex < count) {
			const currentAccount = this.state.accounts[currentIndex];
			if (currentAccount) {
				if (excludedIndices?.has(currentAccount.index)) {
					// Fall through to hybrid selection.
				} else if (currentAccount.enabled === false) {
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
				if (excludedIndices?.has(account.index)) return null;
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
		strictPreferredPool = false,
		excludedIndices?: ReadonlySet<number>,
	): ManagedAccount | null {
		const count = this.state.accounts.length;
		if (count === 0) return null;
		const preferredIndices = this.getPreferredSelectableIndices(
			preferredAccountIds,
			family,
			model,
			strictPreferredPool,
		);

		// Prefer the account we are already pinned to while it still has quota.
		const currentIndex = this.state.currentAccountIndexByFamily[family];
		if (currentIndex >= 0 && currentIndex < count) {
			const currentAccount = this.state.accounts[currentIndex];
			if (
				currentAccount &&
				!excludedIndices?.has(currentAccount.index) &&
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
			if (excludedIndices?.has(account.index)) continue;
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

	/**
	 * The quota keys a (family, model) block covers: the family-wide key, plus
	 * the model-scoped one when a model is named.
	 */
	private getBlockedQuotaKeys(
		family: ModelFamily,
		model?: string | null,
	): string[] {
		const keys: string[] = [getQuotaKey(family)];
		if (model) keys.push(getQuotaKey(family, model));
		return keys;
	}

	/**
	 * Write a rate-limit reset for `key`, keeping whichever block runs longer.
	 *
	 * Every writer goes through here so a later, shorter block can never shorten
	 * an existing one: a concurrent in-flight request that lands a plain 429 with
	 * a 30s retry-after must not pull a week-long weekly-quota block forward
	 * (issue #218). A stale past value can never win, because any reset written
	 * here is at or after `nowMs()`, and expired entries are dropped by
	 * `clearExpiredRateLimits` on the next selection pass anyway.
	 *
	 * @returns true when the stored reset moved later.
	 */
	private extendRateLimitReset(
		account: ManagedAccount,
		key: string,
		resetAt: number,
	): boolean {
		const existing = account.rateLimitResetTimes[key];
		if (
			typeof existing === "number" &&
			Number.isFinite(existing) &&
			existing >= resetAt
		) {
			return false;
		}
		account.rateLimitResetTimes[key] = resetAt;
		return true;
	}

	markRateLimitedWithReason(
		account: ManagedAccount,
		retryAfterMs: number,
		family: ModelFamily,
		reason: RateLimitReason,
		model?: string | null,
	): void {
		const retryMs = Math.max(0, Math.floor(retryAfterMs));
		const keys = this.getBlockedQuotaKeys(family, model);

		if (retryMs === 0) {
			// A zero-length rate limit is not a block, it is the caller saying the
			// window has elapsed. Clearing keeps the long-standing behavior: the
			// old code wrote `nowMs()`, which clearExpiredRateLimits dropped on the
			// next pass. It has to be explicit now, because the monotonic write
			// below would otherwise preserve the very block the caller just
			// declared expired. Nothing in the request path passes 0 — every
			// server-derived delay is at least 1ms.
			for (const key of keys) delete account.rateLimitResetTimes[key];
		} else {
			const resetAt = nowMs() + retryMs;
			for (const key of keys) {
				this.extendRateLimitReset(account, key, resetAt);
			}
		}

		// Set unconditionally even when the existing block already ran longer:
		// this records the reason for the most recent 429, not for the block.
		account.lastRateLimitReason = reason;
	}

	/**
	 * Block an account until a quota window the backend reported as fully spent
	 * resets (issue #218).
	 *
	 * Differs from {@link markRateLimitedWithReason} in taking an ABSOLUTE reset
	 * stamp, so a week-long weekly-quota block is never rebuilt from a capped or
	 * backed-off retry delay. Like every writer it goes through
	 * {@link extendRateLimitReset}, so it neither shortens an existing block nor
	 * can be shortened by a later one.
	 *
	 * The block rides on the same persisted `rateLimitResetTimes` map as server
	 * 429s, so it survives restarts and is shared with other processes through
	 * the accounts file, and it expires on its own via `clearExpiredRateLimits`.
	 *
	 * @returns true when a new (or longer) block was written.
	 */
	markQuotaExhausted(
		account: ManagedAccount,
		resetAtMs: number,
		family: ModelFamily,
		model?: string | null,
	): boolean {
		if (!Number.isFinite(resetAtMs)) return false;
		const resetAt = Math.floor(resetAtMs);
		if (resetAt <= nowMs()) return false;

		let changed = false;
		for (const key of this.getBlockedQuotaKeys(family, model)) {
			if (this.extendRateLimitReset(account, key, resetAt)) changed = true;
		}

		if (changed) account.lastRateLimitReason = "quota";
		return changed;
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

	getMinWaitTimeForFamily(
		family: ModelFamily,
		model?: string | null,
		accountIds?: readonly string[],
	): number {
		const now = nowMs();
		const accountIdSet = accountIds?.length ? new Set(accountIds) : null;
		const enabledAccounts = this.state.accounts.filter(
			(account) =>
				account.enabled !== false &&
				(accountIdSet === null ||
					(account.accountId !== undefined && accountIdSet.has(account.accountId))),
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

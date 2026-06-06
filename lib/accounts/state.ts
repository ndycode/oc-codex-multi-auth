/**
 * In-memory account registry for {@link AccountManager}.
 *
 * Owns the mutable account list, per-family cursors/active indices, and
 * auxiliary in-memory state (toast debounce, auth-failure counters).
 * Other account services (persistence, rotation, recovery) receive a reference
 * to an `AccountState` instance and mutate it through this narrow surface.
 */

import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import type { AccountIdSource, OAuthAuthDetails } from "../types.js";
import { nowMs } from "../utils.js";
import {
	clampNonNegativeInt,
	clearExpiredRateLimits,
	getQuotaKey,
	isRateLimitedForFamily,
	type RateLimitReason,
} from "./rate-limits.js";
import type { AccountStorageV3, CooldownReason, RateLimitStateV3 } from "../storage.js";
import {
	extractAccountEmail,
	extractAccountId,
	sanitizeEmail,
	shouldUpdateAccountIdFromToken,
} from "../auth/token-utils.js";
import { getMissingRequiredOAuthScopes } from "../auth/scopes.js";
import { getHealthTracker, getTokenTracker } from "../rotation.js";
import { remapRateLimitBackoffAfterRemoval } from "../request/rate-limit-backoff.js";
import { logWarn } from "../logger.js";

export interface ManagedAccount {
	index: number;
	accountId?: string;
	organizationId?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	accountTags?: string[];
	accountNote?: string;
	email?: string;
	refreshToken: string;
	enabled?: boolean;
	access?: string;
	expires?: number;
	oauthScope?: string;
	addedAt: number;
	lastUsed: number;
	lastSwitchReason?: "rate-limit" | "initial" | "rotation";
	lastRateLimitReason?: RateLimitReason;
	rateLimitResetTimes: RateLimitStateV3;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
}

export interface AccountSelectionExplainability {
	index: number;
	enabled: boolean;
	isCurrentForFamily: boolean;
	eligible: boolean;
	reasons: string[];
	healthScore: number;
	tokensAvailable: number;
	rateLimitedUntil?: number;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
	lastUsed: number;
}

function initFamilyState(defaultValue: number): Record<ModelFamily, number> {
	return Object.fromEntries(
		MODEL_FAMILIES.map((family) => [family, defaultValue]),
	) as Record<ModelFamily, number>;
}

function appendReauthNote(accountNote: string | undefined, missingScopes: string[]): string {
	const suffix = `Re-auth required for missing OAuth scope(s): ${missingScopes.join(", ")}.`;
	if (!accountNote) return suffix;
	if (accountNote.includes(suffix)) return accountNote;
	return `${accountNote} ${suffix}`;
}

const MISSING_SCOPE_NOTE_MARKER = "Re-auth required for missing OAuth scope(s):";

function hasExplicitOAuthScope(scope: string | undefined): scope is string {
	return typeof scope === "string" && scope.trim().length > 0;
}

function hasMissingScopeReauthNote(accountNote: string | undefined): boolean {
	return typeof accountNote === "string" && accountNote.includes(MISSING_SCOPE_NOTE_MARKER);
}

function getAuthScope(auth: OAuthAuthDetails | undefined): string | undefined {
	const scope = auth?.scope;
	return typeof scope === "string" && scope.trim() ? scope : undefined;
}

export class AccountState {
	accounts: ManagedAccount[] = [];
	cursorByFamily: Record<ModelFamily, number> = initFamilyState(0);
	currentAccountIndexByFamily: Record<ModelFamily, number> = initFamilyState(-1);
	lastToastAccountIndex = -1;
	lastToastTime = 0;
	authFailuresByRefreshToken: Map<string, number> = new Map();
	/**
	 * Per-refresh-token promise chain used to serialize concurrent
	 * `incrementAuthFailures` calls. Prevents lost updates when two org-variant
	 * accounts that share a refresh token observe an auth failure at once — see
	 * audit finding `docs/audits/03-critical-issues.md` (ledger id `47`).
	 */
	incrementAuthFailuresChain: Map<string, Promise<number>> = new Map();

	initializeFromStorage(
		authFallback: OAuthAuthDetails | undefined,
		stored: AccountStorageV3 | null | undefined,
	): void {
		const fallbackAccountId = extractAccountId(authFallback?.access);
		const fallbackAccountEmail = sanitizeEmail(extractAccountEmail(authFallback?.access));
		const fallbackOAuthScope = getAuthScope(authFallback);
		const fallbackMissingOAuthScopes = getMissingRequiredOAuthScopes(fallbackOAuthScope);

		if (stored && stored.accounts.length > 0) {
			const baseNow = nowMs();
			this.accounts = stored.accounts
				.map((account, index): ManagedAccount | null => {
					if (!account.refreshToken || typeof account.refreshToken !== "string") {
						return null;
					}

					const accountOAuthScope = account.oauthScope;

					const matchesFallback =
						!!authFallback &&
						((fallbackAccountId && account.accountId === fallbackAccountId) ||
							account.refreshToken === authFallback.refresh ||
							(!!fallbackAccountEmail &&
								sanitizeEmail(account.email) === fallbackAccountEmail));

					const refreshToken =
						matchesFallback && authFallback ? authFallback.refresh : account.refreshToken;
					const oauthScope =
						matchesFallback && fallbackOAuthScope ? fallbackOAuthScope : accountOAuthScope;
					const hasExplicitScope = hasExplicitOAuthScope(accountOAuthScope);
					const shouldEnforceScope = hasExplicitScope || hasMissingScopeReauthNote(account.accountNote);
					const missingOAuthScopes = shouldEnforceScope ? getMissingRequiredOAuthScopes(oauthScope) : [];

					return {
						index,
						accountId: matchesFallback
							? fallbackAccountId ?? account.accountId
							: account.accountId,
						organizationId: account.organizationId,
						accountIdSource: account.accountIdSource,
						accountLabel: account.accountLabel,
						accountTags: account.accountTags,
						accountNote: missingOAuthScopes.length > 0
							? appendReauthNote(account.accountNote, missingOAuthScopes)
							: account.accountNote,
						email: matchesFallback
							? fallbackAccountEmail ?? sanitizeEmail(account.email)
							: sanitizeEmail(account.email),
						refreshToken,
						enabled:
							account.enabled !== false &&
							(!shouldEnforceScope || missingOAuthScopes.length === 0),
						access:
							matchesFallback && authFallback ? authFallback.access : account.accessToken,
						expires:
							matchesFallback && authFallback ? authFallback.expires : account.expiresAt,
						oauthScope,
						addedAt: clampNonNegativeInt(account.addedAt, baseNow),
						lastUsed: clampNonNegativeInt(account.lastUsed, 0),
						lastSwitchReason: account.lastSwitchReason,
						rateLimitResetTimes: account.rateLimitResetTimes ?? {},
						coolingDownUntil: account.coolingDownUntil,
						cooldownReason: account.cooldownReason,
					};
				})
				.filter((account): account is ManagedAccount => account !== null);

			const hasMatchingFallback =
				!!authFallback &&
				this.accounts.some(
					(account) =>
						account.refreshToken === authFallback.refresh ||
						(fallbackAccountId && account.accountId === fallbackAccountId) ||
						(!!fallbackAccountEmail && account.email === fallbackAccountEmail),
				);

			if (authFallback && !hasMatchingFallback) {
				const now = nowMs();
				if (fallbackMissingOAuthScopes.length === 0) {
					this.accounts.push({
						index: this.accounts.length,
						accountId: fallbackAccountId,
						organizationId: undefined,
						accountIdSource: fallbackAccountId ? "token" : undefined,
						email: fallbackAccountEmail,
						refreshToken: authFallback.refresh,
						enabled: true,
						access: authFallback.access,
						expires: authFallback.expires,
						oauthScope: fallbackOAuthScope,
						addedAt: now,
						lastUsed: now,
						lastSwitchReason: "initial",
						rateLimitResetTimes: {},
					});
				} else {
					logWarn(
						`Stored OAuth fallback is missing required OAuth scope(s): ${fallbackMissingOAuthScopes.join(", ")}. Re-auth required.`,
					);
					this.accounts.push({
						index: this.accounts.length,
						accountId: fallbackAccountId,
						organizationId: undefined,
						accountIdSource: fallbackAccountId ? "token" : undefined,
						email: fallbackAccountEmail,
						refreshToken: authFallback.refresh,
						enabled: false,
						accountNote: appendReauthNote(undefined, fallbackMissingOAuthScopes),
						access: authFallback.access,
						expires: authFallback.expires,
						oauthScope: fallbackOAuthScope,
						addedAt: now,
						lastUsed: 0,
						lastSwitchReason: "initial",
						rateLimitResetTimes: {},
					});
				}
			}

			if (this.accounts.length > 0) {
				const defaultIndex =
					clampNonNegativeInt(stored.activeIndex, 0) % this.accounts.length;

				for (const family of MODEL_FAMILIES) {
					const rawIndex = stored.activeIndexByFamily?.[family];
					const nextIndex =
						clampNonNegativeInt(rawIndex, defaultIndex) % this.accounts.length;
					this.currentAccountIndexByFamily[family] = nextIndex;
					this.cursorByFamily[family] = nextIndex;
				}
			}
			return;
		}

		if (authFallback) {
			const now = nowMs();
			const enabled = fallbackMissingOAuthScopes.length === 0;
			if (!enabled) {
				logWarn(
					`Stored OAuth fallback is missing required OAuth scope(s): ${fallbackMissingOAuthScopes.join(", ")}. Re-auth required.`,
				);
			}
			this.accounts = [
				{
					index: 0,
					accountId: fallbackAccountId,
					organizationId: undefined,
					accountIdSource: fallbackAccountId ? "token" : undefined,
					email: fallbackAccountEmail,
					refreshToken: authFallback.refresh,
					enabled,
					accountNote: enabled
						? undefined
						: appendReauthNote(undefined, fallbackMissingOAuthScopes),
					access: authFallback.access,
					expires: authFallback.expires,
					oauthScope: fallbackOAuthScope,
					addedAt: now,
					lastUsed: 0,
					lastSwitchReason: "initial",
					rateLimitResetTimes: {},
				},
			];
			for (const family of MODEL_FAMILIES) {
				this.currentAccountIndexByFamily[family] = 0;
				this.cursorByFamily[family] = 0;
			}
		}
	}

	hasRefreshToken(refreshToken: string): boolean {
		return this.accounts.some((account) => account.refreshToken === refreshToken);
	}

	getAccountCount(): number {
		return this.accounts.length;
	}

	getActiveIndexForFamily(family: ModelFamily): number {
		const index = this.currentAccountIndexByFamily[family];
		if (index < 0 || index >= this.accounts.length) {
			return this.accounts.length > 0 ? 0 : -1;
		}
		return index;
	}

	getAccountsSnapshot(): ManagedAccount[] {
		return this.accounts.map((account) => ({
			...account,
			rateLimitResetTimes: { ...account.rateLimitResetTimes },
		}));
	}

	getSelectionExplainability(
		family: ModelFamily,
		model?: string | null,
		now = nowMs(),
	): AccountSelectionExplainability[] {
		const quotaKey = model ? `${family}:${model}` : family;
		const baseQuotaKey = getQuotaKey(family);
		const modelQuotaKey = model ? getQuotaKey(family, model) : null;
		const currentIndex = this.currentAccountIndexByFamily[family];
		const healthTracker = getHealthTracker();
		const tokenTracker = getTokenTracker();

		return this.accounts.map((account) => {
			clearExpiredRateLimits(account);
			const enabled = account.enabled !== false;
			const reasons: string[] = [];
			let rateLimitedUntil: number | undefined;
			const baseRateLimit = account.rateLimitResetTimes[baseQuotaKey];
			const modelRateLimit = modelQuotaKey
				? account.rateLimitResetTimes[modelQuotaKey]
				: undefined;
			if (typeof baseRateLimit === "number" && baseRateLimit > now) {
				rateLimitedUntil = baseRateLimit;
			}
			if (
				typeof modelRateLimit === "number" &&
				modelRateLimit > now &&
				(rateLimitedUntil === undefined || modelRateLimit > rateLimitedUntil)
			) {
				rateLimitedUntil = modelRateLimit;
			}

			const coolingDownUntil =
				typeof account.coolingDownUntil === "number" && account.coolingDownUntil > now
					? account.coolingDownUntil
					: undefined;

			if (!enabled) reasons.push("disabled");
			if (rateLimitedUntil !== undefined) reasons.push("rate-limited");
			if (coolingDownUntil !== undefined) {
				reasons.push(
					account.cooldownReason ? `cooldown:${account.cooldownReason}` : "cooldown",
				);
			}

			const tokensAvailable = tokenTracker.getTokens(account.index, quotaKey);
			if (tokensAvailable < 1) reasons.push("token-bucket-empty");

			const eligible =
				enabled &&
				rateLimitedUntil === undefined &&
				coolingDownUntil === undefined &&
				tokensAvailable >= 1;
			if (reasons.length === 0) reasons.push("eligible");

			return {
				index: account.index,
				enabled,
				isCurrentForFamily: currentIndex === account.index,
				eligible,
				reasons,
				healthScore: healthTracker.getScore(account.index, quotaKey),
				tokensAvailable,
				rateLimitedUntil,
				coolingDownUntil,
				cooldownReason: coolingDownUntil !== undefined ? account.cooldownReason : undefined,
				lastUsed: account.lastUsed,
			};
		});
	}

	setActiveIndex(index: number): ManagedAccount | null {
		if (!Number.isFinite(index)) return null;
		if (index < 0 || index >= this.accounts.length) return null;
		const account = this.accounts[index];
		if (!account) return null;
		if (account.enabled === false) return null;

		for (const family of MODEL_FAMILIES) {
			this.currentAccountIndexByFamily[family] = index;
			this.cursorByFamily[family] = index;
		}

		account.lastUsed = nowMs();
		account.lastSwitchReason = "rotation";
		return account;
	}

	getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null {
		const index = this.currentAccountIndexByFamily[family];
		if (index < 0 || index >= this.accounts.length) {
			return null;
		}
		const account = this.accounts[index];
		if (!account) {
			return null;
		}
		return account;
	}

	shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
		const now = nowMs();
		if (
			accountIndex === this.lastToastAccountIndex &&
			now - this.lastToastTime < debounceMs
		) {
			return false;
		}
		return true;
	}

	markToastShown(accountIndex: number): void {
		this.lastToastAccountIndex = accountIndex;
		this.lastToastTime = nowMs();
	}

	updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void {
		const previousRefreshToken = account.refreshToken;
		account.refreshToken = auth.refresh;
		account.access = auth.access;
		account.expires = auth.expires;
		const scope = getAuthScope(auth);
		if (scope) {
			account.oauthScope = scope;
		}
		if (previousRefreshToken !== account.refreshToken) {
			this.authFailuresByRefreshToken.delete(previousRefreshToken);
			// A single OAuth login produces sibling accounts (distinct orgs) that
			// SHARE one refresh token. OpenAI rotates the refresh token on refresh,
			// so the siblings' stored token is now stale; their next refresh would
			// fail and eventually remove still-valid workspaces. Propagate the new
			// refresh token to those siblings. Org-specific fields (access /
			// accountId / email) are left untouched — each sibling re-derives its
			// own access token on its next use.
			this.propagateRotatedRefreshTokenToSiblings(
				account,
				previousRefreshToken,
				auth.refresh,
			);
		}
		const tokenAccountId = extractAccountId(auth.access);
		if (
			tokenAccountId &&
			shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId)
		) {
			account.accountId = tokenAccountId;
			account.accountIdSource = "token";
		}
		account.email = sanitizeEmail(extractAccountEmail(auth.access)) ?? account.email;
	}

	/**
	 * After a refresh rotates the refresh token on `account`, update every OTHER
	 * account that still holds the pre-rotation token so the shared credential
	 * stays consistent across org-variant siblings.
	 */
	private propagateRotatedRefreshTokenToSiblings(
		account: ManagedAccount,
		previousRefreshToken: string,
		newRefreshToken: string,
	): void {
		if (!previousRefreshToken || previousRefreshToken === newRefreshToken) return;
		for (const sibling of this.accounts) {
			if (sibling === account) continue;
			if (sibling.refreshToken === previousRefreshToken) {
				sibling.refreshToken = newRefreshToken;
				// The expired access token on the sibling forces a fresh refresh
				// (with the now-valid token) the next time it is selected.
				sibling.expires = 0;
			}
		}
		this.authFailuresByRefreshToken.delete(previousRefreshToken);
	}

	toAuthDetails(account: ManagedAccount): OAuthAuthDetails {
		return {
			type: "oauth",
			access: account.access ?? "",
			refresh: account.refreshToken,
			expires: account.expires ?? 0,
			scope: account.oauthScope,
		};
	}

	markSwitched(
		account: ManagedAccount,
		reason: "rate-limit" | "initial" | "rotation",
		family: ModelFamily,
	): void {
		account.lastSwitchReason = reason;
		this.currentAccountIndexByFamily[family] = account.index;
	}

	removeAccount(account: ManagedAccount): boolean {
		const idx = this.accounts.indexOf(account);
		if (idx < 0) {
			return false;
		}

		this.accounts.splice(idx, 1);
		this.accounts.forEach((acc, index) => {
			acc.index = index;
		});

		// Rotation heuristic state (health score, token bucket, rate-limit
		// backoff) is keyed by positional account index. Now that survivors have
		// been reindexed, remap that state so each account keeps its own history
		// instead of inheriting the removed (or a shifted neighbor's) state.
		getHealthTracker().remapAfterRemoval(idx);
		getTokenTracker().remapAfterRemoval(idx);
		remapRateLimitBackoffAfterRemoval(idx);

		if (this.accounts.length === 0) {
			for (const family of MODEL_FAMILIES) {
				this.cursorByFamily[family] = 0;
				this.currentAccountIndexByFamily[family] = -1;
			}
			return true;
		}

		for (const family of MODEL_FAMILIES) {
			if (this.cursorByFamily[family] > idx) {
				this.cursorByFamily[family] = Math.max(0, this.cursorByFamily[family] - 1);
			}
		}
		for (const family of MODEL_FAMILIES) {
			this.cursorByFamily[family] = this.cursorByFamily[family] % this.accounts.length;
		}

		for (const family of MODEL_FAMILIES) {
			if (this.currentAccountIndexByFamily[family] > idx) {
				this.currentAccountIndexByFamily[family] -= 1;
			}
			if (this.currentAccountIndexByFamily[family] >= this.accounts.length) {
				this.currentAccountIndexByFamily[family] = -1;
			}
		}

		return true;
	}

	removeAccountByIndex(index: number): boolean {
		if (!Number.isFinite(index)) return false;
		if (index < 0 || index >= this.accounts.length) return false;
		const account = this.accounts[index];
		if (!account) return false;
		return this.removeAccount(account);
	}

	setAccountEnabled(index: number, enabled: boolean): ManagedAccount | null {
		if (!Number.isFinite(index)) return null;
		if (index < 0 || index >= this.accounts.length) return null;
		const account = this.accounts[index];
		if (!account) return null;
		account.enabled = enabled;
		return account;
	}

	/**
	 * Check whether a cooldown window is still active for the given account.
	 * Clears expired cooldowns as a side-effect so that stale `coolingDownUntil`
	 * timestamps do not leak into snapshots or persistence.
	 */
	isAccountCoolingDown(account: ManagedAccount): boolean {
		if (account.coolingDownUntil === undefined) return false;
		if (nowMs() >= account.coolingDownUntil) {
			this.clearAccountCooldown(account);
			return false;
		}
		return true;
	}

	clearAccountCooldown(account: ManagedAccount): void {
		delete account.coolingDownUntil;
		delete account.cooldownReason;
	}

	/**
	 * Shared predicate used by rotation and diagnostic paths: is this account
	 * usable for the given family/model right now? Combines enabled flag,
	 * rate-limit expiry, and cooldown.
	 */
	isEligibleForFamily(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): boolean {
		if (account.enabled === false) return false;
		clearExpiredRateLimits(account);
		if (isRateLimitedForFamily(account, family, model)) return false;
		if (this.isAccountCoolingDown(account)) return false;
		return true;
	}
}

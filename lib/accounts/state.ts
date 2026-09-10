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
	clearExpiredQuotaExhaustion,
	clearExpiredRateLimits,
	getQuotaKey,
	isQuotaExhausted,
	isRateLimitedForFamily,
	type RateLimitReason,
} from "./rate-limits.js";
import type { AccountStorageV3, CooldownReason, RateLimitStateV3 } from "../storage.js";
import {
	extractAccountEmail,
	extractAccountId,
	extractAccountUserId,
	sanitizeEmail,
	shouldUpdateAccountIdFromToken,
} from "../auth/token-utils.js";
import { extractPlanType } from "../auth/plan-tier.js";
import { getMissingRequiredOAuthScopes, normalizeScope } from "../auth/scopes.js";
import { getHealthTracker, getTokenTracker } from "../rotation.js";
import { remapRateLimitBackoffAfterRemoval } from "../request/rate-limit-backoff.js";
import { logWarn } from "../logger.js";

export interface ManagedAccount {
	index: number;
	accountId?: string;
	accountUserId?: string;
	organizationId?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	planType?: string;
	accountTags?: string[];
	accountNote?: string;
	email?: string;
	refreshToken: string;
	enabled?: boolean;
	access?: string;
	expires?: number;
	oauthScope?: string;
	/** When the refresh token was last rotated (ms since epoch); see AccountMetadataV3. */
	tokenRotatedAt?: number;
	addedAt: number;
	lastUsed: number;
	lastSwitchReason?: "rate-limit" | "initial" | "rotation";
	lastRateLimitReason?: RateLimitReason;
	rateLimitResetTimes: RateLimitStateV3;
	quotaExhaustedUntil?: number;
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
	quotaExhaustedUntil?: number;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
	lastUsed: number;
}

function initFamilyState(defaultValue: number): Record<ModelFamily, number> {
	return Object.fromEntries(
		MODEL_FAMILIES.map((family) => [family, defaultValue]),
	) as Record<ModelFamily, number>;
}

type StoredAccount = AccountStorageV3["accounts"][number];

function getStoredAccountUserId(account: StoredAccount): string | undefined {
	return account.accountUserId?.trim() || extractAccountUserId(account.accessToken);
}

function selectUniqueIndex(indices: number[]): number | undefined {
	return indices.length === 1 ? indices[0] : undefined;
}

function resolveFallbackMatches(params: {
	accounts: StoredAccount[];
	refreshToken: string;
	accountId: string | undefined;
	accountUserId: string | undefined;
	email: string | undefined;
}): { indices: Set<number>; ambiguous: boolean } {
	const refreshMatches: number[] = [];
	const memberMatches: number[] = [];
	const legacyCandidates: number[] = [];

	for (let index = 0; index < params.accounts.length; index += 1) {
		const account = params.accounts[index];
		if (!account) continue;
		if (account.refreshToken === params.refreshToken) refreshMatches.push(index);
		const storedMemberId = getStoredAccountUserId(account);
		if (params.accountUserId && storedMemberId === params.accountUserId) {
			memberMatches.push(index);
		}
		if (!storedMemberId) legacyCandidates.push(index);
	}

	// One historical OAuth grant may intentionally back several legacy org
	// variants, so an exact refresh-token match remains authoritative.
	if (refreshMatches.length > 0) {
		return { indices: new Set(refreshMatches), ambiguous: false };
	}

	if (params.accountUserId) {
		const exactMember = selectUniqueIndex(memberMatches);
		if (exactMember !== undefined) {
			return { indices: new Set([exactMember]), ambiguous: false };
		}
		if (memberMatches.length > 1) {
			return { indices: new Set(), ambiguous: true };
		}
	}

	const candidates = params.accountUserId
		? legacyCandidates
		: params.accounts.map((_, index) => index);
	const normalizedEmail = sanitizeEmail(params.email);
	const accountAndEmailMatches = candidates.filter((index) => {
		const account = params.accounts[index];
		return (
			!!account &&
			!!params.accountId &&
			account.accountId === params.accountId &&
			!!normalizedEmail &&
			sanitizeEmail(account.email) === normalizedEmail
		);
	});
	const exactComposite = selectUniqueIndex(accountAndEmailMatches);
	if (exactComposite !== undefined) {
		return { indices: new Set([exactComposite]), ambiguous: false };
	}

	const emailMatches = normalizedEmail
		? candidates.filter(
				(index) => sanitizeEmail(params.accounts[index]?.email) === normalizedEmail,
			)
		: [];
	const exactEmail = selectUniqueIndex(emailMatches);
	if (exactEmail !== undefined) {
		return { indices: new Set([exactEmail]), ambiguous: false };
	}

	// `candidates` already excludes every record that carries a DIFFERENT member
	// id, so matching on accountId here cannot bind two Business seats together.
	// Refusing to match at all would strand a legacy record that predates member
	// ids: the fallback would miss it and push a duplicate slot for the same
	// credential instead of hydrating the record in place.
	const accountIdMatches = params.accountId
		? candidates.filter((index) => params.accounts[index]?.accountId === params.accountId)
		: [];
	const exactAccount = selectUniqueIndex(accountIdMatches);
	if (exactAccount !== undefined) {
		return { indices: new Set([exactAccount]), ambiguous: false };
	}

	return {
		indices: new Set(),
		ambiguous:
			accountAndEmailMatches.length > 1 ||
			emailMatches.length > 1 ||
			accountIdMatches.length > 1,
	};
}

/**
 * Replaces any re-auth note already on the record with one describing the
 * currently missing scopes, keeping operator-authored text intact.
 *
 * Replace, not append: the previous exact-match guard only recognized an
 * identical sentence, so a record whose missing set had changed since it was
 * written — the whole 6.11.2 population, once a real scope became known —
 * ended up carrying both sentences, the stale one first and contradicting the
 * accurate one.
 */
function appendReauthNote(accountNote: string | undefined, missingScopes: string[]): string {
	const suffix = `Re-auth required for missing OAuth scope(s): ${missingScopes.join(", ")}.`;
	const preserved = stripReauthNote(accountNote);
	return preserved ? `${preserved} ${suffix}` : suffix;
}

const MISSING_SCOPE_NOTE_MARKER = "Re-auth required for missing OAuth scope(s):";

function hasExplicitOAuthScope(scope: string | undefined): scope is string {
	return typeof scope === "string" && scope.trim().length > 0;
}

function hasMissingScopeReauthNote(accountNote: string | undefined): boolean {
	return typeof accountNote === "string" && accountNote.includes(MISSING_SCOPE_NOTE_MARKER);
}

/**
 * Removes a re-auth note this class previously appended, preserving any
 * operator-authored text that came before it. `appendReauthNote` always appends
 * its sentence last, so everything from the marker onward is ours to drop.
 */
function stripReauthNote(accountNote: string | undefined): string | undefined {
	if (!accountNote) return undefined;
	const markerIndex = accountNote.indexOf(MISSING_SCOPE_NOTE_MARKER);
	if (markerIndex < 0) return accountNote;
	const preserved = accountNote.slice(0, markerIndex).trim();
	return preserved.length > 0 ? preserved : undefined;
}

/**
 * Required-scope check that only fires when the granted scope is actually
 * known. Absent scope metadata means "unknown", NOT "nothing was granted":
 * `refreshAccessToken` deliberately omits `scope` when the token response does,
 * and host credentials restored by the OpenAI backfill carry no scope either.
 * Treating that absence as a total scope failure disabled freshly-authenticated
 * accounts with "missing: openid, profile, email, offline_access" (issue #213).
 */
function getEnforceableMissingOAuthScopes(scope: string | undefined): string[] {
	return hasExplicitOAuthScope(scope) ? getMissingRequiredOAuthScopes(scope) : [];
}

/**
 * Same check across several records of the *same* grant — typically the pool's
 * stored scope and the host credential's scope. If any known source shows the
 * required scopes, the account is fine; disabling on the weaker of two sources
 * would strand an account the other already vouches for. When none satisfies,
 * the smallest missing set wins so the note reports the best evidence held.
 */
function getEnforceableMissingOAuthScopesAcross(
	scopes: (string | undefined)[],
): string[] {
	let fewestMissing: string[] | undefined;
	for (const scope of scopes) {
		if (!hasExplicitOAuthScope(scope)) continue;
		const missing = getMissingRequiredOAuthScopes(scope);
		if (missing.length === 0) return [];
		if (!fewestMissing || missing.length < fewestMissing.length) {
			fewestMissing = missing;
		}
	}
	return fewestMissing ?? [];
}

function getAuthScope(auth: OAuthAuthDetails | undefined): string | undefined {
	return normalizeScope(auth?.scope);
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
	 * the lost-update fix for shared-refresh-token accounts.
	 */
	incrementAuthFailuresChain: Map<string, Promise<number>> = new Map();
	/**
	 * Set when `initializeFromStorage` re-enabled an account that an earlier
	 * build had wrongly disabled for missing scopes. The repair happens in
	 * memory, so it must be flushed to disk or every surface that reads storage
	 * directly keeps showing the stale disabled state and re-auth note.
	 * `consumeScopeRepairs()` clears it, so the extra write happens once.
	 */
	private scopeRepairsPending = false;

	consumeScopeRepairs(): boolean {
		const pending = this.scopeRepairsPending;
		this.scopeRepairsPending = false;
		return pending;
	}

	initializeFromStorage(
		authFallback: OAuthAuthDetails | undefined,
		stored: AccountStorageV3 | null | undefined,
	): void {
		const fallbackAccountId = extractAccountId(authFallback?.access);
		const fallbackAccountUserId = extractAccountUserId(authFallback?.access);
		const fallbackAccountEmail = sanitizeEmail(extractAccountEmail(authFallback?.access));
		const fallbackOAuthScope = getAuthScope(authFallback);
		const fallbackMissingOAuthScopes = getEnforceableMissingOAuthScopes(fallbackOAuthScope);

		if (stored && stored.accounts.length > 0) {
			const baseNow = nowMs();
			const fallbackMatch = authFallback
				? resolveFallbackMatches({
						accounts: stored.accounts,
						refreshToken: authFallback.refresh,
						accountId: fallbackAccountId,
						accountUserId: fallbackAccountUserId,
						email: fallbackAccountEmail,
					})
				: { indices: new Set<number>(), ambiguous: false };
			if (authFallback && fallbackMatch.ambiguous) {
				logWarn(
					"Stored OAuth fallback matches multiple account records; ignoring the fallback rather than replacing multiple credentials.",
				);
			}
			this.accounts = stored.accounts
				.map((account, index): ManagedAccount | null => {
					if (!account.refreshToken || typeof account.refreshToken !== "string") {
						return null;
					}

					// Canonicalize at the load boundary so a legacy blank on disk is
					// carried as absent rather than as an explicit empty grant.
					const accountOAuthScope = normalizeScope(account.oauthScope);

					const matchesFallback =
						!!authFallback && fallbackMatch.indices.has(index);

					const refreshToken =
						matchesFallback && authFallback ? authFallback.refresh : account.refreshToken;
					const oauthScope =
						matchesFallback && fallbackOAuthScope ? fallbackOAuthScope : accountOAuthScope;
					// The stored record and the matching host credential describe the
					// same grant, so weigh both before disabling anything.
					const missingOAuthScopes = getEnforceableMissingOAuthScopesAcross(
						matchesFallback
							? [accountOAuthScope, fallbackOAuthScope]
							: [accountOAuthScope],
					);
					// An account this class disabled carries the re-auth note. Once the
					// scope check stops firing, undo our own damage instead of leaving
					// it disabled forever — 6.11.2 disabled accounts whose scope was
					// merely unknown, and re-login alone could not clear that (#213).
					// A note-less `enabled: false` stays disabled: that one is the
					// operator's own choice.
					const disabledByScopeCheck =
						account.enabled === false && hasMissingScopeReauthNote(account.accountNote);
					if (disabledByScopeCheck && missingOAuthScopes.length === 0) {
						this.scopeRepairsPending = true;
					}

					return {
						index,
						accountId: matchesFallback
							? fallbackAccountId ?? account.accountId
							: account.accountId,
						accountUserId: matchesFallback
							? fallbackAccountUserId ?? getStoredAccountUserId(account)
							: getStoredAccountUserId(account),
						organizationId: account.organizationId,
						accountIdSource: account.accountIdSource,
						accountLabel: account.accountLabel,
						planType: account.planType,
						accountTags: account.accountTags,
						accountNote: missingOAuthScopes.length > 0
							? appendReauthNote(account.accountNote, missingOAuthScopes)
							: disabledByScopeCheck
								? stripReauthNote(account.accountNote)
								: account.accountNote,
						email: matchesFallback
							? fallbackAccountEmail ?? sanitizeEmail(account.email)
							: sanitizeEmail(account.email),
						refreshToken,
						enabled:
							missingOAuthScopes.length === 0 &&
							(disabledByScopeCheck || account.enabled !== false),
						access:
							matchesFallback && authFallback ? authFallback.access : account.accessToken,
						expires:
							matchesFallback && authFallback ? authFallback.expires : account.expiresAt,
						oauthScope,
						tokenRotatedAt:
							matchesFallback &&
							authFallback &&
							authFallback.refresh !== account.refreshToken
								? baseNow
								: account.tokenRotatedAt,
						addedAt: clampNonNegativeInt(account.addedAt, baseNow),
						lastUsed: clampNonNegativeInt(account.lastUsed, 0),
						lastSwitchReason: account.lastSwitchReason,
						rateLimitResetTimes: account.rateLimitResetTimes ?? {},
						quotaExhaustedUntil: account.quotaExhaustedUntil,
						coolingDownUntil: account.coolingDownUntil,
						cooldownReason: account.cooldownReason,
					};
				})
				.filter((account): account is ManagedAccount => account !== null);

			const hasMatchingFallback = !!authFallback && fallbackMatch.indices.size > 0;

			if (authFallback && !hasMatchingFallback && !fallbackMatch.ambiguous) {
				const now = nowMs();
				if (fallbackMissingOAuthScopes.length === 0) {
					this.accounts.push({
						index: this.accounts.length,
						accountId: fallbackAccountId,
						accountUserId: fallbackAccountUserId,
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
						accountUserId: fallbackAccountUserId,
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
					accountUserId: fallbackAccountUserId,
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
			clearExpiredQuotaExhaustion(account);
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

			const quotaExhaustedUntil = isQuotaExhausted(account, now)
				? account.quotaExhaustedUntil
				: undefined;

			if (!enabled) reasons.push("disabled");
			if (rateLimitedUntil !== undefined) reasons.push("rate-limited");
			if (quotaExhaustedUntil !== undefined) reasons.push("quota-exhausted");
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
				quotaExhaustedUntil === undefined &&
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
				quotaExhaustedUntil,
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
		// Re-read from the token that just arrived. Reading it only at login
		// would pin the tier a Plus -> Pro upgrade left behind until the user
		// re-authenticated, while the live `x-codex-plan-type` header already
		// reported the new one. A token that carries no claim leaves the stored
		// value alone rather than erasing it.
		const planType = extractPlanType(auth.access);
		if (planType) {
			account.planType = planType;
		}
		if (previousRefreshToken !== account.refreshToken) {
			// Stamp the rotation so a concurrent process persisting a stale
			// snapshot can recognize this token as the newer one and adopt it
			// instead of clobbering it (single-use refresh tokens).
			account.tokenRotatedAt = Math.max(
				nowMs(),
				(account.tokenRotatedAt ?? 0) + 1,
			);
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
		const tokenAccountUserId = extractAccountUserId(auth.access);
		if (
			tokenAccountId &&
			shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId)
		) {
			account.accountId = tokenAccountId;
			account.accountIdSource = "token";
		}
		// Mirror the accountId guard above. A manually- or org-pinned record must
		// not be re-identified by a token minted for a different workspace/seat,
		// which would silently move its pool key, usage dedupe key and workspace
		// identity key. A record with no member id yet is still backfilled.
		if (
			tokenAccountUserId &&
			(!account.accountUserId ||
				shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId))
		) {
			account.accountUserId = tokenAccountUserId;
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
				sibling.tokenRotatedAt = Math.max(
					nowMs(),
					(sibling.tokenRotatedAt ?? 0) + 1,
				);
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
		clearExpiredQuotaExhaustion(account);
		if (isQuotaExhausted(account)) return false;
		if (isRateLimitedForFamily(account, family, model)) return false;
		if (this.isAccountCoolingDown(account)) return false;
		return true;
	}
}

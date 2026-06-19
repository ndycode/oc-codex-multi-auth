import {
	extractAccountEmail,
	extractAccountId,
	getAccountIdCandidates,
	sanitizeEmail,
	selectBestAccountCandidate,
} from "../accounts.js";
import { logInfo } from "../logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import { withAccountStorageTransaction } from "../storage.js";
import type { AccountIdSource, TokenResult } from "../types.js";

/**
 * Fields that identify the two account records participating in a merge.
 * Kept permissive so callers can pass stored account records of any concrete
 * shape without coupling this helper to the full V3 schema.
 */
type MergeableAccountRecord = {
	refreshToken?: string;
	accessToken?: string;
	expiresAt?: number;
	oauthScope?: string;
	lastUsed?: number;
	addedAt?: number;
	enabled?: boolean;
	accountId?: string;
	organizationId?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	email?: string;
	lastSwitchReason?: string;
	rateLimitResetTimes?: Record<string, number | undefined>;
	coolingDownUntil?: number;
	cooldownReason?: string;
};

/**
 * Pure merge function that combines two stored account records. `target` wins
 * for stable identity fields; token fields prefer the newer record (by
 * lastUsed/addedAt) but use nullish-coalescing so an explicitly empty newer
 * token does NOT silently fall back to the older value. Empty-string tokens
 * are treated as intentional clears — never resurrected from the older record.
 *
 * Exposed for targeted regression tests around the credential-merge semantics.
 */
export function mergeStoredAccountPair<T extends MergeableAccountRecord>(
	target: T,
	source: T,
): T {
	const targetLastUsed = target.lastUsed ?? 0;
	const sourceLastUsed = source.lastUsed ?? 0;
	const targetAddedAt = target.addedAt ?? 0;
	const sourceAddedAt = source.addedAt ?? 0;
	const sourceIsNewer =
		sourceLastUsed > targetLastUsed ||
		(sourceLastUsed === targetLastUsed && sourceAddedAt > targetAddedAt);
	const newer = sourceIsNewer ? source : target;
	const older = sourceIsNewer ? target : source;

	const mergedRateLimitResetTimes: Record<string, number> = {};
	const rateLimitResetKeys = new Set([
		...Object.keys(older.rateLimitResetTimes ?? {}),
		...Object.keys(newer.rateLimitResetTimes ?? {}),
	]);
	for (const key of rateLimitResetKeys) {
		const olderRaw = older.rateLimitResetTimes?.[key];
		const newerRaw = newer.rateLimitResetTimes?.[key];
		const olderValue =
			typeof olderRaw === "number" && Number.isFinite(olderRaw) ? olderRaw : 0;
		const newerValue =
			typeof newerRaw === "number" && Number.isFinite(newerRaw) ? newerRaw : 0;
		const resolved = Math.max(olderValue, newerValue);
		if (resolved > 0) {
			mergedRateLimitResetTimes[key] = resolved;
		}
	}

	const mergedEnabled =
		target.enabled === false || source.enabled === false
			? false
			: target.enabled ?? source.enabled;

	const targetCoolingDownUntil =
		typeof target.coolingDownUntil === "number" && Number.isFinite(target.coolingDownUntil)
			? target.coolingDownUntil
			: 0;
	const sourceCoolingDownUntil =
		typeof source.coolingDownUntil === "number" && Number.isFinite(source.coolingDownUntil)
			? source.coolingDownUntil
			: 0;
	const mergedCoolingDownUntilValue = Math.max(
		targetCoolingDownUntil,
		sourceCoolingDownUntil,
	);
	const mergedCoolingDownUntil =
		mergedCoolingDownUntilValue > 0 ? mergedCoolingDownUntilValue : undefined;
	const mergedCooldownReason = (() => {
		if (mergedCoolingDownUntilValue <= 0) {
			return target.cooldownReason ?? source.cooldownReason;
		}
		if (sourceCoolingDownUntil > targetCoolingDownUntil) {
			return source.cooldownReason ?? target.cooldownReason;
		}
		if (targetCoolingDownUntil > sourceCoolingDownUntil) {
			return target.cooldownReason ?? source.cooldownReason;
		}
		return source.cooldownReason ?? target.cooldownReason;
	})();

	return {
		...target,
		accountId: target.accountId ?? source.accountId,
		organizationId: target.organizationId ?? source.organizationId,
		accountIdSource: target.accountIdSource ?? source.accountIdSource,
		accountLabel: target.accountLabel ?? source.accountLabel,
		email: target.email ?? source.email,
		// CRITICAL: use `??` (nullish-coalescing), not `||`. An explicit empty-string
		// token on `newer` represents a cleared credential — must NOT silently
		// fall back to the older (potentially stale) token.
		refreshToken: newer.refreshToken ?? older.refreshToken,
		accessToken: newer.accessToken ?? older.accessToken,
		expiresAt: newer.expiresAt ?? older.expiresAt,
		oauthScope: newer.oauthScope ?? older.oauthScope,
		enabled: mergedEnabled,
		addedAt: Math.max(target.addedAt ?? 0, source.addedAt ?? 0),
		lastUsed: Math.max(target.lastUsed ?? 0, source.lastUsed ?? 0),
		lastSwitchReason: target.lastSwitchReason ?? source.lastSwitchReason,
		rateLimitResetTimes: mergedRateLimitResetTimes,
		coolingDownUntil: mergedCoolingDownUntil,
		cooldownReason: mergedCooldownReason,
	};
}

type TokenSuccess = Extract<TokenResult, { type: "success" }>;

export type TokenSuccessWithAccount = TokenSuccess & {
	accountIdOverride?: string;
	organizationIdOverride?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
};

export type AccountSelectionResult = {
	primary: TokenSuccessWithAccount;
	variantsForPersistence: TokenSuccessWithAccount[];
};

export type PersistAccountSelections = (
	results: TokenSuccessWithAccount[],
	replaceAll: boolean,
) => Promise<void>;

export type AccountSelectionFallbacks = Pick<
	TokenSuccessWithAccount,
	"accountIdOverride" | "accountIdSource" | "organizationIdOverride" | "accountLabel"
>;

const PERSIST_AUTHENTICATED_SELECTIONS_ERROR =
	"Failed to persist authenticated account selections.";

const createSelectionVariant = (
	tokens: TokenSuccess,
	candidate: {
		accountId: string;
		organizationId?: string;
		source?: AccountIdSource;
		label?: string;
	},
): TokenSuccessWithAccount => ({
	...tokens,
	accountIdOverride: candidate.accountId,
	organizationIdOverride: candidate.organizationId,
	accountIdSource: candidate.source,
	accountLabel: candidate.label,
});

export function resolveAccountSelection(tokens: TokenSuccess): AccountSelectionResult {
	const override = (process.env.CODEX_AUTH_ACCOUNT_ID ?? "").trim();
	if (override) {
		const suffix = override.length > 6 ? override.slice(-6) : override;
		logInfo(`Using account override from CODEX_AUTH_ACCOUNT_ID (id:${suffix}).`);
		const primary = {
			...tokens,
			accountIdOverride: override,
			accountIdSource: "manual" as const,
			accountLabel: `Override [id:${suffix}]`,
		};
		return {
			primary,
			variantsForPersistence: [primary],
		};
	}

	const candidates = getAccountIdCandidates(tokens.access, tokens.idToken);
	if (candidates.length === 0) {
		return {
			primary: tokens,
			variantsForPersistence: [tokens],
		};
	}

	const choice = selectBestAccountCandidate(candidates);
	if (!choice) {
		return {
			primary: tokens,
			variantsForPersistence: [tokens],
		};
	}

	const primary = createSelectionVariant(tokens, {
		accountId: choice.accountId,
		organizationId: choice.organizationId,
		source: choice.source ?? "token",
		label: choice.label,
	});

	const variantsForPersistence: TokenSuccessWithAccount[] = [primary];
	for (const candidate of candidates) {
		if (
			candidate.accountId === primary.accountIdOverride &&
			(candidate.organizationId ?? "") === (primary.organizationIdOverride ?? "")
		) {
			continue;
		}
		variantsForPersistence.push(
			createSelectionVariant(tokens, {
				accountId: candidate.accountId,
				organizationId: candidate.organizationId,
				source: candidate.source,
				label: candidate.label,
			}),
		);
	}

	return {
		primary,
		variantsForPersistence,
	};
}

export function applyAccountSelectionFallbacks(
	selection: AccountSelectionResult,
	fallbacks: AccountSelectionFallbacks,
): AccountSelectionResult {
	const primary = { ...selection.primary };
	const primaryAccountId = selection.primary.accountIdOverride?.trim();
	const primaryOrganizationId = selection.primary.organizationIdOverride?.trim();
	const shouldReusePrimaryVariant =
		(primaryAccountId?.length ?? 0) > 0 || (primaryOrganizationId?.length ?? 0) > 0;
	// Callers may deep-clone `selection.primary`, so reuse the updated primary by
	// persisted account identity instead of relying on object aliasing.
	let variantsForPersistence = selection.variantsForPersistence.map((variant) =>
		variant === selection.primary ||
		(shouldReusePrimaryVariant &&
			(variant.accountIdOverride?.trim() ?? "") === (primaryAccountId ?? "") &&
			(variant.organizationIdOverride?.trim() ?? "") === (primaryOrganizationId ?? ""))
			? primary
			: { ...variant },
	);

	const accountIdOverride = fallbacks.accountIdOverride?.trim();
	if (!primary.accountIdOverride && accountIdOverride) {
		primary.accountIdOverride = accountIdOverride;
		primary.accountIdSource = fallbacks.accountIdSource ?? "manual";
		variantsForPersistence = [primary];
	}

	const organizationIdOverride = fallbacks.organizationIdOverride?.trim();
	if (!primary.organizationIdOverride && organizationIdOverride) {
		primary.organizationIdOverride = organizationIdOverride;
	}

	const accountLabel = fallbacks.accountLabel?.trim();
	if (!primary.accountLabel && accountLabel) {
		primary.accountLabel = accountLabel;
	}

	return {
		primary,
		variantsForPersistence,
	};
}

/**
 * Persists the already-resolved selection through the caller's
 * `persistSelections` callback. Windows filesystem safety remains delegated to
 * that callback, so callers should use `persistAccountPool` or
 * `withAccountStorageTransaction` to keep the rename retry and serialized
 * read-modify-write behavior covered by `test/login-runner.test.ts`.
 * Callback failures are rethrown with a redacted message so callers can log the
 * wrapper safely without leaking token-file paths or account identifiers.
 */
export async function persistResolvedAccountSelection(
	selection: AccountSelectionResult,
	options?: {
		persistSelections?: PersistAccountSelections;
		replaceAll?: boolean;
	},
): Promise<AccountSelectionResult> {
	if (!options?.persistSelections) {
		return selection;
	}

	try {
		await options.persistSelections(
			selection.variantsForPersistence,
			options.replaceAll ?? false,
		);
	} catch (error) {
		throw new Error(PERSIST_AUTHENTICATED_SELECTIONS_ERROR, {
			cause: error,
		});
	}
	return selection;
}

/**
 * Finalizes a resolved selection by delegating persistence to the caller's
 * `persistSelections` callback. Windows lock-retry and read-modify-write
 * serialization remain the callback's responsibility, so callers should route
 * through `persistAccountPool` or `withAccountStorageTransaction` to preserve
 * the guarantees covered by `test/login-runner.test.ts`.
 * Persistence callback failures are redacted inside
 * `persistResolvedAccountSelection()` before they propagate back to callers.
 */
export async function resolveAndPersistAccountSelection(
	tokens: TokenSuccess,
	options?: {
		fallbacks?: AccountSelectionFallbacks;
		persistSelections?: PersistAccountSelections;
		replaceAll?: boolean;
	},
): Promise<AccountSelectionResult> {
	let selection = resolveAccountSelection(tokens);
	if (options?.fallbacks) {
		selection = applyAccountSelectionFallbacks(selection, options.fallbacks);
	}
	return persistResolvedAccountSelection(selection, options);
}

/**
 * Persists login results through the shared storage transaction so overlapping
 * login retries serialize their read-modify-write cycle instead of racing stale
 * snapshots. `withAccountStorageTransaction` also routes the final rename
 * through the Windows lock retry path in `lib/storage.ts`; see
 * `test/login-runner.test.ts` for the concurrent persist regression coverage.
 */
export async function persistAccountPool(
	results: TokenSuccessWithAccount[],
	replaceAll: boolean = false,
): Promise<void> {
	if (results.length === 0) return;

	await withAccountStorageTransaction(async (loadedStorage, persist) => {
		const now = Date.now();
		const stored = replaceAll ? null : loadedStorage;
		let accounts = stored?.accounts ? [...stored.accounts] : [];

		const pushIndex = (
			map: Map<string, number[]>,
			key: string,
			index: number,
		): void => {
			const existing = map.get(key);
			if (existing) {
				existing.push(index);
				return;
			}
			map.set(key, [index]);
		};

		const asUniqueIndex = (indices: number[] | undefined): number | undefined => {
			if (!indices || indices.length !== 1) return undefined;
			const [onlyIndex] = indices;
			return typeof onlyIndex === "number" ? onlyIndex : undefined;
		};

		const pickNewestAccountIndex = (existingIndex: number, candidateIndex: number): number => {
			const existing = accounts[existingIndex];
			const candidate = accounts[candidateIndex];
			if (!existing) return candidateIndex;
			if (!candidate) return existingIndex;
			const existingLastUsed = existing.lastUsed ?? 0;
			const candidateLastUsed = candidate.lastUsed ?? 0;
			if (candidateLastUsed > existingLastUsed) return candidateIndex;
			if (candidateLastUsed < existingLastUsed) return existingIndex;
			const existingAddedAt = existing.addedAt ?? 0;
			const candidateAddedAt = candidate.addedAt ?? 0;
			return candidateAddedAt >= existingAddedAt ? candidateIndex : existingIndex;
		};

		const mergeAccountRecords = (targetIndex: number, sourceIndex: number): void => {
			const target = accounts[targetIndex];
			const source = accounts[sourceIndex];
			if (!target || !source) return;
			accounts[targetIndex] = mergeStoredAccountPair(target, source);
		};

		const normalizeStoredAccountId = (
			account: { accountId?: string } | undefined,
		): string | undefined => {
			const accountId = account?.accountId?.trim();
			return accountId && accountId.length > 0 ? accountId : undefined;
		};

		const canCollapseWithCandidateAccountId = (
			existing: { accountId?: string } | undefined,
			candidateAccountId: string | undefined,
		): boolean => {
			const existingAccountId = normalizeStoredAccountId(existing);
			const normalizedCandidate = candidateAccountId?.trim() || undefined;
			if (!existingAccountId || !normalizedCandidate) {
				return true;
			}
			return existingAccountId === normalizedCandidate;
		};

		type IdentityIndexes = {
			byOrganizationId: Map<string, number[]>;
			byAccountIdNoOrg: Map<string, number>;
			byRefreshTokenNoOrg: Map<string, number[]>;
			byEmailNoOrg: Map<string, number>;
			byAccountIdOrgScoped: Map<string, number[]>;
			byRefreshTokenOrgScoped: Map<string, number[]>;
			byRefreshTokenGlobal: Map<string, number[]>;
		};

		const resolveOrganizationMatch = (
			indexes: IdentityIndexes,
			organizationId: string,
			candidateAccountId: string | undefined,
		): number | undefined => {
			const matches = indexes.byOrganizationId.get(organizationId);
			if (!matches || matches.length === 0) return undefined;

			const candidateId = candidateAccountId?.trim() || undefined;
			let newestNoAccountId: number | undefined;
			let newestExactAccountId: number | undefined;
			let newestAnyNonEmptyAccountId: number | undefined;
			const distinctNonEmptyAccountIds = new Set<string>();

			for (const index of matches) {
				const existing = accounts[index];
				if (!existing) continue;
				const existingAccountId = normalizeStoredAccountId(existing);
				if (!existingAccountId) {
					newestNoAccountId =
						typeof newestNoAccountId === "number"
							? pickNewestAccountIndex(newestNoAccountId, index)
							: index;
					continue;
				}
				distinctNonEmptyAccountIds.add(existingAccountId);
				newestAnyNonEmptyAccountId =
					typeof newestAnyNonEmptyAccountId === "number"
						? pickNewestAccountIndex(newestAnyNonEmptyAccountId, index)
						: index;
				if (candidateId && existingAccountId === candidateId) {
					newestExactAccountId =
						typeof newestExactAccountId === "number"
							? pickNewestAccountIndex(newestExactAccountId, index)
							: index;
				}
			}

			if (candidateId) {
				return newestExactAccountId ?? newestNoAccountId;
			}
			if (typeof newestNoAccountId === "number") {
				return newestNoAccountId;
			}
			if (distinctNonEmptyAccountIds.size === 1) {
				return newestAnyNonEmptyAccountId;
			}
			return undefined;
		};

		const resolveNoOrgRefreshMatch = (
			indexes: IdentityIndexes,
			refreshToken: string,
			candidateAccountId: string | undefined,
		): number | undefined => {
			const candidateId = candidateAccountId?.trim() || undefined;
			const matches = indexes.byRefreshTokenNoOrg.get(refreshToken);
			if (!matches || matches.length === 0) return undefined;
			let newestNoAccountId: number | undefined;
			let newestExactAccountId: number | undefined;

			for (const index of matches) {
				const existing = accounts[index];
				const existingAccountId = normalizeStoredAccountId(existing);
				if (!existingAccountId) {
					newestNoAccountId =
						typeof newestNoAccountId === "number"
							? pickNewestAccountIndex(newestNoAccountId, index)
							: index;
					continue;
				}
				if (candidateId && existingAccountId === candidateId) {
					newestExactAccountId =
						typeof newestExactAccountId === "number"
							? pickNewestAccountIndex(newestExactAccountId, index)
							: index;
				}
			}

			return newestExactAccountId ?? newestNoAccountId;
		};

		const resolveUniqueOrgScopedMatch = (
			indexes: IdentityIndexes,
			accountId: string | undefined,
			refreshToken: string,
		): number | undefined => {
			const byAccountId = accountId
				? asUniqueIndex(indexes.byAccountIdOrgScoped.get(accountId))
				: undefined;
			if (byAccountId !== undefined) return byAccountId;

			if (accountId) {
				const accountMatches = indexes.byAccountIdOrgScoped.get(accountId);
				if (accountMatches && accountMatches.length > 1) {
					let newestRefreshMatch: number | undefined;
					for (const index of accountMatches) {
						const existing = accounts[index];
						if (!existing) continue;
						const existingRefresh = existing.refreshToken?.trim();
						if (!existingRefresh || existingRefresh !== refreshToken) {
							continue;
						}
						newestRefreshMatch =
							typeof newestRefreshMatch === "number"
								? pickNewestAccountIndex(newestRefreshMatch, index)
								: index;
					}
					if (typeof newestRefreshMatch === "number") {
						return newestRefreshMatch;
					}
				}
			}

			if (accountId) return undefined;
			return asUniqueIndex(indexes.byRefreshTokenOrgScoped.get(refreshToken));
		};

		const buildIdentityIndexes = (): IdentityIndexes => {
			const byOrganizationId = new Map<string, number[]>();
			const byAccountIdNoOrg = new Map<string, number>();
			const byRefreshTokenNoOrg = new Map<string, number[]>();
			const byEmailNoOrg = new Map<string, number>();
			const byAccountIdOrgScoped = new Map<string, number[]>();
			const byRefreshTokenOrgScoped = new Map<string, number[]>();
			const byRefreshTokenGlobal = new Map<string, number[]>();

			for (let i = 0; i < accounts.length; i += 1) {
				const account = accounts[i];
				if (!account) continue;

				const organizationId = account.organizationId?.trim();
				const accountId = account.accountId?.trim();
				const refreshToken = account.refreshToken?.trim();
				// Lowercase the email index key to match the lookup side
				// (sanitizeEmail) and getExactIdentityKey; a trim-only key here let a
				// mixed-case re-login miss its existing no-org entry and append a
				// duplicate (#171 email-identity consistency).
				const email = sanitizeEmail(account.email);

				if (refreshToken) {
					pushIndex(byRefreshTokenGlobal, refreshToken, i);
				}

				if (organizationId) {
					pushIndex(byOrganizationId, organizationId, i);
					if (accountId) {
						pushIndex(byAccountIdOrgScoped, accountId, i);
					}
					if (refreshToken) {
						pushIndex(byRefreshTokenOrgScoped, refreshToken, i);
					}
					continue;
				}

				if (accountId) {
					byAccountIdNoOrg.set(accountId, i);
				}
				if (refreshToken) {
					pushIndex(byRefreshTokenNoOrg, refreshToken, i);
				}
				if (email) {
					byEmailNoOrg.set(email, i);
				}
			}

			return {
				byOrganizationId,
				byAccountIdNoOrg,
				byRefreshTokenNoOrg,
				byEmailNoOrg,
				byAccountIdOrgScoped,
				byRefreshTokenOrgScoped,
				byRefreshTokenGlobal,
			};
		};

		let identityIndexes = buildIdentityIndexes();

		for (const result of results) {
			const accountId = result.accountIdOverride ?? extractAccountId(result.access);
			const normalizedAccountId = accountId?.trim() || undefined;
			const organizationId = result.organizationIdOverride?.trim() || undefined;
			const accountIdSource =
				normalizedAccountId
					? result.accountIdSource ??
						(result.accountIdOverride ? "manual" : "token")
					: undefined;
			const accountLabel = result.accountLabel;
			const accountEmail = sanitizeEmail(extractAccountEmail(result.access, result.idToken));

			const existingIndex = (() => {
				if (organizationId) {
					return resolveOrganizationMatch(
						identityIndexes,
						organizationId,
						normalizedAccountId,
					);
				}
				if (normalizedAccountId) {
					const byAccountId = identityIndexes.byAccountIdNoOrg.get(normalizedAccountId);
					if (byAccountId !== undefined) {
						return byAccountId;
					}
				}

				const byRefreshToken = resolveNoOrgRefreshMatch(
					identityIndexes,
					result.refresh,
					normalizedAccountId,
				);
				if (byRefreshToken !== undefined) {
					return byRefreshToken;
				}

				if (accountEmail && !normalizedAccountId) {
					const byEmail = identityIndexes.byEmailNoOrg.get(accountEmail);
					if (byEmail !== undefined) {
						return byEmail;
					}
				}

				const orgScoped = resolveUniqueOrgScopedMatch(
					identityIndexes,
					normalizedAccountId,
					result.refresh,
				);
				if (orgScoped !== undefined) return orgScoped;

				const globalRefreshMatch = asUniqueIndex(
					identityIndexes.byRefreshTokenGlobal.get(result.refresh),
				);
				if (globalRefreshMatch === undefined) {
					return undefined;
				}
				const existing = accounts[globalRefreshMatch];
				if (!canCollapseWithCandidateAccountId(existing, normalizedAccountId)) {
					return undefined;
				}
				return globalRefreshMatch;
			})();

			if (existingIndex === undefined) {
				accounts.push({
					accountId: normalizedAccountId,
					organizationId,
					accountIdSource,
					accountLabel,
					email: accountEmail,
					refreshToken: result.refresh,
					accessToken: result.access,
					expiresAt: result.expires,
					oauthScope: result.scope,
					addedAt: now,
					lastUsed: now,
				});
				identityIndexes = buildIdentityIndexes();
				continue;
			}

			const existing = accounts[existingIndex];
			if (!existing) continue;

			const nextEmail = accountEmail ?? existing.email;
			const nextOrganizationId = organizationId ?? existing.organizationId;
			const preserveOrgIdentity =
				typeof existing.organizationId === "string" &&
				existing.organizationId.trim().length > 0 &&
				!organizationId;
			const nextAccountId = preserveOrgIdentity
				? existing.accountId ?? normalizedAccountId
				: normalizedAccountId ?? existing.accountId;
			const nextAccountIdSource = preserveOrgIdentity
				? existing.accountIdSource ?? accountIdSource
				: normalizedAccountId
					? accountIdSource ?? existing.accountIdSource
					: existing.accountIdSource;
			const nextAccountLabel = preserveOrgIdentity
				? existing.accountLabel ?? accountLabel
				: accountLabel ?? existing.accountLabel;
			accounts[existingIndex] = {
				...existing,
				accountId: nextAccountId,
				organizationId: nextOrganizationId,
				accountIdSource: nextAccountIdSource,
				accountLabel: nextAccountLabel,
				email: nextEmail,
				refreshToken: result.refresh,
				accessToken: result.access,
				expiresAt: result.expires,
				oauthScope: result.scope ?? existing.oauthScope,
				lastUsed: now,
			};
			identityIndexes = buildIdentityIndexes();
		}

		const pruneRefreshTokenCollisions = (): void => {
			const indicesToRemove = new Set<number>();
			const exactIdentityToIndex = new Map<string, number>();

			const getExactIdentityKey = (
				account: {
					organizationId?: string;
					accountId?: string;
					email?: string;
					refreshToken?: string;
				} | undefined,
			): string => {
				const organizationId = account?.organizationId?.trim() ?? "";
				const accountId = normalizeStoredAccountId(account) ?? "";
				const email = account?.email?.trim().toLowerCase() ?? "";
				const refreshToken = account?.refreshToken?.trim() ?? "";
				if (organizationId || accountId) {
					return `org:${organizationId}|account:${accountId}|refresh:${refreshToken}`;
				}
				return `email:${email}|refresh:${refreshToken}`;
			};

			for (let i = 0; i < accounts.length; i += 1) {
				const account = accounts[i];
				if (!account) continue;

				const identityKey = getExactIdentityKey(account);
				const existingIndex = exactIdentityToIndex.get(identityKey);
				if (existingIndex === undefined) {
					exactIdentityToIndex.set(identityKey, i);
					continue;
				}

				const newestIndex = pickNewestAccountIndex(existingIndex, i);
				const obsoleteIndex = newestIndex === existingIndex ? i : existingIndex;
				mergeAccountRecords(newestIndex, obsoleteIndex);
				indicesToRemove.add(obsoleteIndex);
				exactIdentityToIndex.set(identityKey, newestIndex);
			}

			if (indicesToRemove.size > 0) {
				accounts = accounts.filter((_, index) => !indicesToRemove.has(index));
			}
		};

		const collectIdentityKeys = (
			account: { organizationId?: string; accountId?: string; refreshToken?: string } | undefined,
		): string[] => {
			const keys: string[] = [];
			const organizationId = account?.organizationId?.trim();
			if (organizationId) keys.push(`org:${organizationId}`);
			const accountId = account?.accountId?.trim();
			if (accountId) keys.push(`account:${accountId}`);
			const refreshToken = account?.refreshToken?.trim();
			if (refreshToken) keys.push(`refresh:${refreshToken}`);
			return keys;
		};

		const getStoredAccountAtIndex = (rawIndex: unknown) => {
			const storedAccounts = stored?.accounts;
			if (!storedAccounts) return undefined;
			if (typeof rawIndex !== "number" || !Number.isFinite(rawIndex)) return undefined;
			const candidate = Math.floor(rawIndex);
			if (candidate < 0 || candidate >= storedAccounts.length) return undefined;
			return storedAccounts[candidate];
		};

		const storedActiveKeys = replaceAll
			? []
			: collectIdentityKeys(getStoredAccountAtIndex(stored?.activeIndex));
		const storedActiveKeysByFamily: Partial<Record<ModelFamily, string[]>> = {};
		if (!replaceAll) {
			for (const family of MODEL_FAMILIES) {
				const familyKeys = collectIdentityKeys(
					getStoredAccountAtIndex(stored?.activeIndexByFamily?.[family]),
				);
				if (familyKeys.length > 0) {
					storedActiveKeysByFamily[family] = familyKeys;
				}
			}
		}

		pruneRefreshTokenCollisions();

		if (accounts.length === 0) return;

		const resolveIndexByIdentityKeys = (identityKeys: string[] | undefined): number | undefined => {
			if (!identityKeys || identityKeys.length === 0) return undefined;
			for (const identityKey of identityKeys) {
				const index = accounts.findIndex(
					(account) => collectIdentityKeys(account).includes(identityKey),
				);
				if (index >= 0) {
					return index;
				}
			}
			return undefined;
		};

		const fallbackActiveIndex = replaceAll
			? 0
			: typeof stored?.activeIndex === "number" && Number.isFinite(stored.activeIndex)
				? stored.activeIndex
				: 0;
		const remappedActiveIndex = replaceAll
			? undefined
			: resolveIndexByIdentityKeys(storedActiveKeys);
		const activeIndex = remappedActiveIndex ?? fallbackActiveIndex;

		const clampedActiveIndex = Math.max(0, Math.min(Math.floor(activeIndex), accounts.length - 1));
		const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
		const familiesToPersist = replaceAll
			? []
			: MODEL_FAMILIES.filter((family) => {
				const storedFamilyIndex = stored?.activeIndexByFamily?.[family];
				return typeof storedFamilyIndex === "number" && Number.isFinite(storedFamilyIndex);
			});
		for (const family of familiesToPersist) {
			const storedFamilyIndex = stored?.activeIndexByFamily?.[family];
			const remappedFamilyIndex = replaceAll
				? undefined
				: resolveIndexByIdentityKeys(storedActiveKeysByFamily[family]);
			const rawFamilyIndex = replaceAll
				? 0
				: typeof remappedFamilyIndex === "number"
					? remappedFamilyIndex
					: typeof storedFamilyIndex === "number" && Number.isFinite(storedFamilyIndex)
						? storedFamilyIndex
						: clampedActiveIndex;
			activeIndexByFamily[family] = Math.max(
				0,
				Math.min(Math.floor(rawFamilyIndex), accounts.length - 1),
			);
		}

		await persist({
			version: 3,
			accounts,
			activeIndex: clampedActiveIndex,
			activeIndexByFamily,
		});
	});
}

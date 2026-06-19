/**
 * Account identity + dedup helpers.
 *
 * Split out of `lib/storage.ts` in RC-2. This module is pure and synchronous:
 * it owns the identity-key hierarchy (`organizationId` -> `accountId` ->
 * `refreshToken`) and the dedup + merge rules used by `normalizeAccountStorage`
 * and the import transaction.
 *
 * The two public exports that were already re-exported from `lib/storage.ts`
 * (`deduplicateAccounts`, `deduplicateAccountsByEmail`) keep their original
 * shape so external callers can import them via either the barrel or this
 * submodule.
 */

import type { AccountMetadataV3 } from "./migrations.js";

export type AccountLike = {
  organizationId?: string;
  accountId?: string;
  accountIdSource?: AccountMetadataV3["accountIdSource"];
  accountLabel?: string;
  email?: string;
  refreshToken: string;
  addedAt?: number;
  lastUsed?: number;
  enabled?: boolean;
};

const normalizeWorkspaceIdentityPart = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export function getWorkspaceIdentityKey(account: {
  organizationId?: string;
  accountId?: string;
  refreshToken: string;
}): string {
  const organizationId = normalizeWorkspaceIdentityPart(account.organizationId);
  const accountId = normalizeWorkspaceIdentityPart(account.accountId);
  const refreshToken = normalizeWorkspaceIdentityPart(account.refreshToken) ?? "";
  if (organizationId) {
    return accountId
      ? `organizationId:${organizationId}|accountId:${accountId}`
      : `organizationId:${organizationId}`;
  }
  if (accountId) {
    return `accountId:${accountId}`;
  }
  return `refreshToken:${refreshToken}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

export function toAccountIdentityKeys(
  account: Pick<AccountMetadataV3, "organizationId" | "accountId" | "refreshToken">,
): string[] {
  const keys: string[] = [];
  const organizationId = typeof account.organizationId === "string" ? account.organizationId.trim() : "";
  if (organizationId) {
    keys.push(`organizationId:${organizationId}`);
  }

  const accountId = typeof account.accountId === "string" ? account.accountId.trim() : "";
  if (accountId) {
    keys.push(`accountId:${accountId}`);
  }

  const refreshToken = typeof account.refreshToken === "string" ? account.refreshToken.trim() : "";
  if (refreshToken) {
    keys.push(`refreshToken:${refreshToken}`);
  }

  return keys;
}

export function toAccountIdentityKey(
  account: Pick<AccountMetadataV3, "organizationId" | "accountId" | "refreshToken">,
): string | undefined {
  return toAccountIdentityKeys(account)[0];
}

export function extractActiveKeys(accounts: unknown[], activeIndex: number): string[] {
  const candidate = accounts[activeIndex];
  if (!isRecord(candidate)) return [];

  return toAccountIdentityKeys({
    organizationId: typeof candidate.organizationId === "string" ? candidate.organizationId : undefined,
    accountId: typeof candidate.accountId === "string" ? candidate.accountId : undefined,
    refreshToken: typeof candidate.refreshToken === "string" ? candidate.refreshToken : "",
  });
}

export function findAccountIndexByIdentityKeys(
  accounts: Pick<AccountMetadataV3, "organizationId" | "accountId" | "refreshToken">[],
  identityKeys: string[],
): number {
  if (identityKeys.length === 0) return -1;
  for (const identityKey of identityKeys) {
    const idx = accounts.findIndex((account) => toAccountIdentityKeys(account).includes(identityKey));
    if (idx >= 0) {
      return idx;
    }
  }
  return -1;
}

function selectNewestAccount<T extends AccountLike>(
  current: T | undefined,
  candidate: T,
): T {
  if (!current) return candidate;
  const currentLastUsed = current.lastUsed || 0;
  const candidateLastUsed = candidate.lastUsed || 0;
  if (candidateLastUsed > currentLastUsed) return candidate;
  if (candidateLastUsed < currentLastUsed) return current;
  const currentAddedAt = current.addedAt || 0;
  const candidateAddedAt = candidate.addedAt || 0;
  return candidateAddedAt >= currentAddedAt ? candidate : current;
}

function pickNewestAccountIndex<T extends AccountLike>(
  accounts: T[],
  existingIndex: number,
  candidateIndex: number,
): number {
  const existing = accounts[existingIndex];
  const candidate = accounts[candidateIndex];
  if (!existing) return candidateIndex;
  if (!candidate) return existingIndex;
  const newest = selectNewestAccount(existing, candidate);
  return newest === candidate ? candidateIndex : existingIndex;
}

function isOrgLikeAccount<T extends AccountLike>(account: T): boolean {
  return (
    !!normalizeWorkspaceIdentityPart(account.organizationId) ||
    account.accountIdSource === "org"
  );
}

/**
 * Resolve the merged `enabled` flag.
 *
 * Default is fail-closed: if either side is explicitly disabled, the merge is
 * disabled. The ONE exception (issue #171): when exactly one side is an
 * org-backed real account and the other is a token-source duplicate (a plugin
 * re-login artifact), the org account's own `enabled` state governs. A disabled
 * token duplicate must never silently disable the real account it collapses
 * into — otherwise the canonical account becomes unroutable and unrecoverable.
 */
function resolveMergedEnabled<T extends AccountLike>(target: T, source: T): boolean | undefined {
  const targetOrgLike = isOrgLikeAccount(target);
  const sourceOrgLike = isOrgLikeAccount(source);
  const targetTokenDup = !targetOrgLike && target.accountIdSource === "token";
  const sourceTokenDup = !sourceOrgLike && source.accountIdSource === "token";

  if (targetOrgLike && sourceTokenDup) return target.enabled;
  if (sourceOrgLike && targetTokenDup) return source.enabled;

  // Fail-closed for every other shape (same-identity, two real accounts, etc.).
  if (target.enabled === false || source.enabled === false) return false;
  return target.enabled ?? source.enabled;
}

function mergeAccountRecords<T extends AccountLike>(target: T, source: T): T {
  const newest = selectNewestAccount(target, source);
  const older = newest === target ? source : target;
  return {
    ...older,
    ...newest,
    organizationId: target.organizationId ?? source.organizationId,
    accountId: target.accountId ?? source.accountId,
    accountIdSource: target.accountIdSource ?? source.accountIdSource,
    accountLabel: target.accountLabel ?? source.accountLabel,
    email: target.email ?? source.email,
    enabled: resolveMergedEnabled(target, source),
  };
}

function sameOptionalIdentity(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeWorkspaceIdentityPart(left);
  const normalizedRight = normalizeWorkspaceIdentityPart(right);
  return !!normalizedLeft && !!normalizedRight && normalizedLeft === normalizedRight;
}

function isLegacyRefreshTokenDuplicate<T extends AccountLike>(left: T, right: T): boolean {
  const refreshToken = normalizeWorkspaceIdentityPart(left.refreshToken);
  const leftOrganizationId = normalizeWorkspaceIdentityPart(left.organizationId);
  const rightOrganizationId = normalizeWorkspaceIdentityPart(right.organizationId);
  if (leftOrganizationId && rightOrganizationId && leftOrganizationId !== rightOrganizationId) {
    return false;
  }
  const leftOrgLike = !!leftOrganizationId || left.accountIdSource === "org";
  const rightOrgLike = !!rightOrganizationId || right.accountIdSource === "org";
  const leftTokenLike = !leftOrganizationId && left.accountIdSource === "token";
  const rightTokenLike = !rightOrganizationId && right.accountIdSource === "token";
  if (
    ((leftOrgLike && rightTokenLike) || (rightOrgLike && leftTokenLike)) &&
    (sameOptionalIdentity(left.email, right.email) ||
      (!!refreshToken && refreshToken === normalizeWorkspaceIdentityPart(right.refreshToken)))
  ) {
    return true;
  }
  if (!refreshToken || refreshToken !== normalizeWorkspaceIdentityPart(right.refreshToken)) {
    return false;
  }

  const leftAccountId = normalizeWorkspaceIdentityPart(left.accountId);
  const rightAccountId = normalizeWorkspaceIdentityPart(right.accountId);
  if (leftAccountId && rightAccountId && leftAccountId !== rightAccountId) {
    return false;
  }

  return (
    sameOptionalIdentity(left.accountId, right.accountId) ||
    (!leftOrganizationId && !!rightOrganizationId && !left.accountId) ||
    (!!leftOrganizationId && !rightOrganizationId && !right.accountId)
  );
}

function deduplicateLegacyRefreshTokenDuplicates<T extends AccountLike>(accounts: T[]): T[] {
  const working = [...accounts];
  const indicesToRemove = new Set<number>();

  for (let i = 0; i < working.length; i += 1) {
    if (indicesToRemove.has(i)) continue;
    const account = working[i];
    if (!account) continue;

    for (let j = i + 1; j < working.length; j += 1) {
      if (indicesToRemove.has(j)) continue;
      const candidate = working[j];
      if (!candidate || !isLegacyRefreshTokenDuplicate(account, candidate)) continue;

      const accountOrgLike = !!normalizeWorkspaceIdentityPart(account.organizationId) || account.accountIdSource === "org";
      const candidateOrgLike = !!normalizeWorkspaceIdentityPart(candidate.organizationId) || candidate.accountIdSource === "org";
      const newestIndex = accountOrgLike && !candidateOrgLike
        ? i
        : candidateOrgLike && !accountOrgLike
          ? j
          : pickNewestAccountIndex(working, i, j);
      const obsoleteIndex = newestIndex === i ? j : i;
      const target = working[newestIndex];
      const source = working[obsoleteIndex];
      if (target && source) {
        working[newestIndex] = mergeAccountRecords(target, source);
      }
      indicesToRemove.add(obsoleteIndex);
      if (obsoleteIndex === i) break;
    }
  }

  return working.filter((account, index) => !!account && !indicesToRemove.has(index));
}

function deduplicateAccountsByKey<T extends AccountLike>(accounts: T[]): T[] {
  const working = [...accounts];
  const keyToIndex = new Map<string, number>();
  const indicesToRemove = new Set<number>();

  for (let i = 0; i < working.length; i += 1) {
    const account = working[i];
    if (!account) continue;
    const key = toAccountIdentityKey(account);
    if (!key) continue;

    const existingIndex = keyToIndex.get(key);
    if (existingIndex === undefined) {
      keyToIndex.set(key, i);
      continue;
    }

    const newestIndex = pickNewestAccountIndex(working, existingIndex, i);
    const obsoleteIndex = newestIndex === existingIndex ? i : existingIndex;
    const target = working[newestIndex];
    const source = working[obsoleteIndex];
    if (target && source) {
      working[newestIndex] = mergeAccountRecords(target, source);
    }
    indicesToRemove.add(obsoleteIndex);
    keyToIndex.set(key, newestIndex);
  }

  const result: T[] = [];
  for (let i = 0; i < working.length; i += 1) {
    if (indicesToRemove.has(i)) continue;
    const account = working[i];
    if (account) result.push(account);
  }
  return result;
}

/**
 * Removes duplicate accounts, keeping the most recently used entry for each unique key.
 * Deduplication identity hierarchy: organizationId -> accountId -> refreshToken.
 * @param accounts - Array of accounts to deduplicate
 * @returns New array with duplicates removed
 */
export function deduplicateAccounts<T extends { organizationId?: string; accountId?: string; refreshToken: string; lastUsed?: number; addedAt?: number }>(
  accounts: T[],
): T[] {
  return deduplicateAccountsByKey(accounts);
}

/**
 * Removes duplicate legacy accounts by email, keeping the most recently used entry.
 * Accounts with organizationId/accountId are never merged by email to avoid collapsing workspace variants.
 * Accounts without email are always preserved.
 * @param accounts - Array of accounts to deduplicate
 * @returns New array with email duplicates removed
 */
export function deduplicateAccountsByEmail<T extends { organizationId?: string; accountId?: string; email?: string; lastUsed?: number; addedAt?: number }>(
  accounts: T[],
): T[] {
  const emailToNewestIndex = new Map<string, number>();
  const indicesToKeep = new Set<number>();

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i];
    if (!account) continue;

    const organizationId = account.organizationId?.trim();
    if (organizationId) {
      indicesToKeep.add(i);
      continue;
    }

    const accountId = account.accountId?.trim();
    if (accountId) {
      indicesToKeep.add(i);
      continue;
    }

    const email = account.email?.trim();
    if (!email) {
      indicesToKeep.add(i);
      continue;
    }

    const existingIndex = emailToNewestIndex.get(email);
    if (existingIndex === undefined) {
      emailToNewestIndex.set(email, i);
      continue;
    }

    const existing = accounts[existingIndex];
    // istanbul ignore next -- defensive code: existingIndex always refers to valid account
    if (!existing) {
      emailToNewestIndex.set(email, i);
      continue;
    }

    const existingLastUsed = existing.lastUsed || 0;
    const candidateLastUsed = account.lastUsed || 0;
    const existingAddedAt = existing.addedAt || 0;
    const candidateAddedAt = account.addedAt || 0;

    const isNewer =
      candidateLastUsed > existingLastUsed ||
      (candidateLastUsed === existingLastUsed && candidateAddedAt > existingAddedAt);

    if (isNewer) {
      emailToNewestIndex.set(email, i);
    }
  }

  for (const idx of emailToNewestIndex.values()) {
    indicesToKeep.add(idx);
  }

  const result: T[] = [];
  for (let i = 0; i < accounts.length; i += 1) {
    if (indicesToKeep.has(i)) {
      const account = accounts[i];
      if (account) result.push(account);
    }
  }
  return result;
}

/**
 * Applies storage deduplication semantics used by normalize/import paths.
 * 1) Dedupe only exact identity duplicates (organizationId -> accountId -> refreshToken),
 *    preserving distinct workspace variants that share a refresh token.
 * 2) Then apply legacy email dedupe only for entries that still do not have organizationId/accountId.
 */
export function deduplicateAccountsForStorage<T extends AccountLike & { email?: string }>(accounts: T[]): T[] {
  return deduplicateAccountsByEmail(deduplicateLegacyRefreshTokenDuplicates(deduplicateAccountsByKey(accounts)));
}

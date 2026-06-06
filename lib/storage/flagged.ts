/**
 * Flagged-account storage: load/save/clear + transactional update.
 *
 * Split out of `lib/storage.ts` in RC-2. Flagged accounts live in a sibling
 * file next to the main accounts file and follow the same mutex, temp-file +
 * rename, and legacy-file migration pattern — just with a simpler V1-only
 * schema and different legacy filenames (flagged-accounts.json and the
 * older blocked-accounts.json).
 */

import { promises as fs, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FLAGGED_ACCOUNTS_FILE_NAME,
  LEGACY_BLOCKED_ACCOUNTS_FILE_NAME,
  LEGACY_FLAGGED_ACCOUNTS_FILE_NAME,
} from "../constants.js";
import { createLogger } from "../logger.js";
import { renameWithWindowsRetry } from "./atomic-write.js";
import { getWorkspaceIdentityKey, isRecord } from "./identity.js";
import { getStoragePath, getCurrentProjectStorageKey, withStorageLock } from "./state.js";
import {
  isKeychainOptInEnabled,
  readFlaggedFromKeychain,
  writeFlaggedToKeychain,
} from "./keychain.js";
import type { AccountMetadataV3 } from "./migrations.js";

const log = createLogger("storage");

export interface FlaggedAccountMetadataV1 extends AccountMetadataV3 {
  flaggedAt: number;
  flaggedReason?: string;
  lastError?: string;
}

export interface FlaggedAccountStorageV1 {
  version: 1;
  accounts: FlaggedAccountMetadataV1[];
}

export function getFlaggedAccountsPath(): string {
  return join(dirname(getStoragePath()), FLAGGED_ACCOUNTS_FILE_NAME);
}

function getLegacyFlaggedAccountsPath(): string {
  return join(dirname(getStoragePath()), LEGACY_FLAGGED_ACCOUNTS_FILE_NAME);
}

function getLegacyBlockedAccountsPath(): string {
  return join(dirname(getStoragePath()), LEGACY_BLOCKED_ACCOUNTS_FILE_NAME);
}

function normalizeFlaggedStorage(data: unknown): FlaggedAccountStorageV1 {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.accounts)) {
    return { version: 1, accounts: [] };
  }

  const byIdentityKey = new Map<string, FlaggedAccountMetadataV1>();
  for (const rawAccount of data.accounts) {
    if (!isRecord(rawAccount)) continue;
    const refreshToken =
      typeof rawAccount.refreshToken === "string" ? rawAccount.refreshToken.trim() : "";
    if (!refreshToken) continue;

    const flaggedAt = typeof rawAccount.flaggedAt === "number" ? rawAccount.flaggedAt : Date.now();
    const isAccountIdSource = (
      value: unknown,
    ): value is AccountMetadataV3["accountIdSource"] =>
      value === "token" || value === "id_token" || value === "org" || value === "manual";
    const isSwitchReason = (
      value: unknown,
    ): value is AccountMetadataV3["lastSwitchReason"] =>
      value === "rate-limit" || value === "initial" || value === "rotation";
    const isCooldownReason = (
      value: unknown,
    ): value is AccountMetadataV3["cooldownReason"] =>
      value === "auth-failure" || value === "network-error";
    const normalizeTags = (value: unknown): string[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      const normalized = value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
      return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
    };

    let rateLimitResetTimes: AccountMetadataV3["rateLimitResetTimes"] | undefined;
    if (isRecord(rawAccount.rateLimitResetTimes)) {
      const normalizedRateLimits: Record<string, number | undefined> = {};
      for (const [key, value] of Object.entries(rawAccount.rateLimitResetTimes)) {
        if (typeof value === "number") {
          normalizedRateLimits[key] = value;
        }
      }
      if (Object.keys(normalizedRateLimits).length > 0) {
        rateLimitResetTimes = normalizedRateLimits;
      }
    }

    const accountIdSource = isAccountIdSource(rawAccount.accountIdSource)
      ? rawAccount.accountIdSource
      : undefined;
    const lastSwitchReason = isSwitchReason(rawAccount.lastSwitchReason)
      ? rawAccount.lastSwitchReason
      : undefined;
    const cooldownReason = isCooldownReason(rawAccount.cooldownReason)
      ? rawAccount.cooldownReason
      : undefined;
    const accountTags = normalizeTags(rawAccount.accountTags);
    const accountNote =
      typeof rawAccount.accountNote === "string" && rawAccount.accountNote.trim()
        ? rawAccount.accountNote.trim()
        : undefined;

    const normalized: FlaggedAccountMetadataV1 = {
      refreshToken,
      addedAt: typeof rawAccount.addedAt === "number" ? rawAccount.addedAt : flaggedAt,
      lastUsed: typeof rawAccount.lastUsed === "number" ? rawAccount.lastUsed : flaggedAt,
      organizationId:
        typeof rawAccount.organizationId === "string" ? rawAccount.organizationId : undefined,
      accountId: typeof rawAccount.accountId === "string" ? rawAccount.accountId : undefined,
      accountIdSource,
      accountLabel: typeof rawAccount.accountLabel === "string" ? rawAccount.accountLabel : undefined,
      accountTags,
      accountNote,
      email: typeof rawAccount.email === "string" ? rawAccount.email : undefined,
      enabled: typeof rawAccount.enabled === "boolean" ? rawAccount.enabled : undefined,
      lastSwitchReason,
      rateLimitResetTimes,
      coolingDownUntil:
        typeof rawAccount.coolingDownUntil === "number" ? rawAccount.coolingDownUntil : undefined,
      cooldownReason,
      flaggedAt,
      flaggedReason: typeof rawAccount.flaggedReason === "string" ? rawAccount.flaggedReason : undefined,
      lastError: typeof rawAccount.lastError === "string" ? rawAccount.lastError : undefined,
    };
    // Keep flagged dedup aligned with active cleanup so sibling workspaces only
    // collapse when they resolve to the same shared workspace identity.
    byIdentityKey.set(getWorkspaceIdentityKey(normalized), normalized);
  }

  return {
    version: 1,
    accounts: Array.from(byIdentityKey.values()),
  };
}

async function loadFlaggedAccountsUnlocked(
  saveUnlocked: (storage: FlaggedAccountStorageV1) => Promise<void>,
): Promise<FlaggedAccountStorageV1> {
  const path = getFlaggedAccountsPath();
  const empty: FlaggedAccountStorageV1 = { version: 1, accounts: [] };

  // Keychain-first when opt-in is enabled, mirroring the main account store.
  // A null/throw is treated as "fall back to JSON" — never as "no flagged
  // accounts" — so a locked keychain doesn't hide the on-disk copy.
  if (isKeychainOptInEnabled()) {
    try {
      const blob = await readFlaggedFromKeychain(getCurrentProjectStorageKey());
      if (blob !== null) {
        try {
          return normalizeFlaggedStorage(JSON.parse(blob) as unknown);
        } catch (parseErr) {
          log.warn("keychain: flagged payload failed to parse; falling back to JSON", {
            error: String(parseErr),
          });
        }
      }
    } catch (err) {
      log.warn("keychain: flagged read failed; falling back to JSON", {
        error: String(err),
      });
    }
  }

  try {
    const content = await fs.readFile(path, "utf-8");
    const data = JSON.parse(content) as unknown;
    return normalizeFlaggedStorage(data);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.error("Failed to load flagged account storage", { path, error: String(error) });
      return empty;
    }
  }

  for (const legacyPath of [getLegacyFlaggedAccountsPath(), getLegacyBlockedAccountsPath()]) {
    if (!existsSync(legacyPath)) {
      continue;
    }

    try {
      const legacyContent = await fs.readFile(legacyPath, "utf-8");
      const legacyData = JSON.parse(legacyContent) as unknown;
      const migrated = normalizeFlaggedStorage(legacyData);
      if (migrated.accounts.length > 0) {
        await saveUnlocked(migrated);
      }
      try {
        await fs.unlink(legacyPath);
      } catch {
        // Best effort cleanup.
      }
      log.info("Migrated legacy flagged account storage", {
        from: legacyPath,
        to: path,
        accounts: migrated.accounts.length,
      });
      return migrated;
    } catch (error) {
      log.error("Failed to migrate legacy flagged account storage", {
        from: legacyPath,
        to: path,
        error: String(error),
      });
      return empty;
    }
  }

  return empty;
}

async function saveFlaggedAccountsUnlocked(storage: FlaggedAccountStorageV1): Promise<void> {
  const path = getFlaggedAccountsPath();
  const normalized = normalizeFlaggedStorage(storage);
  const content = JSON.stringify(normalized, null, 2);

  // When keychain opt-in is enabled, store flagged credentials in the OS
  // keychain like the main account store. Flagged records carry raw refresh
  // tokens (required to restore via verify-flagged), so writing them as
  // plaintext JSON would defeat the keychain protection the user opted into.
  if (isKeychainOptInEnabled()) {
    const projectKey = getCurrentProjectStorageKey();
    const result = await writeFlaggedToKeychain(projectKey, content);
    if (result.ok) {
      // Remove any stale plaintext file so the secret does not linger on disk.
      try {
        await fs.unlink(path);
      } catch {
        // Best effort: file may not exist.
      }
      return;
    }
    log.warn("keychain: flagged write failed; falling back to JSON for this save", {
      error: result.error,
    });
  }

  const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = `${path}.${uniqueSuffix}.tmp`;

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    await renameWithWindowsRetry(tempPath, path);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup failures.
    }
    log.error("Failed to save flagged account storage", { path, error: String(error) });
    throw error;
  }
}

export async function loadFlaggedAccounts(): Promise<FlaggedAccountStorageV1> {
  return withStorageLock(async () => loadFlaggedAccountsUnlocked(saveFlaggedAccountsUnlocked));
}

/**
 * Executes a read-modify-write transaction for flagged account storage under the
 * shared storage lock so concurrent callers cannot lose updates.
 */
export async function withFlaggedAccountStorageTransaction<T>(
  handler: (
    current: FlaggedAccountStorageV1,
    persist: (storage: FlaggedAccountStorageV1) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  return withStorageLock(async () => {
    const current = await loadFlaggedAccountsUnlocked(saveFlaggedAccountsUnlocked);
    return handler(current, saveFlaggedAccountsUnlocked);
  });
}

export async function saveFlaggedAccounts(storage: FlaggedAccountStorageV1): Promise<void> {
  return withStorageLock(async () => {
    await saveFlaggedAccountsUnlocked(storage);
  });
}

export async function clearFlaggedAccounts(): Promise<void> {
  return withStorageLock(async () => {
    try {
      await fs.unlink(getFlaggedAccountsPath());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.error("Failed to clear flagged account storage", { error: String(error) });
      }
    }
  });
}

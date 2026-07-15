/**
 * Barrel for the account-storage layer.
 *
 * RC-2 split the original 1400-line `lib/storage.ts` into focused modules
 * under `lib/storage/`. This file exists to keep the public surface stable
 * so every consumer that imports from `./storage` / `../storage` resolves
 * exactly as it did before the refactor.
 *
 * See `docs/audits/07-refactoring-plan.md#rc-2` and
 * `docs/audits/16-code-health.md` for the motivation.
 */

// --- Types re-exported from migrations ---------------------------------------
export type {
  CooldownReason,
  RateLimitStateV3,
  AccountMetadataV1,
  AccountStorageV1,
  AccountMetadataV3,
  AccountStorageV3,
} from "./storage/migrations.js";

// --- Errors ------------------------------------------------------------------
export { StorageError, formatStorageErrorHint } from "./storage/errors.js";

// --- Path + state management -------------------------------------------------
export {
  setStoragePath,
  setStoragePathDirect,
  getStoragePath,
  // Re-exported so tool-layer code that must wrap several raw fs operations
  // (e.g. codex-keychain's rollback) in the SAME critical section as
  // loadAccounts/saveAccounts can do so without duplicating the mutex.
  // Callers must never call loadAccounts/saveAccounts/clearAccounts (the
  // locked wrappers) from inside a withStorageLock callback -- the mutex is
  // not re-entrant and doing so deadlocks. Use direct fs operations instead,
  // mirroring how withAccountStorageTransaction's `persist` callback stays
  // unlocked.
  withStorageLock,
} from "./storage/state.js";

// --- Identity + dedup helpers ------------------------------------------------
export {
  getWorkspaceIdentityKey,
  deduplicateAccounts,
  deduplicateAccountsByEmail,
} from "./storage/identity.js";

// --- Normalization -----------------------------------------------------------
export { normalizeAccountStorage } from "./storage/normalize.js";

// --- Account load/save + transaction -----------------------------------------
export {
  loadAccounts,
  saveAccounts,
  clearAccounts,
  withAccountStorageTransaction,
} from "./storage/load-save.js";

// --- Flagged accounts --------------------------------------------------------
export type {
  FlaggedAccountMetadataV1,
  FlaggedAccountStorageV1,
} from "./storage/flagged.js";
export {
  getFlaggedAccountsPath,
  loadFlaggedAccounts,
  saveFlaggedAccounts,
  clearFlaggedAccounts,
  withFlaggedAccountStorageTransaction,
} from "./storage/flagged.js";

// --- Backups -----------------------------------------------------------------
export { createTimestampedBackupPath } from "./storage/backup.js";

// --- Export / import ---------------------------------------------------------
export type {
  ImportBackupMode,
  ImportBackupStatus,
  ImportAccountsOptions,
  ImportAccountsResult,
  ImportPreviewResult,
} from "./storage/export-import.js";
export {
  exportAccounts,
  importAccounts,
  previewImportAccounts,
} from "./storage/export-import.js";

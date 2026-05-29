import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import {
  deduplicateAccounts,
  deduplicateAccountsByEmail,
  setStoragePathDirect,
  type AccountStorageV3,
} from "../lib/storage.js";
import type { ModelFamily } from "../lib/prompts/codex.js";

const TEST_ACCOUNTS = [
  { email: "account1@example.com", refresh_token: "fake_refresh_token_1_for_testing_only" },
  { email: "account2@example.com", refresh_token: "fake_refresh_token_2_for_testing_only" },
  { email: "account3@example.com", refresh_token: "fake_refresh_token_3_for_testing_only" },
  { email: "account4@example.com", refresh_token: "fake_refresh_token_4_for_testing_only" },
  { email: "account5@example.com", refresh_token: "fake_refresh_token_5_for_testing_only" },
  { email: "account6@example.com", refresh_token: "fake_refresh_token_6_for_testing_only" },
  { email: "account7@example.com", refresh_token: "fake_refresh_token_7_for_testing_only" },
  { email: "account8@example.com", refresh_token: "fake_refresh_token_8_for_testing_only" },
  { email: "account9@example.com", refresh_token: "fake_refresh_token_9_for_testing_only" },
  { email: "account10@example.com", refresh_token: "fake_refresh_token_10_for_testing_only" },
];

const DUPLICATE_EMAIL_ACCOUNTS = [
  { email: "duplicate.a@example.com", refresh_token: "token_old", lastUsed: 1000 },
  { email: "duplicate.a@example.com", refresh_token: "token_new", lastUsed: 2000 },
  { email: "duplicate.b@example.com", refresh_token: "token_old_2", lastUsed: 1500 },
  { email: "duplicate.b@example.com", refresh_token: "token_new_2", lastUsed: 2500 },
  { email: "unique@example.com", refresh_token: "token_unique", lastUsed: 1800 },
];

function createStorageFromTestAccounts(accounts: typeof TEST_ACCOUNTS): AccountStorageV3 {
  const now = Date.now();
  return {
    version: 3,
    accounts: accounts.map((acc, idx) => ({
      email: acc.email,
      refreshToken: acc.refresh_token,
      addedAt: now - (accounts.length - idx) * 1000,
      lastUsed: now - (accounts.length - idx) * 500,
    })),
    activeIndex: 0,
    activeIndexByFamily: {
      "gpt-5.2-codex": 0,
      "codex-max": 0,
      codex: 0,
      "gpt-5.2": 0,
      "gpt-5.1": 0,
    },
  };
}

const TEST_STORAGE_PATH = join(
  tmpdir(),
  `oc-codex-multi-auth-rotation-integration-${process.pid}-${Date.now()}.json`,
);

describe("Multi-Account Rotation Integration", () => {
  beforeAll(() => {
    // Prevent integration tests that call saveToDisk/saveToDiskDebounced from touching real user auth storage.
    setStoragePathDirect(TEST_STORAGE_PATH);
  });

  afterAll(async () => {
    // Tests that schedule debounced saves (see "Debounced save") flush and
    // dispose their own managers while TEST_STORAGE_PATH is still active, so
    // no pending write can outlive this teardown. We deliberately do NOT call
    // the global runCleanup() here: it drains the shared shutdown-flush queue
    // in lib/shutdown.ts, which under non-default vitest pools (singleThread /
    // vmForks) would also flush AccountManager handlers registered by other
    // test files in the same process against the wrong storage path.
    try {
      await fs.unlink(TEST_STORAGE_PATH);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    setStoragePathDirect(null);
  });

  describe("AccountManager with real test accounts", () => {
    let manager: AccountManager;

    beforeEach(() => {
      const storage = createStorageFromTestAccounts(TEST_ACCOUNTS);
      manager = new AccountManager(undefined, storage);
    });

    it("loads all 10 test accounts correctly", () => {
      expect(manager.getAccountCount()).toBe(10);
    });

    it("rotates through accounts in round-robin order for same family", () => {
      const family: ModelFamily = "codex";
      const seen: number[] = [];

      for (let i = 0; i < 10; i++) {
        const account = manager.getCurrentOrNextForFamily(family);
        expect(account).not.toBeNull();
        if (account) seen.push(account.index);
      }

      expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it("wraps around after reaching the last account", () => {
      const family: ModelFamily = "gpt-5.1";
      const seen: number[] = [];

      for (let i = 0; i < 15; i++) {
        const account = manager.getCurrentOrNextForFamily(family);
        expect(account).not.toBeNull();
        if (account) seen.push(account.index);
      }

      expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4]);
    });

    it("maintains independent cursors per model family", () => {
      const codexAccount1 = manager.getCurrentOrNextForFamily("codex");
      const codexAccount2 = manager.getCurrentOrNextForFamily("codex");
      const gpt51Account1 = manager.getCurrentOrNextForFamily("gpt-5.1");
      const codexAccount3 = manager.getCurrentOrNextForFamily("codex");
      const gpt51Account2 = manager.getCurrentOrNextForFamily("gpt-5.1");

      expect(codexAccount1?.index).toBe(0);
      expect(codexAccount2?.index).toBe(1);
      expect(gpt51Account1?.index).toBe(0);
      expect(codexAccount3?.index).toBe(2);
      expect(gpt51Account2?.index).toBe(1);
    });

    it("skips rate-limited accounts and picks next available", () => {
      const family: ModelFamily = "codex";

      manager.getCurrentOrNextForFamily(family);
      const account1 = manager.getCurrentOrNextForFamily(family);
      expect(account1?.index).toBe(1);

      manager.markRateLimited(account1!, 60000, family);

      const account2 = manager.getCurrentOrNextForFamily(family);
      expect(account2?.index).toBe(2);

      const account3 = manager.getCurrentOrNextForFamily(family);
      expect(account3?.index).toBe(3);
    });

    it("skips cooling down accounts", () => {
      const family: ModelFamily = "gpt-5.2";

      const account0 = manager.getCurrentOrNextForFamily(family);
      expect(account0?.index).toBe(0);

      manager.markAccountCoolingDown(account0!, 60000, "auth-failure");

      const account1 = manager.getCurrentOrNextForFamily(family);
      expect(account1?.index).toBe(1);
    });

    it("returns null when all accounts are rate-limited", () => {
      const family: ModelFamily = "codex";

      for (let i = 0; i < 10; i++) {
        const account = manager.getCurrentOrNextForFamily(family);
        if (account) {
          manager.markRateLimited(account, 60000, family);
        }
      }

      const result = manager.getCurrentOrNextForFamily(family);
      expect(result).toBeNull();
    });

    it("returns accounts again after rate limit expires", () => {
      const family: ModelFamily = "codex";

      const account = manager.getCurrentOrNextForFamily(family);
      expect(account).not.toBeNull();

      manager.markRateLimited(account!, -1000, family);

      const nextAccount = manager.getCurrentOrNextForFamily(family);
      expect(nextAccount).not.toBeNull();
    });

    it("hasRefreshToken returns true for existing tokens", () => {
      expect(manager.hasRefreshToken(TEST_ACCOUNTS[0]!.refresh_token)).toBe(true);
      expect(manager.hasRefreshToken(TEST_ACCOUNTS[5]!.refresh_token)).toBe(true);
    });

    it("hasRefreshToken returns false for non-existing tokens", () => {
      expect(manager.hasRefreshToken("non_existent_token")).toBe(false);
    });

    it("getMinWaitTimeForFamily returns correct wait time", () => {
      const family: ModelFamily = "codex";

      for (let i = 0; i < 10; i++) {
        const account = manager.getCurrentOrNextForFamily(family);
        if (account) {
          const waitTime = i === 5 ? 30000 : 60000;
          manager.markRateLimited(account, waitTime, family);
        }
      }

      const minWait = manager.getMinWaitTimeForFamily(family);
      expect(minWait).toBeGreaterThan(0);
      expect(minWait).toBeLessThanOrEqual(30000);
    });
  });

  describe("Email deduplication", () => {
    it("removes duplicate emails keeping the most recently used", () => {
      const result = deduplicateAccountsByEmail(DUPLICATE_EMAIL_ACCOUNTS);

      expect(result.length).toBe(3);

      const jorriAccount = result.find(a => a.email === "duplicate.a@example.com");
      expect(jorriAccount?.refresh_token).toBe("token_new");
      expect(jorriAccount?.lastUsed).toBe(2000);

      const keiyoonAccount = result.find(a => a.email === "duplicate.b@example.com");
      expect(keiyoonAccount?.refresh_token).toBe("token_new_2");
      expect(keiyoonAccount?.lastUsed).toBe(2500);

      const uniqueAccount = result.find(a => a.email === "unique@example.com");
      expect(uniqueAccount?.refresh_token).toBe("token_unique");
    });

    it("preserves accounts without email", () => {
      const accountsWithNoEmail = [
        { email: undefined, refresh_token: "token1", lastUsed: 1000 },
        { email: undefined, refresh_token: "token2", lastUsed: 2000 },
        { email: "test@example.com", refresh_token: "token3", lastUsed: 1500 },
      ];

      const result = deduplicateAccountsByEmail(accountsWithNoEmail as any);
      expect(result.length).toBe(3);
    });
  });

  describe("Refresh token deduplication", () => {
    it("removes accounts with duplicate refresh tokens", () => {
      const accountsWithDuplicateTokens = [
        { refreshToken: "token_a", lastUsed: 1000, addedAt: 100 },
        { refreshToken: "token_a", lastUsed: 2000, addedAt: 200 },
        { refreshToken: "token_b", lastUsed: 1500, addedAt: 150 },
      ];

      const result = deduplicateAccounts(accountsWithDuplicateTokens);
      expect(result.length).toBe(2);

      const tokenA = result.find(a => a.refreshToken === "token_a");
      expect(tokenA?.lastUsed).toBe(2000);
    });
  });

  describe("Storage mutex (file locking)", () => {
    it("concurrent saves complete without corruption", async () => {
      const storage = createStorageFromTestAccounts(TEST_ACCOUNTS.slice(0, 3));
      const manager = new AccountManager(undefined, storage);

      const saves = Array.from({ length: 10 }, () => manager.saveToDisk());
      await Promise.all(saves);
    });
  });

  describe("Debounced save", () => {
    it("saveToDiskDebounced does not throw", async () => {
      const storage = createStorageFromTestAccounts(TEST_ACCOUNTS.slice(0, 3));
      const manager = new AccountManager(undefined, storage);

      expect(() => manager.saveToDiskDebounced()).not.toThrow();
      expect(() => manager.saveToDiskDebounced(100)).not.toThrow();

      // Flush the pending debounced write while TEST_STORAGE_PATH is still
      // active. Without this, the 100ms timer resolves after afterAll() resets
      // the storage path to null and the save lands in the real user store.
      await manager.flushPendingSave();
      manager.disposeShutdownHandler();
    });

    it("flushPendingSave completes pending save", async () => {
      const storage = createStorageFromTestAccounts(TEST_ACCOUNTS.slice(0, 3));
      const manager = new AccountManager(undefined, storage);

      manager.saveToDiskDebounced(1000);
      await manager.flushPendingSave();
      manager.disposeShutdownHandler();
    });
  });

  describe("Per-family rate limiting", () => {
    it("rate limiting one family does not affect another", () => {
      const storage = createStorageFromTestAccounts(TEST_ACCOUNTS.slice(0, 5));
      const manager = new AccountManager(undefined, storage);

      const codexAccounts: number[] = [];
      for (let i = 0; i < 5; i++) {
        const acc = manager.getCurrentOrNextForFamily("codex");
        if (acc) {
          codexAccounts.push(acc.index);
          manager.markRateLimited(acc, 60000, "codex");
        }
      }

      expect(manager.getCurrentOrNextForFamily("codex")).toBeNull();

      const gpt51Account = manager.getCurrentOrNextForFamily("gpt-5.1");
      expect(gpt51Account).not.toBeNull();
      expect(gpt51Account?.index).toBe(0);
    });

    it("model-specific rate limits are independent from family-level limits", () => {
      const storage = createStorageFromTestAccounts(TEST_ACCOUNTS.slice(0, 3));
      const manager = new AccountManager(undefined, storage);

      const account = manager.getCurrentOrNextForFamily("codex");
      expect(account).not.toBeNull();

      manager.markRateLimited(account!, 60000, "codex", "specific-model");

      const nextWithDifferentModel = manager.getCurrentOrNextForFamily("codex", "different-model");
      expect(nextWithDifferentModel).not.toBeNull();
    });
  });

  describe("Account toast deduplication", () => {
    it("shouldShowAccountToast returns true for new account switch", () => {
      const storage = createStorageFromTestAccounts(TEST_ACCOUNTS.slice(0, 5));
      const manager = new AccountManager(undefined, storage);

      const account = manager.getCurrentOrNextForFamily("codex");
      expect(manager.shouldShowAccountToast(account!, 60000)).toBe(true);
    });

    it("shouldShowAccountToast returns false within debounce window", () => {
      const storage = createStorageFromTestAccounts(TEST_ACCOUNTS.slice(0, 5));
      const manager = new AccountManager(undefined, storage);

      const account = manager.getCurrentOrNextForFamily("codex");
      manager.markToastShown(account!);

      expect(manager.shouldShowAccountToast(account!, 60000)).toBe(false);
    });
  });
});

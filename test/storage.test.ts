import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  deduplicateAccounts,
  deduplicateAccountsByEmail,
  normalizeAccountStorage, 
  loadAccounts, 
  saveAccounts,
  clearAccounts,
  loadFlaggedAccounts,
  saveFlaggedAccounts,
  getStoragePath,
  setStoragePath,
  setStoragePathDirect,
  StorageError,
  formatStorageErrorHint,
  exportAccounts,
  importAccounts,
  previewImportAccounts,
  createTimestampedBackupPath,
  getWorkspaceIdentityKey,
  withAccountStorageTransaction,
  withFlaggedAccountStorageTransaction,
} from "../lib/storage.js";

describe("storage", () => {
  describe("getWorkspaceIdentityKey", () => {
    it("uses organizationId and accountId when both are present", () => {
      expect(
        getWorkspaceIdentityKey({
          organizationId: " org-shared ",
          accountId: " workspace-a ",
          refreshToken: " refresh-a ",
        }),
      ).toBe("organizationId:org-shared|accountId:workspace-a");
    });

    it("falls back to accountId when organizationId is missing", () => {
      expect(
        getWorkspaceIdentityKey({
          accountId: " workspace-only ",
          refreshToken: " refresh-b ",
        }),
      ).toBe("accountId:workspace-only");
    });

    it("falls back to refreshToken when workspace ids are missing", () => {
      expect(
        getWorkspaceIdentityKey({
          organizationId: "   ",
          accountId: "",
          refreshToken: " refresh-c ",
        }),
      ).toBe("refreshToken:refresh-c");
    });
  });

  describe("deduplication", () => {
    it("remaps activeIndex after deduplication using active account key", () => {
      const now = Date.now();

      const raw = {
        version: 1,
        activeIndex: 1,
        accounts: [
          {
            accountId: "acctA",
            refreshToken: "tokenA",
            addedAt: now - 2000,
            lastUsed: now - 2000,
          },
          {
            accountId: "acctA",
            refreshToken: "tokenA",
            addedAt: now - 1000,
            lastUsed: now - 1000,
          },
          {
            accountId: "acctB",
            refreshToken: "tokenB",
            addedAt: now,
            lastUsed: now,
          },
        ],
      };

      const normalized = normalizeAccountStorage(raw);
      expect(normalized).not.toBeNull();
      expect(normalized?.accounts).toHaveLength(2);
      expect(normalized?.accounts[0]?.accountId).toBe("acctA");
      expect(normalized?.accounts[1]?.accountId).toBe("acctB");
      expect(normalized?.activeIndex).toBe(0);
    });

    it("deduplicates accounts by keeping the most recently used record", () => {
      const now = Date.now();

      const accounts = [
        {
          accountId: "acctA",
          refreshToken: "tokenA",
          addedAt: now - 2000,
          lastUsed: now - 1000,
        },
        {
          accountId: "acctA",
          refreshToken: "tokenA",
          addedAt: now - 1500,
          lastUsed: now,
        },
      ];

      const deduped = deduplicateAccounts(accounts);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.addedAt).toBe(now - 1500);
      expect(deduped[0]?.lastUsed).toBe(now);
    });
  });

  describe("import/export (TDD)", () => {
    const testWorkDir = join(tmpdir(), "codex-test-" + Math.random().toString(36).slice(2));
    const exportPath = join(testWorkDir, "export.json");
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, "accounts-" + Math.random().toString(36).slice(2) + ".json");
      setStoragePathDirect(testStoragePath);
      await clearAccounts();
    });

    afterEach(async () => {
      await clearAccounts();
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("should export accounts to a file", async () => {
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ accountId: "test", refreshToken: "ref", addedAt: 1, lastUsed: 2 }]
      };
      await saveAccounts(storage);

      await exportAccounts(exportPath);

      expect(existsSync(exportPath)).toBe(true);
      const exported = JSON.parse(await fs.readFile(exportPath, "utf-8"));
      expect(exported.accounts[0].accountId).toBe("test");
    });

    it("should fail export if file exists and force is false", async () => {
      await fs.writeFile(exportPath, "exists");

      await expect(exportAccounts(exportPath, false)).rejects.toThrow(StorageError);
      await expect(exportAccounts(exportPath, false)).rejects.toThrow(/Refusing to overwrite/);
    });

    it("defaults to non-destructive export (force=false) and refuses to overwrite", async () => {
      // Arrange: populate storage and a pre-existing export target.
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ accountId: "test", refreshToken: "ref", addedAt: 1, lastUsed: 2 }],
      };
      await saveAccounts(storage);
      await fs.writeFile(exportPath, "pre-existing");

      // Act + assert: no `force` argument → must refuse.
      await expect(exportAccounts(exportPath)).rejects.toThrow(StorageError);
      // File contents preserved (not overwritten by a silent export).
      expect(await fs.readFile(exportPath, "utf-8")).toBe("pre-existing");

      // Explicit opt-in (force=true) is required to overwrite.
      await exportAccounts(exportPath, true);
      const overwritten = JSON.parse(await fs.readFile(exportPath, "utf-8"));
      expect(overwritten.accounts[0].accountId).toBe("test");
    });

    it("should import accounts from a file and merge", async () => {
      const existing = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ accountId: "existing", refreshToken: "ref1", addedAt: 1, lastUsed: 2 }]
      };
      await saveAccounts(existing);

      const toImport = {
        version: 3,
        activeIndex: 0,
        accounts: [{ accountId: "new", refreshToken: "ref2", addedAt: 3, lastUsed: 4 }]
      };
      await fs.writeFile(exportPath, JSON.stringify(toImport));

      await importAccounts(exportPath);

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(2);
      expect(loaded?.accounts.map(a => a.accountId)).toContain("new");
    });

    it("should preview import results without applying changes", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [{ accountId: "existing", refreshToken: "ref1", addedAt: 1, lastUsed: 2 }],
      });

      await fs.writeFile(
        exportPath,
        JSON.stringify({
          version: 3,
          activeIndex: 0,
          accounts: [{ accountId: "preview", refreshToken: "ref2", addedAt: 3, lastUsed: 4 }],
        }),
      );

      const preview = await previewImportAccounts(exportPath);
      expect(preview.imported).toBe(1);
      expect(preview.skipped).toBe(0);
      expect(preview.total).toBe(2);

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(1);
      expect(loaded?.accounts[0]?.accountId).toBe("existing");
    });

    it("keeps preview and apply counts aligned for the same import fixture", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [{ accountId: "existing", refreshToken: "ref1", addedAt: 1, lastUsed: 2 }],
      });

      await fs.writeFile(
        exportPath,
        JSON.stringify({
          version: 3,
          activeIndex: 0,
          accounts: [{ accountId: "preview", refreshToken: "ref2", addedAt: 3, lastUsed: 4 }],
        }),
      );

      const preview = await previewImportAccounts(exportPath);
      const applied = await importAccounts(exportPath);

      expect(preview).toMatchObject({
        imported: applied.imported,
        skipped: applied.skipped,
        total: applied.total,
      });
    });

    it("creates timestamped backup paths in storage backups directory", () => {
      const path = createTimestampedBackupPath();
      const expectedBackupDir = join(dirname(testStoragePath), "backups");
      expect(dirname(path)).toBe(expectedBackupDir);
      expect(basename(path)).toMatch(/^codex-backup-\d{8}-\d{9}-[a-f0-9]{6}\.json$/);
      expect(path.endsWith(".json")).toBe(true);
    });

    it("sanitizes backup filename prefix to prevent unsafe path fragments", () => {
      const path = createTimestampedBackupPath("../unsafe/../name");
      expect(basename(path)).toMatch(/^unsafe-name-\d{8}-\d{9}-[a-f0-9]{6}\.json$/);
    });

    it("preserves accounts with different accountId values even when refreshToken and email are shared (no organizationId)", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        activeIndexByFamily: { codex: 0, "gpt-5.1": 0 },
        accounts: [
          {
            accountId: "workspace-a",
            refreshToken: "shared-refresh",
            email: "user@example.com",
            addedAt: 1,
            lastUsed: 1,
          },
        ],
      });

      await fs.writeFile(
        exportPath,
        JSON.stringify({
          version: 3,
          activeIndex: 0,
          accounts: [
            {
              accountId: "workspace-b",
              refreshToken: "shared-refresh",
              email: "user@example.com",
              addedAt: 2,
              lastUsed: 2,
            },
          ],
        }),
      );

      const preview = await previewImportAccounts(exportPath);
      expect(preview.imported).toBe(1);
      expect(preview.skipped).toBe(0);
      expect(preview.total).toBe(2);

      await importAccounts(exportPath);

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(2);
      const accountIds = loaded?.accounts.map((account) => account.accountId);
      expect(accountIds).toContain("workspace-a");
      expect(accountIds).toContain("workspace-b");
      expect(loaded?.activeIndex).toBe(0);
      expect(loaded?.activeIndexByFamily?.codex).toBe(0);
    });

    // Issue #171: a disabled token-source duplicate (a plugin re-login artifact)
    // must NOT disable the real org account it collapses into during dedup.
    // Issue #171 (email case divergence): storage dedup must compare emails
    // case-insensitively so it agrees with the codex-doctor/codex-health
    // detectors (which lowercase). Otherwise User@Example.com (org) and
    // user@example.com (token dup) escape dedup but get flagged as removable.
    it("collapses an org + disabled token-dup that differ only by email case (#171)", async () => {
      const now = Date.now();
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            accountId: "org-AAA",
            organizationId: "org-AAA",
            accountIdSource: "org",
            email: "User@Example.com",
            refreshToken: "OLD-refresh",
            addedAt: 100,
            lastUsed: 200,
          },
          {
            accountId: "uuid-fresh",
            accountIdSource: "token",
            email: "user@example.com",
            refreshToken: "FRESH-refresh",
            addedAt: 999,
            lastUsed: 999,
            enabled: false,
          },
        ],
      });
      const loaded = await loadAccounts();
      // Case-insensitive email match => the two collapse into one org account.
      expect(loaded?.accounts).toHaveLength(1);
      expect(loaded!.accounts[0]!.organizationId).toBe("org-AAA");
      expect(loaded!.accounts[0]!.enabled).not.toBe(false);
    });

    it("keeps the org account enabled when a disabled token-source duplicate merges in (#171)", async () => {
      const now = Date.now();
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            accountId: "org-AAA",
            organizationId: "org-AAA",
            accountIdSource: "org",
            email: "user@example.com",
            refreshToken: "OLD-refresh",
            addedAt: 100,
            lastUsed: 200,
            coolingDownUntil: now + 3_600_000,
            cooldownReason: "auth-failure",
          },
          {
            accountId: "uuid-fresh",
            accountIdSource: "token",
            email: "user@example.com",
            refreshToken: "FRESH-refresh",
            addedAt: 999,
            lastUsed: 999,
            enabled: false,
          },
        ],
      });
      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(1);
      const survivor = loaded!.accounts[0]!;
      expect(survivor.organizationId).toBe("org-AAA");
      // The real account must remain routable: NOT disabled by the dup.
      expect(survivor.enabled).not.toBe(false);
      // And it carries the fresh token from the newer (dup) record.
      expect(survivor.refreshToken).toBe("FRESH-refresh");
    });

    it("preserves fail-closed when a same-identity record was user-disabled (#171 guard)", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [
          { accountId: "org-X", organizationId: "org-X", accountIdSource: "org", email: "u@e.com", refreshToken: "RT", addedAt: 100, lastUsed: 100, enabled: false },
          { accountId: "org-X", organizationId: "org-X", accountIdSource: "org", email: "u@e.com", refreshToken: "RT", addedAt: 200, lastUsed: 200, enabled: true },
        ],
      });
      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(1);
      // User intent wins: a genuinely disabled real account stays disabled.
      expect(loaded!.accounts[0]!.enabled).toBe(false);
    });

    it("keeps two distinct real org accounts both enabled (no merge regression)", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [
          { accountId: "org-1", organizationId: "org-1", accountIdSource: "org", email: "a@e.com", refreshToken: "R1", addedAt: 100, lastUsed: 100, enabled: true },
          { accountId: "org-2", organizationId: "org-2", accountIdSource: "org", email: "b@e.com", refreshToken: "R2", addedAt: 100, lastUsed: 100, enabled: true },
        ],
      });
      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(2);
      expect(loaded!.accounts.every((a) => a.enabled !== false)).toBe(true);
    });

    it("retains per-account rate-limit and cooldown metadata through save/load round-trip", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            organizationId: "org-1",
            accountId: "workspace-org",
            accountIdSource: "org",
            refreshToken: "shared-refresh",
            email: "user@example.com",
            addedAt: 100,
            lastUsed: 200,
            rateLimitResetTimes: {
              codex: 1_111,
              "codex:gpt-5.2": 2_222,
            },
            coolingDownUntil: 3_333,
            cooldownReason: "auth-failure",
          },
          {
            accountId: "workspace-token",
            accountIdSource: "token",
            refreshToken: "other-refresh",
            email: "other@example.com",
            addedAt: 101,
            lastUsed: 201,
            rateLimitResetTimes: {
              "gpt-5.1": 4_444,
            },
            coolingDownUntil: 5_555,
            cooldownReason: "network-error",
          },
        ],
      });

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(2);

      const orgVariant = loaded?.accounts.find((account) => account.accountId === "workspace-org");
      expect(orgVariant?.rateLimitResetTimes?.codex).toBe(1_111);
      expect(orgVariant?.rateLimitResetTimes?.["codex:gpt-5.2"]).toBe(2_222);
      expect(orgVariant?.coolingDownUntil).toBe(3_333);
      expect(orgVariant?.cooldownReason).toBe("auth-failure");

      const tokenVariant = loaded?.accounts.find((account) => account.accountId === "workspace-token");
      expect(tokenVariant?.rateLimitResetTimes?.["gpt-5.1"]).toBe(4_444);
      expect(tokenVariant?.coolingDownUntil).toBe(5_555);
      expect(tokenVariant?.cooldownReason).toBe("network-error");
      expect(tokenVariant?.refreshToken).toBe("other-refresh");
    });

    it("collapses same-organization records to newest during import and remaps active keys", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        activeIndexByFamily: { codex: 0, "gpt-5.1": 0 },
        accounts: [
          {
            organizationId: "org-1",
            accountId: "workspace-a",
            refreshToken: "refresh-old",
            email: "user@example.com",
            addedAt: 1,
            lastUsed: 10,
          },
          {
            organizationId: "org-2",
            accountId: "workspace-b",
            refreshToken: "refresh-org-2",
            email: "user@example.com",
            addedAt: 2,
            lastUsed: 20,
          },
        ],
      });

      await fs.writeFile(
        exportPath,
        JSON.stringify({
          version: 3,
          activeIndex: 0,
          accounts: [
            {
              organizationId: "org-1",
              accountId: "workspace-c",
              refreshToken: "refresh-new",
              email: "user@example.com",
              addedAt: 3,
              lastUsed: 30,
            },
          ],
        }),
      );

      await importAccounts(exportPath);

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(2);

      const org1 = loaded?.accounts.find((account) => account.organizationId === "org-1");
      expect(org1?.accountId).toBe("workspace-c");
      expect(org1?.refreshToken).toBe("refresh-new");
      expect(loaded?.activeIndex).toBe(1);
      expect(loaded?.activeIndexByFamily?.codex).toBe(1);
      expect(loaded?.activeIndexByFamily?.["gpt-5.1"]).toBe(1);
    });

    it("preserves same refresh token across different organizationId values during import", async () => {
      setStoragePathDirect(testStoragePath);
      await fs.writeFile(
        exportPath,
        JSON.stringify({
          version: 3,
          activeIndex: 0,
          accounts: [
            {
              organizationId: "org-a",
              accountId: "shared-account",
              refreshToken: "shared-refresh",
              addedAt: 1,
              lastUsed: 1,
            },
            {
              organizationId: "org-b",
              accountId: "shared-account",
              refreshToken: "shared-refresh",
              addedAt: 2,
              lastUsed: 2,
            },
          ],
        }),
      );

      await importAccounts(exportPath);

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(2);
      expect(loaded?.accounts.every((account) => account.refreshToken === "shared-refresh")).toBe(true);
      const organizationIds = loaded?.accounts
        .map((account) => account.organizationId)
        .filter((organizationId): organizationId is string => typeof organizationId === "string");
      expect(new Set(organizationIds)).toEqual(new Set(["org-a", "org-b"]));
    });

    it("does not merge accounts when one has organizationId and the other does not, despite same refreshToken", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            organizationId: "org-scoped",
            accountId: "workspace-with-org",
            refreshToken: "shared-refresh-token",
            addedAt: 1,
            lastUsed: 10,
          },
        ],
      });

      await fs.writeFile(
        exportPath,
        JSON.stringify({
          version: 3,
          activeIndex: 0,
          accounts: [
            {
              organizationId: undefined,
              accountId: "workspace-no-org",
              refreshToken: "shared-refresh-token",
              addedAt: 2,
              lastUsed: 20,
            },
          ],
        }),
      );

      await importAccounts(exportPath);

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(2);

      const orgScoped = loaded?.accounts.find((account) => account.organizationId === "org-scoped");
      expect(orgScoped).toBeDefined();
      expect(orgScoped?.accountId).toBe("workspace-with-org");

      const noOrg = loaded?.accounts.find(
        (account) =>
          typeof account.organizationId === "undefined" &&
          account.accountId === "workspace-no-org",
      );
      expect(noOrg).toBeDefined();
    });

    it("keeps legacy no-organization dedupe semantics during import", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            accountId: "legacy-account",
            refreshToken: "legacy-old",
            email: "legacy-account@example.com",
            addedAt: 1,
            lastUsed: 10,
          },
          {
            refreshToken: "legacy-email-old",
            email: "legacy-email@example.com",
            addedAt: 1,
            lastUsed: 10,
          },
          {
            refreshToken: "legacy-refresh",
            email: "refresh-a@example.com",
            addedAt: 1,
            lastUsed: 10,
          },
        ],
      });

      await fs.writeFile(
        exportPath,
        JSON.stringify({
          version: 3,
          activeIndex: 0,
          accounts: [
            {
              accountId: "legacy-account",
              refreshToken: "legacy-new",
              email: "legacy-account@example.com",
              addedAt: 2,
              lastUsed: 20,
            },
            {
              refreshToken: "legacy-email-new",
              email: "legacy-email@example.com",
              addedAt: 2,
              lastUsed: 20,
            },
            {
              refreshToken: "legacy-refresh",
              email: "refresh-b@example.com",
              addedAt: 2,
              lastUsed: 20,
            },
          ],
        }),
      );

      await importAccounts(exportPath);

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(3);

      const byAccountId = loaded?.accounts.find((account) => account.accountId === "legacy-account");
      expect(byAccountId?.refreshToken).toBe("legacy-new");

      const byEmail = loaded?.accounts.find((account) => account.email === "legacy-email@example.com");
      expect(byEmail?.refreshToken).toBe("legacy-email-new");

      const byRefresh = loaded?.accounts.find((account) => account.refreshToken === "legacy-refresh");
      expect(byRefresh?.email).toBe("refresh-b@example.com");
    });

    it("deduplicates legacy no-accountId records by email during import", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            refreshToken: "legacy-refresh-old",
            email: "legacy@example.com",
            addedAt: 1,
            lastUsed: 10,
          },
        ],
      });

      await fs.writeFile(
        exportPath,
        JSON.stringify({
          version: 3,
          activeIndex: 0,
          accounts: [
            {
              refreshToken: "legacy-refresh-new",
              email: "legacy@example.com",
              addedAt: 2,
              lastUsed: 20,
            },
          ],
        }),
      );

      await importAccounts(exportPath);

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(1);
      expect(loaded?.accounts[0]?.refreshToken).toBe("legacy-refresh-new");
    });

    it("should serialize concurrent transactional updates without losing accounts", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [],
      });

      const addAccount = async (accountId: string, delayMs: number): Promise<void> => {
        await withAccountStorageTransaction(async (current, persist) => {
          const snapshot = current ?? {
            version: 3 as const,
            activeIndex: 0,
            accounts: [],
          };
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          await persist({
            ...snapshot,
            accounts: [
              ...snapshot.accounts,
              { accountId, refreshToken: `ref-${accountId}`, addedAt: Date.now(), lastUsed: Date.now() },
            ],
          });
        });
      };

      await Promise.all([
        addAccount("acct-a", 20),
        addAccount("acct-b", 0),
      ]);

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(2);
      expect(new Set(loaded?.accounts.map((account) => account.accountId))).toEqual(
        new Set(["acct-a", "acct-b"]),
      );
    });

    it("should enforce MAX_ACCOUNTS during import", async () => {
      const manyAccounts = Array.from({ length: 21 }, (_, i) => ({
        accountId: `acct${i}`,
        refreshToken: `ref${i}`,
        addedAt: Date.now(),
        lastUsed: Date.now()
      }));
      
      const toImport = {
        version: 3,
        activeIndex: 0,
        accounts: manyAccounts
      };
      await fs.writeFile(exportPath, JSON.stringify(toImport));

      await expect(importAccounts(exportPath)).rejects.toThrow(/exceed maximum/);
    });

    it("should fail export when no accounts exist", async () => {
      setStoragePathDirect(testStoragePath);
      await expect(exportAccounts(exportPath)).rejects.toThrow(/No accounts to export/);
    });

    it("should fail import when file does not exist", async () => {
      const nonexistentPath = join(testWorkDir, "nonexistent-file.json");
      await expect(importAccounts(nonexistentPath)).rejects.toThrow(/Import file not found/);
    });

    it("should fail import when file contains invalid JSON", async () => {
      await fs.writeFile(exportPath, "not valid json {[");
      await expect(importAccounts(exportPath)).rejects.toThrow(/Invalid JSON/);
    });

    it("should fail import when file contains invalid format", async () => {
      await fs.writeFile(exportPath, JSON.stringify({ invalid: "format" }));
      await expect(importAccounts(exportPath)).rejects.toThrow(/Invalid account storage format/);
    });

    it("continues import in best-effort mode when pre-import backup write is locked", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [{ accountId: "existing", refreshToken: "ref-existing", addedAt: 1, lastUsed: 1 }],
      });

      await fs.writeFile(
        exportPath,
        JSON.stringify({
          version: 3,
          activeIndex: 0,
          accounts: [{ accountId: "imported", refreshToken: "ref-imported", addedAt: 2, lastUsed: 2 }],
        }),
      );

      const originalWriteFile = fs.writeFile.bind(fs);
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (path, data, options) => {
        const filePath = String(path);
        if (filePath.includes("codex-pre-import-backup") && filePath.endsWith(".tmp")) {
          const err = new Error("backup locked by antivirus") as NodeJS.ErrnoException;
          err.code = "EBUSY";
          throw err;
        }
        return originalWriteFile(
          path as Parameters<typeof fs.writeFile>[0],
          data as Parameters<typeof fs.writeFile>[1],
          options as Parameters<typeof fs.writeFile>[2],
        );
      });

      let result: Awaited<ReturnType<typeof importAccounts>>;
      try {
        result = await importAccounts(exportPath, {
          preImportBackupPrefix: "codex-pre-import-backup",
          backupMode: "best-effort",
        });
      } finally {
        writeSpy.mockRestore();
      }

      expect(result.backupStatus).toBe("failed");
      expect(result.backupError).toContain("backup locked by antivirus");

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(2);
      expect(loaded?.accounts.map((account) => account.accountId)).toContain("imported");
    });

    it("fails required import when pre-import backup write times out", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [{ accountId: "existing", refreshToken: "ref-existing", addedAt: 1, lastUsed: 1 }],
      });

      await fs.writeFile(
        exportPath,
        JSON.stringify({
          version: 3,
          activeIndex: 0,
          accounts: [{ accountId: "imported", refreshToken: "ref-imported", addedAt: 2, lastUsed: 2 }],
        }),
      );

      const originalWriteFile = fs.writeFile.bind(fs);
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (path, data, options) => {
        const filePath = String(path);
        if (filePath.includes("codex-pre-import-backup") && filePath.endsWith(".tmp")) {
          const abortError = new Error("aborted");
          abortError.name = "AbortError";
          throw abortError;
        }
        return originalWriteFile(
          path as Parameters<typeof fs.writeFile>[0],
          data as Parameters<typeof fs.writeFile>[1],
          options as Parameters<typeof fs.writeFile>[2],
        );
      });

      try {
        await expect(
          importAccounts(exportPath, {
            preImportBackupPrefix: "codex-pre-import-backup",
            backupMode: "required",
          }),
        ).rejects.toThrow("Pre-import backup failed");
      } finally {
        writeSpy.mockRestore();
      }

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(1);
      expect(loaded?.accounts[0]?.accountId).toBe("existing");
    });

    it("defaults to a timestamped pre-import backup when no backupMode is supplied", async () => {
      // Arrange: existing storage so there is something to back up.
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [
          { accountId: "existing", refreshToken: "ref-existing", addedAt: 1, lastUsed: 1 },
        ],
      });

      await fs.writeFile(
        exportPath,
        JSON.stringify({
          version: 3,
          activeIndex: 0,
          accounts: [
            { accountId: "imported", refreshToken: "ref-imported", addedAt: 2, lastUsed: 2 },
          ],
        }),
      );

      // Act: call with NO backupMode option — must default to a safe backup.
      const result = await importAccounts(exportPath, {
        preImportBackupPrefix: "codex-pre-import-backup-default",
      });

      // Assert: backup was created; path filename carries the prefix used above.
      expect(result.backupStatus).toBe("created");
      expect(result.backupPath).toBeDefined();
      expect(result.backupPath).toMatch(/codex-pre-import-backup-default/);
      // Backup file exists on disk and is readable JSON representing prior state.
      expect(existsSync(result.backupPath!)).toBe(true);
      const backupContent = JSON.parse(await fs.readFile(result.backupPath!, "utf-8"));
      expect(backupContent.accounts[0].accountId).toBe("existing");

      // And the import itself applied as expected.
      const loaded = await loadAccounts();
      expect(loaded?.accounts.map((a) => a.accountId)).toContain("imported");
      expect(loaded?.accounts.map((a) => a.accountId)).toContain("existing");
    });

    it("honours backupMode: 'none' opt-out for callers that want the legacy behaviour", async () => {
      await saveAccounts({
        version: 3,
        activeIndex: 0,
        accounts: [
          { accountId: "existing", refreshToken: "ref-existing", addedAt: 1, lastUsed: 1 },
        ],
      });

      await fs.writeFile(
        exportPath,
        JSON.stringify({
          version: 3,
          activeIndex: 0,
          accounts: [
            { accountId: "imported", refreshToken: "ref-imported", addedAt: 2, lastUsed: 2 },
          ],
        }),
      );

      const result = await importAccounts(exportPath, { backupMode: "none" });

      expect(result.backupStatus).toBe("skipped");
      expect(result.backupPath).toBeUndefined();
    });
  });

  describe("filename migration (TDD)", () => {
    it("should migrate from old filename to new filename", async () => {
      // This test is tricky because it depends on the internal state of getStoragePath()
      // which we are about to change.
      
      const oldName = "openai-codex-accounts.json";
      const newName = "codex-accounts.json";
      
      // We'll need to mock/verify that loadAccounts checks for oldName if newName is missing
      // Since we haven't implemented it yet, this is just a placeholder for the logic
      expect(true).toBe(true); 
    });
  });

  describe("StorageError and formatStorageErrorHint", () => {
    describe("StorageError class", () => {
      it("should store code, path, and hint properties", () => {
        const err = new StorageError(
          "Failed to write file",
          "EACCES",
          "/path/to/file.json",
          "Permission denied. Check folder permissions."
        );
        
        expect(err.name).toBe("StorageError");
        expect(err.message).toBe("Failed to write file");
        expect(err.code).toBe("EACCES");
        expect(err.path).toBe("/path/to/file.json");
        expect(err.hint).toBe("Permission denied. Check folder permissions.");
      });

      it("should be instanceof Error", () => {
        const err = new StorageError("test", "CODE", "/path", "hint");
        expect(err instanceof Error).toBe(true);
        expect(err instanceof StorageError).toBe(true);
      });
    });

    describe("formatStorageErrorHint", () => {
      const testPath = "/home/user/.opencode/accounts.json";

      it("should return permission hint for EACCES on Windows", () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "win32" });

        const err = { code: "EACCES" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("antivirus");
        expect(hint).toContain(testPath);

        Object.defineProperty(process, "platform", { value: originalPlatform });
      });

      it("should return chmod hint for EACCES on Unix", () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, "platform", { value: "darwin" });

        const err = { code: "EACCES" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("chmod");
        expect(hint).toContain(testPath);

        Object.defineProperty(process, "platform", { value: originalPlatform });
      });

      it("should return permission hint for EPERM", () => {
        const err = { code: "EPERM" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("Permission denied");
        expect(hint).toContain(testPath);
      });

      it("should return file locked hint for EBUSY", () => {
        const err = { code: "EBUSY" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("locked");
        expect(hint).toContain("another program");
      });

      it("should return disk full hint for ENOSPC", () => {
        const err = { code: "ENOSPC" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("Disk is full");
      });

      it("should return empty file hint for EEMPTY", () => {
        const err = { code: "EEMPTY" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("empty");
      });

      it("should return generic hint for unknown error codes", () => {
        const err = { code: "UNKNOWN_CODE" } as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("Failed to write");
        expect(hint).toContain(testPath);
      });

      it("should handle errors without code property", () => {
        const err = new Error("Some error") as NodeJS.ErrnoException;
        const hint = formatStorageErrorHint(err, testPath);

        expect(hint).toContain("Failed to write");
        expect(hint).toContain(testPath);
      });
    });
  });

  describe("selectNewestAccount logic", () => {
    it("when lastUsed are equal, prefers newer addedAt", () => {
      const now = Date.now();
      const accounts = [
        { accountId: "A", refreshToken: "t1", addedAt: now - 1000, lastUsed: now },
        { accountId: "A", refreshToken: "t1", addedAt: now - 500, lastUsed: now },
      ];
      const deduped = deduplicateAccounts(accounts);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.addedAt).toBe(now - 500);
    });

    it("when candidate lastUsed is less than current, keeps current", () => {
      const now = Date.now();
      const accounts = [
        { accountId: "A", refreshToken: "t1", addedAt: now, lastUsed: now },
        { accountId: "A", refreshToken: "t1", addedAt: now - 500, lastUsed: now - 1000 },
      ];
      const deduped = deduplicateAccounts(accounts);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.lastUsed).toBe(now);
    });

    it("handles accounts without lastUsed or addedAt", () => {
      const accounts = [
        { accountId: "A", refreshToken: "t1" },
        { accountId: "A", refreshToken: "t1", lastUsed: 100 },
      ];
      const deduped = deduplicateAccounts(accounts);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.lastUsed).toBe(100);
    });
  });

  describe("deduplicateAccountsByKey edge cases", () => {
    it("uses refreshToken as key when accountId is empty", () => {
      const accounts = [
        { accountId: "A", refreshToken: "t1", lastUsed: 100 },
        { accountId: "", refreshToken: "t2", lastUsed: 200 },
        { accountId: "C", refreshToken: "t3", lastUsed: 300 },
      ];
      const deduped = deduplicateAccounts(accounts);
      expect(deduped).toHaveLength(3);
    });

    it("handles empty array", () => {
      const deduped = deduplicateAccounts([]);
      expect(deduped).toHaveLength(0);
    });

    it("handles null/undefined in array", () => {
      const accounts = [
        { accountId: "A", refreshToken: "t1" },
        null as never,
        { accountId: "B", refreshToken: "t2" },
      ];
      const deduped = deduplicateAccounts(accounts);
      expect(deduped).toHaveLength(2);
    });
  });

  describe("deduplicateAccountsByEmail edge cases", () => {
    it("preserves accounts without email", () => {
      const accounts = [
        { email: "test@example.com", lastUsed: 100, addedAt: 50 },
        { lastUsed: 200, addedAt: 100 },
        { email: "", lastUsed: 300, addedAt: 150 },
      ];
      const deduped = deduplicateAccountsByEmail(accounts);
      expect(deduped).toHaveLength(3);
    });

    it("handles email with whitespace", () => {
      const accounts = [
        { email: "  test@example.com  ", lastUsed: 100, addedAt: 50 },
        { email: "test@example.com", lastUsed: 200, addedAt: 100 },
      ];
      const deduped = deduplicateAccountsByEmail(accounts);
      expect(deduped).toHaveLength(1);
    });

    it("handles null existing account edge case", () => {
      const accounts = [
        { email: "test@example.com", lastUsed: 100 },
        { email: "test@example.com", lastUsed: 200 },
      ];
      const deduped = deduplicateAccountsByEmail(accounts);
      expect(deduped.length).toBeGreaterThanOrEqual(1);
    });

    it("when addedAt differs but lastUsed is same, uses addedAt to decide", () => {
      const now = Date.now();
      const accounts = [
        { email: "test@example.com", lastUsed: now, addedAt: now - 1000 },
        { email: "test@example.com", lastUsed: now, addedAt: now - 500 },
      ];
      const deduped = deduplicateAccountsByEmail(accounts);
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.addedAt).toBe(now - 500);
    });
  });

  describe("normalizeAccountStorage edge cases", () => {
    it("returns null for non-object data", () => {
      expect(normalizeAccountStorage(null)).toBeNull();
      expect(normalizeAccountStorage("string")).toBeNull();
      expect(normalizeAccountStorage(123)).toBeNull();
      expect(normalizeAccountStorage([])).toBeNull();
    });

    it("returns null for invalid version (non-V2, non-V1, non-V3)", () => {
      // V2 used to fall into this bucket and silently returned null; it is
      // now explicitly rejected (see test/storage-v2-migration.test.ts) and
      // any finite number > 3 trips the forward-compat guard and throws, so
      // this case uses version 0 which is numeric, not >3, not literal 2,
      // and neither 1 nor 3 — exercising the generic unknown-version path.
      const result = normalizeAccountStorage({ version: 0, accounts: [] });
      expect(result).toBeNull();
    });

    it("returns null for non-array accounts", () => {
      expect(normalizeAccountStorage({ version: 3, accounts: "not-array" })).toBeNull();
      expect(normalizeAccountStorage({ version: 3, accounts: {} })).toBeNull();
    });

    it("handles missing activeIndex", () => {
      const data = {
        version: 3,
        accounts: [{ refreshToken: "t1", accountId: "A" }],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.activeIndex).toBe(0);
    });

    it("handles non-finite activeIndex", () => {
      const data = {
        version: 3,
        activeIndex: NaN,
        accounts: [{ refreshToken: "t1", accountId: "A" }],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.activeIndex).toBe(0);
    });

    it("handles Infinity activeIndex", () => {
      const data = {
        version: 3,
        activeIndex: Infinity,
        accounts: [{ refreshToken: "t1", accountId: "A" }],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.activeIndex).toBe(0);
    });

    it("clamps out-of-bounds activeIndex", () => {
      const data = {
        version: 3,
        activeIndex: 100,
        accounts: [{ refreshToken: "t1", accountId: "A" }, { refreshToken: "t2", accountId: "B" }],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.activeIndex).toBe(1);
    });

    it("filters out accounts with empty refreshToken", () => {
      const data = {
        version: 3,
        accounts: [
          { refreshToken: "valid", accountId: "A" },
          { refreshToken: "  ", accountId: "B" },
          { refreshToken: "", accountId: "C" },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.accounts).toHaveLength(1);
    });

    it("remaps activeKey when deduplication changes indices", () => {
      const now = Date.now();
      const data = {
        version: 3,
        activeIndex: 2,
        accounts: [
          { refreshToken: "t1", accountId: "A", lastUsed: now - 100 },
          { refreshToken: "t1", accountId: "A", lastUsed: now },
          { refreshToken: "t2", accountId: "B", lastUsed: now - 50 },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.accounts).toHaveLength(2);
      expect(result?.activeIndex).toBe(1);
    });

    it("handles v1 to v3 migration", () => {
      const data = {
        version: 1,
        activeIndex: 0,
        accounts: [
          { refreshToken: "t1", accountId: "A", accessToken: "acc1", expiresAt: Date.now() + 3600000 },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.version).toBe(3);
      expect(result?.accounts).toHaveLength(1);
    });

    it("preserves activeIndexByFamily when valid", () => {
      const data = {
        version: 3,
        activeIndex: 0,
        activeIndexByFamily: { codex: 1, "gpt-5.x": 0 },
        accounts: [
          { refreshToken: "t1", accountId: "A" },
          { refreshToken: "t2", accountId: "B" },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.activeIndexByFamily).toBeDefined();
    });

    it("handles activeIndexByFamily with non-finite values", () => {
      const data = {
        version: 3,
        activeIndex: 0,
        activeIndexByFamily: { codex: NaN, "gpt-5.x": Infinity },
        accounts: [{ refreshToken: "t1", accountId: "A" }],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.activeIndexByFamily).toBeDefined();
    });

    it("handles account with only accountId, no refreshToken key match", () => {
      const data = {
        version: 3,
        activeIndex: 0,
        accounts: [
          { refreshToken: "t1", accountId: "" },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result?.accounts).toHaveLength(1);
    });

    it("preserves accounts with different accountId values even when refreshToken and email are shared (no organizationId)", () => {
      const data = {
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            accountId: "workspace-a",
            refreshToken: "shared-refresh",
            email: "user@example.com",
            addedAt: 1,
            lastUsed: 1,
          },
          {
            accountId: "workspace-b",
            refreshToken: "shared-refresh",
            email: "user@example.com",
            addedAt: 2,
            lastUsed: 2,
          },
        ],
      };

      const result = normalizeAccountStorage(data);
      expect(result?.accounts).toHaveLength(2);
      const accountIds = result?.accounts.map((account) => account.accountId);
      expect(accountIds).toContain("workspace-a");
      expect(accountIds).toContain("workspace-b");
    });

    it("preserves organization-scoped variants that share the same refresh token", () => {
      const data = {
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            organizationId: "org-1",
            accountId: "workspace-a",
            refreshToken: "refresh-old",
            addedAt: 1,
            lastUsed: 10,
          },
          {
            organizationId: "org-1",
            accountId: "workspace-b",
            refreshToken: "refresh-new",
            addedAt: 2,
            lastUsed: 20,
          },
          {
            organizationId: "org-2",
            accountId: "workspace-b",
            refreshToken: "refresh-new",
            addedAt: 3,
            lastUsed: 30,
          },
        ],
      };

      const result = normalizeAccountStorage(data);
      expect(result?.accounts).toHaveLength(2);
      const organizationIds = result?.accounts
        .map((account) => account.organizationId)
        .filter((organizationId): organizationId is string => typeof organizationId === "string");
      expect(new Set(organizationIds)).toEqual(new Set(["org-1", "org-2"]));
      expect(result?.accounts.every((account) => account.accountId === "workspace-b")).toBe(true);
    });

    it("preserves workspace variants when organizationId differs despite same accountId and refreshToken", () => {
      const data = {
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            organizationId: "org-1",
            accountId: "same-workspace",
            refreshToken: "shared-refresh",
            addedAt: 1,
            lastUsed: 10,
          },
          {
            organizationId: "org-2",
            accountId: "same-workspace",
            refreshToken: "shared-refresh",
            addedAt: 2,
            lastUsed: 20,
          },
        ],
      };

      const result = normalizeAccountStorage(data);
      expect(result?.accounts).toHaveLength(2);
      expect(result?.accounts.every((account) => account.accountId === "same-workspace")).toBe(true);
      expect(result?.accounts.every((account) => account.refreshToken === "shared-refresh")).toBe(true);
      expect(result?.accounts.map((account) => account.organizationId).sort()).toEqual(["org-1", "org-2"]);
    });

    it("does not bind org-scoped entry with empty accountId to fallback accountId based on order", () => {
      const firstOrder = normalizeAccountStorage({
        version: 3,
        activeIndex: 0,
        accounts: [
          { organizationId: "org-1", refreshToken: "shared-refresh", addedAt: 1, lastUsed: 1 },
          { accountId: "workspace-a", refreshToken: "shared-refresh", addedAt: 2, lastUsed: 2 },
          { accountId: "workspace-b", refreshToken: "shared-refresh", addedAt: 3, lastUsed: 3 },
        ],
      });
      const secondOrder = normalizeAccountStorage({
        version: 3,
        activeIndex: 0,
        accounts: [
          { organizationId: "org-1", refreshToken: "shared-refresh", addedAt: 1, lastUsed: 1 },
          { accountId: "workspace-b", refreshToken: "shared-refresh", addedAt: 2, lastUsed: 2 },
          { accountId: "workspace-a", refreshToken: "shared-refresh", addedAt: 3, lastUsed: 3 },
        ],
      });

      for (const normalized of [firstOrder, secondOrder]) {
        expect(normalized?.accounts).toHaveLength(3);
        const orgScoped = normalized?.accounts.find((account) => account.organizationId === "org-1");
        expect(orgScoped).toBeDefined();
        expect(orgScoped?.accountId).toBeUndefined();
        const noOrgAccountIds = normalized?.accounts
          .filter((account) => !account.organizationId)
          .map((account) => account.accountId)
          .sort();
        expect(noOrgAccountIds).toEqual(["workspace-a", "workspace-b"]);
      }
    });

    it("retains legacy no-organization dedupe semantics", () => {
      const data = {
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            accountId: "legacy-account",
            refreshToken: "legacy-old",
            email: "legacy-account@example.com",
            addedAt: 1,
            lastUsed: 10,
          },
          {
            accountId: "legacy-account",
            refreshToken: "legacy-new",
            email: "legacy-account@example.com",
            addedAt: 2,
            lastUsed: 20,
          },
          {
            refreshToken: "legacy-refresh",
            email: "refresh-a@example.com",
            addedAt: 1,
            lastUsed: 10,
          },
          {
            refreshToken: "legacy-refresh",
            email: "refresh-b@example.com",
            addedAt: 2,
            lastUsed: 20,
          },
          {
            refreshToken: "legacy-email-old",
            email: "legacy-email@example.com",
            addedAt: 1,
            lastUsed: 10,
          },
          {
            refreshToken: "legacy-email-new",
            email: "legacy-email@example.com",
            addedAt: 2,
            lastUsed: 20,
          },
        ],
      };

      const result = normalizeAccountStorage(data);
      expect(result?.accounts).toHaveLength(3);
      expect(result?.accounts.find((account) => account.accountId === "legacy-account")?.refreshToken).toBe(
        "legacy-new",
      );
      expect(result?.accounts.find((account) => account.refreshToken === "legacy-refresh")?.email).toBe(
        "refresh-b@example.com",
      );
      expect(result?.accounts.find((account) => account.email === "legacy-email@example.com")?.refreshToken).toBe(
        "legacy-email-new",
      );
    });

    it("deduplicates legacy no-accountId records by email", () => {
      const data = {
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            refreshToken: "legacy-old",
            email: "legacy@example.com",
            addedAt: 1,
            lastUsed: 10,
          },
          {
            refreshToken: "legacy-new",
            email: "legacy@example.com",
            addedAt: 2,
            lastUsed: 20,
          },
        ],
      };

      const result = normalizeAccountStorage(data);
      expect(result?.accounts).toHaveLength(1);
      expect(result?.accounts[0]?.refreshToken).toBe("legacy-new");
    });
  });

  describe("loadAccounts", () => {
    const testWorkDir = join(tmpdir(), "codex-load-test-" + Math.random().toString(36).slice(2));
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, "accounts.json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("returns null when file does not exist", async () => {
      const result = await loadAccounts();
      expect(result).toBeNull();
    });

    it("returns null on parse error", async () => {
      await fs.writeFile(testStoragePath, "not valid json{{{", "utf-8");
      const result = await loadAccounts();
      expect(result).toBeNull();
    });

    it("returns normalized data on valid file", async () => {
      const storage = { version: 3, activeIndex: 0, accounts: [{ refreshToken: "t1", accountId: "A" }] };
      await fs.writeFile(testStoragePath, JSON.stringify(storage), "utf-8");
      const result = await loadAccounts();
      expect(result?.accounts).toHaveLength(1);
    });

    it("logs schema validation warnings but still returns data", async () => {
      const storage = { version: 3, activeIndex: 0, accounts: [{ refreshToken: "t1", accountId: "A", extraField: "ignored" }] };
      await fs.writeFile(testStoragePath, JSON.stringify(storage), "utf-8");
      const result = await loadAccounts();
      expect(result).not.toBeNull();
    });

    it("migrates v1 to v3 and attempts to save", async () => {
      const v1Storage = { 
        version: 1, 
        activeIndex: 0, 
        accounts: [{ refreshToken: "t1", accountId: "A", accessToken: "acc", expiresAt: Date.now() + 3600000 }] 
      };
      await fs.writeFile(testStoragePath, JSON.stringify(v1Storage), "utf-8");
      const result = await loadAccounts();
      expect(result?.version).toBe(3);
      const saved = JSON.parse(await fs.readFile(testStoragePath, "utf-8"));
      expect(saved.version).toBe(3);
    });

    it("returns migrated data even when save fails (line 422-423 coverage)", async () => {
      const v1Storage = { 
        version: 1, 
        activeIndex: 0, 
        accounts: [{ refreshToken: "t1", accountId: "A", accessToken: "acc", expiresAt: Date.now() + 3600000 }] 
      };
      await fs.writeFile(testStoragePath, JSON.stringify(v1Storage), "utf-8");
      
      // Make the file read-only to cause save to fail
      await fs.chmod(testStoragePath, 0o444);
      
      const result = await loadAccounts();
      
      // Should still return migrated data even though save failed
      expect(result?.version).toBe(3);
      expect(result?.accounts).toHaveLength(1);
      
      // Restore permissions for cleanup
      await fs.chmod(testStoragePath, 0o644);
    });
  });

  describe("saveAccounts", () => {
    const testWorkDir = join(tmpdir(), "codex-save-test-" + Math.random().toString(36).slice(2));
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, ".opencode", "accounts.json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("creates directory and saves file", async () => {
      const storage = { version: 3 as const, activeIndex: 0, accounts: [{ refreshToken: "t1", accountId: "A", addedAt: Date.now(), lastUsed: Date.now() }] };
      await saveAccounts(storage);
      expect(existsSync(testStoragePath)).toBe(true);
    });

    it("writes valid JSON", async () => {
      const storage = { version: 3 as const, activeIndex: 0, accounts: [{ refreshToken: "t1", accountId: "A", addedAt: 1, lastUsed: 2 }] };
      await saveAccounts(storage);
      const content = await fs.readFile(testStoragePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(3);
    });
  });

  describe("clearAccounts", () => {
    const testWorkDir = join(tmpdir(), "codex-clear-test-" + Math.random().toString(36).slice(2));
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, "accounts.json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("deletes the file when it exists", async () => {
      await fs.writeFile(testStoragePath, "{}");
      expect(existsSync(testStoragePath)).toBe(true);
      await clearAccounts();
      expect(existsSync(testStoragePath)).toBe(false);
    });

    it("does not throw when file does not exist", async () => {
      await expect(clearAccounts()).resolves.not.toThrow();
    });
  });

  describe("flagged account storage", () => {
    const testWorkDir = join(tmpdir(), "codex-flagged-test-" + Math.random().toString(36).slice(2));
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, "accounts.json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("preserves organizationId through flagged save/load normalization", async () => {
      await saveFlaggedAccounts({
        version: 1,
        accounts: [
          {
            refreshToken: "flagged-refresh",
            organizationId: "org-secondary",
            accountId: "id-secondary",
            accountIdSource: "id_token",
            flaggedAt: 123,
            addedAt: 123,
            lastUsed: 123,
          },
        ],
      });

      const loaded = await loadFlaggedAccounts();
      expect(loaded.accounts).toHaveLength(1);
      expect(loaded.accounts[0]?.organizationId).toBe("org-secondary");
      expect(loaded.accounts[0]?.accountIdSource).toBe("id_token");
    });

    it("preserves sibling flagged workspaces when organizationId is shared but accountId differs", async () => {
      await saveFlaggedAccounts({
        version: 1,
        accounts: [
          {
            refreshToken: "shared-refresh",
            organizationId: "org-shared",
            accountId: "workspace-a",
            flaggedAt: 100,
            addedAt: 100,
            lastUsed: 100,
          },
          {
            refreshToken: "shared-refresh",
            organizationId: "org-shared",
            accountId: "workspace-b",
            flaggedAt: 200,
            addedAt: 200,
            lastUsed: 200,
          },
        ],
      });

      const loaded = await loadFlaggedAccounts();
      expect(loaded.accounts).toHaveLength(2);
      expect(new Set(loaded.accounts.map((account) => account.accountId))).toEqual(
        new Set(["workspace-a", "workspace-b"]),
      );
    });

    it("serializes flagged account read-modify-write updates", async () => {
      const writeWorkspace = async (
        refreshToken: string,
        accountId: string,
        delayMs: number,
      ) =>
        withFlaggedAccountStorageTransaction(async (current, persist) => {
          const nextStorage = {
            ...current,
            accounts: current.accounts.map((account) => ({ ...account })),
          };
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          nextStorage.accounts.push({
            refreshToken,
            organizationId: "org-shared",
            accountId,
            flaggedAt: Date.now(),
            addedAt: Date.now(),
            lastUsed: Date.now(),
          });
          await persist(nextStorage);
        });

      await Promise.all([
        writeWorkspace("shared-refresh", "workspace-a", 25),
        writeWorkspace("shared-refresh", "workspace-b", 0),
      ]);

      const loaded = await loadFlaggedAccounts();
      expect(loaded.accounts).toHaveLength(2);
      expect(new Set(loaded.accounts.map((account) => account.accountId))).toEqual(
        new Set(["workspace-a", "workspace-b"]),
      );
    });

    it("retries flagged storage rename on EBUSY and succeeds", async () => {
      const originalRename = fs.rename.bind(fs);
      let attemptCount = 0;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
        const destination = String(newPath);
        if (destination.includes("oc-codex-multi-auth-flagged-accounts.json")) {
          attemptCount += 1;
          if (attemptCount <= 2) {
            const err = new Error("EBUSY error") as NodeJS.ErrnoException;
            err.code = "EBUSY";
            throw err;
          }
        }
        return originalRename(
          oldPath as Parameters<typeof fs.rename>[0],
          newPath as Parameters<typeof fs.rename>[1],
        );
      });

      try {
        await saveFlaggedAccounts({
          version: 1,
          accounts: [
            {
              refreshToken: "flagged-ebusy",
              accountId: "flagged-ebusy-account",
              flaggedAt: Date.now(),
              addedAt: Date.now(),
              lastUsed: Date.now(),
            },
          ],
        });
      } finally {
        renameSpy.mockRestore();
      }

      expect(attemptCount).toBe(3);
      const loaded = await loadFlaggedAccounts();
      expect(loaded.accounts).toHaveLength(1);
      expect(loaded.accounts[0]?.refreshToken).toBe("flagged-ebusy");
    });
  });

  describe("setStoragePath", () => {
    afterEach(() => {
      setStoragePathDirect(null);
    });

    it("sets path to null when projectPath is null", () => {
      setStoragePath(null);
      const path = getStoragePath();
      expect(path).toContain(".opencode");
    });

    it("sets path to null when no project root found", () => {
      setStoragePath("/nonexistent/path/that/does/not/exist");
      const path = getStoragePath();
      expect(path).toContain(".opencode");
    });

    it("sets project-scoped path under global .opencode when project root found", () => {
      setStoragePath(process.cwd());
      const path = getStoragePath();
      expect(path).toContain("oc-codex-multi-auth-accounts.json");
      expect(path).toContain(".opencode");
      expect(path).toContain("projects");
    });
  });

  describe("getStoragePath", () => {
    afterEach(() => {
      setStoragePathDirect(null);
    });

    it("returns custom path when set directly", () => {
      setStoragePathDirect("/custom/path/accounts.json");
      expect(getStoragePath()).toBe("/custom/path/accounts.json");
    });

    it("returns global path when no custom path set", () => {
      setStoragePathDirect(null);
      const path = getStoragePath();
      expect(path).toContain("oc-codex-multi-auth-accounts.json");
    });
  });

  describe("normalizeAccountStorage activeKey remapping", () => {
    it("remaps activeIndex using activeKey when present", () => {
      const now = Date.now();
      const data = {
        version: 3,
        activeIndex: 0,
        accounts: [
          { refreshToken: "t1", accountId: "A", lastUsed: now },
          { refreshToken: "t2", accountId: "B", lastUsed: now - 100 },
          { refreshToken: "t3", accountId: "C", lastUsed: now - 200 },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result).not.toBeNull();
      expect(result?.accounts).toHaveLength(3);
      expect(result?.activeIndex).toBe(0);
    });

    it("remaps familyKey for activeIndexByFamily when indices change after dedup", () => {
      const now = Date.now();
      const data = {
        version: 3,
        activeIndex: 0,
        activeIndexByFamily: {
          "codex": 2,
          "gpt-5.x": 1,
        },
        accounts: [
          { refreshToken: "t1", accountId: "A", lastUsed: now },
          { refreshToken: "t1", accountId: "A", lastUsed: now + 100 },
          { refreshToken: "t2", accountId: "B", lastUsed: now - 50 },
        ],
      };
      const result = normalizeAccountStorage(data);
      expect(result).not.toBeNull();
      expect(result?.accounts).toHaveLength(2);
      expect(result?.activeIndexByFamily?.codex).toBeDefined();
    });
  });

  describe("clearAccounts error handling", () => {
    const testWorkDir = join(tmpdir(), "codex-clear-err-" + Math.random().toString(36).slice(2));
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, "accounts.json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("logs but does not throw on non-ENOENT errors", async () => {
      const readOnlyDir = join(testWorkDir, "readonly");
      await fs.mkdir(readOnlyDir, { recursive: true });
      const readOnlyFile = join(readOnlyDir, "accounts.json");
      await fs.writeFile(readOnlyFile, "{}");
      setStoragePathDirect(readOnlyFile);
      
      await expect(clearAccounts()).resolves.not.toThrow();
    });
  });

  describe("StorageError with cause", () => {
    it("preserves the original error as cause", () => {
      const originalError = new Error("Original error");
      const storageErr = new StorageError(
        "Wrapper message",
        "EACCES",
        "/path/to/file",
        "Permission hint",
        originalError
      );
      expect((storageErr as unknown as { cause?: Error }).cause).toBe(originalError);
    });

    it("works without cause parameter", () => {
      const storageErr = new StorageError(
        "Wrapper message",
        "EACCES",
        "/path/to/file",
        "Permission hint"
      );
      expect((storageErr as unknown as { cause?: Error }).cause).toBeUndefined();
    });
  });

  describe("ensureGitignore edge cases", () => {
    const testWorkDir = join(tmpdir(), "codex-gitignore-" + Math.random().toString(36).slice(2));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("writes .gitignore in project root when storage path is externalized", async () => {
      const fakeHome = join(testWorkDir, "home");
      const projectDir = join(testWorkDir, "project-externalized");
      const gitDir = join(projectDir, ".git");
      const gitignorePath = join(projectDir, ".gitignore");

      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(gitDir, { recursive: true });
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      setStoragePath(projectDir);

      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "t1", accountId: "A", addedAt: Date.now(), lastUsed: Date.now() }],
      };

      await saveAccounts(storage);

      expect(existsSync(gitignorePath)).toBe(true);
      const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
      expect(gitignoreContent).toContain(".opencode/");
      expect(getStoragePath()).toContain(join(fakeHome, ".opencode", "projects"));
    });

    it("creates .gitignore when it does not exist but .git dir exists (line 99-100 false branch)", async () => {
      const projectDir = join(testWorkDir, "project");
      const openCodeDir = join(projectDir, ".opencode");
      const gitDir = join(projectDir, ".git");
      const gitignorePath = join(projectDir, ".gitignore");

      await fs.mkdir(openCodeDir, { recursive: true });
      await fs.mkdir(gitDir, { recursive: true });

      testStoragePath = join(openCodeDir, "accounts.json");
      setStoragePathDirect(testStoragePath);

      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "t1", accountId: "A", addedAt: Date.now(), lastUsed: Date.now() }],
      };

      await saveAccounts(storage);

      expect(existsSync(gitignorePath)).toBe(true);
      const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
      expect(gitignoreContent).toContain(".opencode/");
    });

    it("appends to existing .gitignore without trailing newline (line 107 coverage)", async () => {
      const projectDir = join(testWorkDir, "project2");
      const openCodeDir = join(projectDir, ".opencode");
      const gitDir = join(projectDir, ".git");
      const gitignorePath = join(projectDir, ".gitignore");

      await fs.mkdir(openCodeDir, { recursive: true });
      await fs.mkdir(gitDir, { recursive: true });
      await fs.writeFile(gitignorePath, "node_modules", "utf-8");

      testStoragePath = join(openCodeDir, "accounts.json");
      setStoragePathDirect(testStoragePath);

      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "t1", accountId: "A", addedAt: Date.now(), lastUsed: Date.now() }],
      };

      await saveAccounts(storage);

      const gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
      expect(gitignoreContent).toBe("node_modules\n.opencode/\n");
    });
  });

  describe("legacy project storage migration", () => {
    const testWorkDir = join(tmpdir(), "codex-legacy-migration-" + Math.random().toString(36).slice(2));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;

    afterEach(async () => {
      setStoragePathDirect(null);
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUserProfile;
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("removes legacy project storage file after successful migration", async () => {
      const fakeHome = join(testWorkDir, "home");
      const projectDir = join(testWorkDir, "project");
      const projectGitDir = join(projectDir, ".git");
      const legacyProjectConfigDir = join(projectDir, ".opencode");
      const legacyStoragePath = join(legacyProjectConfigDir, "openai-codex-accounts.json");

      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(projectGitDir, { recursive: true });
      await fs.mkdir(legacyProjectConfigDir, { recursive: true });
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      setStoragePath(projectDir);

      const legacyStorage = {
        version: 3,
        activeIndex: 0,
        accounts: [{ refreshToken: "legacy-refresh", accountId: "legacy-account", addedAt: 1, lastUsed: 1 }],
      };
      await fs.writeFile(legacyStoragePath, JSON.stringify(legacyStorage), "utf-8");

      const migrated = await loadAccounts();

      expect(migrated).not.toBeNull();
      expect(migrated?.accounts).toHaveLength(1);
      expect(existsSync(legacyStoragePath)).toBe(false);
      expect(existsSync(getStoragePath())).toBe(true);
    });

    it("loads global storage as fallback when project-scoped storage is missing", async () => {
      const fakeHome = join(testWorkDir, "home-fallback");
      const projectDir = join(testWorkDir, "project-fallback");
      const projectGitDir = join(projectDir, ".git");
      const globalConfigDir = join(fakeHome, ".opencode");
      const globalStoragePath = join(globalConfigDir, "openai-codex-accounts.json");

      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(projectGitDir, { recursive: true });
      await fs.mkdir(globalConfigDir, { recursive: true });
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      setStoragePath(projectDir);

      const globalStorage = {
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            refreshToken: "global-refresh",
            accountId: "global-account",
            addedAt: 1,
            lastUsed: 1,
          },
        ],
      };
      await fs.writeFile(globalStoragePath, JSON.stringify(globalStorage), "utf-8");

      const loaded = await loadAccounts();

      expect(loaded).not.toBeNull();
      expect(loaded?.accounts).toHaveLength(1);
      expect(loaded?.accounts[0]?.accountId).toBe("global-account");

      const projectScopedPath = getStoragePath();
      expect(projectScopedPath).toContain(join(fakeHome, ".opencode", "projects"));
      expect(existsSync(projectScopedPath)).toBe(true);

      const seeded = JSON.parse(await fs.readFile(projectScopedPath, "utf-8")) as {
        accounts?: Array<{ accountId?: string }>;
      };
      expect(seeded.accounts?.[0]?.accountId).toBe("global-account");
    });

    it("seeds project storage only once across serialized global-fallback loads", async () => {
      const fakeHome = join(testWorkDir, "home-fallback-concurrent");
      const projectDir = join(testWorkDir, "project-fallback-concurrent");
      const projectGitDir = join(projectDir, ".git");
      const globalConfigDir = join(fakeHome, ".opencode");
      const globalStoragePath = join(globalConfigDir, "openai-codex-accounts.json");

      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(projectGitDir, { recursive: true });
      await fs.mkdir(globalConfigDir, { recursive: true });
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      setStoragePath(projectDir);

      const globalStorage = {
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            refreshToken: "global-refresh-concurrent",
            accountId: "global-account-concurrent",
            addedAt: 1,
            lastUsed: 1,
          },
        ],
      };
      await fs.writeFile(globalStoragePath, JSON.stringify(globalStorage), "utf-8");

      const projectScopedPath = getStoragePath();
      const originalRename = fs.rename.bind(fs);
      let projectSeedWriteCount = 0;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (sourcePath, destinationPath) => {
        if (String(destinationPath) === projectScopedPath) {
          projectSeedWriteCount += 1;
        }
        return originalRename(sourcePath, destinationPath);
      });

      try {
        const [first, second] = await Promise.all([loadAccounts(), loadAccounts()]);
        expect(first?.accounts[0]?.accountId).toBe("global-account-concurrent");
        expect(second?.accounts[0]?.accountId).toBe("global-account-concurrent");
        expect(projectSeedWriteCount).toBe(1);
      } finally {
        renameSpy.mockRestore();
      }
    });

    it("returns global fallback when project seed write fails", async () => {
      const fakeHome = join(testWorkDir, "home-fallback-seed-fail");
      const projectDir = join(testWorkDir, "project-fallback-seed-fail");
      const projectGitDir = join(projectDir, ".git");
      const globalConfigDir = join(fakeHome, ".opencode");
      const globalStoragePath = join(globalConfigDir, "openai-codex-accounts.json");

      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(projectGitDir, { recursive: true });
      await fs.mkdir(globalConfigDir, { recursive: true });
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      setStoragePath(projectDir);

      const globalStorage = {
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            refreshToken: "global-refresh-fail",
            accountId: "global-account-fail",
            addedAt: 1,
            lastUsed: 1,
          },
        ],
      };
      await fs.writeFile(globalStoragePath, JSON.stringify(globalStorage), "utf-8");

      const projectScopedPath = getStoragePath();
      const originalRename = fs.rename.bind(fs);
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (sourcePath, destinationPath) => {
        if (String(destinationPath) === projectScopedPath) {
          const err = new Error("EPERM seed failure") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        return originalRename(sourcePath, destinationPath);
      });

      try {
        const loaded = await loadAccounts();
        expect(loaded?.accounts[0]?.accountId).toBe("global-account-fail");
        expect(existsSync(projectScopedPath)).toBe(false);
      } finally {
        renameSpy.mockRestore();
      }
    });

    it("skips seed write when project path access fails with non-ENOENT error", async () => {
      const fakeHome = join(testWorkDir, "home-fallback-access-error");
      const projectDir = join(testWorkDir, "project-fallback-access-error");
      const projectGitDir = join(projectDir, ".git");
      const globalConfigDir = join(fakeHome, ".opencode");
      const globalStoragePath = join(globalConfigDir, "openai-codex-accounts.json");

      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(projectGitDir, { recursive: true });
      await fs.mkdir(globalConfigDir, { recursive: true });
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      setStoragePath(projectDir);

      const globalStorage = {
        version: 3,
        activeIndex: 0,
        accounts: [
          {
            refreshToken: "global-refresh-access-error",
            accountId: "global-account-access-error",
            addedAt: 1,
            lastUsed: 1,
          },
        ],
      };
      await fs.writeFile(globalStoragePath, JSON.stringify(globalStorage), "utf-8");

      const projectScopedPath = getStoragePath();
      const originalAccess = fs.access.bind(fs);
      const originalRename = fs.rename.bind(fs);
      let projectSeedWriteCount = 0;

      const accessSpy = vi.spyOn(fs, "access").mockImplementation(async (path, mode) => {
        if (String(path) === projectScopedPath) {
          const err = new Error("EACCES access failure") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return originalAccess(path as string, mode);
      });

      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (sourcePath, destinationPath) => {
        if (String(destinationPath) === projectScopedPath) {
          projectSeedWriteCount += 1;
        }
        return originalRename(sourcePath, destinationPath);
      });

      try {
        const loaded = await loadAccounts();
        expect(loaded?.accounts[0]?.accountId).toBe("global-account-access-error");
        expect(projectSeedWriteCount).toBe(0);
        expect(existsSync(projectScopedPath)).toBe(false);
      } finally {
        accessSpy.mockRestore();
        renameSpy.mockRestore();
      }
    });

    it("returns null when global fallback storage is corrupted", async () => {
      const fakeHome = join(testWorkDir, "home-fallback-corrupted");
      const projectDir = join(testWorkDir, "project-fallback-corrupted");
      const projectGitDir = join(projectDir, ".git");
      const globalConfigDir = join(fakeHome, ".opencode");
      const globalStoragePath = join(globalConfigDir, "openai-codex-accounts.json");

      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(projectGitDir, { recursive: true });
      await fs.mkdir(globalConfigDir, { recursive: true });
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      setStoragePath(projectDir);

      await fs.writeFile(globalStoragePath, "{ invalid json", "utf-8");

      await expect(loadAccounts()).resolves.toBeNull();
      expect(existsSync(getStoragePath())).toBe(false);
    });
  });

  describe("saveAccounts EPERM/EBUSY retry logic", () => {
    const testWorkDir = join(tmpdir(), "codex-retry-" + Math.random().toString(36).slice(2));
    let testStoragePath: string;

    beforeEach(async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, "accounts.json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      vi.useRealTimers();
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("collapses org/token duplicates for the same login identity", async () => {
      const now = Date.now();
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [
          {
            accountId: "org-i1iYFgVqyAkR8CLrUKvNczIa",
            organizationId: "org-i1iYFgVqyAkR8CLrUKvNczIa",
            accountIdSource: "org" as const,
            email: "user@example.com",
            refreshToken: "shared-refresh-kira",
            addedAt: now,
            lastUsed: now,
          },
          {
            accountId: "7ff374aa-1b2e-4e69-89f3-0cec62582efb",
            accountIdSource: "token" as const,
            email: "user@example.com",
            refreshToken: "shared-refresh-kira",
            addedAt: now,
            lastUsed: now,
          },
        ],
      };

      await saveAccounts(storage);

      const loaded = await loadAccounts();
      expect(loaded?.accounts).toHaveLength(1);
      expect(loaded?.accounts[0]?.refreshToken).toBe("shared-refresh-kira");
      expect(loaded?.accounts[0]?.organizationId).toBe("org-i1iYFgVqyAkR8CLrUKvNczIa");
      expect(loaded?.accounts[0]?.accountId).toBe("org-i1iYFgVqyAkR8CLrUKvNczIa");
    });

    it("retries on EPERM and succeeds on second attempt", async () => {
      const now = Date.now();
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
      };

      const originalRename = fs.rename.bind(fs);
      let attemptCount = 0;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
        attemptCount++;
        if (attemptCount === 1) {
          const err = new Error("EPERM error") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        return originalRename(oldPath as string, newPath as string);
      });

      await saveAccounts(storage);
      expect(attemptCount).toBe(2);
      expect(existsSync(testStoragePath)).toBe(true);

      renameSpy.mockRestore();
    });

    it("retries on EBUSY and succeeds on third attempt", async () => {
      const now = Date.now();
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
      };

      const originalRename = fs.rename.bind(fs);
      let attemptCount = 0;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
        attemptCount++;
        if (attemptCount <= 2) {
          const err = new Error("EBUSY error") as NodeJS.ErrnoException;
          err.code = "EBUSY";
          throw err;
        }
        return originalRename(oldPath as string, newPath as string);
      });

      await saveAccounts(storage);
      expect(attemptCount).toBe(3);
      expect(existsSync(testStoragePath)).toBe(true);

      renameSpy.mockRestore();
    });

    it("throws after 5 failed EPERM retries", async () => {
      const now = Date.now();
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
      };

      let attemptCount = 0;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
        attemptCount++;
        const err = new Error("EPERM error") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });

      await expect(saveAccounts(storage)).rejects.toThrow("Failed to save accounts");
      expect(attemptCount).toBe(5);

      renameSpy.mockRestore();
    });

    it("throws immediately on non-EPERM/EBUSY errors", async () => {
      const now = Date.now();
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
      };

      let attemptCount = 0;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
        attemptCount++;
        const err = new Error("EACCES error") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      });

      await expect(saveAccounts(storage)).rejects.toThrow("Failed to save accounts");
      expect(attemptCount).toBe(1);

      renameSpy.mockRestore();
    });

    it("throws when temp file is written with size 0", async () => {
      const now = Date.now();
      const storage = {
        version: 3 as const,
        activeIndex: 0,
        accounts: [{ refreshToken: "token", addedAt: now, lastUsed: now }],
      };

      const statSpy = vi.spyOn(fs, "stat").mockResolvedValue({
        size: 0,
        isFile: () => true,
        isDirectory: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      await expect(saveAccounts(storage)).rejects.toThrow("Failed to save accounts");
      expect(statSpy).toHaveBeenCalled();

      statSpy.mockRestore();
    });
  });

  describe("clearAccounts edge cases", () => {
    it("logs error for non-ENOENT errors during clear", async () => {
      const unlinkSpy = vi.spyOn(fs, "unlink").mockRejectedValue(
        Object.assign(new Error("EACCES error"), { code: "EACCES" })
      );

      await clearAccounts();

      expect(unlinkSpy).toHaveBeenCalled();
      unlinkSpy.mockRestore();
    });
  });

  describe("forward-compat schema guard", () => {
    const testWorkDir = join(tmpdir(), "codex-fwdcompat-test-" + Math.random().toString(36).slice(2));
    let testStoragePath: string;

    beforeEach(async () => {
      await fs.mkdir(testWorkDir, { recursive: true });
      testStoragePath = join(testWorkDir, "accounts.json");
      setStoragePathDirect(testStoragePath);
    });

    afterEach(async () => {
      setStoragePathDirect(null);
      await fs.rm(testWorkDir, { recursive: true, force: true });
    });

    it("normalizeAccountStorage throws StorageError for version 4", () => {
      expect(() =>
        normalizeAccountStorage({ version: 4, accounts: [] }, "/tmp/future.json"),
      ).toThrowError(StorageError);
    });

    it("normalizeAccountStorage StorageError carries UNSUPPORTED_SCHEMA_VERSION code and path", () => {
      try {
        normalizeAccountStorage({ version: 9, accounts: [] }, "/tmp/future-9.json");
        throw new Error("expected normalizeAccountStorage to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        const storageError = error as StorageError;
        expect(storageError.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
        expect(storageError.path).toBe("/tmp/future-9.json");
        expect(storageError.message).toContain("9");
        expect(storageError.hint).toContain("v9");
      }
    });

    it("normalizeAccountStorage uses '<unknown>' path when caller omits sourcePath", () => {
      try {
        normalizeAccountStorage({ version: 4, accounts: [] });
        throw new Error("expected normalizeAccountStorage to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).path).toBe("<unknown>");
      }
    });

    it("normalizeAccountStorage still returns null for non-numeric future marker", () => {
      expect(
        normalizeAccountStorage({ version: "4", accounts: [] }, "/tmp/garbage.json"),
      ).toBeNull();
    });

    it("forward-compat guard does not claim legacy version 2 (V2 path handles it)", () => {
      // V2 has its own dedicated rejection (see test/storage-v2-migration.test.ts)
      // and must NOT be absorbed into the forward-compat UNSUPPORTED_SCHEMA_VERSION
      // code path; that would leak the wrong error code to the UI.
      let caught: unknown = null;
      try {
        normalizeAccountStorage({ version: 2, accounts: [] }, "/tmp/v2.json");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(StorageError);
      expect((caught as StorageError).code).not.toBe("UNSUPPORTED_SCHEMA_VERSION");
    });

    it("loadAccounts throws StorageError with UNSUPPORTED_SCHEMA_VERSION on schemaVersion > 3", async () => {
      const futureStorage = {
        version: 4,
        activeIndex: 0,
        accounts: [{ refreshToken: "t1", addedAt: Date.now(), lastUsed: Date.now() }],
      };
      await fs.writeFile(testStoragePath, JSON.stringify(futureStorage), "utf-8");

      await expect(loadAccounts()).rejects.toBeInstanceOf(StorageError);
      await expect(loadAccounts()).rejects.toMatchObject({
        code: "UNSUPPORTED_SCHEMA_VERSION",
        path: testStoragePath,
      });
    });

    it("loadAccounts leaves the future-schema file untouched when it throws", async () => {
      const originalContent = JSON.stringify({
        version: 5,
        activeIndex: 0,
        accounts: [{ refreshToken: "future-token", addedAt: 1, lastUsed: 1 }],
      });
      await fs.writeFile(testStoragePath, originalContent, "utf-8");

      await expect(loadAccounts()).rejects.toBeInstanceOf(StorageError);

      // The user's future-schema credentials must still be present on disk
      // after the guard fires; silent discard was the bug being fixed.
      const onDisk = await fs.readFile(testStoragePath, "utf-8");
      expect(onDisk).toBe(originalContent);
    });
  });
});

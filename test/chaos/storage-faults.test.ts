/**
 * Phase 3 Batch E — storage-faults chaos tests.
 *
 * Exercises the real disk-write, atomic-rename, load, and shutdown-flush
 * code paths under injected failures, then asserts that the plugin either
 * recovers (retries + eventual success) or degrades safely (typed
 * StorageError with an actionable hint, file preserved on disk).
 *
 * Scenarios covered:
 *   1. Disk-full (ENOSPC) on save — saveAccounts must throw StorageError
 *      with code=ENOSPC + "Disk is full" hint, and the next call with
 *      writable disk must succeed (recovery).
 *   2. Atomic rename EBUSY (simulated antivirus / indexer) — save must
 *      succeed within the retry budget, and no orphaned .tmp file may
 *      remain after the final successful rename.
 *   7. Corrupted V3 file on load — the loader must not crash the plugin;
 *      V2 files (intermediate shape) and forward-compat schemas must raise
 *      a typed StorageError with a recovery hint pointing at the real
 *      path. Malformed JSON is preserved on disk for recovery tooling.
 *   8. SIGTERM fires mid-500ms debounce — runCleanup() must flush the
 *      pending save synchronously so no rotation is lost.
 *
 * Determinism: every scenario injects the fault with vi.spyOn / vi.mock
 * and drives time with vi.useFakeTimers({ shouldAdvanceTime: true }) where
 * real-setTimeout retries are part of the path under test. Mocks are
 * restored between tests so shared in-memory state cannot leak.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	loadAccounts,
	saveAccounts,
	setStoragePathDirect,
	StorageError,
	type AccountStorageV3,
} from "../../lib/storage.js";
import { AccountManager } from "../../lib/accounts.js";
import { registerCleanup, runCleanup } from "../../lib/shutdown.js";

// Tiny helper: build a single-account V3 payload with a deterministic timestamp
function makeStorage(refreshToken = "token-1"): AccountStorageV3 {
	const now = 1_700_000_000_000; // frozen; never Date.now() to avoid drift
	return {
		version: 3,
		activeIndex: 0,
		accounts: [{ refreshToken, addedAt: now, lastUsed: now }],
	};
}

describe("chaos/storage-faults — real fault injection", () => {
	let testDir: string;
	let storagePath: string;

	beforeEach(async () => {
		testDir = join(
			tmpdir(),
			"codex-chaos-storage-" + Math.random().toString(36).slice(2),
		);
		await fs.mkdir(testDir, { recursive: true });
		storagePath = join(testDir, "accounts.json");
		setStoragePathDirect(storagePath);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		setStoragePathDirect(null);
		await runCleanup();
		await fs.rm(testDir, { recursive: true, force: true }).catch(() => {
			/* best-effort cleanup */
		});
	});

	describe("scenario 1: ENOSPC on save", () => {
		it("saveAccounts throws StorageError with ENOSPC hint, then recovers on next attempt", async () => {
			// Inject ENOSPC on the first accounts-file write; let the second
			// one proceed so we can assert clean recovery on the next save.
			// Phase 4 F2 added a worktree lock sidecar write on every save;
			// it piggybacks on the same fs.writeFile surface, so we filter
			// the fault injection by target path to keep the chaos scenario
			// focused on the actual storage write rather than the lock.
			const originalWriteFile = fs.writeFile.bind(fs);
			const isAccountsWrite = (target: unknown): boolean => {
				const p = typeof target === "string" ? target : String(target);
				// Lock file writes always land on `<storage>.lock`; the
				// accounts write targets the atomic tmp file alongside it.
				return !p.endsWith(".lock");
			};
			let accountsWriteCalls = 0;
			const spy = vi.spyOn(fs, "writeFile").mockImplementation(
				async (path, data, options) => {
					if (!isAccountsWrite(path)) {
						return originalWriteFile(
							path as Parameters<typeof originalWriteFile>[0],
							data as Parameters<typeof originalWriteFile>[1],
							options as Parameters<typeof originalWriteFile>[2],
						);
					}
					accountsWriteCalls += 1;
					if (accountsWriteCalls === 1) {
						const err = Object.assign(
							new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException,
							{ code: "ENOSPC" },
						);
						throw err;
					}
					return originalWriteFile(
						path as Parameters<typeof originalWriteFile>[0],
						data as Parameters<typeof originalWriteFile>[1],
						options as Parameters<typeof originalWriteFile>[2],
					);
				},
			);

			// First save: must raise a typed StorageError carrying the ENOSPC
			// code and a user-actionable hint so the CLI can surface it.
			let caught: unknown;
			try {
				await saveAccounts(makeStorage());
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(StorageError);
			const storageErr = caught as StorageError;
			expect(storageErr.code).toBe("ENOSPC");
			expect(storageErr.path).toBe(storagePath);
			expect(storageErr.hint.toLowerCase()).toContain("disk is full");
			expect(storageErr.message).toContain("ENOSPC");

			// Recovery: the next call should succeed now that the disk is writable.
			await expect(saveAccounts(makeStorage("token-2"))).resolves.toBeUndefined();
			expect(existsSync(storagePath)).toBe(true);
			const persisted = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
				accounts: Array<{ refreshToken: string }>;
			};
			expect(persisted.accounts[0]?.refreshToken).toBe("token-2");
			// Exactly two accounts-file writes: the ENOSPC failure and the
			// successful recovery. Lock-file writes are counted separately
			// and not asserted here.
			expect(accountsWriteCalls).toBe(2);
			expect(spy).toHaveBeenCalled();
		});
	});

	describe("scenario 2: EBUSY on atomic rename (AV/indexer lock)", () => {
		beforeEach(() => {
			// The retry path uses real setTimeout with exponential backoff
			// (10/20/40/80ms); `shouldAdvanceTime` lets fake timers drain them
			// automatically so the assertion arrives within the vitest budget.
			vi.useFakeTimers({ shouldAdvanceTime: true });
		});

		it("retries on EBUSY and succeeds without leaving a .tmp orphan", async () => {
			const originalRename = fs.rename.bind(fs);
			let attempts = 0;
			vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
				attempts += 1;
				if (attempts <= 2) {
					const err = Object.assign(
						new Error("EBUSY: file locked") as NodeJS.ErrnoException,
						{ code: "EBUSY" },
					);
					throw err;
				}
				return originalRename(from as string, to as string);
			});

			await expect(saveAccounts(makeStorage("ebusy-token"))).resolves.toBeUndefined();
			expect(attempts).toBe(3);
			expect(existsSync(storagePath)).toBe(true);

			// Invariant: after a successful rename the temp file MUST be gone.
			// Orphaned .tmp files accumulate over time and signal broken cleanup.
			const remaining = readdirSync(testDir);
			const tmpOrphans = remaining.filter((entry) => entry.endsWith(".tmp"));
			expect(tmpOrphans).toEqual([]);
		});
	});

	describe("scenario 7: corrupted V3 file on load", () => {
		it("malformed JSON rejects account loads and preserves the file for recovery", async () => {
			// A malformed file must not become an empty pool that the next write
			// can replace. Keep the original for recovery.
			await fs.writeFile(storagePath, "{not-json", "utf-8");

			await expect(loadAccounts()).rejects.toMatchObject({ code: "INVALID_STORAGE" });

			// File must not have been clobbered by the failed load.
			const preserved = await fs.readFile(storagePath, "utf-8");
			expect(preserved).toBe("{not-json");
		});

		it("V2 account file raises typed StorageError with a recovery hint", async () => {
			// V2 is the intermediate 4.x shape for which no forward migrator
			// shipped. Loading it must refuse instead of silently discarding
			// credentials (see lib/storage/migrations.ts → UNKNOWN_V2_FORMAT).
			await fs.writeFile(
				storagePath,
				JSON.stringify({ version: 2, accounts: [] }),
				"utf-8",
			);

			let caught: unknown;
			try {
				await loadAccounts();
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(StorageError);
			const storageErr = caught as StorageError;
			expect(storageErr.code).toBe("UNKNOWN_V2_FORMAT");
			expect(storageErr.path).toBe(storagePath);
			expect(storageErr.hint.toLowerCase()).toContain("schema v2");
			expect(storageErr.hint.toLowerCase()).toContain("recover");
		});

		it("future schema (v4) raises typed StorageError with upgrade hint", async () => {
			await fs.writeFile(
				storagePath,
				JSON.stringify({ version: 4, accounts: [] }),
				"utf-8",
			);

			let caught: unknown;
			try {
				await loadAccounts();
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(StorageError);
			const storageErr = caught as StorageError;
			expect(storageErr.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
			expect(storageErr.message).toContain("4");
			// Forward-compat guard must not overwrite the future-schema file.
			const preserved = JSON.parse(await fs.readFile(storagePath, "utf-8")) as {
				version: number;
			};
			expect(preserved.version).toBe(4);
		});
	});

	describe("scenario 8: SIGTERM during 500ms debounce", () => {
		beforeEach(() => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			vi.setSystemTime(new Date(1_700_000_000_000));
		});

		it("runCleanup flushes the pending debounced save before process exit", async () => {
			// Persistence saves through the storage transaction; spy on it so we
			// can observe the flush without blocking on disk I/O through the
			// AccountManager wrapper.
			const storageModule = await import("../../lib/storage.js");
			const saveSpy = vi
				.spyOn(storageModule, "withAccountStorageTransaction")
				.mockImplementation(async (handler) =>
					handler(null, async () => {}),
				);

			const now = Date.now();
			const manager = new AccountManager(undefined, {
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "rt-debounced", addedAt: now, lastUsed: now }],
			});

			// Schedule a save with a long debounce; without a shutdown flush
			// the save would be silently lost when the process exits.
			manager.saveToDiskDebounced(500);
			await vi.advanceTimersByTimeAsync(100); // SIGTERM arrives partway through
			expect(saveSpy).not.toHaveBeenCalled();

			// runCleanup() is the public SIGTERM equivalent (signal handler
			// funnels into this). It must drain the pending flush.
			await runCleanup();

			expect(saveSpy).toHaveBeenCalledTimes(1);

			manager.disposeShutdownHandler();
		});

		it("multiple rotations inside the debounce window are coalesced into one flushed save", async () => {
			const storageModule = await import("../../lib/storage.js");
			const saveSpy = vi
				.spyOn(storageModule, "withAccountStorageTransaction")
				.mockImplementation(async (handler) =>
					handler(null, async () => {}),
				);

			const now = Date.now();
			const manager = new AccountManager(undefined, {
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "rt-coalesce", addedAt: now, lastUsed: now }],
			});

			// Three rapid debounce calls — each reschedules the 500ms timer.
			// A correct shutdown flush must still produce exactly one save.
			manager.saveToDiskDebounced(500);
			await vi.advanceTimersByTimeAsync(50);
			manager.saveToDiskDebounced(500);
			await vi.advanceTimersByTimeAsync(50);
			manager.saveToDiskDebounced(500);

			await runCleanup();
			expect(saveSpy).toHaveBeenCalledTimes(1);
			manager.disposeShutdownHandler();
		});

		it("additional cleanup callbacks still run even if flush-on-shutdown fails", async () => {
			// Defense-in-depth: if the AccountManager flush throws, the rest
			// of the cleanup queue (log drains, server closes) must still run.
			const storageModule = await import("../../lib/storage.js");
			const saveSpy = vi
				.spyOn(storageModule, "withAccountStorageTransaction")
				.mockRejectedValueOnce(new Error("simulated disk failure"));

			const now = Date.now();
			const manager = new AccountManager(undefined, {
				version: 3,
				activeIndex: 0,
				accounts: [{ refreshToken: "rt-fail", addedAt: now, lastUsed: now }],
			});

			const secondary = vi.fn();
			registerCleanup(secondary);
			manager.saveToDiskDebounced(500);

			await runCleanup();

			expect(saveSpy).toHaveBeenCalledTimes(1);
			expect(secondary).toHaveBeenCalledTimes(1);
			manager.disposeShutdownHandler();
		});
	});
});

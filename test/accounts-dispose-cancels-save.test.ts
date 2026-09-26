/**
 * `disposeShutdownHandler()` marks a manager as replaced. A debounced save
 * armed before that call fires up to 500ms later; a save that had already
 * started cannot be stopped at all.
 *
 * Disk is authoritative for account membership. A disposed manager also
 * preserves disk credentials and merges only its new volatile state.
 *
 * Dropping the write outright is not the answer either. The only save a
 * cancel can still reach is one armed *after* the caller's flush, and that is
 * the rate-limit block an in-flight request just recorded — losing it hands an
 * exhausted account straight back to rotation. So a disposed manager still
 * writes, with membership and credentials taken from disk.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { AccountManager } from "../lib/accounts.js";
import { setStoragePathDirect, type AccountStorageV3 } from "../lib/storage.js";

/** Longer than the 500ms debounce, short enough to keep the suite fast. */
const PAST_DEBOUNCE_MS = 900;

const TEST_STORAGE_PATH = join(
	tmpdir(),
	`oc-codex-multi-auth-dispose-cancels-save-${process.pid}-${Date.now()}.json`,
);

const ON_DISK_ACCOUNTS = ["rt-user-1", "rt-user-2", "rt-user-3"] as const;

const managers: AccountManager[] = [];

function storageOf(refreshTokens: readonly string[]): AccountStorageV3 {
	return {
		version: 3,
		activeIndex: 0,
		accounts: refreshTokens.map((refreshToken, index) => ({
			refreshToken,
			addedAt: 1_700_000_000_000,
			lastUsed: 1_700_000_000_000 + index,
		})),
	};
}

/** A manager holding one account the on-disk store does not have. */
function managerWithForeignAccount(): AccountManager {
	const manager = new AccountManager(undefined, storageOf(["rt-from-a-dead-manager"]));
	managers.push(manager);
	return manager;
}

/** A manager holding an account the on-disk store also has. */
function managerSharingDiskAccount(): AccountManager {
	const manager = new AccountManager(undefined, storageOf([ON_DISK_ACCOUNTS[0]]));
	managers.push(manager);
	return manager;
}

async function readStored(): Promise<AccountStorageV3> {
	return JSON.parse(await fs.readFile(TEST_STORAGE_PATH, "utf8")) as AccountStorageV3;
}

async function storedRefreshTokens(): Promise<string[]> {
	return (await readStored()).accounts.map((account) => account.refreshToken);
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
	// Redirect account storage before any manager exists, so no save in this
	// file can reach the developer's real account file.
	setStoragePathDirect(TEST_STORAGE_PATH);
	await fs.writeFile(TEST_STORAGE_PATH, JSON.stringify(storageOf(ON_DISK_ACCOUNTS)));
});

afterEach(async () => {
	// Dispose and drain while the override is still active, so no write can
	// resolve the storage path after it is cleared.
	for (const manager of managers.splice(0)) {
		manager.disposeShutdownHandler();
		await manager.flushPendingSave();
	}
	setStoragePathDirect(null);
	await fs.rm(TEST_STORAGE_PATH, { force: true });
});

describe("AccountManager.disposeShutdownHandler", () => {
	it("keeps the store's account membership when a queued save fires after disposal", async () => {
		// Given a store holding accounts this manager knows nothing about
		const manager = managerWithForeignAccount();

		// When a queued save is followed by disposal
		manager.saveToDiskDebounced();
		manager.disposeShutdownHandler();
		await sleep(PAST_DEBOUNCE_MS);

		// Then the store still holds exactly the accounts it started with
		await expect(storedRefreshTokens()).resolves.toEqual([...ON_DISK_ACCOUNTS]);
	});

	it("preserves new accounts even when the old manager is still live", async () => {
		// Given the same store and an identical queued save
		const manager = managerWithForeignAccount();

		// When the manager is left live instead of disposed
		manager.saveToDiskDebounced();
		await sleep(PAST_DEBOUNCE_MS);

		// The other process's accounts remain and the stale account is not
		// resurrected if it was deliberately removed from disk.
		await expect(storedRefreshTokens()).resolves.toEqual([...ON_DISK_ACCOUNTS]);
	});

	it("keeps membership when a save was already in flight at disposal", async () => {
		// Given a save that has already started, so no timer cancel can reach it
		const manager = managerWithForeignAccount();
		const inFlight = manager.saveToDisk();

		// When disposal lands before the storage transaction runs
		manager.disposeShutdownHandler();
		await inFlight;

		// Then the store still holds exactly the accounts it started with
		await expect(storedRefreshTokens()).resolves.toEqual([...ON_DISK_ACCOUNTS]);
	});

	it("still persists a rate-limit block recorded after the caller's flush", async () => {
		// Given a manager that shares an account with the store, flushed clean
		const manager = managerSharingDiskAccount();
		await manager.flushPendingSave();

		// When an in-flight request records a 429 on it and the reload disposes
		// it before the debounce fires
		const account = manager.getCurrentOrNextForFamilyHybrid("codex", "gpt-5.1");
		expect(account).not.toBeNull();
		manager.markRateLimited(account!, 60 * 60_000, "codex", "gpt-5.1");
		manager.saveToDiskDebounced();
		manager.disposeShutdownHandler();
		await sleep(PAST_DEBOUNCE_MS);

		// Then the block reached disk — dropping it would hand an exhausted
		// account straight back to rotation — and membership is untouched
		const stored = await readStored();
		expect(stored.accounts.map((entry) => entry.refreshToken)).toEqual([...ON_DISK_ACCOUNTS]);
		const blocked = stored.accounts.find(
			(entry) => entry.refreshToken === ON_DISK_ACCOUNTS[0],
		);
		const resets = Object.values(blocked?.rateLimitResetTimes ?? {});
		expect(resets.length).toBeGreaterThan(0);
		expect(Math.max(...(resets as number[]))).toBeGreaterThan(Date.now());
	});

	it("leaves an unrelated account's credentials alone while doing so", async () => {
		// Given a disposed manager whose snapshot omits two on-disk accounts
		const manager = managerSharingDiskAccount();
		await manager.flushPendingSave();
		const account = manager.getCurrentOrNextForFamilyHybrid("codex", "gpt-5.1");
		manager.markRateLimited(account!, 60 * 60_000, "codex", "gpt-5.1");
		manager.saveToDiskDebounced();
		manager.disposeShutdownHandler();
		await sleep(PAST_DEBOUNCE_MS);

		// Then the accounts it never held keep their own records verbatim
		const stored = await readStored();
		for (const refreshToken of ON_DISK_ACCOUNTS.slice(1)) {
			const untouched = stored.accounts.find((entry) => entry.refreshToken === refreshToken);
			expect(untouched?.rateLimitResetTimes).toBeUndefined();
			expect(untouched?.coolingDownUntil).toBeUndefined();
		}
	});
});

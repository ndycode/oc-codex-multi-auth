/**
 * Regression tests for the multi-process credential-clobber class of bugs:
 * refresh tokens are single-use, so a process persisting a stale in-memory
 * snapshot must never overwrite a refresh token another process rotated after
 * this process loaded its state. Covers:
 *
 * 1. AccountPersistence.saveToDisk adopting newer on-disk credentials
 *    (recognized via the tokenRotatedAt stamp) into both the persisted
 *    payload and the live in-memory accounts.
 * 2. AccountState.updateFromAuth stamping tokenRotatedAt on rotation and
 *    propagating the stamp to token-sharing siblings.
 * 3. RefreshQueue returning the settled rotation result to a late caller
 *    still holding the consumed pre-rotation token.
 * 4. shouldRefreshProactively treating a missing access token as
 *    refresh-worthy even when no expiry is recorded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountStorageV3 } from "../lib/storage.js";

const { saveAccountsMock, diskStateRef } = vi.hoisted(() => ({
	saveAccountsMock: vi.fn(async (_storage: unknown) => {}),
	diskStateRef: { current: null as unknown },
}));

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		saveAccounts: saveAccountsMock,
		withAccountStorageTransaction: vi.fn(
			async (
				handler: (
					current: unknown,
					persist: (storage: unknown) => Promise<void>,
				) => Promise<unknown>,
			) => handler(diskStateRef.current, saveAccountsMock),
		),
	};
});

vi.mock("../lib/auth/auth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/auth/auth.js")>();
	return {
		...actual,
		refreshAccessToken: vi.fn(),
	};
});

import { AccountPersistence } from "../lib/accounts/persistence.js";
import { AccountState } from "../lib/accounts/state.js";
import * as authModule from "../lib/auth/auth.js";
import { shouldRefreshProactively } from "../lib/proactive-refresh.js";
import { RefreshQueue } from "../lib/refresh-queue.js";

function makeStoredAccount(
	overrides: Partial<AccountStorageV3["accounts"][number]> = {},
): AccountStorageV3["accounts"][number] {
	return {
		accountId: "acct-1",
		organizationId: "org-1",
		email: "user@example.com",
		refreshToken: "rt-old",
		accessToken: "at-old",
		expiresAt: Date.now() + 3_600_000,
		addedAt: 1,
		lastUsed: 1,
		...overrides,
	};
}

function makeState(
	accounts: AccountStorageV3["accounts"],
): AccountState {
	const state = new AccountState();
	state.initializeFromStorage(undefined, {
		version: 3,
		accounts,
		activeIndex: 0,
	});
	return state;
}

beforeEach(() => {
	saveAccountsMock.mockClear();
	diskStateRef.current = null;
});

function persistedStorage(): AccountStorageV3 | undefined {
	return saveAccountsMock.mock.calls[0]?.[0] as AccountStorageV3 | undefined;
}

// Issue #218: a weekly quota block is worth days, so unlike a 5h window it
// cannot be left to last-writer-wins. A second process holding a stale snapshot
// would save over it and put the exhausted account straight back in rotation.
describe("AccountPersistence rate-limit merge (multi-process clobber guard)", () => {
	const WEEKLY_RESET = Date.now() + 7 * 24 * 60 * 60 * 1000;

	it("keeps a longer on-disk quota block instead of clobbering it", async () => {
		const state = makeState([makeStoredAccount()]);
		const persistence = new AccountPersistence(state);

		// Another process recorded the weekly block after this one loaded.
		diskStateRef.current = {
			version: 3,
			accounts: [
				makeStoredAccount({ rateLimitResetTimes: { codex: WEEKLY_RESET } }),
			],
			activeIndex: 0,
		} satisfies AccountStorageV3;

		await persistence.saveToDisk();

		expect(persistedStorage()?.accounts[0]?.rateLimitResetTimes?.codex).toBe(
			WEEKLY_RESET,
		);
	});

	it("keeps its own block when it is the longer one", async () => {
		const state = makeState([
			makeStoredAccount({ rateLimitResetTimes: { codex: WEEKLY_RESET } }),
		]);
		const persistence = new AccountPersistence(state);

		diskStateRef.current = {
			version: 3,
			accounts: [
				makeStoredAccount({
					rateLimitResetTimes: { codex: Date.now() + 30_000 },
				}),
			],
			activeIndex: 0,
		} satisfies AccountStorageV3;

		await persistence.saveToDisk();

		expect(persistedStorage()?.accounts[0]?.rateLimitResetTimes?.codex).toBe(
			WEEKLY_RESET,
		);
	});

	it("merges per quota key rather than wholesale", async () => {
		const state = makeState([
			makeStoredAccount({ rateLimitResetTimes: { codex: WEEKLY_RESET } }),
		]);
		const persistence = new AccountPersistence(state);

		const modelReset = Date.now() + 60_000;
		diskStateRef.current = {
			version: 3,
			accounts: [
				makeStoredAccount({
					rateLimitResetTimes: { "codex:gpt-5-codex": modelReset },
				}),
			],
			activeIndex: 0,
		} satisfies AccountStorageV3;

		await persistence.saveToDisk();

		expect(persistedStorage()?.accounts[0]?.rateLimitResetTimes).toEqual({
			codex: WEEKLY_RESET,
			"codex:gpt-5-codex": modelReset,
		});
	});

	it("does not resurrect an expired on-disk block", async () => {
		const state = makeState([makeStoredAccount()]);
		const persistence = new AccountPersistence(state);

		diskStateRef.current = {
			version: 3,
			accounts: [
				makeStoredAccount({
					rateLimitResetTimes: { codex: Date.now() - 60_000 },
				}),
			],
			activeIndex: 0,
		} satisfies AccountStorageV3;

		await persistence.saveToDisk();

		expect(
			persistedStorage()?.accounts[0]?.rateLimitResetTimes?.codex,
		).toBeUndefined();
	});

	it("keeps a longer on-disk quota-exhaustion stamp instead of clobbering it", async () => {
		// A shorter in-memory quota block must not pull a longer on-disk one
		// forward, mirroring the per-family rate-limit monotonic merge (#218).
		const state = makeState([
			makeStoredAccount({ quotaExhaustedUntil: Date.now() + 30_000 }),
		]);
		const persistence = new AccountPersistence(state);

		diskStateRef.current = {
			version: 3,
			accounts: [makeStoredAccount({ quotaExhaustedUntil: WEEKLY_RESET })],
			activeIndex: 0,
		} satisfies AccountStorageV3;

		await persistence.saveToDisk();

		expect(persistedStorage()?.accounts[0]?.quotaExhaustedUntil).toBe(WEEKLY_RESET);
	});

	// Documents a known limitation rather than desired behavior. A record with
	// neither organizationId nor accountId is identified by its refresh token
	// (lib/storage/identity.ts), so once another process rotates that token
	// there is nothing left to match the two records on and the merge cannot
	// run. It degrades to the pre-merge behavior — the block is dropped, never
	// mis-assigned to a different account — which is why a positional fallback
	// would be worse than this. Fixing it needs a rotation-invariant account id
	// in storage, which also fixes the more serious credential miss asserted
	// below. Flip both expectations when that lands.
	it("cannot merge a token-only record whose token rotated (known limitation)", async () => {
		const state = makeState([
			makeStoredAccount({
				accountId: undefined,
				organizationId: undefined,
				refreshToken: "rt-old",
				tokenRotatedAt: 1_000,
			}),
		]);
		const persistence = new AccountPersistence(state);

		diskStateRef.current = {
			version: 3,
			accounts: [
				makeStoredAccount({
					accountId: undefined,
					organizationId: undefined,
					refreshToken: "rt-new",
					tokenRotatedAt: 2_000,
					rateLimitResetTimes: { codex: WEEKLY_RESET },
				}),
			],
			activeIndex: 0,
		} satisfies AccountStorageV3;

		await persistence.saveToDisk();

		const persisted = persistedStorage();
		// Dropped, not mis-assigned: no record matched, so nothing was merged.
		expect(persisted?.accounts[0]?.rateLimitResetTimes).toBeUndefined();
		// Pre-existing and more serious: the same identity miss makes
		// adoptNewerDiskCredentials overwrite the rotated single-use token.
		expect(persisted?.accounts[0]?.refreshToken).toBe("rt-old");
	});

	it("leaves live rotation state untouched", async () => {
		const state = makeState([makeStoredAccount()]);
		const persistence = new AccountPersistence(state);

		diskStateRef.current = {
			version: 3,
			accounts: [
				makeStoredAccount({ rateLimitResetTimes: { codex: WEEKLY_RESET } }),
			],
			activeIndex: 0,
		} satisfies AccountStorageV3;

		await persistence.saveToDisk();

		// The persisted payload must not share a reference with live state.
		expect(state.accounts[0]?.rateLimitResetTimes).toEqual({});
	});
});

describe("AccountPersistence credential merge (multi-process clobber guard)", () => {
	it("adopts a newer rotated refresh token from disk instead of clobbering it", async () => {
		const state = makeState([
			makeStoredAccount({ refreshToken: "rt-old", tokenRotatedAt: 1_000 }),
		]);
		const persistence = new AccountPersistence(state);

		// Another process rotated the token after this process loaded rt-old.
		diskStateRef.current = {
			version: 3,
			accounts: [
				makeStoredAccount({
					refreshToken: "rt-new",
					accessToken: "at-new",
					expiresAt: 999_999,
					tokenRotatedAt: 2_000,
				}),
			],
			activeIndex: 0,
		} satisfies AccountStorageV3;

		await persistence.saveToDisk();

		const persisted = persistedStorage();
		expect(persisted?.accounts[0]?.refreshToken).toBe("rt-new");
		expect(persisted?.accounts[0]?.accessToken).toBe("at-new");
		expect(persisted?.accounts[0]?.tokenRotatedAt).toBe(2_000);
		// The live account must stop using the consumed token too, or this
		// process's next refresh burns rt-old and kills the account.
		expect(state.accounts[0]?.refreshToken).toBe("rt-new");
		expect(state.accounts[0]?.access).toBe("at-new");
	});

	it("keeps its own token when the in-memory rotation is the newer one", async () => {
		const state = makeState([
			makeStoredAccount({ refreshToken: "rt-mine", tokenRotatedAt: 3_000 }),
		]);
		const persistence = new AccountPersistence(state);

		diskStateRef.current = {
			version: 3,
			accounts: [
				makeStoredAccount({ refreshToken: "rt-stale", tokenRotatedAt: 2_000 }),
			],
			activeIndex: 0,
		} satisfies AccountStorageV3;

		await persistence.saveToDisk();

		const persisted = persistedStorage();
		expect(persisted?.accounts[0]?.refreshToken).toBe("rt-mine");
		expect(state.accounts[0]?.refreshToken).toBe("rt-mine");
	});

	it("keeps its own token when neither record carries a rotation stamp (pre-upgrade files)", async () => {
		const state = makeState([makeStoredAccount({ refreshToken: "rt-mine" })]);
		const persistence = new AccountPersistence(state);

		diskStateRef.current = {
			version: 3,
			accounts: [makeStoredAccount({ refreshToken: "rt-disk" })],
			activeIndex: 0,
		} satisfies AccountStorageV3;

		await persistence.saveToDisk();

		const persisted = persistedStorage();
		expect(persisted?.accounts[0]?.refreshToken).toBe("rt-mine");
	});
});

describe("AccountState rotation stamping", () => {
	it("stamps tokenRotatedAt on the account and its token-sharing siblings", () => {
		const state = makeState([
			makeStoredAccount({ accountId: "acct-1", organizationId: "org-1" }),
			makeStoredAccount({ accountId: "acct-2", organizationId: "org-2" }),
			makeStoredAccount({
				accountId: "acct-3",
				organizationId: "org-3",
				refreshToken: "rt-unrelated",
			}),
		]);
		const account = state.accounts[0];
		if (!account) throw new Error("missing account");

		state.updateFromAuth(account, {
			type: "oauth",
			access: "at-rotated",
			refresh: "rt-rotated",
			expires: Date.now() + 3_600_000,
		});

		expect(account.tokenRotatedAt).toBeGreaterThan(0);
		// The sibling shared rt-old and must follow the rotation, stamp included.
		expect(state.accounts[1]?.refreshToken).toBe("rt-rotated");
		expect(state.accounts[1]?.tokenRotatedAt).toBeGreaterThan(0);
		// Unrelated account untouched.
		expect(state.accounts[2]?.refreshToken).toBe("rt-unrelated");
		expect(state.accounts[2]?.tokenRotatedAt).toBeUndefined();
	});

	it("does not stamp when the refresh token is unchanged", () => {
		const state = makeState([makeStoredAccount()]);
		const account = state.accounts[0];
		if (!account) throw new Error("missing account");

		state.updateFromAuth(account, {
			type: "oauth",
			access: "at-renewed",
			refresh: "rt-old",
			expires: Date.now() + 3_600_000,
		});

		expect(account.tokenRotatedAt).toBeUndefined();
	});
});

describe("RefreshQueue settled-rotation reuse", () => {
	it("returns the rotation result to a late caller holding the consumed token", async () => {
		const queue = new RefreshQueue();
		const rotated = {
			type: "success" as const,
			access: "at-new",
			refresh: "rt-new",
			expires: Date.now() + 3_600_000,
		};
		vi.mocked(authModule.refreshAccessToken).mockResolvedValue(rotated);

		const first = await queue.refresh("rt-old");
		expect(first).toEqual(rotated);

		// The first refresh has fully settled; a sibling that captured rt-old
		// before the rotation now asks to refresh with the consumed token.
		const second = await queue.refresh("rt-old");

		expect(second).toEqual(rotated);
		expect(authModule.refreshAccessToken).toHaveBeenCalledTimes(1);
	});
});

describe("shouldRefreshProactively ordering", () => {
	it("refreshes an account with no access token even when no expiry is set", () => {
		const account = {
			index: 0,
			refreshToken: "rt",
			addedAt: 0,
			lastUsed: 0,
			rateLimitResetTimes: {},
		};
		expect(shouldRefreshProactively(account)).toBe(true);
	});
});

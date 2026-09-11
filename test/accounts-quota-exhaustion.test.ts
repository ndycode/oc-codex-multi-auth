import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { resetTrackers } from "../lib/rotation.js";
import { MODEL_FAMILIES } from "../lib/prompts/codex.js";

// Storage writes are irrelevant to these in-memory rotation/eligibility checks;
// stub the persistence surface so no real accounts file is touched.
vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	const saveAccounts = vi.fn().mockResolvedValue(undefined);
	return {
		...actual,
		saveAccounts,
		loadAccounts: vi.fn().mockResolvedValue(null),
		withAccountStorageTransaction: vi.fn(
			async (
				handler: (
					current: null,
					persist: (storage: unknown) => Promise<void>,
				) => Promise<unknown>,
			) => handler(null, saveAccounts as (storage: unknown) => Promise<void>),
		),
	};
});

/**
 * Regressions for the account-wide `quotaExhaustedUntil` state, which must be
 * kept distinct from the per-family/per-model transient `rateLimitResetTimes`
 * map. See the root-cause note on `persistUsageQuotaExhaustion`.
 */
describe("account-wide quota exhaustion state", () => {
	beforeEach(() => {
		resetTrackers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetTrackers();
	});

	// (b)
	it("blocks selection for every family and reports a quota-exhausted reason distinct from rate-limited", () => {
		const now = Date.now();
		const manager = new AccountManager(undefined, {
			version: 3 as const,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "token-1",
					accountId: "acct-1",
					addedAt: now,
					lastUsed: now,
					quotaExhaustedUntil: now + 7 * 24 * 60 * 60 * 1000,
				},
			],
		});

		// Not selectable for any model family.
		for (const family of MODEL_FAMILIES) {
			expect(manager.getCurrentOrNextForFamily(family), family).toBeNull();
		}

		const explain = manager.getSelectionExplainability("codex", null, now);
		expect(explain[0]?.eligible).toBe(false);
		expect(explain[0]?.reasons).toContain("quota-exhausted");
		expect(explain[0]?.reasons).not.toContain("rate-limited");
	});

	// (c)
	it("does not set quotaExhaustedUntil on a transient 429 and leaves other families usable", () => {
		const now = Date.now();
		const manager = new AccountManager(undefined, {
			version: 3 as const,
			activeIndex: 0,
			accounts: [
				{ refreshToken: "token-1", accountId: "acct-1", addedAt: now, lastUsed: now },
			],
		});
		const account = manager.getCurrentAccount()!;

		manager.markRateLimitedWithReason(account, 60_000, "codex", "quota");

		// A transient rate limit is per-family, never the account-wide field.
		expect(account.quotaExhaustedUntil).toBeUndefined();
		expect(account.rateLimitResetTimes["codex"]).toBeDefined();

		// A different family is unaffected by the codex 429.
		expect(manager.getCurrentOrNextForFamily("gpt-5.1")?.accountId).toBe("acct-1");
	});

	// (d)
	it("getMinWaitTimeForFamily returns the quota-exhaustion wait when it is the only block", () => {
		const now = Date.now();
		const wait = 6 * 60 * 60 * 1000;
		const manager = new AccountManager(undefined, {
			version: 3 as const,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "token-1",
					accountId: "acct-1",
					addedAt: now,
					lastUsed: now,
					quotaExhaustedUntil: now + wait,
				},
			],
		});

		// Whole pool is blocked, so selection fails.
		expect(manager.getCurrentOrNextForFamily("codex")).toBeNull();

		// The wait must reflect the quota reset, not 0 (which upstream turns into
		// a 503 instead of a retryable 429 with a hint).
		const minWait = manager.getMinWaitTimeForFamily("codex");
		expect(minWait).toBeGreaterThan(0);
		expect(minWait).toBeLessThanOrEqual(wait);
	});

	// (e)
	it("probes eligibility by dropping only expired stamps and never moving the rotation cursor", () => {
		vi.useFakeTimers();
		const now = Date.now();
		const manager = new AccountManager(undefined, {
			version: 3, activeIndex: 0,
			accounts: [{ refreshToken: "token-1", addedAt: 1, lastUsed: 1,
				quotaExhaustedUntil: now - 1, rateLimitResetTimes: { codex: now - 1 } }],
		});
		const { quotaExhaustedUntil: _q, rateLimitResetTimes: _r, ...before } = manager.getAccountsSnapshot()[0]!;
		expect(manager.getSelectionExplainability("codex")[0]?.eligible).toBe(true);
		const { quotaExhaustedUntil, rateLimitResetTimes, ...after } = manager.getAccountsSnapshot()[0]!;
		expect(after).toEqual(before);
		expect(quotaExhaustedUntil).toBeUndefined();
		expect(rateLimitResetTimes).toEqual({});
		expect(manager.getCurrentAccount()?.index).toBe(0);
	});

	it("ignores and clears an expired quotaExhaustedUntil", () => {
		const now = Date.now();
		const manager = new AccountManager(undefined, {
			version: 3 as const,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "token-1",
					accountId: "acct-1",
					addedAt: now,
					lastUsed: now,
					quotaExhaustedUntil: now - 60_000,
				},
			],
		});
		const account = manager.getCurrentAccount()!;

		// An elapsed quota block does not keep the account out of rotation.
		expect(manager.getCurrentOrNextForFamily("codex")?.accountId).toBe("acct-1");
		expect(account.quotaExhaustedUntil).toBeUndefined();

		const explain = manager.getSelectionExplainability("codex", null, now);
		expect(explain[0]?.reasons).not.toContain("quota-exhausted");
	});

	// (h)
	it("keeps blocking a legacy record with every family stamped and no quotaExhaustedUntil", () => {
		const now = Date.now();
		const resetAt = now + 6 * 24 * 60 * 60 * 1000;
		const rateLimitResetTimes: Record<string, number> = {};
		for (const family of MODEL_FAMILIES) rateLimitResetTimes[family] = resetAt;

		const manager = new AccountManager(undefined, {
			version: 3 as const,
			activeIndex: 0,
			accounts: [
				{
					refreshToken: "token-1",
					accountId: "acct-1",
					addedAt: now,
					lastUsed: now,
					rateLimitResetTimes,
				},
			],
		});

		// Legacy blanket stamp still blocks via the per-family map, exactly as before.
		expect(manager.getCurrentOrNextForFamily("codex")).toBeNull();
		const explain = manager.getSelectionExplainability("codex", null, now);
		expect(explain[0]?.reasons).toContain("rate-limited");
	});
});

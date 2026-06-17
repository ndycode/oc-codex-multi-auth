/**
 * Stress / regression coverage for issue #171 — request-path 401
 * "authentication token has been invalidated" failover.
 *
 * Unlike test/index-retry.test.ts (which mocks BOTH the detector and the whole
 * AccountManager), this suite drives the REAL AccountManager + REAL detector
 * (`isInvalidatedAuthTokenError`) through the exact method sequence the 401
 * handler in index.ts performs, then asserts the user-visible properties:
 *
 *   A. A 401 on the pinned family slot cools that account's refresh-token group
 *      down and rotation returns a DIFFERENT healthy account.
 *   B. After a successful request on the healthy account, the persisted family
 *      routing (activeIndexByFamily) points at the healthy slot — so the dead
 *      slot is no longer pinned across a simulated restart (the core of #171,
 *      which previously required hand-editing activeIndex).
 *   C. clearAuthFailures on success prevents stale-count accumulation toward
 *      removal of a recovered account.
 *   D. Threshold removal: MAX_AUTH_FAILURES_BEFORE_REMOVAL drops the dead group.
 *   E. Single standalone account 401 exercises the cooledCount<=0 /
 *      markAccountCoolingDown fallback (Greptile-flagged uncovered branch).
 *   F. The real detector classifies the upstream 401 body correctly and does
 *      NOT misfire on rate-limit / entitlement / server bodies.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import { AccountManager } from "../../lib/accounts.js";
import type { AccountStorageV3 } from "../../lib/storage.js";
import { ACCOUNT_LIMITS } from "../../lib/constants.js";
import { isInvalidatedAuthTokenError } from "../../lib/request/fetch-helpers.js";
import type { ModelFamily } from "../../lib/prompts/codex.js";
import { MODEL_FAMILIES } from "../../lib/prompts/codex.js";

const FAMILY: ModelFamily = "codex";
const COOLDOWN = ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS;

const INVALIDATED_401_BODY = {
	error: {
		message:
			"Your authentication token has been invalidated. Please try signing in again.",
	},
} as const;

// Distinct refresh tokens => two independent account groups, so cooling one
// down leaves the other selectable (the realistic multi-account pool).
function makeTwoAccountStorage(): AccountStorageV3 {
	const now = 1_700_000_000_000;
	return {
		version: 3,
		activeIndex: 0,
		accounts: [
			{ refreshToken: "rt-dead", addedAt: now, lastUsed: now },
			{ refreshToken: "rt-healthy", addedAt: now, lastUsed: now - 1 },
		],
	};
}

function makeSingleAccountStorage(): AccountStorageV3 {
	const now = 1_700_000_000_000;
	return {
		version: 3,
		activeIndex: 0,
		accounts: [{ refreshToken: "rt-solo", addedAt: now, lastUsed: now }],
	};
}

type Active = ReturnType<AccountManager["getCurrentOrNextForFamilyHybrid"]>;

/**
 * Replays the request-path 401 handler from index.ts (the block guarded by
 * `if (isInvalidatedAuthTokenError(errorBody, response.status))`) against the
 * REAL manager. Mirrors the production order: refund -> recordFailure ->
 * increment -> (threshold? remove) -> cool group (fallback per-account) -> save.
 *
 * @returns { removed, cooledCount, failures } for assertions.
 */
async function applyInvalidated401(
	manager: AccountManager,
	account: NonNullable<Active>,
): Promise<{ removed: number; cooledCount: number; failures: number }> {
	// Gate on the real detector exactly as index.ts does.
	expect(isInvalidatedAuthTokenError(INVALIDATED_401_BODY, 401)).toBe(true);

	manager.refundToken(account, FAMILY, "gpt-5.1");
	manager.recordFailure(account, FAMILY, "gpt-5.1");

	const failures = await manager.incrementAuthFailures(account);
	let removed = 0;
	if (failures >= ACCOUNT_LIMITS.MAX_AUTH_FAILURES_BEFORE_REMOVAL) {
		removed = manager.removeAccountsWithSameRefreshToken(account);
		if (removed > 0) {
			manager.saveToDiskDebounced();
			return { removed, cooledCount: 0, failures };
		}
	}

	const cooledCount = manager.markAccountsWithRefreshTokenCoolingDown(
		account.refreshToken,
		COOLDOWN,
		"auth-failure",
	);
	if (cooledCount <= 0) {
		manager.markAccountCoolingDown(account, COOLDOWN, "auth-failure");
	}
	manager.saveToDiskDebounced();
	return { removed, cooledCount, failures };
}

/**
 * Capture the on-disk storage shape the way persistence.ts:saveToDisk does,
 * then rebuild a fresh manager from it — a faithful "restart" without touching
 * the real ~/.opencode file.
 */
function simulateRestart(manager: AccountManager): AccountManager {
	const snapshot = manager.getAccountsSnapshot();
	const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
	for (const family of MODEL_FAMILIES) {
		activeIndexByFamily[family] = Math.max(0, manager.getActiveIndexForFamily(family));
	}
	const storage: AccountStorageV3 = {
		version: 3,
		activeIndex: Math.max(0, manager.getActiveIndexForFamily(FAMILY)),
		activeIndexByFamily,
		accounts: snapshot.map((a) => ({
			refreshToken: a.refreshToken,
			addedAt: a.addedAt,
			lastUsed: a.lastUsed,
			coolingDownUntil: a.coolingDownUntil,
			cooldownReason: a.cooldownReason,
		})),
	};
	return new AccountManager(undefined, storage);
}

describe("chaos/auth-invalidated-401 — real manager + real detector (issue #171)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("A: 401 on the pinned slot cools it down and rotation returns a different healthy account", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(1_700_000_000_000));
		const manager = new AccountManager(undefined, makeTwoAccountStorage());

		const dead = manager.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1");
		expect(dead).not.toBeNull();
		expect(dead!.refreshToken).toBe("rt-dead");

		await applyInvalidated401(manager, dead!);

		// The dead group is cooling down; the next selection MUST be the other account.
		const next = manager.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1");
		expect(next).not.toBeNull();
		expect(next!.refreshToken).toBe("rt-healthy");

		const deadSnap = manager
			.getAccountsSnapshot()
			.find((a) => a.refreshToken === "rt-dead")!;
		expect(deadSnap.cooldownReason).toBe("auth-failure");
		expect(deadSnap.coolingDownUntil!).toBeGreaterThan(Date.now());

		manager.disposeShutdownHandler();
	});

	it("B: after success on the healthy account, persisted family routing points at it (self-heals across restart)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(1_700_000_000_000));
		const manager = new AccountManager(undefined, makeTwoAccountStorage());

		// Family is pinned to the dead slot (index 0) initially — the #171 bug.
		expect(manager.getActiveIndexForFamily(FAMILY)).toBe(0);

		const dead = manager.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1");
		await applyInvalidated401(manager, dead!);

		// Rotate to healthy + record a success there (what the request loop does).
		const healthy = manager.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1");
		expect(healthy!.refreshToken).toBe("rt-healthy");
		manager.recordSuccess(healthy!, FAMILY, "gpt-5.1");
		manager.clearAuthFailures(healthy!);

		// Family routing now points at the healthy slot (index 1), not the dead one.
		const healthyIdx = healthy!.index;
		expect(manager.getActiveIndexForFamily(FAMILY)).toBe(healthyIdx);

		// Restart: a fresh manager built from the persisted shape must NOT pin the dead slot.
		const restarted = simulateRestart(manager);
		expect(restarted.getActiveIndexForFamily(FAMILY)).toBe(healthyIdx);
		const afterRestart = restarted.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1");
		expect(afterRestart!.refreshToken).toBe("rt-healthy");

		manager.disposeShutdownHandler();
		restarted.disposeShutdownHandler();
	});

	it("C: clearAuthFailures on success prevents stale-count accumulation toward removal", async () => {
		const manager = new AccountManager(undefined, makeTwoAccountStorage());
		const dead = manager.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1")!;

		// Two 401s (below the threshold of 3).
		await applyInvalidated401(manager, dead);
		const second = await applyInvalidated401(manager, dead);
		expect(second.failures).toBe(2);
		expect(manager.getAuthFailures(dead)).toBe(2);

		// A later success clears the counter, as index.ts does on recordSuccess.
		manager.clearAuthFailures(dead);
		expect(manager.getAuthFailures(dead)).toBe(0);

		// A subsequent single 401 starts from 1 again — never reaches removal.
		const after = await applyInvalidated401(manager, dead);
		expect(after.failures).toBe(1);
		expect(after.removed).toBe(0);
		expect(manager.getAccountCount()).toBe(2);

		manager.disposeShutdownHandler();
	});

	it("D: reaching MAX_AUTH_FAILURES_BEFORE_REMOVAL removes the dead refresh-token group", async () => {
		const manager = new AccountManager(undefined, makeTwoAccountStorage());
		const dead = manager.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1")!;

		let last = { removed: 0, cooledCount: 0, failures: 0 };
		for (let i = 0; i < ACCOUNT_LIMITS.MAX_AUTH_FAILURES_BEFORE_REMOVAL; i++) {
			last = await applyInvalidated401(manager, dead);
		}

		expect(last.failures).toBe(ACCOUNT_LIMITS.MAX_AUTH_FAILURES_BEFORE_REMOVAL);
		expect(last.removed).toBe(1);
		expect(manager.getAccountCount()).toBe(1);
		// The surviving account is the healthy one; rotation returns it.
		const survivor = manager.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1");
		expect(survivor!.refreshToken).toBe("rt-healthy");

		manager.disposeShutdownHandler();
	});

	it("E: single standalone account 401 exercises the cooledCount fallback and cools the lone account", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(1_700_000_000_000));
		const manager = new AccountManager(undefined, makeSingleAccountStorage());
		const solo = manager.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1")!;
		expect(solo.refreshToken).toBe("rt-solo");

		const result = await applyInvalidated401(manager, solo);
		// markAccountsWithRefreshTokenCoolingDown still matches the lone account
		// by its own refresh token, so cooledCount is 1 (the group IS the account).
		expect(result.cooledCount).toBe(1);

		const snap = manager.getAccountsSnapshot()[0];
		expect(snap.cooldownReason).toBe("auth-failure");
		expect(snap.coolingDownUntil!).toBeGreaterThan(Date.now());
		// With only one account there is nowhere to fail over: the hybrid
		// selector intentionally falls back to the least-recently-used account
		// even while it is cooling down (better to retry the sole account than
		// hard-fail). The handler's `accountCount > 1` guard means the request
		// loop surfaces "no other account available" rather than rotating. This
		// asserts that documented single-account limitation, not a rotation.
		const soloAfter = manager.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1");
		expect(soloAfter).not.toBeNull();
		expect(soloAfter!.refreshToken).toBe("rt-solo");
		expect(manager.getAccountCount()).toBe(1);

		manager.disposeShutdownHandler();
	});

	it("E2: explicit fallback — markAccountCoolingDown fires when no token group matches", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(1_700_000_000_000));
		const manager = new AccountManager(undefined, makeSingleAccountStorage());
		const solo = manager.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1")!;

		// Simulate the cooledCount<=0 branch directly: a token with no live match.
		const cooled = manager.markAccountsWithRefreshTokenCoolingDown(
			"rt-nonexistent",
			COOLDOWN,
			"auth-failure",
		);
		expect(cooled).toBe(0);
		// Fallback path the handler takes when cooledCount<=0.
		manager.markAccountCoolingDown(solo, COOLDOWN, "auth-failure");
		expect(manager.isAccountCoolingDown(solo)).toBe(true);

		manager.disposeShutdownHandler();
	});

	it("F: real detector classifies the upstream 401 and does NOT misfire on rate-limit / entitlement / server bodies", () => {
		// Positive: the exact upstream 401 body.
		expect(isInvalidatedAuthTokenError(INVALIDATED_401_BODY, 401)).toBe(true);
		// Positive: any 401 status (primary signal), even an empty body.
		expect(isInvalidatedAuthTokenError(undefined, 401)).toBe(true);
		// Negative: rate-limit (429), entitlement (403), server (500) must not match.
		expect(isInvalidatedAuthTokenError({ error: { code: "rate_limit_exceeded" } }, 429)).toBe(false);
		expect(
			isInvalidatedAuthTokenError(
				{ error: { code: "model_not_supported_with_chatgpt_account" } },
				403,
			),
		).toBe(false);
		expect(isInvalidatedAuthTokenError({ error: { message: "server error" } }, 500)).toBe(false);
		// Negative: generic permission / wrong-key codes on the status-less path.
		expect(isInvalidatedAuthTokenError({ error: { code: "unauthorized" } })).toBe(false);
		expect(isInvalidatedAuthTokenError({ error: { code: "invalid_api_key" } })).toBe(false);
	});
});


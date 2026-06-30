/**
 * Deep stress / adversarial coverage for issue #183 — the load-balancing
 * `rotationStrategy` selectors (sticky / round-robin / hybrid).
 *
 * Unlike test/rotation-strategy.test.ts (focused unit behavior), this suite
 * drives the REAL AccountManager + AccountRotation + health/token trackers
 * through hostile sequences: flapping rate-limits, mid-rotation account
 * removal + reindexing, disable/enable churn, all-cooldown, single-account
 * pools, strategy switching mid-session, and simulated restarts. The goal is
 * to surface hidden coupling bugs between the new sticky path and the existing
 * positional-index state (cursorByFamily / currentAccountIndexByFamily) and the
 * index-keyed trackers remapped on removal.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";

import { AccountManager } from "../../lib/accounts.js";
import type { AccountStorageV3 } from "../../lib/storage.js";
import type { ModelFamily } from "../../lib/prompts/codex.js";
import { resetTrackers } from "../../lib/rotation.js";
import type { RotationStrategy } from "../../lib/config.js";

const FAMILY: ModelFamily = "codex";
const MODEL = "gpt-5.1";

const liveManagers: AccountManager[] = [];

function makeManager(count: number): AccountManager {
	const now = 1_700_000_000_000;
	const storage: AccountStorageV3 = {
		version: 3,
		activeIndex: 0,
		accounts: Array.from({ length: count }, (_v, idx) => ({
			email: `acct${idx + 1}@example.com`,
			refreshToken: `rt-${idx + 1}`,
			addedAt: now - (count - idx) * 1000,
			lastUsed: now - (count - idx) * 500,
			rateLimitResetTimes: {},
		})),
		activeIndexByFamily: { codex: 0 },
	};
	const manager = new AccountManager(undefined, storage);
	liveManagers.push(manager);
	return manager;
}

function pick(manager: AccountManager, strategy: RotationStrategy): number | null {
	const account = manager.getAccountForStrategy(strategy, FAMILY, MODEL);
	return account ? account.index : null;
}

describe("chaos/rotation-strategy — adversarial selection (issue #183)", () => {
	beforeEach(() => {
		resetTrackers();
	});

	afterEach(() => {
		while (liveManagers.length > 0) {
			liveManagers.pop()?.disposeShutdownHandler();
		}
		resetTrackers();
	});

	it("sticky never spreads: 100 calls on a healthy pool all hit one account", () => {
		const manager = makeManager(5);
		const picks = new Set<number>();
		for (let i = 0; i < 100; i++) picks.add(pick(manager, "sticky")!);
		expect(picks.size).toBe(1);
		expect([...picks][0]).toBe(0);
	});

	it("sticky drains the whole pool in order under sequential exhaustion, then returns null", () => {
		const manager = makeManager(4);
		const drainOrder: number[] = [];
		// Exhaust accounts one at a time; sticky should hand out 0,1,2,3 then null.
		for (let expected = 0; expected < 4; expected++) {
			const idx = pick(manager, "sticky");
			expect(idx).toBe(expected);
			drainOrder.push(idx!);
			const account = manager.getAccountsSnapshot()[idx!];
			// Re-fetch the LIVE account (snapshot is a copy) and rate-limit it.
			const live = manager.getAccountForStrategy("sticky", FAMILY, MODEL)!;
			manager.markRateLimited(live, 60_000, FAMILY, MODEL);
			expect(account).toBeDefined();
		}
		expect(drainOrder).toEqual([0, 1, 2, 3]);
		expect(pick(manager, "sticky")).toBeNull();
	});

	it("sticky recovers to the lowest-index account when an earlier one's limit expires", () => {
		const manager = makeManager(3);
		// Pin + rate-limit account 0 for a short window.
		const a0 = manager.getAccountForStrategy("sticky", FAMILY, MODEL)!;
		expect(a0.index).toBe(0);
		manager.markRateLimited(a0, 50, FAMILY, MODEL);
		// Now account 1 is chosen and pinned.
		expect(pick(manager, "sticky")).toBe(1);
		// Rate-limit 1 too, with a long window.
		const a1 = manager.getAccountForStrategy("sticky", FAMILY, MODEL)!;
		manager.markRateLimited(a1, 60_000, FAMILY, MODEL);
		// 0's short window has elapsed in wall-clock terms only if enough time
		// passed; emulate by clearing via a fresh short expiry already elapsed.
		// Force 0 back to healthy by marking with 0ms (immediate expiry).
		manager.markRateLimited(a0, 0, FAMILY, MODEL);
		// Lowest available is 0 again (its 0ms limit is already expired), not 2.
		expect(pick(manager, "sticky")).toBe(0);
	});

	it("round-robin is fair: 6 calls over 3 accounts hit each exactly twice", () => {
		const manager = makeManager(3);
		const counts = new Map<number, number>();
		for (let i = 0; i < 6; i++) {
			const idx = pick(manager, "round-robin")!;
			counts.set(idx, (counts.get(idx) ?? 0) + 1);
		}
		expect([...counts.entries()].sort()).toEqual([
			[0, 2],
			[1, 2],
			[2, 2],
		]);
	});

	it("round-robin skips a rate-limited account without stalling", () => {
		const manager = makeManager(3);
		// Rate-limit account 1.
		const first = manager.getAccountForStrategy("round-robin", FAMILY, MODEL)!; // 0
		const second = manager.getAccountForStrategy("round-robin", FAMILY, MODEL)!; // 1
		expect(second.index).toBe(1);
		manager.markRateLimited(second, 60_000, FAMILY, MODEL);
		// Subsequent picks should only see 0 and 2.
		const seen = new Set<number>();
		for (let i = 0; i < 10; i++) {
			const idx = pick(manager, "round-robin");
			if (idx !== null) seen.add(idx);
		}
		expect(seen.has(1)).toBe(false);
		expect(seen.has(0) || seen.has(2)).toBe(true);
		expect(first.index).toBe(0);
	});

	it("switching strategy mid-session does not corrupt selection state", () => {
		const manager = makeManager(3);
		// Start sticky on 0.
		expect(pick(manager, "sticky")).toBe(0);
		// Switch to round-robin: it should advance from the cursor, not crash.
		const rr1 = pick(manager, "round-robin");
		const rr2 = pick(manager, "round-robin");
		expect(rr1).not.toBeNull();
		expect(rr2).not.toBeNull();
		expect(rr1).not.toBe(rr2);
		// Back to sticky: stays on whatever is current and healthy.
		const s1 = pick(manager, "sticky");
		const s2 = pick(manager, "sticky");
		expect(s1).toBe(s2);
	});

	it("sticky handles the pinned account being REMOVED mid-session (reindex safety)", () => {
		const manager = makeManager(4);
		// Pin account 2.
		const a0 = manager.getAccountForStrategy("sticky", FAMILY, MODEL)!; // 0
		manager.markRateLimited(a0, 60_000, FAMILY, MODEL);
		const a1 = manager.getAccountForStrategy("sticky", FAMILY, MODEL)!; // 1
		manager.markRateLimited(a1, 60_000, FAMILY, MODEL);
		const pinned = manager.getAccountForStrategy("sticky", FAMILY, MODEL)!; // 2
		expect(pinned.index).toBe(2);
		// Remove the pinned account; survivors reindex.
		expect(manager.removeAccountByIndex(2)).toBe(true);
		// Selector must not throw and must return a valid in-range account or null.
		const after = manager.getAccountForStrategy("sticky", FAMILY, MODEL);
		if (after) {
			expect(after.index).toBeGreaterThanOrEqual(0);
			expect(after.index).toBeLessThan(manager.getAccountCount());
		}
		// The two earlier accounts (now indices 0,1) are still rate-limited, the
		// old index-3 account (now index 2) is healthy → it should be selected.
		expect(after?.email).toBe("acct4@example.com");
	});

	it("sticky on a single-account pool keeps returning that account, null when limited", () => {
		const manager = makeManager(1);
		expect(pick(manager, "sticky")).toBe(0);
		expect(pick(manager, "sticky")).toBe(0);
		const only = manager.getAccountForStrategy("sticky", FAMILY, MODEL)!;
		manager.markRateLimited(only, 60_000, FAMILY, MODEL);
		expect(pick(manager, "sticky")).toBeNull();
	});

	it("all strategies return null on an empty pool and never throw", () => {
		const manager = makeManager(2);
		expect(manager.removeAccountByIndex(0)).toBe(true);
		expect(manager.removeAccountByIndex(0)).toBe(true);
		expect(manager.getAccountCount()).toBe(0);
		for (const strategy of ["sticky", "round-robin", "hybrid"] as RotationStrategy[]) {
			expect(pick(manager, strategy)).toBeNull();
		}
	});

	it("sticky skips disabled accounts even when one is the pinned index", () => {
		const manager = makeManager(3);
		expect(pick(manager, "sticky")).toBe(0); // pin 0
		manager.setAccountEnabled(0, false); // disable the pinned account
		expect(pick(manager, "sticky")).toBe(1); // moves to next available
		manager.setAccountEnabled(0, true); // re-enable
		// Still pinned on 1 (1 is healthy), does NOT jump back to 0.
		expect(pick(manager, "sticky")).toBe(1);
	});

	it("survives a simulated restart: sticky pin persists via activeIndexByFamily", () => {
		const manager = makeManager(3);
		// Drain 0, land on 1.
		const a0 = manager.getAccountForStrategy("sticky", FAMILY, MODEL)!;
		manager.markRateLimited(a0, 60_000, FAMILY, MODEL);
		expect(pick(manager, "sticky")).toBe(1);
		// Simulate restart: rebuild from storage that pins family to index 1.
		const restarted = new AccountManager(undefined, {
			version: 3,
			activeIndex: 1,
			accounts: [
				{ email: "acct1@example.com", refreshToken: "rt-1", addedAt: 1, lastUsed: 1, rateLimitResetTimes: {} },
				{ email: "acct2@example.com", refreshToken: "rt-2", addedAt: 2, lastUsed: 2, rateLimitResetTimes: {} },
				{ email: "acct3@example.com", refreshToken: "rt-3", addedAt: 3, lastUsed: 3, rateLimitResetTimes: {} },
			],
			activeIndexByFamily: { codex: 1 },
		});
		liveManagers.push(restarted);
		// After restart sticky resumes on the persisted pin (index 1).
		expect(restarted.getAccountForStrategy("sticky", FAMILY, MODEL)?.index).toBe(1);
	});
});

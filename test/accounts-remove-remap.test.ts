/**
 * End-to-end regression test for AccountManager.removeAccount tracker remap
 * (audit fix #2). Companion to test/rotation-remap.test.ts which tests the
 * tracker remap units directly; this one drives the real manager + singleton
 * trackers through getSelectionExplainability, which is how the rest of the
 * system observes per-account health / token-bucket state.
 *
 * Topology: 3 accounts at indices 0,1,2 with DISTINCT health and token-bucket
 * state. Remove the middle account (index 1). The survivor that was at index 2
 * is reindexed to 1.
 *
 *   OLD behavior (no tracker remap on removal): the reindexed survivor would
 *   read index 1's state — i.e. the REMOVED account's drained bucket / damaged
 *   health — because tracker keys never followed the reindex.
 *   NEW behavior: each survivor keeps its OWN heuristic state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { getHealthTracker, getTokenTracker, resetTrackers } from "../lib/rotation.js";
import { DEFAULT_TOKEN_BUCKET_CONFIG } from "../lib/rotation.js";

describe("AccountManager.removeAccount end-to-end tracker remap", () => {
	beforeEach(() => {
		// Freeze time so token buckets don't refill between drain and read.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));
		// Trackers are process-level singletons; isolate from other suites.
		resetTrackers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function buildManager(): AccountManager {
		const now = Date.now();
		const stored = {
			version: 3 as const,
			activeIndex: 0,
			accounts: [
				{ refreshToken: "token-0", addedAt: now, lastUsed: now },
				{ refreshToken: "token-1", addedAt: now, lastUsed: now },
				{ refreshToken: "token-2", addedAt: now, lastUsed: now },
			],
		};
		return new AccountManager(undefined, stored);
	}

	it("survivors keep their own health + token state after the middle account is removed", () => {
		const manager = buildManager();
		const health = getHealthTracker();
		const tokens = getTokenTracker();
		const quotaKey = "codex"; // getSelectionExplainability("codex") with no model

		// Distinct, observable state per account index.
		tokens.drain(0, quotaKey, 5);
		tokens.drain(1, quotaKey, 15);
		tokens.drain(2, quotaKey, 25);
		health.recordFailure(0, quotaKey); // 1 failure
		health.recordFailure(1, quotaKey);
		health.recordFailure(1, quotaKey); // 2 failures
		health.recordFailure(2, quotaKey);
		health.recordFailure(2, quotaKey);
		health.recordFailure(2, quotaKey); // 3 failures

		const max = DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens;
		const account0Tokens = max - 5;
		const account1Tokens = max - 15; // the removed account's value
		const account2Tokens = max - 25;
		const account0Health = health.getScore(0, quotaKey);
		const account2Health = health.getScore(2, quotaKey);
		// Sanity: every account's state is distinct so the remap is observable.
		expect(new Set([account0Tokens, account1Tokens, account2Tokens]).size).toBe(3);

		// Remove the middle account (index 1) using a live reference.
		const middle = manager.setActiveIndex(1)!;
		expect(middle.refreshToken).toBe("token-1");
		expect(manager.removeAccount(middle)).toBe(true);
		expect(manager.getAccountCount()).toBe(2);

		const explain = manager.getSelectionExplainability("codex");
		const byIndex = new Map(explain.map((e) => [e.index, e]));

		// Account 0 (unchanged position) keeps its own state.
		expect(byIndex.get(0)?.tokensAvailable).toBe(account0Tokens);
		expect(byIndex.get(0)?.healthScore).toBe(account0Health);

		// The survivor formerly at index 2 is now at index 1 and MUST carry its
		// OWN state. OLD behavior would have surfaced the removed account's
		// values (account1Tokens / index-1 health) here.
		expect(byIndex.get(1)?.tokensAvailable).toBe(account2Tokens);
		expect(byIndex.get(1)?.healthScore).toBe(account2Health);

		// The removed account's distinctive bucket value must not survive on any
		// remaining account.
		const survivorTokenValues = explain.map((e) => e.tokensAvailable);
		expect(survivorTokenValues).not.toContain(account1Tokens);
	});

	it("removing the first account shifts every survivor's state down by one", () => {
		const manager = buildManager();
		const tokens = getTokenTracker();
		const quotaKey = "codex";

		tokens.drain(0, quotaKey, 5);
		tokens.drain(1, quotaKey, 15);
		tokens.drain(2, quotaKey, 25);
		const max = DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens;

		const first = manager.setActiveIndex(0)!;
		expect(manager.removeAccount(first)).toBe(true);

		const explain = manager.getSelectionExplainability("codex");
		const byIndex = new Map(explain.map((e) => [e.index, e]));

		// old index 1 -> 0, old index 2 -> 1.
		expect(byIndex.get(0)?.tokensAvailable).toBe(max - 15);
		expect(byIndex.get(1)?.tokensAvailable).toBe(max - 25);
		// The removed account's value (max - 5) is gone.
		expect(explain.map((e) => e.tokensAvailable)).not.toContain(max - 5);
	});
});

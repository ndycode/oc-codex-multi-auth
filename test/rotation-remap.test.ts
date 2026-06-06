/**
 * Regression tests for tracker index-remap on account removal (audit fix #1).
 *
 * The rotation heuristic trackers (health score, token bucket, rate-limit
 * backoff) are keyed by the MUTABLE positional `account.index`. When an account
 * is removed, survivors are reindexed in place (every account above the removed
 * slot shifts down by one). Before the fix there was no remap step, so a
 * surviving account silently inherited the removed (or a shifted neighbor's)
 * heuristic state — a low health score / drained bucket would jump to the wrong
 * account.
 *
 * These tests exercise `remapIndexedKeys`, `HealthScoreTracker.remapAfterRemoval`,
 * `TokenBucketTracker.remapAfterRemoval`, and `remapRateLimitBackoffAfterRemoval`
 * directly. On the OLD behavior (no remap / no-op) the post-removal lookups would
 * return the pre-removal slot's value (or maxScore/maxTokens/attempt=1); the
 * assertions below require the values to follow their account down by one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	remapIndexedKeys,
	HealthScoreTracker,
	TokenBucketTracker,
	DEFAULT_HEALTH_SCORE_CONFIG,
	DEFAULT_TOKEN_BUCKET_CONFIG,
} from "../lib/rotation.js";
import {
	clearRateLimitBackoffState,
	getRateLimitBackoff,
	remapRateLimitBackoffAfterRemoval,
} from "../lib/request/rate-limit-backoff.js";

describe("remapIndexedKeys (pure helper)", () => {
	it("drops the removed index, shifts higher indices down, keeps lower indices", () => {
		const source = new Map<string, string>([
			["0", "a"],
			["1", "b"],
			["2", "c"],
			["3", "d"],
		]);

		const next = remapIndexedKeys(source, 1);

		// Lower index unchanged.
		expect(next.get("0")).toBe("a");
		// Removed index's entry is gone (its old value "b" must not survive).
		// Old behavior (no shift) would have left "b" at key "1".
		expect(next.get("1")).toBe("c"); // old "2" shifted down
		expect(next.get("2")).toBe("d"); // old "3" shifted down
		expect(next.has("3")).toBe(false);
		expect([...next.values()]).not.toContain("b");
		expect(next.size).toBe(3);
	});

	it("remaps quotaKey-suffixed keys (`${index}:${quotaKey}`) by their leading index", () => {
		const source = new Map<string, string>([
			["0:codex", "zero"],
			["1:codex", "one"],
			["2:codex", "two"],
			["2:gpt-5.2", "two-model"],
		]);

		const next = remapIndexedKeys(source, 1);

		expect(next.get("0:codex")).toBe("zero"); // unchanged
		// old index "1" is removed; old index "2:*" shifts down to "1:*" with the
		// quotaKey suffix preserved.
		expect([...next.keys()].sort()).toEqual(["0:codex", "1:codex", "1:gpt-5.2"]);
		expect(next.get("1:codex")).toBe("two");
		expect(next.get("1:gpt-5.2")).toBe("two-model");
	});

	it("preserves keys that do not parse to a leading integer", () => {
		const source = new Map<string, string>([
			["0", "zero"],
			["global", "kept"],
			["1", "one"],
		]);

		const next = remapIndexedKeys(source, 0);

		// Non-index key is preserved untouched.
		expect(next.get("global")).toBe("kept");
		// index 0 removed, index 1 -> 0.
		expect(next.get("0")).toBe("one");
		expect(next.has("1")).toBe(false);
	});
});

describe("HealthScoreTracker.remapAfterRemoval", () => {
	let tracker: HealthScoreTracker;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));
		tracker = new HealthScoreTracker();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shifts higher-index scores down and drops the removed index", () => {
		// Distinct scores per account via differing failure counts.
		tracker.recordFailure(0); // 1 failure
		tracker.recordFailure(1);
		tracker.recordFailure(1); // 2 failures
		tracker.recordFailure(2);
		tracker.recordFailure(2);
		tracker.recordFailure(2); // 3 failures
		const before = [0, 1, 2, 3].map((i) => tracker.getScore(i));
		// Sanity: scores are distinct and below max so the shift is observable.
		expect(before[0]).toBeGreaterThan(before[1]!);
		expect(before[1]).toBeGreaterThan(before[2]!);
		expect(before[3]).toBe(DEFAULT_HEALTH_SCORE_CONFIG.maxScore);

		tracker.remapAfterRemoval(1);

		// Lower index keeps its own score.
		expect(tracker.getScore(0)).toBe(before[0]);
		// OLD behavior: getScore(1) would still equal before[1] (the removed
		// account's score). NEW behavior: old index 2's score follows down to 1.
		expect(tracker.getScore(1)).toBe(before[2]);
		// Index 2 now has no entry (old index 3 was unset -> maxScore).
		expect(tracker.getScore(2)).toBe(DEFAULT_HEALTH_SCORE_CONFIG.maxScore);
	});

	it("remaps quotaKey-scoped scores to the shifted index", () => {
		tracker.recordRateLimit(2, "codex");
		const before2 = tracker.getScore(2, "codex");
		expect(before2).toBeLessThan(DEFAULT_HEALTH_SCORE_CONFIG.maxScore);

		tracker.remapAfterRemoval(1);

		// old (2,"codex") -> (1,"codex").
		expect(tracker.getScore(1, "codex")).toBe(before2);
		// The vacated original slot reads as a fresh (max) score.
		expect(tracker.getScore(2, "codex")).toBe(
			DEFAULT_HEALTH_SCORE_CONFIG.maxScore,
		);
	});
});

describe("TokenBucketTracker.remapAfterRemoval", () => {
	let tracker: TokenBucketTracker;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-30T12:00:00Z"));
		tracker = new TokenBucketTracker();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shifts higher-index buckets down and drops the removed index", () => {
		tracker.drain(0, undefined, 10);
		tracker.drain(1, undefined, 20);
		tracker.drain(2, undefined, 30);
		tracker.drain(3, undefined, 40);
		const before = [0, 1, 2, 3].map((i) => tracker.getTokens(i));

		tracker.remapAfterRemoval(1);

		// Lower index unchanged.
		expect(tracker.getTokens(0)).toBe(before[0]);
		// OLD behavior: getTokens(1) would still read the removed account's 30
		// remaining (20 drained). NEW behavior: old index 2 (30 drained) -> 1.
		expect(tracker.getTokens(1)).toBe(before[2]);
		expect(tracker.getTokens(2)).toBe(before[3]);
		// Old top index now empty -> full bucket.
		expect(tracker.getTokens(3)).toBe(DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens);
	});

	it("remaps quotaKey-scoped buckets to the shifted index", () => {
		tracker.drain(2, "codex", 25);
		const before = tracker.getTokens(2, "codex");
		expect(before).toBe(DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens - 25);

		tracker.remapAfterRemoval(1);

		expect(tracker.getTokens(1, "codex")).toBe(before);
		expect(tracker.getTokens(2, "codex")).toBe(
			DEFAULT_TOKEN_BUCKET_CONFIG.maxTokens,
		);
	});
});

describe("remapRateLimitBackoffAfterRemoval", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));
		clearRateLimitBackoffState();
	});

	afterEach(() => {
		clearRateLimitBackoffState();
		vi.useRealTimers();
	});

	it("moves a higher account's backoff schedule down to its new index", () => {
		// Build attempt=2 backoff state on index 2.
		const first = getRateLimitBackoff(2, "codex", 1000);
		expect(first.attempt).toBe(1);
		vi.setSystemTime(new Date(2500)); // past the 2s dedup window
		const second = getRateLimitBackoff(2, "codex", 1000);
		expect(second.attempt).toBe(2);

		// Remove account index 1; survivors shift down so old index 2 -> 1.
		remapRateLimitBackoffAfterRemoval(1);

		vi.setSystemTime(new Date(5000)); // still inside the 120s reset window
		// NEW behavior: the shifted state is found at index 1, so the counter
		// continues to attempt 3. OLD behavior (no remap): index 1 had no state,
		// so this would reset to attempt 1.
		const continued = getRateLimitBackoff(1, "codex", 1000);
		expect(continued.attempt).toBe(3);
	});

	it("drops the removed index's backoff state", () => {
		getRateLimitBackoff(1, "codex", 1000);
		vi.setSystemTime(new Date(2500));
		getRateLimitBackoff(1, "codex", 1000); // attempt 2 at index 1

		remapRateLimitBackoffAfterRemoval(1);

		vi.setSystemTime(new Date(5000));
		// Index 1's old state was dropped (the removed account). What remains at
		// index 1 is whatever shifted down from index 2 — here nothing did, so a
		// fresh query starts at attempt 1.
		const afterRemoval = getRateLimitBackoff(1, "codex", 1000);
		expect(afterRemoval.attempt).toBe(1);
	});

	it("leaves lower indices' backoff schedules unchanged", () => {
		getRateLimitBackoff(0, "codex", 1000);
		vi.setSystemTime(new Date(2500));
		getRateLimitBackoff(0, "codex", 1000); // attempt 2 at index 0

		remapRateLimitBackoffAfterRemoval(2); // remove a higher index

		vi.setSystemTime(new Date(5000));
		const continued = getRateLimitBackoff(0, "codex", 1000);
		expect(continued.attempt).toBe(3); // index 0 untouched, keeps counting
	});
});

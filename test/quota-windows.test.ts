import { describe, expect, it, vi } from "vitest";

import { AccountManager } from "../lib/accounts.js";
import {
	getQuotaExhaustedResetAtMs,
	isQuotaWindowDisabled,
	isQuotaWindowExhausted,
	parseCodexQuotaWindows,
} from "../lib/quota-windows.js";
import { handleErrorResponse } from "../lib/request/fetch-helpers.js";

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

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function epochSeconds(offsetMs: number): string {
	return String(Math.floor((Date.now() + offsetMs) / 1000));
}

/** Headers as returned for an account whose weekly window is fully spent. */
function weeklyExhaustedHeaders(extra: Record<string, string> = {}): Headers {
	return new Headers({
		"x-codex-primary-used-percent": "40",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-at": epochSeconds(FIVE_HOURS_MS),
		"x-codex-secondary-used-percent": "100",
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-reset-at": epochSeconds(SEVEN_DAYS_MS),
		...extra,
	});
}

describe("parseCodexQuotaWindows", () => {
	it("reads both windows from the Codex quota headers", () => {
		const windows = parseCodexQuotaWindows(weeklyExhaustedHeaders());

		expect(windows).toHaveLength(2);
		expect(windows[0]).toMatchObject({
			kind: "primary",
			usedPercent: 40,
			windowMinutes: 300,
		});
		expect(windows[1]).toMatchObject({
			kind: "secondary",
			usedPercent: 100,
			windowMinutes: 10080,
		});
		expect(windows[1]?.resetAtMs).toBeGreaterThan(Date.now() + SEVEN_DAYS_MS - 60_000);
	});

	it("accepts a relative reset-after-seconds header", () => {
		const windows = parseCodexQuotaWindows(
			new Headers({
				"x-codex-secondary-used-percent": "100",
				"x-codex-secondary-window-minutes": "10080",
				"x-codex-secondary-reset-after-seconds": "3600",
			}),
		);

		const secondary = windows.find((window) => window.kind === "secondary");
		expect(secondary?.resetAtMs).toBeGreaterThan(Date.now() + 3_500_000);
	});

	it("accepts an ISO-8601 reset-at header", () => {
		const resetAt = new Date(Date.now() + SEVEN_DAYS_MS).toISOString();
		const windows = parseCodexQuotaWindows(
			new Headers({
				"x-codex-secondary-used-percent": "100",
				"x-codex-secondary-reset-at": resetAt,
			}),
		);

		expect(windows.find((window) => window.kind === "secondary")?.resetAtMs).toBe(
			Date.parse(resetAt),
		);
	});

	it("returns an empty list when no quota headers are present", () => {
		expect(parseCodexQuotaWindows(new Headers({ "retry-after": "30" }))).toEqual([]);
	});
});

describe("isQuotaWindowExhausted", () => {
	it("treats a window at or above 100% used as exhausted", () => {
		expect(isQuotaWindowExhausted({ kind: "secondary", usedPercent: 100 })).toBe(true);
		expect(isQuotaWindowExhausted({ kind: "secondary", usedPercent: 100.4 })).toBe(true);
		expect(isQuotaWindowExhausted({ kind: "primary", usedPercent: 99 })).toBe(false);
		expect(isQuotaWindowExhausted({ kind: "primary" })).toBe(false);
	});

	it("never treats a plan-disabled window as exhausted", () => {
		const disabled = { kind: "primary" as const, usedPercent: 100, windowMinutes: 0 };
		expect(isQuotaWindowDisabled(disabled)).toBe(true);
		expect(isQuotaWindowExhausted(disabled)).toBe(false);
	});
});

describe("getQuotaExhaustedResetAtMs", () => {
	it("returns the weekly reset when only the weekly window is spent", () => {
		const resetAtMs = getQuotaExhaustedResetAtMs(weeklyExhaustedHeaders());

		expect(resetAtMs).toBeDefined();
		expect(resetAtMs! - Date.now()).toBeGreaterThan(SEVEN_DAYS_MS - 60_000);
	});

	it("returns the latest reset when both windows are spent", () => {
		const resetAtMs = getQuotaExhaustedResetAtMs(
			weeklyExhaustedHeaders({ "x-codex-primary-used-percent": "100" }),
		);

		expect(resetAtMs! - Date.now()).toBeGreaterThan(SEVEN_DAYS_MS - 60_000);
	});

	it("returns undefined when nothing is exhausted", () => {
		expect(
			getQuotaExhaustedResetAtMs(
				weeklyExhaustedHeaders({ "x-codex-secondary-used-percent": "60" }),
			),
		).toBeUndefined();
	});

	it("returns undefined when the exhausted window has no future reset", () => {
		expect(
			getQuotaExhaustedResetAtMs(
				new Headers({
					"x-codex-secondary-used-percent": "100",
					"x-codex-secondary-reset-at": epochSeconds(-60_000),
				}),
			),
		).toBeUndefined();
	});
});

describe("handleErrorResponse weekly quota reset (issue #218)", () => {
	it("blocks until the weekly reset instead of the sooner 5h reset", async () => {
		const response = new Response(
			JSON.stringify({ error: { code: "usage_limit_reached" } }),
			{ status: 429, headers: weeklyExhaustedHeaders() },
		);

		const { rateLimit } = await handleErrorResponse(response);

		expect(rateLimit?.retryAfterMs).toBeGreaterThan(SEVEN_DAYS_MS - 60_000);
	});

	it("is not truncated by a short retry-after when the weekly window is spent", async () => {
		const response = new Response(
			JSON.stringify({ error: { code: "usage_limit_reached", retry_after: 30 } }),
			{
				status: 429,
				headers: weeklyExhaustedHeaders({ "retry-after": "30" }),
			},
		);

		const { rateLimit } = await handleErrorResponse(response);

		expect(rateLimit?.retryAfterMs).toBeGreaterThan(SEVEN_DAYS_MS - 60_000);
	});

	it("still prefers the soonest reset when no window reports exhaustion", async () => {
		const response = new Response(
			JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
			{
				status: 429,
				headers: new Headers({
					"x-codex-primary-reset-at": epochSeconds(FIVE_HOURS_MS),
					"x-codex-secondary-reset-at": epochSeconds(SEVEN_DAYS_MS),
				}),
			},
		);

		const { rateLimit } = await handleErrorResponse(response);

		expect(rateLimit?.retryAfterMs).toBeLessThan(FIVE_HOURS_MS + 60_000);
		expect(rateLimit?.retryAfterMs).toBeGreaterThan(FIVE_HOURS_MS - 60_000);
	});

	it("uses a relative reset header on an ordinary throttle", async () => {
		const response = new Response(
			JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
			{
				status: 429,
				headers: new Headers({
					"x-codex-primary-used-percent": "80",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-after-seconds": "900",
				}),
			},
		);

		const { rateLimit } = await handleErrorResponse(response);

		// Not the 60s default: the backend told us when the window rolls over.
		expect(rateLimit?.retryAfterMs).toBeGreaterThan(890_000);
		expect(rateLimit?.retryAfterMs).toBeLessThanOrEqual(900_000);
	});

	it("uses an ISO reset header on an ordinary throttle", async () => {
		const response = new Response(
			JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
			{
				status: 429,
				headers: new Headers({
					"x-codex-primary-used-percent": "80",
					"x-codex-primary-reset-at": new Date(
						Date.now() + 15 * 60 * 1000,
					).toISOString(),
				}),
			},
		);

		const { rateLimit } = await handleErrorResponse(response);

		expect(rateLimit?.retryAfterMs).toBeGreaterThan(890_000);
		expect(rateLimit?.retryAfterMs).toBeLessThanOrEqual(900_000);
	});

	it("ignores a plan-disabled window when picking an ordinary throttle reset", async () => {
		const response = new Response(
			JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
			{
				status: 429,
				headers: new Headers({
					"x-codex-primary-used-percent": "0",
					"x-codex-primary-window-minutes": "0",
					"x-codex-primary-reset-after-seconds": "60",
					"x-codex-secondary-used-percent": "80",
					"x-codex-secondary-window-minutes": "10080",
					"x-codex-secondary-reset-after-seconds": "900",
				}),
			},
		);

		const { rateLimit } = await handleErrorResponse(response);

		expect(rateLimit?.retryAfterMs).toBeGreaterThan(890_000);
	});

	it("keeps the short retry-after when the 429 is not a quota exhaustion", async () => {
		const response = new Response(
			JSON.stringify({ error: { code: "rate_limit_exceeded", retry_after_ms: 1750 } }),
			{ status: 429 },
		);

		const { rateLimit } = await handleErrorResponse(response);

		expect(rateLimit?.retryAfterMs).toBe(1750);
	});
});

describe("AccountManager.markQuotaExhausted (issue #218)", () => {
	function buildManager() {
		const now = Date.now();
		return new AccountManager(undefined, {
			version: 3 as const,
			activeIndex: 0,
			accounts: [
				{ refreshToken: "token-1", addedAt: now, lastUsed: now },
				{ refreshToken: "token-2", addedAt: now, lastUsed: now },
			],
		});
	}

	it("keeps a weekly-exhausted account out of rotation", () => {
		const manager = buildManager();
		const first = manager.getCurrentOrNext();
		expect(first?.refreshToken).toBe("token-1");

		const changed = manager.markQuotaExhausted(
			first!,
			Date.now() + SEVEN_DAYS_MS,
			"codex",
		);
		expect(changed).toBe(true);

		expect(manager.getCurrentOrNext()?.refreshToken).toBe("token-2");
		expect(manager.getCurrentOrNext()?.refreshToken).toBe("token-2");
	});

	it("records shared quota separately from rate limits", () => {
		const manager = buildManager();
		const account = manager.getCurrentOrNext()!;
		manager.markQuotaExhausted(account, Date.now() + SEVEN_DAYS_MS, "codex");
		expect(account.lastRateLimitReason).toBe("quota");
		expect(account.quotaExhaustedUntil).toBeGreaterThan(Date.now());
		expect(account.rateLimitResetTimes).toEqual({});
	});

	it("never shortens an existing longer block", () => {
		const manager = buildManager();
		const account = manager.getCurrentOrNext()!;
		const weeklyReset = Date.now() + SEVEN_DAYS_MS;

		expect(manager.markQuotaExhausted(account, weeklyReset, "codex")).toBe(true);
		expect(manager.markQuotaExhausted(account, Date.now() + 60_000, "codex")).toBe(false);
		expect(account.quotaExhaustedUntil).toBe(weeklyReset);
	});

	it("is not shortened by a later ordinary rate limit", () => {
		const manager = buildManager();
		const account = manager.getCurrentOrNext()!;
		const weeklyReset = Date.now() + SEVEN_DAYS_MS;

		manager.markQuotaExhausted(account, weeklyReset, "codex", "gpt-5-codex");
		// A concurrent in-flight request lands a plain 429 with a 30s
		// retry-after; it must not pull the weekly block forward.
		manager.markRateLimitedWithReason(
			account,
			30_000,
			"codex",
			"tokens",
			"gpt-5-codex",
		);

		expect(account.quotaExhaustedUntil).toBe(weeklyReset);
		expect(account.rateLimitResetTimes.codex).toBeLessThan(weeklyReset);
		expect(account.rateLimitResetTimes["codex:gpt-5-codex"]).toBe(account.rateLimitResetTimes.codex);
		expect(account.lastRateLimitReason).toBe("tokens");
		expect(manager.getCurrentOrNext()?.refreshToken).toBe("token-2");
	});

	it("still lets a zero-length rate limit clear a block", () => {
		const manager = buildManager();
		const account = manager.getCurrentOrNext()!;

		manager.markRateLimited(account, 60_000, "codex");
		expect(account.rateLimitResetTimes.codex).toBeDefined();

		manager.markRateLimited(account, 0, "codex");
		expect(account.rateLimitResetTimes.codex).toBeUndefined();
	});

	it("still lets an ordinary rate limit extend a shorter block", () => {
		const manager = buildManager();
		const account = manager.getCurrentOrNext()!;

		manager.markRateLimitedWithReason(account, 30_000, "codex", "tokens");
		const shortReset = account.rateLimitResetTimes.codex!;
		manager.markRateLimitedWithReason(account, 10 * 60_000, "codex", "quota");

		expect(account.rateLimitResetTimes.codex).toBeGreaterThan(shortReset);
	});

	it.each([NaN, Infinity, -Infinity, -1000, 0])("ignores an invalid or elapsed reset %s", (offset) => {
		const manager = buildManager();
		const account = manager.getCurrentOrNext()!;

		expect(manager.markQuotaExhausted(account, Date.now() + offset, "codex")).toBe(false);
		expect(account.quotaExhaustedUntil).toBeUndefined();
		expect(account.rateLimitResetTimes.codex).toBeUndefined();
	});

	it("blocks other models without manufacturing model-scoped rate limits", () => {
		const manager = buildManager();
		const account = manager.getCurrentOrNext()!;
		const weeklyReset = Date.now() + SEVEN_DAYS_MS;

		manager.markQuotaExhausted(account, weeklyReset, "codex", "gpt-5-codex");

		expect(account.quotaExhaustedUntil).toBe(weeklyReset);
		expect(account.rateLimitResetTimes).toEqual({});
		expect(manager.getCurrentOrNextForFamily("gpt-5.1", "gpt-5.1")?.refreshToken).toBe("token-2");
	});
});

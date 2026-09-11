/**
 * A reset time further out than any real Codex window is a garbled header, not
 * a quota window — and believing one used to be permanent, because the block it
 * produces is written monotonically into the persisted `rateLimitResetTimes`
 * map. These cover the horizon guard on every path a reset can arrive by.
 */
import { describe, it, expect, vi } from "vitest";
import {
	MAX_QUOTA_RESET_HORIZON_MS,
	getQuotaExhaustedResetAtMs,
	parseQuotaResetAtMs,
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

const HOUR_MS = 60 * 60 * 1000;
const PREFIX = "x-codex-primary";
const headers = (o: Record<string, string>) => new Headers(o);

describe("quota reset horizon", () => {
	const now = 1_700_000_000_000;

	it("keeps a plausible reset-after-seconds", () => {
		const at = parseQuotaResetAtMs(
			headers({ [`${PREFIX}-reset-after-seconds`]: "18000" }),
			PREFIX,
			now,
		);
		expect(at).toBe(now + 5 * HOUR_MS);
	});

	it("keeps a full weekly window", () => {
		const at = parseQuotaResetAtMs(
			headers({ [`${PREFIX}-reset-after-seconds`]: String(7 * 24 * 60 * 60) }),
			PREFIX,
			now,
		);
		expect(at).toBe(now + 7 * 24 * HOUR_MS);
	});

	it("rejects a reset-after-seconds past the horizon", () => {
		expect(
			parseQuotaResetAtMs(
				headers({ [`${PREFIX}-reset-after-seconds`]: "4000000000" }),
				PREFIX,
				now,
			),
		).toBeUndefined();
	});

	it("rejects an epoch reset-at past the horizon", () => {
		const farFuture = Math.floor((now + 400 * 24 * HOUR_MS) / 1000);
		expect(
			parseQuotaResetAtMs(
				headers({ [`${PREFIX}-reset-at`]: String(farFuture) }),
				PREFIX,
				now,
			),
		).toBeUndefined();
	});

	it("rejects an ISO reset-at past the horizon", () => {
		expect(
			parseQuotaResetAtMs(
				headers({ [`${PREFIX}-reset-at`]: "9999-12-31T00:00:00Z" }),
				PREFIX,
				now,
			),
		).toBeUndefined();
	});

	it("accepts a reset exactly on the horizon", () => {
		const at = parseQuotaResetAtMs(
			headers({ [`${PREFIX}-reset-at`]: String(now + MAX_QUOTA_RESET_HORIZON_MS) }),
			PREFIX,
			now,
		);
		expect(at).toBe(now + MAX_QUOTA_RESET_HORIZON_MS);
	});

	it("does not report an exhausted window when its reset is implausible", () => {
		expect(
			getQuotaExhaustedResetAtMs(
				headers({
					[`${PREFIX}-used-percent`]: "100",
					[`${PREFIX}-window-minutes`]: "300",
					[`${PREFIX}-reset-after-seconds`]: "4000000000",
				}),
				now,
			),
		).toBeUndefined();
	});

	it("keeps an implausible horizon out of retryAfterMs", async () => {
		const response = new Response(
			JSON.stringify({ error: { code: "usage_limit_reached" } }),
			{
				status: 429,
				headers: {
					[`${PREFIX}-used-percent`]: "100",
					[`${PREFIX}-window-minutes`]: "300",
					[`${PREFIX}-reset-after-seconds`]: "4000000000",
				},
			},
		);
		const { rateLimit } = await handleErrorResponse(response);
		expect(rateLimit?.retryAfterMs).toBeLessThanOrEqual(MAX_QUOTA_RESET_HORIZON_MS);
	});
});

describe("markQuotaExhausted horizon guard", () => {
	const build = async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const now = Date.now();
		return new AccountManager(undefined, {
			version: 3 as const,
			activeIndex: 0,
			accounts: [{ refreshToken: "r1", addedAt: now, lastUsed: now }],
		});
	};

	it("writes a block for a reset inside the horizon", async () => {
		const manager = await build();
		const account = manager.getCurrentAccount()!;
		const resetAt = Date.now() + 7 * 24 * HOUR_MS;

		expect(manager.markQuotaExhausted(account, resetAt, "codex")).toBe(true);
		expect(account.quotaExhaustedUntil).toBe(Math.floor(resetAt));
		expect(account.rateLimitResetTimes).toEqual({});
	});

	it("refuses a reset past the horizon, so nothing permanent is persisted", async () => {
		const manager = await build();
		const account = manager.getCurrentAccount()!;
		const bogus = Date.now() + 4_000_000_000 * 1000; // ~127 years

		expect(manager.markQuotaExhausted(account, bogus, "codex")).toBe(false);
		expect(account.quotaExhaustedUntil).toBeUndefined();
		expect(account.rateLimitResetTimes["codex"]).toBeUndefined();
	});
});

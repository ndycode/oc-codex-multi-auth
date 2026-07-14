import { afterEach, describe, expect, it, vi } from "vitest";

import {
	consumeCodexResetCredit,
	createRedeemRequestId,
	fetchCodexResetCredits,
	formatCodexResetConsumeResult,
	parseCodexResetCredits,
	selectRedeemableCredit,
} from "../lib/codex-reset.js";

const request = {
	accountId: "acct-1",
	accessToken: "access-token",
	organizationId: undefined,
	timeoutMs: 5_000,
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("parseCodexResetCredits", () => {
	it("normalizes credits and flags the redeemable ones", () => {
		const summary = parseCodexResetCredits({
			available_count: 1,
			credits: [
				{
					id: "RateLimitResetCredit_a",
					status: "available",
					reset_type: "free",
					granted_at: "2026-06-12",
					expires_at: "2026-07-12",
					title: "One free rate limit reset",
				},
				{ id: "RateLimitResetCredit_b", status: "redeemed" },
			],
		});

		expect(summary.availableCount).toBe(1);
		expect(summary.credits).toHaveLength(2);
		expect(summary.credits[0]).toMatchObject({
			id: "RateLimitResetCredit_a",
			isAvailable: true,
			resetType: "free",
			title: "One free rate limit reset",
		});
		expect(summary.credits[1]?.isAvailable).toBe(false);
	});

	it("derives the available count when the server omits it", () => {
		const summary = parseCodexResetCredits({
			credits: [
				{ id: "a", status: "available" },
				{ id: "b", status: "available" },
				{ id: "c", status: "expired" },
			],
		});

		expect(summary.availableCount).toBe(2);
	});

	it("drops credits without an id, since they cannot be redeemed", () => {
		const summary = parseCodexResetCredits({
			credits: [{ status: "available" }, { id: "  ", status: "available" }],
		});

		expect(summary.credits).toEqual([]);
	});

	it("tolerates an empty payload", () => {
		expect(parseCodexResetCredits({})).toEqual({
			availableCount: 0,
			credits: [],
		});
	});
});

describe("selectRedeemableCredit", () => {
	const summary = parseCodexResetCredits({
		credits: [
			{ id: "spent", status: "redeemed" },
			{ id: "first", status: "available" },
			{ id: "second", status: "available" },
		],
	});

	it("defaults to the first available credit", () => {
		expect(selectRedeemableCredit(summary)).toMatchObject({
			type: "selected",
			credit: { id: "first" },
		});
	});

	it("honors an explicit credit id", () => {
		expect(selectRedeemableCredit(summary, "second")).toMatchObject({
			type: "selected",
			credit: { id: "second" },
		});
	});

	it("refuses a credit that is not available rather than posting it", () => {
		expect(selectRedeemableCredit(summary, "spent")).toEqual({
			type: "not-found",
			creditId: "spent",
		});
	});

	it("reports when nothing is redeemable", () => {
		const spentOnly = parseCodexResetCredits({
			credits: [{ id: "spent", status: "redeemed" }],
		});
		expect(selectRedeemableCredit(spentOnly)).toEqual({ type: "none-available" });
	});
});

describe("fetchCodexResetCredits", () => {
	it("calls the credits endpoint with Codex auth headers", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse({ available_count: 1, credits: [] }));

		await fetchCodexResetCredits(request);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
		);
		expect(init.method).toBe("GET");
		const headers = new Headers(init.headers);
		expect(headers.get("Authorization")).toBe("Bearer access-token");
		expect(headers.get("ChatGPT-Account-Id")).toBe("acct-1");
	});

	it("sanitizes bearer tokens out of an error body", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("denied for Bearer sk-secret-token-value", { status: 403 }),
		);

		await expect(fetchCodexResetCredits(request)).rejects.toThrow(
			/HTTP 403.*Bearer \[redacted\]/,
		);
	});
});

describe("consumeCodexResetCredit", () => {
	it("posts the credit id and the redeem request id", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse({ code: "ok" }));

		await consumeCodexResetCredit({
			...request,
			creditId: "credit-1",
			redeemRequestId: "redeem-1",
		});

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
		);
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({
			credit_id: "credit-1",
			redeem_request_id: "redeem-1",
		});
		expect(new Headers(init.headers).get("content-type")).toBe(
			"application/json",
		);
	});
});

describe("createRedeemRequestId", () => {
	it("returns a fresh id per redemption so a retry cannot spend two credits", () => {
		expect(createRedeemRequestId()).not.toBe(createRedeemRequestId());
	});
});

describe("formatCodexResetConsumeResult", () => {
	it("summarizes the redeemed windows", () => {
		expect(
			formatCodexResetConsumeResult({
				code: "ok",
				windows_reset: ["primary", "secondary"],
				credit: { redeemed_at: "2026-07-14T00:00:00Z" },
			}),
		).toBe(
			"code=ok  redeemed=2026-07-14T00:00:00Z  windows_reset=primary, secondary",
		);
	});

	it("falls back to a plain confirmation when the payload is bare", () => {
		expect(formatCodexResetConsumeResult({})).toBe("redeemed");
	});
});

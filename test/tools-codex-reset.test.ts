import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCodexResetTool } from "../lib/tools/codex-reset.js";
import type { ToolContext } from "../lib/tools/index.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
}));

import { loadAccounts } from "../lib/storage.js";

const CREDITS_URL =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CONSUME_URL =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type ToolExecute = (args?: Record<string, unknown>) => Promise<string>;

function buildCtx(): ToolContext {
	return {
		resolveUiRuntime: () => ({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "ascii",
			theme: undefined,
		}),
		resolveMaskEmail: () => false,
		resolveActiveIndex: () => 0,
		formatCommandAccountLabel: (_account, index) => `Account ${index + 1}`,
		buildJsonAccountIdentity: (index) => ({ account: index + 1 }),
		invalidateAccountManagerCache: () => undefined,
	} as unknown as ToolContext;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const usagePayload = {
	plan_type: "team",
	rate_limit: {
		primary_window: {
			used_percent: 23,
			limit_window_seconds: 10080 * 60,
		},
		secondary_window: null,
	},
};

const creditsPayload = {
	available_count: 1,
	credits: [
		{
			id: "RateLimitResetCredit_1",
			status: "available",
			reset_type: "free",
			granted_at: "2026-06-12",
			expires_at: "2026-07-12",
			title: "One free rate limit reset",
		},
	],
};

/** Route the mocked fetch by URL so each endpoint's calls can be asserted. */
function mockCodexFetch(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input);
		if (url === CREDITS_URL) return jsonResponse(creditsPayload);
		if (url === USAGE_URL) return jsonResponse(usagePayload);
		if (url === CONSUME_URL) {
			return jsonResponse({
				code: "ok",
				windows_reset: ["primary"],
				credit: { redeemed_at: "2026-07-14T10:00:00Z" },
			});
		}
		throw new Error(`unexpected fetch: ${url}`);
	});
}

function callsTo(
	fetchMock: ReturnType<typeof mockCodexFetch>,
	url: string,
): unknown[][] {
	return fetchMock.mock.calls.filter((call) => String(call[0]) === url);
}

describe("codex-reset tool", () => {
	beforeEach(() => {
		vi.mocked(loadAccounts).mockResolvedValue({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: {},
			accounts: [
				{
					accountId: "acct-1",
					accessToken: "access-token",
					refreshToken: "refresh-token",
					expiresAt: Date.now() + 3_600_000,
					email: "user@example.com",
				},
			],
		} as unknown as Awaited<ReturnType<typeof loadAccounts>>);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists banked credits and current usage by default", async () => {
		mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const output = await execute();

		expect(output).toContain("banked credits: 1 available");
		expect(output).toContain("RateLimitResetCredit_1");
		expect(output).toContain("Weekly limit: 77% left");
		expect(output).toContain('codex-reset action="consume" confirm=true');
	});

	it("does not redeem when consume is called without confirmation", async () => {
		const fetchMock = mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const output = await execute({ action: "consume" });

		expect(callsTo(fetchMock, CONSUME_URL)).toHaveLength(0);
		expect(output).toContain("about to redeem");
		expect(output).toContain("confirm=true");
	});

	it("does not redeem on a dry run even when confirmed", async () => {
		const fetchMock = mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const output = await execute({
			action: "consume",
			confirm: true,
			dryRun: true,
		});

		expect(callsTo(fetchMock, CONSUME_URL)).toHaveLength(0);
		expect(output).toContain("dry run");
	});

	it("redeems the credit once when confirmed, and reports the new usage", async () => {
		const fetchMock = mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const output = await execute({ action: "consume", confirm: true });

		const consumeCalls = callsTo(fetchMock, CONSUME_URL);
		expect(consumeCalls).toHaveLength(1);
		const body = JSON.parse(
			String((consumeCalls[0]?.[1] as RequestInit).body),
		) as { credit_id: string; redeem_request_id: string };
		expect(body.credit_id).toBe("RateLimitResetCredit_1");
		expect(body.redeem_request_id).toBeTruthy();
		expect(output).toContain("redeemed RateLimitResetCredit_1");
		expect(output).toContain("new usage:");
	});

	it("still reports the redemption when the usage re-read fails afterwards", async () => {
		// The POST succeeds and the credit is spent; only the courtesy usage read
		// that follows it fails. Reporting redeemed=false here would push the user
		// to spend a second credit for a redemption that already happened.
		let consumed = false;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === CREDITS_URL) return jsonResponse(creditsPayload);
			if (url === CONSUME_URL) {
				consumed = true;
				return jsonResponse({ code: "ok" });
			}
			if (url === USAGE_URL) {
				if (consumed) throw new TypeError("network down");
				return jsonResponse(usagePayload);
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const parsed = JSON.parse(
			await execute({ action: "consume", confirm: true, format: "json" }),
		) as { redeemed: boolean; usageError: string | null; error?: string };

		expect(parsed.redeemed).toBe(true);
		expect(parsed.usageError).toContain("network down");
		expect(parsed.error).toBeUndefined();
	});

	it("does not read usage before deciding whether to redeem", async () => {
		const fetchMock = mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		await execute({ action: "consume" });

		// An unconfirmed consume never redeems, so it must not spend a round-trip
		// on the usage endpoint either.
		expect(callsTo(fetchMock, USAGE_URL)).toHaveLength(0);
		expect(callsTo(fetchMock, CONSUME_URL)).toHaveLength(0);
	});

	it("refuses to redeem an unavailable credit id", async () => {
		const fetchMock = mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const output = await execute({
			action: "consume",
			confirm: true,
			creditId: "RateLimitResetCredit_missing",
		});

		expect(callsTo(fetchMock, CONSUME_URL)).toHaveLength(0);
		expect(output).toContain("No available credit with id");
	});

	it("emits machine-readable status output", async () => {
		mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		const parsed = JSON.parse(await execute({ format: "json" })) as {
			availableCount: number;
			credits: Array<{ id: string; isAvailable: boolean }>;
		};

		expect(parsed.availableCount).toBe(1);
		expect(parsed.credits[0]).toMatchObject({
			id: "RateLimitResetCredit_1",
			isAvailable: true,
		});
	});

	it("rejects an unknown action", async () => {
		mockCodexFetch();
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		await expect(execute({ action: "redeem" })).rejects.toThrow(
			/Invalid action "redeem"/,
		);
	});

	it("reports when no accounts are configured", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(null);
		const execute = createCodexResetTool(buildCtx()).execute as ToolExecute;

		expect(await execute()).toContain("No Codex accounts configured");
	});
});

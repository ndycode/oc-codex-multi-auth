import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../lib/tools/index.js";
import {
	createCodexWarmTool,
	createWarmOne,
} from "../lib/tools/codex-warm.js";
import { resolveDisplayEmail } from "../lib/account-display.js";
import type { AccountStorageV3 } from "../lib/storage.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
}));

vi.mock("../lib/codex-usage.js", () => ({
	ensureCodexUsageAccessToken: vi.fn(async () => ({
		accessToken: "access-token",
		refreshed: false,
		persisted: false,
	})),
	resolveCodexUsageAccountId: vi.fn(() => "acct-123"),
}));

vi.mock("../lib/accounts/warm-request.js", () => ({
	warmAccountWindow: vi.fn(async () => true),
}));

import { loadAccounts } from "../lib/storage.js";
import {
	ensureCodexUsageAccessToken,
	resolveCodexUsageAccountId,
} from "../lib/codex-usage.js";
import { warmAccountWindow } from "../lib/accounts/warm-request.js";

function formatCommandAccountLabel(
	account: { email?: string } | undefined,
	index: number,
	options: { maskEmail?: boolean } = {},
): string {
	const email = resolveDisplayEmail(account?.email, options.maskEmail ?? false);
	return email ? `Account ${index + 1} (${email})` : `Account ${index + 1}`;
}

function buildCtx(): ToolContext {
	const ctx = {
		resolveUiRuntime: () => ({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "ascii",
			theme: undefined,
		}),
		resolveMaskEmail: () => false,
		formatCommandAccountLabel,
		getStatusMarker: (_ui: unknown, status: string) => `[${status}]`,
		cachedAccountManagerRef: { current: null },
		accountManagerPromiseRef: { current: null },
	};
	return ctx as unknown as ToolContext;
}

const storageWith = (accounts: unknown[]): AccountStorageV3 =>
	({ version: 3, activeIndex: 0, accounts } as unknown as AccountStorageV3);

beforeEach(() => {
	vi.mocked(loadAccounts).mockReset();
	vi.mocked(ensureCodexUsageAccessToken).mockClear();
	vi.mocked(resolveCodexUsageAccountId).mockClear();
	vi.mocked(warmAccountWindow).mockClear();
	vi.mocked(ensureCodexUsageAccessToken).mockResolvedValue({
		accessToken: "access-token",
		refreshed: false,
		persisted: false,
	} as never);
	vi.mocked(resolveCodexUsageAccountId).mockReturnValue("acct-123");
	vi.mocked(warmAccountWindow).mockResolvedValue(true as never);
});

describe("codex-warm tool (#182)", () => {
	it("reports no accounts when storage is empty", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(null as never);
		const tool = createCodexWarmTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;
		expect(output).toContain("No Codex accounts configured");
		expect(warmAccountWindow).not.toHaveBeenCalled();
	});

	it("warms every enabled account and summarizes", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(
			storageWith([
				{ email: "a@example.com", refreshToken: "r1" },
				{ email: "b@example.com", refreshToken: "r2" },
			]) as never,
		);
		const tool = createCodexWarmTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;

		expect(warmAccountWindow).toHaveBeenCalledTimes(2);
		expect(output).toContain("a@example.com): Window started");
		expect(output).toContain("b@example.com): Window started");
		expect(output).toContain("Summary: 2 warmed, 0 failed, 0 skipped");
	});

	it("skips disabled accounts and never calls upstream for them", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(
			storageWith([
				{ email: "a@example.com", refreshToken: "r1" },
				{ email: "b@example.com", refreshToken: "r2", enabled: false },
			]) as never,
		);
		const tool = createCodexWarmTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;

		expect(warmAccountWindow).toHaveBeenCalledTimes(1);
		expect(output).toContain("b@example.com): Skipped (disabled)");
		expect(output).toContain("Summary: 1 warmed, 0 failed, 1 skipped");
	});

	it("records upstream failures without aborting the batch", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(
			storageWith([
				{ email: "a@example.com", refreshToken: "r1" },
				{ email: "b@example.com", refreshToken: "r2" },
			]) as never,
		);
		// Second account's upstream call fails.
		vi.mocked(warmAccountWindow)
			.mockResolvedValueOnce(true as never)
			.mockRejectedValueOnce(new Error("429 too many requests"));

		const tool = createCodexWarmTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;

		expect(output).toMatch(/Failed - 429 too many requests/);
		expect(output).toContain("Summary: 1 warmed, 1 failed, 0 skipped");
	});
});

describe("createWarmOne adapter (#182)", () => {
	it("composes refresh -> resolve id -> warm and returns warmed", async () => {
		const storage = storageWith([]);
		const account = { email: "a@example.com", refreshToken: "r1" } as never;
		const warmOne = createWarmOne(storage);

		const outcome = await warmOne(account);

		expect(ensureCodexUsageAccessToken).toHaveBeenCalledWith({ storage, account });
		expect(resolveCodexUsageAccountId).toHaveBeenCalledWith({
			account,
			accessToken: "access-token",
		});
		expect(warmAccountWindow).toHaveBeenCalledWith({
			accountId: "acct-123",
			accessToken: "access-token",
			organizationId: undefined,
		});
		expect(outcome.status).toBe("warmed");
	});

	it("fails cleanly when the account id cannot be resolved", async () => {
		vi.mocked(resolveCodexUsageAccountId).mockReturnValueOnce(undefined as never);
		const warmOne = createWarmOne(storageWith([]));
		const outcome = await warmOne({ refreshToken: "r1" } as never);
		expect(outcome.status).toBe("failed");
		expect(outcome.detail).toMatch(/account id/i);
		expect(warmAccountWindow).not.toHaveBeenCalled();
	});
});

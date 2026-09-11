import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../lib/tools/index.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import { createCodexListTool } from "../lib/tools/codex-list.js";
import { resolveDisplayEmail } from "../lib/account-display.js";
import { createUiTheme } from "../lib/ui/theme.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
	getStoragePath: vi.fn(() => "/tmp/accounts.json"),
}));

vi.mock("../lib/accounts.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/accounts.js")>(
		"../lib/accounts.js",
	);
	return { ...actual, AccountManager: { loadFromDisk: vi.fn(async () => ({})) } };
});

import { loadAccounts } from "../lib/storage.js";

function formatCommandAccountLabel(
	account: { email?: string; accountLabel?: string } | undefined,
	index: number,
	options: { maskEmail?: boolean } = {},
): string {
	const email = resolveDisplayEmail(account?.email, options.maskEmail ?? false);
	const label = account?.accountLabel?.trim();
	const details = [label, email].filter(Boolean);
	if (details.length === 0) return `Account ${index + 1}`;
	return `Account ${index + 1} (${details.join(", ")})`;
}

function buildCtx(options: { v2Enabled?: boolean } = {}): ToolContext {
	const ctx = {
		resolveUiRuntime: () => ({
			v2Enabled: options.v2Enabled ?? false,
			colorProfile: "ansi16",
			glyphMode: "ascii",
			theme: createUiTheme({ profile: "ansi16", glyphMode: "ascii" }),
		}),
		resolveMaskEmail: () => false,
		resolveActiveIndex: () => 0,
		formatCommandAccountLabel,
		formatRateLimitEntry: () => null,
		getQuotaExhaustedUntil: () => null,
		formatQuotaExhaustionEntry: () => null,
		buildJsonAccountIdentity: (
			index: number,
			opts: { includeSensitive?: boolean; account?: { email?: string } } = {},
		) => ({
			index: index + 1,
			zeroBasedIndex: index,
			...(opts.includeSensitive ? { email: opts.account?.email ?? null } : {}),
		}),
	};
	return ctx as unknown as ToolContext;
}

/** The six real accounts' plan slugs, paired with the tier each one names. */
const REAL_POOL: AccountStorageV3 = {
	version: 3,
	activeIndex: 0,
	accounts: [
		{
			email: "oferty@nowaker.net",
			planType: "pro",
			refreshToken: "r1",
			addedAt: 1,
			lastUsed: 1,
		},
		{
			email: "nowaker@virtkick.com",
			planType: "team",
			refreshToken: "r2",
			addedAt: 2,
			lastUsed: 2,
		},
		{
			email: "oferty@nowaker.net",
			planType: "self_serve_business_prolite",
			refreshToken: "r3",
			addedAt: 3,
			lastUsed: 3,
		},
		{
			email: "nowaker@virtkick.com",
			planType: "free",
			refreshToken: "r4",
			addedAt: 4,
			lastUsed: 4,
		},
	],
};

describe("codex-list plan tier", () => {
	beforeEach(() => {
		vi.mocked(loadAccounts).mockReset();
	});

	it("names each stored plan slug in the plain table", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(REAL_POOL);

		const tool = createCodexListTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;

		expect(output).toContain("Pro");
		expect(output).toContain("Business");
		expect(output).toContain("Business Premium");
		expect(output).toContain("Free");
	});

	it("reports the plan slug in JSON without requiring includeSensitive", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(REAL_POOL);

		const tool = createCodexListTool(buildCtx());
		const parsed = JSON.parse(
			(await tool.execute({ format: "json" }, {} as never)) as string,
		) as { accounts: Array<{ planType: string | null; plan: string | null }> };

		expect(parsed.accounts.map((account) => account.planType)).toEqual([
			"pro",
			"team",
			"self_serve_business_prolite",
			"free",
		]);
		expect(parsed.accounts.map((account) => account.plan)).toEqual([
			"Pro",
			"Business",
			"Business Premium",
			"Free",
		]);
	});

	it("reports a null plan for an account stored before plan detection", async () => {
		vi.mocked(loadAccounts).mockResolvedValue({
			version: 3,
			activeIndex: 0,
			accounts: [
				{ email: "old@example.com", refreshToken: "r1", addedAt: 1, lastUsed: 1 },
			],
		});

		const tool = createCodexListTool(buildCtx());
		const parsed = JSON.parse(
			(await tool.execute({ format: "json" }, {} as never)) as string,
		) as { accounts: Array<{ planType: string | null; plan: string | null }> };

		expect(parsed.accounts[0]?.planType).toBeNull();
		expect(parsed.accounts[0]?.plan).toBeNull();
	});

	it("badges the plan in the v2 UI", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(REAL_POOL);

		const tool = createCodexListTool(buildCtx({ v2Enabled: true }));
		const output = (await tool.execute({}, {} as never)) as string;

		expect(output).toContain("Business Premium");
		expect(output).toContain("Pro");
	});
});

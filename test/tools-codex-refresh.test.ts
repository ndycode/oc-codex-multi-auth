import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../lib/tools/index.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import { createCodexRefreshTool } from "../lib/tools/codex-refresh.js";
import { resolveDisplayEmail } from "../lib/account-display.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
	withAccountStorageTransaction: vi.fn(),
}));

vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: vi.fn(async () => ({
		type: "success",
		access: "new-access",
		refresh: "new-refresh",
		expires: Date.now() + 3_600_000,
	})),
}));

vi.mock("../lib/accounts.js", () => ({
	AccountManager: { loadFromDisk: vi.fn(async () => ({})) },
}));

import { loadAccounts, withAccountStorageTransaction } from "../lib/storage.js";

/**
 * Faithful stand-in for the `formatCommandAccountLabel` closure defined in
 * `index.ts`: it honors the `maskEmail` option through the shared helper, so a
 * regression that drops `{ maskEmail }` at the call site yields an unmasked
 * string and fails the assertions below.
 */
function formatCommandAccountLabel(
	account: { email?: string; accountLabel?: string } | undefined,
	index: number,
	options: { maskEmail?: boolean } = {},
): string {
	const email = resolveDisplayEmail(account?.email, options.maskEmail ?? false);
	const workspace = account?.accountLabel?.trim();
	const details: string[] = [];
	if (email) details.push(email);
	if (workspace) details.push(`workspace:${workspace}`);
	if (details.length === 0) return `Account ${index + 1}`;
	return `Account ${index + 1} (${details.join(", ")})`;
}

function buildCtx(maskEmail: boolean): ToolContext {
	const ctx = {
		resolveUiRuntime: () => ({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "ascii",
			theme: undefined,
		}),
		resolveMaskEmail: () => maskEmail,
		formatCommandAccountLabel,
		getStatusMarker: () => "[ok]",
		cachedAccountManagerRef: { current: null },
		accountManagerPromiseRef: { current: null },
	};
	return ctx as unknown as ToolContext;
}

describe("codex-refresh tool masking", () => {
	beforeEach(() => {
		vi.mocked(loadAccounts).mockReset();
		vi.mocked(withAccountStorageTransaction).mockReset();
	});

	it("masks the account email when maskEmail is enabled", async () => {
		vi.mocked(loadAccounts).mockResolvedValue({
			version: 3,
			activeIndex: 0,
			accounts: [{ email: "user@example.com", refreshToken: "r1" }],
		} as never);

		const tool = createCodexRefreshTool(buildCtx(true));
		const output = (await tool.execute({}, {} as never)) as string;

		expect(output).toContain("us***@example.com");
		expect(output).not.toContain("user@example.com");
	});

	it("shows the raw email when maskEmail is disabled", async () => {
		vi.mocked(loadAccounts).mockResolvedValue({
			version: 3,
			activeIndex: 0,
			accounts: [{ email: "user@example.com", refreshToken: "r1" }],
		} as never);

		const tool = createCodexRefreshTool(buildCtx(false));
		const output = (await tool.execute({}, {} as never)) as string;

		expect(output).toContain("user@example.com");
	});
});

describe("codex-refresh tool concurrency (lost-update regression)", () => {
	beforeEach(() => {
		vi.mocked(loadAccounts).mockReset();
		vi.mocked(withAccountStorageTransaction).mockReset();
	});

	it("applies refreshed tokens on top of state written to storage after the initial load, instead of clobbering it", async () => {
		// The snapshot the tool's initial loadAccounts() sees, used only to
		// build the work list of accounts to refresh.
		const initialStorage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					email: "user@example.com",
					accountId: "acct-1",
					refreshToken: "old-refresh",
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};
		vi.mocked(loadAccounts).mockResolvedValue(initialStorage);

		// Simulate a concurrent rotation that persisted rate-limit/cooldown
		// state AFTER the tool's initial load but BEFORE its final persist.
		// This is exactly what `current` inside withAccountStorageTransaction
		// must reflect: a fresh re-read, not the stale `initialStorage` above.
		const concurrentStorage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					email: "user@example.com",
					accountId: "acct-1",
					refreshToken: "old-refresh",
					addedAt: 1,
					lastUsed: 1,
					rateLimitResetTimes: { "gpt-5": 1_700_000_000_000 },
					coolingDownUntil: 1_700_000_100_000,
					cooldownReason: "rate-limit",
				},
			],
		};

		let persisted: AccountStorageV3 | undefined;
		vi.mocked(withAccountStorageTransaction).mockImplementation(
			async (handler: any) => {
				return handler(concurrentStorage, async (s: AccountStorageV3) => {
					persisted = s;
				});
			},
		);

		const tool = createCodexRefreshTool(buildCtx(false));
		await tool.execute({}, {} as never);

		expect(persisted).toBeDefined();
		const persistedAccount = persisted!.accounts[0]!;

		// The refresh result was applied onto the fresh (concurrent) snapshot.
		expect(persistedAccount.refreshToken).toBe("new-refresh");
		expect(persistedAccount.accessToken).toBe("new-access");
		expect(persistedAccount.expiresAt).toBeGreaterThan(Date.now());

		// The concurrently-written rate-limit/cooldown state survived --
		// it must NOT have been clobbered by the stale `initialStorage`
		// snapshot the tool loaded before running the (slow) refreshes.
		expect(persistedAccount.rateLimitResetTimes).toEqual({
			"gpt-5": 1_700_000_000_000,
		});
		expect(persistedAccount.coolingDownUntil).toBe(1_700_000_100_000);
		expect(persistedAccount.cooldownReason).toBe("rate-limit");
	});
});

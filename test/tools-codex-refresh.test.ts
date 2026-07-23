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
		vi.mocked(withAccountStorageTransaction).mockImplementation(
			async (handler) =>
				handler(
					{
						version: 3,
						activeIndex: 0,
						accounts: [{ email: "user@example.com", refreshToken: "r1" }],
					} as never,
					async () => {},
				),
		);

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
		vi.mocked(withAccountStorageTransaction).mockImplementation(
			async (handler) =>
				handler(
					{
						version: 3,
						activeIndex: 0,
						accounts: [{ email: "user@example.com", refreshToken: "r1" }],
					} as never,
					async () => {},
				),
		);

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
			async (handler) => {
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

		// The refresh rotated the token (mocked queuedRefresh returns
		// "new-refresh" for the "old-refresh" input), so the persisted
		// account must carry a tokenRotatedAt stamp. Without it, the
		// credential-clobber guard in lib/accounts/persistence.ts (which
		// compares `tokenRotatedAt ?? 0`) cannot tell this rotation apart
		// from a stale snapshot and could let the fresh token be clobbered.
		expect(persistedAccount.tokenRotatedAt).toBeGreaterThan(0);
	});

	it("skips applying a refresh outcome when the on-disk refreshToken changed mid-flight (another process rotated it)", async () => {
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

		// Simulate another process rotating this account's refresh token
		// (e.g. a concurrent request-time refresh) while our queuedRefresh
		// call for "old-refresh" was still in flight. By the time the
		// transaction re-reads storage, the account's refreshToken no
		// longer matches the pre-refresh identity our outcome was keyed on.
		const concurrentStorage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					email: "user@example.com",
					accountId: "acct-1",
					refreshToken: "externally-rotated-refresh",
					addedAt: 1,
					lastUsed: 1,
					tokenRotatedAt: 999,
				},
			],
		};

		let persisted: AccountStorageV3 | undefined;
		vi.mocked(withAccountStorageTransaction).mockImplementation(
			async (handler) => {
				return handler(concurrentStorage, async (s: AccountStorageV3) => {
					persisted = s;
				});
			},
		);

		const tool = createCodexRefreshTool(buildCtx(false));
		const output = (await tool.execute({}, {} as never)) as string;

		// The stale outcome (keyed on "old-refresh") must NOT overwrite the
		// externally-rotated token -- we cannot know which chain is live. The
		// transaction rejects without persisting, and the tool reports a failure.
		expect(persisted).toBeUndefined();
		expect(concurrentStorage.accounts[0]?.refreshToken).toBe(
			"externally-rotated-refresh",
		);
		expect(concurrentStorage.accounts[0]?.tokenRotatedAt).toBe(999);
		expect(output).toContain("Refresh token changed concurrently");
		expect(output).toContain("0 refreshed, 1 failed");
	});
});

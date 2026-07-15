import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../lib/tools/index.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import { createCodexRemoveTool } from "../lib/tools/codex-remove.js";
import { resolveDisplayEmail } from "../lib/account-display.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
	withAccountStorageTransaction: vi.fn(),
}));

vi.mock("../lib/accounts.js", () => ({
	AccountManager: { loadFromDisk: vi.fn(async () => ({})) },
}));

import { loadAccounts, withAccountStorageTransaction } from "../lib/storage.js";

/**
 * Wires withAccountStorageTransaction's mock to hand the handler `current`
 * (defaulting to whatever loadAccounts() was mocked to resolve, unless a
 * distinct snapshot is passed to simulate a concurrent write) and to record
 * whatever the handler persists.
 */
function stubTransaction(current: AccountStorageV3 | null): {
	getPersisted: () => AccountStorageV3 | undefined;
} {
	let persisted: AccountStorageV3 | undefined;
	vi.mocked(withAccountStorageTransaction).mockImplementation(
		async (handler: any) => {
			return handler(current, async (s: AccountStorageV3) => {
				persisted = s;
			});
		},
	);
	return { getPersisted: () => persisted };
}

/**
 * Faithful stand-in for the `formatCommandAccountLabel` closure defined in
 * `index.ts`: it honors the `maskEmail` option through the shared helper.
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
		promptAccountIndexSelection: vi.fn(async () => null),
		supportsInteractiveMenus: () => false,
		cachedAccountManagerRef: { current: null },
		accountManagerPromiseRef: { current: null },
	};
	return ctx as unknown as ToolContext;
}

describe("codex-remove tool masking", () => {
	beforeEach(() => {
		vi.mocked(loadAccounts).mockReset();
		vi.mocked(withAccountStorageTransaction).mockReset();
	});

	it("masks the email in the duplicate-entries hint when maskEmail is enabled", async () => {
		// Two entries share the same email so the post-remove duplicate hint fires.
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{ email: "user@example.com", refreshToken: "r1", addedAt: 1, lastUsed: 1 },
				{ email: "user@example.com", refreshToken: "r2", addedAt: 2, lastUsed: 2 },
			],
		};
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		stubTransaction(storage);

		const tool = createCodexRemoveTool(buildCtx(true));
		const output = (await tool.execute(
			{ index: 1, confirm: true },
			{} as never,
		)) as string;

		expect(output).toContain("us***@example.com");
		expect(output).not.toContain("user@example.com");
	});

	it("shows the raw email in the duplicate-entries hint when maskEmail is disabled", async () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{ email: "user@example.com", refreshToken: "r1", addedAt: 1, lastUsed: 1 },
				{ email: "user@example.com", refreshToken: "r2", addedAt: 2, lastUsed: 2 },
			],
		};
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		stubTransaction(storage);

		const tool = createCodexRemoveTool(buildCtx(false));
		const output = (await tool.execute(
			{ index: 1, confirm: true },
			{} as never,
		)) as string;

		expect(output).toContain("user@example.com");
	});
});

describe("codex-remove tool concurrency (lost-update regression)", () => {
	beforeEach(() => {
		vi.mocked(loadAccounts).mockReset();
		vi.mocked(withAccountStorageTransaction).mockReset();
	});

	it("removes against a freshly re-read snapshot so concurrent writes between load and save survive", async () => {
		// The snapshot the tool's initial loadAccounts() sees, used only to
		// render the "no accounts configured" check and the (unused, since we
		// pass an explicit index) interactive picker.
		const initialStorage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{ email: "a@example.com", refreshToken: "r1", addedAt: 1, lastUsed: 1 },
				{ email: "b@example.com", refreshToken: "r2", addedAt: 2, lastUsed: 2 },
			],
		};
		vi.mocked(loadAccounts).mockResolvedValue(initialStorage);

		// Simulate a concurrent rotation that persisted rate-limit state onto
		// account[0] (the one NOT being removed) after the initial load but
		// before the transaction runs. `current` inside
		// withAccountStorageTransaction must be this fresh snapshot, not the
		// stale `initialStorage` above.
		const concurrentStorage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					email: "a@example.com",
					refreshToken: "r1",
					addedAt: 1,
					lastUsed: 1,
					rateLimitResetTimes: { "gpt-5": 1_700_000_000_000 },
					coolingDownUntil: 1_700_000_100_000,
				},
				{ email: "b@example.com", refreshToken: "r2", addedAt: 2, lastUsed: 2 },
			],
		};
		const { getPersisted } = stubTransaction(concurrentStorage);

		const tool = createCodexRemoveTool(buildCtx(false));
		const output = (await tool.execute(
			{ index: 2, confirm: true },
			{} as never,
		)) as string;

		expect(output).toContain("Removed selected entry");
		const persisted = getPersisted();
		expect(persisted).toBeDefined();
		expect(persisted!.accounts).toHaveLength(1);
		expect(persisted!.accounts[0]!.email).toBe("a@example.com");
		// The concurrently-written rate-limit state on the surviving account
		// must not have been clobbered by the stale `initialStorage` snapshot.
		expect(persisted!.accounts[0]!.rateLimitResetTimes).toEqual({
			"gpt-5": 1_700_000_000_000,
		});
		expect(persisted!.accounts[0]!.coolingDownUntil).toBe(1_700_000_100_000);
	});
});

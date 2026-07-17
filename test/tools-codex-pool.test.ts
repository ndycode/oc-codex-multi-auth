import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountStorageV3 } from "../lib/storage.js";
import type { ToolContext } from "../lib/tools/index.js";
import { createCodexPoolTool } from "../lib/tools/codex-pool.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
}));

vi.mock("../lib/config.js", () => ({
	loadPluginConfig: vi.fn(),
	updateModelAccountPool: vi.fn(),
}));

import { loadPluginConfig, updateModelAccountPool } from "../lib/config.js";
import { loadAccounts } from "../lib/storage.js";

const storage: AccountStorageV3 = {
	version: 3,
	activeIndex: 0,
	accounts: [
		{
			email: "one@example.com",
			accountId: "account-one",
			accountLabel: "Primary",
			refreshToken: "refresh-one",
			addedAt: 1,
			lastUsed: 1,
		},
		{
			email: "two@example.com",
			accountId: "account-two",
			refreshToken: "refresh-two",
			addedAt: 2,
			lastUsed: 2,
			enabled: false,
		},
	],
};

function buildCtx(): ToolContext {
	return {
		resolveMaskEmail: () => true,
		formatCommandAccountLabel: (account, index) =>
			`Account ${index + 1}${account?.accountLabel ? ` (${account.accountLabel})` : ""}`,
		buildJsonAccountIdentity: (index, options) => ({
			index: index + 1,
			zeroBasedIndex: index,
			...(options?.includeSensitive
				? { accountId: options.account?.accountId ?? null }
				: {}),
		}),
	} as unknown as ToolContext;
}

describe("codex-pool tool", () => {
	beforeEach(() => {
		vi.mocked(loadAccounts).mockReset();
		vi.mocked(loadPluginConfig).mockReset();
		vi.mocked(updateModelAccountPool).mockReset();
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		vi.mocked(loadPluginConfig).mockReturnValue({
			modelAccountPools: {
				"gpt-5.6-sol": ["account-one", "missing-account"],
			},
		});
	});

	it("reports configured and unresolved accounts without exposing IDs", async () => {
		const output = await createCodexPoolTool(buildCtx()).execute(
			{ action: "status", format: "json" },
			{} as never,
		);
		const parsed = JSON.parse(output as string) as {
			pools: Array<{
				configuredCount: number;
				accounts: Array<Record<string, unknown>>;
				unresolvedCount: number;
				unresolvedAccountIds?: string[];
			}>;
		};

		expect(parsed.pools[0]).toMatchObject({
			configuredCount: 2,
			unresolvedCount: 1,
		});
		expect(parsed.pools[0]?.accounts[0]).toMatchObject({ index: 1 });
		expect(parsed.pools[0]?.accounts[0]).not.toHaveProperty("accountId");
		expect(parsed.pools[0]).not.toHaveProperty("unresolvedAccountIds");
	});

	it("includes stable IDs only when sensitive JSON is requested", async () => {
		const output = await createCodexPoolTool(buildCtx()).execute(
			{ format: "json", includeSensitive: true },
			{} as never,
		);
		const parsed = JSON.parse(output as string) as {
			pools: Array<{
				accounts: Array<Record<string, unknown>>;
				unresolvedAccountIds: string[];
			}>;
		};

		expect(parsed.pools[0]?.accounts[0]).toMatchObject({
			accountId: "account-one",
		});
		expect(parsed.pools[0]?.unresolvedAccountIds).toEqual(["missing-account"]);
	});

	it("resolves unique 1-based account numbers to stable IDs", async () => {
		vi.mocked(updateModelAccountPool).mockResolvedValue({
			model: "gpt-5.6-sol",
			previousAccountIds: [],
			accountIds: ["account-two", "account-one"],
			changed: true,
			dryRun: false,
		});

		const output = await createCodexPoolTool(buildCtx()).execute(
			{
				action: "set",
				model: " GPT-5.6-SOL ",
				accounts: [2, 1, 2],
			},
			{} as never,
		);

		expect(updateModelAccountPool).toHaveBeenCalledWith(
			"gpt-5.6-sol",
			"set",
			["account-two", "account-one"],
			{ dryRun: undefined },
		);
		expect(output).toContain("Restart OpenCode");
	});

	it("passes dry runs through without requesting a restart", async () => {
		vi.mocked(updateModelAccountPool).mockResolvedValue({
			model: "gpt-5.6-sol",
			previousAccountIds: ["account-one"],
			accountIds: ["account-one", "account-two"],
			changed: true,
			dryRun: true,
		});

		const output = await createCodexPoolTool(buildCtx()).execute(
			{
				action: "add",
				model: "gpt-5.6-sol",
				accounts: [2],
				dryRun: true,
			},
			{} as never,
		);

		expect(updateModelAccountPool).toHaveBeenCalledWith(
			"gpt-5.6-sol",
			"add",
			["account-two"],
			{ dryRun: true },
		);
		expect(output).not.toContain("Restart OpenCode");
	});

	it("clears a pool without requiring account storage", async () => {
		vi.mocked(loadAccounts).mockResolvedValue(null);
		vi.mocked(updateModelAccountPool).mockResolvedValue({
			model: "gpt-5.6-sol",
			previousAccountIds: ["account-one"],
			accountIds: [],
			changed: true,
			dryRun: false,
		});

		await createCodexPoolTool(buildCtx()).execute(
			{ action: "clear", model: "gpt-5.6-sol" },
			{} as never,
		);

		expect(updateModelAccountPool).toHaveBeenCalledWith(
			"gpt-5.6-sol",
			"clear",
			[],
			{ dryRun: undefined },
		);
	});

	it("rejects invalid account numbers before writing", async () => {
		await expect(
			createCodexPoolTool(buildCtx()).execute(
				{ action: "remove", model: "gpt-5.6-sol", accounts: [3] },
				{} as never,
			),
		).rejects.toThrow("Expected 1-2");
		expect(updateModelAccountPool).not.toHaveBeenCalled();
	});

	it("rejects accounts that do not have a stable ID", async () => {
		vi.mocked(loadAccounts).mockResolvedValue({
			...storage,
			accounts: [{ ...storage.accounts[0], accountId: undefined }],
		});

		await expect(
			createCodexPoolTool(buildCtx()).execute(
				{ action: "set", model: "gpt-5.6-sol", accounts: [1] },
				{} as never,
			),
		).rejects.toThrow("has no stable account ID");
	});
});

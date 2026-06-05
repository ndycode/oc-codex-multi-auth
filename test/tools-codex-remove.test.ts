import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../lib/tools/index.js";
import { createCodexRemoveTool } from "../lib/tools/codex-remove.js";
import { resolveDisplayEmail } from "../lib/account-display.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
	saveAccounts: vi.fn(async () => undefined),
}));

vi.mock("../lib/accounts.js", () => ({
	AccountManager: { loadFromDisk: vi.fn(async () => ({})) },
}));

import { loadAccounts } from "../lib/storage.js";

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
	});

	it("masks the email in the duplicate-entries hint when maskEmail is enabled", async () => {
		// Two entries share the same email so the post-remove duplicate hint fires.
		vi.mocked(loadAccounts).mockResolvedValue({
			version: 3,
			activeIndex: 0,
			accounts: [
				{ email: "user@example.com", refreshToken: "r1" },
				{ email: "user@example.com", refreshToken: "r2" },
			],
		} as never);

		const tool = createCodexRemoveTool(buildCtx(true));
		const output = (await tool.execute(
			{ index: 1, confirm: true },
			{} as never,
		)) as string;

		expect(output).toContain("us***@example.com");
		expect(output).not.toContain("user@example.com");
	});

	it("shows the raw email in the duplicate-entries hint when maskEmail is disabled", async () => {
		vi.mocked(loadAccounts).mockResolvedValue({
			version: 3,
			activeIndex: 0,
			accounts: [
				{ email: "user@example.com", refreshToken: "r1" },
				{ email: "user@example.com", refreshToken: "r2" },
			],
		} as never);

		const tool = createCodexRemoveTool(buildCtx(false));
		const output = (await tool.execute(
			{ index: 1, confirm: true },
			{} as never,
		)) as string;

		expect(output).toContain("user@example.com");
	});
});

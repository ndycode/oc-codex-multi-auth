import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../lib/tools/index.js";
import { createCodexRefreshTool } from "../lib/tools/codex-refresh.js";
import { resolveDisplayEmail } from "../lib/account-display.js";

vi.mock("../lib/storage.js", () => ({
	loadAccounts: vi.fn(),
	saveAccounts: vi.fn(async () => undefined),
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

import { loadAccounts } from "../lib/storage.js";

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

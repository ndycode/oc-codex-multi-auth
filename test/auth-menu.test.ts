import { beforeEach, describe, expect, it, vi } from "vitest";
import { showAuthMenu, showAccountDetails, type AccountInfo } from "../lib/ui/auth-menu.js";
import { setUiRuntimeOptions, resetUiRuntimeOptions } from "../lib/ui/runtime.js";
import { select } from "../lib/ui/select.js";
import { confirm } from "../lib/ui/confirm.js";

vi.mock("../lib/ui/select.js", () => ({
	select: vi.fn(),
}));

vi.mock("../lib/ui/confirm.js", () => ({
	confirm: vi.fn(),
}));

describe("auth-menu", () => {
	beforeEach(() => {
		vi.mocked(select).mockReset();
		vi.mocked(confirm).mockReset();
		resetUiRuntimeOptions();
		setUiRuntimeOptions({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "ascii",
		});
	});

	it("renders same-email accounts with workspace and id details", async () => {
		vi.mocked(select).mockResolvedValueOnce({ type: "cancel" });

		const accounts: AccountInfo[] = [
			{
				index: 0,
				email: "shared@example.com",
				accountLabel: "Workspace A",
				accountId: "org-aaaa1111bbbb2222",
			},
			{
				index: 1,
				email: "shared@example.com",
				accountLabel: "Workspace B",
				accountId: "org-cccc1111dddd3333",
			},
		];

		await showAuthMenu(accounts);

		const firstCall = vi.mocked(select).mock.calls[0];
		expect(firstCall).toBeDefined();
		const items = firstCall?.[0] as Array<{ label: string; value?: { type?: string } }>;
		const accountRows = items.filter((item) => item.value?.type === "select-account");
		expect(accountRows).toHaveLength(2);
		expect(accountRows[0]?.label).toContain("shared@example.com");
		expect(accountRows[0]?.label).toContain("workspace:Workspace A");
		expect(accountRows[0]?.label).toContain("id:org-aaaa...bb2222");
		expect(accountRows[1]?.label).toContain("workspace:Workspace B");
		expect(accountRows[1]?.label).toContain("id:org-cccc...dd3333");
	});

	it("uses detailed account title in delete confirmation", async () => {
		vi.mocked(select).mockResolvedValueOnce("delete");
		vi.mocked(confirm).mockResolvedValueOnce(true);

		const action = await showAccountDetails({
			index: 0,
			email: "shared@example.com",
			accountLabel: "Workspace A",
			accountId: "org-aaaa1111bbbb2222",
		});

		expect(action).toBe("delete");
		expect(vi.mocked(confirm)).toHaveBeenCalledWith(
			expect.stringContaining("shared@example.com | workspace:Workspace A | id:org-aaaa...bb2222"),
		);
	});

	it("masks emails in the account menu when maskEmail is enabled", async () => {
		vi.mocked(select).mockResolvedValueOnce({ type: "cancel" });

		const accounts: AccountInfo[] = [
			{
				index: 0,
				email: "shared@example.com",
				accountLabel: "Workspace A",
				accountId: "org-aaaa1111bbbb2222",
			},
		];

		await showAuthMenu(accounts, { maskEmail: true });

		const firstCall = vi.mocked(select).mock.calls[0];
		const items = firstCall?.[0] as Array<{ label: string; value?: { type?: string } }>;
		const accountRows = items.filter((item) => item.value?.type === "select-account");
		expect(accountRows[0]?.label).toContain("sh***@example.com");
		expect(accountRows[0]?.label).not.toContain("shared@example.com");
		expect(accountRows[0]?.label).toContain("workspace:Workspace A");
	});

	it("masks the email in the delete confirmation when maskEmail is enabled", async () => {
		vi.mocked(select).mockResolvedValueOnce("delete");
		vi.mocked(confirm).mockResolvedValueOnce(true);

		const action = await showAccountDetails(
			{
				index: 0,
				email: "shared@example.com",
				accountLabel: "Workspace A",
				accountId: "org-aaaa1111bbbb2222",
			},
			{ maskEmail: true },
		);

		expect(action).toBe("delete");
		expect(vi.mocked(confirm)).toHaveBeenCalledWith(
			expect.stringContaining("sh***@example.com | workspace:Workspace A"),
		);
		expect(vi.mocked(confirm)).not.toHaveBeenCalledWith(
			expect.stringContaining("shared@example.com"),
		);
	});
});

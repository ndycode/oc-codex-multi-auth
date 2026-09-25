import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	overview: vi.fn(),
	cachedOverview: vi.fn(),
	promptStatus: vi.fn(),
	resetsParams: vi.fn(),
	sharedSnapshot: vi.fn(),
	projectRoot: null as string | null,
	freshSnapshot: true,
	quotaStatus: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../lib/config.js", async (original) => ({
	...await original<typeof import("../lib/config.js")>(),
	loadPluginConfig: () => ({ codexTuiMaskEmail: true, quotaStatus: mocks.quotaStatus }),
	getCodexTuiMaskEmail: () => true,
}));
vi.mock("../lib/storage.js", () => ({
	getStoragePath: () => "/tmp/opencode/accounts.json",
	loadAccounts: async () => ({ activeIndex: 1, accounts: [
		{ email: "first@example.com", refreshToken: "private-refresh", accessToken: "private-access", enabled: false },
		{ accountLabel: "Work", email: "second@example.com", refreshToken: "another-refresh" },
	] }),
}));
vi.mock("../lib/storage/state.js", () => ({
	getCurrentProjectRoot: () => mocks.projectRoot,
}));
vi.mock("../lib/tui-quota-cache.js", () => ({
	readTuiQuotaSnapshot: mocks.sharedSnapshot,
	readTuiQuotaOverviewSnapshot: mocks.cachedOverview,
	isFreshTuiQuotaSnapshot: () => mocks.freshSnapshot,
	TUI_QUOTA_OVERVIEW_CACHE_FILE: "overview.json",
}));
vi.mock("../lib/tui-quota-overview.js", () => ({
	fetchTuiQuotaOverview: mocks.overview,
	toQuotaOverviewAccounts: () => [],
}));
vi.mock("../lib/tui-status.js", async (original) => ({
	...await original<typeof import("../lib/tui-status.js")>(),
	formatPromptStatusText: (options: unknown) => { mocks.promptStatus(options); return "quota"; },
	formatQuotaResetsStatusLines: (params: unknown) => { mocks.resetsParams(params); return []; },
	formatQuotaOverviewStatusLines: () => ["pool 40%"],
}));
import { readV2Status, resetV2StatusThrottle } from "../lib/opencode-v2-status.js";
import { resolveDisplayEmail } from "../lib/account-display.js";
import { createUsageAccountFingerprint } from "../lib/codex-usage.js";

beforeEach(() => {
	resetV2StatusThrottle();
	mocks.overview.mockReset();
	mocks.cachedOverview.mockReset();
	mocks.sharedSnapshot.mockReset();
	mocks.sharedSnapshot.mockResolvedValue(null);
	mocks.quotaStatus = undefined;
	mocks.projectRoot = null;
	mocks.freshSnapshot = true;
});

it("reports the effective account storage scope", async () => {
	mocks.overview.mockResolvedValue(null);
	expect((await readV2Status({ width: 80 })).accountStorage).toBe("global");
	mocks.projectRoot = "/tmp/opencode/project";
	expect((await readV2Status({ width: 80 })).accountStorage).toBe("project");
});

it("lists every account with masked identities even when quota is unavailable", async () => {
	mocks.overview.mockResolvedValue(null);
	const result = await readV2Status({ width: 80 });
	expect(result.accounts).toEqual([
		{ index: 1, label: resolveDisplayEmail("first@example.com", true), active: false, enabled: false },
		{ index: 2, label: "Work", active: true, enabled: true },
	]);
	expect(JSON.stringify(result)).not.toMatch(/private-refresh|private-access|another-refresh|first@example.com|second@example.com/);
});

it("marks the account serving requests rather than the selected pool account", async () => {
	mocks.overview.mockResolvedValue(null);
	mocks.sharedSnapshot.mockResolvedValue({
		source: "headers", fingerprint: createUsageAccountFingerprint({ refreshToken: "private-refresh" }),
		fetchedAt: Date.now(), limits: [],
	});
	expect((await readV2Status({ width: 80 })).accounts.map((account) => account.active)).toEqual([true, false]);
	mocks.freshSnapshot = false;
	expect((await readV2Status({ width: 80 })).accounts.map((account) => account.active)).toEqual([false, true]);
	mocks.freshSnapshot = true;

	// Another project or a removed account must not influence this pool's sidebar.
	mocks.sharedSnapshot.mockResolvedValue({ source: "headers", fingerprint: "other-pool", fetchedAt: Date.now(), limits: [] });
	expect((await readV2Status({ width: 80 })).accounts.map((account) => account.active)).toEqual([false, true]);
});

it("does not attribute a shared headers snapshot to another seeded project", async () => {
	mocks.overview.mockResolvedValue(null);
	mocks.sharedSnapshot.mockResolvedValue({
		source: "headers", fingerprint: createUsageAccountFingerprint({ refreshToken: "private-refresh" }),
		fetchedAt: Date.now(), limits: [],
	});
	mocks.projectRoot = "/tmp/opencode/project-a";
	expect((await readV2Status({ width: 80 })).accounts.map((account) => account.active)).toEqual([false, true]);
	mocks.projectRoot = "/tmp/opencode/project-b";
	expect((await readV2Status({ width: 80 })).accounts.map((account) => account.active)).toEqual([false, true]);
});

it("does not mistake a usage poll for a serving-account change", async () => {
	mocks.overview.mockResolvedValue(null);
	mocks.sharedSnapshot.mockResolvedValue({
		source: "usage", fingerprint: createUsageAccountFingerprint({ refreshToken: "private-refresh" }),
		fetchedAt: Date.now(), limits: [],
	});
	expect((await readV2Status({ width: 80 })).accounts.map((account) => account.active)).toEqual([false, true]);
});

it("uses a one-based account index in the V2 quota status", async () => {
	mocks.overview.mockResolvedValue({
		fetchedAt: Date.now(),
		accounts: [{ fingerprint: createUsageAccountFingerprint({ refreshToken: "another-refresh" }), limits: [] }],
	});
	await readV2Status({ width: 80 });
	expect(mocks.promptStatus).toHaveBeenLastCalledWith(expect.objectContaining({
		quota: expect.objectContaining({ accountIndex: 2, accountCount: 2 }),
	}));
});

it("does not re-fetch the pool on every poll while the snapshot stays stale", async () => {
	const stale = { fetchedAt: 0, accounts: [] };
	mocks.overview.mockResolvedValue(stale);
	mocks.cachedOverview.mockResolvedValue(stale);
	for (let poll = 0; poll < 5; poll += 1) await readV2Status({ width: 80 });
	expect(mocks.overview).toHaveBeenCalledTimes(1);
	expect(mocks.cachedOverview).toHaveBeenCalledTimes(4);
});

it("skips an empty resets screen instead of blanking the status line", async () => {
	mocks.quotaStatus = { mode: ["resets"] };
	const snapshot = { fetchedAt: Date.now(), accounts: [] };
	mocks.overview.mockResolvedValue(snapshot);
	mocks.cachedOverview.mockResolvedValue(snapshot);
	expect((await readV2Status({ width: 80 })).text).toBe("");

	resetV2StatusThrottle();
	mocks.quotaStatus = { mode: ["overview", "resets"], rotateMs: 1_000 };
	const seen = new Set<string>();
	const now = vi.spyOn(Date, "now");
	for (const at of [0, 1_000, 2_000, 3_000]) {
		now.mockReturnValue(at);
		seen.add((await readV2Status({ width: 80 })).text);
	}
	now.mockRestore();
	expect([...seen]).toEqual(["pool 40%"]);
});

it("keeps the fetched pool when writing its cache failed", async () => {
	mocks.quotaStatus = { mode: ["overview"] };
	mocks.overview.mockResolvedValue({ fetchedAt: Date.now(), accounts: [] });
	mocks.cachedOverview.mockResolvedValue(undefined);
	expect((await readV2Status({ width: 80 })).text).toBe("pool 40%");
	expect((await readV2Status({ width: 80 })).text).toBe("pool 40%");
	expect(mocks.overview).toHaveBeenCalledTimes(1);
});

it("passes resetsMinUsedPercent to the V2 resets screen", async () => {
	mocks.quotaStatus = { mode: ["resets"], resetsMinUsedPercent: 80 };
	mocks.overview.mockResolvedValue({ fetchedAt: Date.now(), accounts: [] });
	await readV2Status({ width: 80 });
	expect(mocks.resetsParams).toHaveBeenLastCalledWith(expect.objectContaining({ resetsMinUsedPercent: 80 }));
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountStorageV3 } from "../lib/storage.js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createUsageAccountFingerprint, createUsageAccountKey, ensureCodexUsageAccessToken, fetchCodexUsage, resolveCodexUsageActiveAccount } from "../lib/codex-usage.js";

vi.mock("../lib/storage.js", async (original) => ({
	...await original<typeof import("../lib/storage.js")>(),
	loadAccounts: vi.fn(),
}));

vi.mock("../lib/codex-usage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/codex-usage.js")>();
	return {
		...actual,
		ensureCodexUsageAccessToken: vi.fn(() => {
			throw new Error("live usage fetch should not happen when a fresh shared snapshot exists");
		}),
		fetchCodexUsage: vi.fn(() => {
			throw new Error("live usage fetch should not happen when a fresh shared snapshot exists");
		}),
	};
});

import { loadAccounts } from "../lib/storage.js";
import {
	createTuiQuotaSnapshot,
	getTuiQuotaCachePath,
	TUI_QUOTA_SNAPSHOT_FRESH_MS,
	writeTuiQuotaSnapshot,
	writeSessionQuotaEntry,
	type TuiQuotaSnapshot,
} from "../lib/tui-quota-cache.js";
import { refreshQuotaStatusInner, resolveQuotaPollTarget } from "../tui.js";

const storage: AccountStorageV3 = {
	version: 3,
	activeIndex: 0,
	accounts: [
		{
			email: "active@example.com",
			accountId: "account-active",
			refreshToken: "refresh-active",
			addedAt: 1,
			lastUsed: 10,
		},
		{
			email: "serving@example.com",
			accountId: "account-serving",
			refreshToken: "refresh-serving",
			addedAt: 2,
			lastUsed: 2,
		},
		{
			email: "serving@example.com",
			accountId: "account-serving",
			refreshToken: "refresh-serving",
			addedAt: 3,
			lastUsed: 3,
		},
	],
};

function createFakeApi(stateDir: string) {
	const kvStore = new Map<string, unknown>();
	return {
		kv: {
			ready: true,
			get: <T>(key: string) => kvStore.get(key) as T,
			set: (key: string, value: unknown) => {
				kvStore.set(key, value);
			},
		},
		state: {
			path: {
				state: stateDir,
			},
		},
	} as unknown as TuiPluginApi;
}

describe("refreshQuotaStatusInner", () => {
	let stateDir: string;

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
		stateDir = await mkdtemp(join(tmpdir(), "oc-codex-tui-quota-"));
		vi.stubEnv("OPENCODE_STATE_DIR", stateDir);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
		vi.clearAllMocks();
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("keeps each session's account and quota when another session updates the shared cache", async () => {
		// Given two sessions with different serving accounts and a newer global response.
		const api = createFakeApi(stateDir);
		const snapshots = [0, 1].map((index) => {
			const account = storage.accounts[index];
			if (!account) throw new Error("missing account fixture");
			return createTuiQuotaSnapshot({
				fingerprint: createUsageAccountFingerprint(account), source: "headers",
				accountIndex: index + 1, accountCount: 3,
				limits: [{ label: "5h", leftPercent: 80 - index * 30 }],
			});
		});
		for (const [index, snapshot] of snapshots.entries()) {
			await writeSessionQuotaEntry(`ses_${index}`, { accountKey: createUsageAccountKey(storage.accounts[index]!), snapshot }, stateDir);
			await writeTuiQuotaSnapshot(snapshot, getTuiQuotaCachePath(stateDir));
		}
		// When both sessions refresh concurrently.
		const results = await Promise.all([0, 1].map((index) => refreshQuotaStatusInner(api, `ses_${index}`)));
		// Then each status and poll retain that session's account and quota.
		expect(results).toMatchObject([
			{ type: "ready", accountIndex: 1, limits: [{ leftPercent: 80 }] },
			{ type: "ready", accountIndex: 2, limits: [{ leftPercent: 50 }] },
		]);
		for (const [index, snapshot] of snapshots.entries()) {
			expect((await resolveQuotaPollTarget(api, `ses_${index}`))?.fingerprint).toBe(snapshot.fingerprint);
		}
	});

	it.each([true, false])("keeps global fallback for a session without a response (shared cache: %s)", async (hasShared) => {
		// Given another session's optional response and a different global active account.
		const api = createFakeApi(stateDir);
		const account = storage.accounts[1];
		if (!account) throw new Error("missing account fixture");
		if (hasShared) await writeTuiQuotaSnapshot(createTuiQuotaSnapshot({
			fingerprint: createUsageAccountFingerprint(account), source: "headers", accountIndex: 2,
			limits: [{ label: "5h", leftPercent: 50 }],
		}), getTuiQuotaCachePath(stateDir));
		if (!hasShared) {
			vi.mocked(ensureCodexUsageAccessToken).mockResolvedValueOnce({ accessToken: "FAKE_ACCESS", refreshed: false, persisted: false });
			vi.mocked(fetchCodexUsage).mockResolvedValueOnce({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 } } });
		}
		// When a new session requests its status.
		const status = await refreshQuotaStatusInner(api, "ses_without_response");
		// Then the existing global rule still selects headers first, otherwise the active account.
		expect(status).toMatchObject({ type: "ready", accountIndex: hasShared ? 2 : 1, limits: [{ leftPercent: hasShared ? 50 : 80 }] });
	});

	it("falls back to global limits when a newer session binding has no limits and usage fails", async () => {
		const api = createFakeApi(stateDir);
		const account = storage.accounts[1];
		if (!account) throw new Error("missing account fixture");
		const identity = { fingerprint: createUsageAccountFingerprint(account), source: "headers" as const, accountIndex: 2 };
		await writeTuiQuotaSnapshot(createTuiQuotaSnapshot({ ...identity, fetchedAt: Date.now() - TUI_QUOTA_SNAPSHOT_FRESH_MS, limits: [{ label: "5h", leftPercent: 50 }] }), getTuiQuotaCachePath(stateDir));
		await writeSessionQuotaEntry("FAKE_SESSION", { accountKey: createUsageAccountKey(account), snapshot: createTuiQuotaSnapshot({ ...identity, limits: [] }) }, stateDir);
		vi.mocked(ensureCodexUsageAccessToken).mockRejectedValueOnce(new Error("FAKE_USAGE_FAILURE"));
		expect(await refreshQuotaStatusInner(api, "FAKE_SESSION")).toMatchObject({ type: "ready", accountIndex: 2, stale: true, limits: [{ leftPercent: 50 }] });
		expect((await resolveQuotaPollTarget(api, "FAKE_SESSION"))?.fingerprint).toBe(identity.fingerprint);
	});

	it("refreshes stale session quota for its serving account instead of the global active account", async () => {
		// Given a session binding whose quota is stale, plus a fresh response for another account.
		const api = createFakeApi(stateDir);
		const account = storage.accounts[1];
		const globalAccount = storage.accounts[0];
		if (!account || !globalAccount) throw new Error("missing account fixture");
		await writeSessionQuotaEntry("ses_stale", { accountKey: createUsageAccountKey(account), snapshot: createTuiQuotaSnapshot({
			fingerprint: createUsageAccountFingerprint(account), source: "headers", accountIndex: 2,
			fetchedAt: Date.now() - TUI_QUOTA_SNAPSHOT_FRESH_MS,
			limits: [{ label: "5h", leftPercent: 50 }],
		}) }, stateDir);
		await writeTuiQuotaSnapshot(createTuiQuotaSnapshot({
			fingerprint: createUsageAccountFingerprint(globalAccount), source: "headers", accountIndex: 1,
			limits: [{ label: "5h", leftPercent: 10 }],
		}), getTuiQuotaCachePath(stateDir));
		vi.mocked(ensureCodexUsageAccessToken).mockResolvedValueOnce({ accessToken: "FAKE_ACCESS", refreshed: false, persisted: false });
		vi.mocked(fetchCodexUsage).mockResolvedValueOnce({ rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18_000 } } });
		// When the stale session refreshes.
		const status = await refreshQuotaStatusInner(api, "ses_stale");
		// Then usage comes from its bound account, and polling retains that binding.
		expect(status).toMatchObject({ type: "ready", accountIndex: 2, limits: [{ leftPercent: 70 }] });
		expect(ensureCodexUsageAccessToken).toHaveBeenCalledWith({ storage, account });
		expect((await resolveQuotaPollTarget(api, "ses_stale"))?.fingerprint).toBe(createUsageAccountFingerprint(account));
	});

	it("keeps an idle session on its serving account after that account's refresh token rotates", async () => {
		// Given a session bound to the serving account before its refresh token rotates.
		const api = createFakeApi(stateDir);
		const serving = { ...storage.accounts[1]!, refreshToken: "FAKE_REFRESH_SERVING_V1" };
		await writeSessionQuotaEntry("FAKE_SESSION", { accountKey: createUsageAccountKey(serving), snapshot: createTuiQuotaSnapshot({
			fingerprint: createUsageAccountFingerprint(serving), source: "headers", accountIndex: 2, accountCount: 3,
			accountEmail: serving.email, fetchedAt: Date.now() - TUI_QUOTA_SNAPSHOT_FRESH_MS,
			limits: [{ label: "5h", leftPercent: 50 }],
		}) }, stateDir);
		// When a refresh rotates the serving account's token.
		const rotated = { ...serving, refreshToken: "FAKE_REFRESH_SERVING_V2" };
		vi.mocked(loadAccounts).mockResolvedValue({ ...storage, accounts: [storage.accounts[0]!, rotated] });
		vi.mocked(ensureCodexUsageAccessToken).mockResolvedValueOnce({ accessToken: "FAKE_ACCESS", refreshed: false, persisted: false });
		vi.mocked(fetchCodexUsage).mockResolvedValueOnce({ rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18_000 } } });
		// Then polling and refresh still follow the serving account, not the active one.
		expect((await resolveQuotaPollTarget(api, "FAKE_SESSION"))?.fingerprint).toBe(createUsageAccountFingerprint(rotated));
		expect(await refreshQuotaStatusInner(api, "FAKE_SESSION")).toMatchObject({
			type: "ready", accountIndex: 2, accountEmail: "serving@example.com", limits: [{ leftPercent: 70 }],
		});
	});

	it("shows the newest quota for the bound account when another session on that account published later", async () => {
		// Given this session's older reading and a newer global reading of the same account.
		const api = createFakeApi(stateDir);
		const account = storage.accounts[1]!;
		const identity = { fingerprint: createUsageAccountFingerprint(account), source: "headers" as const, accountIndex: 2 };
		await writeSessionQuotaEntry("FAKE_SESSION_A", { accountKey: createUsageAccountKey(account), snapshot: createTuiQuotaSnapshot({
			...identity, fetchedAt: Date.now() - 60_000, limits: [{ label: "5h", leftPercent: 80 }],
		}) }, stateDir);
		await writeTuiQuotaSnapshot(createTuiQuotaSnapshot({
			...identity, fetchedAt: Date.now() - 1_000, limits: [{ label: "5h", leftPercent: 50 }],
		}), getTuiQuotaCachePath(stateDir));
		// When the session refreshes, then it shows the newer reading instead of rolling back.
		expect(await refreshQuotaStatusInner(api, "FAKE_SESSION_A")).toMatchObject({
			type: "ready", accountIndex: 2, stale: false, limits: [{ leftPercent: 50 }],
		});
	});

	it.each(["expires", "account is removed"])("keeps the serving account across polls until its snapshot %s", async (invalidation) => {
		const api = createFakeApi(stateDir);
		const cachePath = getTuiQuotaCachePath(stateDir);
		const activeAccount = storage.accounts[0];
		if (!activeAccount) throw new Error("expected active account fixture");
		const activeFingerprint = createUsageAccountFingerprint(activeAccount);

		const servingSnapshot: TuiQuotaSnapshot = createTuiQuotaSnapshot({
			fingerprint: createUsageAccountFingerprint(storage.accounts[1]!),
			source: "headers",
			accountIndex: 2,
			accountCount: 3,
			accountEmail: "serving@example.com",
			accountLabel: "serving@example.com",
			limits: [
				{ label: "5h", leftPercent: 90, usedPercent: 10, windowMinutes: 300 },
			],
			fetchedAt: Date.now(),
		});
		await writeTuiQuotaSnapshot(servingSnapshot, cachePath);

		const result = await refreshQuotaStatusInner(api);

		expect(result.type).toBe("ready");
		if (result.type !== "ready") throw new Error("expected ready status");
		expect(result.fingerprint).toBe(createUsageAccountFingerprint(storage.accounts[1]!));
		expect(result.accountIndex).toBe(2);
		expect(result.accountEmail).toBe("serving@example.com");
		expect(result.stale).toBe(false);
		expect(resolveCodexUsageActiveAccount(storage)?.index).toBe(0);
		expect(ensureCodexUsageAccessToken).not.toHaveBeenCalled();
		expect(fetchCodexUsage).not.toHaveBeenCalled();

		for (const elapsedMs of [1_000, 2_000]) {
			vi.setSystemTime(servingSnapshot.fetchedAt + elapsedMs);
			const pollFingerprint = (await resolveQuotaPollTarget(api))?.fingerprint;
			expect(pollFingerprint).toBe(result.fingerprint);
			expect(pollFingerprint).not.toBe(activeFingerprint);
			expect(ensureCodexUsageAccessToken).not.toHaveBeenCalled();
			expect(fetchCodexUsage).not.toHaveBeenCalled();
		}

		const nextStorage = invalidation === "account is removed"
			? { ...storage, accounts: [activeAccount] }
			: storage;
		vi.mocked(loadAccounts).mockResolvedValue(nextStorage);
		vi.setSystemTime(servingSnapshot.fetchedAt + (
			invalidation === "expires" ? TUI_QUOTA_SNAPSHOT_FRESH_MS : 3_000
		));

		const nextFingerprint = (await resolveQuotaPollTarget(api))?.fingerprint;
		expect(nextFingerprint).toBe(activeFingerprint);
		expect(nextFingerprint).not.toBe(result.fingerprint);
		expect(ensureCodexUsageAccessToken).not.toHaveBeenCalled();
		expect(fetchCodexUsage).not.toHaveBeenCalled();

		vi.mocked(ensureCodexUsageAccessToken).mockResolvedValueOnce({
			accessToken: "test-access-token",
			refreshed: false,
			persisted: false,
		});
		vi.mocked(fetchCodexUsage).mockResolvedValueOnce({
			rate_limit: {
				primary_window: { used_percent: 40, limit_window_seconds: 18_000 },
			},
		});
		const refreshed = await refreshQuotaStatusInner(api);
		expect(refreshed).toMatchObject({
			type: "ready",
			fingerprint: activeFingerprint,
			accountEmail: "active@example.com",
			accountCount: nextStorage.accounts.length,
			source: "usage",
			stale: false,
			limits: [{ label: "5h", leftPercent: 60 }],
		});
		expect(ensureCodexUsageAccessToken).toHaveBeenCalledExactlyOnceWith({
			storage: nextStorage,
			account: activeAccount,
		});
		expect(fetchCodexUsage).toHaveBeenCalledExactlyOnceWith({
			accountId: "account-active",
			accessToken: "test-access-token",
			organizationId: undefined,
		});

		vi.setSystemTime(Date.now() + 1_000);
		expect((await resolveQuotaPollTarget(api))?.fingerprint).toBe(nextFingerprint);
		expect(ensureCodexUsageAccessToken).toHaveBeenCalledTimes(1);
		expect(fetchCodexUsage).toHaveBeenCalledTimes(1);
	});

	it("does not display a stale snapshot for a different account as the active account's numbers", async () => {
		const api = createFakeApi(stateDir);
		const cachePath = getTuiQuotaCachePath(stateDir);

		const staleOtherAccountSnapshot: TuiQuotaSnapshot = createTuiQuotaSnapshot({
			fingerprint: "fingerprint-stale-other-account",
			source: "headers",
			accountIndex: 3,
			accountCount: 3,
			accountEmail: "serving@example.com",
			accountLabel: "serving@example.com",
			limits: [
				{ label: "5h", leftPercent: 90, usedPercent: 10, windowMinutes: 300 },
			],
			fetchedAt: Date.now() - 60 * 60 * 1000,
		});
		await writeTuiQuotaSnapshot(staleOtherAccountSnapshot, cachePath);

		const result = await refreshQuotaStatusInner(api);

		expect(result.type).toBe("unavailable");
	});
	it("ignores a fresh snapshot from an account outside the current pool", async () => {
		await writeTuiQuotaSnapshot(createTuiQuotaSnapshot({
			fingerprint: "another-project", source: "headers", accountIndex: 1,
			accountCount: 1, accountEmail: "other@example.com", fetchedAt: Date.now(),
			limits: [{ label: "5h", leftPercent: 80, usedPercent: 20, windowMinutes: 300 }],
		}), getTuiQuotaCachePath(stateDir));
		expect((await refreshQuotaStatusInner(createFakeApi(stateDir))).type).toBe("unavailable");
	});
});

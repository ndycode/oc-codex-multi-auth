import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	clearTuiQuotaSnapshot,
	createTuiQuotaSnapshot,
	getTuiQuotaCachePath,
	isFreshTuiQuotaSnapshot,
	parseTuiQuotaSnapshotFromHeaders,
	readTuiQuotaSnapshot,
	writeTuiQuotaSnapshot,
	readSessionQuotaSnapshot,
	writeSessionQuotaSnapshot,
	TUI_QUOTA_CACHE_VERSION,
	TUI_QUOTA_SNAPSHOT_FRESH_MS,
} from "../lib/tui-quota-cache.js";
import { formatQuotaDetailsText, type CompactQuotaStatus } from "../lib/tui-status.js";
import { getQuotaExhaustedResetAtMs, MAX_QUOTA_RESET_HORIZON_MS } from "../lib/quota-windows.js";

describe("TUI quota cache", () => {
	it("bounds session storage and preserves concurrent sessions without credentials", async () => {
		// Given more sessions than the cache can retain and a credential-bearing input.
		const dir = await mkdtemp(join(tmpdir(), "tui-session-quota-"));
		const snapshot = { ...createTuiQuotaSnapshot({
			fingerprint: "FAKE_FINGERPRINT", source: "headers", limits: [{ label: "5h", leftPercent: 80 }],
		}), accessToken: "FAKE_SECRET_ACCESS", refreshToken: "FAKE_SECRET_REFRESH" };
		try {
			for (let index = 0; index < 128; index++) await writeSessionQuotaSnapshot(`ses_${index}`, snapshot, dir);
			// When concurrent writers add two sessions and update a retained session.
			await Promise.all(["ses_128", "ses_129", "ses_64"].map((id) => writeSessionQuotaSnapshot(id, snapshot, dir)));
			// Then the oldest sessions are evicted, both new sessions survive, and no tokens reach disk.
			expect(await readSessionQuotaSnapshot("ses_0", dir)).toBeUndefined();
			expect(await readSessionQuotaSnapshot("ses_1", dir)).toBeUndefined();
			for (const id of ["ses_64", "ses_128", "ses_129"]) {
				expect(await readSessionQuotaSnapshot(id, dir)).toMatchObject({ fingerprint: "FAKE_FINGERPRINT" });
			}
			const files = await fs.readdir(dir);
			expect(files).toHaveLength(1);
			const file = files[0];
			if (!file) throw new Error("missing session cache");
			const raw = await fs.readFile(join(dir, file), "utf-8");
			expect(JSON.parse(raw)).toHaveLength(128);
			expect(raw).not.toContain("FAKE_SECRET");
			expect(raw).not.toContain("ses_129");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("parses Codex quota response headers into a prompt snapshot", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "20",
			"x-codex-primary-window-minutes": "300",
			"x-codex-secondary-used-percent": "16",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-plan-type": "plus",
			"x-codex-active-limit": "40",
		});

		const snapshot = parseTuiQuotaSnapshotFromHeaders(headers, {
			fingerprint: "acct",
			accountIndex: 2,
			accountCount: 3,
			accountEmail: "user2@example.com",
			accountLabel: "Account 2",
			fetchedAt: 1000,
		});

		expect(snapshot).toEqual(
			expect.objectContaining({
				fingerprint: "acct",
				source: "headers",
				accountIndex: 2,
				accountCount: 3,
				accountEmail: "user2@example.com",
				accountLabel: "Account 2",
				planType: "plus",
				activeLimit: 40,
			}),
		);
		expect(snapshot?.limits).toEqual([
			expect.objectContaining({
				label: "5h",
				leftPercent: 80,
				usedPercent: 20,
				windowMinutes: 300,
			}),
			expect.objectContaining({
				label: "7d",
				leftPercent: 84,
				usedPercent: 16,
				windowMinutes: 10080,
			}),
		]);
	});

	it("returns undefined when response headers do not include quota", () => {
		expect(
			parseTuiQuotaSnapshotFromHeaders(new Headers(), {
				fingerprint: "acct",
			}),
		).toBeUndefined();
	});

	it("round-trips the shared quota cache file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tui-quota-cache-"));
		const path = getTuiQuotaCachePath(dir);
		try {
			const snapshot = createTuiQuotaSnapshot({
				fingerprint: "acct",
				source: "usage",
				fetchedAt: 1000,
				limits: [{ label: "5h", leftPercent: 99 }],
			});
			await writeTuiQuotaSnapshot(snapshot, path);
			await expect(readTuiQuotaSnapshot(path)).resolves.toEqual(snapshot);
			await clearTuiQuotaSnapshot(path);
			await expect(readTuiQuotaSnapshot(path)).resolves.toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("skips repeated equivalent writes in a short window", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tui-quota-cache-"));
		const path = getTuiQuotaCachePath(dir);
		try {
			const first = createTuiQuotaSnapshot({
				fingerprint: "acct",
				source: "headers",
				fetchedAt: 1000,
				limits: [{ label: "5h", leftPercent: 94 }],
			});
			const second = createTuiQuotaSnapshot({
				fingerprint: "acct",
				source: "headers",
				fetchedAt: 2000,
				limits: [{ label: "5h", leftPercent: 94 }],
			});

			await writeTuiQuotaSnapshot(first, path);
			await writeTuiQuotaSnapshot(second, path);

			await expect(readTuiQuotaSnapshot(path)).resolves.toEqual(first);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("snapshot freshness", () => {
	const now = 1_752_000_000_000;

	it("trusts a snapshot within the freshness horizon", () => {
		expect(
			isFreshTuiQuotaSnapshot(
				{ fetchedAt: now - TUI_QUOTA_SNAPSHOT_FRESH_MS + 1 },
				now,
			),
		).toBe(true);
	});

	it("rejects a snapshot at or beyond the horizon so an idle TUI re-fetches", () => {
		// The shared cache is only pushed while requests flow; after an idle
		// gap the windows it describes may have reset server-side, so an old
		// snapshot must not short-circuit the live /wham/usage read.
		expect(
			isFreshTuiQuotaSnapshot(
				{ fetchedAt: now - TUI_QUOTA_SNAPSHOT_FRESH_MS },
				now,
			),
		).toBe(false);
		expect(
			isFreshTuiQuotaSnapshot({ fetchedAt: now - 6 * 60 * 60 * 1000 }, now),
		).toBe(false);
	});

	it("treats a clock-skewed future timestamp as fresh", () => {
		expect(isFreshTuiQuotaSnapshot({ fetchedAt: now + 60_000 }, now)).toBe(
			true,
		);
	});
});

describe("disabled quota windows (issue #194)", () => {
	it("omits a secondary window the server reports as disabled", () => {
		// Headers reproduced from the bug report: a paid Team workspace with an
		// active weekly window and a secondary window switched off by OpenAI.
		const headers = new Headers({
			"x-codex-primary-used-percent": "23",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-secondary-used-percent": "0",
			"x-codex-secondary-window-minutes": "0",
			"x-codex-secondary-reset-after-seconds": "0",
		});

		const snapshot = parseTuiQuotaSnapshotFromHeaders(headers, {
			fingerprint: "acct",
		});

		expect(snapshot?.limits).toHaveLength(1);
		expect(snapshot?.limits[0]).toMatchObject({
			label: "7d",
			leftPercent: 77,
		});
		expect(snapshot?.limits.some((limit) => limit.label === "quota")).toBe(false);
	});

	it("still keeps a window whose length header is absent", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "40",
		});

		const snapshot = parseTuiQuotaSnapshotFromHeaders(headers, {
			fingerprint: "acct",
		});

		expect(snapshot?.limits).toHaveLength(1);
		expect(snapshot?.limits[0]).toMatchObject({ label: "quota", leftPercent: 60 });
	});

	it("returns undefined when every reported window is disabled", () => {
		const headers = new Headers({
			"x-codex-primary-window-minutes": "0",
			"x-codex-primary-used-percent": "0",
			"x-codex-secondary-window-minutes": "0",
			"x-codex-secondary-used-percent": "0",
		});

		expect(
			parseTuiQuotaSnapshotFromHeaders(headers, { fingerprint: "acct" }),
		).toBeUndefined();
	});

	it("heals a cache already poisoned by an older build", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tui-quota-disabled-"));
		const cachePath = join(dir, "quota.json");
		try {
			const poisoned = createTuiQuotaSnapshot({
				fingerprint: "acct",
				source: "headers",
				limits: [
					{ label: "7d", leftPercent: 77, usedPercent: 23, windowMinutes: 10080 },
					{ label: "quota", leftPercent: 100, usedPercent: 0, windowMinutes: 0 },
				],
			});
			await writeTuiQuotaSnapshot(poisoned, cachePath);

			const restored = await readTuiQuotaSnapshot(cachePath);

			expect(restored?.limits).toHaveLength(1);
			expect(restored?.limits[0]?.label).toBe("7d");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("tui quota status hostile inputs", () => {
	it("a negative active-limit header never renders a negative count", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "40",
			"x-codex-primary-window-minutes": "300",
			"x-codex-active-limit": "-5",
		});
		const snapshot = parseTuiQuotaSnapshotFromHeaders(headers, {
			fingerprint: "fp",
			accountIndex: 0,
			accountCount: 3,
		});
		expect(snapshot).toBeDefined();
		const status: CompactQuotaStatus = {
			type: "ready",
			limits: snapshot!.limits,
			stale: false,
			source: "headers",
			activeLimit: snapshot!.activeLimit,
		};
		const text = formatQuotaDetailsText(status);
		expect(text).not.toMatch(/-\d/);
	});
});

const HEADER_VALUES = [
	"",
	" ",
	"-1",
	"1e309",
	"NaN",
	"Infinity",
	"0x64",
	"999999999999999999999999",
];

function headerBattery(name: string): Headers[] {
	return HEADER_VALUES.map((value) => new Headers({ [name]: value }));
}

describe("quota header battery", () => {
	it("used-percent battery never produces NaN or negative leftPercent", () => {
		const names = ["x-codex-primary-used-percent", "x-codex-secondary-used-percent"];
		for (const name of names) {
			for (const headers of headerBattery(name)) {
				const snapshot = parseTuiQuotaSnapshotFromHeaders(headers, {
					fingerprint: "fp",
				});
				for (const limit of snapshot?.limits ?? []) {
					expect(
						Number.isFinite(limit.leftPercent ?? 0) && (limit.leftPercent ?? 0) >= 0,
						`${name}=${JSON.stringify(headers.get(name))} -> leftPercent ${limit.leftPercent}`,
					).toBe(true);
				}
			}
		}
	});

	it("reset-at / reset-after batteries stay within the 30-day horizon", () => {
		const names = [
			"x-codex-primary-reset-at",
			"x-codex-primary-reset-after-seconds",
			"x-codex-secondary-reset-at",
			"x-codex-secondary-reset-after-seconds",
		];
		for (const name of names) {
			for (const headers of headerBattery(name)) {
				const resetAt = getQuotaExhaustedResetAtMs(headers);
				if (typeof resetAt === "number") {
					expect(resetAt - Date.now()).toBeLessThanOrEqual(MAX_QUOTA_RESET_HORIZON_MS);
				}
			}
		}
	});

	it("details text over the whole battery never contains NaN, Infinity, or a negative percent", () => {
		const nameSets: Record<string, string> = {
			"x-codex-primary-used-percent": "percent",
			"x-codex-primary-window-minutes": "minutes",
			"x-codex-primary-reset-at": "reset",
			"x-codex-active-limit": "active",
		};
		for (const [name] of Object.entries(nameSets)) {
			for (const headers of headerBattery(name)) {
				headers.set("x-codex-primary-used-percent", headers.get(name) ?? "10");
				const snapshot = parseTuiQuotaSnapshotFromHeaders(headers, { fingerprint: "fp" });
				if (!snapshot) continue;
				const status: CompactQuotaStatus = {
					type: "ready",
					limits: snapshot.limits,
					stale: false,
					source: "headers",
					activeLimit: snapshot.activeLimit,
				};
				const text = formatQuotaDetailsText(status);
				expect(text, `${name}=${headers.get(name)}`).not.toMatch(/NaN|Infinity/);
				expect(text, `${name}=${headers.get(name)}`).not.toMatch(/left: -\d|-\d+%/);
			}
		}
	});
});

describe("TUI quota cache file boundary", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = join(
			tmpdir(),
			`stress-domain2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await fs.mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("a cache file with a negative leftPercent is rejected on read", async () => {
		const cachePath = join(testDir, "quota.json");
		const hostile = {
			version: TUI_QUOTA_CACHE_VERSION,
			fingerprint: "fp",
			fetchedAt: Date.now(),
			source: "headers",
			limits: [{ label: "5h limit", leftPercent: -10 }],
		};
		await fs.writeFile(cachePath, JSON.stringify(hostile), "utf-8");
		expect(await readTuiQuotaSnapshot(cachePath)).toBeUndefined();
	});

	it("a cache file with non-finite fetchedAt or limits is rejected on read", async () => {
		const cachePath = join(testDir, "quota.json");
		const hostile = {
			version: TUI_QUOTA_CACHE_VERSION,
			fingerprint: "fp",
			fetchedAt: 1e400,
			source: "usage",
			limits: [{ label: "x", leftPercent: 50, resetAtMs: NaN }],
		};
		await fs.writeFile(cachePath, JSON.stringify(hostile), "utf-8");
		expect(await readTuiQuotaSnapshot(cachePath)).toBeUndefined();
	});

	it("a truncated or empty cache file is rejected on read", async () => {
		const cachePath = join(testDir, "quota.json");
		await fs.writeFile(cachePath, "", "utf-8");
		expect(await readTuiQuotaSnapshot(cachePath)).toBeUndefined();
		await fs.writeFile(cachePath, '{"version":1,"fingerprint":"fp"}', "utf-8");
		expect(await readTuiQuotaSnapshot(cachePath)).toBeUndefined();
	});

	it("a valid round-trip write/read survives", async () => {
		const cachePath = join(testDir, "quota.json");
		const snapshot = parseTuiQuotaSnapshotFromHeaders(
			new Headers({
				"x-codex-primary-used-percent": "40",
				"x-codex-primary-window-minutes": "300",
			}),
			{ fingerprint: "fp", accountIndex: 0, accountCount: 2 },
		)!;
		await writeTuiQuotaSnapshot(snapshot, cachePath);
		const readBack = await readTuiQuotaSnapshot(cachePath);
		expect(readBack?.fingerprint).toBe("fp");
	});
});

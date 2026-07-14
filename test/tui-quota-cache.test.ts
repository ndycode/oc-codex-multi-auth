import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
	clearTuiQuotaSnapshot,
	createTuiQuotaSnapshot,
	getTuiQuotaCachePath,
	parseTuiQuotaSnapshotFromHeaders,
	readTuiQuotaSnapshot,
	writeTuiQuotaSnapshot,
} from "../lib/tui-quota-cache.js";

describe("TUI quota cache", () => {
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

import { describe, expect, it } from "vitest";

import {
	deduplicateUsageAccountIndices,
	getUsageLeftPercent,
	parseCodexUsagePayload,
	resolveCodexUsageActiveAccount,
	type UsagePayload,
} from "../lib/codex-usage.js";
import type { AccountStorageV3 } from "../lib/storage.js";

describe("codex usage helpers", () => {
	it("parses usage payloads using remaining-percent semantics", () => {
		const payload: UsagePayload = {
			plan_type: "team",
			rate_limit: {
				primary_window: {
					used_percent: 13,
					limit_window_seconds: 18000,
				},
				secondary_window: {
					used_percent: 36,
					limit_window_seconds: 604800,
				},
			},
			code_review_rate_limit: {
				primary_window: {
					used_percent: 0,
					limit_window_seconds: 604800,
				},
			},
			additional_rate_limits: [
				{
					limit_name: "batch_jobs",
					rate_limit: {
						primary_window: {
							used_percent: 25,
							limit_window_seconds: 3600,
						},
					},
				},
			],
			credits: { unlimited: true },
		};

		const usage = parseCodexUsagePayload(payload);

		expect(usage.planType).toBe("team");
		expect(usage.credits).toBe("unlimited");
		expect(usage.limits).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "5h limit",
					leftPercent: 87,
					summary: "87% left",
				}),
				expect.objectContaining({
					name: "Weekly limit",
					leftPercent: 64,
					summary: "64% left",
				}),
				expect.objectContaining({
					name: "Code review",
					leftPercent: 100,
				}),
				expect.objectContaining({
					name: "Batch Jobs",
					leftPercent: 75,
				}),
			]),
		);
	});

	it("clamps remaining percent and preserves active codex account selection", () => {
		expect(getUsageLeftPercent(-10)).toBe(100);
		expect(getUsageLeftPercent(110)).toBe(0);
		expect(getUsageLeftPercent(12.4)).toBe(88);

		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 2 },
			accounts: [
				{ refreshToken: "r1", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r1", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r2", accountId: "acc-2", addedAt: 0, lastUsed: 0 },
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([1, 2]);
		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 2,
			account: { accountId: "acc-2" },
		});
	});

	it("keeps same-token workspace entries distinct, skips disabled, and prefers the freshest duplicate", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{ refreshToken: "r1", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r1", accountId: "acc-2", organizationId: "org-2", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r2", accountId: "acc-3", enabled: false, addedAt: 0, lastUsed: 50 },
				{ refreshToken: "r3", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 0 },
			],
		};

		// org-1 (key W) appears at index 0 and again at index 3 (re-added with a
		// fresh token r3); org-2 (key X) at index 1; index 2 disabled. Display
		// order follows first appearance (W then X), but W resolves to its
		// freshest occurrence (index 3, token r3), not the stale index 0.
		expect(deduplicateUsageAccountIndices(storage)).toEqual([3, 1]);
		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 0,
			account: { accountId: "acc-1" },
		});
	});

	it("deduplicates workspace identities without delimiter collisions", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{ refreshToken: "r1", accountId: "acc:1", organizationId: "org", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r2", accountId: "acc", organizationId: "1:org", addedAt: 0, lastUsed: 0 },
			],
		};

		expect(deduplicateUsageAccountIndices(storage)).toEqual([0, 1]);
	});

	it("handles sparse/undefined account slots without throwing", () => {
		const storage = {
			version: 3,
			activeIndex: 5,
			accounts: [
				undefined,
				{ refreshToken: "r1", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 10 },
			],
		} as unknown as AccountStorageV3;

		expect(() => resolveCodexUsageActiveAccount(storage)).not.toThrow();
		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 1,
			account: { accountId: "acc-1" },
		});
	});

	it("returns null when every account slot is empty or disabled", () => {
		const storage = {
			version: 3,
			activeIndex: 0,
			accounts: [
				undefined,
				{ refreshToken: "r2", accountId: "acc-2", enabled: false, addedAt: 0, lastUsed: 0 },
			],
		} as unknown as AccountStorageV3;

		expect(resolveCodexUsageActiveAccount(storage)).toBeNull();
	});

	it("keeps the active account when its lastUsed is missing", () => {
		const storage = {
			version: 3,
			activeIndex: 1,
			accounts: [
				{ refreshToken: "r1", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r2", accountId: "acc-2", organizationId: "org-2", addedAt: 0 },
			],
		} as unknown as AccountStorageV3;

		// The active account (index 1) has no lastUsed. It must not lose the
		// marker to index 0's lastUsed:0 via a 0 > -1 comparison.
		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 1,
			account: { accountId: "acc-2" },
		});
	});

	it("drops accounts that have no workspace identity and no refresh token", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{ addedAt: 0, lastUsed: 0 },
				{ refreshToken: "r1", accountId: "acc-1", organizationId: "org-1", addedAt: 0, lastUsed: 0 },
			],
		};

		// The identity-less entry (index 0) yields no dedupe key and is excluded.
		expect(deduplicateUsageAccountIndices(storage)).toEqual([1]);
	});

	it("uses the most recently persisted request account for usage display", () => {
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: { codex: 0 },
			accounts: [
				{ refreshToken: "r1", accountId: "acc-1", addedAt: 0, lastUsed: 10 },
				{ refreshToken: "r2", accountId: "acc-2", addedAt: 0, lastUsed: 20 },
			],
		};

		expect(resolveCodexUsageActiveAccount(storage)).toMatchObject({
			index: 1,
			account: { accountId: "acc-2" },
		});
	});
});

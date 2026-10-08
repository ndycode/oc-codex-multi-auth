import { describe, expect, it } from "vitest";
import { RotationObservations } from "../lib/custom-rotation/observations.js";
import type { AccountMetadataV3 } from "../lib/storage.js";
import type { UsagePayload } from "../lib/codex-usage.js";

const account: AccountMetadataV3 = { accountId: "business", accountUserId: "seat-a", refreshToken: "synthetic", addedAt: 1, lastUsed: 2 };
describe("custom rotation observations", () => {
	it("preserves unknown values when no observation has arrived", () => {
		const store = new RotationObservations();
		const result = store.snapshot(account, "project", 1000);
		expect(result.primary.usedPercent).toMatchObject({ status: "unknown", value: null, observedAt: null });
	});
	it("marks observed quota stale when its freshness expires", () => {
		const store = new RotationObservations();
		store.usage(account, "project", { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 500 } } }, 1000);
		const result = store.snapshot(account, "project", 301_000);
		expect(result.primary.usedPercent).toMatchObject({ status: "stale", value: 20, scope: "seat", observedAt: 1000 });
	});
	it.each([
		{},
		{ rate_limit: {} },
		{ credits: { balance: "12", unlimited: false } },
	] satisfies UsagePayload[])("keeps never-observed windows unknown when usage omits them: %j", (payload) => {
		// Given
		const store = new RotationObservations();
		// When
		store.usage(account, "project", payload, 1000);
		// Then
		const result = store.snapshot(account, "project", 1000);
		for (const window of [result.primary, result.secondary]) {
			for (const field of Object.values(window)) {
				expect(field).toEqual({ value: null, status: "unknown", observedAt: null, expiresAt: null, source: null, scope: "unknown" });
			}
		}
	});
	it("preserves header window freshness when usage only updates credits", () => {
		// Given
		const store = new RotationObservations();
		store.headers(account, "project", new Headers({
			"x-codex-primary-used-percent": "20", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": "500",
			"x-codex-secondary-used-percent": "40", "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": "900",
		}), 1000);
		const before = store.snapshot(account, "project", 1000);
		// When
		store.usage(account, "project", { credits: { balance: "12", unlimited: false } }, 2000);
		// Then
		const result = store.snapshot(account, "project", 2000);
		expect(result.primary).toEqual(before.primary);
		expect(result.secondary).toEqual(before.secondary);
		const expired = store.snapshot(account, "project", 301_000);
		for (const window of [expired.primary, expired.secondary]) {
			for (const field of Object.values(window)) {
				expect(field).toMatchObject({ status: "stale", observedAt: 1000, expiresAt: 301_000, source: "headers" });
			}
		}
		expect(expired.credits).toMatchObject({ value: { balance: "12", unlimited: false }, status: "fresh", observedAt: 2000, expiresAt: 302_000, source: "usage" });
	});
	it("preserves missing fields and the secondary window when usage reports only primary utilization", () => {
		// Given
		const store = new RotationObservations();
		store.usage(account, "project", { rate_limit: {
			primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 500 },
			secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 900 },
		} }, 1000);
		const before = store.snapshot(account, "project", 1000);
		// When
		store.usage(account, "project", { rate_limit: { primary_window: { used_percent: 30 } } }, 2000);
		// Then
		const result = store.snapshot(account, "project", 301_000);
		expect(result.primary.usedPercent).toMatchObject({ value: 30, status: "fresh", observedAt: 2000, expiresAt: 302_000 });
		expect(result.primary.resetAtMs).toEqual({ ...before.primary.resetAtMs, status: "stale" });
		expect(result.primary.windowMinutes).toEqual({ ...before.primary.windowMinutes, status: "stale" });
		for (const key of ["usedPercent", "resetAtMs", "windowMinutes"] as const) {
			expect(result.secondary[key]).toEqual({ ...before.secondary[key], status: "stale" });
		}
	});
	it("marks both windows not-applicable when usage explicitly reports null", () => {
		// Given
		const store = new RotationObservations();
		// When
		store.usage(account, "project", { rate_limit: { primary_window: null, secondary_window: null } }, 1000);
		// Then
		const result = store.snapshot(account, "project", 1000);
		for (const window of [result.primary, result.secondary]) {
			for (const field of Object.values(window)) {
				expect(field).toMatchObject({ value: null, status: "not-applicable", observedAt: 1000, source: "usage" });
			}
		}
	});
	it("marks disabled quota not-applicable when the plan reports a zero window", () => {
		const store = new RotationObservations();
		store.usage(account, "project", { rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 0 } } }, 1000);
		const result = store.snapshot(account, "project", 1000);
		expect(result.primary.usedPercent).toMatchObject({ status: "not-applicable", value: null });
	});
	it("keeps newer header fields when older background usage finishes later", () => {
		const store = new RotationObservations();
		store.headers(account, "project", new Headers({ "x-codex-primary-used-percent": "90" }), 2000);
		store.usage(account, "project", { rate_limit: { primary_window: { used_percent: 10, reset_at: 500 } } }, 1000);
		const result = store.snapshot(account, "project", 2000);
		expect(result.primary.usedPercent).toMatchObject({ value: 90, source: "headers", observedAt: 2000 });
		expect(result.primary.resetAtMs.value).toBe(500_000);
	});
	it("preserves string credit balances when they exceed numeric precision", () => {
		const store = new RotationObservations();
		store.usage(account, "project", { credits: { balance: "999999999999999999.125", unlimited: false } }, 1000);
		const result = store.snapshot(account, "project", 1000);
		expect(result.credits.value).toEqual({ balance: "999999999999999999.125", unlimited: false });
	});
	it("keeps unlimited distinct from unknown balance when credits report it", () => {
		const store = new RotationObservations();
		store.usage(account, "project", { credits: { unlimited: true, balance: null } }, 1000);
		const result = store.snapshot(account, "project", 1000);
		expect(result.credits.value).toEqual({ balance: null, unlimited: true });
	});
	it("separates observations when Business seats share a workspace", () => {
		const store = new RotationObservations();
		store.usage(account, "project", { plan_type: "business" }, 1000);
		const result = store.snapshot({ ...account, accountUserId: "seat-b" }, "project", 1000);
		expect(result.plan.status).toBe("unknown");
	});
	it("expires reset counts separately when the 30-minute interval passes", () => {
		const store = new RotationObservations();
		store.resets(account, "project", 2, 1000);
		const result = store.snapshot(account, "project", 1_801_000);
		expect(result.resetCredits).toMatchObject({ value: 2, status: "stale", source: "reset-list" });
	});
});

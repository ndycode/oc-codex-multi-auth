/**
 * Deep stress / adversarial coverage for issue #182 — the account warm-up
 * orchestrator (`warmAccounts`). Drives hostile mixes: all-fail, all-skip,
 * thrown vs returned failures, large fleets, ordering under randomized delays,
 * and strict sequential vs concurrent execution. The orchestrator is pure
 * (network injected), so these are deterministic.
 */

import { describe, it, expect, vi } from "vitest";
import { warmAccounts, type WarmOutcome } from "../../lib/accounts/warm.js";

interface FakeAccount {
	id: number;
	enabled?: boolean;
}

const fleet = (n: number, disabledIds: number[] = []): FakeAccount[] =>
	Array.from({ length: n }, (_v, i) => ({
		id: i,
		enabled: disabledIds.includes(i) ? false : undefined,
	}));

describe("chaos/accounts-warm — adversarial warm-up (issue #182)", () => {
	it("large fleet (200): all warmed, count exact, order preserved", async () => {
		const accounts = fleet(200);
		const summary = await warmAccounts(accounts, async () => ({ status: "warmed" }));
		expect(summary.total).toBe(200);
		expect(summary.warmedCount).toBe(200);
		expect(summary.results.map((r) => r.account.id)).toEqual(
			accounts.map((a) => a.id),
		);
	});

	it("every account fails (returned): batch still completes with full failure count", async () => {
		const accounts = fleet(50);
		const summary = await warmAccounts(accounts, async () => ({
			status: "failed",
			detail: "503",
		}));
		expect(summary.failedCount).toBe(50);
		expect(summary.warmedCount).toBe(0);
		expect(summary.results.every((r) => r.detail === "503")).toBe(true);
	});

	it("every account throws: orchestrator captures all as failed, never rejects", async () => {
		const accounts = fleet(30);
		await expect(
			warmAccounts(accounts, async () => {
				throw new Error("boom");
			}),
		).resolves.toMatchObject({ failedCount: 30, warmedCount: 0 });
	});

	it("interleaved warmed/failed/skipped/throw stays correctly classified", async () => {
		// ids: 0 warmed, 1 failed(returned), 2 disabled(skip), 3 throws, 4 warmed
		const accounts = fleet(5, [2]);
		const summary = await warmAccounts(accounts, async (a) => {
			if (a.id === 1) return { status: "failed", detail: "rate" } as WarmOutcome;
			if (a.id === 3) throw new Error("network");
			return { status: "warmed" };
		});
		expect(summary.warmedCount).toBe(2);
		expect(summary.failedCount).toBe(2);
		expect(summary.skippedCount).toBe(1);
		const byId = new Map(summary.results.map((r) => [r.account.id, r]));
		expect(byId.get(0)?.status).toBe("warmed");
		expect(byId.get(1)?.status).toBe("failed");
		expect(byId.get(2)?.status).toBe("skipped");
		expect(byId.get(3)?.status).toBe("failed");
		expect(byId.get(3)?.detail).toBe("network");
		expect(byId.get(4)?.status).toBe("warmed");
	});

	it("all disabled: zero upstream calls, all skipped", async () => {
		const accounts = fleet(10, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		const warmOne = vi.fn(async (): Promise<WarmOutcome> => ({ status: "warmed" }));
		const summary = await warmAccounts(accounts, warmOne);
		expect(warmOne).not.toHaveBeenCalled();
		expect(summary.skippedCount).toBe(10);
	});

	it("concurrent mode genuinely overlaps but preserves result order under jittered delays", async () => {
		const accounts = fleet(20);
		let inFlight = 0;
		let maxInFlight = 0;
		const summary = await warmAccounts(accounts, async (a) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, (a.id * 7) % 13));
			inFlight--;
			return { status: "warmed" };
		});
		expect(maxInFlight).toBeGreaterThan(1);
		expect(summary.results.map((r) => r.account.id)).toEqual(
			accounts.map((a) => a.id),
		);
	});

	it("sequential mode never overlaps and processes in order", async () => {
		const accounts = fleet(15);
		const order: number[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		await warmAccounts(
			accounts,
			async (a) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 1));
				order.push(a.id);
				inFlight--;
				return { status: "warmed" };
			},
			{ concurrent: false },
		);
		expect(maxInFlight).toBe(1);
		expect(order).toEqual(accounts.map((a) => a.id));
	});

	it("a non-Error throw (string) is still captured as a failed outcome", async () => {
		const accounts = fleet(3);
		const summary = await warmAccounts(accounts, async (a) => {
			if (a.id === 1) throw "weird string error";
			return { status: "warmed" };
		});
		expect(summary.failedCount).toBe(1);
		const failed = summary.results.find((r) => r.account.id === 1);
		expect(failed?.detail).toContain("weird string error");
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRotationMonitor, type RotationMonitor } from "../lib/custom-rotation/monitor.js";
import type { AccountStorageV3 } from "../lib/storage.js";

let monitors: RotationMonitor[];
beforeEach(() => { monitors = []; });
afterEach(() => { for (const monitor of monitors) monitor.dispose(); vi.useRealTimers(); });
const storage: AccountStorageV3 = { version: 3, activeIndex: 0, accounts: [
	{ accountId: "business", accountUserId: "a", refreshToken: "synthetic-a", addedAt: 1 },
	{ accountId: "business", accountUserId: "b", refreshToken: "synthetic-b", addedAt: 1 },
	{ accountId: "business", accountUserId: "a", refreshToken: "synthetic-new-a", addedAt: 2 },
	{ accountId: "disabled", refreshToken: "synthetic-disabled", enabled: false, addedAt: 1 },
] };
function setup(overrides: Parameters<typeof createRotationMonitor>[0] = {}) {
	let now = 1000;
	const usage = vi.fn().mockResolvedValue({ credits: { balance: "10.5" } });
	const resets = vi.fn().mockResolvedValue({ available_count: 2 });
	const credentials = vi.fn().mockResolvedValue({ accessToken: "synthetic-access", refreshed: false, persisted: false });
	const monitor = createRotationMonitor({ enabled: () => true, scope: () => "project", now: () => now, load: async () => storage, usage, resets, credentials, ...overrides });
	monitors.push(monitor);
	return { monitor, usage, resets, credentials, advance: (ms: number) => { now += ms; } };
}

describe("custom-only observation monitor", () => {
	it("does no storage or endpoint work when custom mode is disabled", async () => {
		const load = vi.fn();
		const { monitor, usage } = setup({ enabled: () => false, load });
		await monitor.runNow();
		expect(load).not.toHaveBeenCalled();
		expect(usage).not.toHaveBeenCalled();
	});
	it("deduplicates workspace seats when initial background checks run", async () => {
		const { monitor, usage, resets, credentials } = setup();
		await monitor.runNow();
		expect(usage).toHaveBeenCalledTimes(2);
		expect(resets).toHaveBeenCalledTimes(2);
		expect(credentials.mock.calls.map((call) => call[0].account.refreshToken)).toEqual(["synthetic-new-a", "synthetic-b"]);
	});
	it("refreshes usage independently when five minutes pass", async () => {
		const { monitor, usage, resets, advance } = setup();
		await monitor.runNow();
		advance(300_000);
		await monitor.runNow();
		expect(usage).toHaveBeenCalledTimes(4);
		expect(resets).toHaveBeenCalledTimes(2);
	});
	it("refreshes reset listings when thirty minutes pass", async () => {
		const { monitor, resets, advance } = setup();
		await monitor.runNow();
		advance(1_800_000);
		await monitor.runNow();
		expect(resets).toHaveBeenCalledTimes(4);
	});
	it("deduplicates concurrent checks when one is already running", async () => {
		const { monitor, usage } = setup();
		await Promise.all([monitor.runNow(), monitor.runNow(), monitor.runNow()]);
		expect(usage).toHaveBeenCalledTimes(2);
	});
	it("backs off endpoint failures when another check runs before retry is due", async () => {
		const usage = vi.fn().mockRejectedValue(new Error("synthetic failure"));
		const { monitor, advance } = setup({ usage });
		await monitor.runNow();
		advance(29_999);
		await monitor.runNow();
		expect(usage).toHaveBeenCalledTimes(2);
	});
	it("invalidates cached credentials immediately when refresh commits", async () => {
		const invalidate = vi.fn();
		const { monitor } = setup({ credentials: async () => ({ accessToken: "synthetic", refreshed: true, persisted: true }), onCredentialsPersisted: invalidate });
		await monitor.runNow();
		expect(invalidate).toHaveBeenCalledTimes(2);
	});
	it("aborts endpoint work and skips later work when disposed during fetch", async () => {
		let observedSignal: AbortSignal | undefined;
		const { monitor, resets } = setup({ usage: async (request) => {
			observedSignal = request.signal;
			monitor.dispose();
			return {};
		} });
		await monitor.runNow();
		expect(observedSignal?.aborted).toBe(true);
		expect(resets).not.toHaveBeenCalled();
	});
	it("invalidates cached observations when a reset redemption requests refresh", async () => {
		vi.useFakeTimers();
		const { monitor, usage } = setup();
		monitor.start();
		await monitor.runNow();
		monitor.refresh();
		await monitor.runNow();
		expect(usage).toHaveBeenCalledTimes(4);
	});
	it("limits endpoint concurrency when more than two seats are present", async () => {
		let active = 0;
		let maximum = 0;
		const usage = async () => {
			active += 1; maximum = Math.max(maximum, active);
			await Promise.resolve();
			active -= 1;
			return {};
		};
		const many: AccountStorageV3 = { version: 3, activeIndex: 0, accounts: Array.from({ length: 6 }, (_, index) => ({ accountId: `account-${index}`, refreshToken: `synthetic-${index}`, addedAt: 1 })) };
		const { monitor } = setup({ load: async () => many, usage });
		await monitor.runNow();
		expect(maximum).toBe(2);
	});
	it("discards stale results when the storage scope changes during fetch", async () => {
		let scope = "project";
		const { monitor } = setup({ scope: () => scope, usage: async () => { scope = "other-project"; return { plan_type: "business" }; } });
		await monitor.runNow();
		const account = storage.accounts[0];
		if (!account) throw new Error("fixture missing");
		expect(monitor.observations.snapshot(account, "project", 1000).plan.status).toBe("unknown");
	});
});

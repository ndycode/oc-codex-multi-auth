import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { runRotationPolicy } from "../lib/custom-rotation/runner.js";
import { getCleanupCount, runCleanup } from "../lib/shutdown.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn }));
const context = { version: 1 as const, now: 0, model: "test", currentAccountId: null, accounts: [] };
let child: ChildProcess;
let helper: ChildProcess;
beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(process, "platform", "get").mockReturnValue("win32");
	child = new ChildProcess();
	Object.defineProperty(child, "pid", { value: 12345 });
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
	helper = new ChildProcess();
	vi.spyOn(child, "kill").mockReturnValue(true);
	vi.spyOn(helper, "kill").mockReturnValue(true);
	mocks.spawn.mockReset().mockReturnValueOnce(child).mockReturnValue(helper);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(["timeout", "cancelled"] as const)("settles %s and releases capacity when Windows descendants retain every pipe", async (reason) => {
	// Given: no close event, even after taskkill and worker exit.
	const controller = new AbortController();
	const result = runRotationPolicy("/policy.mjs", context, { timeoutMs: 100, signal: controller.signal });
	// When: termination is requested while the pipes remain open.
	if (reason === "cancelled") controller.abort();
	await vi.advanceTimersByTimeAsync(1000);
	// Then: settlement does not require close and the tree was targeted.
	expect(await Promise.race([result, Promise.resolve("pending")])).toEqual({ accountId: null, error: reason });
	expect(mocks.spawn.mock.calls[1]?.[1]).toEqual(["/PID", "12345", "/T", "/F"]);
	child.emit("close", 1); // A late close must not release capacity twice.
	mocks.spawn.mockReturnValue(child);
	const running = Array.from({ length: 4 }, () => runRotationPolicy("/policy.mjs", context));
	expect(await runRotationPolicy("/policy.mjs", context)).toEqual({ accountId: null, error: "busy" });
	await vi.advanceTimersByTimeAsync(2000);
	await Promise.all(running);
});

it("drains a split success frame before tearing down a live Windows root", async () => {
	// Given: a worker with descendants keeping its streams open.
	const result = runRotationPolicy("/policy.mjs", context);
	const channel = child.stdio[3];
	// When: the complete result arrives in separate chunks without root exit.
	channel?.emit("data", Buffer.from('{"accountId":"'));
	expect(mocks.spawn).toHaveBeenCalledTimes(1);
	channel?.emit("data", Buffer.from('chosen"}\n'));
	await vi.advanceTimersByTimeAsync(500);
	// Then: the complete result survives teardown without waiting for pipes.
	expect(await Promise.race([result, Promise.resolve("pending")])).toEqual({ accountId: "chosen", error: null });
});

it("finishes shutdown cleanup when taskkill fails and descendants keep pipes open", async () => {
	// Given: a worker registered for shutdown.
	const result = runRotationPolicy("/policy.mjs", context);
	// When: cleanup runs and the Windows tree helper fails to start.
	const cleanup = runCleanup().then(() => "cleaned");
	helper.emit("error", new Error("synthetic spawn failure"));
	await vi.advanceTimersByTimeAsync(500);
	// Then: both the run and cleanup settle without close.
	expect(await Promise.race([result, Promise.resolve("pending")])).toEqual({ accountId: null, error: "cancelled" });
	expect(await Promise.race([cleanup, Promise.resolve("pending")])).toBe("cleaned");
	expect(getCleanupCount()).toBe(0);
});

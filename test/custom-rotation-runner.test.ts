import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRotationPolicy } from "../lib/custom-rotation/runner.js";
import { validateRotation } from "../lib/custom-rotation/validate.js";
import { emptyRotationAccount } from "../lib/custom-rotation/observations.js";
import { PluginConfigSchema } from "../lib/schemas.js";
import { getRotationStrategy } from "../lib/config.js";
import type { RotationInput } from "../lib/custom-rotation/contract.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "rotation-runner-")); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const context: RotationInput = { version: 1, now: 123, model: "gpt-5.6-sol", currentAccountId: null, accounts: [emptyRotationAccount("a")] };
async function policy(source: string): Promise<string> {
	const path = join(directory, "policy.mjs");
	await writeFile(path, source);
	return path;
}

describe("bounded Node policy runner", () => {
	it("returns a selected opaque id when select is asynchronous", async () => {
		const module = await policy("export async function select(input) { return input.accounts[0].id; }");
		const result = await runRotationPolicy(module, context);
		expect(result).toEqual({ accountId: "a", error: null });
	});
	it.each([
		["import", "while (true) {} export function select() { return null; }"],
		["select", "export function select() { while (true) {} }"],
		["promise", "export function select() { return new Promise(() => {}); }"],
	])("times out when %s never completes", async (_name, source) => {
		const module = await policy(source);
		const result = await runRotationPolicy(module, context, { timeoutMs: 150 });
		expect(result.error).toBe("timeout");
	});
	it("rejects output flooding when stdout exceeds its bound", async () => {
		const module = await policy("export function select() { process.stdout.write('x'.repeat(100000)); return null; }");
		const result = await runRotationPolicy(module, context);
		expect(result.error).toBe("output-limit");
	});
	it("rejects protocol flooding when fd3 exceeds its bound", async () => {
		const module = await policy("import { writeSync } from 'node:fs'; export function select() { writeSync(3, 'x'.repeat(100000)); return null; }");
		const result = await runRotationPolicy(module, context);
		expect(result.error).toBe("output-limit");
	});
	it.each(["export const select = 1;", "export function select() { return {}; }", "throw new Error('private detail');"])("returns only a safe error when policy fails: %s", async (source) => {
		const module = await policy(source);
		const result = await runRotationPolicy(module, context);
		expect(result).toEqual({ accountId: null, error: "policy" });
	});
	it("strips credentials and preloads when the host environment contains them", async () => {
		vi.stubEnv("NODE_OPTIONS", "--require /missing-preload.js");
		vi.stubEnv("OPENAI_API_KEY", "synthetic-secret");
		const module = await policy("export function select(input) { return !process.env.NODE_OPTIONS && !process.env.OPENAI_API_KEY && !process.env.HOME && !process.versions.bun ? input.accounts[0].id : 'leaked'; }");
		const result = await runRotationPolicy(module, context);
		expect(result.accountId).toBe("a");
	});
	it("reaps the child when it successfully completes", async () => {
		const module = await policy("export function select() { return String(process.pid); }");
		const result = await runRotationPolicy(module, context);
		expect(() => process.kill(Number(result.accountId), 0)).toThrowError();
	});
	it("cleans inherited pipes when a policy launches an ordinary descendant", async () => {
		const module = await policy("import { spawn } from 'node:child_process'; export function select() { spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); return null; }");
		const result = await runRotationPolicy(module, context);
		expect(result).toEqual({ accountId: null, error: null });
	});
	it.each(["timeout", "cancelled"] as const)("settles %s when an ordinary descendant inherits pipes", async (reason) => {
		// Given: a real descendant retaining stdout/stderr after the policy stalls.
		const ready = join(directory, "ready");
		const module = await policy(`import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; export function select() {
			spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
			writeFileSync(${JSON.stringify(ready)}, 'ready');
			return new Promise(() => {});
		}`);
		const controller = new AbortController();
		const watcher = watch(directory, (_event, filename) => {
			if (filename === "ready" && reason === "cancelled") controller.abort();
		});
		// When: timeout or a readiness-triggered abort tears down the live tree.
		let result;
		try { result = await runRotationPolicy(module, context, { timeoutMs: 500, signal: controller.signal }); }
		finally { watcher.close(); }
		// Then: the host settles through the real process surface.
		expect(result.error).toBe(reason);
	});
	it("cancels a running child when the host signal aborts", async () => {
		const module = await policy("export function select() { while (true) {} }");
		const controller = new AbortController();
		const result = runRotationPolicy(module, context, { signal: controller.signal });
		controller.abort();
		expect((await result).error).toBe("cancelled");
	});
	it("bounds concurrency when more than four children are requested", async () => {
		const module = await policy("export function select() { return new Promise(() => {}); }");
		const controller = new AbortController();
		const running = Array.from({ length: 4 }, () => runRotationPolicy(module, context, { signal: controller.signal }));
		const overflow = await runRotationPolicy(module, context);
		controller.abort();
		await Promise.all(running);
		expect(overflow.error).toBe("busy");
	});
	it("rejects oversized input when the protocol budget is exceeded", async () => {
		const module = await policy("export function select() { return null; }");
		const result = await runRotationPolicy(module, { ...context, model: "x".repeat(1_048_576) });
		expect(result.error).toBe("input-limit");
	});
});

describe("offline validation", () => {
	it("passes synthetic cases when the shipped example honors eligibility", async () => {
		const result = await validateRotation(resolve("assets/rotation/my-policy.mjs"));
		expect(result.exitCode).toBe(0);
	});
	it("fails an expected scenario when override selection differs", async () => {
		const module = await policy("export function select(input) { return input.accounts[0]?.id ?? null; }");
		const result = await validateRotation(module, { scenarios: [{ name: "current", input: { ...context, currentAccountId: "b", accounts: [{ id: "a" }, { id: "b" }] }, expectedAccountId: "b" }] });
		expect(result.results.find((scenario) => scenario.name === "current")?.error).toBe("unexpected-account");
		expect(result.exitCode).toBe(1);
	});
	it("fails policies when they return an id outside the input", async () => {
		const module = await policy("export function select() { return 'blocked'; }");
		const result = await validateRotation(module);
		expect(result.exitCode).toBe(1);
	});
	it("rejects fixtures when seat ids are duplicated", async () => {
		const result = await validateRotation(join(directory, "policy.mjs"), { scenarios: [{ name: "duplicates", input: { ...context, accounts: [{ id: "a" }, { id: "a" }] } }] });
		expect(result.exitCode).toBe(2);
	});
	it("accepts custom strategy when an absolute module is configured", () => {
		const config = PluginConfigSchema.parse({ rotationStrategy: "custom", customRotation: { module: join(directory, "policy.mjs") } });
		expect(getRotationStrategy(config)).toBe("custom");
	});
	it.each(["./policy.mjs", "~/rotation/policy.mjs", "/absolute/policy.js"])("rejects configuration when module path is %s", (module) => {
		const result = PluginConfigSchema.safeParse({ customRotation: { module } });
		expect(result.success).toBe(false);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TuiPluginApi, TuiPluginMeta, TuiSlotPlugin } from "@opencode-ai/plugin/tui";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storage from "../lib/storage.js";
import * as config from "../lib/config.js";
import * as status from "../lib/tui-status.js";
import { createStorageScope, setStoragePathDirect } from "../lib/storage/state.js";
import { createUsageAccountFingerprint, createUsageAccountKey } from "../lib/codex-usage.js";
import { createTuiQuotaSnapshot, getTuiQuotaCachePath, writeSessionQuotaEntry, writeTuiQuotaSnapshot } from "../lib/tui-quota-cache.js";

const mocks = vi.hoisted(() => ({ cleanups: [] as Array<() => void>, onSignal: (_value: unknown): void => {} }));
vi.mock("@opentui/solid", () => ({
	createElement: () => ({}),
	spread: (element: object, props: object) => Object.defineProperties(element, Object.getOwnPropertyDescriptors(props)),
}));
vi.mock("solid-js", () => ({
	createSignal: <T>(initial: T) => {
		let value = initial;
		return [() => value, (next: T) => { value = next; mocks.onSignal(next); }];
	},
	onCleanup: (cleanup: () => void) => mocks.cleanups.push(cleanup),
}));
import tuiModule from "../tui.js";

type RegisteredSlotPlugin = Omit<TuiSlotPlugin, "slots"> & {
	slots: Record<string, (ctx: unknown, props: { session_id: string }) => unknown>;
};

/**
 * `api.slots.register` hands back the registry id and `TuiSlots` offers no
 * `unregister`; teardown reaches a slot plugin through its `dispose` hook.
 * These cases pin that contract: once `dispose` or plugin teardown runs, the
 * renderer stops producing nodes instead of polling a dead api.
 */
function harness(stateDir?: string) {
	const disposers: Array<() => void> = [];
	const commandDispose = vi.fn();
	let plugin: RegisteredSlotPlugin | undefined;
	const api = {
		renderer: { width: 100 },
		state: { path: { state: stateDir }, config: {}, session: { messages: () => [] } },
		kv: { ready: false },
		slots: {
			register: (value: RegisteredSlotPlugin): string => {
				plugin = value;
				return "slot-1";
			},
		},
		command: { register: () => commandDispose },
		lifecycle: {
			signal: new AbortController().signal,
			onDispose: (fn: () => void) => {
				disposers.push(fn);
				return () => {};
			},
		},
		event: { on: () => () => {} },
	};
	return {
		api: api as unknown as TuiPluginApi,
		plugin: () => plugin,
		disposers,
		commandDispose,
	};
}

afterEach(() => {
	for (const cleanup of mocks.cleanups.splice(0)) cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	mocks.onSignal = () => {};
});

describe("TUI status slot lifecycle", () => {
	it.each([
		["same account and scope", false, false, 1],
		["different accounts", true, false, 2],
		["different storage scopes", false, true, 2],
	] as const)("shares only matching in-flight usage reads for mounted slots: %s", async (_name, differentAccounts, differentScopes, expectedReads) => {
		vi.useFakeTimers();
		const dir = await mkdtemp(join(tmpdir(), "tui-inflight-slots-"));
		vi.stubEnv("OPENCODE_STATE_DIR", dir);
		const accounts = ["FIRST", "SECOND"].map((name) => ({
			accountId: `FAKE_${name}`, refreshToken: `FAKE_REFRESH_${name}`, accessToken: `FAKE_ACCESS_${name}`,
			expiresAt: Date.now() + 3_600_000, email: `${name.toLowerCase()}@example.com`, addedAt: 1, lastUsed: 1,
		}));
		vi.spyOn(storage, "loadAccounts").mockResolvedValue({ version: 3, activeIndex: 0, accounts });
		const prepared = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const ready = Promise.withResolvers<void>();
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			started.resolve();
			await release.promise;
			const accountId = new Headers(init?.headers).get("chatgpt-account-id");
			return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: accountId === "FAKE_SECOND" ? 50 : 20, limit_window_seconds: 18_000 } } }), { status: 200 });
		});
		try {
			for (const index of [0, 1]) {
				const account = accounts[differentAccounts ? index : 0];
				if (!account) throw new Error("missing account fixture");
				await writeSessionQuotaEntry(`FAKE_SESSION_${index}`, { accountKey: createUsageAccountKey(account), snapshot: createTuiQuotaSnapshot({ fingerprint: createUsageAccountFingerprint(account), source: "headers", limits: [] }) }, dir);
			}
			const h = harness(dir);
			let cacheReads = 0;
			Object.assign(h.api.kv, { ready: true, get: () => { if (++cacheReads === 2) prepared.resolve(); }, set: () => {} });
			let readySlots = 0;
			mocks.onSignal = (value) => {
				if (value && typeof value === "object" && "type" in value && value.type === "ready" && ++readySlots === 2) ready.resolve();
			};
			await tuiModule.tui(h.api, undefined, {} as TuiPluginMeta);
			const render = h.plugin()?.slots["session_prompt_right"];
			if (!render) throw new Error("missing prompt slot");
			const scopes = [createStorageScope(), createStorageScope()];
			const nodes = [0, 1].map((index) => {
				const scope = scopes[differentScopes ? index : 0];
				if (!scope) throw new Error("missing storage scope");
				return scope(() => {
					setStoragePathDirect(join(dir, `FAKE_ACCOUNTS_${differentScopes ? index : 0}.json`));
					return render({}, { session_id: `FAKE_SESSION_${index}` });
				});
			});
			await Promise.all([prepared.promise, started.promise]);
			release.resolve();
			await ready.promise;
			expect(fetch).toHaveBeenCalledTimes(expectedReads);
			for (const [index, node] of nodes.entries()) {
				if (!node || typeof node !== "object" || !("content" in node)) throw new Error("missing status node");
				expect(node.content).toContain(differentAccounts && index === 1 ? "50%" : "80%");
				expect(node.content).toContain(differentAccounts && index === 1 ? "second@example.com" : "first@example.com");
			}
		} finally {
			release.resolve();
			for (const cleanup of mocks.cleanups.splice(0)) cleanup();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("polls global limits without losing an empty session snapshot's account binding", async () => {
		vi.useFakeTimers();
		const dir = await mkdtemp(join(tmpdir(), "tui-empty-session-"));
		vi.stubEnv("OPENCODE_STATE_DIR", dir);
		const account = { accountId: "FAKE_ACCOUNT", refreshToken: "FAKE_REFRESH", email: "bound@example.com", addedAt: 1, lastUsed: 1 };
		vi.spyOn(storage, "loadAccounts").mockResolvedValue({ version: 3, activeIndex: 0, accounts: [account] });
		const identity = { fingerprint: createUsageAccountFingerprint(account), source: "headers" as const, accountIndex: 1, accountEmail: account.email };
		const initial = createTuiQuotaSnapshot({ ...identity, limits: [{ label: "5h", leftPercent: 80 }] });
		try {
			await writeSessionQuotaEntry("FAKE_SESSION", { accountKey: createUsageAccountKey(account), snapshot: initial }, dir);
			const first = Promise.withResolvers<void>();
			mocks.onSignal = (value) => { if (value && typeof value === "object" && "type" in value && value.type === "ready") first.resolve(); };
			const h = harness(dir);
			await tuiModule.tui(h.api, undefined, {} as TuiPluginMeta);
			const render = h.plugin()?.slots["session_prompt_right"];
			if (!render) throw new Error("missing prompt slot");
			const node = render({}, { session_id: "FAKE_SESSION" });
			await first.promise;
			const fetchedAt = initial.fetchedAt + 1;
			await writeTuiQuotaSnapshot(createTuiQuotaSnapshot({ ...identity, fetchedAt, limits: [{ label: "5h", leftPercent: 50 }] }), getTuiQuotaCachePath(dir));
			await writeSessionQuotaEntry("FAKE_SESSION", { accountKey: createUsageAccountKey(account), snapshot: createTuiQuotaSnapshot({ ...identity, fetchedAt: fetchedAt + 1, limits: [] }) }, dir);
			const updated = Promise.withResolvers<void>();
			mocks.onSignal = (value) => { if (value && typeof value === "object" && "fetchedAt" in value && value.fetchedAt === fetchedAt) updated.resolve(); };
			await vi.advanceTimersByTimeAsync(1_000);
			await updated.promise;
			if (!node || typeof node !== "object" || !("content" in node)) throw new Error("missing status node");
			expect(node.content).toContain("50%");
			expect(node.content).toContain("bound@example.com");
		} finally {
			for (const cleanup of mocks.cleanups.splice(0)) cleanup();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.each([["中文 ", 75], ["e\u0301 ", 78]])("reserves display columns for the mounted V1 prefix %s", async (prefix, availableChars) => {
		vi.useFakeTimers();
		vi.spyOn(config, "getQuotaStatus").mockReturnValue({ ...config.getQuotaStatus({}), prefix });
		const format = vi.spyOn(status, "formatPromptStatusText");
		const h = harness();
		await tuiModule.tui(h.api, undefined, {} as TuiPluginMeta);
		const render = h.plugin()?.slots["session_prompt_right"];
		if (!render) throw new Error("missing prompt slot");
		const node = render({}, { session_id: "FAKE_SESSION" });
		if (!node || typeof node !== "object" || !("content" in node)) throw new Error("missing status node");
		Object.assign(node, { parent: { primaryAxis: "row", width: 120, getChildren: () => [node, {}] } });
		await vi.advanceTimersByTimeAsync(500);
		expect(node.content).toBeTypeOf("string");
		expect(format).toHaveBeenLastCalledWith(expect.objectContaining({ availableChars }));
	});

	it("renders concurrent prompt slots with their own account and quota, and global fallback for a new session", async () => {
		// Given two bound sessions and a global snapshot from the second session.
		const dir = await mkdtemp(join(tmpdir(), "tui-session-slots-"));
		vi.stubEnv("OPENCODE_STATE_DIR", dir);
		const accounts = ["first", "second"].map((name) => ({ accountId: `FAKE_${name}`, email: `${name}@example.test`, refreshToken: `FAKE_REFRESH_${name}`, addedAt: 1, lastUsed: 1 }));
		vi.spyOn(storage, "loadAccounts").mockResolvedValue({ version: 3, activeIndex: 0, accounts });
		try {
			for (const [index, account] of accounts.entries()) {
				const snapshot = createTuiQuotaSnapshot({ fingerprint: createUsageAccountFingerprint(account), source: "headers", accountIndex: index + 1, accountEmail: account.email, limits: [{ label: "5h", leftPercent: 80 - index * 30 }] });
				await writeSessionQuotaEntry(`ses_${index}`, { accountKey: createUsageAccountKey(account), snapshot }, dir);
				await writeTuiQuotaSnapshot(snapshot, getTuiQuotaCachePath(dir));
			}
			const h = harness(dir);
			await tuiModule.tui(h.api, undefined, {} as TuiPluginMeta);
			const render = h.plugin()?.slots["session_prompt_right"];
			if (!render) throw new Error("missing prompt slot");
			// When the host mounts all three prompt slots before their refreshes resolve.
			const nodes = ["ses_0", "ses_1", "ses_new"].map((id) => render({}, { session_id: id }));
			// Then account identity and quota remain paired in the rendered status text.
			await vi.waitFor(() => {
				const contents = nodes.map((node) => {
					if (!node || typeof node !== "object" || !("content" in node)) throw new Error("missing status node");
					return node.content;
				});
				expect(contents[0]).toContain("first@example.test");
				expect(contents[0]).toContain("80%");
				expect(contents[1]).toContain("second@example.test");
				expect(contents[1]).toContain("50%");
				expect(contents[2]).toBe(contents[1]);
			});
		} finally {
			for (const cleanup of mocks.cleanups.splice(0)) cleanup();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("stops the slot renderer once the registry calls the plugin's dispose hook", async () => {
		vi.useFakeTimers();
		const h = harness();
		await tuiModule.tui(h.api, undefined, {} as TuiPluginMeta);
		const plugin = h.plugin();
		expect(plugin).toBeDefined();
		expect(typeof plugin!.dispose).toBe("function");
		const render = plugin!.slots["session_prompt_right"]!;
		expect(render({}, { session_id: "s" })).not.toBeNull();
		plugin!.dispose!();
		expect(render({}, { session_id: "s" })).toBeNull();
	});

	it("unregisters the command and stops the slot on plugin teardown", async () => {
		vi.useFakeTimers();
		const h = harness();
		await tuiModule.tui(h.api, undefined, {} as TuiPluginMeta);
		for (const dispose of h.disposers) dispose();
		expect(h.commandDispose).toHaveBeenCalledTimes(1);
		expect(h.plugin()!.slots["session_prompt_right"]!({}, { session_id: "s" })).toBeNull();
	});
});

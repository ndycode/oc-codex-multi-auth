import { afterEach, describe, expect, it, vi } from "vitest";
import type { TuiPluginApi, TuiPluginMeta, TuiSlotPlugin } from "@opencode-ai/plugin/tui";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storage from "../lib/storage.js";
import { createUsageAccountFingerprint } from "../lib/codex-usage.js";
import { createTuiQuotaSnapshot, getTuiQuotaCachePath, writeSessionQuotaSnapshot, writeTuiQuotaSnapshot } from "../lib/tui-quota-cache.js";

const mocks = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock("@opentui/solid", () => ({
	createElement: () => ({}),
	spread: (element: object, props: object) => Object.defineProperties(element, Object.getOwnPropertyDescriptors(props)),
}));
vi.mock("solid-js", () => ({
	createSignal: <T>(initial: T) => {
		let value = initial;
		return [() => value, (next: T) => { value = next; }];
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
});

describe("TUI status slot lifecycle", () => {
	it("renders concurrent prompt slots with their own account and quota, and global fallback for a new session", async () => {
		// Given two bound sessions and a global snapshot from the second session.
		const dir = await mkdtemp(join(tmpdir(), "tui-session-slots-"));
		vi.stubEnv("OPENCODE_STATE_DIR", dir);
		const accounts = ["first", "second"].map((name) => ({ accountId: `FAKE_${name}`, email: `${name}@example.test`, refreshToken: `FAKE_REFRESH_${name}`, addedAt: 1, lastUsed: 1 }));
		vi.spyOn(storage, "loadAccounts").mockResolvedValue({ version: 3, activeIndex: 0, accounts });
		try {
			for (const [index, account] of accounts.entries()) {
				const snapshot = createTuiQuotaSnapshot({ fingerprint: createUsageAccountFingerprint(account), source: "headers", accountIndex: index + 1, accountEmail: account.email, limits: [{ label: "5h", leftPercent: 80 - index * 30 }] });
				await writeSessionQuotaSnapshot(`ses_${index}`, snapshot, dir);
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

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TuiPluginApi, TuiPluginMeta, TuiRouteCurrent } from "@opencode-ai/plugin/tui";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storage from "../lib/storage.js";
import { createUsageAccountFingerprint, createUsageAccountKey } from "../lib/codex-usage.js";
import { createTuiQuotaSnapshot, getTuiQuotaCachePath, writeSessionQuotaEntry, writeTuiQuotaSnapshot } from "../lib/tui-quota-cache.js";

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

type Command = { value: string; onSelect?: () => void };

afterEach(() => {
	for (const cleanup of mocks.cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("quota details command", () => {
	it.each<[string, TuiRouteCurrent, string, string]>([
		["the open session's account", { name: "session", params: { sessionID: "ses_0" } }, "first@example.test", "second@example.test"],
		["the last served account outside a session", { name: "home" }, "second@example.test", "first@example.test"],
	])("shows %s", async (_name, route, shown, hidden) => {
		// Given two sessions on different accounts, the second one served last.
		const dir = await mkdtemp(join(tmpdir(), "tui-quota-details-"));
		vi.stubEnv("OPENCODE_STATE_DIR", dir);
		const accounts = ["first", "second"].map((name) => ({
			accountId: `FAKE_${name}`, email: `${name}@example.test`, refreshToken: `FAKE_REFRESH_${name}`, addedAt: 1, lastUsed: 1,
		}));
		vi.spyOn(storage, "loadAccounts").mockResolvedValue({ version: 3, activeIndex: 0, accounts });
		try {
			for (const [index, account] of accounts.entries()) {
				const snapshot = createTuiQuotaSnapshot({
					fingerprint: createUsageAccountFingerprint(account), source: "headers", accountIndex: index + 1,
					accountCount: 2, accountEmail: account.email, limits: [{ label: "5h", leftPercent: 80 - index * 30 }],
				});
				await writeSessionQuotaEntry(`ses_${index}`, { accountKey: createUsageAccountKey(account), snapshot }, dir);
				await writeTuiQuotaSnapshot(snapshot, getTuiQuotaCachePath(dir));
			}
			let commands: Command[] = [];
			const dialog = Promise.withResolvers<string>();
			const api = {
				renderer: { width: 100 },
				state: { path: { state: dir }, config: {}, session: { messages: () => [] } },
				kv: { ready: false },
				route: { current: route },
				slots: { register: () => "slot-1" },
				command: { register: (register: () => Command[]) => { commands = register(); return () => {}; } },
				lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
				event: { on: () => () => {} },
				ui: {
					DialogAlert: (props: { message: string }) => props.message,
					dialog: { replace: (render: () => string) => dialog.resolve(render()), clear: () => {} },
				},
			} as unknown as TuiPluginApi;
			await tuiModule.tui(api, undefined, {} as TuiPluginMeta);
			// When the user opens the quota details dialog.
			commands.find((command) => command.value === "codex.quota.details")?.onSelect?.();
			// Then it describes the account for the current route.
			const message = await dialog.promise;
			expect(message).toContain(shown);
			expect(message).not.toContain(hidden);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

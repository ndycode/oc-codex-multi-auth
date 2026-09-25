import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin/tui";

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
import { setupV2Tui } from "../lib/opencode-v2-tui.js";

afterEach(() => {
	for (const cleanup of mocks.cleanups.splice(0)) cleanup();
	vi.useRealTimers();
});

describe("V2 accounts UI", () => {
	it("exposes accounts without a mounted prompt and cleans up polling", async () => {
		vi.useFakeTimers();
		const slots = new Map<string, { render: (props: object) => { children: string } | null }>();
		const commands: Array<{ id: string; run: () => Promise<void> }> = [];
		const status = vi.fn().mockResolvedValue({
			text: "quota ready", details: "Quota details", showFor: "codex-models",
			accountStorage: "project",
			accounts: [
				{ index: 1, label: "First", active: true, enabled: true },
				{ index: 2, label: "Second", active: false, enabled: false },
			],
		});
		const alert = vi.fn();
		const unregister = vi.fn();
		const messages: Array<{ type: string; model?: { providerID: string } }> = [];
		let configuredProvider = "anthropic";
		const context = {
			location: { directory: "/tmp/opencode/project" }, renderer: { width: 100 },
			client: { rpc: () => ({ status }) }, theme: { text: { base: "white" } },
			data: { session: { get: () => ({ model: { providerID: configuredProvider } }), message: { list: () => messages } } },
			keymap: { layer: (factory: () => { commands: typeof commands }) => commands.push(...factory().commands) },
			ui: { dialog: { alert }, slot: (claim: { append: string; render: (props: object) => { children: string } | null }) => {
				slots.set(claim.append, claim);
				return unregister;
			} },
		} as unknown as Plugin.Context;
		const dispose = setupV2Tui(context);
		slots.get("app")!.render({});
		await vi.advanceTimersByTimeAsync(0);
		const sidebar = slots.get("sidebar.content")!.render({})!;
		expect(sidebar.children).toContain("● 1. First");
		expect(sidebar.children).toContain("○ 2. Second (disabled)");
		expect(status).toHaveBeenCalledWith({ width: 60 }, expect.objectContaining({ location: context.location }));
		await commands.find((command) => command.id === "codex.accounts")!.run();
		expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: "Codex accounts", message: expect.stringContaining("opencode auth login") }));
		expect(alert.mock.calls[0]?.[0].message).toContain("this project uses its own pool");
		expect(alert.mock.calls[0]?.[0].message).toContain("global pool is used to seed it");
		expect(alert.mock.calls[0]?.[0].message).toContain('"perProjectAccounts" to true (per-project) or false (global)');
		expect(alert.mock.calls[0]?.[0].message).toContain("CODEX_AUTH_PER_PROJECT_ACCOUNTS overrides this setting");
		status.mockResolvedValueOnce({
			text: "quota ready", details: "Quota details", showFor: "codex-models",
			accountStorage: "global", accounts: [
				{ index: 1, label: "First", active: true, enabled: true },
				{ index: 2, label: "Second", active: false, enabled: false },
			],
		});
		await commands.find((command) => command.id === "codex.accounts")!.run();
		expect(alert.mock.calls[1]?.[0].message).toContain("global pool is shared across projects");
		expect(alert.mock.calls[1]?.[0].message).toContain("~/.opencode/openai-codex-auth-config.json");
		expect(alert.mock.calls[1]?.[0].message).not.toContain("from this project directory");
		// Hiding Codex quota for a different provider must not hide the account list.
		expect(slots.get("prompt.footer.status")!.render({ sessionID: "test" })!.children).toBe("");
		messages.push({ type: "assistant", model: { providerID: "openai" } }, { type: "user" });
		expect(slots.get("prompt.footer.status")!.render({ sessionID: "test" })!.children).toBe("quota ready");
		configuredProvider = "openai";
		messages.push({ type: "assistant", model: { providerID: "anthropic" } });
		expect(slots.get("prompt.footer.status")!.render({ sessionID: "test" })!.children).toBe("");
		expect(sidebar.children).toContain("First");
		status.mockRejectedValue(new Error("offline"));
		await vi.advanceTimersByTimeAsync(2000);
		expect(sidebar.children).toContain("Accounts unavailable");
		await commands.find((command) => command.id === "codex.accounts")!.run();
		expect(alert.mock.calls[2]?.[0].message).toContain("Account storage: unavailable");
		expect(alert.mock.calls[2]?.[0].message).not.toContain("the global pool is shared");
		for (const cleanup of mocks.cleanups.splice(0)) cleanup();
		const calls = status.mock.calls.length;
		await vi.advanceTimersByTimeAsync(4000);
		expect(status).toHaveBeenCalledTimes(calls);
		dispose();
		expect(unregister).toHaveBeenCalledTimes(3);
	});
});

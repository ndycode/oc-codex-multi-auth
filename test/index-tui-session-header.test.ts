import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpencodeClient } from "@opencode-ai/sdk";

vi.mock("../lib/tools/index.js", () => ({ createToolRegistry: () => ({}) }));
vi.mock("../lib/quota-notifications.js", () => ({
	createQuotaMonitor: () => ({ start() {}, dispose() {}, runNow: async () => {} }),
}));
vi.mock("../lib/auto-update-checker.js", () => ({ checkAndNotify: vi.fn(async () => {}) }));
vi.mock("../lib/config.js", async (original) => ({
	...await original<typeof import("../lib/config.js")>(),
	loadPluginConfig: () => ({
		perProjectAccounts: false,
		startupPrewarm: false,
		startupPreflight: false,
		retryAllAccountsMaxRetries: 0,
	}),
}));
vi.mock("../lib/storage.js", async (original) => ({
	...await original<typeof import("../lib/storage.js")>(),
	setStoragePath: vi.fn(),
}));

import { OpenAIOAuthPlugin } from "../index.js";
import { setStoragePathDirect } from "../lib/storage.js";

type Hooks = {
	"chat.headers": (input: unknown, output: { headers: Record<string, string> }) => Promise<void>;
	auth: { loader: (getAuth: () => Promise<unknown>, provider: unknown) => Promise<{ fetch?: typeof fetch }> };
	dispose?: () => Promise<void>;
	event?: (input: unknown) => Promise<void>;
};

const MARKER = "x-oc-codex-tui-session";

describe("TUI session header with the real Codex header builder", () => {
	let directory: string;
	let plugin: Hooks;
	let upstream: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		directory = await fs.mkdtemp(join(tmpdir(), "tui-session-header-"));
		vi.stubEnv("OPENCODE_STATE_DIR", join(directory, "state"));
		const path = join(directory, "accounts.json");
		setStoragePathDirect(path);
		await fs.writeFile(path, JSON.stringify({
			version: 3, activeIndex: 0,
			accounts: [{ accountId: "FAKE_ACCOUNT", refreshToken: "FAKE_REFRESH", accessToken: "FAKE_ACCESS", expiresAt: Date.now() + 86_400_000, enabled: true, addedAt: 1, lastUsed: 1 }],
		}));
		plugin = await Reflect.apply(OpenAIOAuthPlugin, undefined, [{ client: createOpencodeClient({ baseUrl: "http://localhost" }) }]) as Hooks;
		upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
	});

	afterEach(async () => {
		await plugin.dispose?.();
		await plugin.event?.({ event: { type: "server.instance.disposed", properties: { directory } } });
		setStoragePathDirect(null);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await fs.rm(directory, { recursive: true, force: true });
	});

	const loadFetch = async () => {
		const sdk = await plugin.auth.loader(async () => ({ type: "api", key: "FAKE" }), {});
		if (!sdk.fetch) throw new Error("missing plugin fetch");
		return sdk.fetch;
	};

	const sendUpstream = async (pluginFetch: typeof fetch, headers: Record<string, string>) => {
		await pluginFetch("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ model: "gpt-5.4", input: [] }),
		}).catch(() => undefined);
		const call = upstream.mock.calls.find(([url]) => String(url).includes("/responses"));
		if (!call) throw new Error("no upstream call");
		return new Headers((call[1] as RequestInit | undefined)?.headers);
	};

	const chatHeaders = async (sessionID: string) => {
		const output = { headers: {} as Record<string, string> };
		await plugin["chat.headers"]({ sessionID, model: { providerID: "openai" } }, output);
		return output.headers;
	};

	it("marks the session for this plugin's fetch and strips the marker before the upstream request", async () => {
		const pluginFetch = await loadFetch();
		const headers = await chatHeaders("ses_FAKE");
		expect(headers[MARKER]).toBe("ses_FAKE");
		const sent = await sendUpstream(pluginFetch, headers);
		expect(sent.get("authorization")).toBe("Bearer FAKE_ACCESS");
		expect(sent.has(MARKER)).toBe(false);
	});

	it("strips an empty marker before the upstream request", async () => {
		const sent = await sendUpstream(await loadFetch(), { [MARKER]: "" });
		expect(sent.get("authorization")).toBe("Bearer FAKE_ACCESS");
		expect(sent.has(MARKER)).toBe(false);
	});

	it("does not mark a request before this plugin's fetch is installed", async () => {
		expect(await chatHeaders("ses_FAKE")).not.toHaveProperty(MARKER);
	});

	it("does not mark a request without a session ID", async () => {
		await loadFetch();
		expect(await chatHeaders("")).not.toHaveProperty(MARKER);
	});
});

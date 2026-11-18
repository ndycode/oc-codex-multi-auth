import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { ToolContext } from "../lib/tools/index.js";
import { resetTrackers } from "../lib/rotation.js";

/**
 * Regression coverage for the request-runtime hardening fixes:
 *  - the refcounted accounts-file watcher registry (one StatWatcher per path,
 *    released only after the last runtime unsubscribes),
 *  - warn-once behaviour for records that can never resolve an accountId,
 *  - storage-unavailability cooling accounts down instead of counting auth
 *    failures and disabling them,
 *  - the terminal exhaustion envelope gaining a stable `code` plus a pointer
 *    at the on-disk request logs,
 *  - the public `dispose()` teardown, and
 *  - the host auth.json backfill honouring XDG_DATA_HOME with an atomic
 *    0600 write.
 */

const captured = vi.hoisted((): {
	contexts: ToolContext[];
	watchCalls: { path: unknown; listener: () => void }[];
	unwatchCalls: { path: unknown; listener: unknown }[];
	reads: Promise<unknown>[];
	maxRetries?: number;
	forceRefresh: boolean;
	refreshError?: unknown;
	accountsPath?: string;
	readFileError?: NodeJS.ErrnoException;
	quotaDisposes: number;
} => ({
	contexts: [],
	watchCalls: [],
	unwatchCalls: [],
	reads: [],
	forceRefresh: false,
	quotaDisposes: 0,
}));

vi.mock("node:fs", async (original) => ({
	...await original<typeof import("node:fs")>(),
	watchFile: vi.fn((path: unknown, _options: unknown, listener: () => void) => {
		captured.watchCalls.push({ path, listener });
	}),
	unwatchFile: vi.fn((path: unknown, listener: unknown) => {
		captured.unwatchCalls.push({ path, listener });
	}),
}));

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => {
			if (captured.readFileError && args[0] === captured.accountsPath) {
				const pending = Promise.reject(captured.readFileError) as Promise<never>;
				captured.reads.push(pending.catch(() => undefined));
				return pending;
			}
			const pending = actual.readFile(...args);
			captured.reads.push(pending.catch(() => undefined));
			return pending;
		}),
	};
});

vi.mock("../lib/tools/index.js", () => ({
	createToolRegistry: (context: ToolContext) => {
		captured.contexts.push(context);
		return {};
	},
}));

vi.mock("../lib/quota-notifications.js", () => ({
	createQuotaMonitor: () => ({
		start() {},
		dispose() {
			captured.quotaDisposes += 1;
		},
		runNow: async () => {},
	}),
}));

vi.mock("../lib/auto-update-checker.js", () => ({ checkAndNotify: vi.fn(async () => {}) }));

vi.mock("../lib/config.js", async (original) => ({
	...await original<typeof import("../lib/config.js")>(),
	loadPluginConfig: () => ({
		perProjectAccounts: false,
		startupPrewarm: false,
		startupPreflight: false,
		retryAllAccountsMaxRetries: captured.maxRetries,
	}),
}));

vi.mock("../lib/storage.js", async (original) => ({
	...await original<typeof import("../lib/storage.js")>(),
	setStoragePath: vi.fn(),
}));

// The refresh boundary is where a dead credential store used to masquerade
// as an auth failure. `forceRefresh`/`refreshError` steer the stub so a test
// can drop the account straight into the auth-refresh catch with whichever
// failure shape production surfaces.
vi.mock("../lib/request/fetch-helpers.js", async (original) => {
	const actual = await original<typeof import("../lib/request/fetch-helpers.js")>();
	return {
		...actual,
		shouldRefreshToken: () => captured.forceRefresh,
		refreshAndUpdateToken: vi.fn(async (auth: unknown) => {
			if (captured.refreshError) throw captured.refreshError;
			return auth;
		}),
	};
});

import { OpenAIOAuthPlugin } from "../index.js";
import * as logger from "../lib/logger.js";
import { setStoragePathDirect } from "../lib/storage.js";

type PluginInstance = Awaited<ReturnType<typeof OpenAIOAuthPlugin>> & {
	dispose?: () => Promise<void>;
};

const client = () => createOpencodeClient({ baseUrl: "http://localhost" });

const storage = (accounts: Record<string, unknown>[]) => ({
	version: 3 as const,
	activeIndex: 0,
	accounts,
});

const account = (overrides: Record<string, unknown> = {}) => ({
	accountId: "test-account",
	refreshToken: "test-refresh",
	accessToken: "test-access",
	expiresAt: Date.now() + 86_400_000,
	enabled: true,
	addedAt: 1,
	lastUsed: 1,
	...overrides,
});

const postGpt51 = { model: "gpt-5.1", stream: true, input: [] };

describe("index runtime hardening", () => {
	let directory: string;
	let path: string;
	const plugins: PluginInstance[] = [];

	const fetchFor = async (plugin: PluginInstance): Promise<typeof fetch> => {
		const loader = plugin.auth?.loader;
		if (!loader) throw new Error("Missing auth loader");
		const sdk = await Reflect.apply(loader, undefined, [
			async () => ({ type: "api", key: "test" }),
			{},
		]);
		if (!sdk.fetch) throw new Error("Missing plugin fetch");
		return sdk.fetch as typeof fetch;
	};

	const createPlugin = async (): Promise<PluginInstance> => {
		const plugin = await Reflect.apply(OpenAIOAuthPlugin, undefined, [
			{ client: client() },
		]) as PluginInstance;
		plugins.push(plugin);
		await fetchFor(plugin);
		return plugin;
	};

	const drainReads = async () => {
		while (captured.reads.length > 0) {
			await Promise.allSettled(captured.reads.splice(0));
		}
	};

	const tick = async () => {
		const listener = captured.watchCalls.at(-1)?.listener;
		expect(listener).toBeTypeOf("function");
		listener?.();
		await drainReads();
	};

	const settle = async () => {
		await vi.advanceTimersByTimeAsync(500);
		await drainReads();
	};

	// Resolves once the debug marker has fired `times` times — one per runtime
	// that completed an external-change reload. Reads alone can't bound the
	// reload: `loadFromDisk` goes through the transaction lock before its own
	// read lands, so the observable completion signal is the log line.
	const nextReloads = (times: number) =>
		new Promise<void>((resolve) => {
			let seen = 0;
			vi.spyOn(logger, "logDebug").mockImplementation((message) => {
				if (
					typeof message === "string" &&
					message.includes("Reloaded cached account manager") &&
					++seen === times
				) {
					resolve();
				}
			});
		});

	const warnCalls = (needle: string) =>
		vi.mocked(logger.logWarn).mock.calls.filter((call) =>
			call.some((arg) => typeof arg === "string" && arg.includes(needle)),
		);

	beforeEach(async () => {
		resetTrackers();
		vi.useFakeTimers();
		vi.stubEnv("CODEX_RETRY_ALL_UNBOUNDED", "1");
		vi.spyOn(logger, "logWarn").mockImplementation(() => {});
		directory = await fs.mkdtemp(join(tmpdir(), "index-runtime-"));
		path = join(directory, "accounts.json");
		setStoragePathDirect(path);
		captured.accountsPath = path;
		await fs.writeFile(path, JSON.stringify(storage([account()])));
		captured.contexts.length = 0;
		captured.watchCalls.length = 0;
		captured.unwatchCalls.length = 0;
		captured.reads.length = 0;
		captured.maxRetries = undefined;
		captured.forceRefresh = false;
		captured.refreshError = undefined;
		captured.readFileError = undefined;
		captured.quotaDisposes = 0;
		plugins.length = 0;
		await createPlugin();
	});

	afterEach(async () => {
		resetTrackers();
		for (const plugin of plugins.splice(0)) {
			await plugin.dispose?.();
			await plugin.event?.({
				event: { type: "server.instance.disposed", properties: { directory } },
			});
		}
		for (const context of captured.contexts) {
			await context.cachedAccountManagerRef.current?.flushPendingSave();
			context.cachedAccountManagerRef.current?.disposeShutdownHandler();
		}
		setStoragePathDirect(null);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.useRealTimers();
		await fs.rm(directory, { recursive: true, force: true });
	});

	describe("accounts-file watcher registry", () => {
		it("shares one StatWatcher across runtimes and unwatchFile only after the last release", async () => {
			expect(captured.watchCalls).toHaveLength(1);
			const firstContext = captured.contexts[0];

			const second = await createPlugin();
			// One underlying watcher now fans out to both runtimes.
			expect(captured.watchCalls).toHaveLength(1);
			const secondContext = captured.contexts.at(-1);
			if (!firstContext || !secondContext) throw new Error("Missing contexts");

			const firstBefore = firstContext.cachedAccountManagerRef.current;
			const secondBefore = secondContext.cachedAccountManagerRef.current;
			const bothReloaded = nextReloads(2);
			await fs.writeFile(path, JSON.stringify(storage([account({ enabled: false })])));
			await tick();
			await settle();
			await bothReloaded;
			expect(firstContext.cachedAccountManagerRef.current).not.toBe(firstBefore);
			expect(secondContext.cachedAccountManagerRef.current).not.toBe(secondBefore);
			expect(firstContext.cachedAccountManagerRef.current?.getAccountsSnapshot()[0]?.enabled).toBe(false);
			expect(secondContext.cachedAccountManagerRef.current?.getAccountsSnapshot()[0]?.enabled).toBe(false);

			// Releasing the first runtime must leave the shared watcher in place.
			await plugins[0]?.dispose();
			expect(captured.unwatchCalls).toHaveLength(0);

			vi.mocked(logger.logDebug).mockRestore();
			const secondReloaded = nextReloads(1);
			await fs.writeFile(path, JSON.stringify(storage([account({ enabled: true, lastUsed: 2 })])));
			await tick();
			await settle();
			await secondReloaded;
			expect(secondContext.cachedAccountManagerRef.current?.getAccountsSnapshot()[0]?.enabled).toBe(true);

			await second.dispose();
			expect(captured.unwatchCalls).toHaveLength(1);
			expect(captured.unwatchCalls[0]?.listener).toBe(captured.watchCalls[0]?.listener);
		});
	});

	describe("accounts-file read failures", () => {
		const eacces = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

		it("warns after consecutive failures, respects the cooldown, and resets on a healthy read", async () => {
			captured.readFileError = eacces();
			await tick();
			expect(warnCalls("unreadable")).toHaveLength(0);
			await tick();
			expect(warnCalls("unreadable")).toHaveLength(1);
			// Inside the 60s cooldown the corruption is logged once, not per tick.
			await tick();
			await tick();
			expect(warnCalls("unreadable")).toHaveLength(1);

			// Still failing after the cooldown elapses: warn again.
			await vi.advanceTimersByTimeAsync(61_000);
			await tick();
			expect(warnCalls("unreadable")).toHaveLength(2);

			captured.readFileError = undefined;
			await tick();
			await tick();
			expect(warnCalls("unreadable")).toHaveLength(2);
		});

		it("never warns for ENOENT — an absent accounts file is a fresh install", async () => {
			captured.readFileError = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
			await tick();
			await tick();
			await tick();
			expect(warnCalls("unreadable")).toHaveLength(0);
		});
	});

	describe("dispose()", () => {
		it("is exposed on the hooks, idempotent, and releases the shared watcher once", async () => {
			const plugin = plugins[0];
			if (!plugin?.dispose) throw new Error("Missing dispose hook");
			expect(captured.watchCalls).toHaveLength(1);

			await plugin.dispose();
			await plugin.dispose();
			await plugin.event?.({ event: { type: "server.instance.disposed", properties: { directory } } });

			expect(captured.quotaDisposes).toBe(1);
			expect(captured.unwatchCalls).toHaveLength(1);
		});
	});

	describe("terminal failure envelope", () => {
		it.each(["auth cooldown", "local throttle"])("answers %s with 503 rather than an upstream rate limit", async (reason) => {
			captured.maxRetries = 0;
			const plugin = plugins[0];
			if (!plugin) throw new Error("Missing plugin");
			const manager = captured.contexts[0]?.cachedAccountManagerRef.current;
			if (!manager) throw new Error("Missing manager");
			const active = manager.getCurrentAccount();
			if (!active) throw new Error("Missing account");
			if (reason === "auth cooldown") {
				manager.markAccountCoolingDown(active, 60_000, "auth-failure");
			} else {
				for (let i = 0; i < 100; i++) manager.consumeToken(active, "gpt-5.1", "gpt-5.1");
			}
			const fetch1 = await fetchFor(plugin);
			const response = await fetch1("https://api.openai.com/v1/responses", {
				method: "POST", body: JSON.stringify(postGpt51),
			});
			expect(response.status).toBe(503);
			const body = await response.json() as { error: { code: string; message: string } };
			expect(body.error.code).toBe("accounts_temporarily_unavailable");
			expect(body.error.message).toContain(reason === "auth cooldown" ? "cooling down" : "local request throttle");
			expect(body.error.message).not.toContain("rate-limited");
		});

		it("answers an empty pool with 503, a stable code, and the request-log pointer", async () => {
			await fs.writeFile(path, JSON.stringify(storage([])));
			const plugin = await createPlugin();
			const fetch2 = await fetchFor(plugin);

			const response = await fetch2("https://api.openai.com/v1/responses", {
				method: "POST",
				body: JSON.stringify(postGpt51),
			});
			expect(response.status).toBe(503);
			const body = await response.json() as { error: { code: string; message: string } };
			expect(body.error.code).toBe("no_accounts_configured");
			expect(body.error.message).toContain("Request logs live in");
		});

		it("answers an all-blocked pool with 429, a stable code, and the request-log pointer", async () => {
			captured.maxRetries = 0;
			const plugin = plugins[0];
			if (!plugin) throw new Error("Missing plugin");
			const manager = captured.contexts[0]?.cachedAccountManagerRef.current;
			if (!manager) throw new Error("Missing manager");
			const active = manager.getCurrentAccount();
			if (!active) throw new Error("Missing account");
			manager.markRateLimited(active, 60_000, "gpt-5.1");

			const fetch1 = await fetchFor(plugin);
			const response = await fetch1("https://api.openai.com/v1/responses", {
				method: "POST",
				body: JSON.stringify(postGpt51),
			});
			expect(response.status).toBe(429);
			const body = await response.json() as { error: { code: string; message: string } };
			expect(body.error.code).toBe("all_accounts_rate_limited");
			expect(body.error.message).toContain("Request logs live in");
		});
	});

	describe("storage-unavailable refresh failure", () => {
		it("cools the account down without counting an auth failure or disabling it", async () => {
			captured.maxRetries = 0;
			captured.forceRefresh = true;
			captured.refreshError = new Error("Account storage is unavailable");
			const plugin = plugins[0];
			if (!plugin) throw new Error("Missing plugin");
			const manager = captured.contexts[0]?.cachedAccountManagerRef.current;
			if (!manager) throw new Error("Missing manager");
			const incrementAuthFailures = vi.spyOn(manager, "incrementAuthFailures");
			const fetch1 = await fetchFor(plugin);

			// Four passes of "the store is down" would have disabled the account
			// under MAX_AUTH_FAILURES=3 had these counted as auth rejections.
			for (let i = 0; i < 4; i++) {
				const response = await fetch1("https://api.openai.com/v1/responses", {
					method: "POST",
					body: JSON.stringify(postGpt51),
				});
				expect(response.status).toBe(503);
				await vi.advanceTimersByTimeAsync(31_000);
			}

			expect(incrementAuthFailures).not.toHaveBeenCalled();
			expect(manager.getAccountsSnapshot()[0]?.enabled).not.toBe(false);
			expect(warnCalls("storage unavailable").length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("missing accountId", () => {
		it("warns once per broken record instead of every request", async () => {
			captured.maxRetries = 0;
			await fs.writeFile(path, JSON.stringify(storage([
				account({ accountId: undefined, accountIdSource: undefined, accessToken: "not-a-jwt" }),
			])));
			const plugin = await createPlugin();
			const fetch2 = await fetchFor(plugin);

			const first = await fetch2("https://api.openai.com/v1/responses", {
				method: "POST",
				body: JSON.stringify(postGpt51),
			});
			expect(first.status).toBe(503);
			expect(warnCalls("no resolvable accountId")).toHaveLength(1);

			// Past the cooldown the record is re-attempted — and must not re-warn.
			await vi.advanceTimersByTimeAsync(31_000);
			const second = await fetch2("https://api.openai.com/v1/responses", {
				method: "POST",
				body: JSON.stringify(postGpt51),
			});
			expect(second.status).toBe(503);
			expect(warnCalls("no resolvable accountId")).toHaveLength(1);
		});
	});

	describe("host auth.json backfill", () => {
		it("writes to XDG_DATA_HOME/opencode/auth.json atomically with mode 0600", async () => {
			const xdg = await fs.mkdtemp(join(tmpdir(), "xdg-data-"));
			vi.stubEnv("XDG_DATA_HOME", xdg);
			const plugin = await Reflect.apply(OpenAIOAuthPlugin, undefined, [
				{ client: client() },
			]) as PluginInstance;
			plugins.push(plugin);

			const authPath = join(xdg, "opencode", "auth.json");
			const written = JSON.parse(await fs.readFile(authPath, "utf8")) as {
				openai: { type: string; access: string; refresh: string };
			};
			expect(written.openai.type).toBe("oauth");
			expect(written.openai.access).toBe("test-access");
			expect(written.openai.refresh).toBe("test-refresh");
			const stat = await fs.stat(authPath);
			expect(stat.mode & 0o777).toBe(0o600);
		});
	});
});

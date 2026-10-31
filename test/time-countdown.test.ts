/**
 * Clock-skew coverage for index.ts's private `sleepWithCountdown` retry loop
 * (index.ts:2688-2735), reached end-to-end via the plugin's sdk.fetch
 * "all accounts rate-limited" path (index.ts:4078-4099).
 * Harness mirrors test/index-retry.test.ts. Promoted from the round-2 clock
 * audit.
 *
 *   - PROVEN       : behavior verified correct at the boundary.
 *   - AUDIT BUG    : characterization test pinning observed deficient
 *     behaviour; a fix should flip the expectation in the same commit.
 *   - AUDIT FINDING: semantics worth recording; severity contextual.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const T0 = Date.UTC(2026, 1, 15, 12, 0, 0, 0);

// Hoisted knobs the AccountManager double reads — set before each dynamic
// index.js import (resetModules between tests re-imports fresh).
const knobs = vi.hoisted(() => ({
	waitMs: 10_000,
	maxWaitMs: "60000",
	maxRetries: "1",
}));

vi.mock("@opencode-ai/plugin/tool", () => {
	const makeSchema = () => ({
		optional: () => makeSchema(),
		describe: () => makeSchema(),
	});
	const tool = (definition: any) => definition;
	(tool as any).schema = {
		number: () => makeSchema(),
		boolean: () => makeSchema(),
		string: () => makeSchema(),
		array: () => makeSchema(),
		enum: () => makeSchema(),
	};
	return { tool };
});

vi.mock("../lib/request/fetch-helpers.js", () => ({
	applyServiceTier: () => undefined,
	extractRequestUrl: (input: any) => (typeof input === "string" ? input : String(input)),
	rewriteUrlForCodex: (url: string) => url,
	transformRequestForCodex: async (init: any) => ({ updatedInit: init, body: { model: "gpt-5.1" } }),
	shouldRefreshToken: () => false,
	refreshAndUpdateToken: async (auth: any) => auth,
	createCodexHeaders: () => new Headers(),
	handleErrorResponse: async (response: Response) => ({ response }),
	isDeactivatedWorkspaceError: () => false,
	createAbortError: (signal?: AbortSignal | null) => {
		const reason = (signal as any)?.reason;
		if (reason instanceof Error) {
			if (reason.name !== "AbortError") reason.name = "AbortError";
			return reason;
		}
		const err = new Error(typeof reason === "string" && reason.length > 0 ? reason : "Aborted");
		err.name = "AbortError";
		return err;
	},
	isInvalidatedAuthTokenError: (_errorBody: unknown, status?: number) => status === 401,
	resolveUnsupportedCodexFallbackModel: () => undefined,
	isDefaultAutoFallbackModel: () => false,
	pickFallbackChainTarget: () => undefined,
	getUnsupportedCodexModelInfo: () => ({
		isUnsupported: false,
		unsupportedModel: undefined,
		message: undefined,
	}),
	shouldFallbackToGpt52OnUnsupportedGpt53: () => false,
	handleSuccessResponse: async (response: Response) => response,
}));

vi.mock("../lib/request/request-transformer.js", () => ({
	applyFastSessionDefaults: <T>(config: T) => config,
}));

vi.mock("../lib/accounts.js", () => {
	class AccountManager {
		private calls = 0;
		private readonly accounts = [
			null,
			{ index: 0, accountId: "account-1", email: "user@example.com" },
			{ index: 1, accountId: "account-2", email: "second@example.com" },
		] as const;

		static async loadFromDisk() {
			return new AccountManager();
		}

		getAccountCount() {
			return 2;
		}

		getCurrentOrNextForFamily() {
			const account = this.accounts[Math.min(this.calls, this.accounts.length - 1)];
			this.calls += 1;
			return account;
		}

		getCurrentOrNextForFamilyHybrid() {
			return this.getCurrentOrNextForFamily();
		}

		getAccountForStrategy() {
			return this.getCurrentOrNextForFamilyHybrid();
		}

		getSelectionExplainability() {
			return [];
		}

		recordSuccess() {}
		recordRateLimit() {}
		recordFailure() {}

		authFailures = 0;

		async incrementAuthFailures() {
			this.authFailures += 1;
			return this.authFailures;
		}

		clearAuthFailures() {
			this.authFailures = 0;
		}

		removeAccountsWithSameRefreshToken() {
			return 1;
		}

		markAccountsWithRefreshTokenCoolingDown() {
			return 1;
		}

		toAuthDetails() {
			return {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			};
		}

		hasRefreshToken(_token: string) {
			return true;
		}

		saveToDiskDebounced() {}
		updateFromAuth() {}
		async saveToDisk() {}
		markAccountCoolingDown() {}
		markRateLimited() {}
		markRateLimitedWithReason() {}
		consumeToken() { return true; }
		refundToken() {}
		markSwitched() {}

		getMinWaitTimeForFamily() {
			return knobs.waitMs;
		}

		getAccountsSnapshot() {
			return this.accounts.filter((account) => account !== null);
		}

		shouldShowAccountToast() {
			return false;
		}

		markToastShown() {}
	}

	return {
		AccountManager,
		extractAccountEmail: () => "user@example.com",
		extractAccountId: () => "account-1",
		selectBestAccountCandidate: (candidates: Array<{ accountId: string }>) => candidates[0] ?? null,
		resolveRequestAccountId: (_storedId: string | undefined, _source: string | undefined, tokenId: string | undefined) => tokenId,
		formatAccountLabel: (_account: any, index: number) => `Account ${index + 1}`,
		formatCooldown: (ms: number) => `${ms}ms`,
		formatWaitTime: (ms: number) => `${ms}ms`,
		sanitizeEmail: (email: string) => email,
		parseRateLimitReason: () => "unknown",
		lookupCodexCliTokensByEmail: vi.fn(async () => null),
	};
});

vi.mock("../lib/storage.js", () => ({
	getStoragePath: () => "",
	loadAccounts: async () => null,
	saveAccounts: async () => {},
	withAccountStorageTransaction: async (
		handler: (
			current: null,
			persist: (storage: unknown) => Promise<void>,
		) => Promise<unknown>,
	) => handler(null, async () => {}),
	setStoragePath: () => {},
	exportAccounts: async () => {},
	importAccounts: async () => ({ imported: 0, total: 0 }),
	previewImportAccounts: async () => { return { imported: 0, total: 0, skipped: 0 }; },
	createTimestampedBackupPath: () => "/tmp/codex-backup-test.json",
}));

vi.mock("../lib/auto-update-checker.js", () => ({
	checkAndNotify: async () => {},
	checkForUpdates: async () => ({ hasUpdate: false, currentVersion: "4.5.0", latestVersion: null, updateCommand: "" }),
	clearUpdateCache: () => {},
}));

describe("clock audit — sleepWithCountdown under wall-clock jumps", () => {
	const envKeys = [
		"CODEX_AUTH_RETRY_ALL_RATE_LIMITED",
		"CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS",
		"CODEX_AUTH_RETRY_ALL_MAX_RETRIES",
		"CODEX_AUTH_TOKEN_REFRESH_SKEW_MS",
		"CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS",
		"CODEX_AUTH_PREWARM",
		"CODEX_AUTH_AUTO_PROTECT_CREDITS",
		"CODEX_AUTH_QUOTA_NOTIFICATIONS",
	] as const;

	const originalEnv: Record<string, string | undefined> = {};
	let originalFetch: typeof globalThis.fetch;

	const bootPlugin = async () => {
		const { OpenAIAuthPlugin } = (await import("../index.js")) as any;
		const client = { tui: { showToast: vi.fn() }, auth: { set: vi.fn() } } as any;
		const plugin = await OpenAIAuthPlugin({ client } as any);
		const getAuth = async () => ({
			type: "oauth" as const,
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});
		return (await (plugin.auth as any).loader(getAuth, { options: {}, models: {} } as any)) as any;
	};

	beforeEach(() => {
		for (const key of envKeys) originalEnv[key] = process.env[key];
		process.env.CODEX_AUTH_RETRY_ALL_RATE_LIMITED = "1";
		process.env.CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS = knobs.maxWaitMs;
		process.env.CODEX_AUTH_RETRY_ALL_MAX_RETRIES = knobs.maxRetries;
		process.env.CODEX_AUTH_TOKEN_REFRESH_SKEW_MS = "0";
		process.env.CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS = "0";
		process.env.CODEX_AUTH_PREWARM = "0";
		process.env.CODEX_AUTH_AUTO_PROTECT_CREDITS = "0";
		process.env.CODEX_AUTH_QUOTA_NOTIFICATIONS = "0";
		knobs.waitMs = 10_000;
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		// Neutralize addJitter(waitMs, 0.2): random 0.5 => jitter delta 0.
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.fetch = originalFetch;
		for (const key of envKeys) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it("PROVEN (baseline): a 10s wait completes after ~10s of clock advance", async () => {
		const sdk = await bootPlugin();
		let settled = false;
		const fetchPromise = sdk.fetch("https://example.com", {}).finally(() => { settled = true; });
		expect(globalThis.fetch).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(9_999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(2_000);
		await fetchPromise;
		expect(settled).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("FIXED: a backward jump mid-wait does NOT extend the countdown — it is monotonic now (index.ts)", async () => {
		const sdk = await bootPlugin();
		let settled = false;
		const fetchPromise = sdk.fetch("https://example.com", {}).finally(() => { settled = true; });

		// 3s into a 10s wait, wall clock jumps back 60s. The countdown runs on
		// performance.now(), which vitest advances with the fake timers and the
		// Date jump cannot touch.
		await vi.advanceTimersByTimeAsync(3_000);
		vi.setSystemTime(T0 - 60_000);

		await vi.advanceTimersByTimeAsync(10_000);
		// ~13s of monotonic advance > the 10s deadline — the wait ends on
		// schedule instead of running ~60s late.
		await fetchPromise;
		expect(settled).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("FIXED: a forward jump no longer abandons the remaining backoff — the monotonic deadline stands (index.ts)", async () => {
		// Fake ONLY Date so performance.now() and setTimeout run on real,
		// monotonic time — which is exactly what the fixed loop uses.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
		knobs.waitMs = 8_000;
		const sdk = await bootPlugin();
		let settled = false;
		const fetchPromise = sdk.fetch("https://example.com", {}).finally(() => { settled = true; });
		const startedAt = performance.now(); // real monotonic — Date is faked

		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(globalThis.fetch).not.toHaveBeenCalled();

		vi.setSystemTime(T0 + 600_000); // wall clock jumps 10 minutes forward

		// The first 5s sleep boundary is where the old loop exited early;
		// under the monotonic deadline the wait is still running.
		await new Promise((resolve) => setTimeout(resolve, 5_500));
		expect(settled).toBe(false);
		expect(globalThis.fetch).not.toHaveBeenCalled();

		// It completes only when the real ~8s have elapsed.
		await fetchPromise;
		expect(settled).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		const realElapsed = performance.now() - startedAt;
		expect(realElapsed).toBeGreaterThan(7_000);
		expect(realElapsed).toBeLessThan(20_000);
	}, 20_000);

	it("FIXED: backward jump under REAL setTimeout semantics — the monotonic wait completes on schedule, no clock recovery needed (index.ts)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
		knobs.waitMs = 300; // one real 300ms sleep first
		const sdk = await bootPlugin();
		let settled = false;
		const fetchPromise = sdk.fetch("https://example.com", {}).finally(() => { settled = true; });

		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(globalThis.fetch).not.toHaveBeenCalled();

		vi.setSystemTime(T0 - 60_000); // clock rolls back a minute mid-wait

		// The old loop re-slept until the wall clock recovered; the monotonic
		// deadline ignores the jump entirely and exits at ~300ms real.
		await new Promise((resolve) => setTimeout(resolve, 700));
		await fetchPromise;
		expect(settled).toBe(true);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	}, 20_000);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { rewriteUrlForCodexMock } = vi.hoisted(() => ({
	rewriteUrlForCodexMock: vi.fn((url: string) => url),
}));

vi.mock("@opencode-ai/plugin/tool", () => {
	const makeSchema = () => ({
		optional: () => makeSchema(),
		describe: () => makeSchema(),
	});

	const tool = (definition: unknown) => definition;
	(tool as unknown as { schema: unknown }).schema = {
		number: () => makeSchema(),
		boolean: () => makeSchema(),
		string: () => makeSchema(),
		array: () => makeSchema(),
	};

	return { tool };
});

vi.mock("../lib/auth/auth.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/auth/auth.js")>(
		"../lib/auth/auth.js",
	);
	return {
		...actual,
		createAuthorizationFlow: vi.fn(async () => ({
			pkce: { verifier: "test-verifier", challenge: "test-challenge" },
			state: "test-state",
			url: "https://auth.openai.com/test",
		})),
		exchangeAuthorizationCode: vi.fn(async () => ({
			type: "success" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 3600_000,
			idToken: "id-token",
		})),
		decodeJWT: vi.fn((token: string) => {
			try {
				const payload = token.split(".")[1];
				return payload
					? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
							string,
							unknown
						>)
					: null;
			} catch {
				return null;
			}
		}),
	};
});

// Only the refresh lease is stubbed: `getStoragePath()` is mocked to a path that
// does not exist, and acquiring a real cross-process lockfile there would create
// directories outside the test sandbox. Everything else stays real.
vi.mock("../lib/storage/transaction-lock.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/storage/transaction-lock.js")>(
		"../lib/storage/transaction-lock.js",
	);
	return {
		...actual,
		withRefreshLease: vi.fn(
			async (
				_storagePath: string,
				operation: (lease: { assertValid: () => void }) => Promise<unknown>,
			) => operation({ assertValid: () => {} }),
		),
	};
});

vi.mock("../lib/refresh-queue.js", () => ({
	queuedRefresh: vi.fn(async () => ({
		type: "success" as const,
		access: "refreshed-access",
		refresh: "refreshed-refresh",
		expires: Date.now() + 3600_000,
	})),
	getRefreshQueueMetrics: vi.fn(() => ({
		started: 0,
		deduplicated: 0,
		rotationReused: 0,
		succeeded: 0,
		failed: 0,
		exceptions: 0,
		rotated: 0,
		staleEvictions: 0,
		lastDurationMs: 0,
		lastFailureReason: null,
		pending: 0,
	})),
}));

vi.mock("../lib/auth/browser.js", () => ({
	openBrowserUrl: vi.fn(() => true),
}));

vi.mock("../lib/auth/server.js", () => ({
	startLocalOAuthServer: vi.fn(async () => ({
		ready: true,
		close: vi.fn(),
		waitForCode: vi.fn(async () => ({ code: "auth-code" })),
	})),
}));

vi.mock("../lib/auth/device-code.js", () => ({
	createDeviceCodeSession: vi.fn(async () => ({
		type: "ready" as const,
		session: {
			verificationUrl: "https://auth.openai.com/codex/device",
			userCode: "ABCD-EFGH",
			deviceAuthId: "device-auth-1",
			intervalSeconds: 1,
		},
	})),
	buildDeviceCodeInstructions: vi.fn(
		(session: { verificationUrl: string; userCode: string }) =>
			`Open this link and sign in: ${session.verificationUrl}\nEnter this one-time code: ${session.userCode}\nThis code expires in about 15 minutes.`,
	),
	completeDeviceCodeSession: vi.fn(async () => ({
		type: "success" as const,
		access: "device-access-token",
		refresh: "device-refresh-token",
		expires: Date.now() + 3600_000,
		idToken: "device-id-token",
	})),
}));

vi.mock("../lib/cli.js", () => ({
	promptLoginMode: vi.fn(async () => ({ mode: "add" })),
	promptAddAnotherAccount: vi.fn(async () => false),
}));

vi.mock("../lib/config.js", () => ({
	getCodexMode: () => true,
	getRequestTransformMode: () => "native",
	getFastSession: () => false,
	getFastSessionStrategy: () => "hybrid",
	getFastSessionMaxInputItems: () => 30,
	getRetryProfile: () => "balanced",
	getRetryBudgetOverrides: () => ({}),
	getRateLimitToastDebounceMs: () => 5000,
	getRetryAllAccountsMaxRetries: () => 3,
	getRetryAllAccountsMaxWaitMs: () => 30000,
	getRetryAllAccountsRateLimited: () => true,
	getUnsupportedCodexPolicy: vi.fn(() => "fallback"),
	getFallbackOnUnsupportedCodexModel: vi.fn(() => true),
	getFallbackToGpt52OnUnsupportedGpt53: vi.fn(() => false),
	getUnsupportedCodexFallbackChain: () => ({}),
	getTokenRefreshSkewMs: () => 60000,
	getSessionRecovery: () => false,
	getAutoResume: () => false,
	getAutoUpdate: () => true,
	getToastDurationMs: () => 5000,
	getAccountToastsEnabled: vi.fn(() => true),
	getPerProjectAccounts: () => false,
	getEmptyResponseMaxRetries: () => 2,
	getEmptyResponseRetryDelayMs: () => 1000,
	getPidOffsetEnabled: () => false,
	getRotationStrategy: () => "hybrid",
	getModelAccountPool: vi.fn(() => []),
	getModelAccountPoolMode: vi.fn(() => "preferred"),
	getFetchTimeoutMs: () => 60000,
	getStreamStallTimeoutMs: () => 45000,
	getCodexTuiV2: () => false,
	getCodexTuiColorProfile: () => "ansi16",
	getCodexTuiGlyphMode: () => "ascii",
	getCodexTuiMaskEmail: vi.fn(() => false),
	getBeginnerSafeMode: () => false,
	loadPluginConfig: () => ({}),
}));

vi.mock("../lib/request/request-transformer.js", () => ({
	applyFastSessionDefaults: <T>(config: T) => config,
	clampReasoningForModel: <T>(reasoning: T) => reasoning,
	upsertBackendModelIdentityMessage: (input: unknown) => input,
}));

vi.mock("../lib/logger.js", () => ({
	initLogger: vi.fn(),
	logRequest: vi.fn(),
	logDebug: vi.fn(),
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logError: vi.fn(),
	setCorrelationId: vi.fn(() => "test-correlation-id"),
	clearCorrelationId: vi.fn(),
	createLogger: vi.fn(() => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		time: vi.fn(() => vi.fn(() => 0)),
		timeEnd: vi.fn(),
	})),
}));

vi.mock("../lib/auto-update-checker.js", () => ({
	checkAndNotify: vi.fn(async () => {}),
}));

const { quotaMonitorMock } = vi.hoisted(() => ({
	quotaMonitorMock: {
		start: vi.fn(),
		dispose: vi.fn(),
		runNow: vi.fn(async () => {}),
	},
}));

// The factory is a plain function, not a `vi.fn`, so the `resetAllMocks` in the
// fetch-handler suite cannot reset it to returning `undefined`.
vi.mock("../lib/quota-notifications.js", () => ({
	createQuotaMonitor: () => quotaMonitorMock,
}));

vi.mock("../lib/context-overflow.js", () => ({
	handleContextOverflow: vi.fn(async () => ({ handled: false })),
}));

vi.mock("../lib/rotation.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../lib/rotation.js")>(),
	addJitter: (ms: number) => ms,
}));

// The interactive account picker (`promptAccountIndexSelection`) and setup
// wizard dynamically import this; mocking it lets us capture the menu items
// (account labels) without a real TTY. Only active when a test stubs isTTY.
vi.mock("../lib/ui/select.js", () => ({
	select: vi.fn(async () => null),
}));

vi.mock("../lib/prompts/codex.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../lib/prompts/codex.js")>(),
	getModelFamily: (model: string) => {
		if (model.includes("codex-max")) return "codex-max";
		if (model.includes("codex")) return "codex";
		return "gpt-5.1";
	},
	getCodexInstructions: vi.fn(async () => "test instructions"),
	prewarmCodexInstructions: vi.fn(),
}));

vi.mock("../lib/prompts/opencode-codex.js", () => ({
	prewarmOpenCodeCodexPrompt: vi.fn(),
}));

vi.mock("../lib/recovery.js", () => ({
	createSessionRecoveryHook: vi.fn(),
	isRecoverableError: () => false,
	detectErrorType: () => "unknown",
	getRecoveryToastContent: () => ({ title: "Error", message: "Test" }),
}));

vi.mock("../lib/request/rate-limit-backoff.js", () => ({
	getRateLimitBackoff: () => ({ attempt: 1, delayMs: 1000 }),
	RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS: 5000,
	resetRateLimitBackoff: vi.fn(),
}));

	vi.mock("../lib/request/fetch-helpers.js", () => ({
		extractRequestUrl: (input: unknown) => (typeof input === "string" ? input : String(input)),
		rewriteUrlForCodex: rewriteUrlForCodexMock,
		transformRequestForCodex: vi.fn(async (init: unknown) => ({
		updatedInit: init,
		body: { model: "gpt-5.1" },
	})),
		shouldRefreshToken: () => false,
		refreshAndUpdateToken: vi.fn(async (auth: unknown) => auth),
		createCodexHeaders: vi.fn(() => new Headers()),
		handleErrorResponse: vi.fn(async (response: Response) => ({ response })),
		isDeactivatedWorkspaceError: vi.fn((errorBody: unknown, status?: number) => {
			if (status !== 402 || !errorBody || typeof errorBody !== "object") return false;
			const body = errorBody as {
				code?: unknown;
				detail?: { code?: unknown } | undefined;
				error?: { code?: unknown; type?: unknown } | undefined;
			};
			const code =
				(typeof body.code === "string" && body.code) ||
				(typeof body.detail?.code === "string" && body.detail.code) ||
				(typeof body.error?.code === "string" && body.error.code) ||
				(typeof body.error?.type === "string" && body.error.type) ||
				undefined;
			return code === "deactivated_workspace";
		}),
		isInvalidatedAuthTokenError: vi.fn((_errorBody: unknown, status?: number) => status === 401),
	getUnsupportedCodexModelInfo: vi.fn(() => ({ isUnsupported: false })),
	resolveUnsupportedCodexFallbackModel: vi.fn(() => undefined),
	isDefaultAutoFallbackModel: vi.fn(() => false),
	pickFallbackChainTarget: vi.fn(() => undefined),
	shouldFallbackToGpt52OnUnsupportedGpt53: vi.fn(() => false),
	handleSuccessResponse: vi.fn(async (response: Response) => response),
}));

const mockStorage = {
	version: 3 as const,
	accounts: [] as Array<{
		accountId?: string;
		organizationId?: string;
		accountIdSource?: string;
		accountLabel?: string;
		email?: string;
		refreshToken: string;
		accessToken?: string;
		expiresAt?: number;
		enabled?: boolean;
		addedAt?: number;
		lastUsed?: number;
		coolingDownUntil?: number;
		cooldownReason?: string;
		rateLimitResetTimes?: Record<string, number>;
		quotaExhaustedUntil?: number;
		lastSwitchReason?: string;
	}>,
	activeIndex: 0,
	activeIndexByFamily: {} as Record<string, number>,
};

/** Records every quota-exhaustion block the request path applies (issue #218). */
const mockQuotaExhaustionCalls: Array<{
	resetAtMs: number;
	family: string;
	model?: string | null;
}> = [];

type MockManagedAccount = {
	index: number;
	accountId?: string;
	accountUserId?: string;
	email?: string;
	refreshToken: string;
	addedAt?: number;
	/** `false` makes rotation skip it, standing in for rate-limited/cooling down. */
	selectable?: boolean;
};

/**
 * Accounts served by the mocked `AccountManager`. Most suites assume the single
 * default account; tests that need real rotation across several accounts replace
 * the contents with `setMockManagedAccounts`, and the hooks reset it afterwards.
 */
const mockManagedAccounts: MockManagedAccount[] = [];

const setMockManagedAccounts = (
	accounts: ReadonlyArray<Omit<MockManagedAccount, "index">>,
) => {
	mockManagedAccounts.length = 0;
	accounts.forEach((account, index) =>
		mockManagedAccounts.push({ ...account, index, addedAt: account.addedAt ?? index }),
	);
};

const resetMockManagedAccounts = () =>
	setMockManagedAccounts([
		{ accountId: "acc-1", email: "user1@example.com", refreshToken: "refresh-1" },
	]);

resetMockManagedAccounts();

const cloneAccount = (account: (typeof mockStorage.accounts)[number]) => structuredClone(account);

const cloneMockStorage = () => ({
	...mockStorage,
	accounts: mockStorage.accounts.map(cloneAccount),
	activeIndexByFamily: { ...mockStorage.activeIndexByFamily },
});

const mockFlaggedStorage = {
	version: 1 as const,
	accounts: [] as Array<{
		accountId?: string;
		organizationId?: string;
		accountIdSource?: string;
		accountLabel?: string;
		email?: string;
		refreshToken: string;
		flaggedAt: number;
		flaggedReason?: string;
		lastError?: string;
		addedAt?: number;
		lastUsed?: number;
	}>,
};

const cloneFlaggedAccount = (account: (typeof mockFlaggedStorage.accounts)[number]) =>
	structuredClone(account);

const cloneMockFlaggedStorage = () => ({
	...mockFlaggedStorage,
	accounts: mockFlaggedStorage.accounts.map(cloneFlaggedAccount),
});

const parseJsonOutput = <T>(output: string): T => JSON.parse(output) as T;

const persistMockFlaggedStorage = async (nextStorage: typeof mockFlaggedStorage) => {
	mockFlaggedStorage.version = nextStorage.version;
	mockFlaggedStorage.accounts = nextStorage.accounts.map(cloneFlaggedAccount);
};

const mockSaveFlaggedAccounts = vi.fn(async (nextStorage: typeof mockFlaggedStorage) => {
	await persistMockFlaggedStorage(nextStorage);
});

vi.mock("../lib/storage.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/storage.js")>("../lib/storage.js");

	return {
	getStoragePath: () => "/mock/path/accounts.json",
	loadAccounts: vi.fn(async () => cloneMockStorage()),
	saveAccounts: vi.fn(async (nextStorage: typeof mockStorage) => {
		mockStorage.version = nextStorage.version;
		mockStorage.accounts = nextStorage.accounts.map(cloneAccount);
		mockStorage.activeIndex = nextStorage.activeIndex;
		mockStorage.activeIndexByFamily = { ...nextStorage.activeIndexByFamily };
	}),
	withAccountStorageTransaction: vi.fn(
		async <T>(
			callback: (
				loadedStorage: typeof mockStorage,
				persist: (nextStorage: typeof mockStorage) => Promise<void>,
			) => Promise<T>,
		) => {
			const loadedStorage = cloneMockStorage();
			const persist = async (nextStorage: typeof mockStorage) => {
				mockStorage.version = nextStorage.version;
				mockStorage.accounts = nextStorage.accounts.map(cloneAccount);
				mockStorage.activeIndex = nextStorage.activeIndex;
				mockStorage.activeIndexByFamily = { ...nextStorage.activeIndexByFamily };
			};
			return await callback(loadedStorage, persist);
		},
	),
	clearAccounts: vi.fn(async () => {}),
	setStoragePath: vi.fn(),
	exportAccounts: vi.fn(async () => {}),
	importAccounts: vi.fn(async () => ({
		imported: 2,
		skipped: 1,
		total: 5,
		backupStatus: "created",
		backupPath: "/tmp/codex-pre-import-backup-20260101-000000000-deadbe.json",
	})),
	previewImportAccounts: vi.fn(async () => ({ imported: 2, skipped: 1, total: 5 })),
	createTimestampedBackupPath: vi.fn((prefix?: string) => `/tmp/${prefix ?? "codex-backup"}-20260101-000000.json`),
	loadFlaggedAccounts: vi.fn(async () => cloneMockFlaggedStorage()),
	getWorkspaceIdentityKey: vi.fn(actual.getWorkspaceIdentityKey),
	saveFlaggedAccounts: mockSaveFlaggedAccounts,
	withFlaggedAccountStorageTransaction: vi.fn(
		async <T>(
			callback: (
				loadedStorage: typeof mockFlaggedStorage,
				persist: (nextStorage: typeof mockFlaggedStorage) => Promise<void>,
			) => Promise<T>,
		) => {
			const loadedStorage = cloneMockFlaggedStorage();
			const persist = async (nextStorage: typeof mockFlaggedStorage) => {
				await mockSaveFlaggedAccounts(nextStorage);
			};
			return await callback(loadedStorage, persist);
		},
	),
	clearFlaggedAccounts: vi.fn(async () => {}),
	StorageError: class StorageError extends Error {
		hint: string;
		constructor(message: string, hint: string) {
			super(message);
			this.hint = hint;
		}
	},
	formatStorageErrorHint: () => "Check file permissions",
	};
});

vi.mock("../lib/accounts.js", () => {
	class MockAccountManager {
		// A getter, not a field: the list is owned by `mockManagedAccounts` so a
		// test can reshape it after the manager has already been constructed.
		private get accounts(): MockManagedAccount[] {
			return mockManagedAccounts;
		}

		static async loadFromDisk() {
			return new MockAccountManager();
		}

		getAccountCount() {
			return this.accounts.length;
		}

		private selectableAccounts(excludedIndices?: ReadonlySet<number>) {
			return this.accounts.filter(
				(account) =>
					account.selectable !== false && !excludedIndices?.has(account.index),
			);
		}

		getCurrentOrNextForFamily() {
			return this.selectableAccounts()[0] ?? null;
		}

		getCurrentOrNextForFamilyHybrid() {
			return this.selectableAccounts()[0] ?? null;
		}

		getAccountForStrategy(
			_strategy?: string,
			_family?: string,
			_model?: string,
			_options?: unknown,
			preferredAccountIds: readonly string[] = [],
			poolMode: "preferred" | "strict" = "preferred",
			excludedIndices?: ReadonlySet<number>,
		) {
			// Honouring `excludedIndices` is what lets a test rotate across several
			// accounts: without it the caller re-selects account 0 and bails out.
			const available = this.selectableAccounts(excludedIndices);
			const preferred = available.find(
				(account) =>
					account.accountId !== undefined &&
					preferredAccountIds.includes(account.accountId),
			);
			if (preferred) return preferred;
			if (poolMode === "strict" && preferredAccountIds.length > 0) return null;
			return available[0] ?? null;
		}

		getSelectionExplainability() {
			return this.accounts.map((account, index) => ({
				index,
				enabled: true,
				isCurrentForFamily: index === 0,
				eligible: true,
				reasons: ["eligible"],
				healthScore: 100,
				tokensAvailable: 50,
				lastUsed: Date.now(),
			}));
		}

		recordSuccess() {}
		recordRateLimit() {}
		recordFailure() {}

		toAuthDetails() {
			return {
				type: "oauth" as const,
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			};
		}

		hasRefreshToken() {
			return true;
		}

		saveToDiskDebounced() {}
		async flushPendingSave() {}
		disposeShutdownHandler() {}
		updateFromAuth() {}
		clearAuthFailures() {}
		incrementAuthFailures() { return 1; }
		async saveToDisk() {}
		markAccountCoolingDown() {}
		markAccountsWithRefreshTokenCoolingDown() { return 1; }
		markRateLimited() {}
		markRateLimitedWithReason() {}
		markQuotaExhausted(
			_account: unknown,
			resetAtMs: number,
			family: string,
			model?: string | null,
		) {
			mockQuotaExhaustionCalls.push({ resetAtMs, family, model });
			return true;
		}
		consumeToken() { return true; }
		refundToken() {}
		markSwitched() {}
		removeAccount() {}
		removeAccountsWithSameRefreshToken() { return 1; }
		removeAccountsByWorkspaceIdentity() { return 1; }

		getMinWaitTimeForFamily() {
			return 0;
		}

		shouldShowAccountToast() {
			return false;
		}

		markToastShown() {}

		setActiveIndex(index: number) {
			return this.accounts[index] ?? null;
		}

		getAccountsSnapshot() {
			return this.accounts;
		}
	}

	return {
		AccountManager: MockAccountManager,
		getAccountIdCandidates: vi.fn(() => [
			{ accountId: "acc-1", source: "token" as const, label: "Test" },
		]),
		selectBestAccountCandidate: vi.fn(
			(candidates: Array<{ accountId: string }>) => candidates[0] ?? null,
		),
		extractAccountEmail: vi.fn(() => "user@example.com"),
		extractAccountId: vi.fn(() => "account-1"),
		extractAccountUserId: vi.fn(() => undefined),
		resolveRequestAccountId: vi.fn(
			(_storedId: string | undefined, _source: string | undefined, tokenId: string | undefined) =>
				tokenId,
		),
		formatAccountLabel: vi.fn(
			(_account: unknown, index: number) => `Account ${index + 1}`,
		),
		formatCooldown: () => null,
		formatWaitTime: (ms: number) => `${Math.round(ms / 1000)}s`,
		sanitizeEmail: (email: string) => email,
		shouldUpdateAccountIdFromToken: vi.fn(() => true),
		parseRateLimitReason: () => "unknown",
		lookupCodexCliTokensByEmail: vi.fn(async () => null),
	};
});

type ToolExecute<T = void> = { execute: (args: T) => Promise<string> };
type OptionalToolExecute<T> = { execute: (args?: T) => Promise<string> };
type PluginType = {
	event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>;
	auth: {
		provider: string;
		methods: Array<{ label: string; type: string }>;
		loader: (getAuth: () => Promise<unknown>, provider: unknown) => Promise<{
			apiKey?: string;
			baseURL?: string;
			fetch?: (input: unknown, init?: unknown) => Promise<Response>;
		}>;
	};
	tool: {
		"codex-list": OptionalToolExecute<{ tag?: string; format?: string; includeSensitive?: boolean }>;
		"codex-switch": OptionalToolExecute<{ index?: number }>;
		"codex-warm": ToolExecute;
		"codex-status": OptionalToolExecute<{ format?: string; includeSensitive?: boolean }>;
		"codex-limits": OptionalToolExecute<{ format?: string; includeSensitive?: boolean }>;
		"codex-metrics": OptionalToolExecute<{ format?: string }>;
		"codex-help": ToolExecute<{ topic?: string }>;
		"codex-setup": OptionalToolExecute<{ wizard?: boolean }>;
		"codex-doctor": OptionalToolExecute<{ deep?: boolean; fix?: boolean; format?: string }>;
		"codex-next": OptionalToolExecute<{ format?: string }>;
		"codex-label": ToolExecute<{ index?: number; label: string }>;
		"codex-tag": ToolExecute<{ index?: number; tags: string }>;
		"codex-pool": OptionalToolExecute<{
			action?: string;
			model?: string;
			accounts?: number[];
			dryRun?: boolean;
			format?: string;
			includeSensitive?: boolean;
		}>;
		"codex-note": ToolExecute<{ index?: number; note: string }>;
		"codex-dashboard": OptionalToolExecute<{ format?: string; includeSensitive?: boolean }>;
		"codex-health": OptionalToolExecute<{ format?: string; includeSensitive?: boolean }>;
		"codex-remove": OptionalToolExecute<{ index?: number; confirm?: boolean }>;
		"codex-refresh": ToolExecute;
		"codex-export": ToolExecute<{ path?: string; force?: boolean; timestamped?: boolean }>;
		"codex-import": ToolExecute<{ path: string; dryRun?: boolean }>;
	};
};

const createMockClient = () => ({
	tui: { showToast: vi.fn() },
	auth: { set: vi.fn() },
	session: { prompt: vi.fn() },
});

describe("OpenAIOAuthPlugin", () => {
	let plugin: PluginType;
	let mockClient: ReturnType<typeof createMockClient>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockClient = createMockClient();

		mockStorage.accounts = [];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
		mockFlaggedStorage.accounts = [];

		const { OpenAIOAuthPlugin } = await import("../index.js");
		plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	describe("plugin structure", () => {
		it("exports event handler", () => {
			expect(plugin.event).toBeDefined();
			expect(typeof plugin.event).toBe("function");
		});

		it("exports auth configuration", () => {
			expect(plugin.auth).toBeDefined();
			expect(plugin.auth.provider).toBe("openai");
		});

		it("exports tool definitions", () => {
			expect(plugin.tool).toBeDefined();
			expect(plugin.tool["codex-list"]).toBeDefined();
			expect(plugin.tool["codex-switch"]).toBeDefined();
			expect(plugin.tool["codex-warm"]).toBeDefined();
			expect(plugin.tool["codex-status"]).toBeDefined();
			expect(plugin.tool["codex-limits"]).toBeDefined();
			expect(plugin.tool["codex-metrics"]).toBeDefined();
			expect(plugin.tool["codex-help"]).toBeDefined();
			expect(plugin.tool["codex-setup"]).toBeDefined();
			expect(plugin.tool["codex-doctor"]).toBeDefined();
			expect(plugin.tool["codex-next"]).toBeDefined();
			expect(plugin.tool["codex-label"]).toBeDefined();
			expect(plugin.tool["codex-tag"]).toBeDefined();
			expect(plugin.tool["codex-pool"]).toBeDefined();
			expect(plugin.tool["codex-note"]).toBeDefined();
			expect(plugin.tool["codex-dashboard"]).toBeDefined();
			expect(plugin.tool["codex-health"]).toBeDefined();
			expect(plugin.tool["codex-remove"]).toBeDefined();
			expect(plugin.tool["codex-refresh"]).toBeDefined();
			expect(plugin.tool["codex-export"]).toBeDefined();
			expect(plugin.tool["codex-import"]).toBeDefined();
		});

		it("rejects manual OAuth callbacks with mismatched state", async () => {
			const authModule = await import("../lib/auth/auth.js");
			const manualMethod = plugin.auth.methods[3] as unknown as {
				authorize: () => Promise<{
					validate: (input: string) => string | undefined;
					callback: (input: string) => Promise<{ type: string; reason?: string; message?: string }>;
				}>;
			};

			const flow = await manualMethod.authorize();
			const invalidInput = "http://localhost:1455/auth/callback?code=abc123&state=wrong-state";

			expect(flow.validate(invalidInput)).toContain("state mismatch");
			const result = await flow.callback(invalidInput);
			expect(result.type).toBe("failed");
			expect(result.reason).toBe("invalid_response");
			expect(vi.mocked(authModule.exchangeAuthorizationCode)).not.toHaveBeenCalled();
		});

		it("suggests device code when browser callback server is unavailable", async () => {
			const serverModule = await import("../lib/auth/server.js");
			vi.mocked(serverModule.startLocalOAuthServer).mockResolvedValueOnce({
				ready: false,
				close: vi.fn(),
				waitForCode: vi.fn(async () => null),
				port: 1455,
			});

			const autoMethod = plugin.auth.methods[0] as unknown as {
				authorize: (inputs?: Record<string, string>) => Promise<{
					instructions: string;
					callback: () => Promise<{ type: string; message?: string }>;
				}>;
			};

			const authResult = await autoMethod.authorize({ loginMode: "add", accountCount: "1" });
			expect(authResult.instructions).toContain("Device Code");
			expect(authResult.instructions).toContain("Manual URL Paste");

			const result = await authResult.callback();
			expect(result.type).toBe("failed");
			expect(result.message).toContain("Device Code");
		});

		it("completes device code login and persists the account", async () => {
			const deviceModule = await import("../lib/auth/device-code.js");
			const deviceMethod = plugin.auth.methods[2] as unknown as {
				authorize: () => Promise<{
					instructions: string;
					callback: () => Promise<{ type: string }>;
				}>;
			};

			const authResult = await deviceMethod.authorize();
			expect(authResult.instructions).toContain("ABCD-EFGH");
			expect(authResult.instructions).toContain("https://auth.openai.com/codex/device");

			const result = await authResult.callback();
			expect(result.type).toBe("success");
			expect(vi.mocked(deviceModule.createDeviceCodeSession)).toHaveBeenCalledTimes(1);
			expect(vi.mocked(deviceModule.completeDeviceCodeSession)).toHaveBeenCalledTimes(1);
			expect(mockStorage.accounts).toHaveLength(1);
			expect(mockStorage.accounts[0]).toMatchObject({
				refreshToken: "device-refresh-token",
				accessToken: "device-access-token",
				accountId: "acc-1",
			});
		});
	});

	describe("four-method OAuth contract", () => {
		it("plugin.auth.methods has four entries in the four-method order", () => {
			expect(plugin.auth.methods).toHaveLength(4);
			expect(plugin.auth.methods[0].label).toBe("Codex OAuth (ChatGPT Plus/Pro)");
			expect(plugin.auth.methods[1].label).toBe("Codex OAuth (Open URL Manually)");
			expect(plugin.auth.methods[2].label).toBe("Codex OAuth (Device Code)");
			expect(plugin.auth.methods[3].label).toBe("Codex OAuth (Manual URL Paste)");
		});

		it("noBrowser input returns the paste flow instead of launching a browser", async () => {
			// Programmatic input from a headless caller or script. Ignoring it
			// would enter the multi-account loop, try to launch a browser, and
			// bind port 1455 — the opposite of what was asked for.
			const browserModule = await import("../lib/auth/browser.js");
			vi.mocked(browserModule.openBrowserUrl).mockClear();
			const oauthMethod = plugin.auth.methods[0] as unknown as {
				authorize: (inputs?: Record<string, string>) => Promise<{
					url: string;
					method: string;
					validate?: (input: string) => string | undefined;
				}>;
			};

			for (const inputs of [{ noBrowser: "true" }, { "no-browser": "true" }]) {
				const flow = await oauthMethod.authorize(inputs);
				expect(flow.method).toBe("code");
				expect(flow.url.length).toBeGreaterThan(0);
				expect(vi.mocked(browserModule.openBrowserUrl)).not.toHaveBeenCalled();
			}
		});

		it("manual-browser method returns a non-empty URL with method:auto and does not open the default browser", async () => {
			const browserModule = await import("../lib/auth/browser.js");
			vi.mocked(browserModule.openBrowserUrl).mockClear();
			const manualBrowserMethod = plugin.auth.methods[1] as unknown as {
				authorize: () => Promise<{
					url: string;
					method: string;
				}>;
			};
			const flow = await manualBrowserMethod.authorize();
			expect(flow.url.length).toBeGreaterThan(0);
			expect(flow.method).toBe("auto");
			expect(vi.mocked(browserModule.openBrowserUrl)).not.toHaveBeenCalled();
		});

		it("manual-browser method awaits the callback server, exchanges the code, and persists a successful account", async () => {
			const authModule = await import("../lib/auth/auth.js");
			const serverModule = await import("../lib/auth/server.js");
			vi.mocked(authModule.exchangeAuthorizationCode).mockClear();
			vi.mocked(serverModule.startLocalOAuthServer).mockClear();
			const manualBrowserMethod = plugin.auth.methods[1] as unknown as {
				authorize: () => Promise<{
					callback: () => Promise<{ type: string }>;
				}>;
			};
			const flow = await manualBrowserMethod.authorize();
			const result = await flow.callback();
			expect(result.type).toBe("success");
			expect(vi.mocked(serverModule.startLocalOAuthServer)).toHaveBeenCalled();
			expect(vi.mocked(authModule.exchangeAuthorizationCode)).toHaveBeenCalledWith(
				"auth-code",
				"test-verifier",
				"http://localhost:1455/auth/callback",
			);
			expect(mockStorage.accounts).toHaveLength(1);
		});

		it("manual-browser method with unavailable listener returns a failed callback naming Device Code and Manual URL Paste and never opens the browser", async () => {
			const serverModule = await import("../lib/auth/server.js");
			vi.mocked(serverModule.startLocalOAuthServer).mockResolvedValueOnce({
				ready: false,
				close: vi.fn(),
				waitForCode: vi.fn(async () => null),
				port: 1455,
			});
			const browserModule = await import("../lib/auth/browser.js");
			vi.mocked(browserModule.openBrowserUrl).mockClear();
			const manualBrowserMethod = plugin.auth.methods[1] as unknown as {
				authorize: () => Promise<{
					url: string;
					callback: () => Promise<{ type: string; message?: string }>;
				}>;
			};
			const flow = await manualBrowserMethod.authorize();
			expect(vi.mocked(browserModule.openBrowserUrl)).not.toHaveBeenCalled();
			const result = await flow.callback();
			expect(result.type).toBe("failed");
			expect(result.message).toContain("Device Code");
			expect(result.message).toContain("Manual URL Paste");
		});

		it("manual paste rejects a raw authorization code with no state", async () => {
			// The state comparison is this flow's only in-plugin binding between
			// the pasted value and this login attempt. Accepting a bare code
			// would delegate that binding entirely to the authorization server's
			// PKCE enforcement and hand anything a user was talked into pasting
			// to the exchange with this attempt's verifier.
			const authModule = await import("../lib/auth/auth.js");
			vi.mocked(authModule.exchangeAuthorizationCode).mockClear();
			const manualMethod = plugin.auth.methods[3] as unknown as {
				authorize: () => Promise<{
					validate: (input: string) => string | undefined;
					callback: (input: string) => Promise<{ type: string }>;
				}>;
			};
			const flow = await manualMethod.authorize();
			const rawCode = "abc123";
			expect(flow.validate(rawCode)).toContain("state parameter");
			const result = await flow.callback(rawCode);
			expect(result.type).toBe("failed");
			expect(vi.mocked(authModule.exchangeAuthorizationCode)).not.toHaveBeenCalled();
		});

		it("manual paste accepts a full callback URL with matching state and calls exchange", async () => {
			const authModule = await import("../lib/auth/auth.js");
			vi.mocked(authModule.exchangeAuthorizationCode).mockClear();
			const manualMethod = plugin.auth.methods[3] as unknown as {
				authorize: () => Promise<{
					validate: (input: string) => string | undefined;
					callback: (input: string) => Promise<{ type: string }>;
				}>;
			};
			const flow = await manualMethod.authorize();
			const validUrl = "http://localhost:1455/auth/callback?code=abc123&state=test-state";
			expect(flow.validate(validUrl)).toBeUndefined();
			const result = await flow.callback(validUrl);
			expect(result.type).toBe("success");
			expect(vi.mocked(authModule.exchangeAuthorizationCode)).toHaveBeenCalledWith(
				"abc123",
				"test-verifier",
				"http://localhost:1455/auth/callback",
			);
		});

		it("manual paste with mismatched supplied state fails validation and callback without calling exchange", async () => {
			const authModule = await import("../lib/auth/auth.js");
			vi.mocked(authModule.exchangeAuthorizationCode).mockClear();
			const manualMethod = plugin.auth.methods[3] as unknown as {
				authorize: () => Promise<{
					validate: (input: string) => string | undefined;
					callback: (input: string) => Promise<{ type: string; reason?: string }>;
				}>;
			};
			const flow = await manualMethod.authorize();
			const mismatchedUrl = "http://localhost:1455/auth/callback?code=abc123&state=wrong-state";
			expect(flow.validate(mismatchedUrl)).toContain("state mismatch");
			const result = await flow.callback(mismatchedUrl);
			expect(result.type).toBe("failed");
			expect(result.reason).toBe("invalid_response");
			expect(vi.mocked(authModule.exchangeAuthorizationCode)).not.toHaveBeenCalled();
		});

		it.each([
			["full callback URL with no state", "http://localhost:1455/auth/callback?code=abc123"],
			["full callback URL with empty state", "http://localhost:1455/auth/callback?code=abc123&state="],
			["bare query with no state", "code=abc123"],
			["bare query with empty state", "code=abc123&state="],
			["bare fragment with no state", "#code=abc123"],
			["code#state with empty state", "abc123#"],
		])(
			"manual paste rejects structured input carrying no usable state (%s) before exchange",
			async (_label, input) => {
				// Given a manual-paste flow and structured input that omits its state
				const authModule = await import("../lib/auth/auth.js");
				vi.mocked(authModule.exchangeAuthorizationCode).mockClear();
				const manualMethod = plugin.auth.methods[3] as unknown as {
					authorize: () => Promise<{
						validate: (input: string) => string | undefined;
						callback: (input: string) => Promise<{ type: string; reason?: string }>;
					}>;
				};
				const flow = await manualMethod.authorize();

				// When it is validated and submitted
				const validation = flow.validate(input);
				const result = await flow.callback(input);

				// Then both gates refuse it and no exchange is attempted
				expect(validation).toBeDefined();
				expect(result.type).toBe("failed");
				expect(result.reason).toBe("invalid_response");
				expect(vi.mocked(authModule.exchangeAuthorizationCode)).not.toHaveBeenCalled();
			},
		);

		it("manual paste accepts a callback URL in the provider's own parameter shape", async () => {
			// Given a manual-paste flow and the URL shape the provider actually
			// redirects to: an opaque dotted code, a scope parameter between code
			// and state, and plus-encoded scope values
			const authModule = await import("../lib/auth/auth.js");
			vi.mocked(authModule.exchangeAuthorizationCode).mockClear();
			const manualMethod = plugin.auth.methods[3] as unknown as {
				authorize: () => Promise<{
					validate: (input: string) => string | undefined;
					callback: (input: string) => Promise<{ type: string }>;
				}>;
			};
			const flow = await manualMethod.authorize();
			const providerCode = "ac_ZmFrZS1hdXRoLWNvZGU.ZmFrZS1zaWduYXR1cmU";
			const providerUrl =
				`http://localhost:1455/auth/callback?code=${providerCode}` +
				`&scope=openid+profile+email+offline_access&state=test-state`;

			// When it is validated and submitted
			const validation = flow.validate(providerUrl);
			const result = await flow.callback(providerUrl);

			// Then the unrelated scope parameter does not defeat the state gate
			expect(validation).toBeUndefined();
			expect(result.type).toBe("success");
			expect(vi.mocked(authModule.exchangeAuthorizationCode)).toHaveBeenCalledWith(
				providerCode,
				"test-verifier",
				"http://localhost:1455/auth/callback",
			);
		});

		it("manual paste rejects that same provider code pasted on its own", async () => {
			// Given a manual-paste flow and only the opaque code from that callback
			const authModule = await import("../lib/auth/auth.js");
			vi.mocked(authModule.exchangeAuthorizationCode).mockClear();
			const manualMethod = plugin.auth.methods[3] as unknown as {
				authorize: () => Promise<{
					validate: (input: string) => string | undefined;
					callback: (input: string) => Promise<{ type: string }>;
				}>;
			};
			const flow = await manualMethod.authorize();
			const providerCode = "ac_ZmFrZS1hdXRoLWNvZGU.ZmFrZS1zaWduYXR1cmU";

			// When it is validated and submitted with no state alongside it
			const validation = flow.validate(providerCode);
			const result = await flow.callback(providerCode);

			// Then it is refused: a dotted opaque code is still a code with no
			// state, and PKCE alone is not this flow's binding to the attempt.
			expect(validation).toContain("state parameter");
			expect(result.type).toBe("failed");
			expect(vi.mocked(authModule.exchangeAuthorizationCode)).not.toHaveBeenCalled();
		});

		it("manual paste accepts code#state whose state matches the login attempt", async () => {
			// Given a manual-paste flow and code#state input for this attempt
			const authModule = await import("../lib/auth/auth.js");
			vi.mocked(authModule.exchangeAuthorizationCode).mockClear();
			const manualMethod = plugin.auth.methods[3] as unknown as {
				authorize: () => Promise<{
					validate: (input: string) => string | undefined;
					callback: (input: string) => Promise<{ type: string }>;
				}>;
			};
			const flow = await manualMethod.authorize();

			// When it is validated and submitted
			const validation = flow.validate("abc123#test-state");
			const result = await flow.callback("abc123#test-state");

			// Then it exchanges with this attempt's verifier and redirect URI
			expect(validation).toBeUndefined();
			expect(result.type).toBe("success");
			expect(vi.mocked(authModule.exchangeAuthorizationCode)).toHaveBeenCalledWith(
				"abc123",
				"test-verifier",
				"http://localhost:1455/auth/callback",
			);
		});

		it("manual paste with no code returns invalid_response without calling exchange", async () => {
			const authModule = await import("../lib/auth/auth.js");
			vi.mocked(authModule.exchangeAuthorizationCode).mockClear();
			const manualMethod = plugin.auth.methods[3] as unknown as {
				authorize: () => Promise<{
					validate: (input: string) => string | undefined;
					callback: (input: string) => Promise<{ type: string; reason?: string }>;
				}>;
			};
			const flow = await manualMethod.authorize();
			const stateOnly = "state=test-state";
			expect(flow.validate(stateOnly)).toBeDefined();
			const result = await flow.callback(stateOnly);
			expect(result.type).toBe("failed");
			expect(result.reason).toBe("invalid_response");
			expect(vi.mocked(authModule.exchangeAuthorizationCode)).not.toHaveBeenCalled();
		});
	});

	describe("event handler", () => {
		it("handles account.select event", async () => {
			await plugin.event({ event: { type: "account.select", properties: { index: 0 } } });
		});

		it("handles openai.account.select event", async () => {
			await plugin.event({ event: { type: "openai.account.select", properties: { index: 0 } } });
		});

		it("ignores events with different provider", async () => {
			await plugin.event({
				event: { type: "account.select", properties: { provider: "other", index: 0 } },
			});
		});

		it("handles events without properties", async () => {
			await plugin.event({ event: { type: "unknown.event" } });
		});
	});

	describe("auth loader", () => {
		// The loader caches `accountManagerPromise` before awaiting it. A rejected
		// load therefore parks a rejected promise in that cache, and nothing
		// clears it on failure — so a transient read error (a momentary Windows
		// file lock, a partially-written save) keeps failing every later request
		// until opencode is restarted, long after the cause is gone.
		it("recovers on the next call when a load fails transiently", async () => {
			const accountsModule = await import("../lib/accounts.js");
			const healthyManager = {
				getAccountCount: () => 1,
				getSelectionExplainability: () => null,
				getCurrentOrNextForFamilyHybrid: () => null,
				getAccountForStrategy: () => null,
				getMinWaitTimeForFamily: () => 0,
				hasRefreshToken: () => true,
				saveToDisk: async () => {},
			} as unknown as InstanceType<typeof accountsModule.AccountManager>;

			const spy = vi
				.spyOn(accountsModule.AccountManager, "loadFromDisk")
				.mockRejectedValueOnce(new Error("EBUSY: storage temporarily locked"))
				.mockResolvedValue(healthyManager);

			const getAuth = async () => ({
				type: "oauth" as const,
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});

			await expect(plugin.auth.loader(getAuth, {})).rejects.toThrow();

			// The transient cause is gone; the next load must be attempted again.
			const result = await plugin.auth.loader(getAuth, {});
			expect(result.fetch).toBeDefined();
			expect(spy).toHaveBeenCalledTimes(2);
		});

		it("returns SDK config for non-oauth auth when stored accounts exist", async () => {
			const getAuth = async () => ({ type: "apikey" as const, key: "test" });
			const result = await plugin.auth.loader(getAuth, {});
			expect(result.apiKey).toBeDefined();
			expect(result.baseURL).toBeDefined();
			expect(result.fetch).toBeDefined();
		});

		it("returns SDK config for non-oauth auth when no stored accounts exist", async () => {
			const accountsModule = await import("../lib/accounts.js");
			vi.spyOn(accountsModule.AccountManager, "loadFromDisk").mockResolvedValue({
				getAccountCount: () => 0,
				getSelectionExplainability: () => null,
				getCurrentOrNextForFamilyHybrid: () => null,
				getAccountForStrategy: () => null,
				getMinWaitTimeForFamily: () => 0,
				getAccountsSnapshot: () => [],
				hasRefreshToken: () => false,
				saveToDisk: async () => {},
			} as unknown as InstanceType<typeof accountsModule.AccountManager>);

			const getAuth = async () => ({ type: "apikey" as const, key: "test" });
			const result = await plugin.auth.loader(getAuth, {});
			expect(result.apiKey).toBeDefined();
			expect(result.baseURL).toBeDefined();
			expect(result.fetch).toBeDefined();

			const response = await result.fetch("https://api.openai.com/v1/responses", {
				method: "POST",
				body: "{}",
			});
			expect(response.status).toBe(503);
			const body = await response.text();
			expect(body).toContain("No Codex accounts configured");
		});

		it("returns SDK config for oauth without multiAccount marker", async () => {
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
			});
			const result = await plugin.auth.loader(getAuth, {});
			expect(result.apiKey).toBeDefined();
			expect(result.baseURL).toBeDefined();
			expect(result.fetch).toBeDefined();
		});

		it("returns SDK config for multiAccount oauth", async () => {
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});
			const result = await plugin.auth.loader(getAuth, { options: {}, models: {} });
			expect(result.apiKey).toBeDefined();
			expect(result.baseURL).toBeDefined();
			expect(result.fetch).toBeDefined();
		});

		it("uses OPENAI_BASE_URL for multiAccount OAuth requests", async () => {
			vi.stubEnv("OPENAI_BASE_URL", "https://gateway.example/v1");
			vi.stubEnv("CODEX_AUTH_ALLOW_OPENAI_BASE_URL", "1");
			mockStorage.accounts = [
				{
					accountId: "account-1",
					refreshToken: "refresh-token",
					accessToken: "access-token",
					expiresAt: Date.now() + 60_000,
				},
			];
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});

			const result = await plugin.auth.loader(getAuth, { options: {}, models: {} });

			expect(result.baseURL).toBe("https://gateway.example/v1");
			const logger = await import("../lib/logger.js");
			expect(vi.mocked(logger.logWarn)).toHaveBeenCalledWith(
				"Routing ChatGPT OAuth inference through OPENAI_BASE_URL",
				{ origin: "https://gateway.example" },
			);
			const warningCount = vi.mocked(logger.logWarn).mock.calls.length;
			await plugin.auth.loader(getAuth, { options: {}, models: {} });
			expect(vi.mocked(logger.logWarn)).toHaveBeenCalledTimes(warningCount);
			if (!result.fetch) throw new Error("Expected SDK fetch implementation");
			await result.fetch("https://gateway.example/v1/responses", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
			});
			expect(rewriteUrlForCodexMock).not.toHaveBeenCalled();
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://gateway.example/v1/responses",
				expect.objectContaining({ redirect: "manual" }),
			);
		});

		it("ignores OPENAI_BASE_URL without explicit OAuth gateway consent", async () => {
			vi.stubEnv("OPENAI_BASE_URL", "https://gateway.example/v1");
			mockStorage.accounts = [
				{
					accountId: "account-1",
					refreshToken: "refresh-token",
					accessToken: "access-token",
					expiresAt: Date.now() + 60_000,
				},
			];
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});

			const result = await plugin.auth.loader(getAuth, { options: {}, models: {} });

			expect(result.baseURL).toBe("https://chatgpt.com/backend-api");
			if (!result.fetch) throw new Error("Expected SDK fetch implementation");
			await result.fetch("https://api.openai.com/v1/responses", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
			});
			expect(rewriteUrlForCodexMock).toHaveBeenCalledWith("https://api.openai.com/v1/responses");
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://api.openai.com/v1/responses",
				expect.not.objectContaining({ redirect: "manual" }),
			);
		});

		it("allows a loopback HTTP OAuth gateway", async () => {
			vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:8080/v1/");
			vi.stubEnv("CODEX_AUTH_ALLOW_OPENAI_BASE_URL", "1");
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});

			const result = await plugin.auth.loader(getAuth, { options: {}, models: {} });

			expect(result.baseURL).toBe("http://127.0.0.1:8080/v1");
		});

		it.each([
			"http://127.0.0.2:8080/v1/",
			"http://127.0.1.1:8080/v1/",
			"http://127.255.255.254:8080/v1/",
			"http://[::1]:8080/v1/",
			// IPv4-mapped spellings normalize to hex (`::ffff:7f00:2`), and are
			// just as unroutable as the dotted form.
			"http://[::ffff:127.0.0.1]:8080/v1/",
			"http://[::ffff:127.0.0.2]:8080/v1/",
			"http://[::ffff:127.1.1.1]:8080/v1/",
		])("allows any literal loopback HTTP OAuth gateway: %s", async (baseURL) => {
			vi.stubEnv("OPENAI_BASE_URL", baseURL);
			vi.stubEnv("CODEX_AUTH_ALLOW_OPENAI_BASE_URL", "1");
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});

			const result = await plugin.auth.loader(getAuth, { options: {}, models: {} });

			// WHATWG normalizes IPv6 literals (`::ffff:127.0.0.1` -> `::ffff:7f00:1`),
			// so compare against the normalized form rather than the raw input.
			expect(result.baseURL).toBe(new URL(baseURL).toString().replace(/\/+$/, ""));
		});

		it.each([
			"http://gateway.example/v1",
			"http://localhost:8080/v1",
			// Resolves to a loopback address on most hosts, but a resolver can point
			// it anywhere, so only literal addresses are trusted.
			"http://loopback.example/v1",
			// 126/8 and 128/8 bracket the loopback block; neither is loopback.
			"http://126.255.255.255:8080/v1",
			"http://128.0.0.1:8080/v1",
			// Same brackets in IPv4-mapped form (`::ffff:7eff:ffff` / `::ffff:8000:1`).
			"http://[::ffff:126.255.255.255]:8080/v1",
			"http://[::ffff:128.0.0.1]:8080/v1",
			"https://user:password@gateway.example/v1",
			"https://gateway.example/v1?tenant=one",
			"https://gateway.example/v1?",
			"https://gateway.example/v1#",
			"file:///tmp/gateway",
		])("rejects an unsafe OAuth gateway URL: %s", async (baseURL) => {
			vi.stubEnv("OPENAI_BASE_URL", baseURL);
			vi.stubEnv("CODEX_AUTH_ALLOW_OPENAI_BASE_URL", "1");
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});

			await expect(plugin.auth.loader(getAuth, { options: {}, models: {} })).rejects.toThrow();
		});

		it("reports a scheme-less OPENAI_BASE_URL without echoing the value", async () => {
			// A scheme-less value can carry a token in its query string, and this
			// message reaches a toast, so the value itself must not appear in it.
			vi.stubEnv("OPENAI_BASE_URL", "gateway.example/v1?access_token=secret-value");
			vi.stubEnv("CODEX_AUTH_ALLOW_OPENAI_BASE_URL", "1");
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});

			await expect(plugin.auth.loader(getAuth, { options: {}, models: {} })).rejects.toThrow(
				/\[oc-codex-multi-auth\] OPENAI_BASE_URL is invalid.*not a valid absolute URL/s,
			);
			const toastMessage = vi.mocked(mockClient.tui.showToast).mock.calls
				.map((call) => String((call[0] as { body?: { message?: string } })?.body?.message ?? ""))
				.join("\n");
			expect(toastMessage).toContain("[oc-codex-multi-auth] OPENAI_BASE_URL is invalid");
			expect(toastMessage).not.toContain("secret-value");
			expect(toastMessage).not.toContain("gateway.example");
		});

		it("rejects a redirect from the OAuth gateway instead of following it", async () => {
			vi.stubEnv("OPENAI_BASE_URL", "https://gateway.example/v1");
			vi.stubEnv("CODEX_AUTH_ALLOW_OPENAI_BASE_URL", "1");
			mockStorage.accounts = [
				{
					accountId: "account-1",
					refreshToken: "refresh-token",
					accessToken: "access-token",
					expiresAt: Date.now() + 60_000,
				},
			];
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(null, {
					status: 302,
					headers: { location: "https://evil.example/v1/responses?token=leaked" },
				}),
			);
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});

			const result = await plugin.auth.loader(getAuth, { options: {}, models: {} });
			if (!result.fetch) throw new Error("Expected SDK fetch implementation");
			const response = await result.fetch("https://gateway.example/v1/responses", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
			});

			// The mocked fetch returns a raw 302 regardless of RequestInit, so assert
			// the flag explicitly: without it undici would silently FOLLOW the
			// redirect and replay the OAuth token to the new origin.
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://gateway.example/v1/responses",
				expect.objectContaining({ redirect: "manual" }),
			);
			expect(response.status).toBe(502);
			const payload = await response.json();
			expect(payload.error.message).toContain("302 redirect");
			// Origin only: the full location can carry credentials in its query string.
			expect(payload.error.message).toContain("https://evil.example");
			expect(payload.error.message).not.toContain("token=leaked");
		});
	});

	describe("codex-list tool", () => {
		it("returns message when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-list"].execute();
			expect(result).toContain("No Codex accounts configured");
			expect(result).toContain("opencode auth login");
		});

		it("returns json output for account inventory", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					email: "user1@example.com",
					accountId: "acc-1",
					accountTags: ["work"],
					accountLabel: "Work",
					accountNote: "weekday primary",
				},
			];
			const result = parseJsonOutput<{
				totalAccounts: number;
				activeIndex: number | null;
				accounts: Array<{
					statuses: string[];
					tags: string[];
					note: string | null;
				}>;
			}>(await plugin.tool["codex-list"].execute({ format: "json" }));

			expect(result.totalAccounts).toBe(1);
			expect(result.activeIndex).toBe(1);
			expect(result.accounts[0]).toMatchObject({
				tags: ["work"],
				note: "weekday primary",
			});
			expect(result.accounts[0]).not.toHaveProperty("label");
			expect(result.accounts[0]).not.toHaveProperty("email");
			expect(result.accounts[0]).not.toHaveProperty("accountId");
			expect(result.accounts[0]?.statuses).toContain("active");
		});

		it("includes raw account identifiers only when explicitly requested", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					email: "user1@example.com",
					accountId: "acc-1",
					accountLabel: "Work",
				},
			];
			const result = parseJsonOutput<{
				accounts: Array<{
					label: string;
					email: string | null;
					accountId: string | null;
				}>;
			}>(
				await plugin.tool["codex-list"].execute({
					format: "json",
					includeSensitive: true,
				}),
			);

			expect(result.accounts[0]).toMatchObject({
				label: expect.stringContaining("user1@example.com"),
				email: "user1@example.com",
				accountId: "acc-1",
			});
		});

		it("lists accounts with status", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user1@example.com", accountId: "acc-1" },
				{ refreshToken: "r2", email: "user2@example.com", accountId: "acc-2" },
			];
			const result = await plugin.tool["codex-list"].execute();
			expect(result).toContain("Codex Accounts (2)");
			expect(result).toContain("Account 1");
			expect(result).toContain("Account 2");
		});

		it("shows rate-limited status", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					email: "user@example.com",
					rateLimitResetTimes: { "codex": Date.now() + 60000 },
				},
			];
			const result = await plugin.tool["codex-list"].execute();
			expect(result).toContain("rate-limited");
		});

		it("shows cooldown status", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					email: "user@example.com",
					coolingDownUntil: Date.now() + 60000,
				},
			];
			const result = await plugin.tool["codex-list"].execute();
			expect(result).toContain("cooldown");
		});

		it("filters accounts by tag", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user1@example.com", accountTags: ["work"] },
				{ refreshToken: "r2", email: "user2@example.com", accountTags: ["personal"] },
			];
			const result = await plugin.tool["codex-list"].execute({ tag: "work" });
			expect(result).toContain("user1@example.com");
			expect(result).not.toContain("user2@example.com");
		});
	});

	describe("codex-switch tool", () => {
		it("returns error when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-switch"].execute({ index: 1 });
			expect(result).toContain("No Codex accounts configured");
		});

		it("returns guidance when index is omitted in non-interactive mode", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-switch"].execute();
			expect(result).toContain("Missing account number");
			expect(result).toContain("codex-switch index=2");
		});

		it("returns error for invalid index", async () => {
			mockStorage.accounts = [{ refreshToken: "r1" }];
			const result = await plugin.tool["codex-switch"].execute({ index: 5 });
			expect(result).toContain("Invalid account number");
		});

		it("switches to valid account", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user1@example.com" },
				{ refreshToken: "r2", email: "user2@example.com" },
			];
			const result = await plugin.tool["codex-switch"].execute({ index: 2 });
			expect(result).toContain("Switched to account");
		});

		it("reloads account manager from disk when cached manager exists", async () => {
			const { AccountManager } = await import("../lib/accounts.js");
			const loadFromDiskSpy = vi.spyOn(AccountManager, "loadFromDisk");
			const getAuth = async () => ({
				type: "oauth" as const,
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
				multiAccount: true,
			});

			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user1@example.com" },
				{ refreshToken: "r2", email: "user2@example.com" },
			];

			await plugin.auth.loader(getAuth, { options: {}, models: {} });
			loadFromDiskSpy.mockClear();

			await plugin.tool["codex-switch"].execute({ index: 2 });
			expect(loadFromDiskSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe.each(["codex-list", "codex-status"] as const)("%s quota badges", (toolName) => {
		it.each([
			{ state: "clean", rate: false, quota: false },
			{ state: "transient-only", rate: true, quota: false },
			{ state: "quota-only", rate: false, quota: true },
		])("renders exactly the $state badges", async ({ rate, quota }) => {
			const config = await import("../lib/config.js");
			vi.spyOn(config, "getCodexTuiV2").mockReturnValue(true);
			mockStorage.accounts = [{
				accountId: "acc-1", refreshToken: "refresh-1",
				rateLimitResetTimes: rate ? { codex: Date.now() + 60_000 } : {},
				quotaExhaustedUntil: quota ? Date.now() + 600_000 : undefined,
			}];
			const output = await plugin.tool[toolName].execute();
			const accountLine = output.split("\n").find((line) => line.includes("Account 1") && line.includes(toolName === "codex-list" ? "current" : "active"));
			expect(accountLine).toBeDefined();
			expect(accountLine?.match(/rate-limited/g) ?? []).toHaveLength(rate ? 1 : 0);
			expect(accountLine?.match(/quota-exhausted/g) ?? []).toHaveLength(quota ? 1 : 0);
		});
	});

	describe("codex-status tool", () => {
		it("returns error when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-status"].execute();
			expect(result).toContain("No Codex accounts configured");
		});

		it("shows detailed status for accounts", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user@example.com", lastUsed: Date.now() - 60000 },
			];
			mockStorage.activeIndexByFamily = { codex: 0 };
			const result = await plugin.tool["codex-status"].execute();
			expect(result).toContain("Account Status");
			expect(result).toContain("Active index by model family");
		});

		it("shows the plan in the default output, not only in JSON", async () => {
			// README documents the plan as shown by codex-list AND codex-status.
			// It reached only the JSON payload, so the default view contradicted
			// the documented capability.
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					email: "user@example.com",
					accountId: "acc-1",
					planType: "self_serve_business_prolite",
				},
			];
			mockStorage.activeIndexByFamily = { codex: 0 };
			const result = (await plugin.tool["codex-status"].execute()) as string;
			expect(result).toContain("Business Premium");
			expect(result).not.toContain("self_serve_business_prolite");
		});

		it("returns json output for account status", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user@example.com", accountId: "acc-1" },
			];
			mockStorage.activeIndexByFamily = { codex: 0 };
			const result = parseJsonOutput<{
				totalAccounts: number;
				accounts: Array<{ isActive: boolean }>;
				routingVisibility: {
					selectedAccountIndex: number | null;
					zeroBasedSelectedAccountIndex: number | null;
					selectionExplainability: Array<{ index: number; zeroBasedIndex: number }>;
				};
			}>(await plugin.tool["codex-status"].execute({ format: "json" }));

			expect(result.totalAccounts).toBe(1);
			expect(result.accounts[0]?.isActive).toBe(true);
			expect(result.routingVisibility.selectedAccountIndex).toBe(1);
			expect(result.routingVisibility.zeroBasedSelectedAccountIndex).toBe(0);
			expect(result.routingVisibility.selectionExplainability[0]).toMatchObject({
				index: 1,
				zeroBasedIndex: 0,
			});
		});
	});

	describe("codex-limits tool", () => {
		let originalFetch: typeof globalThis.fetch;

		beforeEach(() => {
			originalFetch = globalThis.fetch;
			mockStorage.activeIndex = 0;
			mockStorage.activeIndexByFamily = {};
		});

		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		it("returns error when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-limits"].execute();
			expect(result).toContain("No Codex accounts configured");
		});

		it("shows live usage windows from wham usage", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					accountId: "acc-1",
					email: "user@example.com",
					accessToken: "access-1",
					expiresAt: Date.now() + 3600_000,
				},
			];
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						plan_type: "team",
						rate_limit: {
							primary_window: {
								used_percent: 13,
								limit_window_seconds: 18000,
								reset_at: Math.floor(Date.now() / 1000) + 3600,
							},
							secondary_window: {
								used_percent: 36,
								limit_window_seconds: 604800,
								reset_at: Math.floor(Date.now() / 1000) + 86400,
							},
						},
						code_review_rate_limit: {
							primary_window: {
								used_percent: 0,
								limit_window_seconds: 604800,
								reset_at: Math.floor(Date.now() / 1000) + 7200,
							},
						},
						credits: { unlimited: true, has_credits: true },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const result = await plugin.tool["codex-limits"].execute();

			expect(result).toContain("Codex limits");
			expect(result).toContain("5h limit: 87% left");
			expect(result).toContain("Weekly limit: 64% left");
			expect(result).toContain("Code review: 100% left");
			// Named, not echoed: the same seat must not read "Business" in
			// codex-list and "team" here.
			expect(result).toContain("Plan: Business");
			expect(result).toContain("Credits: unlimited");
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"https://chatgpt.com/backend-api/wham/usage",
				expect.objectContaining({ method: "GET" }),
			);
		});

		it("blocks a fully spent usage quota before round-robin can spend Credits", async () => {
			const weeklyResetAt = Math.floor(Date.now() / 1000) + 86_400;
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					accountId: "acc-1",
					email: "user@example.com",
					accessToken: "access-1",
					expiresAt: Date.now() + 3600_000,
				},
			];
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						rate_limit: {
							primary_window: {
								used_percent: 4,
								limit_window_seconds: 18000,
								reset_at: Math.floor(Date.now() / 1000) + 3600,
							},
							secondary_window: {
								used_percent: 100,
								limit_window_seconds: 604800,
								reset_at: weeklyResetAt,
							},
						},
						credits: { balance: "483.12" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			await plugin.tool["codex-limits"].execute();

			// The account-wide subscription-quota fact now lands on its own field
			// instead of being forged into a per-family rate-limit block for every
			// model, so a spent weekly quota is not mislabeled as a transient 429.
			expect(mockStorage.accounts[0]?.quotaExhaustedUntil).toBe(weeklyResetAt * 1000);
			expect(mockStorage.accounts[0]?.rateLimitResetTimes ?? {}).toEqual({});
		});

		it("returns json output for usage windows", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					accountId: "acc-1",
					email: "user@example.com",
					accessToken: "access-1",
					expiresAt: Date.now() + 3600_000,
				},
			];
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						plan_type: "team",
						rate_limit: {
							primary_window: {
								used_percent: 13,
								limit_window_seconds: 18000,
								reset_at: Math.floor(Date.now() / 1000) + 3600,
							},
							secondary_window: {
								used_percent: 36,
								limit_window_seconds: 604800,
								reset_at: Math.floor(Date.now() / 1000) + 86400,
							},
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const result = parseJsonOutput<{
				totalAccounts: number;
				accounts: Array<{ planType: string | null; limits: Array<{ name: string }> }>;
			}>(await plugin.tool["codex-limits"].execute({ format: "json" }));

			expect(result.totalAccounts).toBe(1);
			expect(result.accounts[0]?.planType).toBe("team");
			expect(result.accounts[0]?.limits.map((limit) => limit.name)).toContain("5h limit");
		});

		it("refreshes missing tokens before fetching usage", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", accountId: "acc-1", email: "user@example.com" },
			];
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						rate_limit: {
							primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 1800 },
							secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 3600 },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const result = await plugin.tool["codex-limits"].execute();

			expect(result).toContain("100% left");
			expect(mockStorage.accounts[0]?.accessToken).toBe("refreshed-access");
		});

		it("keeps same-token workspace accounts separate and keeps the active marker", async () => {
			const { createCodexHeaders } = await import("../lib/request/fetch-helpers.js");
			mockStorage.accounts = [
				{
					refreshToken: "rt_same",
					accountId: "acc-1",
					organizationId: "org-1",
					email: "a@test.com",
					accessToken: "shared-access",
					expiresAt: Date.now() + 3600_000,
				},
				{
					refreshToken: "rt_same",
					accountId: "acc-2",
					organizationId: "org-2",
					email: "a@test.com",
					accessToken: "shared-access",
					expiresAt: Date.now() + 3600_000,
				},
				{
					refreshToken: "rt_other",
					accountId: "acc-3",
					email: "b@test.com",
					accessToken: "access-3",
					expiresAt: Date.now() + 3600_000,
				},
			];
			mockStorage.activeIndex = 1;
			mockStorage.activeIndexByFamily = { codex: 1 };
			globalThis.fetch = vi.fn().mockImplementation(async () =>
				new Response(
					JSON.stringify({
						rate_limit: {
							primary_window: { used_percent: 50, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 1800 },
							secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 86400 },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
			vi.mocked(createCodexHeaders).mockClear();

			const result = await plugin.tool["codex-limits"].execute();

			expect(result).toContain("3 account");
			expect(globalThis.fetch).toHaveBeenCalledTimes(3);
			expect(result).toContain("Account 1 (a@test.com, id:acc-1):");
			expect(result).toContain("Account 2 (a@test.com, id:acc-2) [active]:");
			expect(result.match(/Account 2 \(a@test\.com, id:acc-2\)/g)).toHaveLength(1);
			expect(result).toContain("Account 3 (b@test.com, id:acc-3):");
			expect(result).not.toContain("Account 2 (a@test.com, id:acc-2):");
			expect(vi.mocked(createCodexHeaders)).toHaveBeenCalledWith(
				undefined,
				"acc-1",
				"shared-access",
				expect.objectContaining({ organizationId: "org-1" }),
			);
			expect(vi.mocked(createCodexHeaders)).toHaveBeenCalledWith(
				undefined,
				"acc-2",
				"shared-access",
				expect.objectContaining({ organizationId: "org-2" }),
			);
		});

		it("keeps the active marker when the active account was deduped out by a re-issued token", async () => {
			// Two entries for the same workspace (acc-1/org-1). Dedupe keeps the
			// freshest (last) occurrence — index 1, carrying the re-issued token.
			// The active index points at the earlier occurrence (index 0), which is
			// deduped out, so the [active] marker must be recovered onto the
			// surviving entry via workspace-identity match, not refresh-token match.
			mockStorage.accounts = [
				{
					refreshToken: "rt_old",
					accountId: "acc-1",
					organizationId: "org-1",
					email: "a@test.com",
					accessToken: "access-old",
					expiresAt: Date.now() + 3600_000,
				},
				{
					refreshToken: "rt_reissued",
					accountId: "acc-1",
					organizationId: "org-1",
					email: "a@test.com",
					accessToken: "access-reissued",
					expiresAt: Date.now() + 3600_000,
				},
			];
			mockStorage.activeIndex = 0;
			mockStorage.activeIndexByFamily = { codex: 0 };
			globalThis.fetch = vi.fn().mockImplementation(async () =>
				new Response(
					JSON.stringify({
						rate_limit: {
							primary_window: { used_percent: 50, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 1800 },
							secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 86400 },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const result = await plugin.tool["codex-limits"].execute();

			// The active occurrence (index 0) was deduped out, but the surviving
			// freshest workspace entry still shows [active] via identity match.
			expect(result).toContain("1 account");
			expect(result).toContain("[active]");
		});

		it("does not deduplicate accounts that are missing refreshToken", async () => {
			mockStorage.activeIndex = 0;
			mockStorage.activeIndexByFamily = {};
			mockStorage.accounts = [
				{
					refreshToken: "",
					accountId: "acc-1",
					email: "missing-1@test.com",
					accessToken: "access-1",
					expiresAt: Date.now() + 3600_000,
				},
				{
					refreshToken: "",
					accountId: "acc-2",
					email: "missing-2@test.com",
					accessToken: "access-2",
					expiresAt: Date.now() + 3600_000,
				},
				{
					refreshToken: "rt_other",
					accountId: "acc-3",
					email: "other@test.com",
					accessToken: "access-3",
					expiresAt: Date.now() + 3600_000,
				},
			];
			globalThis.fetch = vi.fn().mockImplementation(async () =>
				new Response(
					JSON.stringify({
						rate_limit: {
							primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 1800 },
							secondary_window: { used_percent: 25, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 86400 },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const result = await plugin.tool["codex-limits"].execute();

			expect(result).toContain("3 account");
			expect(globalThis.fetch).toHaveBeenCalledTimes(3);
			expect(result).toContain("Account 1 (missing-1@test.com, id:acc-1) [active]:");
			expect(result).toContain("Account 2 (missing-2@test.com, id:acc-2):");
			expect(result).toContain("Account 3 (other@test.com, id:acc-3):");
		});

		it("propagates refreshed credentials to duplicate stored accounts", async () => {
			const { loadAccounts } = await import("../lib/storage.js");
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			const rotatedExpires = Date.now() + 7200_000;
			vi.mocked(queuedRefresh).mockResolvedValueOnce({
				type: "success",
				access: "rotated-access",
				refresh: "rotated-refresh",
				expires: rotatedExpires,
			});
			mockStorage.accounts = [
				{
					refreshToken: "stale-refresh",
					accountId: "acc-1",
					email: "a@test.com",
					accessToken: "expired-access-1",
					expiresAt: Date.now() - 1000,
				},
				{
					refreshToken: "stale-refresh",
					accountId: "acc-2",
					email: "a@test.com",
					accessToken: "expired-access-2",
					expiresAt: Date.now() - 1000,
				},
			];
			globalThis.fetch = vi.fn().mockImplementation(async () =>
				new Response(
					JSON.stringify({
						rate_limit: {
							primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 1800 },
							secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 86400 },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			await plugin.tool["codex-limits"].execute();

			expect(vi.mocked(queuedRefresh)).toHaveBeenCalledTimes(1);
			expect(vi.mocked(queuedRefresh)).toHaveBeenCalledWith("stale-refresh");
			const reloadedStorage = await vi.mocked(loadAccounts)();
			expect(reloadedStorage?.accounts.map((account) => account.refreshToken)).toEqual([
				"rotated-refresh",
				"rotated-refresh",
			]);
			expect(reloadedStorage?.accounts.map((account) => account.accessToken)).toEqual([
				"rotated-access",
				"expired-access-2",
			]);
			expect(reloadedStorage?.accounts.map((account) => account.expiresAt)).toEqual([
				rotatedExpires,
				0,
			]);
		});

		it("updates the current account when transactional refresh fallback matches by identity", async () => {
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			const { loadAccounts, withAccountStorageTransaction } = await import("../lib/storage.js");
			const refreshedExpires = Date.now() + 7200_000;
			vi.mocked(queuedRefresh).mockResolvedValueOnce({
				type: "success",
				access: "single-access",
				refresh: "single-refresh",
				expires: refreshedExpires,
			});
			mockStorage.accounts = [
				{
					refreshToken: "stale-refresh",
					accountId: "acc-1",
					email: "solo@test.com",
					accessToken: "",
					expiresAt: Date.now() - 1000,
				},
			];
			vi.mocked(withAccountStorageTransaction).mockImplementationOnce(
				async (
					handler: (
						current: typeof mockStorage | null,
						persist: (storage: typeof mockStorage) => Promise<void>,
					) => Promise<boolean>,
				) =>
					await handler(
						{
							version: 3,
							accounts: [
								{
									refreshToken: "different-refresh",
									accountId: "acc-1",
									email: "solo@test.com",
								},
							],
							activeIndex: 0,
							activeIndexByFamily: {},
						},
						async (nextStorage) => {
							mockStorage.version = nextStorage.version;
							mockStorage.accounts = nextStorage.accounts.map((account) => structuredClone(account));
							mockStorage.activeIndex = nextStorage.activeIndex;
							mockStorage.activeIndexByFamily = { ...nextStorage.activeIndexByFamily };
						},
					),
			);
			globalThis.fetch = vi.fn().mockImplementation(async () =>
				new Response(
					JSON.stringify({
						rate_limit: {
							primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 1800 },
							secondary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 86400 },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			await plugin.tool["codex-limits"].execute();

			expect(vi.mocked(queuedRefresh)).toHaveBeenCalledWith("different-refresh");
			const reloadedStorage = await vi.mocked(loadAccounts)();
			expect(reloadedStorage?.accounts[0]?.refreshToken).toBe("single-refresh");
			expect(reloadedStorage?.accounts[0]?.accessToken).toBe("single-access");
			expect(reloadedStorage?.accounts[0]?.expiresAt).toBe(refreshedExpires);
		});

		it("updates only the single matching stored account during refresh propagation", async () => {
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			const { loadAccounts } = await import("../lib/storage.js");
			const refreshedExpires = Date.now() + 7200_000;
			vi.mocked(queuedRefresh).mockResolvedValueOnce({
				type: "success",
				access: "matched-access",
				refresh: "matched-refresh",
				expires: refreshedExpires,
			});
			mockStorage.accounts = [
				{
					refreshToken: "single-match",
					accountId: "acc-1",
					email: "match@test.com",
					accessToken: "",
					expiresAt: Date.now() - 1000,
				},
				{
					refreshToken: "other-refresh",
					accountId: "acc-2",
					email: "other@test.com",
					accessToken: "still-valid",
					expiresAt: Date.now() + 3600_000,
				},
			];
			globalThis.fetch = vi.fn().mockImplementation(async () =>
				new Response(
					JSON.stringify({
						rate_limit: {
							primary_window: { used_percent: 15, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 1800 },
							secondary_window: { used_percent: 15, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 86400 },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			await plugin.tool["codex-limits"].execute();

			expect(vi.mocked(queuedRefresh)).toHaveBeenCalledWith("single-match");
			const reloadedStorage = await vi.mocked(loadAccounts)();
			expect(reloadedStorage?.accounts[0]?.refreshToken).toBe("matched-refresh");
			expect(reloadedStorage?.accounts[0]?.accessToken).toBe("matched-access");
			expect(reloadedStorage?.accounts[0]?.expiresAt).toBe(refreshedExpires);
			expect(reloadedStorage?.accounts[1]?.refreshToken).toBe("other-refresh");
			expect(reloadedStorage?.accounts[1]?.accessToken).toBe("still-valid");
		});

		it("fails closed when stable identity no longer exists in authoritative storage", async () => {
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			const { loadAccounts, withAccountStorageTransaction } = await import("../lib/storage.js");
			const transactionStorage = {
				version: 3 as const,
				accounts: [
					{
						refreshToken: "different-refresh",
						accountId: "acc-other",
						organizationId: "org-a",
						email: "user@example.com",
						accessToken: "other-access",
						expiresAt: Date.now() + 3600_000,
					},
					{
						refreshToken: "different-refresh-2",
						accountId: "acc-other-2",
						organizationId: "org-b",
						email: "user@example.com",
						accessToken: "other-access-2",
						expiresAt: Date.now() + 3600_000,
					},
				],
				activeIndex: 0,
				activeIndexByFamily: {},
			};
			vi.mocked(queuedRefresh).mockResolvedValueOnce({
				type: "success",
				access: "orphaned-access",
				refresh: "orphaned-refresh",
				expires: Date.now() + 7200_000,
			});
			vi.mocked(withAccountStorageTransaction).mockImplementationOnce(
				async (
					handler: (
						current: typeof mockStorage | null,
						persist: (storage: typeof mockStorage) => Promise<void>,
					) => Promise<boolean>,
				) =>
					await handler(
						transactionStorage,
						async (nextStorage) => {
							mockStorage.version = nextStorage.version;
							mockStorage.accounts = nextStorage.accounts.map((account) => structuredClone(account));
							mockStorage.activeIndex = nextStorage.activeIndex;
							mockStorage.activeIndexByFamily = { ...nextStorage.activeIndexByFamily };
						},
					),
			);
			mockStorage.accounts = [
				{
					refreshToken: "stale-refresh",
					accountId: "acc-1",
					email: "user@example.com",
					accessToken: "",
					expiresAt: Date.now() - 1000,
				},
			];
			globalThis.fetch = vi.fn().mockImplementation(async () =>
				new Response(
					JSON.stringify({
						rate_limit: {
							primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 1800 },
							secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: Math.floor(Date.now() / 1000) + 86400 },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			await plugin.tool["codex-limits"].execute();

			expect(queuedRefresh).not.toHaveBeenCalled();
			expect(transactionStorage.accounts[0]).toMatchObject({
				accountId: "acc-other",
				refreshToken: "different-refresh",
				accessToken: "other-access",
			});
			expect(transactionStorage.accounts[1]).toMatchObject({
				accountId: "acc-other-2",
				refreshToken: "different-refresh-2",
				accessToken: "other-access-2",
			});
			const reloadedStorage = await vi.mocked(loadAccounts)();
			expect(reloadedStorage?.accounts[0]).toMatchObject({
				accountId: "acc-1",
				refreshToken: "stale-refresh",
				accessToken: "",
			});
		});

		it("reports missing refresh tokens instead of attempting a blank-token refresh", async () => {
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			mockStorage.accounts = [
				{
					refreshToken: "",
					accountId: "acc-1",
					email: "missing-refresh@test.com",
					accessToken: "",
					expiresAt: Date.now() - 1000,
				},
			];

			const result = await plugin.tool["codex-limits"].execute();

			expect(result).toContain("Error: Cannot refresh: account has no refresh token");
			expect(vi.mocked(queuedRefresh)).not.toHaveBeenCalled();
		});

		it("redacts upstream auth material from usage fetch errors", async () => {
			const fakeJwt = `eyJabc.eyJdef.${"sig"}`;
			const fakeOpenAiKey = `sk-${"abcdefghijklmnopqrstuvwx"}`;
			const fakeLiveKey = `sk-live_${"abcd"}.${"efgh"}:${"ijklmnopqrst"}`;
			const fakeHexToken = `${"deadbeef".repeat(5)}`;
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					accountId: "acc-1",
					email: "user@example.com",
					accessToken: "access-1",
					expiresAt: Date.now() + 3600_000,
				},
			];
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					[
						"upstream said Authorization: Bearer secret-token",
						`and jwt ${fakeJwt}`,
						`and ${fakeOpenAiKey}`,
						`and ${fakeLiveKey}`,
						`and ${fakeHexToken}`,
					].join(" "),
					{ status: 401, headers: { "content-type": "text/plain" } },
				),
			);

			const result = await plugin.tool["codex-limits"].execute();

			expect(result).toContain("Error: HTTP 401:");
			expect(result).toContain("Bearer [redacted]");
			expect(result).toContain("[redacted-token]");
			expect(result).not.toContain("secret-token");
			expect(result).not.toContain(fakeJwt);
			expect(result).not.toContain(fakeOpenAiKey);
			expect(result).not.toContain(fakeLiveKey);
			expect(result).not.toContain(fakeHexToken);
		});

		it("surfaces usage fetch timeouts without leaking raw abort errors", async () => {
			vi.useFakeTimers();
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					accountId: "acc-1",
					email: "user@example.com",
					accessToken: "access-1",
					expiresAt: Date.now() + 3600_000,
				},
			];
			try {
				globalThis.fetch = vi.fn().mockImplementation(async (_input, init) => {
					const signal = init?.signal as AbortSignal | undefined;
					return {
						ok: false,
						status: 504,
						headers: new Headers({ "content-type": "text/plain" }),
						text: async () =>
							await new Promise<string>((_resolve, reject) => {
								signal?.addEventListener(
									"abort",
									() => reject(new DOMException("The operation was aborted.", "AbortError")),
									{ once: true },
								);
							}),
					} as Response;
				});

				const resultPromise = plugin.tool["codex-limits"].execute();
				await vi.runAllTimersAsync();
				const result = await resultPromise;

				expect(result).toContain("Error: Usage request timed out");
				expect(result).not.toContain("AbortError");
				expect(result).not.toContain("DOMException");
			} finally {
				vi.useRealTimers();
			}
		});

		it("surfaces usage fetch timeouts before response headers arrive", async () => {
			vi.useFakeTimers();
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					accountId: "acc-1",
					email: "user@example.com",
					accessToken: "access-1",
					expiresAt: Date.now() + 3600_000,
				},
			];
			try {
				globalThis.fetch = vi.fn().mockImplementation(async (_input, init) =>
					await new Promise<Response>((_resolve, reject) => {
						const signal = init?.signal as AbortSignal | undefined;
						signal?.addEventListener(
							"abort",
							() => reject(new DOMException("The operation was aborted.", "AbortError")),
							{ once: true },
						);
					}),
				);

				const resultPromise = plugin.tool["codex-limits"].execute();
				await vi.runAllTimersAsync();
				const result = await resultPromise;

				expect(result).toContain("Error: Usage request timed out");
				expect(result).not.toContain("AbortError");
				expect(result).not.toContain("DOMException");
			} finally {
				vi.useRealTimers();
			}
		});

		it("surfaces usage fetch timeouts during successful response body reads", async () => {
			vi.useFakeTimers();
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					accountId: "acc-1",
					email: "user@example.com",
					accessToken: "access-1",
					expiresAt: Date.now() + 3600_000,
				},
			];
			try {
				globalThis.fetch = vi.fn().mockImplementation(async (_input, init) => {
					const signal = init?.signal as AbortSignal | undefined;
					return {
						ok: true,
						status: 200,
						headers: new Headers({ "content-type": "application/json" }),
						json: async () =>
							await new Promise<unknown>((_resolve, reject) => {
								signal?.addEventListener(
									"abort",
									() => reject(new DOMException("The operation was aborted.", "AbortError")),
									{ once: true },
								);
							}),
					} as Response;
				});

				const resultPromise = plugin.tool["codex-limits"].execute();
				await vi.runAllTimersAsync();
				const result = await resultPromise;

				expect(result).toContain("Error: Usage request timed out");
				expect(result).not.toContain("AbortError");
				expect(result).not.toContain("DOMException");
			} finally {
				vi.useRealTimers();
			}
		});

		it("preserves non-abort text read failures from unsuccessful responses", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					accountId: "acc-1",
					email: "user@example.com",
					accessToken: "access-1",
					expiresAt: Date.now() + 3600_000,
				},
			];
			globalThis.fetch = vi.fn().mockImplementation(async () => ({
				ok: false,
				status: 502,
				headers: new Headers({ "content-type": "text/plain" }),
				text: async () => {
					throw new Error("body read failed");
				},
			} as Response));

			const result = await plugin.tool["codex-limits"].execute();

			expect(result).toContain("Error: body read failed");
			expect(result).not.toContain("Usage request timed out");
		});

		it("preserves non-abort json read failures from successful responses", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					accountId: "acc-1",
					email: "user@example.com",
					accessToken: "access-1",
					expiresAt: Date.now() + 3600_000,
				},
			];
			globalThis.fetch = vi.fn().mockImplementation(async () => ({
				ok: true,
				status: 200,
				headers: new Headers({ "content-type": "application/json" }),
				json: async () => {
					throw new Error("body read failed");
				},
			} as Response));

			const result = await plugin.tool["codex-limits"].execute();

			expect(result).toContain("Error: body read failed");
			expect(result).not.toContain("Usage request timed out");
		});
	});

	describe("codex-metrics tool", () => {
		it("shows runtime metrics", async () => {
			const result = await plugin.tool["codex-metrics"].execute();
			expect(result).toContain("Codex Plugin Metrics");
			expect(result).toContain("Total upstream requests");
		});

		it("returns json output for runtime metrics", async () => {
			const result = parseJsonOutput<{
				totalRequests: number;
				retryProfile: string;
				routingVisibility: {
					fallbackApplied: boolean;
					selectedAccountIndex: number | null;
					zeroBasedSelectedAccountIndex: number | null;
				};
			}>(await plugin.tool["codex-metrics"].execute({ format: "json" }));

			expect(result.totalRequests).toBe(0);
			expect(result.retryProfile).toBe("balanced");
			expect(result.routingVisibility.fallbackApplied).toBe(false);
			expect(result.routingVisibility.selectedAccountIndex).toBeNull();
			expect(result.routingVisibility.zeroBasedSelectedAccountIndex).toBeNull();
		});

		it("rejects unsupported format values", async () => {
			expect(() =>
				plugin.tool["codex-metrics"].execute({ format: "jsno" }),
			).toThrow('Invalid format "jsno". Expected "text" or "json".');
		});
	});

	describe("codex-help tool", () => {
		it("shows the default help overview", async () => {
			const result = await plugin.tool["codex-help"].execute({ topic: "" });
			expect(result).toContain("Codex Help");
			expect(result).toContain("Quickstart");
			expect(result).toContain("codex-doctor");
			expect(result).toContain("codex-setup --wizard");
		});

		it("filters by topic", async () => {
			const result = await plugin.tool["codex-help"].execute({ topic: "backup" });
			expect(result).toContain("Backup and migration");
			expect(result).toContain("codex-export");
		});

		it("matches topics exactly instead of by substring", async () => {
			const result = await plugin.tool["codex-help"].execute({ topic: "s" });
			expect(result).toContain("Unknown topic");
			expect(result).toContain("Available topics");
			expect(result).not.toContain("Quickstart");
			expect(result).not.toContain("Daily account operations");
		});

		it("handles unknown topics", async () => {
			const result = await plugin.tool["codex-help"].execute({ topic: "unknown-topic" });
			expect(result).toContain("Unknown topic");
			expect(result).toContain("Available topics");
		});
	});

	describe("codex-setup tool", () => {
		it("shows checklist with login guidance when no accounts exist", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-setup"].execute();
			expect(result).toContain("Setup Checklist");
			expect(result).toContain("opencode auth login");
			expect(result).toContain("codex-setup --wizard");
		});

		it("shows healthy account progress when account exists", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-setup"].execute();
			expect(result).toContain("Healthy accounts");
			expect(result).toContain("Recommended next step");
		});

		it("falls back to checklist when wizard is requested in non-interactive test environment", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-setup"].execute({ wizard: true });
			expect(result).toContain("Interactive wizard mode is unavailable");
			expect(result).toContain("Showing checklist view instead");
			expect(result).toContain("Setup Checklist");
		});
	});

	describe("codex-doctor tool", () => {
		it("reports diagnostics when no accounts exist", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-doctor"].execute({ deep: false });
			expect(result).toContain("Codex Doctor");
			expect(result).toContain("No accounts are configured");
		});

		it("includes technical snapshot in deep mode", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-doctor"].execute({ deep: true });
			expect(result).toContain("Technical snapshot");
			expect(result).toContain("Storage:");
		});

		it("applies safe auto-fixes when fix mode is enabled", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-doctor"].execute({ fix: true });
			expect(result).toContain("Auto-fix");
			expect(result).toContain("Refreshed");
		});

		it("reports when no eligible account exists for auto-switch during fix mode", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const { AccountManager } = await import("../lib/accounts.js");
			vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue({
				getSelectionExplainability: () => [
					{
						index: 0,
						enabled: true,
						isCurrentForFamily: true,
						eligible: false,
						reasons: ["rate-limited"],
						healthScore: 0,
						tokensAvailable: 0,
						lastUsed: Date.now(),
					},
				],
			} as unknown as InstanceType<typeof AccountManager>);

			const result = await plugin.tool["codex-doctor"].execute({ fix: true });
			expect(result).toContain("Auto-fix");
			expect(result).toContain("No eligible account available for auto-switch");
		});

		it("clears stale auth-failure cooldown and rate-limit markers on fix (issue #171)", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					email: "user@example.com",
					accountId: "org-AAA",
					organizationId: "org-AAA",
					accountIdSource: "org",
					coolingDownUntil: Date.now() + 600_000,
					cooldownReason: "auth-failure",
					rateLimitResetTimes: {
						"gpt-5.4": Date.now() + 3_600_000,
						"gpt-5.4-mini": Date.now() + 3_600_000,
					},
				},
			];

			const result = await plugin.tool["codex-doctor"].execute({ fix: true });

			expect(result).toContain("Cleared cooldown on 1 recovered account(s).");
			expect(result).toContain("Cleared 2 stale rate-limit marker(s).");
			// The recovered account must no longer carry the stale block so rotation
			// can select it again.
			expect(mockStorage.accounts[0]?.coolingDownUntil).toBeUndefined();
			expect(mockStorage.accounts[0]?.cooldownReason).toBeUndefined();
			expect(mockStorage.accounts[0]?.rateLimitResetTimes).toEqual({});
		});


		it("flags a disabled token-source duplicate that shadows an org account (issue #171)", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r-org",
					email: "user@example.com",
					accountId: "org-AAA",
					organizationId: "org-AAA",
					accountIdSource: "org",
					enabled: true,
				},
				{
					refreshToken: "r-token",
					email: "user@example.com",
					accountId: "uuid-fresh-123",
					accountIdSource: "token",
					enabled: false,
				},
			];

			const result = await plugin.tool["codex-doctor"].execute({ deep: false });

			expect(result).toContain("disabled duplicate account entry");
			expect(result).toContain("codex-remove");
		});


		it("does not report cleared stale-state when its persist fails during fix (issue #171)", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r1",
					email: "user@example.com",
					accountId: "org-AAA",
					organizationId: "org-AAA",
					accountIdSource: "org",
					coolingDownUntil: Date.now() + 600_000,
					cooldownReason: "auth-failure",
					rateLimitResetTimes: { "gpt-5.4": Date.now() + 3_600_000 },
				},
			];

			const { withAccountStorageTransaction } = await import("../lib/storage.js");
			const originalTransaction = vi.mocked(withAccountStorageTransaction).getMockImplementation();
			const committingTransaction = async <T>(
				callback: (
					loadedStorage: typeof mockStorage,
					persist: (nextStorage: typeof mockStorage) => Promise<void>,
				) => Promise<T>,
			) => {
				const loadedStorage = cloneMockStorage();
				const persist = async (nextStorage: typeof mockStorage) => {
					mockStorage.version = nextStorage.version;
					mockStorage.accounts = nextStorage.accounts.map(cloneAccount);
					mockStorage.activeIndex = nextStorage.activeIndex;
					mockStorage.activeIndexByFamily = { ...nextStorage.activeIndexByFamily };
				};
				return callback(loadedStorage, persist);
			};
			// A coordinated refresh opens TWO storage transactions: a short probe
			// that reads the authoritative token, then the durable commit. The probe
			// never persists, so the same implementation serves both.
			vi.mocked(withAccountStorageTransaction)
				.mockImplementationOnce(committingTransaction)
				.mockImplementationOnce(committingTransaction);
			vi.mocked(withAccountStorageTransaction).mockImplementationOnce(
				async <T>(
					callback: (
						loadedStorage: typeof mockStorage,
						persist: (nextStorage: typeof mockStorage) => Promise<void>,
					) => Promise<T>,
				) => {
					const loadedStorage = cloneMockStorage();
					const persist = async () => {
						throw new Error("disk full");
					};
					return callback(loadedStorage, persist);
				},
			);
			vi.mocked(withAccountStorageTransaction).mockImplementation(
				originalTransaction,
			);

			const result = await plugin.tool["codex-doctor"].execute({ fix: true });

			// The token credential may have been refreshed before the later stale-state
			// transaction failed, but no "Cleared ..." stale-state fix may be emitted —
			// otherwise the user would believe that repair landed when it did not.
			expect(result).not.toContain("Cleared cooldown");
			expect(result).not.toContain("stale rate-limit marker");
			expect(result).toContain("Failed to persist stale-state repairs");
			expect(mockStorage.accounts[0]?.coolingDownUntil).toBeGreaterThan(Date.now());
			expect(mockStorage.accounts[0]?.rateLimitResetTimes).toEqual({
				"gpt-5.4": expect.any(Number),
			});
		});

		it("surfaces re-login-required when a refresh fails during fix (issue #171)", async () => {
			mockStorage.accounts = [
				{ refreshToken: "dead-token", email: "user@example.com", accountId: "org-AAA", organizationId: "org-AAA", accountIdSource: "org" },
			];
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			vi.mocked(queuedRefresh).mockResolvedValueOnce({
				type: "failed",
				reason: "invalid_grant",
				message: "refresh token expired",
			});

			const result = (await plugin.tool["codex-doctor"].execute({ fix: true })) as string;

			// A failed refresh must not be silent: the user is told to re-login.
			expect(result).toContain("opencode auth login");
			expect(result).toMatch(/need re-login|re-authenticate/i);
		});

		it("never reports every account healthy after all refresh verifications fail", async () => {
			mockStorage.accounts = Array.from({ length: 8 }, (_, index) => ({
				refreshToken: `dead-${index + 1}`,
				email: `user${index + 1}@example.com`,
			}));
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			vi.mocked(queuedRefresh).mockResolvedValue({
				type: "failed",
				reason: "invalid_grant",
				message: "refresh_token_reused",
			});

			const result = (await plugin.tool["codex-doctor"].execute({ fix: true })) as string;

			expect(result).toContain("healthy=0");
			expect(result).not.toContain("healthy=8");
			expect(result).toContain("8 account(s) failed refresh-token verification");
			expect(result).toContain("8 account(s) need re-login");

			vi.mocked(queuedRefresh).mockImplementation(async () => ({
				type: "success" as const,
				access: "refreshed-access",
				refresh: "refreshed-refresh",
				expires: Date.now() + 3_600_000,
			}));
		});

		it("keeps successful accounts healthy and recommends re-login after mixed verification results", async () => {
			mockStorage.accounts = [
				{ refreshToken: "alive-token", email: "alive@example.com" },
				{ refreshToken: "dead-token", email: "dead@example.com" },
			];
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			vi.mocked(queuedRefresh).mockImplementation(async (token: string) =>
				token === "alive-token"
					? {
							type: "success" as const,
							access: "alive-access",
							refresh: "alive-refresh",
							expires: Date.now() + 3_600_000,
						}
					: {
							type: "failed" as const,
							reason: "invalid_grant",
							message: "refresh token expired",
						},
			);

			const result = parseJsonOutput<{
				summary: { healthyAccounts: number; blockedAccounts: number };
				findings: Array<{ summary: string }>;
				recommendedNextAction: string;
			}>(await plugin.tool["codex-doctor"].execute({ fix: true, format: "json" }));
			vi.mocked(queuedRefresh).mockImplementation(async () => ({
				type: "success" as const,
				access: "refreshed-access",
				refresh: "refreshed-refresh",
				expires: Date.now() + 3_600_000,
			}));

			expect(result.summary).toMatchObject({ healthyAccounts: 1, blockedAccounts: 1 });
			expect(result.findings.some((finding) =>
				finding.summary.includes("failed refresh-token verification"),
			)).toBe(true);
			expect(result.recommendedNextAction).toContain("opencode auth login");
		});

		it("re-resolves the selected account identity before auto-switching after storage reorder", async () => {
			mockStorage.accounts = [
				{
					organizationId: "org-current",
					accountId: "current",
					refreshToken: "current-token",
				},
				{
					organizationId: "org-best",
					accountId: "best",
					refreshToken: "best-token",
				},
			];
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			vi.mocked(queuedRefresh).mockImplementation(async () => ({
				type: "success" as const,
				access: "refreshed-access",
				refresh: "refreshed-refresh",
				expires: Date.now() + 3_600_000,
			}));
			const { AccountManager } = await import("../lib/accounts.js");
			vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue({
				getSelectionExplainability: () => [
					{
						index: 0,
						enabled: true,
						isCurrentForFamily: true,
						eligible: true,
						reasons: [],
						healthScore: 1,
						tokensAvailable: 1,
						lastUsed: 1,
					},
					{
						index: 1,
						enabled: true,
						isCurrentForFamily: false,
						eligible: true,
						reasons: [],
						healthScore: 2,
						tokensAvailable: 2,
						lastUsed: 2,
					},
				],
				getAccountsSnapshot: () => mockStorage.accounts.map((account) => ({
					...account,
					addedAt: account.addedAt ?? 0,
					lastUsed: account.lastUsed ?? 0,
					rateLimitResetTimes: account.rateLimitResetTimes ?? {},
				})),
			} as unknown as InstanceType<typeof AccountManager>);
			const { withAccountStorageTransaction } = await import("../lib/storage.js");
			const originalTransaction = vi.mocked(withAccountStorageTransaction).getMockImplementation();
			let transactionCount = 0;
			vi.mocked(withAccountStorageTransaction).mockImplementation(
				async (callback) => {
					transactionCount += 1;
					// Two coordinated refreshes (a probe plus a commit each) and one
					// stale-state clear precede the auto-switch persist, so transaction
					// 6 must resolve identity against the reordered storage snapshot.
					if (transactionCount !== 6) {
						return originalTransaction!(callback);
					}
					const reorderedStorage = {
						...cloneMockStorage(),
						accounts: [
							{ refreshToken: "inserted-token" },
							...cloneMockStorage().accounts,
						],
					};
					return callback(reorderedStorage, async (nextStorage) => {
						mockStorage.accounts = nextStorage.accounts.map(cloneAccount);
						mockStorage.activeIndex = nextStorage.activeIndex;
						mockStorage.activeIndexByFamily = { ...nextStorage.activeIndexByFamily };
					});
				},
			);

			await plugin.tool["codex-doctor"].execute({ fix: true });

			expect(mockStorage.accounts[mockStorage.activeIndex]?.accountId).toBe("best");
			expect(mockStorage.activeIndex).toBe(2);
			expect(transactionCount).toBe(6);
			vi.mocked(withAccountStorageTransaction).mockImplementation(originalTransaction);
		});

		it("persists rotated tokens transactionally during fix and preserves concurrent state", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "old-refresh",
					email: "user@example.com",
					coolingDownUntil: Date.now() + 600_000,
					cooldownReason: "auth-failure",
					rateLimitResetTimes: { "gpt-5.4": Date.now() + 3_600_000 },
				},
			];
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			vi.mocked(queuedRefresh).mockResolvedValueOnce({
				type: "success" as const,
				access: "rotated-access",
				refresh: "rotated-refresh",
				expires: Date.now() + 3_600_000,
			});
			const { withAccountStorageTransaction } = await import("../lib/storage.js");
			const originalTransaction = vi.mocked(withAccountStorageTransaction).getMockImplementation();
			const persistSnapshot = async (nextStorage: typeof mockStorage) => {
				mockStorage.version = nextStorage.version;
				mockStorage.accounts = nextStorage.accounts.map(cloneAccount);
				mockStorage.activeIndex = nextStorage.activeIndex;
				mockStorage.activeIndexByFamily = { ...nextStorage.activeIndexByFamily };
			};
			// Credential probe + credential commit: a coordinated refresh reads the
			// authoritative token in a short transaction before exchanging, then
			// commits in a second one. Both see a fresh snapshot carrying a
			// concurrent rate-limit update, but no concurrent cooldown.
			const concurrentTransaction = async <T>(
				callback: (
					loadedStorage: typeof mockStorage,
					persist: (nextStorage: typeof mockStorage) => Promise<void>,
				) => Promise<T>,
			) => {
				const loadedStorage = cloneMockStorage();
				loadedStorage.accounts[0]!.rateLimitResetTimes = {
					"gpt-5.4-mini": Date.now() + 1_800_000,
				};
				delete loadedStorage.accounts[0]!.coolingDownUntil;
				delete loadedStorage.accounts[0]!.cooldownReason;
				return callback(loadedStorage, persistSnapshot);
			};
			vi.mocked(withAccountStorageTransaction)
				.mockImplementationOnce(concurrentTransaction)
				.mockImplementationOnce(concurrentTransaction);
			vi.mocked(withAccountStorageTransaction).mockImplementation(
				originalTransaction,
			);

			const result = (await plugin.tool["codex-doctor"].execute({ fix: true })) as string;

			expect(result).toContain("Refreshed and persisted 1 account token(s)");
			expect(mockStorage.accounts[0]?.refreshToken).toBe("rotated-refresh");
			expect(mockStorage.accounts[0]?.accessToken).toBe("rotated-access");
			expect(mockStorage.accounts[0]?.tokenRotatedAt).toBeGreaterThan(0);
			// The stale repair starts from the post-credential snapshot, so it can
			// clear the original cooldown while retaining the newer rate-limit
			// marker. The absent concurrent cooldown was a concurrent recovery and
			// remains cleared.
			expect(mockStorage.accounts[0]?.rateLimitResetTimes).toEqual({
				"gpt-5.4-mini": expect.any(Number),
			});
			expect(mockStorage.accounts[0]?.coolingDownUntil).toBeUndefined();
		});

		it("recovers the reporter's exact composite 3-account pool on fix (issue #171)", async () => {
			// Mirrors comment 4748562388: slot 0 org+auth-failure cooldown, slot 1 org
			// with stale gpt-5.4 / gpt-5.4-mini rate-limits, slot 2 disabled token dup.
			mockStorage.accounts = [
				{
					refreshToken: "r-a",
					email: "user@example.com",
					accountId: "org-AAA",
					organizationId: "org-AAA",
					accountIdSource: "org",
					enabled: true,
					coolingDownUntil: Date.now() + 600_000,
					cooldownReason: "auth-failure",
				},
				{
					refreshToken: "r-b",
					email: "two@example.com",
					accountId: "org-BBB",
					organizationId: "org-BBB",
					accountIdSource: "org",
					enabled: true,
					rateLimitResetTimes: {
						"gpt-5.4": Date.now() + 3_600_000,
						"gpt-5.4-mini": Date.now() + 3_600_000,
					},
				},
				{
					refreshToken: "r-dup",
					email: "user@example.com",
					accountId: "uuid-fresh",
					accountIdSource: "token",
					enabled: false,
				},
			];

			const result = (await plugin.tool["codex-doctor"].execute({ fix: true })) as string;

			// Stale cooldown + both rate-limit markers cleared on the two alive accounts.
			expect(result).toContain("Cleared cooldown on 1 recovered account(s).");
			expect(result).toContain("Cleared 2 stale rate-limit marker(s).");
			expect(mockStorage.accounts[0]?.coolingDownUntil).toBeUndefined();
			expect(mockStorage.accounts[1]?.rateLimitResetTimes).toEqual({});
			// The disabled token-source duplicate (slot 3) is surfaced, not removed.
			expect(result).toContain("disabled duplicate account entry");
			expect(mockStorage.accounts).toHaveLength(3);
			expect(mockStorage.accounts[2]?.enabled).toBe(false);
		});

		it("returns json output for deep diagnostics", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = parseJsonOutput<{
				summary: { totalAccounts: number };
				technicalSnapshot: { storagePath: string; routingVisibility: { selectionExplainability: unknown[] } } | null;
			}>(await plugin.tool["codex-doctor"].execute({ deep: true, format: "json" }));

			expect(result.summary.totalAccounts).toBe(1);
			expect(result.technicalSnapshot?.storagePath).toBe("/mock/path/accounts.json");
			expect(result.technicalSnapshot?.routingVisibility.selectionExplainability).toBeDefined();
		});
	});

	describe("codex-next tool", () => {
		it("recommends login when no accounts exist", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-next"].execute();
			expect(result).toContain("opencode auth login");
		});

		it("recommends dashboard for healthy setup", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-next"].execute();
			expect(result).toContain("codex-dashboard");
		});

		it("returns json output for the recommended next action", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = parseJsonOutput<{
				recommendedNextAction: string;
				totalAccounts: number;
				activeIndex: number | null;
			}>(await plugin.tool["codex-next"].execute({ format: "json" }));

			expect(result.totalAccounts).toBe(1);
			expect(result.activeIndex).toBe(1);
			expect(result.recommendedNextAction).toContain("codex-dashboard");
		});
	});

	describe("codex-dashboard tool", () => {
		it("returns json output for dashboard visibility", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = parseJsonOutput<{
				accountCount: number;
				selectionLens: string;
				accountEligibility: Array<{ eligible: boolean }>;
				routingVisibility: { selectionExplainability: unknown[] };
			}>(await plugin.tool["codex-dashboard"].execute({ format: "json" }));

			expect(result.accountCount).toBe(1);
			expect(result.selectionLens).toBe("codex");
			expect(result.accountEligibility[0]?.eligible).toBe(true);
			expect(result.routingVisibility.selectionExplainability).toHaveLength(1);
		});
	});

	describe("codex-label tool", () => {
		it("returns error when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-label"].execute({ index: 1, label: "Work" });
			expect(result).toContain("No Codex accounts configured");
		});

		it("returns guidance when index is omitted in non-interactive mode", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-label"].execute({ label: "Work" });
			expect(result).toContain("Missing account number");
			expect(result).toContain("codex-label index=2 label=\"Work\"");
		});

		it("returns error for invalid account index", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-label"].execute({ index: 9, label: "Work" });
			expect(result).toContain("Invalid account number");
		});

		it("sets a label on the selected account", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-label"].execute({ index: 1, label: "Work Laptop" });
			expect(result).toContain("Set label");
			expect(mockStorage.accounts[0]?.accountLabel).toBe("Work Laptop");
		});

		it("clears a label when blank input is provided", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user@example.com", accountLabel: "Personal" },
			];
			const result = await plugin.tool["codex-label"].execute({ index: 1, label: "   " });
			expect(result).toContain("Cleared label");
			expect(mockStorage.accounts[0]?.accountLabel).toBeUndefined();
		});
	});

	describe("codex-tag tool", () => {
		it("sets tags for an account", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-tag"].execute({ index: 1, tags: "work, team-a" });
			expect(result).toContain("Updated tags");
			expect(mockStorage.accounts[0]?.accountTags).toEqual(["work", "team-a"]);
		});

		it("returns guidance when index is omitted in non-interactive mode", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-tag"].execute({ tags: "work" });
			expect(result).toContain("Missing account number");
			expect(result).toContain("codex-tag index=2 tags=\"work,team-a\"");
		});
	});

	describe("codex-note tool", () => {
		it("sets and clears account note", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const setResult = await plugin.tool["codex-note"].execute({ index: 1, note: "Primary laptop" });
			expect(setResult).toContain("Saved note");
			expect(mockStorage.accounts[0]?.accountNote).toBe("Primary laptop");
			const clearResult = await plugin.tool["codex-note"].execute({ index: 1, note: " " });
			expect(clearResult).toContain("Cleared note");
			expect(mockStorage.accounts[0]?.accountNote).toBeUndefined();
		});

		it("returns guidance when index is omitted in non-interactive mode", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-note"].execute({ note: "Primary" });
			expect(result).toContain("Missing account number");
			expect(result).toContain("codex-note index=2 note=\"weekday primary\"");
		});
	});

	describe("codex-health tool", () => {
		it("returns error when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-health"].execute();
			expect(result).toContain("No Codex accounts configured");
		});

		it("checks health of accounts", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user@example.com" },
			];
			const result = await plugin.tool["codex-health"].execute();
			expect(result).toContain("Health Check");
			expect(result).toContain("Healthy");

			// Deterministic per-token rotations keep the shared credential tests
			// independent of this test's rotated mock storage.
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			vi.mocked(queuedRefresh).mockImplementation(async (token: string) => ({
				type: "success" as const,
				access: `${token}-access`,
				refresh: `${token}-new`,
				expires: Date.now() + 3_600_000,
			}));
		});

		it("persists rotated tokens so a restart does not report refresh_token_reused", async () => {
			mockStorage.accounts = [
				{ refreshToken: "old-r1", email: "one@example.com" },
				{ refreshToken: "old-r2", email: "two@example.com" },
			];
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			vi.mocked(queuedRefresh).mockImplementation(async (token: string) => ({
				type: "success" as const,
				access: `${token}-access`,
				refresh: `${token}-new`,
				expires: Date.now() + 3_600_000,
			}));

			const first = await plugin.tool["codex-health"].execute();
			expect(first).toContain("2 healthy, 0 unhealthy");
			expect(mockStorage.accounts.map((account) => account.refreshToken)).toEqual([
				"old-r1-new",
				"old-r2-new",
			]);
			expect(mockStorage.accounts[0]?.tokenRotatedAt).toBeGreaterThan(0);
			expect(mockStorage.accounts[1]?.tokenRotatedAt).toBeGreaterThan(0);

			// A restart loads the persisted tokens. Verification rotates them again;
			// the previous regression left `old-*` on disk, producing refresh_token_reused.
			const second = await plugin.tool["codex-health"].execute();
			expect(second).toContain("2 healthy, 0 unhealthy");
			expect(mockStorage.accounts.map((account) => account.refreshToken)).toEqual([
				"old-r1-new-new",
				"old-r2-new-new",
			]);
		});

		it("propagates a shared rotated token to workspace sibling records", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "shared-old",
					email: "one@example.com",
					organizationId: "org-A",
					accountId: "org-A",
					accountIdSource: "org",
					expiresAt: Date.now() + 3_600_000,
				},
				{
					refreshToken: "shared-old",
					email: "two@example.com",
					organizationId: "org-B",
					accountId: "org-B",
					accountIdSource: "org",
					expiresAt: Date.now() + 3_600_000,
				},
			];
			const { queuedRefresh } = await import("../lib/refresh-queue.js");
			vi.mocked(queuedRefresh)
				.mockResolvedValueOnce({
					type: "success" as const,
					access: "workspace-a-access",
					refresh: "shared-new",
					expires: Date.now() + 3_600_000,
				})
				.mockResolvedValueOnce({
					type: "success" as const,
					access: "workspace-b-access",
					refresh: "shared-new",
					expires: Date.now() + 3_600_000,
				});

			const result = await plugin.tool["codex-health"].execute();

			expect(result).toContain("2 healthy, 0 unhealthy");
			expect(queuedRefresh).toHaveBeenCalledTimes(2);
			expect(mockStorage.accounts[0]?.refreshToken).toBe("shared-new");
			expect(mockStorage.accounts[0]?.accessToken).toBe("workspace-a-access");
			expect(mockStorage.accounts[1]?.refreshToken).toBe("shared-new");
			expect(mockStorage.accounts[1]?.accessToken).toBe("workspace-b-access");
			expect(mockStorage.accounts[1]?.expiresAt).toBeGreaterThan(Date.now());
		});

		it("skips an independently disabled account without consuming its token", async () => {
			mockStorage.accounts = [
				{ refreshToken: "active-old", email: "active@example.com" },
				{ refreshToken: "disabled-old", email: "disabled@example.com", enabled: false },
			];
			const { queuedRefresh } = await import("../lib/refresh-queue.js");

			const result = parseJsonOutput<{
				healthyCount: number;
				unhealthyCount: number;
				skippedCount: number;
				accounts: Array<{ status: string }>;
			}>(await plugin.tool["codex-health"].execute({ format: "json" }));

			expect(queuedRefresh).toHaveBeenCalledTimes(1);
			expect(queuedRefresh).toHaveBeenCalledWith("active-old");
			expect(result.healthyCount).toBe(1);
			expect(result.unhealthyCount).toBe(0);
			expect(result.skippedCount).toBe(1);
			expect(result.accounts[1]?.status).toBe("skipped");
			expect(mockStorage.accounts[1]?.refreshToken).toBe("disabled-old");
		});

		it("reports persistence failure instead of healthy when a rotated token cannot be saved", async () => {
			mockStorage.accounts = [
				{ refreshToken: "old-r1", email: "one@example.com" },
			];
			const { withAccountStorageTransaction } = await import("../lib/storage.js");
			// Probe + commit: only the commit persists, so the failing persist has to
			// be in place for both calls of the coordinated refresh.
			const failingTransaction = async <T>(
				callback: (
					loadedStorage: typeof mockStorage,
					persist: (nextStorage: typeof mockStorage) => Promise<void>,
				) => Promise<T>,
			) => {
				const loadedStorage = cloneMockStorage();
				const persist = async () => {
					throw new Error("disk full");
				};
				return callback(loadedStorage, persist);
			};
			vi.mocked(withAccountStorageTransaction)
				.mockImplementationOnce(failingTransaction)
				.mockImplementationOnce(failingTransaction);

			const result = parseJsonOutput<{
				healthyCount: number;
				unhealthyCount: number;
				accounts: Array<{ status: string; error?: string }>;
			}>(await plugin.tool["codex-health"].execute({ format: "json" }));

			expect(result.healthyCount).toBe(0);
			expect(result.unhealthyCount).toBe(1);
			expect(result.accounts[0]?.status).toBe("unhealthy");
			expect(result.accounts[0]?.error).toContain("disk full");
			expect(mockStorage.accounts[0]?.refreshToken).toBe("old-r1");
		});

		it("surfaces stale-state and duplicate findings (issue #171)", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r-org",
					email: "user@example.com",
					accountId: "org-AAA",
					organizationId: "org-AAA",
					accountIdSource: "org",
					enabled: true,
					coolingDownUntil: Date.now() + 600_000,
					cooldownReason: "auth-failure",
				},
				{
					refreshToken: "r-token",
					email: "user@example.com",
					accountId: "uuid-fresh",
					accountIdSource: "token",
					enabled: false,
				},
			];
			const result = (await plugin.tool["codex-health"].execute()) as string;
			expect(result).toContain("Stale state:");
			expect(result).toContain("codex-doctor --fix");
			expect(result).toContain("disabled duplicate entry");
			expect(result).toContain("codex-remove");
		});

		it("returns json output for health checks", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = parseJsonOutput<{
				totalAccounts: number;
				healthyCount: number;
				unhealthyCount: number;
				accounts: Array<{ status: string }>;
				staleRecoverableSlots: number[];
				disabledDuplicateSlots: number[];
			}>(await plugin.tool["codex-health"].execute({ format: "json" }));

			expect(result.totalAccounts).toBe(1);
			expect(result.healthyCount).toBe(1);
			expect(result.unhealthyCount).toBe(0);
			expect(result.accounts[0]?.status).toBe("healthy");
			expect(Array.isArray(result.staleRecoverableSlots)).toBe(true);
			expect(Array.isArray(result.disabledDuplicateSlots)).toBe(true);
		});

		it("reports populated stale/duplicate slots in JSON when present (issue #171)", async () => {
			mockStorage.accounts = [
				{
					refreshToken: "r-org",
					email: "user@example.com",
					accountId: "org-AAA",
					organizationId: "org-AAA",
					accountIdSource: "org",
					enabled: true,
					coolingDownUntil: Date.now() + 600_000,
					cooldownReason: "auth-failure",
				},
				{
					refreshToken: "r-token",
					email: "user@example.com",
					accountId: "uuid-fresh",
					accountIdSource: "token",
					enabled: false,
				},
			];
			const result = parseJsonOutput<{
				staleRecoverableSlots: number[];
				disabledDuplicateSlots: number[];
			}>(await plugin.tool["codex-health"].execute({ format: "json" }));
			// slot 1 is blocked by a stale cooldown; slot 2 is the disabled token dup.
			expect(result.staleRecoverableSlots).toContain(1);
			expect(result.disabledDuplicateSlots).toContain(2);
		});
	});

	describe("codex-remove tool", () => {
		it("returns error when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-remove"].execute({ index: 1, confirm: true });
			expect(result).toContain("No Codex accounts configured");
		});

		it("returns guidance when index is omitted in non-interactive mode", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-remove"].execute({ confirm: true });
			expect(result).toContain("Missing account number");
			expect(result).toContain("codex-remove index=2 confirm=true");
		});

		it("returns error for invalid index", async () => {
			mockStorage.accounts = [{ refreshToken: "r1" }];
			const result = await plugin.tool["codex-remove"].execute({ index: 5, confirm: true });
			expect(result).toContain("Invalid account number");
		});

		it("removes valid account", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user1@example.com" },
				{ refreshToken: "r2", email: "user2@example.com" },
			];
			const result = await plugin.tool["codex-remove"].execute({ index: 1, confirm: true });
			expect(result).toContain("Removed");
			expect(mockStorage.accounts).toHaveLength(1);
		});

		it("handles removal of last account", async () => {
			mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];
			const result = await plugin.tool["codex-remove"].execute({ index: 1, confirm: true });
			expect(result).toContain("Removed");
			expect(result).toContain("No accounts remaining");
		});

		it("refuses to remove without confirm=true (destructive-default guard)", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user1@example.com" },
				{ refreshToken: "r2", email: "user2@example.com" },
			];
			// No args at all: no account touched.
			const noArgsResult = await plugin.tool["codex-remove"].execute();
			expect(noArgsResult).toContain("confirm=true");
			expect(mockStorage.accounts).toHaveLength(2);

			// Explicit confirm=false: still no-op.
			const falseConfirmResult = await plugin.tool["codex-remove"].execute({
				index: 1,
				confirm: false,
			});
			expect(falseConfirmResult).toContain("confirm=true");
			expect(mockStorage.accounts).toHaveLength(2);

			// Valid index but no confirm: still no-op.
			const missingConfirmResult = await plugin.tool["codex-remove"].execute({ index: 1 });
			expect(missingConfirmResult).toContain("confirm=true");
			expect(mockStorage.accounts).toHaveLength(2);

			// Finally, pass confirm=true and verify removal proceeds.
			const confirmedResult = await plugin.tool["codex-remove"].execute({
				index: 1,
				confirm: true,
			});
			expect(confirmedResult).toContain("Removed");
			expect(mockStorage.accounts).toHaveLength(1);
		});
	});

	describe("codex-refresh tool", () => {
		it("returns error when no accounts", async () => {
			mockStorage.accounts = [];
			const result = await plugin.tool["codex-refresh"].execute();
			expect(result).toContain("No Codex accounts configured");
		});

		it("refreshes accounts", async () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "user@example.com" },
			];
			const result = await plugin.tool["codex-refresh"].execute();
			expect(result).toContain("Refreshing");
			expect(result).toContain("Refreshed");
		});
	});

	describe("codex-export tool", () => {
		it("exports accounts to file", async () => {
			mockStorage.accounts = [{ refreshToken: "r1" }];
			const storageModule = await import("../lib/storage.js");
			const result = await plugin.tool["codex-export"].execute({
				path: "/tmp/backup.json",
			});
			expect(result).toContain("Exported");
			expect(storageModule.exportAccounts).toHaveBeenCalledWith("/tmp/backup.json", false);
		});

		it("exports to timestamped path when path is omitted", async () => {
			mockStorage.accounts = [{ refreshToken: "r1" }];
			const storageModule = await import("../lib/storage.js");
			const result = await plugin.tool["codex-export"].execute({});
			expect(result).toContain("Exported");
			expect(result).toContain("codex-backup");
			expect(storageModule.createTimestampedBackupPath).toHaveBeenCalledWith();
			expect(storageModule.exportAccounts).toHaveBeenCalledWith(
				"/tmp/codex-backup-20260101-000000.json",
				false,
			);
		});

		it("uses non-timestamped default path when timestamped=false", async () => {
			mockStorage.accounts = [{ refreshToken: "r1" }];
			const storageModule = await import("../lib/storage.js");
			const result = await plugin.tool["codex-export"].execute({ timestamped: false });
			expect(result).toContain("codex-backup.json");
			expect(storageModule.createTimestampedBackupPath).not.toHaveBeenCalled();
			expect(storageModule.exportAccounts).toHaveBeenCalledWith("codex-backup.json", false);
		});

		it("passes explicit force=true when the caller opts into overwrite", async () => {
			mockStorage.accounts = [{ refreshToken: "r1" }];
			const storageModule = await import("../lib/storage.js");
			const result = await plugin.tool["codex-export"].execute({
				path: "/tmp/backup.json",
				force: true,
			});
			expect(result).toContain("Exported");
			expect(storageModule.exportAccounts).toHaveBeenCalledWith("/tmp/backup.json", true);
		});
	});

	describe("codex-import tool", () => {
		it("imports accounts from file", async () => {
			const storageModule = await import("../lib/storage.js");
			const result = await plugin.tool["codex-import"].execute({
				path: "/tmp/backup.json",
			});
			expect(result).toContain("Import complete");
			expect(result).toContain("New accounts: 2");
			expect(result).toContain(
				"Auto-backup: /tmp/codex-pre-import-backup-20260101-000000000-deadbe.json",
			);
			expect(storageModule.importAccounts).toHaveBeenCalledWith("/tmp/backup.json", {
				preImportBackupPrefix: "codex-pre-import-backup",
				backupMode: "required",
			});
		});

		it("supports dry-run preview mode", async () => {
			const storageModule = await import("../lib/storage.js");
			const result = await plugin.tool["codex-import"].execute({
				path: "/tmp/backup.json",
				dryRun: true,
			});
			expect(result).toContain("Import preview");
			expect(storageModule.previewImportAccounts).toHaveBeenCalledWith("/tmp/backup.json");
			expect(storageModule.importAccounts).not.toHaveBeenCalled();
			expect(storageModule.exportAccounts).not.toHaveBeenCalled();
			expect(storageModule.createTimestampedBackupPath).not.toHaveBeenCalled();
		});

		it("skips pre-import backup when no accounts exist yet", async () => {
			mockStorage.accounts = [];
			const storageModule = await import("../lib/storage.js");
			vi.mocked(storageModule.importAccounts).mockResolvedValueOnce({
				imported: 2,
				skipped: 1,
				total: 5,
				backupStatus: "skipped",
			});

			const result = await plugin.tool["codex-import"].execute({
				path: "/tmp/backup.json",
			});
			expect(result).toContain("Import complete");
			expect(result).toContain("Auto-backup: skipped");
			expect(storageModule.exportAccounts).not.toHaveBeenCalled();
			expect(storageModule.importAccounts).toHaveBeenCalledWith("/tmp/backup.json", {
				preImportBackupPrefix: "codex-pre-import-backup",
				backupMode: "required",
			});
		});

		it("fails import when required pre-import backup cannot be created", async () => {
			mockStorage.accounts = [{ refreshToken: "r1" }];
			const storageModule = await import("../lib/storage.js");
			vi.mocked(storageModule.importAccounts).mockRejectedValueOnce(
				new Error("Pre-import backup failed: backup locked by antivirus"),
			);

			const result = await plugin.tool["codex-import"].execute({
				path: "/tmp/backup.json",
			});

			expect(result).toContain("Import failed");
			expect(result).toContain("Pre-import backup failed");
		});

		it("delegates backup+apply sequencing to storage import to avoid race windows", async () => {
			mockStorage.accounts = [{ refreshToken: "s1" }];
			const storageModule = await import("../lib/storage.js");
			const observedSnapshots: string[] = [];
			vi.mocked(storageModule.importAccounts).mockImplementationOnce(
				async (_path, _options) => {
					observedSnapshots.push(
						mockStorage.accounts.map((account) => account.refreshToken).join(","),
					);
					mockStorage.accounts = [{ refreshToken: "s2" }];
					observedSnapshots.push(
						mockStorage.accounts.map((account) => account.refreshToken).join(","),
					);
					return {
						imported: 1,
						skipped: 0,
						total: 1,
						backupStatus: "created",
						backupPath:
							"/tmp/codex-pre-import-backup-20260101-000000000-deadbe.json",
					};
				},
			);

			const result = await plugin.tool["codex-import"].execute({
				path: "/tmp/backup.json",
			});

			expect(result).toContain("Import complete");
			expect(result).toContain(
				"Auto-backup: /tmp/codex-pre-import-backup-20260101-000000000-deadbe.json",
			);
			expect(storageModule.exportAccounts).not.toHaveBeenCalled();
			expect(storageModule.importAccounts).toHaveBeenCalledWith("/tmp/backup.json", {
				preImportBackupPrefix: "codex-pre-import-backup",
				backupMode: "required",
			});
			expect(observedSnapshots).toEqual(["s1", "s2"]);
		});
	});

	// Regression suite for #163: when `maskEmail` is enabled, no human-facing
	// account-display surface may render a raw email. These drive the REAL
	// plugin tools (and thus the real `formatCommandAccountLabel` closure), so a
	// regression that drops `{ maskEmail }` at any call site fails here.
	describe("issue #163: email masking across all display surfaces", () => {
		const RAW_EMAIL = "alice.example@example.com";
		const MASKED_EMAIL = "al***@example.com";

		const enableMasking = async () => {
			const configModule = await import("../lib/config.js");
			vi.mocked(configModule.getCodexTuiMaskEmail).mockReturnValue(true);
		};
		const disableMasking = async () => {
			const configModule = await import("../lib/config.js");
			vi.mocked(configModule.getCodexTuiMaskEmail).mockReturnValue(false);
		};

		const seedSingleAccount = () => {
			mockStorage.accounts = [
				{ refreshToken: "r1", email: RAW_EMAIL, accountId: "acc-1" },
			];
		};

		// Each entry: a label and a thunk that returns the tool's rendered TEXT
		// output for a single seeded account. Index-bearing tools target index 1.
		const textSurfaces: Array<{
			name: string;
			run: () => Promise<string>;
		}> = [
			{
				name: "codex-list",
				run: async () =>
					(await plugin.tool["codex-list"].execute()) as string,
			},
			{
				name: "codex-status",
				run: async () =>
					(await plugin.tool["codex-status"].execute()) as string,
			},
			{
				name: "codex-health",
				run: async () =>
					(await plugin.tool["codex-health"].execute()) as string,
			},
			{
				name: "codex-switch",
				run: async () =>
					(await plugin.tool["codex-switch"].execute({ index: 1 })) as string,
			},
			{
				name: "codex-label",
				run: async () =>
					(await plugin.tool["codex-label"].execute({
						index: 1,
						label: "Work",
					})) as string,
			},
			{
				name: "codex-tag",
				run: async () =>
					(await plugin.tool["codex-tag"].execute({
						index: 1,
						tags: "work",
					})) as string,
			},
			{
				name: "codex-note",
				run: async () =>
					(await plugin.tool["codex-note"].execute({
						index: 1,
						note: "primary",
					})) as string,
			},
			{
				name: "codex-remove",
				run: async () =>
					(await plugin.tool["codex-remove"].execute({
						index: 1,
						confirm: true,
					})) as string,
			},
		];

		// PLACEHOLDER_163_TESTS
		for (const surface of textSurfaces) {
			it(`${surface.name}: never renders the raw email when maskEmail is enabled`, async () => {
				await enableMasking();
				seedSingleAccount();

				const output = await surface.run();

				expect(output).toContain(MASKED_EMAIL);
				expect(output).not.toContain(RAW_EMAIL);
			});

			it(`${surface.name}: renders the raw email when maskEmail is disabled (backward compatible)`, async () => {
				await disableMasking();
				seedSingleAccount();

				const output = await surface.run();

				expect(output).toContain(RAW_EMAIL);
				expect(output).not.toContain(MASKED_EMAIL);
			});
		}

		it("codex-list: masks every email when multiple accounts are listed", async () => {
			await enableMasking();
			mockStorage.accounts = [
				{ refreshToken: "r1", email: "alice@example.com", accountId: "acc-1" },
				{ refreshToken: "r2", email: "bob@other.org", accountId: "acc-2" },
			];

			const output = (await plugin.tool["codex-list"].execute()) as string;

			expect(output).toContain("al***@example.com");
			expect(output).toContain("bo***@other.org");
			expect(output).not.toContain("alice@example.com");
			expect(output).not.toContain("bob@other.org");
		});

		it("codex-remove: masks the email in the duplicate-entries hint when maskEmail is enabled", async () => {
			await enableMasking();
			// Two entries share the same email so the post-remove duplicate hint fires.
			mockStorage.accounts = [
				{ refreshToken: "r1", email: RAW_EMAIL, accountId: "acc-1" },
				{ refreshToken: "r2", email: RAW_EMAIL, accountId: "acc-2" },
			];

			const output = (await plugin.tool["codex-remove"].execute({
				index: 1,
				confirm: true,
			})) as string;

			expect(output).toContain("Other entries for");
			expect(output).toContain(MASKED_EMAIL);
			expect(output).not.toContain(RAW_EMAIL);
		});

		it("codex-remove: shows the raw email in the duplicate-entries hint when maskEmail is disabled", async () => {
			await disableMasking();
			mockStorage.accounts = [
				{ refreshToken: "r1", email: RAW_EMAIL, accountId: "acc-1" },
				{ refreshToken: "r2", email: RAW_EMAIL, accountId: "acc-2" },
			];

			const output = (await plugin.tool["codex-remove"].execute({
				index: 1,
				confirm: true,
			})) as string;

			expect(output).toContain(`Other entries for ${RAW_EMAIL} remain`);
		});

		it("codex-list --includeSensitive: still emits the raw email in opt-in JSON even when masking is enabled", async () => {
			await enableMasking();
			seedSingleAccount();

			const result = parseJsonOutput<{
				accounts: Array<{ label: string; email: string | null }>;
			}>(
				(await plugin.tool["codex-list"].execute({
					format: "json",
					includeSensitive: true,
				})) as string,
			);

			// The privacy boundary: --includeSensitive is the one opt-in surface
			// where raw identity is intentionally preserved for tooling.
			expect(result.accounts[0]?.email).toBe(RAW_EMAIL);
			expect(result.accounts[0]?.label).toContain(RAW_EMAIL);
		});

		it("interactive account picker: masks emails in the selection menu when maskEmail is enabled", async () => {
			await enableMasking();
			mockStorage.accounts = [
				{ refreshToken: "r1", email: RAW_EMAIL, accountId: "acc-1" },
				{ refreshToken: "r2", email: "bob@other.org", accountId: "acc-2" },
			];

			const { select } = await import("../lib/ui/select.js");
			vi.mocked(select).mockResolvedValueOnce(null);

			// promptAccountIndexSelection only runs when an interactive TTY is
			// available; stub both streams for the duration of this test.
			const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
			const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

			try {
				// No index => falls through to the interactive picker.
				await plugin.tool["codex-switch"].execute({});

				expect(vi.mocked(select)).toHaveBeenCalled();
				const items = vi.mocked(select).mock.calls[0]?.[0] as Array<{
					label: string;
				}>;
				const labels = items.map((item) => item.label).join("\n");

				expect(labels).toContain("al***@example.com");
				expect(labels).toContain("bo***@other.org");
				expect(labels).not.toContain(RAW_EMAIL);
				expect(labels).not.toContain("bob@other.org");
			} finally {
				// Off a real TTY there is no own `isTTY` descriptor to put back, so
				// the stub has to be deleted rather than restored. Leaving it set
				// leaks `isTTY: true` into every later test in this worker and makes
				// non-interactive assertions fail under a shuffled test order.
				if (stdinDesc) Object.defineProperty(process.stdin, "isTTY", stdinDesc);
				else delete (process.stdin as { isTTY?: boolean }).isTTY;
				if (stdoutDesc) Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
				else delete (process.stdout as { isTTY?: boolean }).isTTY;
			}
		});
	});
});

describe("OpenAIOAuthPlugin edge cases", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStorage.accounts = [];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("handles event handler errors gracefully", async () => {
		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		await plugin.event({ event: { type: "account.select", properties: { index: "not-a-number" } } });
	});

	it("starts the quota monitor and disposes it when the server instance is disposed", async () => {
		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		expect(quotaMonitorMock.start).toHaveBeenCalled();
		expect(quotaMonitorMock.dispose).not.toHaveBeenCalled();

		await plugin.event({ event: { type: "server.instance.disposed" } });

		expect(quotaMonitorMock.dispose).toHaveBeenCalledOnce();
	});

	it("handles storage errors in codex-switch", async () => {
		// codex-switch persists through withAccountStorageTransaction's
		// `persist` callback (not the standalone saveAccounts export), so the
		// failure must be injected there to exercise the tool's save-failed
		// branch.
		const { withAccountStorageTransaction } = await import("../lib/storage.js");
		vi.mocked(withAccountStorageTransaction).mockImplementationOnce(
			async <T>(
				callback: (
					current: typeof mockStorage | null,
					persist: (storage: typeof mockStorage) => Promise<void>,
				) => Promise<T>,
			) => {
				const loadedStorage = cloneMockStorage();
				const persist = async () => {
					throw new Error("Write failed");
				};
				return await callback(loadedStorage, persist);
			},
		);

		mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-switch"].execute({ index: 1 });
		expect(result).toContain("Failed to switch to");
		expect(result).toContain("account storage could not be updated");
	});

	it("handles export errors", async () => {
		const { exportAccounts } = await import("../lib/storage.js");
		vi.mocked(exportAccounts).mockRejectedValueOnce(new Error("Export failed"));

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-export"].execute({
			path: "/tmp/backup.json",
		});
		expect(result).toContain("Export failed");
	});

	it("handles import errors", async () => {
		const { importAccounts } = await import("../lib/storage.js");
		vi.mocked(importAccounts).mockRejectedValueOnce(new Error("Import failed"));

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-import"].execute({
			path: "/tmp/backup.json",
		});
		expect(result).toContain("Import failed");
	});

	it("handles health check failures", async () => {
		const { queuedRefresh } = await import("../lib/refresh-queue.js");
		vi.mocked(queuedRefresh).mockRejectedValueOnce(new Error("Network error"));

		mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-health"].execute();
		expect(result).toContain("Network error");
		expect(result).toContain("0 healthy, 1 unhealthy");
	});

	it("handles refresh failures", async () => {
		const { queuedRefresh } = await import("../lib/refresh-queue.js");
		vi.mocked(queuedRefresh).mockResolvedValueOnce({
			type: "failed" as const,
			reason: "http_error",
			message: "Token expired",
		});

		mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-refresh"].execute();
		expect(result).toContain("Failed");
	});

	it("handles refresh throwing errors", async () => {
		const { queuedRefresh } = await import("../lib/refresh-queue.js");
		vi.mocked(queuedRefresh).mockRejectedValueOnce(new Error("Network timeout"));

		mockStorage.accounts = [{ refreshToken: "r1", email: "user@example.com" }];

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-refresh"].execute();
		expect(result).toContain("Failed - Network timeout");
	});

	it("handles storage errors in codex-remove", async () => {
		// codex-remove persists through withAccountStorageTransaction's
		// `persist` callback (not the standalone saveAccounts export), so the
		// failure must be injected there to exercise the tool's save-failed
		// branch.
		const { withAccountStorageTransaction } = await import("../lib/storage.js");
		vi.mocked(withAccountStorageTransaction).mockImplementationOnce(
			async <T>(
				callback: (
					current: typeof mockStorage | null,
					persist: (storage: typeof mockStorage) => Promise<void>,
				) => Promise<T>,
			) => {
				const loadedStorage = cloneMockStorage();
				const persist = async () => {
					throw new Error("Write failed");
				};
				return await callback(loadedStorage, persist);
			},
		);

		mockStorage.accounts = [
			{ refreshToken: "r1", email: "user1@example.com" },
			{ refreshToken: "r2", email: "user2@example.com" },
		];

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-remove"].execute({ index: 1, confirm: true });
		expect(result).toContain("Failed to remove");
		expect(result).toContain("account storage could not be updated");
	});

	it("adjusts activeIndex when removing account before it", async () => {
		// When activeIndex=2 and we remove index 0 (1-based: 1), the remaining accounts
		// have length 2. Since activeIndex (2) >= length (2), it resets to 0.
		mockStorage.accounts = [
			{ refreshToken: "r1", email: "user1@example.com" },
			{ refreshToken: "r2", email: "user2@example.com" },
			{ refreshToken: "r3", email: "user3@example.com" },
		];
		mockStorage.activeIndex = 2;
		mockStorage.activeIndexByFamily = { codex: 2 };

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		await plugin.tool["codex-remove"].execute({ index: 1, confirm: true });
		// After removing account at 0-based index 0, length is 2.
		// activeIndex (2) >= length (2), so it resets to 0
		expect(mockStorage.activeIndex).toBe(0);
		expect(mockStorage.activeIndexByFamily.codex).toBe(0);
	});

	it("resets activeIndex when removing active account at end", async () => {
		mockStorage.accounts = [
			{ refreshToken: "r1", email: "user1@example.com" },
			{ refreshToken: "r2", email: "user2@example.com" },
		];
		mockStorage.activeIndex = 1;
		mockStorage.activeIndexByFamily = { codex: 1 };

		const mockClient = createMockClient();

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		await plugin.tool["codex-remove"].execute({ index: 2, confirm: true });
		expect(mockStorage.activeIndex).toBe(0);
	});
});

describe("OpenAIOAuthPlugin fetch handler", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
		resetMockManagedAccounts();
		mockStorage.accounts = [
			{
				accountId: "acc-1",
				email: "user@example.com",
				refreshToken: "refresh-1",
			},
		];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetMockManagedAccounts();
		// `clearAllMocks` in beforeEach only clears call records, so a
		// `mockReturnValue` set by one test would otherwise still be in force for
		// the next one. `resetAllMocks` puts every module mock back to the
		// implementation its `vi.mock` factory declared.
		vi.resetAllMocks();
		vi.restoreAllMocks();
	});

	const setupPlugin = async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = await plugin.auth.loader(getAuth, { options: {}, models: {} });
		return { plugin, sdk, mockClient };
	};

	it("returns success response for successful fetch", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "test" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(200);
	});

	// issue #203: gate the informational "Using <account> (N/N)" toast behind
	// the accountToasts opt-out, without affecting warning/error toasts. These
	// tests drive a real request through the selection path and OBSERVE whether
	// the toast reaches client.tui.showToast.
	describe("issue #203: account-selection toast opt-out", () => {
		const buildMultiAccountManager = () => {
			const account = {
				index: 0,
				accountId: "acc-1",
				email: "user@example.com",
				refreshToken: "refresh-1",
			};
			return {
				getAccountCount: () => 2,
				getCurrentOrNextForFamilyHybrid: () => account,
				getAccountForStrategy: () => account,
				getSelectionExplainability: () => [
					{
						index: 0,
						enabled: true,
						isCurrentForFamily: true,
						eligible: true,
						reasons: ["eligible"],
						healthScore: 100,
						tokensAvailable: 50,
						lastUsed: 1,
					},
				],
				toAuthDetails: () => ({
					type: "oauth" as const,
					access: "access-1",
					refresh: account.refreshToken,
					expires: 2,
				}),
				hasRefreshToken: () => true,
				saveToDiskDebounced: vi.fn(),
				updateFromAuth: vi.fn(),
				clearAuthFailures: vi.fn(),
				incrementAuthFailures: vi.fn(() => 1),
				markAccountCoolingDown: vi.fn(),
				markRateLimitedWithReason: vi.fn(),
				recordRateLimit: vi.fn(),
				consumeToken: vi.fn(() => true),
				refundToken: vi.fn(),
				markSwitched: vi.fn(),
				removeAccount: vi.fn(() => false),
				removeAccountsWithSameRefreshToken: vi.fn(() => 0),
				recordFailure: vi.fn(),
				recordSuccess: vi.fn(),
				getMinWaitTimeForFamily: vi.fn(() => 0),
				shouldShowAccountToast: vi.fn(() => true),
				markToastShown: vi.fn(),
				setActiveIndex: vi.fn(() => account),
				getAccountsSnapshot: vi.fn(() => [account]),
			};
		};

		const usingToastCalls = (client: ReturnType<typeof createMockClient>) =>
			client.tui.showToast.mock.calls.filter((call) => {
				const message = (call[0] as { body?: { message?: string } })?.body?.message;
				return typeof message === "string" && /^Using .+ \(\d+\/\d+\)$/.test(message);
			});

		it("shows the account-selection toast when accountToasts is enabled", async () => {
			const configModule = await import("../lib/config.js");
			vi.mocked(configModule.getAccountToastsEnabled).mockReturnValue(true);

			const { AccountManager } = await import("../lib/accounts.js");
			const manager = buildMultiAccountManager();
			vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(manager as never);
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

			const { sdk, mockClient } = await setupPlugin();
			const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			});

			expect(response.status).toBe(200);
			expect(usingToastCalls(mockClient)).toHaveLength(1);
			expect(manager.markToastShown).toHaveBeenCalledTimes(1);
		});

		it("suppresses ONLY the selection toast when accountToasts is disabled", async () => {
			const configModule = await import("../lib/config.js");
			vi.mocked(configModule.getAccountToastsEnabled).mockReturnValue(false);

			const { AccountManager } = await import("../lib/accounts.js");
			const manager = buildMultiAccountManager();
			vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(manager as never);
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

			const { sdk, mockClient } = await setupPlugin();
			const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			});

			// Request still succeeds; the toast is the only thing suppressed.
			expect(response.status).toBe(200);
			expect(usingToastCalls(mockClient)).toHaveLength(0);
			// The info toast is skipped, so its debounce marker is never consumed —
			// which keeps warning toasts fully eligible rather than suppressing them.
			expect(manager.markToastShown).not.toHaveBeenCalled();
		});
	});

	it.each([
		{ pool: [], policy: "preferred", mode: "general", size: 0 },
		{ pool: ["acc-1"], policy: "preferred", mode: "preferred", size: 1 },
		{ pool: ["unavailable-account"], policy: "preferred", mode: "general-fallback", size: 1 },
		{ pool: ["acc-1"], policy: "strict", mode: "strict", size: 1 },
	] as const)(
		"reports $mode account pool routing diagnostics",
		async ({ pool, policy, mode, size }) => {
			const configModule = await import("../lib/config.js");
			vi.mocked(configModule.getModelAccountPool).mockReturnValueOnce([...pool]);
			vi.mocked(configModule.getModelAccountPoolMode).mockReturnValueOnce(policy);
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ content: "test" }), { status: 200 }),
			);

			const { plugin, sdk } = await setupPlugin();
			const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			});

			expect(response.status).toBe(200);
			const metrics = parseJsonOutput<{
				routingVisibility: {
					accountPoolMode: string | null;
					configuredAccountPoolSize: number;
				};
			}>(await plugin.tool["codex-metrics"].execute({ format: "json" }));
			expect(metrics.routingVisibility).toMatchObject({
				accountPoolMode: mode,
				configuredAccountPoolSize: size,
			});
		},
	);

	it("fails immediately when a strict model pool has no selectable account", async () => {
		const configModule = await import("../lib/config.js");
		vi.mocked(configModule.getModelAccountPool).mockReturnValueOnce([
			"unavailable-account",
		]);
		vi.mocked(configModule.getModelAccountPoolMode).mockReturnValueOnce("strict");
		globalThis.fetch = vi.fn();

		const { plugin, sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});
		expect(configModule.getModelAccountPoolMode).toHaveBeenCalled();
		expect(response).toBeInstanceOf(Response);
		const body = (await response.json()) as {
			error: { code: string; message: string };
		};

		expect(response.status).toBe(503);
		expect(body.error).toMatchObject({
			code: "strict_pool_unavailable",
		});
		expect(body.error.message).toContain("Strict account pool unavailable");
		expect(globalThis.fetch).not.toHaveBeenCalled();

		const metrics = parseJsonOutput<{
			routingVisibility: { accountPoolMode: string | null };
		}>(await plugin.tool["codex-metrics"].execute({ format: "json" }));
		expect(metrics.routingVisibility.accountPoolMode).toBe("strict-unavailable");
	});

	it("does not record TUI quota cache from a non-authoritative error response", async () => {
		const previousStateDir = process.env.OPENCODE_STATE_DIR;
		const stateDir = await mkdtemp(join(tmpdir(), "tui-quota-error-"));
		process.env.OPENCODE_STATE_DIR = stateDir;
		const quotaHeaders = {
			"x-codex-primary-used-percent": "100",
			"x-codex-primary-window-minutes": "300",
			"x-codex-secondary-used-percent": "100",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-plan-type": "plus",
			"x-codex-active-limit": "40",
		};
		const sendPrompt = async () => {
			const { sdk } = await setupPlugin();
			return sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			});
		};
		try {
			const { getTuiQuotaCachePath, readTuiQuotaSnapshot } = await import(
				"../lib/tui-quota-cache.js"
			);
			const cachePath = getTuiQuotaCachePath(stateDir);

			// An entitlement-style failure carrying a stale 0%-left snapshot. The
			// router ignores those headers, so the status line must not report the
			// account as spent either.
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: { code: "usage_not_included" } }), {
					status: 400,
					headers: quotaHeaders,
				}),
			);
			await sendPrompt();
			for (let attempt = 0; attempt < 20; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(await readTuiQuotaSnapshot(cachePath)).toBeFalsy();

			// Positive control: the same headers on a served request still land, so
			// the assertion above is about the authority gate and not a broken write.
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ content: "test" }), {
					status: 200,
					headers: quotaHeaders,
				}),
			);
			await sendPrompt();
			let snapshot = await readTuiQuotaSnapshot(cachePath);
			for (let attempt = 0; !snapshot && attempt < 20; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				snapshot = await readTuiQuotaSnapshot(cachePath);
			}
			expect(snapshot).toEqual(
				expect.objectContaining({ source: "headers", planType: "plus" }),
			);
		} finally {
			if (previousStateDir === undefined) {
				delete process.env.OPENCODE_STATE_DIR;
			} else {
				process.env.OPENCODE_STATE_DIR = previousStateDir;
			}
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("records TUI quota cache from successful Codex response headers", async () => {
		const previousStateDir = process.env.OPENCODE_STATE_DIR;
		const stateDir = await mkdtemp(join(tmpdir(), "tui-quota-index-"));
		process.env.OPENCODE_STATE_DIR = stateDir;
		try {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ content: "test" }), {
					status: 200,
					headers: {
						"x-codex-primary-used-percent": "6",
						"x-codex-primary-window-minutes": "300",
						"x-codex-secondary-used-percent": "17",
						"x-codex-secondary-window-minutes": "10080",
						"x-codex-plan-type": "plus",
						"x-codex-active-limit": "40",
					},
				}),
			);

			const { sdk } = await setupPlugin();
			const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			});
			const { getTuiQuotaCachePath, readTuiQuotaSnapshot } = await import(
				"../lib/tui-quota-cache.js"
			);
			let snapshot = await readTuiQuotaSnapshot(getTuiQuotaCachePath(stateDir));
			for (let attempt = 0; !snapshot && attempt < 20; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				snapshot = await readTuiQuotaSnapshot(getTuiQuotaCachePath(stateDir));
			}

			expect(response.status).toBe(200);
			expect(snapshot).toEqual(
				expect.objectContaining({
					source: "headers",
					accountIndex: 1,
					accountCount: 1,
					accountEmail: "user@example.com",
					accountLabel: "Account 1",
					planType: "plus",
					activeLimit: 40,
				}),
			);
			expect(snapshot?.limits).toEqual([
				expect.objectContaining({
					label: "5h",
					leftPercent: 94,
					usedPercent: 6,
					windowMinutes: 300,
				}),
				expect.objectContaining({
					label: "7d",
					leftPercent: 83,
					usedPercent: 17,
					windowMinutes: 10080,
				}),
			]);
		} finally {
			if (previousStateDir === undefined) {
				delete process.env.OPENCODE_STATE_DIR;
			} else {
				process.env.OPENCODE_STATE_DIR = previousStateDir;
			}
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	// Issue #218: an account whose weekly window is spent was picked again on
	// every prompt because nothing consumed the used-percent headers, and the
	// 429 path collapsed the weekly and 5h resets with Math.min.
	describe("issue #218: weekly quota exhaustion", () => {
		const nowSeconds = () => Math.floor(Date.now() / 1000);

		const respondWith = (headers: Record<string, string>, status = 200) => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ content: "test" }), { status, headers }),
			);
		};

		const sendPrompt = async () => {
			const { sdk } = await setupPlugin();
			return sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			});
		};

		beforeEach(() => {
			mockQuotaExhaustionCalls.length = 0;
		});

		it("blocks the account until the weekly reset when it reports 0% left", async () => {
			const weeklyResetAtSeconds = nowSeconds() + 7 * 24 * 60 * 60;
			respondWith({
				"x-codex-primary-used-percent": "40",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": String(nowSeconds() + 5 * 60 * 60),
				"x-codex-secondary-used-percent": "100",
				"x-codex-secondary-window-minutes": "10080",
				"x-codex-secondary-reset-at": String(weeklyResetAtSeconds),
			});

			expect((await sendPrompt()).status).toBe(200);

			// The weekly reset wins over the sooner 5h reset: an account whose
			// weekly quota is gone stays unusable after the 5h window rolls over.
			expect(mockQuotaExhaustionCalls).toEqual([
				expect.objectContaining({ resetAtMs: weeklyResetAtSeconds * 1000 }),
			]);
		});

		it("leaves an account with quota left in rotation", async () => {
			respondWith({
				"x-codex-primary-used-percent": "40",
				"x-codex-primary-window-minutes": "300",
				"x-codex-secondary-used-percent": "99",
				"x-codex-secondary-window-minutes": "10080",
				"x-codex-secondary-reset-at": String(nowSeconds() + 7 * 24 * 60 * 60),
			});

			expect((await sendPrompt()).status).toBe(200);
			expect(mockQuotaExhaustionCalls).toEqual([]);
		});

		it("ignores a window the plan has switched off", async () => {
			respondWith({
				"x-codex-primary-used-percent": "100",
				"x-codex-primary-window-minutes": "0",
				"x-codex-primary-reset-at": String(nowSeconds() + 5 * 60 * 60),
				"x-codex-secondary-used-percent": "12",
				"x-codex-secondary-window-minutes": "10080",
			});

			expect((await sendPrompt()).status).toBe(200);
			expect(mockQuotaExhaustionCalls).toEqual([]);
		});

		it("does not persist exhausted headers from a non-rate-limit error", async () => {
			respondWith(
				{
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": String(nowSeconds() + 5 * 60 * 60),
				},
				400,
			);

			expect((await sendPrompt()).status).toBe(400);
			expect(mockQuotaExhaustionCalls).toEqual([]);
		});

		it("persists exhausted headers from a confirmed rate-limit error", async () => {
			const resetAtSeconds = nowSeconds() + 5 * 60 * 60;
			respondWith(
				{
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": String(resetAtSeconds),
				},
				429,
			);
			const fetchHelpers = await import("../lib/request/fetch-helpers.js");
			vi.mocked(fetchHelpers.handleErrorResponse).mockImplementationOnce(async (response) => ({
				response,
				rateLimit: { retryAfterMs: 60_000, code: "usage_limit_reached" },
				quotaHeadersAuthoritative: true,
			}));

			// The only account in the pool is now blocked, so the router runs out of
			// candidates rather than replaying the upstream 429 — the same outcome any
			// rate limit past the short-retry threshold already produced.
			expect((await sendPrompt()).status).toBe(503);
			expect(mockQuotaExhaustionCalls).toEqual([
				expect.objectContaining({ resetAtMs: resetAtSeconds * 1000 }),
			]);
			// The window is spent for the next five hours and the block just written
			// for it cannot be shortened, so the short 429 retry must not fire: a
			// second upstream call here would mean the account is serving traffic
			// while rotation still considers it blocked.
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		});

		it("ignores exhausted headers on a 429-shaped upstream overload", async () => {
			respondWith(
				{
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": String(nowSeconds() + 5 * 60 * 60),
				},
				429,
			);
			const fetchHelpers = await import("../lib/request/fetch-helpers.js");
			vi.mocked(fetchHelpers.handleErrorResponse).mockImplementationOnce(async (response) => ({
				response,
				rateLimit: { retryAfterMs: 1_750, code: "server_is_overloaded" },
				retryAsServerError: true,
				quotaHeadersAuthoritative: false,
			}));

			const { resetAllCircuitBreakers } = await import("../lib/circuit-breaker.js");
			try {
				await sendPrompt();
				// A ten-second upstream blip must not park the account until the reset.
				expect(mockQuotaExhaustionCalls).toEqual([]);
			} finally {
				// The overload path feeds the module-level breaker, which outlives this
				// test and would short-circuit every later request in the file.
				resetAllCircuitBreakers();
			}
		});
	});

	it("persists the selected account before writing TUI quota snapshots", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const { AccountManager } = accountsModule;
		const previousStateDir = process.env.OPENCODE_STATE_DIR;
		const stateDir = await mkdtemp(join(tmpdir(), "tui-quota-selected-"));
		const selectedAccount = {
			index: 1,
			accountId: "acc-2",
			email: "user2@example.com",
			refreshToken: "refresh-2",
		};
		const saveToDiskDebounced = vi.fn();
		const customManager = {
			getAccountCount: () => 2,
			getCurrentOrNextForFamilyHybrid: () => selectedAccount,
			getAccountForStrategy: () => selectedAccount,
			getSelectionExplainability: () => [
				{
					index: 0,
					enabled: true,
					isCurrentForFamily: false,
					eligible: true,
					reasons: ["eligible"],
					healthScore: 100,
					tokensAvailable: 50,
					lastUsed: Date.now(),
				},
				{
					index: 1,
					enabled: true,
					isCurrentForFamily: true,
					eligible: true,
					reasons: ["eligible"],
					healthScore: 100,
					tokensAvailable: 50,
					lastUsed: Date.now(),
				},
			],
			toAuthDetails: () => ({
				type: "oauth" as const,
				access: "access-2",
				refresh: selectedAccount.refreshToken,
				expires: Date.now() + 60_000,
			}),
			hasRefreshToken: () => true,
			saveToDiskDebounced,
			updateFromAuth: vi.fn(),
			clearAuthFailures: vi.fn(),
			incrementAuthFailures: vi.fn(() => 1),
			markAccountCoolingDown: vi.fn(),
			markRateLimitedWithReason: vi.fn(),
			recordRateLimit: vi.fn(),
			consumeToken: vi.fn(() => true),
			refundToken: vi.fn(),
			markSwitched: vi.fn(),
			removeAccount: vi.fn(() => false),
			removeAccountsWithSameRefreshToken: vi.fn(() => 0),
			recordFailure: vi.fn(),
			recordSuccess: vi.fn(),
			getMinWaitTimeForFamily: vi.fn(() => 0),
			shouldShowAccountToast: vi.fn(() => false),
			markToastShown: vi.fn(),
			setActiveIndex: vi.fn(() => selectedAccount),
			getAccountsSnapshot: vi.fn(() => [
				{ index: 0, accountId: "acc-1", email: "user1@example.com", refreshToken: "refresh-1" },
				selectedAccount,
			]),
		};
		process.env.OPENCODE_STATE_DIR = stateDir;
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(customManager as never);
		try {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ content: "test" }), {
					status: 200,
					headers: {
						"x-codex-primary-used-percent": "12",
						"x-codex-primary-window-minutes": "300",
					},
				}),
			);

			const { sdk } = await setupPlugin();
			const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			});
			const { getTuiQuotaCachePath, readTuiQuotaSnapshot } = await import(
				"../lib/tui-quota-cache.js"
			);
			let snapshot = await readTuiQuotaSnapshot(getTuiQuotaCachePath(stateDir));
			for (let attempt = 0; !snapshot && attempt < 20; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				snapshot = await readTuiQuotaSnapshot(getTuiQuotaCachePath(stateDir));
			}

			expect(response.status).toBe(200);
			expect(saveToDiskDebounced).toHaveBeenCalledTimes(1);
			expect(snapshot).toEqual(
				expect.objectContaining({
					source: "headers",
					accountIndex: 2,
					accountCount: 2,
				}),
			);
		} finally {
			if (previousStateDir === undefined) {
				delete process.env.OPENCODE_STATE_DIR;
			} else {
				process.env.OPENCODE_STATE_DIR = previousStateDir;
			}
			await rm(stateDir, { recursive: true, force: true });
		}
	});

	it("handles network errors and rotates to next account", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(503);
		expect(await response.text()).toContain("server errors or auth issues");
	});

	it("retries single-account overloads when retry-after is preserved on server overloads", async () => {
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const accountsModule = await import("../lib/accounts.js");
		const { AccountManager } = accountsModule;

		vi.useFakeTimers();

		try {
			const overloadedAccount = {
				index: 0,
				accountId: "acc-1",
				email: "user@example.com",
				refreshToken: "refresh-1",
			};

			let rateLimitedUntil = 0;
			const markRateLimitedWithReason = vi.fn(
				(_account: typeof overloadedAccount, retryAfterMs: number) => {
				rateLimitedUntil = Date.now() + retryAfterMs;
				},
			);
			const customManager = {
				getAccountCount: () => 1,
				getCurrentOrNextForFamilyHybrid: () => overloadedAccount,
				getAccountForStrategy: () => overloadedAccount,
				getSelectionExplainability: () => [
					{
						index: 0,
						enabled: true,
						isCurrentForFamily: true,
						eligible: true,
						reasons: ["eligible"],
						healthScore: 100,
						tokensAvailable: 50,
						lastUsed: Date.now(),
					},
				],
				toAuthDetails: () => ({
					type: "oauth" as const,
					access: "access-overloaded",
					refresh: overloadedAccount.refreshToken,
					expires: Date.now() + 60_000,
				}),
				hasRefreshToken: () => true,
				saveToDiskDebounced: vi.fn(),
				updateFromAuth: vi.fn(),
				clearAuthFailures: vi.fn(),
				incrementAuthFailures: vi.fn(() => 1),
				markAccountCoolingDown: vi.fn(),
				markRateLimitedWithReason,
				recordRateLimit: vi.fn(),
				consumeToken: vi.fn(() => true),
				refundToken: vi.fn(),
				markSwitched: vi.fn(),
				removeAccount: vi.fn(() => false),
				removeAccountsWithSameRefreshToken: vi.fn(() => 0),
				recordFailure: vi.fn(),
				recordSuccess: vi.fn(),
				getMinWaitTimeForFamily: vi.fn(() => Math.max(0, rateLimitedUntil - Date.now())),
				shouldShowAccountToast: vi.fn(() => false),
				markToastShown: vi.fn(),
				setActiveIndex: vi.fn(() => overloadedAccount),
				getAccountsSnapshot: vi.fn(() => [overloadedAccount]),
			};
			vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(customManager as never);
			vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation(
				(_init, _accountId, accessToken) =>
					new Headers({ "x-test-access-token": String(accessToken) }),
			);
			vi.mocked(fetchHelpers.handleErrorResponse).mockResolvedValueOnce({
				response: new Response(
					JSON.stringify({
						error: {
							context: {
								type: "service_unavailable_error",
							},
							message: "Our servers are currently overloaded. Please try again later.",
							retry_after_ms: 1000,
						},
					}),
					{ status: 429 },
				),
				rateLimit: { retryAfterMs: 1000, code: "server_is_overloaded" },
				errorBody: {
					error: {
						context: {
							type: "service_unavailable_error",
						},
					},
				},
				retryAsServerError: true,
			});

			globalThis.fetch = vi
				.fn()
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							error: {
								context: {
									type: "service_unavailable_error",
								},
								message: "Our servers are currently overloaded. Please try again later.",
								retry_after_ms: 1000,
							},
						}),
						{ status: 429 },
					),
				)
				.mockResolvedValueOnce(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

			const { sdk } = await setupPlugin();
			const fetchPromise = sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			});

			await vi.advanceTimersByTimeAsync(1500);

			const response = await fetchPromise;
			expect(response.status).toBe(200);
			expect(globalThis.fetch).toHaveBeenCalledTimes(2);
			expect(markRateLimitedWithReason).toHaveBeenCalledWith(
				overloadedAccount,
				1000,
				"gpt-5.1",
				"unknown",
				"gpt-5.1",
			);
			expect(customManager.getMinWaitTimeForFamily).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	describe("quota fallback safety with real account eligibility", () => {
		const entryModel = "gpt-5.6-sol";
		const makeManager = async (accounts: import("../lib/storage.js").AccountMetadataV3[]) => {
			const prompts = await import("../lib/prompts/codex.js");
			const realPrompts = await vi.importActual<typeof prompts>("../lib/prompts/codex.js");
			vi.spyOn(prompts, "getModelFamily").mockImplementation(realPrompts.getModelFamily);
			const actual = await vi.importActual<typeof import("../lib/accounts.js")>("../lib/accounts.js");
			const { AccountManager, resolveRequestAccountId } = await import("../lib/accounts.js");
			vi.mocked(resolveRequestAccountId).mockImplementation((storedId) => storedId);
			const manager = new actual.AccountManager(undefined, { version: 3, activeIndex: 0, accounts });
			vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(manager);
			vi.spyOn(manager, "saveToDiskDebounced").mockImplementation(() => {});
			const fetchHelpers = await import("../lib/request/fetch-helpers.js");
			const realHelpers = await vi.importActual<typeof fetchHelpers>("../lib/request/fetch-helpers.js");
			vi.mocked(fetchHelpers.transformRequestForCodex).mockImplementation(async (init) => ({
				updatedInit: init, body: JSON.parse(String(init?.body)),
			}));
			vi.mocked(fetchHelpers.isDefaultAutoFallbackModel).mockImplementation(realHelpers.isDefaultAutoFallbackModel);
			vi.mocked(fetchHelpers.pickFallbackChainTarget).mockImplementation(realHelpers.pickFallbackChainTarget);
			vi.mocked(fetchHelpers.handleErrorResponse).mockImplementation(realHelpers.handleErrorResponse);
			vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation((_init, accountId) => new Headers({ "x-test-account": accountId }));
			const quotaCache = await import("../lib/tui-quota-cache.js");
			vi.spyOn(quotaCache, "writeTuiQuotaSnapshot").mockResolvedValue(undefined);
			globalThis.fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ content: "ok" })));
			return manager;
		};
		const accountRecord = (accountId = "acc-1") => ({
			accountId, refreshToken: `refresh-${accountId}`, accessToken: "access-test",
			expiresAt: Date.now() + 3_600_000, addedAt: 1, lastUsed: 1,
		});
		const send = async (sdk: Awaited<ReturnType<typeof setupPlugin>>["sdk"], model = entryModel) => {
			if (!sdk.fetch) throw new Error("Missing plugin fetch");
			return sdk.fetch("https://api.openai.com/v1/chat", {
				method: "POST", body: JSON.stringify({ model }),
			});
		};

		beforeEach(async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-09-11T00:00:00Z"));
			const { resetTrackers } = await import("../lib/rotation.js");
			resetTrackers();
		});
		afterEach(async () => {
			vi.useRealTimers();
			vi.unstubAllEnvs();
			const { resetTrackers } = await import("../lib/rotation.js");
			resetTrackers();
		});

		it.each([200, 429])("persists authoritative %i shared quota and never falls back into the spent account", async (status) => {
			const manager = await makeManager([accountRecord()]);
			const resetAt = Date.now() + 604_800_000;
			vi.mocked(globalThis.fetch).mockImplementationOnce(async () => new Response(
				JSON.stringify(status === 429 ? { error: { code: "usage_limit_reached" } } : { content: "ok" }),
				{ status, headers: { "x-codex-secondary-used-percent": "100", "x-codex-secondary-reset-at": String(resetAt) } },
			));
			const { sdk } = await setupPlugin();
			expect((await send(sdk)).status).toBe(status);
			expect((await send(sdk, "gpt-5.6-terra")).status).toBe(429);
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
			expect(manager.getAccountsSnapshot()[0]?.quotaExhaustedUntil).toBe(resetAt);
			expect(manager.getAccountsSnapshot()[0]?.rateLimitResetTimes).toEqual({});
			expect(manager.getSelectionExplainability(entryModel, entryModel)[0]?.reasons).toContain("quota-exhausted");
			expect(manager.getSelectionExplainability(entryModel, entryModel)[0]?.reasons).not.toContain("rate-limited");
			expect(manager.saveToDiskDebounced).toHaveBeenCalled();
			await manager.saveToDisk();
			expect(mockStorage.accounts[0]?.quotaExhaustedUntil).toBe(resetAt);
		});

		it.each(["token-bucket", "cooldown"])("does not downgrade for %s-only blocking", async (block) => {
			const manager = await makeManager([accountRecord()]);
			const account = manager.getCurrentAccount();
			if (!account) throw new Error("Missing test account");
			if (block === "cooldown") manager.markAccountCoolingDown(account, 600_000, "auth-failure");
			else {
				const { getTokenTracker } = await import("../lib/rotation.js");
				getTokenTracker().drain(account.index, `${entryModel}:${entryModel}`, 100);
			}
			const config = await import("../lib/config.js");
			vi.spyOn(config, "getRetryAllAccountsRateLimited").mockReturnValue(false);
			vi.spyOn(config, "getRotationStrategy").mockReturnValue("sticky");
			const { sdk } = await setupPlugin();
			expect((await send(sdk)).status).toBe(429);
			expect(globalThis.fetch).not.toHaveBeenCalled();
			const helpers = await import("../lib/request/fetch-helpers.js");
			expect(helpers.pickFallbackChainTarget).not.toHaveBeenCalled();
		});

		it.each(["blocked", "unresolved", "disabled"])("skips a %s strict target and serves a subsequent eligible strict candidate", async (state) => {
			await makeManager([
				{ ...accountRecord(), rateLimitResetTimes: { [`${entryModel}:${entryModel}`]: Date.now() + 600_000, "gpt-5.6-terra:gpt-5.6-terra": Date.now() + 600_000 } },
				{ ...accountRecord("acc-2"), rateLimitResetTimes: { [`${entryModel}:${entryModel}`]: Date.now() + 600_000 } },
				{ ...accountRecord("disabled"), enabled: false },
			]);
			const config = await import("../lib/config.js");
			vi.spyOn(config, "getRotationStrategy").mockReturnValue("sticky");
			vi.mocked(config.getModelAccountPool).mockImplementation((_config, model) => model === "gpt-5.6-terra"
				? [state === "blocked" ? "acc-1" : state === "unresolved" ? "missing" : "disabled"]
				: model === "gpt-5.6-luna" ? ["acc-2"] : []);
			vi.mocked(config.getModelAccountPoolMode).mockReturnValue("strict");
			const { sdk } = await setupPlugin();
			expect((await send(sdk)).status).toBe(200);
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
			const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
			expect(JSON.parse(String(init?.body)).model).toBe("gpt-5.6-luna");
			expect(new Headers(init?.headers).get("x-test-account")).toBe("acc-2");
		});

		it.each([undefined, "CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK"])("preserves genuine model fallback and opt-out %s", async (optOut) => {
			await makeManager([{ ...accountRecord(), rateLimitResetTimes: { [`${entryModel}:${entryModel}`]: Date.now() + 600_000 } }]);
			if (optOut) vi.stubEnv(optOut, "1");
			const { sdk } = await setupPlugin();
			expect((await send(sdk)).status).toBe(optOut ? 429 : 200);
			expect(globalThis.fetch).toHaveBeenCalledTimes(optOut ? 0 : 1);
			if (!optOut) expect(JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body)).model).toBe("gpt-5.6-terra");
		});
	});

	it("degrades to the next chain model when every account is blocked for the requested one", async () => {
		// Given a pool that is fully blocked for the requested default selector,
		// while the next chain model is servable right now.
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const { AccountManager } = await import("../lib/accounts.js");

		const account = {
			index: 0,
			accountId: "acc-1",
			email: "user@example.com",
			refreshToken: "refresh-1",
		};
		let askedModel = "";
		const selectable = () => (askedModel === "gpt-5.5" ? account : null);
		const customManager = {
			getAccountCount: () => 1,
			getSelectionExplainability: (_family: string, model?: string | null) => {
				askedModel = String(model ?? "");
				return [{ index: 0, enabled: true, eligible: model === "gpt-5.5", reasons: model === "gpt-5.5" ? ["eligible"] : ["rate-limited"], rateLimitedUntil: model === "gpt-5.5" ? undefined : Date.now() + 600_000 }];
			},
			getCurrentOrNextForFamilyHybrid: selectable,
			getAccountForStrategy: selectable,
			// Only the fallback model is servable; the requested one is blocked.
			getMinWaitTimeForFamily: vi.fn((_family: string, model?: string | null) =>
				model === "gpt-5.5" ? 0 : 600_000,
			),
			toAuthDetails: () => ({
				type: "oauth" as const,
				access: "access-1",
				refresh: account.refreshToken,
				expires: Date.now() + 60_000,
			}),
			hasRefreshToken: () => true,
			saveToDiskDebounced: vi.fn(),
			updateFromAuth: vi.fn(),
			clearAuthFailures: vi.fn(),
			incrementAuthFailures: vi.fn(() => 1),
			markAccountCoolingDown: vi.fn(),
			markRateLimitedWithReason: vi.fn(),
			recordRateLimit: vi.fn(),
			consumeToken: vi.fn(() => true),
			refundToken: vi.fn(),
			markSwitched: vi.fn(),
			removeAccount: vi.fn(() => false),
			removeAccountsWithSameRefreshToken: vi.fn(() => 0),
			recordFailure: vi.fn(),
			recordSuccess: vi.fn(),
			shouldShowAccountToast: vi.fn(() => false),
			markToastShown: vi.fn(),
			setActiveIndex: vi.fn(() => account),
			getAccountsSnapshot: vi.fn(() => [account]),
		};
		vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValue(customManager as never);
		vi.mocked(fetchHelpers.isDefaultAutoFallbackModel).mockReturnValue(true);
		vi.mocked(fetchHelpers.pickFallbackChainTarget).mockReturnValue("gpt-5.5");
		vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation(() => new Headers());
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

		// When the request asks for the blocked model.
		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.6-sol" }),
		});

		// Then it is served on the fallback model instead of waiting out the block.
		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		const sent = JSON.parse(
			String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body),
		);
		expect(sent.model).toBe("gpt-5.5");
	});

	it("cools down the account when grouped auth removal removes zero entries", async () => {
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const { AccountManager } = await import("../lib/accounts.js");
		const { ACCOUNT_LIMITS } = await import("../lib/constants.js");

		vi.spyOn(fetchHelpers, "shouldRefreshToken").mockReturnValue(true);
		vi.mocked(fetchHelpers.refreshAndUpdateToken).mockRejectedValue(
			new Error("Token expired"),
		);
		const incrementAuthFailuresSpy = vi
			.spyOn(AccountManager.prototype, "incrementAuthFailures")
			.mockReturnValue(ACCOUNT_LIMITS.MAX_AUTH_FAILURES_BEFORE_REMOVAL);
		const removeGroupedAccountsSpy = vi
			.spyOn(AccountManager.prototype, "removeAccountsWithSameRefreshToken")
			.mockReturnValue(0);
		const markAccountsWithRefreshTokenCoolingDownSpy = vi.spyOn(
			AccountManager.prototype,
			"markAccountsWithRefreshTokenCoolingDown",
		);

		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "should-not-fetch" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(response.status).toBe(503);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(incrementAuthFailuresSpy).toHaveBeenCalledTimes(1);
		expect(removeGroupedAccountsSpy).toHaveBeenCalledTimes(1);
		expect(markAccountsWithRefreshTokenCoolingDownSpy).toHaveBeenCalledWith(
			"refresh-1",
			ACCOUNT_LIMITS.AUTH_FAILURE_COOLDOWN_MS,
			"auth-failure",
		);
	});

	it("passes maskEmail to the account label on the auth-failure removal path", async () => {
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		const accountsModule = await import("../lib/accounts.js");
		const configModule = await import("../lib/config.js");
		const { AccountManager } = accountsModule;
		const { ACCOUNT_LIMITS } = await import("../lib/constants.js");

		vi.mocked(configModule.getCodexTuiMaskEmail).mockReturnValue(true);
		vi.spyOn(fetchHelpers, "shouldRefreshToken").mockReturnValue(true);
		vi.mocked(fetchHelpers.refreshAndUpdateToken).mockRejectedValue(
			new Error("Token expired"),
		);
		vi.spyOn(AccountManager.prototype, "incrementAuthFailures").mockReturnValue(
			ACCOUNT_LIMITS.MAX_AUTH_FAILURES_BEFORE_REMOVAL,
		);
		// Returning 1 drives the single-account removal branch that renders the
		// account label in the user-facing removal toast.
		vi.spyOn(
			AccountManager.prototype,
			"removeAccountsWithSameRefreshToken",
		).mockReturnValue(1);

		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "should-not-fetch" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		// The runtime label must be built with masking enabled. If the
		// `{ maskEmail }` option is dropped from this call site, this fails.
		expect(vi.mocked(accountsModule.formatAccountLabel)).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Number),
			{ maskEmail: true },
		);
	});

	it("skips fetch when local token bucket is depleted", async () => {
		const { AccountManager } = await import("../lib/accounts.js");
		const consumeSpy = vi.spyOn(AccountManager.prototype, "consumeToken").mockReturnValue(false);
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "should-not-be-returned" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
		});

		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("server errors or auth issues");
		consumeSpy.mockRestore();
	});

	it("falls back from gpt-5.4-pro to gpt-5.4 when unsupported fallback is enabled", async () => {
		const configModule = await import("../lib/config.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");

		vi.mocked(configModule.getFallbackOnUnsupportedCodexModel).mockReturnValueOnce(true);
		vi.mocked(configModule.getFallbackToGpt52OnUnsupportedGpt53).mockReturnValueOnce(false);
		vi.mocked(fetchHelpers.transformRequestForCodex).mockResolvedValueOnce({
			updatedInit: {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.4-pro" }),
			},
			body: { model: "gpt-5.4-pro" },
		});
		vi.mocked(fetchHelpers.handleErrorResponse).mockResolvedValueOnce({
			response: new Response(
				JSON.stringify({
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message:
							"The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
					},
				}),
				{ status: 400 },
			),
			rateLimit: undefined,
			errorBody: {
				error: {
					code: "model_not_supported_with_chatgpt_account",
					message:
						"The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
				},
			},
		});
		vi.mocked(fetchHelpers.resolveUnsupportedCodexFallbackModel).mockReturnValueOnce("gpt-5.4");

		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("bad", { status: 400 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.4-pro" }),
		});

		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		const firstInit = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
		const secondInit = vi.mocked(globalThis.fetch).mock.calls[1]?.[1] as RequestInit;
		expect(JSON.parse(firstInit.body as string).model).toBe("gpt-5.4-pro");
		expect(JSON.parse(secondInit.body as string).model).toBe("gpt-5.4");
	});

	it("surfaces fallback routing visibility through json ops tools", async () => {
		const configModule = await import("../lib/config.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");

		mockStorage.accounts = [
			{ refreshToken: "r1", email: "user@example.com", accountId: "acc-1" },
		];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = { codex: 0 };

		vi.mocked(configModule.getFallbackOnUnsupportedCodexModel).mockReturnValueOnce(true);
		vi.mocked(configModule.getFallbackToGpt52OnUnsupportedGpt53).mockReturnValueOnce(false);
		vi.mocked(fetchHelpers.transformRequestForCodex).mockResolvedValueOnce({
			updatedInit: {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.4-pro" }),
			},
			body: { model: "gpt-5.4-pro" },
		});
		vi.mocked(fetchHelpers.handleErrorResponse).mockResolvedValueOnce({
			response: new Response(
				JSON.stringify({
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message:
							"The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
					},
				}),
				{ status: 400 },
			),
			rateLimit: undefined,
			errorBody: {
				error: {
					code: "model_not_supported_with_chatgpt_account",
					message:
						"The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
				},
			},
		});
		vi.mocked(fetchHelpers.resolveUnsupportedCodexFallbackModel).mockReturnValueOnce("gpt-5.4");

		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("bad", { status: 400 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

		const { plugin, sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.4-pro" }),
		});

		expect(response.status).toBe(200);

		const metrics = parseJsonOutput<{
			routingVisibility: {
				requestedModel: string | null;
				effectiveModel: string | null;
				selectedAccountIndex: number | null;
				zeroBasedSelectedAccountIndex: number | null;
				fallbackApplied: boolean;
				fallbackFrom: string | null;
				fallbackTo: string | null;
				fallbackReason: string | null;
				lastErrorCategory: string | null;
				selectionExplainability: Array<{ index: number; zeroBasedIndex: number }>;
			};
		}>(await plugin.tool["codex-metrics"].execute({ format: "json" }));
		const status = parseJsonOutput<{
			routingVisibility: {
				requestedModel: string | null;
				effectiveModel: string | null;
				selectedAccountIndex: number | null;
				zeroBasedSelectedAccountIndex: number | null;
				fallbackApplied: boolean;
				fallbackFrom: string | null;
				fallbackTo: string | null;
				fallbackReason: string | null;
				selectionExplainability: Array<{ index: number; zeroBasedIndex: number }>;
			};
		}>(await plugin.tool["codex-status"].execute({ format: "json" }));
		const dashboard = parseJsonOutput<{
			routingVisibility: {
				requestedModel: string | null;
				effectiveModel: string | null;
				selectedAccountIndex: number | null;
				zeroBasedSelectedAccountIndex: number | null;
				fallbackApplied: boolean;
				fallbackFrom: string | null;
				fallbackTo: string | null;
				fallbackReason: string | null;
				selectionExplainability: Array<{ index: number; zeroBasedIndex: number }>;
			};
		}>(await plugin.tool["codex-dashboard"].execute({ format: "json" }));
		const doctor = parseJsonOutput<{
			technicalSnapshot: {
				routingVisibility: {
					requestedModel: string | null;
					effectiveModel: string | null;
					selectedAccountIndex: number | null;
					zeroBasedSelectedAccountIndex: number | null;
					fallbackApplied: boolean;
					fallbackFrom: string | null;
					fallbackTo: string | null;
					fallbackReason: string | null;
					selectionExplainability: Array<{ index: number; zeroBasedIndex: number }>;
				};
			} | null;
		}>(await plugin.tool["codex-doctor"].execute({ deep: true, format: "json" }));

		expect(metrics.routingVisibility).toMatchObject({
			requestedModel: "gpt-5.4-pro",
			effectiveModel: "gpt-5.4",
			fallbackApplied: true,
			fallbackFrom: "gpt-5.4-pro",
			fallbackTo: "gpt-5.4",
			fallbackReason: "fallback-unsupported-model-entitlement",
			lastErrorCategory: null,
			selectedAccountIndex: 1,
			zeroBasedSelectedAccountIndex: 0,
		});
		expect(status.routingVisibility).toMatchObject({
			requestedModel: "gpt-5.4-pro",
			effectiveModel: "gpt-5.4",
			fallbackApplied: true,
			fallbackFrom: "gpt-5.4-pro",
			fallbackTo: "gpt-5.4",
			fallbackReason: "fallback-unsupported-model-entitlement",
			selectedAccountIndex: 1,
			zeroBasedSelectedAccountIndex: 0,
		});
		expect(dashboard.routingVisibility).toMatchObject({
			requestedModel: "gpt-5.4-pro",
			effectiveModel: "gpt-5.4",
			fallbackApplied: true,
			fallbackFrom: "gpt-5.4-pro",
			fallbackTo: "gpt-5.4",
			fallbackReason: "fallback-unsupported-model-entitlement",
			selectedAccountIndex: 1,
			zeroBasedSelectedAccountIndex: 0,
		});
		expect(doctor.technicalSnapshot?.routingVisibility).toMatchObject({
			requestedModel: "gpt-5.4-pro",
			effectiveModel: "gpt-5.4",
			fallbackApplied: true,
			fallbackFrom: "gpt-5.4-pro",
			fallbackTo: "gpt-5.4",
			fallbackReason: "fallback-unsupported-model-entitlement",
			selectedAccountIndex: 1,
			zeroBasedSelectedAccountIndex: 0,
		});
		expect(metrics.routingVisibility.selectionExplainability[0]).toMatchObject({
			index: 1,
			zeroBasedIndex: 0,
		});
		expect(status.routingVisibility.selectionExplainability[0]).toMatchObject({
			index: 1,
			zeroBasedIndex: 0,
		});
		expect(dashboard.routingVisibility.selectionExplainability[0]).toMatchObject({
			index: 1,
			zeroBasedIndex: 0,
		});
		expect(
			doctor.technicalSnapshot?.routingVisibility.selectionExplainability[0],
		).toMatchObject({
			index: 1,
			zeroBasedIndex: 0,
		});
	});

	it("surfaces strict blocked-model routing visibility without fallback", async () => {
		const configModule = await import("../lib/config.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");

		vi.mocked(configModule.getUnsupportedCodexPolicy).mockReturnValue("strict");
		vi.mocked(fetchHelpers.transformRequestForCodex).mockResolvedValueOnce({
			updatedInit: {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.4-pro" }),
			},
			body: { model: "gpt-5.4-pro" },
		});
		vi.mocked(fetchHelpers.handleErrorResponse).mockResolvedValueOnce({
			response: new Response(
				JSON.stringify({
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message:
							"The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
					},
				}),
				{ status: 400 },
			),
			rateLimit: undefined,
			errorBody: {
				error: {
					code: "model_not_supported_with_chatgpt_account",
					message:
						"The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
				},
			},
		});
		vi.mocked(fetchHelpers.getUnsupportedCodexModelInfo).mockReturnValue({
			isUnsupported: true,
			unsupportedModel: "gpt-5.4-pro",
			message:
				"The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
			code: "model_not_supported_with_chatgpt_account",
		});

		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("bad", { status: 400 }));

		const { plugin, sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.4-pro" }),
		});

		expect(response.status).toBe(400);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(configModule.getUnsupportedCodexPolicy).toHaveReturnedWith("strict");
		expect(fetchHelpers.getUnsupportedCodexModelInfo).toHaveBeenCalled();

		const metrics = parseJsonOutput<{
			routingVisibility: {
				requestedModel: string | null;
				effectiveModel: string | null;
				selectedAccountIndex: number | null;
				zeroBasedSelectedAccountIndex: number | null;
				fallbackApplied: boolean;
				fallbackFrom: string | null;
				fallbackTo: string | null;
				fallbackReason: string | null;
			};
		}>(await plugin.tool["codex-metrics"].execute({ format: "json" }));
		const status = parseJsonOutput<{
			routingVisibility: {
				requestedModel: string | null;
				effectiveModel: string | null;
				selectedAccountIndex: number | null;
				zeroBasedSelectedAccountIndex: number | null;
				fallbackApplied: boolean;
				fallbackFrom: string | null;
				fallbackTo: string | null;
				fallbackReason: string | null;
			};
		}>(await plugin.tool["codex-status"].execute({ format: "json" }));

		expect(metrics.routingVisibility).toMatchObject({
			requestedModel: "gpt-5.4-pro",
			effectiveModel: "gpt-5.4-pro",
			fallbackApplied: false,
			fallbackFrom: "gpt-5.4-pro",
			fallbackTo: null,
			fallbackReason: "blocked-unsupported-model-entitlement",
			selectedAccountIndex: 1,
			zeroBasedSelectedAccountIndex: 0,
		});
		expect(status.routingVisibility).toMatchObject({
			requestedModel: "gpt-5.4-pro",
			effectiveModel: "gpt-5.4-pro",
			fallbackApplied: false,
			fallbackFrom: "gpt-5.4-pro",
			fallbackTo: null,
			fallbackReason: "blocked-unsupported-model-entitlement",
			selectedAccountIndex: 1,
			zeroBasedSelectedAccountIndex: 0,
		});
	});

	/**
	 * Two *distinct* stored accounts, every upstream call answering
	 * `model_not_supported_with_chatgpt_account` for gpt-5.4-pro.
	 *
	 * The second account is what makes the strict-pool assertions below
	 * meaningful: with the suite's default single account, "the general account
	 * was never fetched" holds in `preferred` mode too, so the test could not
	 * discriminate the mode it exists to cover.
	 */
	const setupUnsupportedModelOnEveryAccount = async (
		accounts: ReadonlyArray<Omit<MockManagedAccount, "index">> = [
			{ accountId: "acc-1", email: "user1@example.com", refreshToken: "refresh-1" },
			{ accountId: "acc-2", email: "user2@example.com", refreshToken: "refresh-2" },
		],
	) => {
		const accountsModule = await import("../lib/accounts.js");
		const configModule = await import("../lib/config.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		// Strict policy: no model fallback, so the traversal exhausts accounts and
		// reaches the terminal diagnostics under test.
		vi.mocked(configModule.getUnsupportedCodexPolicy).mockReturnValue("strict");
		vi.mocked(configModule.getFallbackOnUnsupportedCodexModel).mockReturnValue(false);
		// The suite-wide mock answers every account with the same token id, which
		// would rewrite each account's id to that one value and make the pool keys
		// stop matching. Keep the stored id, which is what the real resolver does
		// for a stable, non-org account id.
		vi.mocked(accountsModule.resolveRequestAccountId).mockImplementation(
			(storedId, _source, tokenId) => storedId ?? tokenId,
		);
		setMockManagedAccounts(accounts);
		vi.mocked(fetchHelpers.transformRequestForCodex).mockResolvedValue({
			updatedInit: {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.4-pro" }),
			},
			body: { model: "gpt-5.4-pro" },
		});
		const errorBody = {
			error: {
				code: "model_not_supported_with_chatgpt_account",
				message:
					"The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
			},
		};
		vi.mocked(fetchHelpers.handleErrorResponse).mockResolvedValue({
			response: new Response(JSON.stringify(errorBody), { status: 400 }),
			rateLimit: undefined,
			errorBody,
		});
		vi.mocked(fetchHelpers.getUnsupportedCodexModelInfo).mockReturnValue({
			isUnsupported: true,
			unsupportedModel: "gpt-5.4-pro",
			message: errorBody.error.message,
			code: errorBody.error.code,
		});
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify(errorBody), { status: 400 }));
	};

	const requestGpt54Pro = (sdk: { fetch?: PluginType["fetch"] }) =>
		sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.4-pro" }),
		});

	const setupRemovedAccountThenUnsupportedModel = async () => {
		const accountsModule = await import("../lib/accounts.js");
		const configModule = await import("../lib/config.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");
		setMockManagedAccounts([
			{ accountId: "acc-1", email: "removed@example.com", refreshToken: "refresh-1" },
			{ accountId: "acc-2", email: "unsupported@example.com", refreshToken: "refresh-2" },
			{
				accountId: "acc-3",
				email: "unavailable@example.com",
				refreshToken: "refresh-3",
				selectable: false,
			},
		]);
		vi.mocked(configModule.getUnsupportedCodexPolicy).mockReturnValue("strict");
		vi.mocked(configModule.getFallbackOnUnsupportedCodexModel).mockReturnValue(false);
		vi.mocked(accountsModule.resolveRequestAccountId).mockImplementation(
			(storedId, _source, tokenId) => storedId ?? tokenId,
		);
		vi.mocked(fetchHelpers.transformRequestForCodex).mockResolvedValue({
			updatedInit: {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.4-pro" }),
			},
			body: { model: "gpt-5.4-pro" },
		});
		const invalidTokenBody = { error: { code: "invalid_token" } };
		const unsupportedBody = {
			error: {
				code: "model_not_supported_with_chatgpt_account",
				message:
					"The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
			},
		};
		vi.mocked(fetchHelpers.handleErrorResponse)
			.mockResolvedValueOnce({
				response: new Response(JSON.stringify(invalidTokenBody), { status: 401 }),
				rateLimit: undefined,
				errorBody: invalidTokenBody,
			})
			.mockResolvedValueOnce({
				response: new Response(JSON.stringify(unsupportedBody), { status: 400 }),
				rateLimit: undefined,
				errorBody: unsupportedBody,
			});
		vi.mocked(fetchHelpers.getUnsupportedCodexModelInfo)
			.mockReturnValueOnce({ isUnsupported: false })
			.mockReturnValueOnce({
				isUnsupported: true,
				unsupportedModel: "gpt-5.4-pro",
				message: unsupportedBody.error.message,
				code: unsupportedBody.error.code,
			});
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(invalidTokenBody), { status: 401 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(unsupportedBody), { status: 400 }),
			);
		vi.spyOn(accountsModule.AccountManager.prototype, "incrementAuthFailures")
			.mockReturnValue(999);
		vi.spyOn(
			accountsModule.AccountManager.prototype,
			"removeAccountsWithSameRefreshToken",
		).mockImplementation((account) => {
			const removedIndex = mockManagedAccounts.findIndex(
				(candidate) => candidate.refreshToken === account.refreshToken,
			);
			if (removedIndex < 0) return 0;
			mockManagedAccounts.splice(removedIndex, 1);
			mockManagedAccounts.forEach((candidate, index) => {
				candidate.index = index;
			});
			return 1;
		});
	};

	it("reports actual strict-pool attempts without trying general accounts", async () => {
		const configModule = await import("../lib/config.js");
		await setupUnsupportedModelOnEveryAccount();
		vi.mocked(configModule.getModelAccountPool).mockReturnValue(["acc-1"]);
		vi.mocked(configModule.getModelAccountPoolMode).mockReturnValue("strict");

		const { sdk } = await setupPlugin();
		const response = await requestGpt54Pro(sdk);
		const body = await response.text();

		expect(response.status).toBe(503);
		// acc-2 is a real, healthy, non-pooled account: strict mode must not reach it.
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(body).toContain("strict_pool_unavailable");
		// Pool size is counted over resolved accounts, not over configured keys.
		expect(body).toContain("1 configured pool key(s) resolved to 1 account(s)");
		expect(body).toContain("unsupported on 1 of 1 attempted pooled account(s)");
		expect(body).not.toContain("All 2 account(s)");
	});

	it("counts each legacy Business seat attempted through one workspace pool key", async () => {
		const configModule = await import("../lib/config.js");
		await setupUnsupportedModelOnEveryAccount([
			{
				accountId: "workspace-1",
				accountUserId: "seat-1",
				email: "seat1@example.com",
				refreshToken: "shared-refresh",
			},
			{
				accountId: "workspace-1",
				accountUserId: "seat-2",
				email: "seat2@example.com",
				refreshToken: "shared-refresh",
			},
			{ accountId: "acc-3", email: "general@example.com", refreshToken: "refresh-3" },
		]);
		let fetchCount = 0;
		vi.mocked(globalThis.fetch).mockImplementation(async () => {
			fetchCount++;
			if (fetchCount === 1) {
				// Refresh propagation rotates the shared grant after seat 1 was keyed.
				mockManagedAccounts[0]!.refreshToken = "rotated-refresh";
				mockManagedAccounts[1]!.refreshToken = "rotated-refresh";
			}
			return new Response("{}", { status: 400 });
		});
		vi.mocked(configModule.getModelAccountPool).mockReturnValue(["workspace-1"]);
		vi.mocked(configModule.getModelAccountPoolMode).mockReturnValue("strict");

		const { sdk } = await setupPlugin();
		const response = await requestGpt54Pro(sdk);
		const body = await response.text();

		expect(response.status).toBe(503);
		// The third account keeps the traversal alive long enough to render the
		// strict-pool diagnostic, but strict mode must never send it a request.
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		expect(body).toContain("1 configured pool key(s) resolved to 2 account(s)");
		expect(body).toContain("unsupported on 2 of 2 attempted pooled account(s)");
		expect(body).not.toContain("pooled account(s) were never attempted");
	});

	it("treats an empty strict-pool snapshot as available", async () => {
		const configModule = await import("../lib/config.js");
		setMockManagedAccounts([]);
		vi.mocked(configModule.getModelAccountPool).mockReturnValue(["removed-account"]);
		vi.mocked(configModule.getModelAccountPoolMode).mockReturnValue("strict");
		globalThis.fetch = vi.fn();

		const { sdk } = await setupPlugin();
		const response = await requestGpt54Pro(sdk);
		const body = await response.text();

		expect(response.status).toBe(503);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(body).toContain("1 configured pool key(s) resolved to 0 account(s)");
		expect(body).toContain("1 configured pool key(s) matched no known account");
	});

	it("counts a live unavailable pooled account after a fetched account is removed", async () => {
		const configModule = await import("../lib/config.js");
		await setupRemovedAccountThenUnsupportedModel();
		vi.mocked(configModule.getModelAccountPool).mockReturnValue([
			"acc-1",
			"acc-2",
			"acc-3",
		]);
		vi.mocked(configModule.getModelAccountPoolMode).mockReturnValue("strict");

		const { sdk } = await setupPlugin();
		const response = await requestGpt54Pro(sdk);
		const body = await response.text();

		expect(response.status).toBe(503);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		expect(body).toContain("3 configured pool key(s) resolved to 2 account(s)");
		expect(body).toContain("1 pooled account(s) were never attempted");
	});

	it("counts a live unavailable general account after a fetched account is removed", async () => {
		await setupRemovedAccountThenUnsupportedModel();

		const { sdk } = await setupPlugin();
		const response = await requestGpt54Pro(sdk);
		const body = await response.text();

		expect(response.status).toBe(503);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		expect(body).toContain("across 2 configured account(s)");
		expect(body).toContain("1 configured account(s) were unavailable or excluded");
	});

	it("spills onto the general account when the same pool is preferred, not strict", async () => {
		const configModule = await import("../lib/config.js");
		await setupUnsupportedModelOnEveryAccount();
		vi.mocked(configModule.getModelAccountPool).mockReturnValue(["acc-1"]);
		vi.mocked(configModule.getModelAccountPoolMode).mockReturnValue("preferred");

		const { sdk } = await setupPlugin();
		const response = await requestGpt54Pro(sdk);
		const body = await response.text();

		// The pool mode is the only difference from the strict test above: here the
		// traversal reaches acc-2 and the upstream rejection is what surfaces.
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		expect(response.status).toBe(400);
		expect(body).not.toContain("strict_pool_unavailable");
	});

	it("names an unresolved strict-pool key instead of counting it as an account", async () => {
		const configModule = await import("../lib/config.js");
		await setupUnsupportedModelOnEveryAccount();
		vi.mocked(configModule.getModelAccountPool).mockReturnValue([
			"acc-1",
			"typo-account-id",
		]);
		vi.mocked(configModule.getModelAccountPoolMode).mockReturnValue("strict");

		const { sdk } = await setupPlugin();
		const response = await requestGpt54Pro(sdk);
		const body = await response.text();

		expect(response.status).toBe(503);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(body).toContain("2 configured pool key(s) resolved to 1 account(s)");
		expect(body).toContain("1 configured pool key(s) matched no known account");
		// The unresolved key is not an account, so it must not inflate this count.
		expect(body).not.toContain("pooled account(s) were never attempted");
	});

	it("reports how many general accounts the backend rejected the model on", async () => {
		// acc-2 is configured but not selectable (rate-limited or cooling down), so
		// the traversal ends with one account attempted out of two configured.
		await setupUnsupportedModelOnEveryAccount([
			{ accountId: "acc-1", email: "user1@example.com", refreshToken: "refresh-1" },
			{
				accountId: "acc-2",
				email: "user2@example.com",
				refreshToken: "refresh-2",
				selectable: false,
			},
		]);

		const { sdk } = await setupPlugin();
		const response = await requestGpt54Pro(sdk);
		const body = await response.text();

		expect(response.status).toBe(503);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(body).toContain(
			"No selectable account succeeded for the requested model across 2 configured account(s)",
		);
		expect(body).toContain(
			"rejected 'gpt-5.4-pro' as not entitled for Codex OAuth on 1 of 1 attempted account(s)",
		);
		expect(body).toContain("1 configured account(s) were unavailable or excluded");
	});

	it("does not reuse the previous request's entitlement failure when nothing was attempted", async () => {
		await setupUnsupportedModelOnEveryAccount([
			{ accountId: "acc-1", email: "user1@example.com", refreshToken: "refresh-1" },
			{
				accountId: "acc-2",
				email: "user2@example.com",
				refreshToken: "refresh-2",
				selectable: false,
			},
		]);

		const { sdk } = await setupPlugin();
		// The first request ends in entitlement exhaustion, leaving
		// runtimeMetrics.lastErrorCategory = "unsupported-model". runtimeMetrics is
		// plugin-scoped, so that value survives into the next request.
		await requestGpt54Pro(sdk);

		// The second request never reaches an account at all, so it must not inherit
		// the previous request's entitlement verdict — nor render it as "0 of 0".
		setMockManagedAccounts([
			{
				accountId: "acc-1",
				email: "user1@example.com",
				refreshToken: "refresh-1",
				selectable: false,
			},
			{
				accountId: "acc-2",
				email: "user2@example.com",
				refreshToken: "refresh-2",
				selectable: false,
			},
		]);
		const response = await requestGpt54Pro(sdk);
		const body = await response.text();

		expect(response.status).toBe(503);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(body).not.toContain("0 of 0");
		expect(body).not.toContain("not entitled for Codex OAuth");
		expect(body).toContain("All 2 account(s) failed");
	});

	it("falls back from gpt-5.3-codex to gpt-5.2-codex when unsupported fallback is enabled", async () => {
		const configModule = await import("../lib/config.js");
		const fetchHelpers = await import("../lib/request/fetch-helpers.js");

		vi.mocked(configModule.getFallbackOnUnsupportedCodexModel).mockReturnValueOnce(true);
		vi.mocked(configModule.getFallbackToGpt52OnUnsupportedGpt53).mockReturnValueOnce(true);
		vi.mocked(fetchHelpers.transformRequestForCodex).mockResolvedValueOnce({
			updatedInit: {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.3-codex" }),
			},
			body: { model: "gpt-5.3-codex" },
		});
		vi.mocked(fetchHelpers.handleErrorResponse).mockResolvedValueOnce({
			response: new Response(
				JSON.stringify({
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message:
							"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				}),
				{ status: 400 },
			),
			rateLimit: undefined,
			errorBody: {
				error: {
					code: "model_not_supported_with_chatgpt_account",
					message:
						"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
				},
			},
		});
		vi.mocked(fetchHelpers.resolveUnsupportedCodexFallbackModel).mockReturnValueOnce("gpt-5.2-codex");

		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("bad", { status: 400 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.3-codex" }),
		});

		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		const firstInit = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
		const secondInit = vi.mocked(globalThis.fetch).mock.calls[1]?.[1] as RequestInit;
		expect(JSON.parse(firstInit.body as string).model).toBe("gpt-5.3-codex");
		expect(JSON.parse(secondInit.body as string).model).toBe("gpt-5.2-codex");
	});

		it("cascades Spark fallback from gpt-5.3-codex-spark -> gpt-5.3-codex -> gpt-5.2-codex", async () => {
			const configModule = await import("../lib/config.js");
			const fetchHelpers = await import("../lib/request/fetch-helpers.js");

		vi.mocked(configModule.getFallbackOnUnsupportedCodexModel).mockReturnValueOnce(true);
		vi.mocked(configModule.getFallbackToGpt52OnUnsupportedGpt53).mockReturnValueOnce(true);
		vi.mocked(fetchHelpers.transformRequestForCodex).mockResolvedValueOnce({
			updatedInit: {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.3-codex-spark" }),
			},
			body: { model: "gpt-5.3-codex-spark" },
		});
		vi.mocked(fetchHelpers.handleErrorResponse)
			.mockResolvedValueOnce({
				response: new Response(JSON.stringify({ error: { code: "model_not_supported_with_chatgpt_account" } }), { status: 400 }),
				rateLimit: undefined,
				errorBody: {
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message:
							"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
					},
				},
			})
			.mockResolvedValueOnce({
				response: new Response(JSON.stringify({ error: { code: "model_not_supported_with_chatgpt_account" } }), { status: 400 }),
				rateLimit: undefined,
				errorBody: {
					error: {
						code: "model_not_supported_with_chatgpt_account",
						message:
							"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
			});
		vi.mocked(fetchHelpers.resolveUnsupportedCodexFallbackModel)
			.mockReturnValueOnce("gpt-5.3-codex")
			.mockReturnValueOnce("gpt-5.2-codex");

		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("bad", { status: 400 }))
			.mockResolvedValueOnce(new Response("still bad", { status: 400 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: "ok" }), { status: 200 }));

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.3-codex-spark" }),
		});

		expect(response.status).toBe(200);
		expect(globalThis.fetch).toHaveBeenCalledTimes(3);
		const firstInit = vi.mocked(globalThis.fetch).mock.calls[0]?.[1] as RequestInit;
		const secondInit = vi.mocked(globalThis.fetch).mock.calls[1]?.[1] as RequestInit;
		const thirdInit = vi.mocked(globalThis.fetch).mock.calls[2]?.[1] as RequestInit;
		expect(JSON.parse(firstInit.body as string).model).toBe("gpt-5.3-codex-spark");
			expect(JSON.parse(secondInit.body as string).model).toBe("gpt-5.3-codex");
			expect(JSON.parse(thirdInit.body as string).model).toBe("gpt-5.2-codex");
		});

		it("restarts account traversal after fallback model switch", async () => {
			const configModule = await import("../lib/config.js");
			const fetchHelpers = await import("../lib/request/fetch-helpers.js");
			const { AccountManager } = await import("../lib/accounts.js");

			const accountOne = {
				index: 0,
				accountId: "acc-1",
				email: "user1@example.com",
				refreshToken: "refresh-1",
			};
			const accountTwo = {
				index: 1,
				accountId: "acc-2",
				email: "user2@example.com",
				refreshToken: "refresh-2",
			};

			let legacySelection = 0;
			let fallbackSelection = 0;
			const selectHybrid = (_family: string, currentModel?: string) => {
				if (currentModel === "gpt-5-codex") {
					if (fallbackSelection === 0) {
						fallbackSelection++;
						return accountOne;
					}
					if (fallbackSelection === 1) {
						fallbackSelection++;
						return accountTwo;
					}
					return null;
				}
				if (legacySelection === 0) {
					legacySelection++;
					return accountOne;
				}
				if (legacySelection === 1) {
					legacySelection++;
					return accountTwo;
				}
				return null;
			};
			const customManager = {
				getAccountCount: () => 2,
				getCurrentOrNextForFamilyHybrid: selectHybrid,
				getAccountForStrategy: (
					_strategy: string,
					family: string,
					model?: string,
				) => selectHybrid(family, model),
				getSelectionExplainability: () => [
					{
						index: 0,
						enabled: true,
						isCurrentForFamily: true,
						eligible: true,
						reasons: ["eligible"],
						healthScore: 100,
						tokensAvailable: 50,
						lastUsed: Date.now(),
					},
					{
						index: 1,
						enabled: true,
						isCurrentForFamily: false,
						eligible: true,
						reasons: ["eligible"],
						healthScore: 100,
						tokensAvailable: 50,
						lastUsed: Date.now(),
					},
				],
				toAuthDetails: (account: { accountId?: string }) => ({
					type: "oauth" as const,
					access: `access-${account.accountId ?? "unknown"}`,
					refresh: "refresh-token",
					expires: Date.now() + 60_000,
				}),
				hasRefreshToken: () => true,
				saveToDiskDebounced: () => {},
				updateFromAuth: () => {},
				clearAuthFailures: () => {},
				incrementAuthFailures: () => 1,
				markAccountCoolingDown: () => {},
				markRateLimitedWithReason: () => {},
				recordRateLimit: () => {},
				consumeToken: () => true,
				refundToken: () => {},
				markSwitched: () => {},
				removeAccount: () => {},
				recordFailure: () => {},
				recordSuccess: () => {},
				getMinWaitTimeForFamily: () => 0,
				shouldShowAccountToast: () => false,
				markToastShown: () => {},
				setActiveIndex: () => accountOne,
				getAccountsSnapshot: () => [accountOne, accountTwo],
			};
			vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(customManager as never);

			vi.mocked(configModule.getFallbackOnUnsupportedCodexModel).mockReturnValueOnce(true);
			vi.mocked(configModule.getFallbackToGpt52OnUnsupportedGpt53).mockReturnValueOnce(true);
			vi.mocked(fetchHelpers.transformRequestForCodex).mockResolvedValueOnce({
				updatedInit: {
					method: "POST",
					body: JSON.stringify({ model: "gpt-5.3-codex" }),
				},
				body: { model: "gpt-5.3-codex" },
			});
			vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation(
				(_init, _accountId, accessToken) =>
					new Headers({ "x-test-access-token": String(accessToken) }),
			);
			vi.mocked(fetchHelpers.handleErrorResponse).mockImplementation(async (response) => {
				const errorBody = await response.clone().json().catch(() => ({}));
				return { response, rateLimit: undefined, errorBody };
			});
			vi.mocked(fetchHelpers.getUnsupportedCodexModelInfo).mockImplementation((errorBody: unknown) => {
				const message = (errorBody as { error?: { message?: string } })?.error?.message ?? "";
				if (!/not supported when using codex with a chatgpt account/i.test(message)) {
					return { isUnsupported: false };
				}
				const match = message.match(/'([^']+)'/);
				return {
					isUnsupported: true,
					unsupportedModel: match?.[1],
					message,
					code: "model_not_supported_with_chatgpt_account",
				};
			});
			vi.mocked(fetchHelpers.resolveUnsupportedCodexFallbackModel).mockImplementation(({ requestedModel }) => {
				return requestedModel === "gpt-5.3-codex" ? "gpt-5-codex" : undefined;
			});

			globalThis.fetch = vi.fn(async (_url, init) => {
				const body =
					init && typeof init.body === "string"
						? (JSON.parse(init.body) as { model?: string })
						: {};
				const headers = new Headers(init?.headers);
				const accessToken = headers.get("x-test-access-token");

				if (body.model === "gpt-5.3-codex") {
					return new Response(
						JSON.stringify({
							error: {
								code: "model_not_supported_with_chatgpt_account",
								message:
									"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
							},
						}),
						{ status: 400 },
					);
				}

				if (body.model === "gpt-5-codex" && accessToken === "access-account-1") {
					return new Response(JSON.stringify({ content: "ok" }), { status: 200 });
				}

				return new Response(
					JSON.stringify({
						error: {
							code: "model_not_supported_with_chatgpt_account",
							message:
								"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
						},
					}),
					{ status: 400 },
				);
			});

			const { sdk } = await setupPlugin();
			const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.3-codex" }),
			});

			const fetchCalls = vi.mocked(globalThis.fetch).mock.calls.map((call) => {
				const init = call[1] as RequestInit;
				const body =
					typeof init.body === "string"
						? (JSON.parse(init.body) as { model?: string })
						: {};
				const headers = new Headers(init.headers);
				return {
					model: body.model,
					accessToken: headers.get("x-test-access-token"),
				};
			});
			expect(fetchCalls).toEqual([
				{ model: "gpt-5.3-codex", accessToken: "access-acc-1" },
				{ model: "gpt-5.3-codex", accessToken: "access-acc-2" },
				{ model: "gpt-5-codex", accessToken: "access-account-1" },
			]);
			expect(response.status).toBe(200);
		});

		it("removes only the deactivated workspace (not refresh-token siblings) and fails over to a healthy account", async () => {
			const fetchHelpers = await import("../lib/request/fetch-helpers.js");
			const storageModule = await import("../lib/storage.js");
			const accountsModule = await import("../lib/accounts.js");
			const { AccountManager } = accountsModule;

			const deadWorkspace = {
				index: 0,
				accountId: "org-dead",
				organizationId: "org-dead",
				accountIdSource: "org",
				accountLabel: "Dead workspace",
				email: "same@example.com",
				refreshToken: "shared-refresh",
			};
			const duplicateWorkspace = {
				index: 1,
				accountId: "org-dead-duplicate",
				organizationId: "org-dead-duplicate",
				accountIdSource: "org",
				accountLabel: "Duplicate dead workspace",
				email: "same@example.com",
				refreshToken: "shared-refresh",
			};
			const healthyFallback = {
				index: 2,
				accountId: "org-live",
				organizationId: "org-live",
				accountIdSource: "org",
				accountLabel: "Live workspace",
				email: "live@example.com",
				refreshToken: "healthy-refresh",
			};

			const accounts = [deadWorkspace, duplicateWorkspace, healthyFallback];
			const removeAccount = vi.fn((target: typeof deadWorkspace) => {
				const idx = accounts.findIndex((account) => account.accountId === target.accountId);
				if (idx < 0) return false;
				accounts.splice(idx, 1);
				accounts.forEach((account, index) => {
					account.index = index;
				});
				return true;
			});
			const removeAccountsWithSameRefreshToken = vi.fn((target: typeof deadWorkspace) => {
				const nextAccounts = accounts.filter((account) => account.refreshToken !== target.refreshToken);
				const removedCount = accounts.length - nextAccounts.length;
				accounts.splice(0, accounts.length, ...nextAccounts);
				accounts.forEach((account, index) => {
					account.index = index;
				});
				return removedCount;
			});
			// Workspace-scoped removal: drops only the account(s) matching the
			// failing workspace's org/account identity, leaving refresh-token
			// siblings (distinct workspaces) intact.
			const removeAccountsByWorkspaceIdentity = vi.fn((target: typeof deadWorkspace) => {
				const nextAccounts = accounts.filter(
					(account) =>
						!(
							account.organizationId === target.organizationId &&
							account.accountId === target.accountId
						),
				);
				const removedCount = accounts.length - nextAccounts.length;
				accounts.splice(0, accounts.length, ...nextAccounts);
				accounts.forEach((account, index) => {
					account.index = index;
				});
				return removedCount;
			});

			const customManager = {
				getAccountCount: () => accounts.length,
				getCurrentOrNextForFamilyHybrid: () => accounts[0] ?? null,
				getAccountForStrategy: () => accounts[0] ?? null,
				getSelectionExplainability: () =>
					accounts.map((account, index) => ({
						index,
						enabled: true,
						isCurrentForFamily: index === 0,
						eligible: true,
						reasons: ["eligible"],
						healthScore: 100,
						tokensAvailable: 50,
						lastUsed: Date.now(),
					})),
				toAuthDetails: (account: typeof deadWorkspace) => ({
					type: "oauth" as const,
					access: `access-${account.accountId}`,
					refresh: account.refreshToken,
					expires: Date.now() + 60_000,
				}),
				hasRefreshToken: () => true,
				saveToDiskDebounced: vi.fn(),
				updateFromAuth: vi.fn(),
				clearAuthFailures: vi.fn(),
				incrementAuthFailures: vi.fn(() => 1),
				markAccountCoolingDown: vi.fn(),
				markRateLimitedWithReason: vi.fn(),
				recordRateLimit: vi.fn(),
				consumeToken: vi.fn(() => true),
				refundToken: vi.fn(),
				markSwitched: vi.fn(),
				removeAccount,
				removeAccountsWithSameRefreshToken,
				removeAccountsByWorkspaceIdentity,
				recordFailure: vi.fn(),
				recordSuccess: vi.fn(),
				getMinWaitTimeForFamily: vi.fn(() => 0),
				shouldShowAccountToast: vi.fn(() => false),
				markToastShown: vi.fn(),
				setActiveIndex: vi.fn(() => accounts[0] ?? null),
				getAccountsSnapshot: vi.fn(() => [...accounts]),
			};
			vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(customManager as never);
			vi.mocked(accountsModule.extractAccountId).mockImplementation((token?: string) => {
				if (token === "access-org-dead") return "org-dead";
				if (token === "access-org-live") return "org-live";
				return "account-1";
			});

			vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation(
				(_init, _accountId, accessToken) =>
					new Headers({ "x-test-access-token": String(accessToken) }),
			);
			vi.mocked(fetchHelpers.handleErrorResponse).mockImplementation(async (response) => {
				const errorBody = await response.clone().json().catch(() => ({}));
				return { response, rateLimit: undefined, errorBody };
			});

			globalThis.fetch = vi.fn(async (_url, init) => {
				const headers = new Headers(init?.headers);
				const accessToken = headers.get("x-test-access-token");
				if (accessToken === "access-org-dead") {
					return new Response(JSON.stringify({
						error: { code: "deactivated_workspace", message: "workspace dead" },
						detail: { code: "deactivated_workspace", message: "workspace dead" },
					}), {
						status: 402,
					});
				}
				return new Response(JSON.stringify({ content: "ok" }), { status: 200 });
			});

			const { sdk } = await setupPlugin();
			const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			});

			expect(response.status).toBe(200);
			expect(globalThis.fetch).toHaveBeenCalledTimes(2);
			expect(removeAccount).not.toHaveBeenCalled();
			// Only the deactivated workspace is removed by identity; refresh-token
			// siblings (distinct workspaces) must survive in rotation.
			expect(removeAccountsWithSameRefreshToken).not.toHaveBeenCalled();
			expect(removeAccountsByWorkspaceIdentity).toHaveBeenCalledTimes(1);
			// Only the deactivated workspace (org-dead) is removed by identity; the
			// refresh-token sibling survives. Its accountId is re-derived by the
			// retry path's extractAccountId mock (-> "account-1").
			expect(accounts.map((account) => account.accountId)).toEqual([
				"account-1",
				"org-live",
			]);
			expect(vi.mocked(storageModule.withFlaggedAccountStorageTransaction)).toHaveBeenCalledTimes(1);
			expect(mockFlaggedStorage.accounts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						accountId: "org-dead",
						organizationId: "org-dead",
						flaggedReason: "workspace-deactivated",
						lastError: "deactivated_workspace",
					}),
				]),
			);
		});

		it("cools down the deactivated workspace when grouped removal returns zero", async () => {
			const fetchHelpers = await import("../lib/request/fetch-helpers.js");
			const storageModule = await import("../lib/storage.js");
			const accountsModule = await import("../lib/accounts.js");
			const { AccountManager } = accountsModule;

			const deadWorkspace = {
				index: 0,
				accountId: "org-dead",
				organizationId: "org-dead",
				accountIdSource: "org",
				accountLabel: "Dead workspace",
				email: "same@example.com",
				refreshToken: "shared-refresh",
			};

			const markAccountCoolingDown = vi.fn();
			const saveToDiskDebounced = vi.fn();
			const removeAccountsWithSameRefreshToken = vi.fn(() => 0);
			const removeAccountsByWorkspaceIdentity = vi.fn(() => 0);
			const customManager = {
				getAccountCount: () => 1,
				getCurrentOrNextForFamilyHybrid: () => deadWorkspace,
				getAccountForStrategy: () => deadWorkspace,
				getSelectionExplainability: () => [
					{
						index: 0,
						enabled: true,
						isCurrentForFamily: true,
						eligible: true,
						reasons: ["eligible"],
						healthScore: 100,
						tokensAvailable: 50,
						lastUsed: Date.now(),
					},
				],
				toAuthDetails: () => ({
					type: "oauth" as const,
					access: "access-org-dead",
					refresh: deadWorkspace.refreshToken,
					expires: Date.now() + 60_000,
				}),
				hasRefreshToken: () => true,
				saveToDiskDebounced,
				updateFromAuth: vi.fn(),
				clearAuthFailures: vi.fn(),
				incrementAuthFailures: vi.fn(() => 1),
				markAccountCoolingDown,
				markRateLimitedWithReason: vi.fn(),
				recordRateLimit: vi.fn(),
				consumeToken: vi.fn(() => true),
				refundToken: vi.fn(),
				markSwitched: vi.fn(),
				removeAccount: vi.fn(() => false),
				removeAccountsWithSameRefreshToken,
				removeAccountsByWorkspaceIdentity,
				recordFailure: vi.fn(),
				recordSuccess: vi.fn(),
				getMinWaitTimeForFamily: vi.fn(() => 0),
				shouldShowAccountToast: vi.fn(() => false),
				markToastShown: vi.fn(),
				setActiveIndex: vi.fn(() => deadWorkspace),
				getAccountsSnapshot: vi.fn(() => [deadWorkspace]),
			};
			vi.spyOn(AccountManager, "loadFromDisk").mockResolvedValueOnce(customManager as never);
			vi.mocked(accountsModule.extractAccountId).mockReturnValue("org-dead");
			vi.mocked(fetchHelpers.createCodexHeaders).mockImplementation(
				(_init, _accountId, accessToken) =>
					new Headers({ "x-test-access-token": String(accessToken) }),
			);
			vi.mocked(fetchHelpers.handleErrorResponse).mockImplementation(async (response) => {
				const errorBody = await response.clone().json().catch(() => ({}));
				return { response, rateLimit: undefined, errorBody };
			});

			globalThis.fetch = vi.fn(async () =>
				new Response(JSON.stringify({
					error: { code: "deactivated_workspace", message: "workspace dead" },
					detail: { code: "deactivated_workspace", message: "workspace dead" },
				}), {
					status: 402,
				}),
			);

			const { sdk } = await setupPlugin();
			const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5.1" }),
			});
			const body = await response.json();

			expect(response.status).toBe(503);
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
			expect(removeAccountsByWorkspaceIdentity).toHaveBeenCalledTimes(1);
			expect(markAccountCoolingDown).toHaveBeenCalledWith(
				deadWorkspace,
				expect.any(Number),
				"auth-failure",
			);
			expect(saveToDiskDebounced).toHaveBeenCalledTimes(2);
			expect(body).toEqual({
				error: {
					message: "All 1 account(s) failed (server errors or auth issues). Check account health with `codex-health`.",
				},
			});
		});

		it("handles empty body in request", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ content: "test" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {});

		expect(response.status).toBe(200);
	});

	it("handles malformed JSON body gracefully", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "test" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: "not-valid-json{",
		});

		expect(response.status).toBe(200);
	});

	it("handles abort signal during fetch", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "test" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const controller = new AbortController();

		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1" }),
			signal: controller.signal,
		});

		expect(response.status).toBe(200);
	});

	it("handles streaming request (stream=true in body)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ content: "test" }), { status: 200 }),
		);

		const { sdk } = await setupPlugin();
		const response = await sdk.fetch!("https://api.openai.com/v1/chat", {
			method: "POST",
			body: JSON.stringify({ model: "gpt-5.1", stream: true }),
		});

		expect(response.status).toBe(200);
	});
});

describe("OpenAIOAuthPlugin resolveAccountSelection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStorage.accounts = [];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
		delete process.env.CODEX_AUTH_ACCOUNT_ID;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.CODEX_AUTH_ACCOUNT_ID;
	});

	it("uses CODEX_AUTH_ACCOUNT_ID environment override", async () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "override-account-12345";

		mockStorage.accounts = [
			{ accountId: "acc-1", email: "user@example.com", refreshToken: "refresh-1" },
		];

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = await plugin.auth.loader(getAuth, { options: {}, models: {} });
		expect(sdk.fetch).toBeDefined();
	});

	it("uses short CODEX_AUTH_ACCOUNT_ID override", async () => {
		process.env.CODEX_AUTH_ACCOUNT_ID = "short";

		mockStorage.accounts = [
			{ accountId: "acc-1", email: "user@example.com", refreshToken: "refresh-1" },
		];

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		const sdk = await plugin.auth.loader(getAuth, { options: {}, models: {} });
		expect(sdk.fetch).toBeDefined();
	});
});

describe("OpenAIOAuthPlugin persistAccountPool", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStorage.accounts = [];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
		delete process.env.CODEX_AUTH_ACCOUNT_ID;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("handles existing account update by refreshToken", async () => {
		mockStorage.accounts = [
			{
				accountId: "acc-1",
				email: "old@example.com",
				refreshToken: "refresh-1",
				addedAt: Date.now() - 100000,
			},
		];

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		await OpenAIOAuthPlugin({ client: mockClient } as never);

		expect(mockStorage.accounts).toHaveLength(1);
	});

	it("handles existing account update by accountId", async () => {
		mockStorage.accounts = [
			{
				accountId: "acc-existing",
				email: "old@example.com",
				refreshToken: "old-refresh",
				addedAt: Date.now() - 100000,
			},
		];

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		await OpenAIOAuthPlugin({ client: mockClient } as never);

		expect(mockStorage.accounts).toHaveLength(1);
	});

	it("persists one token-scoped account per login instead of one per organization", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const authModule = await import("../lib/auth/auth.js");

		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-multi",
			refresh: "refresh-multi",
			expires: Date.now() + 300_000,
			idToken: "id-multi",
		});
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValueOnce([
			{ accountId: "token-personal", source: "token", label: "Token Personal [id:sonal]", organizationId: "org-personal" },
			{ accountId: "org-default", source: "org", label: "Workspace Alpha [id:fault]", organizationId: "org-default" },
			{ accountId: "id-secondary", source: "id_token", label: "Workspace Beta [id:ndary]", organizationId: "org-secondary" },
		]);
		vi.mocked(accountsModule.selectBestAccountCandidate).mockImplementationOnce((candidates) =>
			candidates.find((candidate) => candidate.accountId === "org-default") ?? candidates[0],
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });

		// Every candidate shares this login's single OAuth token, so persisting
		// one entry per organization produced N rows that all drew from the same
		// quota pool (#226). Only the token-scoped id routes.
		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts[0]?.accountId).toBe("token-personal");
		expect(mockStorage.accounts[0]?.accountIdSource).toBe("token");
		// The candidate name is an API-platform organization, not a ChatGPT
		// workspace, so no label is generated from it. Email and account id are
		// already stored as their own fields and rendered from there, masked.
		expect(mockStorage.accounts[0]?.accountLabel).toBeUndefined();
		expect(mockStorage.accounts[0]?.email).toBe("user@example.com");
		// organizationId is display/dedupe metadata only - it is not sent as a
		// header unless CODEX_AUTH_SEND_ORGANIZATION_HEADER=1.
		expect(mockStorage.accounts[0]?.organizationId).toBe("org-default");
		expect(mockStorage.activeIndex).toBe(0);
	});

	it("binds the login to the token account even when the best candidate is an organization", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const authModule = await import("../lib/auth/auth.js");

		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-two",
			refresh: "refresh-two",
			expires: Date.now() + 300_000,
			idToken: "id-two",
		});
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValueOnce([
			{ accountId: "token-first", source: "token", label: "Token First [id:first]", organizationId: "org-token" },
			{ accountId: "org-preferred", source: "org", label: "Org Preferred [id:ferred]", organizationId: "org-preferred" },
		]);
		vi.mocked(accountsModule.selectBestAccountCandidate).mockImplementationOnce((candidates) =>
			candidates.find((candidate) => candidate.accountId === "org-preferred") ?? candidates[0],
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });

		expect(mockStorage.accounts.map((account) => account.accountId)).toEqual([
			"token-first",
		]);
		expect(mockStorage.accounts[0]?.accountIdSource).toBe("token");
		// The preferred organization still supplies the org id, but not the name.
		expect(mockStorage.accounts[0]?.organizationId).toBe("org-preferred");
		expect(mockStorage.accounts[0]?.accountLabel).toBeUndefined();
	});

	it("collapses duplicate organization candidates onto the single token account", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const authModule = await import("../lib/auth/auth.js");

		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-org-dup",
			refresh: "refresh-org-dup",
			expires: Date.now() + 300_000,
			idToken: "id-org-dup",
		});
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValueOnce([
			{
				accountId: "org-variant-a",
				organizationId: "organization-shared",
				source: "org",
				label: "Org Shared A [id:ared-a]",
			},
			{
				accountId: "org-variant-b",
				organizationId: "organization-shared",
				source: "org",
				label: "Org Shared B [id:ared-b]",
			},
			{ accountId: "token-personal", source: "token", label: "Token [id:sonal]" },
		]);
		vi.mocked(accountsModule.selectBestAccountCandidate).mockImplementationOnce((candidates) =>
			candidates.find((candidate) => candidate.accountId === "org-variant-a") ?? candidates[0],
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });

		// Two org rows under one organization are two views of the same
		// subscription, not two quotas.
		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts[0]?.accountId).toBe("token-personal");
		expect(mockStorage.accounts[0]?.organizationId).toBe("organization-shared");
		expect(mockStorage.accounts[0]?.accountLabel).toBeUndefined();
	});

	it("persists a single token-scoped entry when a login yields org and token candidates", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const authModule = await import("../lib/auth/auth.js");

// Simulate a single OAuth login that produces an org candidate + a token
		// candidate. They share one refresh token because they are one login, so
		// they can only ever reach one quota pool - persisting both produced the
		// duplicate rows with identical quota reported in #226.
		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-holly",
			refresh: "refresh-holly-shared",
			expires: Date.now() + 300_000,
			idToken: "id-holly",
		});
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValueOnce([
			{
				accountId: "org-QA1bZCn6zb57FT6TXLZWMPO3",
				organizationId: "org-QA1bZCn6zb57FT6TXLZWMPO3",
				source: "org",
				label: "Personal (role:owner) [id:ZWMPO3]",
				isPersonal: true,
			},
			{
				accountId: "e4692e53-2f30-42a0-b8df-3a685d3c2a4a",
				source: "token",
				label: "Token account [id:3c2a4a]",
				isDefault: true,
			},
		]);
		vi.mocked(accountsModule.selectBestAccountCandidate).mockImplementationOnce((candidates) =>
			candidates.find((c) => c.source === "org") ?? candidates[0],
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });

		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts[0]?.accountId).toBe(
			"e4692e53-2f30-42a0-b8df-3a685d3c2a4a",
		);
		expect(mockStorage.accounts[0]?.accountIdSource).toBe("token");
		expect(mockStorage.accounts[0]?.organizationId).toBe(
			"org-QA1bZCn6zb57FT6TXLZWMPO3",
		);
		// "Personal (role:owner)" is the API org's own name and role, which named
		// every ChatGPT account this way regardless of its real subscription. No
		// label replaces it: the email and account id fields already carry the
		// identity, and every surface renders them.
		expect(mockStorage.accounts[0]?.accountLabel).toBeUndefined();
		expect(mockStorage.accounts[0]?.refreshToken).toBe("refresh-holly-shared");
	});

	it("updates a unique org-scoped entry when later login lacks organization metadata", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const authModule = await import("../lib/auth/auth.js");

		vi.mocked(authModule.exchangeAuthorizationCode)
			.mockResolvedValueOnce({
				type: "success",
				access: "access-org-initial",
				refresh: "refresh-unique",
				expires: Date.now() + 300_000,
				idToken: "id-org-initial",
			})
			.mockResolvedValueOnce({
				type: "success",
				access: "access-no-org-update",
				refresh: "refresh-unique",
				expires: Date.now() + 300_000,
				idToken: "id-no-org-update",
			});
		vi.mocked(accountsModule.getAccountIdCandidates)
			.mockReturnValueOnce([
				{
					accountId: "shared-account",
					organizationId: "org-unique",
					source: "org",
					label: "Workspace Unique [id:nique]",
				},
			])
			.mockReturnValueOnce([]);
		vi.mocked(accountsModule.selectBestAccountCandidate).mockImplementation(
			(candidates) => candidates[0],
		);
		vi.mocked(accountsModule.extractAccountId).mockImplementation((accessToken) =>
			accessToken === "access-no-org-update" ? "shared-account" : "account-1",
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = (await OpenAIOAuthPlugin({
			client: mockClient,
		} as never)) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });
		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });

		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts[0]?.organizationId).toBe("org-unique");
		expect(mockStorage.accounts[0]?.accountId).toBe("shared-account");
		expect(mockStorage.accounts[0]?.accessToken).toBe("access-no-org-update");
	});

	it("preserves org-scoped variants when organizationId differs despite shared account/refresh context", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const authModule = await import("../lib/auth/auth.js");

		mockStorage.accounts = [
			{
				organizationId: "org-a",
				accountId: "shared-account",
				email: "user@example.com",
				refreshToken: "shared-refresh",
				addedAt: Date.now() - 20_000,
				lastUsed: Date.now() - 20_000,
			},
			{
				organizationId: "org-b",
				accountId: "shared-account",
				email: "user@example.com",
				refreshToken: "shared-refresh",
				addedAt: Date.now() - 10_000,
				lastUsed: Date.now() - 10_000,
			},
		];

		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-ambiguous",
			refresh: "shared-refresh",
			expires: Date.now() + 300_000,
			idToken: "id-ambiguous",
		});
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValueOnce([]);
		vi.mocked(accountsModule.extractAccountId).mockImplementation((accessToken) =>
			accessToken === "access-ambiguous" ? "shared-account" : "account-1",
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = (await OpenAIOAuthPlugin({
			client: mockClient,
		} as never)) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });

		expect(mockStorage.accounts).toHaveLength(2);
		const orgScopedEntries = mockStorage.accounts.filter((account) => account.organizationId);
		expect(orgScopedEntries).toHaveLength(2);
		expect(orgScopedEntries.map((account) => account.organizationId).sort()).toEqual([
			"org-a",
			"org-b",
		]);
		expect(orgScopedEntries.some((account) => account.accessToken === "access-ambiguous")).toBe(true);
		expect(mockStorage.activeIndex).toBe(0);
		expect(mockStorage.activeIndexByFamily).toEqual({});
	});

	it("preserves entries with different accountId values even when they share the same refresh token (org-scoped vs no-org)", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const authModule = await import("../lib/auth/auth.js");

		mockStorage.accounts = [
			{
				accountId: "other-a",
				email: "other-a@example.com",
				refreshToken: "refresh-a",
				addedAt: 1,
				lastUsed: 1,
			},
			{
				accountId: "org-shared",
				organizationId: "org-keep",
				email: "org@example.com",
				refreshToken: "shared-refresh",
				addedAt: 5,
				lastUsed: 5,
			},
			{
				accountId: "token-shared",
				email: "token@example.com",
				refreshToken: "shared-refresh",
				addedAt: 10,
				lastUsed: 10,
			},
			{
				accountId: "other-b",
				email: "other-b@example.com",
				refreshToken: "refresh-b",
				addedAt: 2,
				lastUsed: 2,
			},
		];
		mockStorage.activeIndex = 2;
		mockStorage.activeIndexByFamily = { codex: 2, "gpt-5.1": 2 };

		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-other-a",
			refresh: "refresh-a",
			expires: Date.now() + 300_000,
			idToken: "id-other-a",
		});
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValueOnce([]);
		vi.mocked(accountsModule.extractAccountId).mockImplementation((accessToken) =>
			accessToken === "access-other-a" ? "other-a" : "account-1",
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = (await OpenAIOAuthPlugin({
			client: mockClient,
		} as never)) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });

		// accountId values differ ("org-shared" vs "token-shared") so both should be preserved
		// despite sharing the same refreshToken. Active index should still be remapped correctly.
		expect(mockStorage.accounts).toHaveLength(4);
		const accountIds = mockStorage.accounts.map((account) => account.accountId);
		expect(accountIds).toContain("org-shared");
		expect(accountIds).toContain("token-shared");
		expect(mockStorage.activeIndex).toBe(2);
		expect(mockStorage.activeIndexByFamily).toEqual({ codex: 2, "gpt-5.1": 2 });
	});

	it("keeps latest rate-limit reset windows when collapsing same-organization duplicates", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const authModule = await import("../lib/auth/auth.js");

		mockStorage.accounts = [
			{
				accountId: "org-shared",
				organizationId: "org-keep",
				email: "org@example.com",
				refreshToken: "shared-refresh",
				addedAt: 10,
				lastUsed: 10,
				rateLimitResetTimes: {
					codex: 1_000,
					"codex-max": 5_000,
				},
			},
			{
				accountId: "org-shared",
				organizationId: "org-keep",
				email: "token@example.com",
				refreshToken: "shared-refresh",
				addedAt: 20,
				lastUsed: 20,
				rateLimitResetTimes: {
					codex: 9_000,
					"gpt-5.1": 8_000,
				},
			},
		];

		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-unrelated",
			refresh: "refresh-unrelated",
			expires: Date.now() + 300_000,
			idToken: "id-unrelated",
		});
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValueOnce([]);
		vi.mocked(accountsModule.extractAccountId).mockImplementation((accessToken) =>
			accessToken === "access-unrelated" ? "unrelated" : "account-1",
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = (await OpenAIOAuthPlugin({
			client: mockClient,
		} as never)) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });

		const mergedOrgEntries = mockStorage.accounts.filter(
			(account) => account.organizationId === "org-keep",
		);
		expect(mergedOrgEntries).toHaveLength(1);
		const mergedOrg = mergedOrgEntries[0];
		expect(mergedOrg?.accountId).toBe("org-shared");
		expect(mergedOrg?.rateLimitResetTimes?.codex).toBe(9_000);
		expect(mergedOrg?.rateLimitResetTimes?.["codex-max"]).toBe(5_000);
		expect(mergedOrg?.rateLimitResetTimes?.["gpt-5.1"]).toBe(8_000);
	});

	it("keeps restrictive enabled/cooldown metadata when collapsing same-organization duplicates", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const authModule = await import("../lib/auth/auth.js");

		mockStorage.accounts = [
			{
				accountId: "org-shared",
				organizationId: "org-keep",
				email: "org@example.com",
				refreshToken: "shared-refresh",
				enabled: true,
				addedAt: 10,
				lastUsed: 10,
			},
			{
				accountId: "org-shared",
				organizationId: "org-keep",
				email: "token@example.com",
				refreshToken: "shared-refresh",
				enabled: false,
				coolingDownUntil: 12_000,
				cooldownReason: "auth-failure",
				addedAt: 20,
				lastUsed: 20,
			},
		];

		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-unrelated-cooling",
			refresh: "refresh-unrelated-cooling",
			expires: Date.now() + 300_000,
			idToken: "id-unrelated-cooling",
		});
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValueOnce([]);
		vi.mocked(accountsModule.extractAccountId).mockImplementation((accessToken) =>
			accessToken === "access-unrelated-cooling" ? "unrelated-cooling" : "account-1",
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = (await OpenAIOAuthPlugin({
			client: mockClient,
		} as never)) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });

		const mergedOrgEntries = mockStorage.accounts.filter(
			(account) => account.organizationId === "org-keep",
		);
		expect(mergedOrgEntries).toHaveLength(1);
		const mergedOrg = mergedOrgEntries[0];
		expect(mergedOrg?.accountId).toBe("org-shared");
		expect(mergedOrg?.enabled).toBe(false);
		expect(mergedOrg?.coolingDownUntil).toBe(12_000);
		expect(mergedOrg?.cooldownReason).toBe("auth-failure");
	});

	it("preserves same-organization entries when accountId differs", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const authModule = await import("../lib/auth/auth.js");

		mockStorage.accounts = [
			{
				accountId: "org-shared-a",
				organizationId: "org-keep",
				email: "org-a@example.com",
				refreshToken: "shared-refresh",
				addedAt: 10,
				lastUsed: 10,
			},
			{
				accountId: "org-shared-b",
				organizationId: "org-keep",
				email: "org-b@example.com",
				refreshToken: "shared-refresh",
				addedAt: 20,
				lastUsed: 20,
			},
		];

		vi.mocked(authModule.exchangeAuthorizationCode).mockResolvedValueOnce({
			type: "success",
			access: "access-unrelated-preserve",
			refresh: "refresh-unrelated-preserve",
			expires: Date.now() + 300_000,
			idToken: "id-unrelated-preserve",
		});
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValueOnce([]);
		vi.mocked(accountsModule.extractAccountId).mockImplementation((accessToken) =>
			accessToken === "access-unrelated-preserve" ? "unrelated-preserve" : "account-1",
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = (await OpenAIOAuthPlugin({
			client: mockClient,
		} as never)) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });

		const orgEntries = mockStorage.accounts.filter(
			(account) => account.organizationId === "org-keep",
		);
		expect(orgEntries).toHaveLength(2);
		const accountIds = orgEntries.map((account) => account.accountId).sort();
		expect(accountIds).toEqual(["org-shared-a", "org-shared-b"]);
	});

	it("persists non-team login and updates same record via accountId/refresh fallback", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const authModule = await import("../lib/auth/auth.js");

		vi.mocked(authModule.exchangeAuthorizationCode)
			.mockResolvedValueOnce({
				type: "success",
				access: "access-no-org-1",
				refresh: "refresh-shared",
				expires: Date.now() + 300_000,
				idToken: "id-no-org-1",
			})
			.mockResolvedValueOnce({
				type: "success",
				access: "access-no-org-2",
				refresh: "refresh-shared",
				expires: Date.now() + 300_000,
				idToken: "id-no-org-2",
			});
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValue([]);
		vi.mocked(accountsModule.extractAccountId)
			.mockReturnValueOnce("account-1")
			.mockReturnValueOnce(undefined);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });
		await autoMethod.authorize({ loginMode: "add", accountCount: "1" });

		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts[0]?.organizationId).toBeUndefined();
		expect(mockStorage.accounts[0]?.accountId).toBe("account-1");
		expect(mockStorage.accounts[0]?.refreshToken).toBe("refresh-shared");
		expect(mockStorage.accounts[0]?.accessToken).toBe("access-no-org-2");
	});

	it("preserves flagged organization identity during verify-flagged restore for cached and refreshed paths", async () => {
		const cliModule = await import("../lib/cli.js");
		const storageModule = await import("../lib/storage.js");
		const accountsModule = await import("../lib/accounts.js");
		const refreshQueueModule = await import("../lib/refresh-queue.js");

		const flaggedAccounts = [
			{
				refreshToken: "flagged-refresh-cache",
				organizationId: "org-cache",
				accountId: "flagged-cache",
				accountIdSource: "manual" as const,
				accountLabel: "Cache Workspace",
				email: "cache@example.com",
				flaggedAt: Date.now() - 1000,
				addedAt: Date.now() - 1000,
				lastUsed: Date.now() - 1000,
			},
			{
				refreshToken: "flagged-refresh-live",
				organizationId: "org-refresh",
				accountId: "flagged-live",
				accountIdSource: "manual" as const,
				accountLabel: "Refresh Workspace",
				email: "refresh@example.com",
				flaggedAt: Date.now() - 500,
				addedAt: Date.now() - 500,
				lastUsed: Date.now() - 500,
			},
		];
		mockFlaggedStorage.accounts = flaggedAccounts.map(cloneFlaggedAccount);

		vi.mocked(cliModule.promptLoginMode)
			.mockResolvedValueOnce({ mode: "verify-flagged" })
			.mockResolvedValueOnce({ mode: "cancel" });

		vi.mocked(storageModule.loadFlaggedAccounts)
			.mockResolvedValueOnce({
				version: 1,
				accounts: flaggedAccounts,
			})
			.mockResolvedValueOnce({
				version: 1,
				accounts: flaggedAccounts,
			})
			.mockResolvedValueOnce({
				version: 1,
				accounts: [],
			});

		vi.mocked(accountsModule.lookupCodexCliTokensByEmail).mockImplementation(async (email) => {
			if (email === "cache@example.com") {
				return {
					accessToken: "cached-access",
					refreshToken: "cached-refresh",
					expiresAt: Date.now() + 60_000,
				};
			}
			return null;
		});
		vi.mocked(accountsModule.getAccountIdCandidates).mockReturnValue([
			{
				accountId: "token-shared",
				source: "token",
				label: "Token Shared [id:shared]",
			},
		]);
		vi.mocked(accountsModule.selectBestAccountCandidate).mockImplementation(
			(candidates) => candidates[0] ?? null,
		);

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = (await OpenAIOAuthPlugin({
			client: mockClient,
		} as never)) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		const authResult = await autoMethod.authorize();
		expect(authResult.instructions).toBe("Authentication cancelled");

		expect(vi.mocked(refreshQueueModule.queuedRefresh)).toHaveBeenCalledTimes(1);
		expect(mockStorage.accounts).toHaveLength(2);
		expect(new Set(mockStorage.accounts.map((account) => account.organizationId))).toEqual(
			new Set(["org-cache", "org-refresh"]),
		);
		expect(vi.mocked(storageModule.saveFlaggedAccounts)).toHaveBeenCalledWith({
			version: 1,
			accounts: [],
		});
	});

	it("masks the email in the interactive delete confirmation when maskEmail is enabled", async () => {
		const cliModule = await import("../lib/cli.js");
		const configModule = await import("../lib/config.js");

		vi.mocked(configModule.getCodexTuiMaskEmail).mockReturnValue(true);

		mockStorage.accounts = [
			{ refreshToken: "r1", email: "user@example.com", accountId: "acc-1" },
		];

		vi.mocked(cliModule.promptLoginMode)
			.mockReset()
			.mockResolvedValueOnce({ mode: "manage", deleteAccountIndex: 0 })
			.mockResolvedValue({ mode: "cancel" });

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = (await OpenAIOAuthPlugin({
			client: mockClient,
		} as never)) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize();

		const logged = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(logged).toContain("Deleted us***@example.com");
		expect(logged).not.toContain("user@example.com");

		logSpy.mockRestore();
	});

	it("masks the email in the interactive enable/disable confirmation when maskEmail is enabled", async () => {
		const cliModule = await import("../lib/cli.js");
		const configModule = await import("../lib/config.js");

		vi.mocked(configModule.getCodexTuiMaskEmail).mockReturnValue(true);

		mockStorage.accounts = [
			{ refreshToken: "r1", email: "user@example.com", accountId: "acc-1" },
		];

		vi.mocked(cliModule.promptLoginMode)
			.mockReset()
			.mockResolvedValueOnce({ mode: "manage", toggleAccountIndex: 0 })
			.mockResolvedValue({ mode: "cancel" });

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = (await OpenAIOAuthPlugin({
			client: mockClient,
		} as never)) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		await autoMethod.authorize();

		const logged = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(logged).toContain("us***@example.com");
		expect(logged).not.toContain("user@example.com");

		logSpy.mockRestore();
	});

	it("keeps workspace-deactivated flagged entries out of verify-flagged restore", async () => {
		const cliModule = await import("../lib/cli.js");
		const storageModule = await import("../lib/storage.js");
		const refreshQueueModule = await import("../lib/refresh-queue.js");

		mockFlaggedStorage.accounts = [
			{
				refreshToken: "flagged-refresh-dead",
				organizationId: "org-dead",
				accountId: "workspace-dead",
				accountIdSource: "manual",
				accountLabel: "Dead Workspace",
				email: "dead@example.com",
				flaggedAt: Date.now() - 500,
				flaggedReason: "workspace-deactivated",
				lastError: "deactivated_workspace",
				addedAt: Date.now() - 500,
				lastUsed: Date.now() - 500,
			},
		];

		vi.mocked(cliModule.promptLoginMode)
			.mockResolvedValueOnce({ mode: "verify-flagged" })
			.mockResolvedValueOnce({ mode: "cancel" });

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = (await OpenAIOAuthPlugin({
			client: mockClient,
		} as never)) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		const authResult = await autoMethod.authorize();
		expect(authResult.instructions).toBe("Authentication cancelled");

		expect(vi.mocked(refreshQueueModule.queuedRefresh)).not.toHaveBeenCalled();
		expect(mockStorage.accounts).toHaveLength(0);
		expect(vi.mocked(storageModule.saveFlaggedAccounts)).toHaveBeenCalledWith({
			version: 1,
			accounts: expect.arrayContaining([
				expect.objectContaining({
					accountId: "workspace-dead",
					flaggedReason: "workspace-deactivated",
				}),
			]),
		});
	});

	it("removes only the token-invalid org-scoped workspace during deep-check cleanup", async () => {
		const cliModule = await import("../lib/cli.js");
		const refreshQueueModule = await import("../lib/refresh-queue.js");
		const storageModule = await import("../lib/storage.js");

		mockStorage.accounts = [
			{
				refreshToken: "shared-refresh",
				organizationId: "org-shared",
				accountId: "workspace-dead",
				accountIdSource: "manual",
				email: "dead@example.com",
				addedAt: 1,
				lastUsed: 1,
			},
			{
				refreshToken: "shared-refresh",
				organizationId: "org-shared",
				accountId: "workspace-live",
				accountIdSource: "manual",
				email: "live@example.com",
				addedAt: 2,
				lastUsed: 2,
			},
		];

		vi.mocked(cliModule.promptLoginMode)
			.mockResolvedValueOnce({ mode: "deep-check" })
			.mockResolvedValueOnce({ mode: "cancel" });
		vi.mocked(refreshQueueModule.queuedRefresh)
			.mockResolvedValueOnce({
				type: "failed",
				reason: "http_error",
				statusCode: 400,
				message: "invalid_grant",
			} as const)
			.mockResolvedValueOnce({
				type: "success",
				access: "access-live",
				refresh: "shared-refresh",
				expires: Date.now() + 300_000,
			});

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = (await OpenAIOAuthPlugin({
			client: mockClient,
		} as never)) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		const authResult = await autoMethod.authorize();
		expect(authResult.instructions).toBe("Authentication cancelled");

		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts.some((account) => account.accountId === "workspace-dead")).toBe(false);
		expect(mockStorage.accounts[0]?.organizationId).toBe("org-shared");
		expect(mockStorage.accounts[0]?.refreshToken).toBe("shared-refresh");
		expect(vi.mocked(storageModule.withFlaggedAccountStorageTransaction)).toHaveBeenCalled();
		expect(mockFlaggedStorage.accounts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					accountId: "workspace-dead",
					organizationId: "org-shared",
					flaggedReason: "token-invalid",
				}),
			]),
		);
	});

	it("uses model-independent usage for free plans and removes only a deactivated workspace", async () => {
		const accountsModule = await import("../lib/accounts.js");
		const cliModule = await import("../lib/cli.js");
		const refreshQueueModule = await import("../lib/refresh-queue.js");
		const fetchHelpersModule = await import("../lib/request/fetch-helpers.js");
		const storageModule = await import("../lib/storage.js");

		mockStorage.accounts = [
			{
				refreshToken: "shared-refresh",
				organizationId: "org-shared",
				accountId: "workspace-dead",
				accountIdSource: "manual",
				email: "dead@example.com",
				addedAt: 1,
				lastUsed: 1,
			},
			{
				refreshToken: "shared-refresh",
				organizationId: "org-shared",
				accountId: "workspace-live",
				accountIdSource: "manual",
				email: "live@example.com",
				addedAt: 2,
				lastUsed: 2,
			},
		];

		vi.mocked(cliModule.promptLoginMode)
			.mockResolvedValueOnce({ mode: "check" })
			.mockResolvedValueOnce({ mode: "cancel" });
		vi.mocked(accountsModule.shouldUpdateAccountIdFromToken).mockImplementation(
			(source: string | undefined, currentAccountId?: string) => {
				if (!currentAccountId) return true;
				if (!source) return true;
				return source === "token" || source === "id_token";
			},
		);
		vi.mocked(accountsModule.resolveRequestAccountId).mockImplementation(
			(storedId: string | undefined, source: string | undefined, tokenId: string | undefined) => {
				if (!storedId) return tokenId;
				if (!accountsModule.shouldUpdateAccountIdFromToken(source, storedId)) {
					return storedId;
				}
				return tokenId ?? storedId;
			},
		);
		vi.mocked(refreshQueueModule.queuedRefresh)
			.mockResolvedValueOnce({
				type: "success",
				access: "access-dead",
				refresh: "shared-refresh",
				expires: Date.now() + 300_000,
			})
			.mockResolvedValueOnce({
				type: "success",
				access: "access-live",
				refresh: "shared-refresh",
				expires: Date.now() + 300_000,
			});
		vi.mocked(fetchHelpersModule.createCodexHeaders).mockImplementation(
			(_requestId, _accountId, accessToken) => {
				const headers = new Headers();
				if (typeof accessToken === "string" && accessToken.length > 0) {
					headers.set("x-test-access-token", accessToken);
				}
				return headers;
			},
		);
		globalThis.fetch = vi.fn(async (_url, init) => {
			const headers = new Headers(init?.headers);
			const accessToken = headers.get("x-test-access-token");
			if (accessToken === "access-dead") {
				return new Response(JSON.stringify({
					error: { code: "deactivated_workspace", message: "workspace dead" },
					detail: { code: "deactivated_workspace", message: "workspace dead" },
				}), {
					status: 402,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({
				plan_type: "free",
				rate_limit: {
					primary_window: {
						used_percent: 20,
						limit_window_seconds: 18_000,
						reset_after_seconds: 900,
					},
					secondary_window: {
						used_percent: 10,
						limit_window_seconds: 604_800,
						reset_after_seconds: 86_400,
					},
				},
			}), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = (await OpenAIOAuthPlugin({
			client: mockClient,
		} as never)) as unknown as PluginType;
		const autoMethod = plugin.auth.methods[0] as unknown as {
			authorize: (inputs?: Record<string, string>) => Promise<{ instructions: string }>;
		};

		const authResult = await autoMethod.authorize();
		expect(authResult.instructions).toBe("Authentication cancelled");

		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		for (const [url, init] of vi.mocked(globalThis.fetch).mock.calls) {
			expect(String(url)).toContain("/wham/usage");
			expect(init?.method).toBe("GET");
			expect(init?.body).toBeUndefined();
		}
		expect(mockStorage.accounts).toHaveLength(1);
		expect(mockStorage.accounts.some((account) => account.accountId === "workspace-dead")).toBe(false);
		expect(mockStorage.accounts[0]?.accountId).toBe("workspace-live");
		expect(vi.mocked(storageModule.withFlaggedAccountStorageTransaction)).toHaveBeenCalled();
		expect(mockFlaggedStorage.accounts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					accountId: "workspace-dead",
					organizationId: "org-shared",
					flaggedReason: "workspace-deactivated",
					lastError: "deactivated_workspace",
				}),
			]),
		);
	});
});

describe("OpenAIOAuthPlugin showToast error handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStorage.accounts = [
			{ accountId: "acc-1", email: "user@example.com", refreshToken: "refresh-1" },
		];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("handles TUI unavailable gracefully", async () => {
		const mockClient = {
			tui: {
				showToast: vi.fn().mockRejectedValue(new Error("TUI unavailable")),
			},
			auth: { set: vi.fn() },
			session: { prompt: vi.fn() },
		};

		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const result = await plugin.tool["codex-switch"].execute({ index: 1 });
		expect(result).toContain("Switched to account");
	});
});

describe("OpenAIOAuthPlugin event handler edge cases", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStorage.accounts = [
			{ accountId: "acc-1", email: "user1@example.com", refreshToken: "refresh-1" },
			{ accountId: "acc-2", email: "user2@example.com", refreshToken: "refresh-2" },
		];
		mockStorage.activeIndex = 0;
		mockStorage.activeIndexByFamily = {};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("handles account.select with accountIndex property", async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		await plugin.auth.loader(getAuth, { options: {}, models: {} });

		await plugin.event({
			event: { type: "account.select", properties: { accountIndex: 1 } },
		});
	});

	it("flushes and disposes the cached manager when handling account.select", async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;
		const { AccountManager } = await import("../lib/accounts.js");
		const loadFromDiskSpy = vi.spyOn(AccountManager, "loadFromDisk");
		const flushSpy = vi.spyOn(AccountManager.prototype, "flushPendingSave");
		const disposeSpy = vi.spyOn(AccountManager.prototype, "disposeShutdownHandler");

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		await plugin.auth.loader(getAuth, { options: {}, models: {} });
		loadFromDiskSpy.mockClear();
		flushSpy.mockClear();
		disposeSpy.mockClear();

		await plugin.event({
			event: { type: "account.select", properties: { index: 1 } },
		});

		expect(flushSpy).toHaveBeenCalledTimes(1);
		expect(loadFromDiskSpy).toHaveBeenCalledTimes(1);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(flushSpy.mock.invocationCallOrder[0]).toBeLessThan(
			loadFromDiskSpy.mock.invocationCallOrder[0]!,
		);
		expect(loadFromDiskSpy.mock.invocationCallOrder[0]).toBeLessThan(
			disposeSpy.mock.invocationCallOrder[0]!,
		);
	});

	it("keeps the cached manager when an account.select reload fails", async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;
		const { AccountManager } = await import("../lib/accounts.js");
		const loadFromDiskSpy = vi.spyOn(AccountManager, "loadFromDisk");
		const flushSpy = vi.spyOn(AccountManager.prototype, "flushPendingSave");
		const disposeSpy = vi.spyOn(AccountManager.prototype, "disposeShutdownHandler");

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		await plugin.auth.loader(getAuth, { options: {}, models: {} });
		loadFromDiskSpy.mockClear();
		flushSpy.mockClear();
		disposeSpy.mockClear();
		loadFromDiskSpy.mockRejectedValueOnce(new Error("reload failed"));

		await plugin.event({
			event: { type: "account.select", properties: { index: 1 } },
		});

		expect(flushSpy).toHaveBeenCalledTimes(1);
		expect(loadFromDiskSpy).toHaveBeenCalledTimes(1);
		expect(disposeSpy).not.toHaveBeenCalled();

		await plugin.event({
			event: { type: "account.select", properties: { index: 0 } },
		});

		expect(flushSpy).toHaveBeenCalledTimes(2);
		expect(loadFromDiskSpy).toHaveBeenCalledTimes(2);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("handles openai.account.select with openai provider", async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		const getAuth = async () => ({
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
			multiAccount: true,
		});

		await plugin.auth.loader(getAuth, { options: {}, models: {} });

		await plugin.event({
			event: {
				type: "openai.account.select",
				properties: { provider: "openai", index: 0 },
			},
		});
	});

	it("ignores account.select when cachedAccountManager is null", async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		await plugin.event({
			event: { type: "account.select", properties: { index: 0 } },
		});
	});

	it("handles non-numeric index gracefully", async () => {
		const mockClient = createMockClient();
		const { OpenAIOAuthPlugin } = await import("../index.js");
		const plugin = await OpenAIOAuthPlugin({ client: mockClient } as never) as unknown as PluginType;

		await plugin.event({
			event: { type: "account.select", properties: { index: "invalid" } },
		});
	});
});

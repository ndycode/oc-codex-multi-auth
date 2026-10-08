import { readFileSync, statSync, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { lock } from "proper-lockfile";
import type { PluginConfig } from "./types.js";
import {
	normalizeRetryBudgetValue,
	type RetryBudgetOverrides,
	type RetryProfile,
} from "./request/retry-budget.js";
import { logWarn } from "./logger.js";
import {
	DEFAULT_QUOTA_DISPLAY_MODE,
	QUOTA_DISPLAY_MODES,
	type QuotaDisplayMode,
} from "./quota-display.js";
import type {
	QuotaOverviewLayout,
	QuotaOverviewNames,
	QuotaOverviewOrder,
	QuotaOverviewResetTimes,
} from "./quota-overview.js";
import { stripEffortSuffix } from "./request/helpers/effort-suffix.js";
import {
	isWindowsLockError,
	renameWithWindowsRetry,
} from "./storage/atomic-write.js";
import { ConfigLockContentionError } from "./errors.js";
import {
	PluginConfigSchema,
	getValidationErrors,
	EnvBooleanSchema,
	EnvNumberSchema,
	makeEnvEnumSchema,
	makeEnvIntegerSchema,
	MAX_CONFIG_DURATION_MS,
	parseAccountIdOverride,
} from "./schemas.js";

const CONFIG_PATH = join(homedir(), ".opencode", "openai-codex-auth-config.json");
const TUI_COLOR_PROFILES = new Set(["truecolor", "ansi16", "ansi256"]);
const TUI_GLYPH_MODES = new Set(["ascii", "unicode", "auto"]);
const REQUEST_TRANSFORM_MODES = new Set(["native", "legacy"]);
const UNSUPPORTED_CODEX_POLICIES = new Set(["strict", "fallback"]);
const RETRY_PROFILES = new Set(["conservative", "balanced", "aggressive"]);
const QUOTA_DISPLAY_MODE_SET: ReadonlySet<string> = new Set(QUOTA_DISPLAY_MODES);

export type UnsupportedCodexPolicy = "strict" | "fallback";

export type ModelAccountPoolMode = "preferred" | "strict";

export type ModelAccountPoolMutation =
	| "set"
	| "add"
	| "remove"
	| "clear"
	| "set-mode";

export interface ModelAccountPoolMutationResult {
	model: string;
	previousAccountIds: string[];
	accountIds: string[];
	previousPoolMode: ModelAccountPoolMode;
	poolMode: ModelAccountPoolMode;
	changed: boolean;
	dryRun: boolean;
}

export interface ModelAccountPoolMutationOptions {
	dryRun?: boolean;
	poolMode?: ModelAccountPoolMode;
	normalizeExistingAccountIds?: (accountIds: readonly string[]) => readonly string[];
}

let modelAccountPoolMutationQueue: Promise<void> = Promise.resolve();

/**
 * Default plugin configuration
 * CODEX_MODE is enabled by default for better Codex CLI parity
 */
const DEFAULT_CONFIG: PluginConfig = {
	codexMode: true,
	requestTransformMode: "native",
	codexTuiV2: true,
	codexTuiColorProfile: "truecolor",
	codexTuiGlyphMode: "ascii",
	maskEmail: false,
	maskEmailInQuotaDetails: false,
	quotaDisplay: DEFAULT_QUOTA_DISPLAY_MODE,
	beginnerSafeMode: false,
	fastSession: false,
	fastSessionStrategy: "hybrid",
	rotationStrategy: "hybrid",
	fastSessionMaxInputItems: 30,
	retryProfile: "balanced",
	retryBudgetOverrides: {},
	retryAllAccountsRateLimited: true,
	retryAllAccountsMaxWaitMs: 0,
	retryAllAccountsMaxRetries: Infinity,
	unsupportedCodexPolicy: "strict",
	fallbackOnUnsupportedCodexModel: false,
	fallbackToGpt52OnUnsupportedGpt53: true,
	unsupportedCodexFallbackChain: {},
	tokenRefreshSkewMs: 60_000,
	rateLimitToastDebounceMs: 60_000,
	toastDurationMs: 5_000,
	accountToasts: true,
	perProjectAccounts: true,
	credentialSnapshots: true,
	credentialSnapshotsMaxCount: 10,
	sessionRecovery: true,
	autoResume: true,
	autoUpdate: true,
	parallelProbing: false,
	parallelProbingMaxConcurrency: 2,
	emptyResponseMaxRetries: 2,
	emptyResponseRetryDelayMs: 1_000,
	pidOffsetEnabled: false,
	fetchTimeoutMs: 60_000,
	streamStallTimeoutMs: 45_000,
	maxStreamDurationMs: 300_000,
};

/**
 * File-signature the config cache is keyed on. `mtimeMs`+`size` alone miss
 * an in-place rewrite that preserves both (the hot-reload contract requires
 * detecting exactly that), so `ctimeMs` and `ino` ride along: POSIX bumps
 * ctime on every inode-status change and a rename-based replace changes the
 * inode. Fields are `| undefined` because partial Stats stand-ins (mocks,
 * odd filesystems) may not supply all of them — a missing field simply
 * compares equal on both sides.
 */
type PluginConfigFileStat = {
	readonly mtimeMs: number | undefined;
	readonly ctimeMs: number | undefined;
	readonly size: number | undefined;
	readonly ino: number | undefined;
};

let pluginConfigCache: {
	/** Signature of the file at the time `content` was read; `undefined` means the file was missing. */
	readonly stat: PluginConfigFileStat | undefined;
	readonly content: string | undefined;
	readonly config: PluginConfig;
} | undefined;

export function resetPluginConfigCache(): void {
	pluginConfigCache = undefined;
}

function statPluginConfigFile(): PluginConfigFileStat {
	const stat = statSync(CONFIG_PATH);
	return {
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
		size: stat.size,
		ino: stat.ino,
	};
}

function sameConfigFileStat(
	a: PluginConfigFileStat | undefined,
	b: PluginConfigFileStat | undefined,
): boolean {
	if (a === undefined || b === undefined) return false;
	return (
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		a.size === b.size &&
		a.ino === b.ino
	);
}

/**
 * Load plugin configuration from ~/.opencode/openai-codex-auth-config.json
 * Keeps the last usable configuration during incomplete writes; defaults on cold start.
 *
 * This runs on the per-request path, so the file is only re-read when its
 * stat signature changed and only re-validated when its content did —
 * an unchanged file costs one `statSync`, not a read+parse.
 *
 * @returns Plugin configuration
 */
export function loadPluginConfig(): PluginConfig {
	try {
		const stat = statPluginConfigFile();
		if (
			pluginConfigCache !== undefined &&
			sameConfigFileStat(pluginConfigCache.stat, stat)
		) {
			return pluginConfigCache.config;
		}
		const content = readFileSync(CONFIG_PATH, "utf-8");
		if (pluginConfigCache?.content === content) {
			pluginConfigCache = { stat, content, config: pluginConfigCache.config };
			return pluginConfigCache.config;
		}
		const config = readPluginConfig(content) ?? pluginConfigCache?.config ?? DEFAULT_CONFIG;
		pluginConfigCache = { stat, content, config };
		return config;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			// A missing file was already recorded: no point probing the path
			// again until something changes it, so answer from the cache.
			if (pluginConfigCache !== undefined && pluginConfigCache.stat === undefined) {
				return pluginConfigCache.config;
			}
			pluginConfigCache = {
				stat: undefined,
				content: undefined,
				config: pluginConfigCache?.config ?? DEFAULT_CONFIG,
			};
		} else {
			logWarn(`Failed to read config from ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return pluginConfigCache?.config ?? DEFAULT_CONFIG;
	}
}

function readPluginConfig(fileContent: string): PluginConfig | undefined {
	try {
		const normalizedFileContent = stripUtf8Bom(fileContent);
		const userConfig = JSON.parse(normalizedFileContent) as unknown;
		const hasFallbackEnvOverride =
			process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL !== undefined ||
			process.env.CODEX_AUTH_FALLBACK_GPT53_TO_GPT52 !== undefined;
		if (isRecord(userConfig)) {
			const hasPolicyKey = Object.hasOwn(userConfig, "unsupportedCodexPolicy");
			const hasLegacyFallbackKey =
				Object.hasOwn(userConfig, "fallbackOnUnsupportedCodexModel") ||
				Object.hasOwn(userConfig, "fallbackToGpt52OnUnsupportedGpt53") ||
				Object.hasOwn(userConfig, "unsupportedCodexFallbackChain");
			if (!hasPolicyKey && (hasLegacyFallbackKey || hasFallbackEnvOverride)) {
				logWarn(
					"Legacy unsupported-model fallback settings detected without unsupportedCodexPolicy. " +
						'Using backward-compat behavior; prefer unsupportedCodexPolicy: "strict" | "fallback".',
				);
			}
		}

		// RC-9: validate at the process boundary. Reject anything that is not
		// a JSON object, then route through PluginConfigSchema so bad values
		// from an external config file never flow into the merged runtime
		// config. Callers still see DEFAULT_CONFIG as the base, so an invalid
		// file degrades gracefully instead of silently mis-configuring retry
		// budgets, timeouts, or feature flags.
		if (!isRecord(userConfig) || Array.isArray(userConfig)) {
			logWarn(
				`Plugin config at ${CONFIG_PATH} is not a JSON object; keeping the last usable configuration.`,
			);
			return undefined;
		}

		const parseResult = PluginConfigSchema.safeParse(userConfig);
		if (parseResult.success) {
			return {
				...DEFAULT_CONFIG,
				...parseResult.data,
			};
		}

		// Top-level schema failed. Preserve legacy logging so existing
		// operators still see the familiar "validation warnings" string, then
		// salvage the subset of keys that individually pass validation so a
		// single bad field does not wipe out every other user setting.
		const schemaErrors = getValidationErrors(PluginConfigSchema, userConfig);
		logWarn(
			`Plugin config validation warnings: ${schemaErrors.slice(0, 3).join(", ")}`,
		);
		const salvaged = salvageValidKeys(userConfig);
		return { ...(pluginConfigCache?.config ?? DEFAULT_CONFIG), ...salvaged };
	} catch (error) {
		logWarn(
			`Failed to load config from ${CONFIG_PATH}: ${(error as Error).message}`,
		);
		return undefined;
	}
}

type LockRetryBudget = {
	retries: number;
	factor: number;
	minTimeout: number;
	maxTimeout: number;
	randomize: boolean;
};

/**
 * Full budget: roughly three seconds of retries, enough to ride out another
 * process finishing a mutation of its own.
 */
const LOCK_RETRY_BUDGET_FULL: LockRetryBudget = {
	retries: 20,
	factor: 1.2,
	minTimeout: 25,
	maxTimeout: 200,
	randomize: true,
};

/**
 * Short budget used once contention has just been observed: long enough to win
 * a lock its holder is releasing right now, far short of the full budget.
 */
const LOCK_RETRY_BUDGET_PROBE: LockRetryBudget = {
	retries: 3,
	factor: 1.2,
	minTimeout: 25,
	maxTimeout: 50,
	randomize: true,
};

/** How long one contention observation keeps later mutations on the probe budget. */
const LOCK_CONTENTION_FAST_FAIL_WINDOW_MS = 1_000;

/**
 * When another process was last seen holding the config lock past our budget.
 *
 * `modelAccountPoolMutationQueue` serializes every in-process mutation, so
 * without this each queued caller independently waited out the full budget
 * against the same foreign holder: ten parallel `codex-pool` calls blocked for
 * ten times the budget and then all failed anyway, which is the "completely
 * stalls the sub tasks" half of #224. Once one call has established that the
 * lock is externally held, the rest probe briefly and degrade immediately, so
 * the stall is bounded rather than multiplied by the queue depth.
 */
let lastLockContentionAt: number | null = null;

function nextLockRetryBudget(): LockRetryBudget {
	if (lastLockContentionAt === null) return LOCK_RETRY_BUDGET_FULL;
	if (
		Date.now() - lastLockContentionAt >=
		LOCK_CONTENTION_FAST_FAIL_WINDOW_MS
	) {
		lastLockContentionAt = null;
		return LOCK_RETRY_BUDGET_FULL;
	}
	return LOCK_RETRY_BUDGET_PROBE;
}

/** Test hook: forget any observed contention so budgets start from full. */
export function __resetLockContentionStateForTests(): void {
	lastLockContentionAt = null;
}

/**
 * Update one model pool while preserving every unrelated raw config key.
 * Account indexes are deliberately resolved by the caller; only stable IDs
 * cross this persistence boundary.
 */
export function updateModelAccountPool(
	model: string,
	mutation: ModelAccountPoolMutation,
	accountIds: readonly string[] = [],
	options: ModelAccountPoolMutationOptions = {},
): Promise<ModelAccountPoolMutationResult> {
	const pending = modelAccountPoolMutationQueue.then(async () => {
		if (options.dryRun === true) {
			return performModelAccountPoolMutation(
				model,
				mutation,
				accountIds,
				options,
			);
		}

		await fs.mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
		let release: () => Promise<void>;
		try {
			release = await lock(CONFIG_PATH, {
				realpath: false,
				stale: 10_000,
				update: 2_000,
				// proper-lockfile's default `onCompromised` rethrows from inside an
				// fs callback. Nothing in this process installs an
				// `uncaughtException` handler, so a lock that goes stale mid-mutation
				// (event loop blocked past `stale`, or another process reclaiming the
				// entry) would take the whole plugin down instead of failing this one
				// call. The mutation is already in flight and cannot be rolled back,
				// so the only useful response is to record it; the release below
				// tolerates the ERELEASED that follows.
				onCompromised: (error: Error) => {
					logWarn(
						`Plugin configuration lock at ${CONFIG_PATH} was compromised mid-mutation: ${error.message}`,
					);
				},
				retries: nextLockRetryBudget(),
			});
			lastLockContentionAt = null;
		} catch (error) {
			if (isLockContentionError(error)) {
				lastLockContentionAt = Date.now();
				throw new ConfigLockContentionError(CONFIG_PATH, error);
			}
			throw error;
		}
		try {
			return await performModelAccountPoolMutation(
				model,
				mutation,
				accountIds,
				options,
			);
		} finally {
			// A release failure must never replace the mutation's outcome. By this
			// point the config has already been written, so surfacing ERELEASED (or
			// a Windows EPERM/EBUSY on the lock directory, which `removeLock`
			// propagates straight from `rmdir`) would report a fatal lock error for
			// a change that actually landed - the exact symptom this fix removes.
			await releaseLockQuietly(release);
		}
	});
	modelAccountPoolMutationQueue = pending.then(
		() => undefined,
		() => undefined,
	);
	return pending;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

/**
 * True when a lock acquisition failure means "another process holds it", as
 * opposed to a genuine environment fault the caller must see.
 *
 * proper-lockfile forwards raw fs errors from the lock directory's
 * `mkdir`/`stat`/`rmdir` straight into its retry loop, so the error that
 * finally escapes (`operation.mainError()`) is not always ELOCKED. On Windows a
 * lock directory held open by another process - or by an antivirus scanner or
 * the search indexer - surfaces as EPERM/EBUSY rather than EEXIST, the same
 * class `renameWithWindowsRetry` already tolerates one layer down. Those codes
 * count as contention only on win32; on POSIX an EPERM really is a permission
 * problem and has to stay fatal.
 */
function isLockContentionError(error: unknown): boolean {
	if (hasErrorCode(error, "ELOCKED")) return true;
	return process.platform === "win32" && isWindowsLockError(error);
}

/** Release a config lock, downgrading any failure to a warning. */
async function releaseLockQuietly(release: () => Promise<void>): Promise<void> {
	try {
		await release();
	} catch (error) {
		// Losing the lock directory is recoverable on its own: `stale` reclaims a
		// leftover entry within 10s, and the mutation it guarded is already
		// durable on disk.
		logWarn(
			`Failed to release plugin configuration lock at ${CONFIG_PATH}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

async function performModelAccountPoolMutation(
	model: string,
	mutation: ModelAccountPoolMutation,
	accountIds: readonly string[],
	options: ModelAccountPoolMutationOptions,
): Promise<ModelAccountPoolMutationResult> {
	const normalizedModel = model.trim().toLowerCase();
	if (!normalizedModel) throw new Error("Model is required.");

	let rawConfig: Record<string, unknown> = {};
	try {
		const content = await fs.readFile(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(stripUtf8Bom(content)) as unknown;
		if (!isRecord(parsed) || Array.isArray(parsed)) {
			throw new Error(`Plugin config at ${CONFIG_PATH} is not a JSON object.`);
		}
		rawConfig = parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const poolResult = PluginConfigSchema.safeParse({
		modelAccountPools: rawConfig.modelAccountPools,
		modelAccountPoolModes: rawConfig.modelAccountPoolModes,
	});
	if (!poolResult.success) {
		throw new Error(
			`Existing modelAccountPools configuration is invalid: ${getValidationErrors(
				PluginConfigSchema,
				{ modelAccountPools: rawConfig.modelAccountPools },
			)[0] ?? "validation failed"}`,
		);
	}

	// Null-prototype accumulators: `normalizedModel` is arbitrary caller input
	// and `pools[model] = ids` on a plain object with model = "__proto__" would
	// invoke the [[Set]] prototype write instead of creating an own property.
	// `Object.assign` onto a null-prototype target keeps even that key inert.
	// The same consideration already guards the fallback-chain normalizer.
	const pools: Record<string, string[]> = Object.assign(
		Object.create(null),
		poolResult.data.modelAccountPools ?? {},
	);
	const poolModes: Record<string, ModelAccountPoolMode> = Object.assign(
		Object.create(null),
		poolResult.data.modelAccountPoolModes ?? {},
	);
	const matchingKeys = Object.keys(pools).filter(
		(key) => key.trim().toLowerCase() === normalizedModel,
	);
	const matchingModeKeys = Object.keys(poolModes).filter(
		(key) => key.trim().toLowerCase() === normalizedModel,
	);
	const storedPreviousAccountIds = Array.from(
		new Set(matchingKeys.flatMap((key) => pools[key] ?? [])),
	);
	const previousAccountIds = Array.from(
		new Set(
			(options.normalizeExistingAccountIds?.(storedPreviousAccountIds) ??
				storedPreviousAccountIds)
				.map((id) => id.trim())
				.filter(Boolean),
		),
	);
	for (const key of matchingKeys) delete pools[key];
	const previousPoolMode = matchingModeKeys
		.map((key) => poolModes[key])
		.find((mode): mode is ModelAccountPoolMode => mode !== undefined) ?? "preferred";
	for (const key of matchingModeKeys) delete poolModes[key];
	if (mutation === "set-mode" && previousAccountIds.length === 0) {
		throw new Error(`No model account pool configured for ${normalizedModel}.`);
	}
	if (mutation === "set-mode" && options.poolMode === undefined) {
		throw new Error("poolMode is required for set-mode.");
	}

	const normalizedAccountIds = Array.from(
		new Set(accountIds.map((id) => id.trim()).filter(Boolean)),
	);
	let nextAccountIds: string[];
	if (mutation === "set-mode") {
		nextAccountIds = previousAccountIds;
	} else if (mutation === "set") {
		nextAccountIds = normalizedAccountIds;
	} else if (mutation === "add") {
		nextAccountIds = Array.from(
			new Set([...previousAccountIds, ...normalizedAccountIds]),
		);
	} else if (mutation === "remove") {
		const removedIds = new Set(normalizedAccountIds);
		nextAccountIds = previousAccountIds.filter((id) => !removedIds.has(id));
	} else {
		nextAccountIds = [];
	}

	const nextPoolMode = mutation === "clear"
		? "preferred"
		: options.poolMode ?? previousPoolMode;
	if (nextAccountIds.length > 0) {
		pools[normalizedModel] = nextAccountIds;
		if (nextPoolMode !== "preferred") {
			poolModes[normalizedModel] = nextPoolMode;
		}
	}
	const changed =
		matchingKeys.length !== (nextAccountIds.length > 0 ? 1 : 0) ||
		storedPreviousAccountIds.length !== nextAccountIds.length ||
		storedPreviousAccountIds.some((id, index) => id !== nextAccountIds[index]) ||
		(matchingKeys[0] !== undefined && matchingKeys[0] !== normalizedModel) ||
		matchingModeKeys.length !== (nextPoolMode !== "preferred" && nextAccountIds.length > 0 ? 1 : 0) ||
		previousPoolMode !== nextPoolMode ||
		(matchingModeKeys[0] !== undefined && matchingModeKeys[0] !== normalizedModel);

	if (changed && options.dryRun !== true) {
		if (Object.keys(pools).length > 0) {
			rawConfig.modelAccountPools = pools;
		} else {
			delete rawConfig.modelAccountPools;
		}
		if (Object.keys(poolModes).length > 0) {
			rawConfig.modelAccountPoolModes = poolModes;
		} else {
			delete rawConfig.modelAccountPoolModes;
		}

		const tempPath = `${CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(tempPath, `${JSON.stringify(rawConfig, null, 2)}\n`, {
				encoding: "utf-8",
				mode: 0o600,
			});
			await renameWithWindowsRetry(tempPath, CONFIG_PATH);
		} finally {
			await fs.rm(tempPath, { force: true }).catch(() => undefined);
		}
	}

	return {
		model: normalizedModel,
		// Report what the config file actually held. `previousAccountIds` may have
		// been expanded from legacy workspace keys purely to compute the next set;
		// surfacing the expansion would make callers report a "previous" count the
		// file never contained.
		previousAccountIds: storedPreviousAccountIds,
		accountIds: nextAccountIds,
		previousPoolMode,
		poolMode: nextPoolMode,
		changed,
		dryRun: options.dryRun === true,
	};
}

/**
 * Salvage the subset of user-supplied config keys that individually pass
 * schema validation. Used when the top-level parse fails so callers still
 * benefit from valid keys while invalid ones are discarded instead of
 * silently cast into place.
 */
function salvageValidKeys(raw: Record<string, unknown>): Partial<PluginConfig> {
	// Null-prototype accumulator + an own-property read on the probe result:
	// a config file can legitimately carry an own `__proto__` key (JSON.parse
	// creates one), and `salvaged[key] = value` on a plain object would write
	// to the prototype rather than the key. `Object.hasOwn` on the parsed
	// data also skips keys the schema stripped instead of reading an
	// inherited `__proto__` accessor.
	const salvaged: Record<string, unknown> = Object.create(null);
	for (const [key, value] of Object.entries(raw)) {
		const probe = PluginConfigSchema.safeParse({ [key]: value });
		if (probe.success && Object.hasOwn(probe.data, key)) {
			const candidate = (probe.data as Record<string, unknown>)[key];
			if (candidate !== undefined) {
				salvaged[key] = candidate;
			}
		}
	}
	return salvaged as Partial<PluginConfig>;
}

function stripUtf8Bom(content: string): string {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

// RC-9: the env-var parsing helpers below are thin wrappers around Zod
// schemas that live in `lib/schemas.ts`. Keeping them here (instead of
// inlining the schema use at every call site) preserves the existing
// `resolveBooleanSetting` / `resolveNumberSetting` call graph while ensuring
// every process-boundary env read flows through a validated schema. Each
// helper surfaces `undefined` on invalid input so callers can fall back to
// the config file / default instead of silently honouring a poisoned value.
function parseBooleanEnv(value: string | undefined): boolean | undefined {
	const result = EnvBooleanSchema.safeParse(value);
	return result.success ? result.data : undefined;
}

function parseNumberEnv(value: string | undefined): number | undefined {
	const result = EnvNumberSchema.safeParse(value);
	return result.success ? result.data : undefined;
}

function parseIntegerEnv(value: string | undefined, min: number): number | undefined {
	const result = makeEnvIntegerSchema(min).safeParse(value);
	return result.success ? result.data : undefined;
}

function parseEnumEnv<T extends string>(
	value: string | undefined,
	allowed: ReadonlySet<T>,
): T | undefined {
	const schema = makeEnvEnumSchema(allowed);
	const result = schema.safeParse(value);
	return result.success ? result.data : undefined;
}

function resolveBooleanSetting(
	envName: string,
	configValue: boolean | undefined,
	defaultValue: boolean,
): boolean {
	const envValue = parseBooleanEnv(process.env[envName]);
	if (envValue !== undefined) return envValue;
	return configValue ?? defaultValue;
}

function resolveNumberSetting(
	envName: string,
	configValue: number | undefined,
	defaultValue: number,
	options?: { min?: number; max?: number },
): number {
	const envValue = parseNumberEnv(process.env[envName]);
	const candidate = envValue ?? configValue ?? defaultValue;
	const min = options?.min;
	const max = options?.max;
	// Env input is finite-checked by EnvNumberSchema and file input by the
	// Zod schema, but callers can hand these getters an unvalidated
	// PluginConfig. A non-finite candidate sails straight through
	// Math.max/Math.min — NaN in particular reaches setTimeout as ~0, a
	// silent hot re-poll — so fall back to the default instead of clamping
	// it. A deliberately non-finite *default* (Infinity means "unbounded")
	// is honoured; it is ours, not untrusted input.
	let result = Number.isFinite(candidate) ? candidate : defaultValue;
	if (min !== undefined) {
		result = Math.max(min, result);
	}
	if (max !== undefined) {
		result = Math.min(max, result);
	}
	return result;
}

/**
 * Number resolver for count/index-semantic settings. The env value must be
 * an integer — a fractional `CODEX_AUTH_*=2.5` falls back to config/default
 * rather than being silently truncated — and the resolved candidate is
 * truncated after clamping so a fractional value that bypassed file
 * validation still yields an integer.
 */
function resolveIntegerSetting(
	envName: string,
	configValue: number | undefined,
	defaultValue: number,
	options?: { min?: number; max?: number },
): number {
	const envValue = parseIntegerEnv(
		process.env[envName],
		Number.MIN_SAFE_INTEGER,
	);
	const candidate = envValue ?? configValue ?? defaultValue;
	const min = options?.min;
	const max = options?.max;
	// Same non-finite guard as resolveNumberSetting: Math.trunc cannot rescue
	// NaN — it stays NaN through the clamps — so an unvalidated config value
	// falls back to the default. A non-finite *default* is still honoured:
	// retryAllAccountsMaxRetries deliberately defaults to Infinity.
	const base = Number.isFinite(candidate) ? candidate : defaultValue;
	let result = Math.trunc(base);
	if (min !== undefined) {
		result = Math.max(min, result);
	}
	if (max !== undefined) {
		result = Math.min(max, result);
	}
	return result;
}

/**
 * Number resolver for millisecond durations. Same clamp contract as
 * {@link resolveNumberSetting}, but every duration gets a ceiling of
 * {@link MAX_CONFIG_DURATION_MS} (24h) unless the caller passes a tighter
 * one: an env value like `1e15` is not a long timeout, it is an infinite
 * wait spelled with digits, and a poll interval that large silently
 * disables the feature. Settings whose documented semantic is `0` =
 * unlimited (`retryAllAccountsMaxWaitMs`) use resolveNumberSetting instead.
 */
function resolveDurationMsSetting(
	envName: string,
	configValue: number | undefined,
	defaultValue: number,
	options?: { min?: number; max?: number },
): number {
	return resolveNumberSetting(envName, configValue, defaultValue, {
		min: options?.min,
		max: options?.max ?? MAX_CONFIG_DURATION_MS,
	});
}

function resolveStringSetting<T extends string>(
	envName: string,
	configValue: T | undefined,
	defaultValue: T,
	allowedValues: ReadonlySet<string>,
): T {
	// RC-9: validate the env-supplied enum through a Zod schema so unknown
	// values fall back to the config / default instead of being accepted
	// verbatim.
	const envValue = parseEnumEnv(
		process.env[envName],
		allowedValues as ReadonlySet<T>,
	);
	if (envValue !== undefined) {
		return envValue;
	}
	if (configValue && allowedValues.has(configValue)) {
		return configValue;
	}
	return defaultValue;
}

/**
 * The effective `CODEX_AUTH_ACCOUNT_ID` override: the trimmed, length-bounded
 * (256) value from {@link AccountIdOverrideSchema}, or `undefined` when the
 * env var is unset, blank, or out of bounds. Reading `process.env` raw would
 * accept whitespace-only or unbounded input, so every consumer should come
 * through here — `resolveAccountSelection` in `lib/auth/login-runner.ts`
 * already does, and the request path can adopt the same helper for runtime
 * account pinning.
 */
export function resolveAccountIdOverride(): string | undefined {
	return parseAccountIdOverride(process.env.CODEX_AUTH_ACCOUNT_ID);
}

/**
 * Get the effective CODEX_MODE setting.
 * Priority: environment variable > config file > default (true).
 *
 * @param pluginConfig - Plugin configuration from file
 * @returns True if CODEX_MODE should be enabled
 */
export function getCodexMode(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting("CODEX_MODE", pluginConfig.codexMode, true);
}

export function getRequestTransformMode(pluginConfig: PluginConfig): "native" | "legacy" {
	return resolveStringSetting(
		"CODEX_AUTH_REQUEST_TRANSFORM_MODE",
		pluginConfig.requestTransformMode,
		"native",
		REQUEST_TRANSFORM_MODES,
	);
}

export function getCodexTuiV2(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting("CODEX_TUI_V2", pluginConfig.codexTuiV2, true);
}

export function getCodexTuiColorProfile(
	pluginConfig: PluginConfig,
): "truecolor" | "ansi16" | "ansi256" {
	return resolveStringSetting(
		"CODEX_TUI_COLOR_PROFILE",
		pluginConfig.codexTuiColorProfile,
		"truecolor",
		TUI_COLOR_PROFILES,
	);
}

export function getCodexTuiGlyphMode(
	pluginConfig: PluginConfig,
): "ascii" | "unicode" | "auto" {
	return resolveStringSetting(
		"CODEX_TUI_GLYPHS",
		pluginConfig.codexTuiGlyphMode,
		"ascii",
		TUI_GLYPH_MODES,
	);
}

export function getCodexTuiMaskEmail(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_TUI_MASK_EMAIL",
		pluginConfig.maskEmail,
		false,
	);
}

export function getCodexTuiMaskEmailInQuotaDetails(
	pluginConfig: PluginConfig,
): boolean {
	return resolveBooleanSetting(
		"CODEX_TUI_MASK_EMAIL_DETAILS",
		pluginConfig.maskEmailInQuotaDetails,
		false,
	);
}

/**
 * Whether quota percentages are worded as headroom or as consumption.
 *
 * Defaults to `free`, which is how Codex itself reports a quota. Only the
 * wording changes: exhaustion, rotation blocks, notification thresholds and
 * the status line's warning/danger colouring all stay keyed on the remaining
 * percentage.
 */
export function getQuotaDisplay(pluginConfig: PluginConfig): QuotaDisplayMode {
	return resolveStringSetting(
		"CODEX_AUTH_QUOTA_DISPLAY",
		pluginConfig.quotaDisplay,
		DEFAULT_QUOTA_DISPLAY_MODE,
		QUOTA_DISPLAY_MODE_SET,
	);
}

export type LimitsSortField = "account" | "usage" | "reset";
export type LimitsSortDirection = "asc" | "desc";

/**
 * Default account order for the standalone `limits` CLI. `--sort` and
 * `--asc`/`--desc` on the command line override each half independently.
 * File-only, like `quotaStatus`: a display preference belongs to a person.
 */
export function getLimitsSort(pluginConfig: PluginConfig): {
	by: LimitsSortField;
	direction: LimitsSortDirection;
} {
	const config = pluginConfig.limitsSort;
	return {
		by: pickEnum(config?.by, ["account", "usage", "reset"] as const, "account"),
		direction: pickEnum(config?.direction, ["asc", "desc"] as const, "asc"),
	};
}

export function getFastSession(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_FAST_SESSION",
		pluginConfig.fastSession,
		false,
	);
}

/**
 * Spend Codex credits once no account entitled to the model has plan quota
 * left. Off by default: an account at 100% of its plan window keeps serving
 * on its credit balance by itself, so without this the plugin keeps such
 * accounts out of rotation rather than spend money nobody asked it to.
 */
export function getSpendCredits(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_SPEND_CREDITS",
		pluginConfig.spendCredits,
		false,
	);
}

export function getBeginnerSafeMode(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_BEGINNER_SAFE_MODE",
		pluginConfig.beginnerSafeMode,
		false,
	);
}

const FAST_SESSION_STRATEGIES = new Set(["hybrid", "always"] as const);

export function getFastSessionStrategy(pluginConfig: PluginConfig): "hybrid" | "always" {
	// RC-9: validate env-supplied strategy through the shared Zod enum helper
	// so bogus values (e.g. `CODEX_AUTH_FAST_SESSION_STRATEGY=turbo`) fall
	// back to the config / default instead of propagating.
	const envValue = parseEnumEnv(
		process.env.CODEX_AUTH_FAST_SESSION_STRATEGY,
		FAST_SESSION_STRATEGIES as ReadonlySet<"hybrid" | "always">,
	);
	if (envValue !== undefined) return envValue;
	return pluginConfig.fastSessionStrategy === "always" ? "always" : "hybrid";
}

export type RotationStrategy = "hybrid" | "sticky" | "round-robin" | "custom";

const ROTATION_STRATEGIES = new Set([
	"hybrid",
	"sticky",
	"round-robin",
	"custom",
] as const);

/**
 * Account load-balancing strategy (issue #183).
 *
 * - `hybrid` (default): unchanged historical behavior — stick to the current
 *   account while it is healthy, otherwise score-select the next one
 *   (health + tokens + freshness, which *spreads* load across accounts).
 * - `sticky`: drain-first. Stay on the current account while it has quota,
 *   and when it is exhausted pick the lowest-indexed available account so load
 *   *concentrates* on as few accounts as possible. This staggers weekly-quota
 *   cooldowns instead of exhausting every account at once.
 * - `round-robin`: advance through accounts in order on every selection.
 *
 * Env override `CODEX_AUTH_ROTATION_STRATEGY` wins over config; bogus values
 * fall back to the config / default via the shared Zod enum helper.
 */
export function getRotationStrategy(pluginConfig: PluginConfig): RotationStrategy {
	const envValue = parseEnumEnv(
		process.env.CODEX_AUTH_ROTATION_STRATEGY,
		ROTATION_STRATEGIES as ReadonlySet<RotationStrategy>,
	);
	if (envValue !== undefined) return envValue;
	const configured = pluginConfig.rotationStrategy;
	if (configured === "sticky" || configured === "round-robin" || configured === "custom") return configured;
	return "hybrid";
}

export function getModelAccountPool(
	pluginConfig: PluginConfig,
	model?: string | null,
): string[] {
	if (!model) return [];
	const normalizedModel = model.trim().toLowerCase();
	for (const [configuredModel, accountIds] of Object.entries(
		pluginConfig.modelAccountPools ?? {},
	)) {
		if (configuredModel.trim().toLowerCase() === normalizedModel) {
			return [...new Set(accountIds.map((id) => id.trim()).filter(Boolean))];
		}
	}
	return [];
}

export function getModelAccountPoolMode(
	pluginConfig: PluginConfig,
	model?: string | null,
): ModelAccountPoolMode {
	if (!model) return "preferred";
	const normalizedModel = model.trim().toLowerCase();
	for (const [configuredModel, mode] of Object.entries(
		pluginConfig.modelAccountPoolModes ?? {},
	)) {
		if (configuredModel.trim().toLowerCase() === normalizedModel) return mode;
	}
	return "preferred";
}

export function getFastSessionMaxInputItems(pluginConfig: PluginConfig): number {
	return resolveIntegerSetting(
		"CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS",
		pluginConfig.fastSessionMaxInputItems,
		30,
		{ min: 8 },
	);
}

export function getRetryProfile(pluginConfig: PluginConfig): RetryProfile {
	return resolveStringSetting(
		"CODEX_AUTH_RETRY_PROFILE",
		pluginConfig.retryProfile,
		"balanced",
		RETRY_PROFILES,
	);
}

export function getRetryBudgetOverrides(
	pluginConfig: PluginConfig,
): RetryBudgetOverrides {
	const source = pluginConfig.retryBudgetOverrides;
	if (!isRecord(source)) return {};

	const normalized: RetryBudgetOverrides = {};
	const authRefresh = normalizeRetryBudgetValue(source.authRefresh);
	const network = normalizeRetryBudgetValue(source.network);
	const server = normalizeRetryBudgetValue(source.server);
	const rateLimitShort = normalizeRetryBudgetValue(source.rateLimitShort);
	const rateLimitGlobal = normalizeRetryBudgetValue(source.rateLimitGlobal);
	const emptyResponse = normalizeRetryBudgetValue(source.emptyResponse);

	if (authRefresh !== undefined) normalized.authRefresh = authRefresh;
	if (network !== undefined) normalized.network = network;
	if (server !== undefined) normalized.server = server;
	if (rateLimitShort !== undefined) normalized.rateLimitShort = rateLimitShort;
	if (rateLimitGlobal !== undefined) normalized.rateLimitGlobal = rateLimitGlobal;
	if (emptyResponse !== undefined) normalized.emptyResponse = emptyResponse;

	return normalized;
}

export function getRetryAllAccountsRateLimited(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_RETRY_ALL_RATE_LIMITED",
		pluginConfig.retryAllAccountsRateLimited,
		true,
	);
}

export function getRetryAllAccountsMaxWaitMs(pluginConfig: PluginConfig): number {
	// Deliberately resolveNumberSetting, not resolveDurationMsSetting: `0` is
	// a documented "wait without a bound" for riding out multi-day quota
	// resets, so the 24h ceiling the other durations take must not apply.
	return resolveNumberSetting(
		"CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS",
		pluginConfig.retryAllAccountsMaxWaitMs,
		0,
		{ min: 0 },
	);
}

export function getRetryAllAccountsMaxRetries(pluginConfig: PluginConfig): number {
	return resolveIntegerSetting(
		"CODEX_AUTH_RETRY_ALL_MAX_RETRIES",
		pluginConfig.retryAllAccountsMaxRetries,
		Infinity,
		{ min: 0 },
	);
}

export function getUnsupportedCodexPolicy(
	pluginConfig: PluginConfig,
): UnsupportedCodexPolicy {
	// RC-9: validate the env-supplied policy through the shared Zod enum
	// helper. Unknown policy strings fall back to the config / legacy
	// fallback path rather than being accepted as-is.
	const envPolicy = parseEnumEnv(
		process.env.CODEX_AUTH_UNSUPPORTED_MODEL_POLICY,
		UNSUPPORTED_CODEX_POLICIES as ReadonlySet<UnsupportedCodexPolicy>,
	);
	if (envPolicy !== undefined) {
		return envPolicy;
	}

	const configPolicy =
		typeof pluginConfig.unsupportedCodexPolicy === "string"
			? pluginConfig.unsupportedCodexPolicy.toLowerCase()
			: undefined;
	if (configPolicy && UNSUPPORTED_CODEX_POLICIES.has(configPolicy)) {
		return configPolicy as UnsupportedCodexPolicy;
	}

	const legacyEnvFallback = parseBooleanEnv(
		process.env.CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL,
	);
	if (legacyEnvFallback !== undefined) {
		return legacyEnvFallback ? "fallback" : "strict";
	}

	if (typeof pluginConfig.fallbackOnUnsupportedCodexModel === "boolean") {
		return pluginConfig.fallbackOnUnsupportedCodexModel
			? "fallback"
			: "strict";
	}

	return "strict";
}

export function getFallbackOnUnsupportedCodexModel(pluginConfig: PluginConfig): boolean {
	return getUnsupportedCodexPolicy(pluginConfig) === "fallback";
}

export function getFallbackToGpt52OnUnsupportedGpt53(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_FALLBACK_GPT53_TO_GPT52",
		pluginConfig.fallbackToGpt52OnUnsupportedGpt53,
		true,
	);
}

export function getUnsupportedCodexFallbackChain(
	pluginConfig: PluginConfig,
): Record<string, string[]> {
	const chain = pluginConfig.unsupportedCodexFallbackChain;
	if (!chain || typeof chain !== "object") {
		return {};
	}

	const normalizeModel = (value: string): string => {
		const trimmed = value.trim().toLowerCase();
		if (!trimmed) return "";
		const stripped = trimmed.includes("/")
			? (trimmed.split("/").pop() ?? trimmed)
			: trimmed;
		return stripEffortSuffix(stripped);
	};

	// Null-prototype: the keys come from settings.json, which reaches here via
	// `JSON.parse`, and a parsed `__proto__` key IS a real own property (unlike
	// one written as an object literal). On a plain object it would reassign
	// this object's prototype rather than add a row.
	const normalized: Record<string, string[]> = Object.create(null);
	for (const [key, value] of Object.entries(chain)) {
		if (typeof key !== "string" || !Array.isArray(value)) continue;
		const normalizedKey = normalizeModel(key);
		if (!normalizedKey) continue;

		const targets = value
			.map((target) => (typeof target === "string" ? normalizeModel(target) : ""))
			.filter((target) => target.length > 0);

		if (targets.length > 0) {
			normalized[normalizedKey] = targets;
		}
	}

	return normalized;
}

export function getTokenRefreshSkewMs(pluginConfig: PluginConfig): number {
	return resolveDurationMsSetting(
		"CODEX_AUTH_TOKEN_REFRESH_SKEW_MS",
		pluginConfig.tokenRefreshSkewMs,
		60_000,
		{ min: 0 },
	);
}

export function getRateLimitToastDebounceMs(pluginConfig: PluginConfig): number {
	return resolveDurationMsSetting(
		"CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS",
		pluginConfig.rateLimitToastDebounceMs,
		60_000,
		{ min: 0 },
	);
}

export function getSessionRecovery(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_SESSION_RECOVERY",
		pluginConfig.sessionRecovery,
		true,
	);
}

export function getAutoResume(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_AUTO_RESUME",
		pluginConfig.autoResume,
		true,
	);
}

export function getAutoUpdate(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_AUTO_UPDATE",
		pluginConfig.autoUpdate,
		true,
	);
}

export function getToastDurationMs(pluginConfig: PluginConfig): number {
	return resolveDurationMsSetting(
		"CODEX_AUTH_TOAST_DURATION_MS",
		pluginConfig.toastDurationMs,
		5_000,
		{ min: 1_000 },
	);
}

/**
 * Gates only the informational "Using <account> (N/N)" account-selection toast.
 * Warning/error toasts (rate limits, expired auth, recovery, retries) are never
 * affected by this setting.
 */
export function getAccountToastsEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_ACCOUNT_TOASTS",
		pluginConfig.accountToasts,
		true,
	);
}

export function getPerProjectAccounts(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PER_PROJECT_ACCOUNTS",
		pluginConfig.perProjectAccounts,
		true,
	);
}

/**
 * Whether the credential store is snapshotted before a significant write.
 *
 * On by default: the snapshots are the only recourse if the accounts file is
 * ever replaced wholesale, and they are worth little unless they are recent
 * enough to hold refresh tokens that still work.
 */
export function getCredentialSnapshots(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_CREDENTIAL_SNAPSHOTS",
		pluginConfig.credentialSnapshots,
		true,
	);
}

/**
 * How many credential snapshots to keep. `0` keeps every snapshot; turning the
 * feature off is {@link getCredentialSnapshots}' job, not a magic zero.
 */
export function getCredentialSnapshotsMaxCount(pluginConfig: PluginConfig): number {
	// This env override is strict where the other number settings clamp: a
	// value the file schema would reject (non-integer, or below the floor)
	// falls back to the config file / default instead of being silently
	// repaired. Flooring "-5" to 0 would select keep-everything — the
	// unbounded snapshot growth the floor exists to rule out — and truncating
	// "2.5" would honour a count the user never wrote.
	const envValue = parseIntegerEnv(
		process.env.CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT,
		0,
	);
	if (envValue !== undefined) return envValue;
	const configValue = pluginConfig.credentialSnapshotsMaxCount;
	return configValue !== undefined && Number.isInteger(configValue) && configValue >= 0
		? configValue
		: 10;
}

export function getParallelProbing(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PARALLEL_PROBING",
		pluginConfig.parallelProbing,
		false,
	);
}

export function getParallelProbingMaxConcurrency(pluginConfig: PluginConfig): number {
	return resolveIntegerSetting(
		"CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY",
		pluginConfig.parallelProbingMaxConcurrency,
		2,
		{ min: 1, max: 5 },
	);
}

export function getEmptyResponseMaxRetries(pluginConfig: PluginConfig): number {
	return resolveIntegerSetting(
		"CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES",
		pluginConfig.emptyResponseMaxRetries,
		2,
		{ min: 0 },
	);
}

export function getEmptyResponseRetryDelayMs(pluginConfig: PluginConfig): number {
	return resolveDurationMsSetting(
		"CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS",
		pluginConfig.emptyResponseRetryDelayMs,
		1_000,
		{ min: 0 },
	);
}

export function getPidOffsetEnabled(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PID_OFFSET_ENABLED",
		pluginConfig.pidOffsetEnabled,
		false,
	);
}

export function getFetchTimeoutMs(pluginConfig: PluginConfig): number {
	return resolveDurationMsSetting(
		"CODEX_AUTH_FETCH_TIMEOUT_MS",
		pluginConfig.fetchTimeoutMs,
		60_000,
		{ min: 1_000 },
	);
}

export function getStreamStallTimeoutMs(pluginConfig: PluginConfig): number {
	return resolveDurationMsSetting(
		"CODEX_AUTH_STREAM_STALL_TIMEOUT_MS",
		pluginConfig.streamStallTimeoutMs,
		45_000,
		{ min: 1_000 },
	);
}

/**
 * Overall post-headers deadline for a non-streaming SSE conversion. The stall
 * timeout above bounds only the gap between chunks and is re-armed per read, so
 * a drip that always lands inside the gap would otherwise hang the conversion
 * forever. This one is armed once and never extended.
 */
export function getMaxStreamDurationMs(pluginConfig: PluginConfig): number {
	return resolveDurationMsSetting(
		"CODEX_AUTH_MAX_STREAM_DURATION_MS",
		pluginConfig.maxStreamDurationMs,
		300_000,
		{ min: 1_000 },
	);
}

export interface QuotaNotificationsConfig {
	enabled: boolean;
	/** Poll usage to block fully spent subscription quotas before they spend Credits. */
	autoProtectCredits?: boolean;
	/** Spend a banked rate-limit reset credit once the weekly quota runs low. */
	autoRedeemResets?: boolean;
	/** Weekly quota left (percent) at or below which a credit is spent. */
	autoRedeemResetsBelowPercent?: number;
	intervalMs: number;
	notifyEveryCheck: boolean;
	thresholds: number[];
}

export const DEFAULT_QUOTA_NOTIFICATION_THRESHOLDS: readonly number[] = [25, 10, 0];

export function getQuotaNotifications(
	pluginConfig: PluginConfig,
): QuotaNotificationsConfig {
	const config = pluginConfig.quotaNotifications;

	const enabled = resolveBooleanSetting(
		"CODEX_AUTH_QUOTA_NOTIFICATIONS",
		config?.enabled,
		false,
	);
	const autoProtectCredits = resolveBooleanSetting(
		"CODEX_AUTH_AUTO_PROTECT_CREDITS",
		config?.autoProtectCredits,
		true,
	);

	const autoRedeemResets = resolveBooleanSetting(
		"CODEX_AUTH_AUTO_REDEEM_RESETS",
		config?.autoRedeemResets,
		false,
	);
	const autoRedeemResetsBelowPercent = resolveNumberSetting(
		"CODEX_AUTH_AUTO_REDEEM_RESETS_BELOW_PERCENT",
		config?.autoRedeemResetsBelowPercent,
		10,
		{ min: 0, max: 100 },
	);

	const intervalMs = resolveDurationMsSetting(
		"CODEX_AUTH_QUOTA_NOTIFICATIONS_INTERVAL_MS",
		config?.intervalMs,
		1_800_000,
		{ min: 30_000 },
	);

	const configured = config?.thresholds;
	let thresholds: number[];
	if (configured === undefined) {
		thresholds = [...DEFAULT_QUOTA_NOTIFICATION_THRESHOLDS];
	} else {
		// Normalize: unique, in range, most-generous first. An explicitly empty
		// array is honoured — it is the only way to run `notifyEveryCheck`
		// without threshold alerts, so it must not fall back to the defaults.
		// The range guard looks redundant next to the schema's own
		// `min(0).max(100)`, and through the file path it is — it exists for
		// callers that hand this function an unvalidated PluginConfig.
		thresholds = Array.from(new Set(configured))
			.filter((value) => Number.isFinite(value) && value >= 0 && value <= 100)
			.sort((a, b) => b - a);
	}

	return {
		enabled,
		autoProtectCredits,
		autoRedeemResets,
		autoRedeemResetsBelowPercent,
		intervalMs,
		notifyEveryCheck: config?.notifyEveryCheck ?? false,
		thresholds,
	};
}

/** One thing the prompt status line can be showing at a given moment. */
export type QuotaStatusScreen = "active" | "overview" | "resets" | "credits";

/** Whether the line appears for every model or only for the ones it describes. */
export type QuotaStatusAudience = "always" | "codex-models";

const QUOTA_STATUS_SCREENS: readonly QuotaStatusScreen[] = [
	"active",
	"overview",
	"resets",
	"credits",
];
const QUOTA_STATUS_AUDIENCES: readonly QuotaStatusAudience[] = [
	"always",
	"codex-models",
];
const QUOTA_OVERVIEW_LAYOUTS: readonly QuotaOverviewLayout[] = [
	"accounts",
	"aggregate",
	"count",
	"total",
];
const QUOTA_OVERVIEW_NAMES: readonly QuotaOverviewNames[] = [
	"number",
	"label",
	"none",
];
const QUOTA_OVERVIEW_ORDERS: readonly QuotaOverviewOrder[] = [
	"number",
	"most-used",
	"least-used",
	"renewing-earliest",
	"renewing-latest",
];
const QUOTA_OVERVIEW_RESET_TIMES: readonly QuotaOverviewResetTimes[] = [
	"never",
	"low",
	"always",
];
const DEFAULT_QUOTA_STATUS_ROTATE_MS = 5_000;
const MIN_QUOTA_STATUS_ROTATE_MS = 1_000;
const MAX_QUOTA_STATUS_ROWS = 4;

export interface QuotaStatusConfig {
	/**
	 * The screens to show, in the order they take turns. `active` names the
	 * account serving requests, which is how the status line has always
	 * worked; `overview` describes the whole pool; `resets` lists the banked
	 * reset credits worth redeeming once nothing has headroom left; `credits`
	 * lists the accounts holding a Codex credit balance at that point. More than
	 * one screen alternates every {@link rotateMs}.
	 */
	screens: QuotaStatusScreen[];
	rotateMs: number;
	/** Per-account segments, grouped percentages, a count, or only the total. */
	layout: QuotaOverviewLayout;
	/** `#1`, the account's own name, or nothing at all. */
	accountNames: QuotaOverviewNames;
	order: QuotaOverviewOrder;
	/** `5x` / `20x` plan allotment badges. */
	multipliers: boolean;
	/** `66% of 65x`: what the pool the percentage is taken over adds up to. */
	allotment: boolean;
	/** Which accounts get a `3d` countdown: none, the low ones, or all. */
	resetTimes: QuotaOverviewResetTimes;
	/** `1r` for banked rate-limit resets redeemable now. */
	resetCredits: boolean;
	/** Next reset's delta, or all future capacity returns when set to `all`. */
	recovery: boolean | "all";
	/** Minimum pool usage before showing actionable reset credits. */
	resetsMinUsedPercent: number;
	/**
	 * Rows the line may occupy. A ceiling rather than a height: a rendering
	 * that fits on one row still takes one, so raising this costs nothing until
	 * the terminal is narrow enough for the line to need the room.
	 */
	rows: number;
	showFor: QuotaStatusAudience;
}

function pickEnum<T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: T,
): T {
	return allowed.find((entry) => entry === value) ?? fallback;
}

/**
 * The screens to rotate through, from either a single value or a list.
 *
 * Unknown names are dropped rather than failing: this is presentation, and a
 * typo should cost the line its extra screen, not the session its status.
 * Duplicates are collapsed so a list cannot make one screen come up twice as
 * often as the others.
 */
function resolveQuotaStatusScreens(value: unknown): QuotaStatusScreen[] {
	const requested = Array.isArray(value) ? value : [value];
	const screens: QuotaStatusScreen[] = [];
	for (const entry of requested) {
		const screen = QUOTA_STATUS_SCREENS.find((candidate) => candidate === entry);
		if (screen && !screens.includes(screen)) screens.push(screen);
	}
	return screens.length > 0 ? screens : ["active"];
}

/**
 * How the prompt status line describes the account pool.
 *
 * Every default here is the behaviour an install already has, so adding
 * `"mode": "overview"` and nothing else changes the line's subject without
 * changing anything about how it is written. The switches only apply to the
 * pool screens; they are resolved unconditionally anyway so a reader of this
 * config sees what `overview` would render without having to enable it first.
 *
 * Presentation preference belongs to a person rather than to a shell, so none
 * of this is overridable by environment variable - the config file is the only
 * place it is read from.
 */
export function getQuotaStatus(pluginConfig: PluginConfig): QuotaStatusConfig {
	const config = pluginConfig.quotaStatus;
	const resetTimes = config?.resetTimes;
	const rotateMs = config?.rotateMs;
	return {
		screens: resolveQuotaStatusScreens(config?.mode),
		rotateMs:
			typeof rotateMs === "number" && Number.isFinite(rotateMs)
				? Math.min(
						MAX_CONFIG_DURATION_MS,
						Math.max(MIN_QUOTA_STATUS_ROTATE_MS, rotateMs),
					)
				: DEFAULT_QUOTA_STATUS_ROTATE_MS,
		// Per-account by default: someone switching to `overview` is asking
		// where each account stands, and the count alone is the one form that
		// does not answer that.
		layout:
			QUOTA_OVERVIEW_LAYOUTS.find((entry) => entry === config?.layout) ??
			(config?.accounts === false ? "count" : "accounts"),
		accountNames: pickEnum(
			config?.accountNames,
			QUOTA_OVERVIEW_NAMES,
			"number",
		),
		order: pickEnum(config?.order, QUOTA_OVERVIEW_ORDERS, "number"),
		multipliers: config?.multipliers ?? false,
		allotment: config?.allotment ?? false,
		// `low` by default: a spent account is the one an account list is read
		// to find, and "when does it come back" is the next question every
		// time, while the same countdown beside a healthy account is noise.
		resetTimes:
			typeof resetTimes === "boolean"
				? resetTimes
					? "low"
					: "never"
				: pickEnum(resetTimes, QUOTA_OVERVIEW_RESET_TIMES, "low"),
		resetCredits: config?.resetCredits ?? false,
		recovery: config?.recovery ?? false,
		// Finite-clamped like rotateMs/rows above: NaN would make every
		// `used >= min` comparison downstream silently false.
		resetsMinUsedPercent:
			typeof config?.resetsMinUsedPercent === "number" &&
			Number.isFinite(config.resetsMinUsedPercent)
				? Math.min(100, Math.max(0, config.resetsMinUsedPercent))
				: 100,
		rows:
			typeof config?.rows === "number" && Number.isFinite(config.rows)
				? Math.min(MAX_QUOTA_STATUS_ROWS, Math.max(1, Math.trunc(config.rows)))
				: 1,
		showFor: pickEnum(config?.showFor, QUOTA_STATUS_AUDIENCES, "always"),
	};
}

import { readFileSync, existsSync, promises as fs } from "node:fs";
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
import { stripEffortSuffix } from "./request/helpers/effort-suffix.js";
import { renameWithWindowsRetry } from "./storage/atomic-write.js";
import {
	PluginConfigSchema,
	getValidationErrors,
	EnvBooleanSchema,
	EnvNumberSchema,
	makeEnvEnumSchema,
} from "./schemas.js";

const CONFIG_PATH = join(homedir(), ".opencode", "openai-codex-auth-config.json");
const TUI_COLOR_PROFILES = new Set(["truecolor", "ansi16", "ansi256"]);
const TUI_GLYPH_MODES = new Set(["ascii", "unicode", "auto"]);
const REQUEST_TRANSFORM_MODES = new Set(["native", "legacy"]);
const UNSUPPORTED_CODEX_POLICIES = new Set(["strict", "fallback"]);
const RETRY_PROFILES = new Set(["conservative", "balanced", "aggressive"]);

export type UnsupportedCodexPolicy = "strict" | "fallback";

export type ModelAccountPoolMutation = "set" | "add" | "remove" | "clear";

export interface ModelAccountPoolMutationResult {
	model: string;
	previousAccountIds: string[];
	accountIds: string[];
	changed: boolean;
	dryRun: boolean;
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
};

/**
 * Load plugin configuration from ~/.opencode/openai-codex-auth-config.json
 * Falls back to defaults if file doesn't exist or is invalid
 *
 * @returns Plugin configuration
 */
export function loadPluginConfig(): PluginConfig {
	try {
		if (!existsSync(CONFIG_PATH)) {
			return DEFAULT_CONFIG;
		}

		const fileContent = readFileSync(CONFIG_PATH, "utf-8");
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
		if (!isRecord(userConfig)) {
			logWarn(
				`Plugin config at ${CONFIG_PATH} is not a JSON object; using defaults.`,
			);
			return DEFAULT_CONFIG;
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
		return { ...DEFAULT_CONFIG, ...salvaged };
	} catch (error) {
		logWarn(
			`Failed to load config from ${CONFIG_PATH}: ${(error as Error).message}`,
		);
		return DEFAULT_CONFIG;
	}
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
	options: { dryRun?: boolean } = {},
): Promise<ModelAccountPoolMutationResult> {
	const pending = modelAccountPoolMutationQueue.then(async () => {
		await fs.mkdir(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
		const release = await lock(CONFIG_PATH, {
			realpath: false,
			stale: 10_000,
			update: 2_000,
			retries: {
				retries: 20,
				factor: 1.2,
				minTimeout: 25,
				maxTimeout: 200,
				randomize: true,
			},
		});
		try {
			return await performModelAccountPoolMutation(
				model,
				mutation,
				accountIds,
				options,
			);
		} finally {
			await release();
		}
	});
	modelAccountPoolMutationQueue = pending.then(
		() => undefined,
		() => undefined,
	);
	return pending;
}

async function performModelAccountPoolMutation(
	model: string,
	mutation: ModelAccountPoolMutation,
	accountIds: readonly string[],
	options: { dryRun?: boolean },
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
	});
	if (!poolResult.success) {
		throw new Error(
			`Existing modelAccountPools configuration is invalid: ${getValidationErrors(
				PluginConfigSchema,
				{ modelAccountPools: rawConfig.modelAccountPools },
			)[0] ?? "validation failed"}`,
		);
	}

	const pools = { ...(poolResult.data.modelAccountPools ?? {}) };
	const matchingKeys = Object.keys(pools).filter(
		(key) => key.trim().toLowerCase() === normalizedModel,
	);
	const previousAccountIds = Array.from(
		new Set(matchingKeys.flatMap((key) => pools[key] ?? [])),
	);
	for (const key of matchingKeys) delete pools[key];

	const normalizedAccountIds = Array.from(
		new Set(accountIds.map((id) => id.trim()).filter(Boolean)),
	);
	let nextAccountIds: string[];
	if (mutation === "set") {
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

	if (nextAccountIds.length > 0) pools[normalizedModel] = nextAccountIds;
	const changed =
		matchingKeys.length !== (nextAccountIds.length > 0 ? 1 : 0) ||
		previousAccountIds.length !== nextAccountIds.length ||
		previousAccountIds.some((id, index) => id !== nextAccountIds[index]) ||
		(matchingKeys[0] !== undefined && matchingKeys[0] !== normalizedModel);

	if (changed && options.dryRun !== true) {
		if (Object.keys(pools).length > 0) {
			rawConfig.modelAccountPools = pools;
		} else {
			delete rawConfig.modelAccountPools;
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
		previousAccountIds,
		accountIds: nextAccountIds,
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
	const salvaged: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const probe = PluginConfigSchema.safeParse({ [key]: value });
		if (probe.success) {
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

/**
 * Get the effective CODEX_MODE setting
 * Priority: environment variable > config file > default (true)
 *
 * @param pluginConfig - Plugin configuration from file
 * @returns True if CODEX_MODE should be enabled
 */
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
	options?: { min?: number },
): number {
	const envValue = parseNumberEnv(process.env[envName]);
	const candidate = envValue ?? configValue ?? defaultValue;
	const min = options?.min;
	if (min !== undefined) {
		return Math.max(min, candidate);
	}
	// istanbul ignore next -- dead code: all callers pass { min: ... }
	return candidate;
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

export function getFastSession(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_FAST_SESSION",
		pluginConfig.fastSession,
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

export type RotationStrategy = "hybrid" | "sticky" | "round-robin";

const ROTATION_STRATEGIES = new Set([
	"hybrid",
	"sticky",
	"round-robin",
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
	if (configured === "sticky" || configured === "round-robin") return configured;
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

export function getFastSessionMaxInputItems(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
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
	return resolveNumberSetting(
		"CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS",
		pluginConfig.retryAllAccountsMaxWaitMs,
		0,
		{ min: 0 },
	);
}

export function getRetryAllAccountsMaxRetries(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
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

	const normalized: Record<string, string[]> = {};
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
	return resolveNumberSetting(
		"CODEX_AUTH_TOKEN_REFRESH_SKEW_MS",
		pluginConfig.tokenRefreshSkewMs,
		60_000,
		{ min: 0 },
	);
}

export function getRateLimitToastDebounceMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
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
	return resolveNumberSetting(
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

export function getParallelProbing(pluginConfig: PluginConfig): boolean {
	return resolveBooleanSetting(
		"CODEX_AUTH_PARALLEL_PROBING",
		pluginConfig.parallelProbing,
		false,
	);
}

export function getParallelProbingMaxConcurrency(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY",
		pluginConfig.parallelProbingMaxConcurrency,
		2,
		{ min: 1 },
	);
}

export function getEmptyResponseMaxRetries(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES",
		pluginConfig.emptyResponseMaxRetries,
		2,
		{ min: 0 },
	);
}

export function getEmptyResponseRetryDelayMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
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
	return resolveNumberSetting(
		"CODEX_AUTH_FETCH_TIMEOUT_MS",
		pluginConfig.fetchTimeoutMs,
		60_000,
		{ min: 1_000 },
	);
}

export function getStreamStallTimeoutMs(pluginConfig: PluginConfig): number {
	return resolveNumberSetting(
		"CODEX_AUTH_STREAM_STALL_TIMEOUT_MS",
		pluginConfig.streamStallTimeoutMs,
		45_000,
		{ min: 1_000 },
	);
}

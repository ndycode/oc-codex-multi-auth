/**
 * Zod schemas for runtime validation.
 * These are the single source of truth for data structures.
 * Types are inferred from schemas using z.infer.
 */
import { z } from "zod";
import { MODEL_FAMILIES, type ModelFamily } from "./prompts/codex.js";

// ============================================================================
// Plugin Configuration Schema
// ============================================================================

export const PluginConfigSchema = z.object({
	codexMode: z.boolean().optional(),
	requestTransformMode: z.enum(["native", "legacy"]).optional(),
	codexTuiV2: z.boolean().optional(),
	codexTuiColorProfile: z.enum(["truecolor", "ansi16", "ansi256"]).optional(),
	codexTuiGlyphMode: z.enum(["ascii", "unicode", "auto"]).optional(),
	maskEmail: z.boolean().optional(),
	maskEmailInQuotaDetails: z.boolean().optional(),
	beginnerSafeMode: z.boolean().optional(),
	fastSession: z.boolean().optional(),
	fastSessionStrategy: z.enum(["hybrid", "always"]).optional(),
	rotationStrategy: z.enum(["hybrid", "sticky", "round-robin"]).optional(),
	modelAccountPools: z.record(
		z.string().min(1),
		z.array(z.string().min(1)),
	).optional(),
	fastSessionMaxInputItems: z.number().min(8).max(200).optional(),
	retryProfile: z.enum(["conservative", "balanced", "aggressive"]).optional(),
	retryBudgetOverrides: z.object({
		authRefresh: z.number().int().min(0).optional(),
		network: z.number().int().min(0).optional(),
		server: z.number().int().min(0).optional(),
		rateLimitShort: z.number().int().min(0).optional(),
		rateLimitGlobal: z.number().int().min(0).optional(),
		emptyResponse: z.number().int().min(0).optional(),
	}).optional(),
	retryAllAccountsRateLimited: z.boolean().optional(),
	retryAllAccountsMaxWaitMs: z.number().min(0).optional(),
	retryAllAccountsMaxRetries: z.number().min(0).optional(),
	unsupportedCodexPolicy: z.enum(["strict", "fallback"]).optional(),
	fallbackOnUnsupportedCodexModel: z.boolean().optional(),
	fallbackToGpt52OnUnsupportedGpt53: z.boolean().optional(),
	unsupportedCodexFallbackChain: z.record(
		z.string(),
		z.array(z.string().min(1)),
	).optional(),
	tokenRefreshSkewMs: z.number().min(0).optional(),
	rateLimitToastDebounceMs: z.number().min(0).optional(),
	toastDurationMs: z.number().min(1000).optional(),
	accountToasts: z.boolean().optional(),
	perProjectAccounts: z.boolean().optional(),
	sessionRecovery: z.boolean().optional(),
	autoResume: z.boolean().optional(),
	autoUpdate: z.boolean().optional(),
	parallelProbing: z.boolean().optional(),
	parallelProbingMaxConcurrency: z.number().min(1).max(5).optional(),
	emptyResponseMaxRetries: z.number().min(0).optional(),
	emptyResponseRetryDelayMs: z.number().min(0).optional(),
	pidOffsetEnabled: z.boolean().optional(),
	fetchTimeoutMs: z.number().min(1_000).optional(),
	streamStallTimeoutMs: z.number().min(1_000).optional(),
});

export type PluginConfigFromSchema = z.infer<typeof PluginConfigSchema>;

// ============================================================================
// Account Storage Schemas
// ============================================================================

/**
 * Source of the accountId used for ChatGPT requests.
 */
export const AccountIdSourceSchema = z.enum(["token", "id_token", "org", "manual"]);

export type AccountIdSourceFromSchema = z.infer<typeof AccountIdSourceSchema>;

/**
 * Cooldown reason for temporary account suspension.
 */
export const CooldownReasonSchema = z.enum(["auth-failure", "network-error"]);

export type CooldownReasonFromSchema = z.infer<typeof CooldownReasonSchema>;

/**
 * Last switch reason for account rotation tracking.
 */
export const SwitchReasonSchema = z.enum(["rate-limit", "initial", "rotation"]);

export type SwitchReasonFromSchema = z.infer<typeof SwitchReasonSchema>;

/**
 * Rate limit state - maps model family to reset timestamp.
 */
export const RateLimitStateV3Schema = z.record(z.string(), z.number().optional());

export type RateLimitStateV3FromSchema = z.infer<typeof RateLimitStateV3Schema>;

const AccountTagsSchema = z.array(z.string()).optional().transform((value) => {
	if (!value) return undefined;
	const normalized = value
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
	return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
});

const AccountNoteSchema = z.string().optional().transform((value) => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
});

/**
 * Account metadata V3 - current storage format.
 */
export const AccountMetadataV3Schema = z.object({
	accountId: z.string().optional(),
	organizationId: z.string().optional(),
	accountIdSource: AccountIdSourceSchema.optional(),
	accountLabel: z.string().optional(),
	accountTags: AccountTagsSchema,
	accountNote: AccountNoteSchema,
	email: z.string().optional(),
	refreshToken: z.string().min(1), // Required, non-empty
	accessToken: z.string().optional(),
	expiresAt: z.number().optional(),
	oauthScope: z.string().optional(),
	tokenRotatedAt: z.number().optional(),
	enabled: z.boolean().optional(),
	addedAt: z.number(),
	lastUsed: z.number(),
	lastSwitchReason: SwitchReasonSchema.optional(),
	rateLimitResetTimes: RateLimitStateV3Schema.optional(),
	coolingDownUntil: z.number().optional(),
	cooldownReason: CooldownReasonSchema.optional(),
});

export type AccountMetadataV3FromSchema = z.infer<typeof AccountMetadataV3Schema>;

/**
 * Build activeIndexByFamily schema dynamically from MODEL_FAMILIES.
 */
const modelFamilyEntries = MODEL_FAMILIES.map((family) => [family, z.number().optional()]);
export const ActiveIndexByFamilySchema = z.object(
	Object.fromEntries(modelFamilyEntries) as Record<ModelFamily, z.ZodOptional<z.ZodNumber>>
).partial();

export type ActiveIndexByFamilyFromSchema = z.infer<typeof ActiveIndexByFamilySchema>;

/**
 * Account storage V3 - current storage format with per-family active indices.
 */
export const AccountStorageV3Schema = z.object({
	version: z.literal(3),
	accounts: z.array(AccountMetadataV3Schema),
	activeIndex: z.number().min(0),
	activeIndexByFamily: ActiveIndexByFamilySchema.optional(),
});

export type AccountStorageV3FromSchema = z.infer<typeof AccountStorageV3Schema>;

/**
 * Legacy V1 account metadata for migration support.
 */
export const AccountMetadataV1Schema = z.object({
	accountId: z.string().optional(),
	organizationId: z.string().optional(),
	accountIdSource: AccountIdSourceSchema.optional(),
	accountLabel: z.string().optional(),
	accountTags: AccountTagsSchema,
	accountNote: AccountNoteSchema,
	email: z.string().optional(),
	refreshToken: z.string().min(1),
	accessToken: z.string().optional(),
	expiresAt: z.number().optional(),
	oauthScope: z.string().optional(),
	enabled: z.boolean().optional(),
	addedAt: z.number(),
	lastUsed: z.number(),
	lastSwitchReason: SwitchReasonSchema.optional(),
	rateLimitResetTime: z.number().optional(), // V1 used single value
	coolingDownUntil: z.number().optional(),
	cooldownReason: CooldownReasonSchema.optional(),
});

export type AccountMetadataV1FromSchema = z.infer<typeof AccountMetadataV1Schema>;

/**
 * Legacy V1 storage format for migration support.
 */
export const AccountStorageV1Schema = z.object({
	version: z.literal(1),
	accounts: z.array(AccountMetadataV1Schema),
	activeIndex: z.number().min(0),
});

export type AccountStorageV1FromSchema = z.infer<typeof AccountStorageV1Schema>;

/**
 * Minimal V2 detection schema.
 *
 * V2 was an intermediate account-storage format used by legacy 4.x builds
 * that never shipped a documented shape. We only validate enough to recognise
 * `version: 2` files so the loader can surface a typed `UNKNOWN_V2_FORMAT`
 * error instead of silently discarding credentials. Do not extend this
 * schema without evidence of the real V2 shape.
 */
export const AccountStorageV2DetectionSchema = z.object({
	version: z.literal(2),
	// Use `.nullish()` (accepts `null` OR `undefined`) rather than `.optional()`
	// so a malformed V2 file with `"accounts": null` still matches the V2 shape
	// and flows to the typed UNKNOWN_V2_FORMAT rejection path instead of
	// silently falling through to `return null` and discarding credentials.
	accounts: z.array(z.unknown()).nullish(),
});

export type AccountStorageV2DetectionFromSchema = z.infer<
	typeof AccountStorageV2DetectionSchema
>;

/**
 * Union of V1 and V3 storage formats for migration detection.
 * V2 is intentionally excluded: it is detected separately and rejected with a
 * typed StorageError so users with a V2 file are told how to recover instead
 * of having their credentials silently discarded.
 */
export const AnyAccountStorageSchema = z.discriminatedUnion("version", [
	AccountStorageV1Schema,
	AccountStorageV3Schema,
]);

export type AnyAccountStorageFromSchema = z.infer<typeof AnyAccountStorageSchema>;

// ============================================================================
// Codex CLI Cross-Process Account File Schema
// ============================================================================

/**
 * Schema for a single Codex CLI account entry.
 *
 * This file is produced by a separate process (the Codex CLI) and lives on
 * disk at a known path. It is a cross-trust-boundary input: the file could be
 * stale, truncated, tampered with, or produced by a mismatched Codex CLI
 * version. All fields are therefore `optional` at the schema level — we
 * extract only the fields we need and let `catchall(z.unknown())` preserve
 * any extra fields without rejection.
 *
 * Security note (audit top-20 #11): never trust field shapes via ad-hoc
 * property checks before validating through this schema. The wrapper
 * `CodexCliAccountsSchema` must be applied at the JSON-parse boundary.
 */
export const CodexCliAccountEntrySchema = z
	.object({
		email: z.string().optional(),
		accountId: z.string().optional(),
		auth: z
			.object({
				tokens: z
					.object({
						access_token: z.string().optional(),
						refresh_token: z.string().optional(),
						id_token: z.string().optional(),
					})
					.catchall(z.unknown())
					.optional(),
			})
			.catchall(z.unknown())
			.optional(),
	})
	.catchall(z.unknown());

export type CodexCliAccountEntryFromSchema = z.infer<typeof CodexCliAccountEntrySchema>;

/**
 * Schema for the full Codex CLI accounts file.
 *
 * Applied at the JSON-parse boundary in `lib/accounts.ts:getCodexCliTokenCache`.
 * A validation failure causes the loader to warn+skip (treat cache as empty)
 * rather than throwing — a malformed or attacker-controlled Codex CLI file
 * must never take down the host plugin.
 */
export const CodexCliAccountsSchema = z
	.object({
		accounts: z.array(CodexCliAccountEntrySchema).optional(),
	})
	.catchall(z.unknown());

export type CodexCliAccountsFromSchema = z.infer<typeof CodexCliAccountsSchema>;

// ============================================================================
// Token Result Schemas
// ============================================================================

/**
 * Token failure reason codes.
 */
export const TokenFailureReasonSchema = z.enum([
	"http_error",
	"invalid_response",
	"network_error",
	"missing_refresh",
	"unknown",
]);

export type TokenFailureReasonFromSchema = z.infer<typeof TokenFailureReasonSchema>;

/**
 * Successful token exchange result.
 */
export const TokenSuccessSchema = z.object({
	type: z.literal("success"),
	access: z.string().min(1),
	refresh: z.string().min(1),
	expires: z.number(),
	idToken: z.string().optional(),
	scope: z.string().optional(),
	multiAccount: z.boolean().optional(),
});

export type TokenSuccessFromSchema = z.infer<typeof TokenSuccessSchema>;

/**
 * Failed token exchange result.
 */
export const TokenFailureSchema = z.object({
	type: z.literal("failed"),
	reason: TokenFailureReasonSchema.optional(),
	statusCode: z.number().optional(),
	message: z.string().optional(),
});

export type TokenFailureFromSchema = z.infer<typeof TokenFailureSchema>;

/**
 * Token result - discriminated union of success/failure.
 */
export const TokenResultSchema = z.discriminatedUnion("type", [
	TokenSuccessSchema,
	TokenFailureSchema,
]);

export type TokenResultFromSchema = z.infer<typeof TokenResultSchema>;

// ============================================================================
// OAuth Response Schemas (for validating API responses)
// ============================================================================

/**
 * OAuth token response from OpenAI.
 */
export const OAuthTokenResponseSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().optional(),
	expires_in: z.number(),
	id_token: z.string().optional(),
	token_type: z.string().optional(),
	scope: z.string().optional(),
});

export type OAuthTokenResponseFromSchema = z.infer<typeof OAuthTokenResponseSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safely parse plugin configuration with detailed error logging.
 * Returns null on failure, allowing graceful degradation.
 */
export function safeParsePluginConfig(data: unknown): PluginConfigFromSchema | null {
	const result = PluginConfigSchema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Safely parse account storage (any version).
 * Returns null on failure, allowing graceful degradation.
 */
export function safeParseAccountStorage(data: unknown): AnyAccountStorageFromSchema | null {
	const result = AnyAccountStorageSchema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Safely parse V3 account storage specifically.
 * Returns null on failure.
 */
export function safeParseAccountStorageV3(data: unknown): AccountStorageV3FromSchema | null {
	const result = AccountStorageV3Schema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Safely parse token result.
 * Returns null on failure.
 */
export function safeParseTokenResult(data: unknown): TokenResultFromSchema | null {
	const result = TokenResultSchema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Safely parse OAuth token response from API.
 * Returns null on failure.
 */
export function safeParseOAuthTokenResponse(data: unknown): OAuthTokenResponseFromSchema | null {
	const result = OAuthTokenResponseSchema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Get validation errors as a flat array of strings.
 * Useful for logging and error messages.
 */
export function getValidationErrors(schema: z.ZodType, data: unknown): string[] {
	const result = schema.safeParse(data);
	if (result.success) {
		return [];
	}
	return result.error.issues.map((issue) => {
		const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
		return `${path}${issue.message}`;
	});
}

// ============================================================================
// JWT Payload Schema (process boundary: decoded JWT from OAuth provider)
// ============================================================================

/**
 * JWT payload schema.
 *
 * The JWT is produced by the OAuth provider (ChatGPT backend) and decoded on
 * the client. Unknown claims are preserved via `catchall(z.unknown())` so we
 * never reject a valid-but-unfamiliar token, but the claims we actually read
 * (account id, email, organization hints) are shape-checked. A failed parse
 * causes callers to treat the JWT as opaque (same behavior as an undecodable
 * JWT) instead of blindly casting arbitrary JSON into our `JWTPayload` type.
 */
export const JWTPayloadSchema = z
	.object({
		"https://api.openai.com/auth": z
			.object({
				chatgpt_account_id: z.string().optional(),
				organizations: z.unknown().optional(),
				email: z.string().optional(),
				chatgpt_user_email: z.string().optional(),
			})
			.catchall(z.unknown())
			.optional(),
		organizations: z.unknown().optional(),
		orgs: z.unknown().optional(),
		accounts: z.unknown().optional(),
		workspaces: z.unknown().optional(),
		teams: z.unknown().optional(),
		email: z.string().optional(),
		preferred_username: z.string().optional(),
	})
	.catchall(z.unknown());

export type JWTPayloadFromSchema = z.infer<typeof JWTPayloadSchema>;

/**
 * Safely parse a decoded JWT payload.
 * Returns null on failure so callers can treat the token as opaque.
 */
export function safeParseJWTPayload(data: unknown): JWTPayloadFromSchema | null {
	const result = JWTPayloadSchema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

// ============================================================================
// Prompt Cache Metadata Schemas (process boundary: on-disk cache files)
// ============================================================================

/**
 * Cache metadata for Codex instructions fetched from GitHub.
 *
 * File lives at `~/.opencode/cache/<model>-instructions-meta.json` and is
 * read at startup and after stale-while-revalidate refreshes. The file can be
 * corrupted, truncated, or produced by a different plugin version, so the
 * schema is strict: invalid files fall back to "no cached metadata" (the
 * same state as a missing file) and force a fresh fetch.
 */
export const CacheMetadataSchema = z.object({
	etag: z.string().nullable(),
	tag: z.string(),
	lastChecked: z.number(),
	url: z.string(),
});

export type CacheMetadataFromSchema = z.infer<typeof CacheMetadataSchema>;

export function safeParseCacheMetadata(data: unknown): CacheMetadataFromSchema | null {
	const result = CacheMetadataSchema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

/**
 * Cache metadata for the OpenCode codex prompt fetched from GitHub.
 *
 * File lives at `~/.opencode/cache/opencode-codex-meta.json`. Same trust
 * considerations as `CacheMetadataSchema`; fall back to empty cache on
 * parse failure instead of crashing the prompt fetcher.
 */
export const OpenCodeCodexCacheMetaSchema = z.object({
	etag: z.string(),
	lastFetch: z.string().optional(),
	lastChecked: z.number(),
	sourceUrl: z.string().optional(),
});

export type OpenCodeCodexCacheMetaFromSchema = z.infer<typeof OpenCodeCodexCacheMetaSchema>;

export function safeParseOpenCodeCodexCacheMeta(
	data: unknown,
): OpenCodeCodexCacheMetaFromSchema | null {
	const result = OpenCodeCodexCacheMetaSchema.safeParse(data);
	if (!result.success) {
		return null;
	}
	return result.data;
}

// ============================================================================
// Environment Variable Schemas (process boundary: process.env)
// ============================================================================

/**
 * Boolean env-var parser.
 *
 * Historical semantics (kept verbatim for backward compatibility with the
 * pre-RC-9 `parseBooleanEnv` helper): the literal string `"1"` is truthy, any
 * other non-empty string (including `"0"`, `"yes"`, `"true"`) is falsy, and
 * `undefined` remains `undefined` so callers can fall back to the config
 * file / hard-coded default. The schema does not throw on invalid input;
 * boolean env vars are a process boundary but one where permissive parsing
 * is the documented contract.
 */
export const EnvBooleanSchema = z
	.string()
	.optional()
	.transform((value): boolean | undefined => {
		if (value === undefined) return undefined;
		return value === "1";
	});

/**
 * Numeric env-var parser.
 *
 * Accepts any string that coerces to a finite JS number. Non-finite values
 * (empty string, `"abc"`, `"NaN"`, `"Infinity"` treated as non-finite) fall
 * back to undefined so callers can apply config-file / hard-coded defaults
 * instead of silently using a poisoned value.
 */
export const EnvNumberSchema = z
	.string()
	.optional()
	.transform((value): number | undefined => {
		if (value === undefined) return undefined;
		const trimmed = value.trim();
		if (trimmed.length === 0) return undefined;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : undefined;
	});

/**
 * Factory for a string-enum env-var parser.
 *
 * Produces a Zod schema that trims+lower-cases the raw env value and accepts
 * it only when it is a member of `allowed`. Any other value becomes
 * undefined so the caller falls back to the config file / default.
 */
export function makeEnvEnumSchema<T extends string>(
	allowed: ReadonlySet<T> | readonly T[],
) {
	const set: ReadonlySet<string> =
		allowed instanceof Set ? (allowed as ReadonlySet<string>) : new Set(allowed);
	return z
		.string()
		.optional()
		.transform((value): T | undefined => {
			if (value === undefined) return undefined;
			const trimmed = value.trim().toLowerCase();
			if (trimmed.length === 0) return undefined;
			return set.has(trimmed) ? (trimmed as T) : undefined;
		});
}

/**
 * Schema for `CODEX_AUTH_ACCOUNT_ID`.
 *
 * A manual account-id override supplied via env var. Must be a non-empty
 * trimmed string within a sane length bound; empty / whitespace-only /
 * absurdly-long values fall back to undefined so the rotation code picks
 * an account from the configured pool instead of honouring a bogus override.
 */
const ACCOUNT_ID_OVERRIDE_MAX_LENGTH = 256;

export const AccountIdOverrideSchema = z
	.string()
	.optional()
	.transform((value): string | undefined => {
		if (value === undefined) return undefined;
		const trimmed = value.trim();
		if (trimmed.length === 0) return undefined;
		if (trimmed.length > ACCOUNT_ID_OVERRIDE_MAX_LENGTH) return undefined;
		return trimmed;
	});

/**
 * Parse an env-var value through the account-id override schema.
 * Returns `undefined` on any validation failure.
 */
export function parseAccountIdOverride(value: string | undefined): string | undefined {
	const result = AccountIdOverrideSchema.safeParse(value);
	return result.success ? result.data : undefined;
}

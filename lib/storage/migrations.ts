/**
 * Storage migration utilities for account data format upgrades.
 * Extracted from storage.ts to reduce module size.
 */

import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import type { AccountIdSource } from "../types.js";

export type CooldownReason = "auth-failure" | "network-error";

/**
 * StorageError code emitted when a `version: 2` account file is loaded.
 *
 * V2 is an intermediate account schema produced by legacy 4.x plugin builds
 * that never shipped with a documented shape nor a forward-migrator to V3.
 * The safe behaviour is to refuse to load V2 explicitly so the user's
 * credentials are not silently discarded; callers surface this code to the
 * user alongside a recovery hint.
 */
export const UNKNOWN_V2_FORMAT_CODE = "UNKNOWN_V2_FORMAT";

/**
 * Minimal detection shape for V2 account storage.
 *
 * The full V2 schema was never documented and no V2 migrator shipped, so this
 * type is intentionally coarse: it only captures the fields needed to detect
 * that a file claims `version: 2` and contains something account-shaped. Do
 * not extend this shape without evidence of the real V2 layout - inventing
 * fields risks producing a silently-wrong migration.
 */
export interface AccountStorageV2Detected {
	version: 2;
	accounts?: unknown[];
}

/**
 * Diagnostic message shown when the loader refuses a V2 storage file.
 * Pulled into a helper so storage.ts, import paths, and tests produce
 * identical copy without drifting.
 */
export function buildV2RejectionMessage(): string {
	return (
		"Unsupported account storage schema version 2; this plugin only ships " +
		"migrations for v1 and v3. V2 files were produced by an intermediate " +
		"4.x build that never documented its shape, so migrating blindly would " +
		"risk silent account corruption."
	);
}

/**
 * Recovery hint shown alongside the V2 rejection message.
 * @param path - Absolute path of the offending storage file, or a placeholder
 *   when the caller cannot determine the source (e.g. in-memory normalization).
 */
export function buildV2RecoveryHint(path: string): string {
	const resolvedPath = path || "<unknown>";
	return (
		`The storage file at ${resolvedPath} uses account schema v2, which ` +
		"this plugin cannot migrate automatically. To recover: " +
		"(1) back up the file outside the .opencode directory, " +
		"(2) remove or rename the original so the plugin can start fresh, " +
		"(3) run `opencode auth login` to create a v3 account pool, then " +
		"(4) if you need the old credentials, open each account manually or " +
		"re-run login per account. If you believe this file was produced by " +
		"the current plugin, please open an issue so V2 can be documented."
	);
}

export interface RateLimitStateV3 {
	[key: string]: number | undefined;
}

export interface AccountMetadataV1 {
	accountId?: string;
	/** Account-scoped user/seat id from the OAuth access token. */
	accountUserId?: string;
	organizationId?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	accountTags?: string[];
	accountNote?: string;
	email?: string;
	refreshToken: string;
	/** Optional cached access token (Codex CLI parity). */
	accessToken?: string;
	/** Optional access token expiry timestamp (ms since epoch). */
	expiresAt?: number;
	/** OAuth scope string granted when this token set was minted. */
	oauthScope?: string;
	enabled?: boolean;
	addedAt: number;
	lastUsed: number;
	lastSwitchReason?: "rate-limit" | "initial" | "rotation";
	rateLimitResetTime?: number;
	coolingDownUntil?: number;
	cooldownReason?: CooldownReason;
}

export interface AccountStorageV1 {
	version: 1;
	accounts: AccountMetadataV1[];
	activeIndex: number;
}

export interface AccountMetadataV3 {
	accountId?: string;
	/** Account-scoped user/seat id from the OAuth access token. */
	accountUserId?: string;
	organizationId?: string;
	accountIdSource?: AccountIdSource;
	accountLabel?: string;
	/** `chatgpt_plan_type` from the access token, e.g. `pro` or `team`. */
	planType?: string;
	accountTags?: string[];
	accountNote?: string;
	email?: string;
	refreshToken: string;
	/** Optional cached access token (Codex CLI parity). */
	accessToken?: string;
	/** Optional access token expiry timestamp (ms since epoch). */
	expiresAt?: number;
	/** OAuth scope string granted when this token set was minted. */
	oauthScope?: string;
	/**
	 * When the refresh token on this record was last rotated (ms since epoch).
	 * Refresh tokens are single-use, so a concurrent process must be able to
	 * tell which of two differing tokens is the live one before persisting —
	 * see AccountPersistence.saveToDisk's credential merge.
	 */
	tokenRotatedAt?: number;
	enabled?: boolean;
	addedAt: number;
	lastUsed: number;
	lastSwitchReason?: "rate-limit" | "initial" | "rotation";
	rateLimitResetTimes?: RateLimitStateV3;
	coolingDownUntil?: number;
	/**
	 * Ms epoch until which this account's shared subscription quota (the
	 * `/wham/usage` primary/secondary window) is spent. Account-wide, distinct
	 * from the per-family/per-model blocks in `rateLimitResetTimes`.
	 */
	quotaExhaustedUntil?: number;
	cooldownReason?: CooldownReason;
}

export interface AccountStorageV3 {
	version: 3;
	accounts: AccountMetadataV3[];
	activeIndex: number;
	activeIndexByFamily?: Partial<Record<ModelFamily, number>>;
}

function nowMs(): number {
	return Date.now();
}

export function migrateV1ToV3(v1: AccountStorageV1): AccountStorageV3 {
	const now = nowMs();
	return {
		version: 3,
		accounts: v1.accounts.map((account) => {
			const rateLimitResetTimes: RateLimitStateV3 = {};
			if (typeof account.rateLimitResetTime === "number" && account.rateLimitResetTime > now) {
				for (const family of MODEL_FAMILIES) {
					rateLimitResetTimes[family] = account.rateLimitResetTime;
				}
			}
			return {
				accountId: account.accountId,
				accountUserId: account.accountUserId,
				organizationId: account.organizationId,
				accountIdSource: account.accountIdSource,
				accountLabel: account.accountLabel,
				accountTags: account.accountTags,
				accountNote: account.accountNote,
				email: account.email,
				refreshToken: account.refreshToken,
				accessToken: account.accessToken,
				expiresAt: account.expiresAt,
				oauthScope: account.oauthScope,
				enabled: account.enabled,
				addedAt: account.addedAt,
				lastUsed: account.lastUsed,
				lastSwitchReason: account.lastSwitchReason,
				rateLimitResetTimes: Object.keys(rateLimitResetTimes).length > 0 ? rateLimitResetTimes : undefined,
				coolingDownUntil: account.coolingDownUntil,
				cooldownReason: account.cooldownReason,
			};
		}),
		activeIndex: v1.activeIndex,
		activeIndexByFamily: Object.fromEntries(
			MODEL_FAMILIES.map((family) => [family, v1.activeIndex]),
		) as Partial<Record<ModelFamily, number>>,
	};
}

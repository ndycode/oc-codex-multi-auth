/**
 * Rate limiting utilities for account management.
 * Extracted from accounts.ts to reduce module size and improve cohesion.
 */

import { nowMs } from "../utils.js";
import type { ModelFamily } from "../prompts/codex.js";

export type BaseQuotaKey = ModelFamily;
export type QuotaKey = BaseQuotaKey | `${BaseQuotaKey}:${string}`;

export type RateLimitReason = "quota" | "tokens" | "concurrent" | "unknown";

export function parseRateLimitReason(code: string | undefined): RateLimitReason {
	if (!code) return "unknown";
	const lc = code.toLowerCase();
	if (lc.includes("quota") || lc.includes("usage_limit")) return "quota";
	if (lc.includes("token") || lc.includes("tpm") || lc.includes("rpm")) return "tokens";
	if (lc.includes("concurrent") || lc.includes("parallel")) return "concurrent";
	return "unknown";
}

export function getQuotaKey(family: ModelFamily, model?: string | null): QuotaKey {
	if (model) {
		return `${family}:${model}`;
	}
	return family;
}

export function clampNonNegativeInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return value < 0 ? 0 : Math.floor(value);
}

export interface RateLimitState {
	[key: string]: number | undefined;
}

export interface RateLimitedEntity {
	rateLimitResetTimes: RateLimitState;
}

export function clearExpiredRateLimits(entity: RateLimitedEntity): void {
	const now = nowMs();
	const keys = Object.keys(entity.rateLimitResetTimes);
	for (const key of keys) {
		const resetTime = entity.rateLimitResetTimes[key];
		if (resetTime !== undefined && now >= resetTime) {
			delete entity.rateLimitResetTimes[key];
		}
	}
}

export interface QuotaExhaustibleEntity {
	/** Ms epoch until which this account's shared subscription quota is spent. */
	quotaExhaustedUntil?: number;
}

/**
 * Whether an account's shared subscription quota is currently spent.
 *
 * This is an ACCOUNT-WIDE block sourced from the `/wham/usage`
 * primary/secondary window, deliberately distinct from the per-family /
 * per-model transient blocks tracked in {@link RateLimitState}. Read sites
 * report it separately so a 30-second 429 is never conflated with a week-long
 * subscription-quota exhaustion.
 */
export function isQuotaExhausted(
	entity: QuotaExhaustibleEntity,
	now: number = nowMs(),
): boolean {
	const until = entity.quotaExhaustedUntil;
	return typeof until === "number" && Number.isFinite(until) && now < until;
}

/**
 * Drop an elapsed (or non-finite) quota-exhaustion stamp so it does not leak
 * into snapshots or persistence, mirroring {@link clearExpiredRateLimits} for
 * the per-family map.
 */
export function clearExpiredQuotaExhaustion(
	entity: QuotaExhaustibleEntity,
	now: number = nowMs(),
): void {
	const until = entity.quotaExhaustedUntil;
	if (until !== undefined && (!Number.isFinite(until) || now >= until)) {
		delete entity.quotaExhaustedUntil;
	}
}

export function isRateLimitedForQuotaKey(entity: RateLimitedEntity, key: QuotaKey): boolean {
	const resetTime = entity.rateLimitResetTimes[key];
	return resetTime !== undefined && nowMs() < resetTime;
}

export function isRateLimitedForFamily(
	entity: RateLimitedEntity,
	family: ModelFamily,
	model?: string | null,
): boolean {
	clearExpiredRateLimits(entity);

	if (model) {
		const modelKey = getQuotaKey(family, model);
		if (isRateLimitedForQuotaKey(entity, modelKey)) {
			return true;
		}
	}

	const baseKey = getQuotaKey(family);
	return isRateLimitedForQuotaKey(entity, baseKey);
}

/**
 * Human-readable duration, used in toasts, status lines and log warnings.
 *
 * Non-finite input reads as zero rather than propagating: the old arithmetic
 * turned NaN into the string "NaNs" and Infinity into "Infinitym NaNs", both of
 * which reached users verbatim.
 *
 * Hours and days are split out because the callers routinely pass durations far
 * past an hour — a weekly quota block and process uptime both used to render as
 * a five-figure minute count ("10080m 0s").
 */
export function formatWaitTime(ms: number): string {
	const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
	const days = Math.floor(totalSeconds / 86400);
	const hours = Math.floor((totalSeconds % 86400) / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

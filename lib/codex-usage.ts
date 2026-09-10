import { createHash } from "node:crypto";

import { extractAccountId } from "./accounts.js";
import { extractAccountUserId } from "./auth/token-utils.js";
import { getFetchTimeoutMs, loadPluginConfig } from "./config.js";
import { normalizeResetCreditCount } from "./codex-reset.js";
import { CODEX_BASE_URL, PLUGIN_NAME } from "./constants.js";
import {
	createDeactivatedWorkspaceError,
	createUsageRequestTimeoutError,
} from "./error-sentinels.js";
import { logWarn } from "./logger.js";
import {
	isQuotaWindowExhausted,
	MAX_QUOTA_RESET_HORIZON_MS,
} from "./quota-windows.js";
import { coordinatePersistedRefresh } from "./storage/coordinated-refresh.js";
import {
	createCodexHeaders,
	isDeactivatedWorkspaceError,
	isInvalidatedAuthTokenError,
} from "./request/fetch-helpers.js";
import {
	withAccountStorageTransaction,
	type AccountMetadataV3,
	type AccountStorageV3,
} from "./storage.js";

export type UsageWindow = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_at?: number;
	reset_after_seconds?: number;
} | null;

export type LimitWindow = {
	usedPercent?: number;
	windowMinutes?: number;
	resetAtMs?: number;
};

export type UsageRateLimit = {
	primary_window?: UsageWindow;
	secondary_window?: UsageWindow;
} | null;

export type UsageCredits = {
	has_credits?: boolean;
	unlimited?: boolean;
	balance?: string | null;
} | null;

export type UsageResetCredits = {
	available_count?: number | null;
	applicable_available_count?: number | null;
} | null;

export type UsagePayload = {
	plan_type?: string;
	rate_limit?: UsageRateLimit;
	code_review_rate_limit?: UsageRateLimit;
	additional_rate_limits?: Array<{
		limit_name?: string;
		metered_feature?: string;
		rate_limit?: UsageRateLimit;
	}> | null;
	credits?: UsageCredits;
	rate_limit_reset_credits?: UsageResetCredits;
};

export type UsageLimitPayload = {
	name: string;
	windowMinutes: number | null;
	usedPercent: number | null;
	leftPercent: number | null;
	resetAtMs: number | null;
	summary: string;
};

export type AdditionalUsageLimit = {
	name: string;
	window: LimitWindow;
};

export type ResetCreditCounts = {
	available: number;
	/** `null` when the server stated a count this code cannot read. */
	applicableNow: number | null;
};

export type CodexUsageSummary = {
	planType: string | null;
	credits: string | null;
	resetCredits: ResetCreditCounts | null;
	primary: LimitWindow;
	secondary: LimitWindow;
	codeReview: LimitWindow;
	additionalLimits: AdditionalUsageLimit[];
	limits: UsageLimitPayload[];
};

export type EnsureCodexUsageAccessTokenResult = {
	accessToken: string;
	refreshed: boolean;
	persisted: boolean;
};

export type UsageAccountSelection = {
	index: number;
	account: AccountMetadataV3;
};

const usageErrorBodyMaxChars = 4096;

export function getUsageLeftPercent(
	usedPercent: number | undefined,
): number | undefined {
	return typeof usedPercent === "number" && Number.isFinite(usedPercent)
		? Math.max(0, Math.min(100, Math.round(100 - usedPercent)))
		: undefined;
}

export function formatUsageWindowLabel(
	windowMinutes: number | undefined,
): string {
	if (
		!windowMinutes ||
		!Number.isFinite(windowMinutes) ||
		windowMinutes <= 0
	) {
		return "quota";
	}
	if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

export function formatUsageReset(
	resetAtMs: number | undefined,
): string | undefined {
	if (!resetAtMs || !Number.isFinite(resetAtMs) || resetAtMs <= 0) {
		return undefined;
	}
	const date = new Date(resetAtMs);
	if (!Number.isFinite(date.getTime())) return undefined;

	const now = new Date();
	const sameDay =
		now.getFullYear() === date.getFullYear() &&
		now.getMonth() === date.getMonth() &&
		now.getDate() === date.getDate();
	const time = date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	if (sameDay) return time;
	const day = date.toLocaleDateString(undefined, {
		month: "short",
		day: "2-digit",
	});
	return `${time} on ${day}`;
}

/**
 * Convert a reported window length in seconds to minutes.
 *
 * A non-positive length means the plan has the window switched off, and is
 * preserved as `0` — the disabled marker {@link hasUsageWindow} filters on.
 * Rounding it up to `1` would surface a disabled window as a real `1m` limit.
 * A missing/non-finite length is an unknown window, which stays `undefined`.
 */
function mapUsageWindowMinutes(
	limitWindowSeconds: number | undefined,
): number | undefined {
	if (
		typeof limitWindowSeconds !== "number" ||
		!Number.isFinite(limitWindowSeconds)
	) {
		return undefined;
	}
	if (limitWindowSeconds <= 0) return 0;
	return Math.max(1, Math.ceil(limitWindowSeconds / 60));
}

export function mapUsageWindow(window: UsageWindow): LimitWindow {
	if (!window) return {};
	return {
		usedPercent:
			typeof window.used_percent === "number" &&
			Number.isFinite(window.used_percent)
				? window.used_percent
				: undefined,
		windowMinutes: mapUsageWindowMinutes(window.limit_window_seconds),
		resetAtMs:
			typeof window.reset_at === "number" && window.reset_at > 0
				? window.reset_at * 1000
				: typeof window.reset_after_seconds === "number" &&
						window.reset_after_seconds > 0
					? Date.now() + window.reset_after_seconds * 1000
					: undefined,
	};
}

export function formatUsageLimitTitle(
	windowMinutes: number | undefined,
	fallback = "quota",
): string {
	if (windowMinutes === 300) return "5h limit";
	if (windowMinutes === 10080) return "Weekly limit";
	if (fallback !== "quota") return fallback;
	return `${formatUsageWindowLabel(windowMinutes)} limit`;
}

export function formatUsageLimitSummary(window: LimitWindow): string {
	const left = getUsageLeftPercent(window.usedPercent);
	const reset = formatUsageReset(window.resetAtMs);
	if (left !== undefined && reset) return `${left}% left (resets ${reset})`;
	if (left !== undefined) return `${left}% left`;
	if (reset) return `resets ${reset}`;
	return "unavailable";
}

export function toUsageLimitPayload(
	name: string,
	window: LimitWindow,
): UsageLimitPayload {
	return {
		name,
		windowMinutes: window.windowMinutes ?? null,
		usedPercent:
			typeof window.usedPercent === "number" ? window.usedPercent : null,
		leftPercent: getUsageLeftPercent(window.usedPercent) ?? null,
		resetAtMs: window.resetAtMs ?? null,
		summary: formatUsageLimitSummary(window),
	};
}

export function formatUsageCredits(
	credits: UsageCredits,
): string | undefined {
	if (!credits) return undefined;
	if (credits.unlimited) return "unlimited";
	if (typeof credits.balance === "string" && credits.balance.trim()) {
		return credits.balance.trim();
	}
	if (credits.has_credits) return "available";
	return undefined;
}

/**
 * Read the redeemable rate-limit resets the usage response already carries.
 *
 * These are a different currency from `credits`, and an account routinely
 * holds both readings at once: a spent purchase balance alongside banked
 * resets. Reporting only `credits` therefore says "you have nothing" while a
 * full reset is waiting to be redeemed.
 *
 * `applicable_available_count` is the subset redeemable right now, which is
 * smaller than the banked count whenever no window is exhausted yet. A
 * response that omits it predates the field rather than reporting zero, so it
 * defaults to the banked count - defaulting to zero would report every banked
 * reset as unusable. Omitted means absent OR null: this endpoint sends a
 * literal JSON null for a field it has no value for, which is how
 * `secondary_window` arrives on every single-window plan.
 *
 * A count the server did state and this code cannot read is a different thing,
 * and defaulting it would invent an answer. A negative, fractional,
 * non-numeric or larger-than-banked applicable count therefore reports
 * `applicableNow: null`, because over-reporting sends someone to redeem a
 * credit that is not there.
 *
 * Only `applicableNow` goes unknown, not the whole reading: the banked count
 * is a separate field that arrived intact, and dropping it would print
 * "Credits: 0" while a full reset waits to be redeemed - the exact failure
 * this function exists to fix. `codex-reset` reads the same banked total from
 * the list endpoint, so discarding it here would also make the two surfaces
 * disagree about the same account in the same session.
 */
export function parseUsageResetCredits(
	source: UsageResetCredits | undefined,
): ResetCreditCounts | null {
	if (typeof source !== "object" || source === null) return null;
	const available = normalizeResetCreditCount(source.available_count);
	if (available === null) return null;

	const stated = source.applicable_available_count;
	if (stated === undefined || stated === null) {
		return { available, applicableNow: available };
	}
	const applicableNow = normalizeResetCreditCount(stated);
	if (applicableNow === null || applicableNow > available) {
		return { available, applicableNow: null };
	}
	return { available, applicableNow };
}

export function formatResetCredits(counts: ResetCreditCounts): string {
	if (counts.applicableNow === null) {
		return `${counts.available} banked (applicable now unknown)`;
	}
	return counts.applicableNow === counts.available
		? `${counts.available} banked`
		: `${counts.available} banked (${counts.applicableNow} applicable now)`;
}

export function formatAdditionalUsageLimitName(
	name: string | undefined,
): string {
	// `limit_name` is declared `string` but arrives straight from the usage
	// document, so a non-string reaches `.replace` and throws.
	if (typeof name !== "string" || !name) return "Additional limit";
	if (name === "code_review_rate_limit") return "Code review";
	return name
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (match) => match.toUpperCase());
}

/**
 * A window reported with a length of zero is disabled for the plan (e.g. the
 * 5-hour window on plans where OpenAI has switched it off), not a window whose
 * length is merely unknown. It still reports `used_percent: 0`, so it has to be
 * rejected on the explicit zero length or it renders as a full quota.
 */
export function hasUsageWindow(window: LimitWindow): boolean {
	if (window.windowMinutes === 0) return false;
	return Boolean(
		window.windowMinutes ||
			typeof window.usedPercent === "number" ||
			window.resetAtMs,
	);
}

/**
 * Return the latest valid reset time among fully spent ordinary Codex usage
 * windows. This deliberately accepts only the primary and secondary windows:
 * code-review and additional quotas do not govern ordinary model requests.
 *
 * The `/wham/usage` endpoint and request response headers describe the same
 * 5-hour/weekly quota state. Applying this result to rotation lets an explicit
 * `codex-limits` refresh protect paid Credits before the next model request.
 */
export function getUsageQuotaExhaustedResetAtMs(
	windows: readonly LimitWindow[],
	now: number = Date.now(),
): number | undefined {
	let latest: number | undefined;
	for (const window of windows) {
		if (!isQuotaWindowExhausted(window)) continue;
		const resetAtMs = window.resetAtMs;
		if (
			typeof resetAtMs !== "number" ||
			!Number.isFinite(resetAtMs) ||
			resetAtMs <= now ||
			resetAtMs - now > MAX_QUOTA_RESET_HORIZON_MS
		) {
			continue;
		}
		if (latest === undefined || resetAtMs > latest) latest = resetAtMs;
	}
	return latest;
}

/**
 * Persist the account-wide subscription-quota exhaustion stamp on stored
 * entries sharing the queried usage quota. Rotation tracks each model family
 * independently in `rateLimitResetTimes`, whereas the `/wham/usage`
 * primary/secondary subscription quota is shared by all models — so it is
 * recorded ONCE, on the dedicated `quotaExhaustedUntil` field, rather than
 * forged into a per-family rate-limit block for every model. Read sites treat
 * an active stamp as a blocking condition reported separately from a transient
 * 429.
 *
 * The stored value is kept at its monotonic maximum, with the same validity
 * guards as {@link AccountRotation.markQuotaExhausted}: finite, strictly in the
 * future, and within {@link MAX_QUOTA_RESET_HORIZON_MS} so an absurd stamp
 * cannot strand the account.
 *
 * This uses a storage transaction rather than saving the caller's usage
 * snapshot: usage inspection can refresh a single-use token, while another
 * process can independently update credentials or account membership.
 */
export async function persistUsageQuotaExhaustion(
	account: AccountMetadataV3,
	resetAtMs: number,
): Promise<boolean> {
	const usageKey = getUsageAccountDedupeKey(account);
	if (!usageKey) return false;

	if (!Number.isFinite(resetAtMs)) return false;
	const resetAt = Math.floor(resetAtMs);
	const now = Date.now();
	if (resetAt <= now) return false;
	if (resetAt - now > MAX_QUOTA_RESET_HORIZON_MS) return false;

	return withAccountStorageTransaction(async (current, persist) => {
		if (!current) return false;
		let changed = false;
		for (const storedAccount of current.accounts) {
			if (getUsageAccountDedupeKey(storedAccount) !== usageKey) continue;
			const existing = storedAccount.quotaExhaustedUntil;
			if (
				typeof existing === "number" &&
				Number.isFinite(existing) &&
				existing >= resetAt
			) {
				continue;
			}
			storedAccount.quotaExhaustedUntil = resetAt;
			changed = true;
		}
		if (changed) await persist(current);
		return changed;
	});
}

/**
 * Reduce a `/wham/usage` document to the summary the callers render.
 *
 * The parameter is whatever `response.json()` produced: {@link fetchCodexUsage}
 * casts its result to {@link UsagePayload} without validating it, and a `200`
 * carrying the body `null` is valid JSON. The gateway in front of `/wham/usage`
 * is user-configurable (`OPENAI_BASE_URL`), so that is a reachable response and
 * not only a hypothetical. Every field *inside* the payload is already
 * null-tolerant; the payload itself was not, and dereferencing it threw
 * `Cannot read properties of null (reading 'rate_limit')`. A non-object payload
 * is now read as an empty document, which renders as "unavailable".
 */
export function parseCodexUsagePayload(
	payload: UsagePayload | null | undefined,
): CodexUsageSummary {
	const source: UsagePayload =
		typeof payload === "object" && payload !== null ? payload : {};
	// Same reasoning one level down: the field is declared `Array | null` but
	// arrives unvalidated, and `.find`/`.filter` on a non-array, or a member
	// dereference on a null entry, throws.
	const additionalRateLimits = (
		Array.isArray(source.additional_rate_limits) ? source.additional_rate_limits : []
	).filter((entry): entry is NonNullable<typeof entry> =>
		typeof entry === "object" && entry !== null,
	);
	const primary = mapUsageWindow(source.rate_limit?.primary_window ?? null);
	const secondary = mapUsageWindow(source.rate_limit?.secondary_window ?? null);
	const codeReviewRateLimit =
		source.code_review_rate_limit ??
		additionalRateLimits.find(
			(entry) => entry.limit_name === "code_review_rate_limit",
		)?.rate_limit ??
		null;
	const codeReview = mapUsageWindow(codeReviewRateLimit?.primary_window ?? null);
	const credits = formatUsageCredits(source.credits ?? null);
	const additionalLimits = additionalRateLimits
		.filter((entry) => entry.limit_name !== "code_review_rate_limit")
		.map((entry) => ({
			name: formatAdditionalUsageLimitName(
				entry.limit_name ?? entry.metered_feature,
			),
			window: mapUsageWindow(entry.rate_limit?.primary_window ?? null),
		}));
	const limits: UsageLimitPayload[] = [];
	for (const window of [primary, secondary]) {
		if (!hasUsageWindow(window)) continue;
		limits.push(
			toUsageLimitPayload(formatUsageLimitTitle(window.windowMinutes), window),
		);
	}
	if (hasUsageWindow(codeReview)) {
		limits.push(toUsageLimitPayload("Code review", codeReview));
	}
	for (const limit of additionalLimits) {
		limits.push(toUsageLimitPayload(limit.name, limit.window));
	}

	return {
		planType: source.plan_type ?? null,
		credits: credits ?? null,
		resetCredits: parseUsageResetCredits(source.rate_limit_reset_credits),
		primary,
		secondary,
		codeReview,
		additionalLimits,
		limits,
	};
}

/**
 * Build a safe error message from a failed Codex backend response.
 *
 * Shared with the reset-credit client in `lib/codex-reset.ts`: both talk to
 * `chatgpt.com/backend-api` with the same bearer credentials, so both must
 * scrub tokens out of an error body before it reaches tool output or logs.
 */
export function sanitizeCodexApiErrorMessage(
	status: number,
	bodyText: string,
): string {
	const normalized = bodyText.replace(/\s+/g, " ").trim();
	const redacted = normalized
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(
			/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
			"[redacted-token]",
		)
		.replace(/\bsk-[A-Za-z0-9][A-Za-z0-9._:-]{19,}\b/gi, "[redacted-token]")
		.replace(/\b[a-f0-9]{40,}\b/gi, "[redacted-token]");
	return redacted ? `HTTP ${status}: ${redacted.slice(0, 200)}` : `HTTP ${status}`;
}

export function isCodexAbortError(error: unknown): boolean {
	return (
		(error instanceof Error && error.name === "AbortError") ||
		(typeof DOMException !== "undefined" &&
			error instanceof DOMException &&
			error.name === "AbortError")
	);
}

export async function fetchCodexUsage(params: {
	accountId: string;
	accessToken: string;
	organizationId: string | undefined;
	timeoutMs?: number;
	normalizeAccountErrors?: boolean;
}): Promise<UsagePayload> {
	const headers = createCodexHeaders(
		undefined,
		params.accountId,
		params.accessToken,
		{
			organizationId: params.organizationId,
		},
	);
	headers.set("accept", "application/json");
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		params.timeoutMs ?? getFetchTimeoutMs(loadPluginConfig()),
	);

	try {
		const response = await fetch(`${CODEX_BASE_URL}/wham/usage`, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (!response.ok) {
			let bodyText = "";
			try {
				bodyText = (await response.text()).slice(0, usageErrorBodyMaxChars);
			} catch (error) {
				if (isCodexAbortError(error) || controller.signal.aborted) {
					throw createUsageRequestTimeoutError();
				}
				throw error;
			}
			if (controller.signal.aborted) {
				throw createUsageRequestTimeoutError();
			}
			let errorBody: unknown = bodyText;
			try {
				errorBody = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
			} catch {
				// Keep non-JSON bodies available to the shared error matchers.
			}
			if (
				params.normalizeAccountErrors &&
				isDeactivatedWorkspaceError(errorBody, response.status)
			) {
				throw createDeactivatedWorkspaceError();
			}
			if (
				params.normalizeAccountErrors &&
				isInvalidatedAuthTokenError(errorBody, response.status)
			) {
				throw new Error(
					"Your authentication token has been invalidated. Please try signing in again.",
				);
			}
			throw new Error(sanitizeCodexApiErrorMessage(response.status, bodyText));
		}
		return (await response.json()) as UsagePayload;
	} catch (error) {
		if (isCodexAbortError(error)) {
			throw createUsageRequestTimeoutError();
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function applyRefreshedCredentials(
	target: {
		refreshToken: string;
		accountUserId?: string;
		accessToken?: string;
		expiresAt?: number;
	},
	result: {
		refresh: string;
		access: string;
		expires: number;
	},
): void {
	target.refreshToken = result.refresh;
	target.accountUserId = extractAccountUserId(result.access) ?? target.accountUserId;
	target.accessToken = result.access;
	target.expiresAt = result.expires;
}

export async function ensureCodexUsageAccessToken(params: {
	storage: AccountStorageV3;
	account: AccountMetadataV3;
}): Promise<EnsureCodexUsageAccessTokenResult> {
	let accessToken = params.account.accessToken;
	if (
		typeof accessToken === "string" &&
		accessToken &&
		typeof params.account.expiresAt === "number" &&
		params.account.expiresAt > Date.now() + 30_000
	) {
		return { accessToken, refreshed: false, persisted: false };
	}

	const previousRefreshToken = params.account.refreshToken;
	if (!previousRefreshToken) {
		throw new Error("Cannot refresh: account has no refresh token");
	}
	const refreshResult = await coordinatePersistedRefresh(params.account);
	if (refreshResult.type !== "success") {
		throw new Error(refreshResult.message ?? refreshResult.reason);
	}
	let refreshedCount = 0;
	for (const storedAccount of params.storage.accounts) {
		if (storedAccount.refreshToken === previousRefreshToken) {
			applyRefreshedCredentials(storedAccount, refreshResult);
			refreshedCount += 1;
		}
	}
	if (refreshedCount === 0) {
		// `params.storage` is a caller-supplied snapshot, so its copy of this
		// account can already carry a rotated token and match nothing. The durable
		// commit still happened inside the coordinator; only this in-memory
		// snapshot missed it, which is worth saying out loud because it means the
		// caller's other views of the account stay stale for this invocation.
		logWarn(
			`[${PLUGIN_NAME}] No account in the supplied storage snapshot matched the refreshed token; the rotation is durable on disk but this snapshot was not updated.`,
			{
				accountId: params.account.accountId,
				organizationId: params.account.organizationId,
			},
		);
		applyRefreshedCredentials(params.account, refreshResult);
	}

	accessToken = refreshResult.access;
	// The coordinator either adopted a rotation another process had already
	// committed or committed this one itself; both leave the credential durable.
	return { accessToken, refreshed: true, persisted: true };
}

/**
 * Normalize an account identity field to a trimmed string.
 *
 * Non-string values collapse to an empty string so callers can treat
 * "missing" and "blank" identity parts uniformly when building dedupe keys.
 */
function normalizeUsageIdentityPart(value: string | undefined): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Derive a stable usage-quota dedupe key for an account.
 *
 * Business members can share one `accountId` while each bearer token has a
 * distinct `accountUserId` and quota, so the seat id disambiguates members
 * WITHIN a workspace. It is APPENDED to the workspace identity rather than
 * replacing it: one OAuth grant can back several workspace variants that all
 * carry the same member id, and those still consume separate quotas. Older
 * records without a member id keep workspace-level dedup, then the refresh
 * token as a last resort.
 *
 * Keys are emitted as `JSON.stringify` arrays (tagged `"seat"`, `"workspace"`,
 * or `"refresh"`) so values containing delimiter characters cannot collide.
 *
 * @param account - Stored account metadata to derive the key from.
 * @returns A unique identity key, or `undefined` when the account carries no
 *   workspace identity and no refresh token.
 */
export function getUsageAccountDedupeKey(
	account: AccountMetadataV3,
): string | undefined {
	const accountId = normalizeUsageIdentityPart(account.accountId);
	const accountUserId = normalizeUsageIdentityPart(
		account.accountUserId?.trim() || extractAccountUserId(account.accessToken),
	);
	const organizationId = normalizeUsageIdentityPart(account.organizationId);
	if (accountUserId) {
		return JSON.stringify(["seat", accountId, organizationId, accountUserId]);
	}
	if (accountId || organizationId) {
		return JSON.stringify(["workspace", accountId, organizationId]);
	}

	const refreshToken = normalizeUsageIdentityPart(account.refreshToken);
	return refreshToken ? JSON.stringify(["refresh", refreshToken]) : undefined;
}

/**
 * Collect the indices of accounts that represent distinct usage quotas.
 *
 * Disabled accounts are skipped. Accounts with no usable identity — no
 * `accountId`, no `organizationId`, and no `refreshToken`, i.e. those for which
 * {@link getUsageAccountDedupeKey} returns `undefined` — are also dropped, since
 * they cannot be attributed to a quota and have no token to query. Entries
 * sharing the same dedupe key are collapsed to a single index.
 *
 * When a workspace key appears more than once (e.g. an account re-added after a
 * token re-issue), the *last* (most recently added) occurrence is kept so the
 * freshest credential is queried — keeping the first occurrence could surface
 * an invalidated refresh token after re-auth. First-appearance order is still
 * used for display stability.
 *
 * @param storage - The account storage to scan.
 * @returns Storage indices of unique, enabled, identifiable usage accounts in
 *   first-appearance order, each pointing at its freshest occurrence.
 */
export function deduplicateUsageAccountIndices(storage: AccountStorageV3): number[] {
	const indexByIdentity = new Map<string, number>();
	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account) continue;
		if (account.enabled === false) continue;
		const key = getUsageAccountDedupeKey(account);
		if (!key) continue;
		// Map keeps first-insertion key order (stable display) while overwriting
		// the value so the latest occurrence's index wins (freshest credential).
		indexByIdentity.set(key, i);
	}
	return [...indexByIdentity.values()];
}

/**
 * Resolve which account's usage quota should be shown as active.
 *
 * Starts from the persisted active index (preferring the Codex family index)
 * and then prefers the most-recently-used enabled account by `lastUsed`, so the
 * displayed quota tracks the credential actually serving requests. Disabled
 * accounts are ignored, and invalid/missing `lastUsed` values are treated as
 * oldest.
 *
 * @param storage - The account storage to inspect.
 * @returns The selected account and its index, or `null` when no enabled
 *   account is available.
 */
export function resolveCodexUsageActiveAccount(
	storage: AccountStorageV3,
): UsageAccountSelection | null {
	if (storage.accounts.length === 0) return null;
	const rawIndex = storage.activeIndexByFamily?.codex ?? storage.activeIndex;
	const numericIndex =
		typeof rawIndex === "number" && Number.isFinite(rawIndex) ? rawIndex : 0;
	const index = Math.max(
		0,
		Math.min(storage.accounts.length - 1, Math.trunc(numericIndex)),
	);
	const activeAccount = storage.accounts[index];
	if (
		!activeAccount &&
		storage.accounts.every((account) => !account || account.enabled === false)
	) {
		return null;
	}

	// An enabled active account with a missing/invalid `lastUsed` must fall back
	// to 0 (same as every other enabled account), not -1. Using -1 would let a
	// lower-index enabled account with `lastUsed` 0 win the `0 > -1` comparison
	// and steal the active marker before the active account's own iteration.
	const activeEnabled = !!activeAccount && activeAccount.enabled !== false;
	const activeLastUsed =
		activeEnabled &&
		typeof activeAccount?.lastUsed === "number" &&
		Number.isFinite(activeAccount.lastUsed)
			? activeAccount.lastUsed
			: activeEnabled
				? 0
				: -1;
	let newestIndex = activeEnabled ? index : -1;
	let newestLastUsed = activeLastUsed;
	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account || account.enabled === false) continue;
		const lastUsed =
			typeof account.lastUsed === "number" && Number.isFinite(account.lastUsed)
				? account.lastUsed
				: 0;
		if (lastUsed > newestLastUsed) {
			newestIndex = i;
			newestLastUsed = lastUsed;
		}
	}
	if (newestIndex < 0) return null;

	const account = storage.accounts[newestIndex];
	return account ? { index: newestIndex, account } : null;
}

export function resolveCodexUsageAccountId(params: {
	account: AccountMetadataV3;
	accessToken: string;
}): string | undefined {
	return params.account.accountId ?? extractAccountId(params.accessToken);
}

export function createUsageAccountFingerprint(
	account: AccountMetadataV3,
): string {
	const fingerprintSource = [
		account.accountId ?? "",
		account.accountUserId?.trim() || extractAccountUserId(account.accessToken) || "",
		account.organizationId ?? "",
		account.refreshToken ?? "",
	].join("\0");
	return createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 16);
}

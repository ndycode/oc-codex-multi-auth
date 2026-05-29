import { createHash } from "node:crypto";

import { extractAccountId } from "./accounts.js";
import { getFetchTimeoutMs, loadPluginConfig } from "./config.js";
import { CODEX_BASE_URL, PLUGIN_NAME } from "./constants.js";
import { createUsageRequestTimeoutError } from "./error-sentinels.js";
import { logWarn } from "./logger.js";
import { queuedRefresh } from "./refresh-queue.js";
import { createCodexHeaders } from "./request/fetch-helpers.js";
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

export type CodexUsageSummary = {
	planType: string | null;
	credits: string | null;
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

export function mapUsageWindow(window: UsageWindow): LimitWindow {
	if (!window) return {};
	return {
		usedPercent:
			typeof window.used_percent === "number" &&
			Number.isFinite(window.used_percent)
				? window.used_percent
				: undefined,
		windowMinutes:
			typeof window.limit_window_seconds === "number" &&
			Number.isFinite(window.limit_window_seconds)
				? Math.max(1, Math.ceil(window.limit_window_seconds / 60))
				: undefined,
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

export function formatAdditionalUsageLimitName(
	name: string | undefined,
): string {
	if (!name) return "Additional limit";
	if (name === "code_review_rate_limit") return "Code review";
	return name
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (match) => match.toUpperCase());
}

export function hasUsageWindow(window: LimitWindow): boolean {
	return Boolean(
		window.windowMinutes ||
			typeof window.usedPercent === "number" ||
			window.resetAtMs,
	);
}

export function parseCodexUsagePayload(
	payload: UsagePayload,
): CodexUsageSummary {
	const primary = mapUsageWindow(payload.rate_limit?.primary_window ?? null);
	const secondary = mapUsageWindow(payload.rate_limit?.secondary_window ?? null);
	const codeReviewRateLimit =
		payload.code_review_rate_limit ??
		payload.additional_rate_limits?.find(
			(entry) => entry.limit_name === "code_review_rate_limit",
		)?.rate_limit ??
		null;
	const codeReview = mapUsageWindow(codeReviewRateLimit?.primary_window ?? null);
	const credits = formatUsageCredits(payload.credits ?? null);
	const additionalLimits = (payload.additional_rate_limits ?? [])
		.filter((entry) => entry.limit_name !== "code_review_rate_limit")
		.map((entry) => ({
			name: formatAdditionalUsageLimitName(
				entry.limit_name ?? entry.metered_feature,
			),
			window: mapUsageWindow(entry.rate_limit?.primary_window ?? null),
		}));
	const limits = [
		toUsageLimitPayload(formatUsageLimitTitle(primary.windowMinutes), primary),
		toUsageLimitPayload(formatUsageLimitTitle(secondary.windowMinutes), secondary),
	];
	if (hasUsageWindow(codeReview)) {
		limits.push(toUsageLimitPayload("Code review", codeReview));
	}
	for (const limit of additionalLimits) {
		limits.push(toUsageLimitPayload(limit.name, limit.window));
	}

	return {
		planType: payload.plan_type ?? null,
		credits: credits ?? null,
		primary,
		secondary,
		codeReview,
		additionalLimits,
		limits,
	};
}

function sanitizeUsageErrorMessage(status: number, bodyText: string): string {
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

function isAbortError(error: unknown): boolean {
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
				if (isAbortError(error) || controller.signal.aborted) {
					throw createUsageRequestTimeoutError();
				}
				throw error;
			}
			if (controller.signal.aborted) {
				throw createUsageRequestTimeoutError();
			}
			throw new Error(sanitizeUsageErrorMessage(response.status, bodyText));
		}
		return (await response.json()) as UsagePayload;
	} catch (error) {
		if (isAbortError(error)) {
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
	target.accessToken = result.access;
	target.expiresAt = result.expires;
}

async function persistRefreshedCredentials(params: {
	previousRefreshToken: string;
	accountId?: string;
	organizationId?: string;
	email?: string;
	refreshResult: {
		refresh: string;
		access: string;
		expires: number;
	};
}): Promise<boolean> {
	return await withAccountStorageTransaction(async (current, persist) => {
		const latestStorage: AccountStorageV3 =
			current ??
			({
				version: 3,
				accounts: [],
				activeIndex: 0,
				activeIndexByFamily: {},
			} satisfies AccountStorageV3);

		const uniqueMatch = <Value>(matches: Value[]): Value | undefined =>
			matches.length === 1 ? matches[0] : undefined;

		let updated = false;
		if (params.previousRefreshToken) {
			for (const storedAccount of latestStorage.accounts) {
				if (storedAccount.refreshToken === params.previousRefreshToken) {
					applyRefreshedCredentials(storedAccount, params.refreshResult);
					updated = true;
				}
			}
		}

		if (!updated) {
			const normalizedOrganizationId = params.organizationId?.trim() ?? "";
			const normalizedEmail = params.email?.trim().toLowerCase();
			const orgScopedMatches = params.accountId
				? latestStorage.accounts.filter(
						(storedAccount) =>
							storedAccount.accountId === params.accountId &&
							(storedAccount.organizationId?.trim() ?? "") ===
								normalizedOrganizationId,
					)
				: [];
			const accountIdMatches = params.accountId
				? latestStorage.accounts.filter(
						(storedAccount) => storedAccount.accountId === params.accountId,
					)
				: [];
			const emailMatches =
				normalizedEmail && !params.accountId
					? latestStorage.accounts.filter(
							(storedAccount) =>
								storedAccount.email?.trim().toLowerCase() === normalizedEmail,
						)
					: [];

			const fallbackTarget =
				uniqueMatch(orgScopedMatches) ??
				uniqueMatch(accountIdMatches) ??
				uniqueMatch(emailMatches);

			if (fallbackTarget) {
				applyRefreshedCredentials(fallbackTarget, params.refreshResult);
				updated = true;
			}
		}

		if (updated) {
			await persist(latestStorage);
		}
		if (!updated) {
			logWarn(
				`[${PLUGIN_NAME}] persistRefreshedCredentials could not find a matching stored account. Refreshed credentials remain in-memory for this invocation only.`,
				{
					accountId: params.accountId,
					organizationId: params.organizationId,
				},
			);
		}

		return updated;
	});
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
	const refreshResult = await queuedRefresh(previousRefreshToken);
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
		applyRefreshedCredentials(params.account, refreshResult);
	}

	const persisted = await persistRefreshedCredentials({
		previousRefreshToken,
		accountId: params.account.accountId,
		organizationId: params.account.organizationId,
		email: params.account.email,
		refreshResult,
	});

	accessToken = refreshResult.access;
	return { accessToken, refreshed: true, persisted };
}

function normalizeUsageIdentityPart(value: string | undefined): string {
	return typeof value === "string" ? value.trim() : "";
}

export function getUsageAccountDedupeKey(
	account: AccountMetadataV3,
): string | undefined {
	const accountId = normalizeUsageIdentityPart(account.accountId);
	const organizationId = normalizeUsageIdentityPart(account.organizationId);
	if (accountId || organizationId) {
		return JSON.stringify(["workspace", accountId, organizationId]);
	}

	const refreshToken = normalizeUsageIdentityPart(account.refreshToken);
	return refreshToken ? JSON.stringify(["refresh", refreshToken]) : undefined;
}

export function deduplicateUsageAccountIndices(storage: AccountStorageV3): number[] {
	const seenIdentities = new Set<string>();
	const uniqueIndices: number[] = [];
	for (let i = 0; i < storage.accounts.length; i += 1) {
		const account = storage.accounts[i];
		if (!account) continue;
		if (account.enabled === false) continue;
		const key = getUsageAccountDedupeKey(account);
		if (!key) continue;
		if (seenIdentities.has(key)) continue;
		seenIdentities.add(key);
		uniqueIndices.push(i);
	}
	return uniqueIndices;
}

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
	if (!activeAccount && storage.accounts.every((account) => account.enabled === false)) return null;

	const activeLastUsed =
		activeAccount?.enabled !== false &&
		typeof activeAccount?.lastUsed === "number" && Number.isFinite(activeAccount.lastUsed)
			? activeAccount.lastUsed
			: -1;
	let newestIndex = activeAccount?.enabled === false ? -1 : index;
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
		account.organizationId ?? "",
		account.refreshToken ?? "",
	].join("\0");
	return createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 16);
}

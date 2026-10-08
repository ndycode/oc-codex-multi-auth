/**
 * Client for Codex banked rate-limit reset credits.
 *
 * OpenAI grants eligible ChatGPT plans a small number of "reset credits" that
 * clear the current rate-limit windows early. Redemption is exposed in the
 * Codex desktop app, the IDE extensions, and the Codex CLI `/usage` screen —
 * but not on a surface Linux users of this plugin can reach. This module wraps
 * the same two backend endpoints those clients use so `codex-reset` can list
 * and redeem credits:
 *
 * - `GET  /wham/rate-limit-reset-credits`          — list credits
 * - `POST /wham/rate-limit-reset-credits/consume`  — redeem one credit
 *
 * Both are undocumented and authenticate exactly like `/wham/usage` (see
 * `lib/codex-usage.ts`), so they share its bearer credentials, timeout, and
 * error-body sanitization. Redeeming is irreversible and consumes a real,
 * finite credit, so the redeem path is never taken implicitly — the caller must
 * pass an explicit confirmation (see `lib/tools/codex-reset.ts`).
 */

import { createHash } from "node:crypto";

import {
	hasUsageWindow,
	isCodexAbortError,
	sanitizeCodexApiErrorMessage,
	type CodexUsageSummary,
} from "./codex-usage.js";
import { getFetchTimeoutMs, loadPluginConfig } from "./config.js";
import { CODEX_BASE_URL } from "./constants.js";
import { createUsageRequestTimeoutError } from "./error-sentinels.js";
import { logInfo, logWarn } from "./logger.js";
import { createCodexHeaders } from "./request/fetch-helpers.js";

/** Status string the backend uses for a credit that can still be redeemed. */
export const CODEX_RESET_CREDIT_AVAILABLE_STATUS = "available";

const RESET_CREDITS_PATH = "/wham/rate-limit-reset-credits";
const RESET_CREDITS_CONSUME_PATH = "/wham/rate-limit-reset-credits/consume";
const resetErrorBodyMaxChars = 4096;

/** Raw credit entry as returned by the backend. */
export type CodexResetCreditEntry = {
	id?: string;
	status?: string;
	reset_type?: string;
	granted_at?: string;
	expires_at?: string;
	title?: string;
};

/** Raw list response. */
export type CodexResetCreditsPayload = {
	credits?: CodexResetCreditEntry[] | null;
	available_count?: number;
};

/** Raw consume response. */
export type CodexResetConsumePayload = {
	code?: string;
	windows_reset?: unknown;
	credit?: { id?: string; status?: string; redeemed_at?: string } | null;
};

/** Normalized credit entry used by the tool and its JSON output. */
export type CodexResetCredit = {
	id: string;
	status: string;
	isAvailable: boolean;
	resetType: string | null;
	grantedAt: string | null;
	expiresAt: string | null;
	title: string | null;
};

export type CodexResetCreditsSummary = {
	availableCount: number;
	credits: CodexResetCredit[];
};

/** Outcome of choosing which credit to redeem. */
export type CodexResetCreditSelection =
	| { type: "selected"; credit: CodexResetCredit }
	| { type: "none-available" }
	| { type: "not-found"; creditId: string };

function toTrimmedString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Read a reset-credit counter the server stated.
 *
 * A count is a whole number of redeemable resets, so a negative, fractional,
 * non-finite or non-numeric value is a payload this code cannot read rather
 * than a zero: truncating `1.9` to `1` would silently paper over a malformed
 * response. Returning `null` leaves the fallback to each caller, which is why
 * the two reset-credit surfaces stay consistent about what "sane" means
 * without sharing a fallback policy they do not agree on. The list endpoint
 * below derives the count from the credits it also sent; the usage endpoint,
 * which sends no list, reports the count as unknown.
 */
export function normalizeResetCreditCount(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		return null;
	}
	return value;
}

/**
 * Normalize the list response.
 *
 * The payload crosses an external HTTP boundary
 * (`OPENAI_BASE_URL`-style gateways can rewrite the body), so a null body or
 * a wrong-shaped `credits` field degrades to an empty summary instead of
 * throwing — the same boundary treatment `parseCodexUsagePayload` got in
 * 6.15.0.
 *
 * Credits without an `id` are dropped: an id is required to redeem, so an
 * entry lacking one is not actionable and would only pad the display. The
 * server's `available_count` is trusted when it is a sane number and otherwise
 * derived from the credits themselves, so a missing counter never understates
 * what the user actually has.
 */
export function parseCodexResetCredits(
	payload: CodexResetCreditsPayload | null | undefined,
): CodexResetCreditsSummary {
	const source = payload && typeof payload === "object" ? payload : undefined;
	const credits: CodexResetCredit[] = [];
	for (const entry of Array.isArray(source?.credits) ? source.credits : []) {
		const id = toTrimmedString(entry?.id);
		if (!id) continue;
		const status = toTrimmedString(entry?.status) ?? "unknown";
		credits.push({
			id,
			status,
			isAvailable: status === CODEX_RESET_CREDIT_AVAILABLE_STATUS,
			resetType: toTrimmedString(entry?.reset_type),
			grantedAt: toTrimmedString(entry?.granted_at),
			expiresAt: toTrimmedString(entry?.expires_at),
			title: toTrimmedString(entry?.title),
		});
	}

	const availableCount =
		normalizeResetCreditCount(source?.available_count) ??
		credits.filter((credit) => credit.isAvailable).length;

	return { availableCount, credits };
}

/**
 * Pick the credit to redeem.
 *
 * Only credits the backend still reports as available are eligible, so an
 * explicit `creditId` naming an expired or already-redeemed credit is reported
 * as not-found rather than being sent to the consume endpoint.
 */
export function selectRedeemableCredit(
	summary: CodexResetCreditsSummary,
	creditId?: string,
): CodexResetCreditSelection {
	const available = summary.credits.filter((credit) => credit.isAvailable);
	const requestedId = creditId?.trim();
	if (requestedId) {
		const credit = available.find((entry) => entry.id === requestedId);
		return credit
			? { type: "selected", credit }
			: { type: "not-found", creditId: requestedId };
	}
	const credit = available[0];
	return credit ? { type: "selected", credit } : { type: "none-available" };
}

export function formatCodexResetCredit(credit: CodexResetCredit): string {
	const parts = [credit.id, `status=${credit.status}`];
	if (credit.resetType) parts.push(`type=${credit.resetType}`);
	if (credit.grantedAt) parts.push(`granted=${credit.grantedAt}`);
	if (credit.expiresAt) parts.push(`expires=${credit.expiresAt}`);
	return parts.join("  ");
}

/**
 * Idempotency key for redeeming a specific credit.
 *
 * The key must be STABLE across invocations for the same credit: a credit can
 * be redeemed at most once, so "the same logical redemption" is exactly "the
 * same credit id". A per-call random UUID would hand the backend a brand-new
 * key on every retry, making the idempotency mechanism inert — a consume whose
 * response was lost could then be retried without the backend recognizing it.
 * The key is derived deterministically from the credit id (UUID-shaped so the
 * backend sees the same format the official clients send).
 */
export function createRedeemRequestId(creditId: string): string {
	const digest = createHash("sha256")
		.update(`oc-codex-multi-auth:redeem-request:${creditId}`)
		.digest();
	const bytes = digest.subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function requestCodexResetJson<T>(params: {
	path: string;
	method: "GET" | "POST";
	accountId: string;
	accessToken: string;
	organizationId: string | undefined;
	body?: unknown;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<T> {
	const headers = createCodexHeaders(
		undefined,
		params.accountId,
		params.accessToken,
		{ organizationId: params.organizationId },
	);
	headers.set("accept", "application/json");
	if (params.body !== undefined) {
		headers.set("content-type", "application/json");
	}

	const controller = new AbortController();
	const abort = (): void => controller.abort();
	params.signal?.addEventListener("abort", abort, { once: true });
	if (params.signal?.aborted) abort();
	const timeout = setTimeout(
		() => controller.abort(),
		params.timeoutMs ?? getFetchTimeoutMs(loadPluginConfig()),
	);

	try {
		const response = await fetch(`${CODEX_BASE_URL}${params.path}`, {
			method: params.method,
			headers,
			body: params.body === undefined ? undefined : JSON.stringify(params.body),
			signal: controller.signal,
		});
		if (!response.ok) {
			let bodyText = "";
			try {
				bodyText = (await response.text()).slice(0, resetErrorBodyMaxChars);
			} catch (error) {
				if (isCodexAbortError(error) || controller.signal.aborted) {
					throw createUsageRequestTimeoutError();
				}
				throw error;
			}
			if (controller.signal.aborted) {
				throw createUsageRequestTimeoutError();
			}
			throw new Error(sanitizeCodexApiErrorMessage(response.status, bodyText));
		}
		return (await response.json()) as T;
	} catch (error) {
		if (isCodexAbortError(error)) {
			throw createUsageRequestTimeoutError();
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		params.signal?.removeEventListener("abort", abort);
	}
}

export async function fetchCodexResetCredits(params: {
	accountId: string;
	accessToken: string;
	organizationId: string | undefined;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<CodexResetCreditsPayload> {
	return await requestCodexResetJson<CodexResetCreditsPayload>({
		...params,
		path: RESET_CREDITS_PATH,
		method: "GET",
	});
}

/**
 * Redeem one banked credit. Irreversible.
 *
 * `redeemRequestId` is echoed to the backend as an idempotency key so a retry
 * of the same logical redemption cannot spend two credits.
 */
export async function consumeCodexResetCredit(params: {
	accountId: string;
	accessToken: string;
	organizationId: string | undefined;
	creditId: string;
	redeemRequestId: string;
	timeoutMs?: number;
}): Promise<CodexResetConsumePayload> {
	const { creditId, redeemRequestId, ...rest } = params;
	return await requestCodexResetJson<CodexResetConsumePayload>({
		...rest,
		path: RESET_CREDITS_CONSUME_PATH,
		method: "POST",
		body: { credit_id: creditId, redeem_request_id: redeemRequestId },
	});
}

export function formatCodexResetConsumeResult(
	result: CodexResetConsumePayload,
): string {
	const parts: string[] = [];
	if (result.code) parts.push(`code=${result.code}`);
	const redeemedAt = toTrimmedString(result.credit?.redeemed_at);
	if (redeemedAt) parts.push(`redeemed=${redeemedAt}`);
	if (Array.isArray(result.windows_reset) && result.windows_reset.length > 0) {
		parts.push(`windows_reset=${result.windows_reset.join(", ")}`);
	} else if (typeof result.windows_reset === "string") {
		parts.push(`windows_reset=${result.windows_reset}`);
	}
	return parts.length > 0 ? parts.join("  ") : "redeemed";
}

const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

/**
 * Credit ids this process already tried to spend. A failed redemption is not
 * retried on every poll: the credit stays put and a person can look at why.
 */
const autoRedeemAttemptedCreditIds = new Set<string>();

/** Percent left in the weekly window, or `undefined` when there is none to read. */
export function getWeeklyLeftPercent(usage: CodexUsageSummary): number | undefined {
	const window = weeklyWindow(usage);
	if (!window) return undefined;
	if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) {
		return undefined;
	}
	return Math.max(0, 100 - window.usedPercent);
}

function weeklyWindow(usage: CodexUsageSummary) {
	for (const window of [usage.primary, usage.secondary]) {
		if (!hasUsageWindow(window)) continue;
		if ((window.windowMinutes ?? 0) < WEEKLY_WINDOW_MINUTES) continue;
		return window;
	}
	return undefined;
}

/**
 * Spend one banked reset credit when the weekly quota is (nearly) gone.
 *
 * Opt-in (`quotaNotifications.autoRedeemResets`). A credit clears both windows
 * but the 5-hour one refills by itself within hours, so only the weekly window,
 * which can shut an account out for days, triggers a redemption. The server's
 * own `applicableNow` count decides whether a credit can be spent right now.
 *
 * Never throws: a failed redemption is logged and reported as `false`.
 */
export async function autoRedeemResetCredit(params: {
	usage: CodexUsageSummary;
	request: { accountId: string; accessToken: string; organizationId: string | undefined };
	belowPercent: number;
	label: string;
	/**
	 * Cross-process dedupe hook: invoked after a credit is selected and before
	 * it is consumed. Returning `false` means another process already claimed a
	 * spend for this depleted window, so this process spends nothing.
	 */
	claimWindow?: () => Promise<boolean>;
}): Promise<boolean> {
	const { usage, request, belowPercent, label, claimWindow } = params;
	const applicableNow = usage.resetCredits?.applicableNow;
	if (typeof applicableNow !== "number" || applicableNow <= 0) return false;
	const weeklyLeft = getWeeklyLeftPercent(usage);
	if (weeklyLeft === undefined || weeklyLeft > belowPercent) return false;
	try {
		const summary = parseCodexResetCredits(await fetchCodexResetCredits(request));
		const selection = selectRedeemableCredit(summary);
		if (selection.type !== "selected") return false;
		const { credit } = selection;
		if (autoRedeemAttemptedCreditIds.has(credit.id)) return false;
		// The in-process Set above only covers this monitor: a second host
		// holding the same low-quota reading would list its own credits and
		// spend a different one. The caller's claim serializes that across
		// processes before the irreversible POST.
		if (claimWindow && !(await claimWindow())) return false;
		autoRedeemAttemptedCreditIds.add(credit.id);
		const result = await consumeCodexResetCredit({
			...request,
			creditId: credit.id,
			redeemRequestId: createRedeemRequestId(credit.id),
		});
		logInfo(
			`Spent a banked rate-limit reset on ${label} (weekly quota ${Math.round(weeklyLeft)}% left): ${formatCodexResetConsumeResult(result)}`,
		);
		return true;
	} catch (error) {
		logWarn(
			`Could not spend a banked rate-limit reset on ${label}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/** Test seam: forget which credits this process already tried. */
export function resetAutoRedeemAttempts(): void {
	autoRedeemAttemptedCreditIds.clear();
}

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

import { randomUUID } from "node:crypto";

import {
	isCodexAbortError,
	sanitizeCodexApiErrorMessage,
} from "./codex-usage.js";
import { getFetchTimeoutMs, loadPluginConfig } from "./config.js";
import { CODEX_BASE_URL } from "./constants.js";
import { createUsageRequestTimeoutError } from "./error-sentinels.js";
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
 * Normalize the list response.
 *
 * Credits without an `id` are dropped: an id is required to redeem, so an
 * entry lacking one is not actionable and would only pad the display. The
 * server's `available_count` is trusted when it is a sane number and otherwise
 * derived from the credits themselves, so a missing counter never understates
 * what the user actually has.
 */
export function parseCodexResetCredits(
	payload: CodexResetCreditsPayload,
): CodexResetCreditsSummary {
	const credits: CodexResetCredit[] = [];
	for (const entry of payload.credits ?? []) {
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

	const reported = payload.available_count;
	const availableCount =
		typeof reported === "number" && Number.isFinite(reported) && reported >= 0
			? Math.trunc(reported)
			: credits.filter((credit) => credit.isAvailable).length;

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

/** Fresh idempotency key for a redeem request. */
export function createRedeemRequestId(): string {
	return randomUUID();
}

async function requestCodexResetJson<T>(params: {
	path: string;
	method: "GET" | "POST";
	accountId: string;
	accessToken: string;
	organizationId: string | undefined;
	body?: unknown;
	timeoutMs?: number;
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
	}
}

export async function fetchCodexResetCredits(params: {
	accountId: string;
	accessToken: string;
	organizationId: string | undefined;
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

/**
 * Real upstream "warm" request for issue #182.
 *
 * Sends a single minimal billable request to `POST /codex/responses` — the
 * same endpoint and request shape the live request path uses for its quota
 * probe — so the account's rolling usage window actually starts. A read-only
 * `GET /wham/usage` does NOT open the window (it only reports server-side
 * windows that already exist), so warming must send a genuine inference
 * request. The body is deliberately tiny (reasoning effort "none", verbosity
 * "low", no stored conversation) to keep the quota cost negligible, and mirrors
 * the proven quota-probe request shape used by the live request path.
 *
 * This module owns the network side-effect; the pure iteration/summary logic
 * lives in `warm.ts` and is injected this function via `codex-warm.ts`.
 */

import { CODEX_BASE_URL } from "../constants.js";
import { createCodexHeaders } from "../request/fetch-helpers.js";
import { getCodexInstructions } from "../prompts/codex.js";
import { parseRateLimitReason } from "./rate-limits.js";
import type { RequestBody } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger("warm-request");

/** Model used for the warm ping. Mirrors the live quota-probe default. */
const WARM_MODEL = "gpt-5.4";

/** Hard ceiling on a warm request so a hung upstream cannot wedge the batch. */
const WARM_TIMEOUT_MS = 15_000;

export interface WarmRequestParams {
	accountId: string;
	accessToken: string;
	organizationId: string | undefined;
	/** Override the timeout (tests). */
	timeoutMs?: number;
	/** Injectable fetch for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Build the minimal warm-ping request body. Exported for tests so the exact
 * shape (stream/store/reasoning) stays pinned.
 *
 * Instruction resolution is best-effort: a warm ping only needs a valid request
 * that opens the usage window, not the full Codex system prompt. If
 * `getCodexInstructions` cannot resolve the prompt (offline, cache miss, or the
 * bundled file is unavailable in a standalone CLI run), we fall back to a
 * minimal instruction so warming never fails on prompt-file resolution.
 */
export async function buildWarmRequestBody(model = WARM_MODEL): Promise<RequestBody> {
	let instructions: string;
	try {
		instructions = await getCodexInstructions(model);
	} catch (error) {
		log.debug("getCodexInstructions failed for warm ping; using minimal fallback", {
			error: error instanceof Error ? error.message : String(error),
		});
		instructions = "You are a helpful assistant.";
	}
	return {
		model,
		stream: true,
		store: false,
		include: ["reasoning.encrypted_content"],
		instructions,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "warm ping" }],
			},
		],
		reasoning: { effort: "none", summary: "auto" },
		text: { verbosity: "low" },
	};
}

/**
 * Outcome of a warm request.
 * - `opened`: the request started/confirmed the usage window (2xx, or a 429
 *   whose reason is a transient token/concurrency limit — the window is ticking).
 * - `exhausted`: a 429 whose reason is quota/usage-limit — the account's window
 *   is already spent, so warming it is meaningless. Reported distinctly so the
 *   tool does not claim a quota-dead account was "warmed".
 */
export type WarmRequestStatus = "opened" | "exhausted";

export interface WarmRequestResult {
	status: WarmRequestStatus;
	detail?: string;
}

/**
 * Send one warm request to open the account's usage window.
 *
 * Resolves with `{ status: "opened" }` when the upstream started/confirmed the
 * window (2xx, or a non-quota 429 meaning the window is already active), or
 * `{ status: "exhausted" }` for a quota/usage-limit 429 (window already spent).
 * Any other non-2xx, or a network/timeout error, throws so the caller records
 * the account as failed.
 */
export async function warmAccountWindow(
	params: WarmRequestParams,
): Promise<WarmRequestResult> {
	const doFetch = params.fetchImpl ?? fetch;
	const body = await buildWarmRequestBody();
	const headers = createCodexHeaders(undefined, params.accountId, params.accessToken, {
		model: WARM_MODEL,
		organizationId: params.organizationId,
	});

	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		params.timeoutMs ?? WARM_TIMEOUT_MS,
	);
	try {
		const response = await doFetch(`${CODEX_BASE_URL}/codex/responses`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (response.ok) {
			// Drain/cancel the SSE stream — we only needed to start the window.
			try {
				await response.body?.cancel();
			} catch {
				// Ignore cancellation failures.
			}
			return { status: "opened" };
		}

		// Read the error body (small) BEFORE classifying so a 429 quota-exhausted
		// account is not mis-reported as warmed.
		let bodyText = "";
		try {
			bodyText = (await response.text()).slice(0, 2048);
		} catch {
			// Ignore body-read failures; fall back to status-only classification.
		}

		if (response.status === 429) {
			const reason = parseRateLimitReason(extractErrorCode(bodyText));
			if (reason === "quota") {
				log.debug("Warm ping hit 429 quota limit — account window already spent", {
					accountId: params.accountId,
				});
				return { status: "exhausted", detail: "quota/usage limit reached" };
			}
			// token/concurrent/unknown → the window is active and ticking.
			log.debug("Warm ping hit 429 — window already active", {
				accountId: params.accountId,
				reason,
			});
			return { status: "opened" };
		}

		throw new Error(`Warm request failed: HTTP ${response.status}`);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Pull a rate-limit error code/message out of a JSON or plain-text error body
 * so {@link parseRateLimitReason} can classify the 429. Best-effort: returns
 * the raw text when JSON parsing fails so substring matching still works.
 */
function extractErrorCode(bodyText: string): string | undefined {
	if (!bodyText) return undefined;
	try {
		const parsed = JSON.parse(bodyText) as {
			error?: { code?: string; type?: string; message?: string };
			code?: string;
		};
		return (
			parsed.error?.code ??
			parsed.error?.type ??
			parsed.error?.message ??
			parsed.code ??
			bodyText
		);
	} catch {
		return bodyText;
	}
}

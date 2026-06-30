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
 */
export async function buildWarmRequestBody(model = WARM_MODEL): Promise<RequestBody> {
	const instructions = await getCodexInstructions(model);
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
 * Send one warm request to open the account's usage window.
 *
 * Resolves `true` when the upstream accepted the request enough to start the
 * window. A 2xx clearly opens it; a 429 (rate-limited) means the window is
 * already open/active, which still satisfies the user intent ("the window is
 * ticking"). Any other non-2xx, or a network/timeout error, throws so the
 * caller records the account as failed.
 */
export async function warmAccountWindow(params: WarmRequestParams): Promise<boolean> {
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

		// Drain/cancel the SSE stream immediately — we only needed to start the
		// window, not consume the response.
		try {
			await response.body?.cancel();
		} catch {
			// Ignore cancellation failures.
		}

		if (response.ok) return true;

		// 429 = window already open and currently rate-limited. The user's goal
		// (window is ticking) is satisfied, so treat it as a successful warm.
		if (response.status === 429) {
			log.debug("Warm ping hit 429 — window already active", {
				accountId: params.accountId,
			});
			return true;
		}

		throw new Error(`Warm request failed: HTTP ${response.status}`);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * `x-codex-turn-state` sticky routing (codex-rs/core/src/client.rs,
 * `ModelClientSession::turn_state`).
 *
 * The backend returns an `x-codex-turn-state` token on the first response of a
 * turn. Codex replays it unchanged on every later request of the same turn
 * (tool-result continuations and retries), must not send it on a different
 * turn, and clears it when the auth owner changes.
 *
 * The plugin has no explicit turn boundary, so it infers one from the request
 * body: a request whose last input item is a tool result continues the
 * current turn; anything else (a new user message) starts a fresh one. State
 * is keyed per session (`prompt_cache_key`) and per account, so rotating to a
 * different account never replays another owner's token, and a new turn
 * clears the tokens of every account that served the session.
 */
import { OPENAI_HEADERS } from "../constants.js";
import type { InputItem } from "../types.js";

const CONTINUATION_ITEM_TYPES: ReadonlySet<string> = new Set([
	"function_call_output",
	"custom_tool_call_output",
	"tool_search_output",
	"local_shell_call_output",
]);

/** True when the request continues a turn (its last input item is a tool result). */
export function isTurnContinuation(input: InputItem[] | undefined): boolean {
	if (!Array.isArray(input) || input.length === 0) return false;
	const last = input[input.length - 1];
	return typeof last?.type === "string" && CONTINUATION_ITEM_TYPES.has(last.type);
}

export class TurnStateStore {
	/** session -> (account -> token) for the session's current turn. */
	private readonly sessions = new Map<string, Map<string, string>>();

	constructor(private readonly maxSessions = 512) {}

	/**
	 * Token to send on this request, if any. A request that starts a new turn
	 * drops every account's token for the session, so no account can replay a
	 * previous turn's routing after the pool rotates.
	 */
	forRequest(
		sessionKey: string | undefined,
		accountKey: string,
		input: InputItem[] | undefined,
	): string | undefined {
		if (!sessionKey) return undefined;
		if (!isTurnContinuation(input)) {
			this.sessions.delete(sessionKey);
			return undefined;
		}
		return this.sessions.get(sessionKey)?.get(accountKey);
	}

	/**
	 * The token currently held for this session and account, without treating
	 * the request as a turn boundary. Used to refresh the header on same-account
	 * retries of a request whose first response seeded the token.
	 */
	current(sessionKey: string | undefined, accountKey: string): string | undefined {
		if (!sessionKey) return undefined;
		return this.sessions.get(sessionKey)?.get(accountKey);
	}

	/** Remember the token from a response; the first token of a turn wins per account. */
	capture(sessionKey: string | undefined, accountKey: string, headers: Headers): void {
		if (!sessionKey) return;
		const token = headers.get(OPENAI_HEADERS.TURN_STATE)?.trim();
		if (!token) return;
		let accounts = this.sessions.get(sessionKey);
		if (!accounts) {
			accounts = new Map();
			this.sessions.set(sessionKey, accounts);
			while (this.sessions.size > this.maxSessions) {
				const oldest = this.sessions.keys().next().value;
				if (oldest === undefined) break;
				this.sessions.delete(oldest);
			}
		}
		if (!accounts.has(accountKey)) accounts.set(accountKey, token);
	}

	/** Number of sessions holding turn state. */
	get size(): number {
		return this.sessions.size;
	}
}

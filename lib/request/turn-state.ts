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

interface SessionTurnState {
	/** Bumped at every new turn; responses from an older turn are ignored. */
	generation: number;
	/** account -> token for the current turn. */
	tokens: Map<string, string>;
}

export interface TurnStateRequest {
	/** Token to send on this request, if any. */
	turnState?: string;
	/** Turn this request belongs to; pass back to {@link TurnStateStore.capture}. */
	generation: number;
}

export class TurnStateStore {
	private readonly sessions = new Map<string, SessionTurnState>();

	constructor(private readonly maxSessions = 512) {}

	private session(sessionKey: string): SessionTurnState {
		let state = this.sessions.get(sessionKey);
		if (!state) {
			state = { generation: 0, tokens: new Map() };
			this.sessions.set(sessionKey, state);
			while (this.sessions.size > this.maxSessions) {
				const oldest = this.sessions.keys().next().value;
				if (oldest === undefined) break;
				this.sessions.delete(oldest);
			}
		}
		return state;
	}

	/**
	 * Token to send on this request, if any. A request that starts a new turn
	 * drops every account's token for the session and advances its turn
	 * generation, so no account can replay a previous turn's routing after the
	 * pool rotates, and a late response from the old turn cannot seed the new one.
	 */
	forRequest(
		sessionKey: string | undefined,
		accountKey: string,
		input: InputItem[] | undefined,
	): TurnStateRequest {
		if (!sessionKey) return { generation: 0 };
		const state = this.session(sessionKey);
		if (!isTurnContinuation(input)) {
			state.generation += 1;
			state.tokens.clear();
			return { generation: state.generation };
		}
		return { turnState: state.tokens.get(accountKey), generation: state.generation };
	}

	/**
	 * The token currently held for this session and account, without treating
	 * the request as a turn boundary. Used to refresh the header on same-account
	 * retries of a request whose first response seeded the token.
	 */
	current(sessionKey: string | undefined, accountKey: string): string | undefined {
		if (!sessionKey) return undefined;
		return this.sessions.get(sessionKey)?.tokens.get(accountKey);
	}

	/**
	 * Remember the token from a response; the first token of a turn wins per
	 * account. `generation` is the value {@link forRequest} returned for the
	 * request; a response from a turn the session has moved past is ignored.
	 */
	capture(
		sessionKey: string | undefined,
		accountKey: string,
		headers: Headers,
		generation: number,
	): void {
		if (!sessionKey) return;
		const token = headers.get(OPENAI_HEADERS.TURN_STATE)?.trim();
		if (!token) return;
		const state = this.sessions.get(sessionKey);
		if (!state || state.generation !== generation) return;
		if (!state.tokens.has(accountKey)) state.tokens.set(accountKey, token);
	}

	/** Number of sessions tracked. */
	get size(): number {
		return this.sessions.size;
	}
}

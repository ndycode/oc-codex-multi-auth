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
 * different account never replays another owner's token.
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
	private readonly states = new Map<string, string>();

	constructor(private readonly maxEntries = 512) {}

	private key(sessionKey: string, accountKey: string): string {
		return `${accountKey}\u0000${sessionKey}`;
	}

	/**
	 * Token to send on this request, if any. A request that starts a new turn
	 * clears the stored token so the next response can seed a fresh one.
	 */
	forRequest(
		sessionKey: string | undefined,
		accountKey: string,
		input: InputItem[] | undefined,
	): string | undefined {
		if (!sessionKey) return undefined;
		const key = this.key(sessionKey, accountKey);
		if (!isTurnContinuation(input)) {
			this.states.delete(key);
			return undefined;
		}
		return this.states.get(key);
	}

	/** Remember the token from a response; the first token of a turn wins. */
	capture(sessionKey: string | undefined, accountKey: string, headers: Headers): void {
		if (!sessionKey) return;
		const token = headers.get(OPENAI_HEADERS.TURN_STATE)?.trim();
		if (!token) return;
		const key = this.key(sessionKey, accountKey);
		if (this.states.has(key)) return;
		this.states.set(key, token);
		while (this.states.size > this.maxEntries) {
			const oldest = this.states.keys().next().value;
			if (oldest === undefined) break;
			this.states.delete(oldest);
		}
	}

	get size(): number {
		return this.states.size;
	}
}

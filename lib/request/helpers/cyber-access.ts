/**
 * OpenAI Daybreak ("Trusted Access for Cyber") access programs.
 *
 * Daybreak is not a model: a request selects it with the Responses body field
 * `access_programs: { cyber: "standard" | "daybreak_blue" | "daybreak_red" }`
 * on a model whose catalog entry lists that program for the account
 * (`available_access_programs.cyber` in `/backend-api/codex/models`). The
 * ChatGPT Codex backend does not default to Daybreak: an omitted field is
 * served as `standard`.
 *
 * Observed backend behavior (2026-11) that shapes the routing here:
 * - an incompatible model answers 403 `{"detail":"Daybreak isn't available
 *   for this model. ..."}` on every account;
 * - an account without the program answers 200 and echoes
 *   `access_programs.cyber: "standard"` - a silent downgrade, not an error.
 *
 * See https://developers.openai.com/api/docs/guides/daybreak.
 */

import type { RequestBody } from "../../types.js";
import { getEffortSuffix, stripEffortSuffix } from "./effort-suffix.js";

export const CYBER_ACCESS_PROGRAMS = ["standard", "daybreak_blue", "daybreak_red"] as const;
export type CyberAccessProgram = (typeof CYBER_ACCESS_PROGRAMS)[number];

/** Selector suffix that asks for `daybreak_blue` on a mainline model, e.g. `gpt-6-sol-daybreak`. */
export const DAYBREAK_SELECTOR_SUFFIX = "-daybreak";

export function normalizeCyberAccessProgram(value: unknown): CyberAccessProgram | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return (CYBER_ACCESS_PROGRAMS as readonly string[]).includes(normalized)
		? (normalized as CyberAccessProgram)
		: undefined;
}

/** True for a program that changes safeguards, i.e. anything but `standard`. */
export function isDaybreakProgram(program: CyberAccessProgram | undefined): program is Exclude<CyberAccessProgram, "standard"> {
	return program !== undefined && program !== "standard";
}

/**
 * Split a `-daybreak` selector into the backend model id and the flag.
 * Accepts `<model>-daybreak` and `<model>-daybreak-<effort>`; the effort
 * suffix is kept on the returned id so effort parsing still sees it.
 * Input must already have its provider prefix removed.
 */
export function stripDaybreakSelector(modelId: string): { modelId: string; daybreak: boolean } {
	const effort = getEffortSuffix(modelId);
	const withoutEffort = effort ? stripEffortSuffix(modelId) : modelId;
	if (!withoutEffort.toLowerCase().endsWith(DAYBREAK_SELECTOR_SUFFIX)) {
		return { modelId, daybreak: false };
	}
	const base = withoutEffort.slice(0, -DAYBREAK_SELECTOR_SUFFIX.length);
	if (!base) return { modelId, daybreak: false };
	return { modelId: effort ? `${base}-${effort}` : base, daybreak: true };
}

/**
 * Account-pool and entitlement key for a request. A Daybreak request uses its
 * own key (`gpt-6-sol-daybreak`, `gpt-6-sol-daybreak-red`) so a pool for it
 * never restricts the model's standard traffic.
 */
export function getCyberAccessPoolKey(
	model: string | undefined,
	program: CyberAccessProgram | undefined,
): string | undefined {
	if (!model || !isDaybreakProgram(program)) return model;
	return program === "daybreak_red" ? `${model}${DAYBREAK_SELECTOR_SUFFIX}-red` : `${model}${DAYBREAK_SELECTOR_SUFFIX}`;
}

/** Put the program on the body, or remove the field when none was requested. */
export function applyCyberAccessProgram(body: RequestBody, program: CyberAccessProgram | undefined): void {
	if (program) body.access_programs = { cyber: program };
	else delete body.access_programs;
}

/**
 * `model`: the model cannot run the program on any account (fail the request).
 * `account`: this account lacks the program (try the next account).
 */
export type CyberAccessFailure = "model" | "account";

const MODEL_UNAVAILABLE = /daybreak isn'?t available for this model/i;

/** Classify an upstream error caused by the requested access program. */
export function classifyCyberAccessError(status: number, errorBody: unknown): CyberAccessFailure | undefined {
	const text = typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody ?? "");
	if (/access_program_not_enabled/.test(text)) return "account";
	if (/invalid_access_program|unsupported_access_program/.test(text)) return "model";
	if (status === 403 && MODEL_UNAVAILABLE.test(text)) return "model";
	return undefined;
}

const MAX_PEEK_BYTES = 64 * 1024;

/**
 * Read the stream up to the first event that carries a `response` object and
 * report its `access_programs.cyber`. The returned response replays every
 * byte already read, so the caller can forward it unchanged.
 * `served` is `null` when the response carries no program (standard) and
 * `undefined` when no response object appeared within the peek window.
 */
export async function peekServedCyberAccessProgram(
	response: Response,
): Promise<{ response: Response; served: CyberAccessProgram | null | undefined }> {
	if (!response.body) return { response, served: undefined };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	const decoder = new TextDecoder();
	let text = "";
	let size = 0;
	let served: CyberAccessProgram | null | undefined;
	let done = false;
	while (served === undefined && size < MAX_PEEK_BYTES) {
		const result = await reader.read();
		if (result.done) {
			done = true;
			break;
		}
		chunks.push(result.value);
		size += result.value.byteLength;
		text += decoder.decode(result.value, { stream: true });
		served = findServedProgram(text);
	}
	const replay = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			if (done) controller.close();
		},
		async pull(controller) {
			const result = await reader.read();
			if (result.done) controller.close();
			else controller.enqueue(result.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return {
		response: new Response(replay, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		}),
		served,
	};
}

function findServedProgram(text: string): CyberAccessProgram | null | undefined {
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		let event: unknown;
		try {
			event = JSON.parse(payload);
		} catch {
			continue;
		}
		if (!event || typeof event !== "object") continue;
		const response = (event as { response?: unknown }).response;
		if (!response || typeof response !== "object") continue;
		const programs = (response as { access_programs?: unknown }).access_programs;
		if (!programs || typeof programs !== "object") return null;
		return normalizeCyberAccessProgram((programs as { cyber?: unknown }).cyber) ?? null;
	}
	return undefined;
}

import { RequestError } from "../errors.js";
import { createLogger, logRequest, LOGGING_ENABLED } from "../logger.js";

import type { SSEEventData } from "../types.js";

const log = createLogger("response-handler");

const MAX_SSE_SIZE = 10 * 1024 * 1024; // 10MB limit to prevent memory exhaustion
const DEFAULT_STREAM_STALL_TIMEOUT_MS = 45_000;
const STREAM_ERROR_CODE = "stream_error";

type ParsedSseResult =
	| {
			kind: "response";
			response: unknown;
	  }
	| {
			kind: "error";
			error: {
				message: string;
				type?: string;
				code?: string | number;
			};
	  };

function toRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object") {
		return value as Record<string, unknown>;
	}
	return null;
}

function extractErrorFromRecord(errorRecord: Record<string, unknown> | null): {
	message: string;
	type?: string;
	code?: string | number;
} | null {
	if (!errorRecord) return null;
	const message =
		typeof errorRecord.message === "string" ? errorRecord.message.trim() : "";
	if (!message) return null;
	const type = typeof errorRecord.type === "string" ? errorRecord.type : undefined;
	const rawCode = errorRecord.code;
	const code =
		typeof rawCode === "string" || typeof rawCode === "number"
			? rawCode
			: undefined;

	return { message, type, code };
}

function extractStreamError(event: SSEEventData): {
	message: string;
	type?: string;
	code?: string | number;
} {
	const errorRecord = toRecord((event as { error?: unknown }).error);
	const eventMessage = (event as { message?: unknown }).message;
	const parsedError = extractErrorFromRecord(errorRecord);
	if (parsedError) return parsedError;

	const message =
		(typeof eventMessage === "string" ? eventMessage.trim() : "") ||
		"Codex stream emitted an error event";
	return { message };
}

function extractResponseError(responseRecord: Record<string, unknown>): {
	message: string;
	type?: string;
	code?: string | number;
} | null {
	const status = typeof responseRecord.status === "string" ? responseRecord.status : "";
	const parsedError = extractErrorFromRecord(
		toRecord((responseRecord as { error?: unknown }).error),
	);
	if (parsedError) return parsedError;
	if (status === "failed" || status === "incomplete") {
		return { message: `Codex stream ended with status: ${status}` };
	}
	return null;
}

function parseDataPayload(line: string): string | null {
	if (!line.startsWith("data:")) return null;
	const payload = line.slice(5).trimStart();
	if (!payload || payload === "[DONE]") return null;
	return payload;
}

/**

 * Parse SSE stream to extract final response
 * @param sseText - Complete SSE stream text
 * @returns Final response object or null if not found
 */
function parseSseStream(sseText: string): ParsedSseResult | null {
	const lines = sseText.split(/\r?\n/);

	for (const line of lines) {
		const trimmedLine = line.trim();
		const payload = parseDataPayload(trimmedLine);
		if (payload) {
			try {
				const data = JSON.parse(payload) as SSEEventData;
				const responseRecord = toRecord((data as { response?: unknown }).response);

				if (data.type === "error" || data.type === "response.error") {
					const parsedError = extractStreamError(data);
					log.error("SSE error event received", { error: parsedError });
					return { kind: "error", error: parsedError };
				}

				if (data.type === "response.failed" || data.type === "response.incomplete") {
					const parsedError =
						(responseRecord && extractResponseError(responseRecord)) ??
						extractStreamError(data);
					log.error("SSE response terminal error event received", {
						type: data.type,
						error: parsedError,
					});
					return { kind: "error", error: parsedError };
				}

				if (data.type === "response.done" || data.type === "response.completed") {
					if (responseRecord) {
						const parsedError = extractResponseError(responseRecord);
						if (parsedError) {
							log.error("SSE response completed with terminal error", {
								error: parsedError,
								status: responseRecord.status,
							});
							return { kind: "error", error: parsedError };
						}
					}
					return { kind: "response", response: data.response };
				}
			} catch {
				// Skip malformed JSON
			}
		}
	}

	return null;
}

/**
 * Convert SSE stream response to JSON for generateText()
 * @param response - Fetch response with SSE stream
 * @param headers - Response headers
 * @returns Response with JSON body
 */
export async function convertSseToJson(
	response: Response,
	headers: Headers,
	options?: { streamStallTimeoutMs?: number },
): Promise<Response> {
	if (!response.body) {
		throw new RequestError('[openai-codex-plugin] Response has no body', {
			code: 'NO_RESPONSE_BODY',
		});
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let fullText = '';
	const streamStallTimeoutMs = Math.max(
		1_000,
		Math.floor(options?.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS),
	);

	try {
		// Consume the entire stream
		while (true) {
			const { done, value } = await readWithTimeout(reader, streamStallTimeoutMs);
			if (done) break;
			fullText += decoder.decode(value, { stream: true });
			if (fullText.length > MAX_SSE_SIZE) {
				throw new RequestError(`SSE response exceeds ${MAX_SSE_SIZE} bytes limit`, {
					code: 'SSE_TOO_LARGE',
					context: { maxBytes: MAX_SSE_SIZE, actualBytes: fullText.length },
				});
			}
		}

		if (LOGGING_ENABLED) {
			logRequest("stream-full", { fullContent: fullText });
		}

		// Parse SSE events to extract the final response
		const parsedResult = parseSseStream(fullText);

		if (parsedResult?.kind === "error") {
			log.warn("SSE stream returned an error event", parsedResult.error);
			logRequest("stream-error", {
				error: parsedResult.error.message,
				type: parsedResult.error.type,
				code: parsedResult.error.code,
			});

			const jsonHeaders = new Headers(headers);
			jsonHeaders.set("content-type", "application/json; charset=utf-8");
			const status = response.status >= 400 ? response.status : 502;
			const payload = {
				error: {
					message: parsedResult.error.message,
					type: parsedResult.error.type ?? STREAM_ERROR_CODE,
					code: parsedResult.error.code ?? STREAM_ERROR_CODE,
				},
			};

			return new Response(JSON.stringify(payload), {
				status,
				statusText: status === 502 ? "Bad Gateway" : response.statusText,
				headers: jsonHeaders,
			});
		}

		const finalResponse =
			parsedResult?.kind === "response" ? parsedResult.response : null;

		if (!finalResponse) {
			log.warn("Could not find final response in SSE stream");

			logRequest("stream-error", { error: "No response.done event found" });

			// Non-streaming responses are routed here unconditionally, so a body
			// with no SSE framing at all may simply be plain JSON — pass it
			// through untouched. A body that DID carry SSE data lines but never
			// reached a terminal event is a truncated upstream response:
			// returning it at the original 2xx status would credit the account
			// with a success and hand the client an unparseable body, so it is
			// surfaced like the terminal-error branch above instead.
			const carriedSseData = /^(data|event):/m.test(fullText);
			if (!carriedSseData) {
				return new Response(fullText, {
					status: response.status,
					statusText: response.statusText,
					headers: headers,
				});
			}

			const jsonHeaders = new Headers(headers);
			jsonHeaders.set("content-type", "application/json; charset=utf-8");
			const status = response.status >= 400 ? response.status : 502;
			return new Response(
				JSON.stringify({
					error: {
						message:
							"Upstream SSE stream ended without a terminal response event.",
						type: STREAM_ERROR_CODE,
						code: "incomplete_stream",
					},
				}),
				{
					status,
					statusText: status === 502 ? "Bad Gateway" : response.statusText,
					headers: jsonHeaders,
				},
			);
		}

		// Return as plain JSON (not SSE)
		const jsonHeaders = new Headers(headers);
		jsonHeaders.set('content-type', 'application/json; charset=utf-8');

		return new Response(JSON.stringify(finalResponse), {
			status: response.status,
			statusText: response.statusText,
			headers: jsonHeaders,
		});

	} catch (error) {
		log.error("Error converting stream", { error: String(error) });
		logRequest("stream-error", { error: String(error) });
		if (typeof reader.cancel === "function") {
			await reader.cancel(String(error)).catch(() => {});
		}
		throw error;
	} finally {
		// Release the reader lock to prevent resource leaks
		reader.releaseLock();
	}

}

/**
 * Ensure response has content-type header
 * @param headers - Response headers
 * @returns Headers with content-type set
 */
export function ensureContentType(headers: Headers): Headers {
	const responseHeaders = new Headers(headers);

	if (!responseHeaders.has('content-type')) {
		responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
	}

	return responseHeaders;
}

async function readWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					reject(
						new Error(
							`SSE stream stalled for ${timeoutMs}ms while waiting for response.done`,
						),
					);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	}
}

/**
 * Check if a non-streaming response is empty or malformed.
 * Returns true if the response body is empty, null, or lacks meaningful content.
 * @param body - Parsed JSON body from the response
 * @returns True if response should be considered empty/malformed
 */
export function isEmptyResponse(body: unknown): boolean {
	if (body === null || body === undefined) return true;
	if (typeof body === 'string' && body.trim() === '') return true;
	if (typeof body !== 'object') return false;

	const obj = body as Record<string, unknown>;

	if (Object.keys(obj).length === 0) return true;

	const hasOutput = 'output' in obj && obj.output !== null && obj.output !== undefined;
	const hasChoices = 'choices' in obj && Array.isArray(obj.choices) && 
		obj.choices.some(c => c !== null && c !== undefined && typeof c === 'object' && Object.keys(c as object).length > 0);
	const hasContent = 'content' in obj && obj.content !== null && obj.content !== undefined &&
		(typeof obj.content !== 'string' || obj.content.trim() !== '');

	if ('id' in obj || 'object' in obj || 'model' in obj) {
		return !hasOutput && !hasChoices && !hasContent;
	}

	return false;
}

/**
 * Contract test — Codex SSE stream event shapes.
 *
 * Pins the SSE framing and event shapes the Codex backend emits for a
 * streaming response. The production SSE parser is
 * `convertSseToJson` in `lib/request/response-handler.ts`; it scans the
 * stream, matches `response.done` / `response.completed` events, extracts
 * the embedded `response` object, and returns a JSON `Response`.
 *
 * If Codex changes the SSE framing (`data:` prefix, terminal event name,
 * embedded `response` object structure), this test fails fast with a clear
 * "upstream shape changed" message. The test uses the EXACT production
 * parser — no duplicated SSE parsing in test code.
 */

import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { convertSseToJson } from "../../lib/request/response-handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
	__dirname,
	"fixtures",
	"codex-sse-stream.txt",
);

async function loadFixtureAsResponse(): Promise<Response> {
	const raw = await fs.readFile(fixturePath, "utf-8");
	return new Response(raw, {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "text/event-stream; charset=utf-8" },
	});
}

describe("contract: Codex SSE stream events", () => {
	it("production parser extracts the final response from the pinned stream", async () => {
		const response = await loadFixtureAsResponse();
		const headers = new Headers();

		const converted = await convertSseToJson(response, headers);

		if (converted.status >= 400) {
			const errorBody = await converted.text();
			throw new Error(
				`Contract broken: upstream shape changed for Codex SSE stream. ` +
					`convertSseToJson returned status ${converted.status} for the pinned ` +
					`fixture. Body: ${errorBody}`,
			);
		}

		expect(converted.status).toBe(200);
		expect(converted.headers.get("content-type")).toBe(
			"application/json; charset=utf-8",
		);

		const body = (await converted.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			id: expect.any(String),
			object: "response",
			model: expect.any(String),
			status: "completed",
			output: expect.any(Array),
		});
	});

	it("pins response.completed as the terminal event shape", async () => {
		const response = await loadFixtureAsResponse();
		const converted = await convertSseToJson(response, new Headers());
		const body = (await converted.json()) as {
			output: Array<{
				type: string;
				content: Array<{ type: string; text: string }>;
			}>;
			reasoning?: { encrypted_content?: unknown };
		};

		// Nested shape the plugin forwards to OpenCode. If upstream moves
		// these fields, downstream renderers break — we catch that here.
		const firstMessage = body.output[0];
		expect(firstMessage?.type).toBe("message");
		const firstContent = firstMessage?.content?.[0];
		expect(firstContent?.type).toBe("output_text");
		expect(typeof firstContent?.text).toBe("string");

		// Per AGENTS.md, streaming responses must still carry
		// reasoning.encrypted_content for stateless continuity.
		expect(typeof body.reasoning?.encrypted_content).toBe("string");
	});

	it("rejects an SSE stream that lacks a terminal response event (drift guard)", async () => {
		// Control case: an SSE stream with only delta events and NO
		// response.done / response.completed must NOT be parsed as a JSON
		// response. If upstream ever renames the terminal event, we need this
		// to fail loudly rather than silently returning an empty JSON body.
		const streamWithoutTerminal =
			'data: {"type":"response.output_text.delta","delta":"hello"}\n\n';
		const resp = new Response(streamWithoutTerminal, { status: 200 });
		const converted = await convertSseToJson(resp, new Headers());

		// Production surfaces this as a loud 502 `incomplete_stream` error:
		// SSE data lines with no terminal event mean either a truncated
		// upstream response or a parser-vs-upstream mismatch, and neither may
		// be reported to the caller (or the account pool) as a success.
		expect(converted.status).toBe(502);
		const body = (await converted.json()) as {
			error?: { code?: string; type?: string };
		};
		expect(body.error?.code).toBe("incomplete_stream");
		expect(body.error?.type).toBe("stream_error");
	});

	it("pins stream error event shape (error contract)", async () => {
		// A Codex error event must be converted to a JSON error body with
		// status 502 and the error envelope shape the plugin forwards to
		// OpenCode. This is part of the upstream contract: if the error
		// event shape changes, users see unhandled errors.
		const errorStream =
			'data: {"type":"error","error":{"message":"contract error","code":"test_code"}}\n\n';
		const resp = new Response(errorStream, { status: 200 });
		const converted = await convertSseToJson(resp, new Headers());

		expect(converted.status).toBe(502);
		const body = (await converted.json()) as {
			error?: { message?: string; type?: string; code?: string };
		};
		expect(body.error).toBeDefined();
		expect(body.error?.message).toBe("contract error");
		expect(body.error?.code).toBe("test_code");
	});
});

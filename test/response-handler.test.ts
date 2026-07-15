import { describe, it, expect, vi } from 'vitest';
import { ensureContentType, convertSseToJson, isEmptyResponse } from '../lib/request/response-handler.js';

describe('Response Handler Module', () => {
	describe('ensureContentType', () => {
		it('should preserve existing content-type', () => {
			const headers = new Headers();
			headers.set('content-type', 'application/json');
			const result = ensureContentType(headers);
			expect(result.get('content-type')).toBe('application/json');
		});

		it('should add default content-type if missing', () => {
			const headers = new Headers();
			const result = ensureContentType(headers);
			expect(result.get('content-type')).toBe('text/event-stream; charset=utf-8');
		});

		it('should not modify original headers', () => {
			const headers = new Headers();
			const result = ensureContentType(headers);
			expect(headers.has('content-type')).toBe(false);
			expect(result.has('content-type')).toBe(true);
		});
	});

	describe('convertSseToJson', () => {
		it('should throw error if response has no body', async () => {
			const response = new Response(null);
			const headers = new Headers();

			await expect(convertSseToJson(response, headers)).rejects.toThrow(
				'Response has no body'
			);
		});

		it('should parse SSE stream with response.done event', async () => {
			const sseContent = `data: {"type":"response.started"}
data: {"type":"response.done","response":{"id":"resp_123","output":"test"}}
`;
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json();

			expect(body).toEqual({ id: 'resp_123', output: 'test' });
			expect(result.headers.get('content-type')).toBe('application/json; charset=utf-8');
		});

		it('should parse SSE stream with response.completed event', async () => {
			const sseContent = `data: {"type":"response.started"}
data: {"type":"response.completed","response":{"id":"resp_456","output":"done"}}
`;
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json();

			expect(body).toEqual({ id: 'resp_456', output: 'done' });
		});

		it('should surface a truncated SSE stream as a 502 instead of a fake 200', async () => {
			// The stream carried SSE data lines but ended before any terminal
			// event (completed/done/failed/incomplete/error): the upstream
			// response was cut off. Returning the raw SSE at 200 would credit
			// the account with a success and hand the client an unparseable body.
			const sseContent = `data: {"type":"response.created","response":{"id":"resp_cut"}}
data: {"type":"response.in_progress","response":{"id":"resp_cut"}}
`;
			const response = new Response(sseContent, { status: 200 });

			const result = await convertSseToJson(response, new Headers());
			const body = await result.json();

			expect(result.status).toBe(502);
			expect(body.error.code).toBe('incomplete_stream');
			expect(body.error.type).toBe('stream_error');
		});

		it('should pass a plain JSON body through untouched', async () => {
			// Non-streaming responses route through convertSseToJson
			// unconditionally, so a body with no SSE framing is not an error —
			// it is the JSON answer itself.
			const jsonBody = JSON.stringify({ id: 'resp_json', output: 'plain' });
			const response = new Response(jsonBody, { status: 200 });

			const result = await convertSseToJson(response, new Headers());

			expect(result.status).toBe(200);
			expect(await result.text()).toBe(jsonBody);
		});

		it('should convert SSE error events into JSON error responses', async () => {
			const sseContent = `data: {"type":"error","error":{"message":"Tool call failed","code":"tool_failed"}}`;
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json();

			expect(result.status).toBe(502);
			expect(result.headers.get('content-type')).toBe('application/json; charset=utf-8');
			expect(body).toEqual({
				error: {
					message: 'Tool call failed',
					type: 'stream_error',
					code: 'tool_failed',
				},
			});
		});

		it('should convert response.failed terminal events into JSON error responses', async () => {
			const sseContent = `data: {"type":"response.failed","response":{"id":"resp_fail","status":"failed","error":{"message":"Tool execution failed","code":"tool_error"}}}`;
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json();

			expect(result.status).toBe(502);
			expect(body).toEqual({
				error: {
					message: 'Tool execution failed',
					type: 'stream_error',
					code: 'tool_error',
				},
			});
		});

		it('should parse data lines without trailing space after colon', async () => {
			const sseContent = `data:{"type":"response.done","response":{"id":"resp_no_space","output":"ok"}}`;
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json();

			expect(body).toEqual({ id: 'resp_no_space', output: 'ok' });
		});

		it('should report a 502 if SSE data was carried but no final response found', async () => {
			const sseContent = `data: {"type":"response.started"}
data: {"type":"chunk","delta":"text"}
`;
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json();

			expect(result.status).toBe(502);
			expect(body.error.code).toBe('incomplete_stream');
		});

		it('should skip malformed JSON in SSE stream', async () => {
			const sseContent = `data: not-json
data: {"type":"response.done","response":{"id":"resp_789"}}
`;
			const response = new Response(sseContent);
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const body = await result.json();

			expect(body).toEqual({ id: 'resp_789' });
		});

		it('should handle empty SSE stream', async () => {
			const response = new Response('');
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);
			const text = await result.text();

			expect(text).toBe('');
		});

		it('should preserve response status and statusText', async () => {
			const sseContent = `data: {"type":"response.done","response":{"id":"x"}}`;
			const response = new Response(sseContent, {
				status: 200,
				statusText: 'OK',
			});
			const headers = new Headers();

			const result = await convertSseToJson(response, headers);

			expect(result.status).toBe(200);
			expect(result.statusText).toBe('OK');
		});

		it('should throw error if SSE stream exceeds size limit', async () => {
			const largeContent = 'a'.repeat(20 * 1024 * 1024 + 1);
			const response = new Response(largeContent);
			const headers = new Headers();

			await expect(convertSseToJson(response, headers)).rejects.toThrow(
				/exceeds.*bytes limit/
			);
		});

		it('should throw error when stream read fails', async () => {
			const mockReader = {
				read: vi.fn().mockRejectedValue(new Error('Stream read error')),
				releaseLock: vi.fn(),
			};
			const response = {
				body: {
					getReader: () => mockReader,
				},
				status: 200,
				statusText: 'OK',
			} as unknown as Response;
			const headers = new Headers();

			await expect(convertSseToJson(response, headers)).rejects.toThrow('Stream read error');
			expect(mockReader.releaseLock).toHaveBeenCalled();
		});

		it('should throw when stream stalls past timeout', async () => {
			vi.useFakeTimers();
			const mockReader = {
				read: vi.fn(() => new Promise<{ done: boolean; value?: Uint8Array }>(() => {})),
				cancel: vi.fn(async () => undefined),
				releaseLock: vi.fn(),
			};
			const response = {
				body: {
					getReader: () => mockReader,
				},
				status: 200,
				statusText: 'OK',
			} as unknown as Response;

			const pending = convertSseToJson(response, new Headers(), { streamStallTimeoutMs: 1000 });
			const assertion = expect(pending).rejects.toThrow(/stalled/);
			await vi.advanceTimersByTimeAsync(1100);

			await assertion;
			expect(mockReader.cancel).toHaveBeenCalled();
			expect(mockReader.releaseLock).toHaveBeenCalled();
			vi.useRealTimers();
		});
	});

	describe('isEmptyResponse', () => {
		it('should return true for null', () => {
			expect(isEmptyResponse(null)).toBe(true);
		});

		it('should return true for undefined', () => {
			expect(isEmptyResponse(undefined)).toBe(true);
		});

		it('should return true for empty string', () => {
			expect(isEmptyResponse('')).toBe(true);
			expect(isEmptyResponse('   ')).toBe(true);
		});

		it('should return true for empty object', () => {
			expect(isEmptyResponse({})).toBe(true);
		});

		it('should return true for response object without meaningful content', () => {
			expect(isEmptyResponse({ id: 'resp_123' })).toBe(true);
			expect(isEmptyResponse({ id: 'resp_123', model: 'gpt-5.2' })).toBe(true);
			expect(isEmptyResponse({ id: 'resp_123', object: 'response' })).toBe(true);
		});

		it('should return true for response with null/undefined output', () => {
			expect(isEmptyResponse({ id: 'resp_123', output: null })).toBe(true);
			expect(isEmptyResponse({ id: 'resp_123', output: undefined })).toBe(true);
		});

		it('should return true for response with empty choices array', () => {
			expect(isEmptyResponse({ id: 'resp_123', choices: [] })).toBe(true);
		});

		it('should return false for response with output', () => {
			expect(isEmptyResponse({ output: [{ text: 'hello' }] })).toBe(false);
			expect(isEmptyResponse({ id: 'resp_123', output: 'some output' })).toBe(false);
		});

		it('should return false for response with choices', () => {
			expect(isEmptyResponse({ choices: [{ message: { content: 'hi' } }] })).toBe(false);
		});

		it('should return true for response with empty choice objects', () => {
			expect(isEmptyResponse({ id: 'resp_123', choices: [{}] })).toBe(true);
			expect(isEmptyResponse({ id: 'resp_123', choices: [null] })).toBe(true);
		});

		it('should return false for response with content', () => {
			expect(isEmptyResponse({ content: 'hello world' })).toBe(false);
			expect(isEmptyResponse({ id: 'resp_123', content: [] })).toBe(false);
		});

		it('should return true for response with empty string content', () => {
			expect(isEmptyResponse({ id: 'resp_123', content: '' })).toBe(true);
			expect(isEmptyResponse({ id: 'resp_123', content: '   ' })).toBe(true);
		});

		it('should return false for non-object primitives', () => {
			expect(isEmptyResponse(123)).toBe(false);
			expect(isEmptyResponse(true)).toBe(false);
			expect(isEmptyResponse('non-empty string')).toBe(false);
		});

		it('should return false for objects that are not response-like', () => {
			// Objects without id/object/model are considered valid (not response objects)
			expect(isEmptyResponse({ foo: 'bar' })).toBe(false);
			expect(isEmptyResponse({ data: [1, 2, 3] })).toBe(false);
		});
	});
});

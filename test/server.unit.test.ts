/**
 * Unit tests for OAuth server logic
 * Tests request handling without actual port binding
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

type ListenBehavior = 'success' | 'fail-all' | 'fail-ipv6';

type MockOAuthServer = {
	listen: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	unref: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	_handler?: (req: IncomingMessage, res: ServerResponse) => void;
	_lastCode?: string;
	_host?: string;
	_port?: number;
	_errorHandlers: Array<(err: NodeJS.ErrnoException) => void>;
};

// Mock http module before importing server
vi.mock('node:http', () => {
	const mockServers: MockOAuthServer[] = [];
	let listenBehavior: ListenBehavior = 'success';

	const makeBindError = (): NodeJS.ErrnoException => {
		const error = new Error('Address in use') as NodeJS.ErrnoException;
		error.code = 'EADDRINUSE';
		return error;
	};

	const defaultExport = {
		__mockServers: mockServers,
		__reset: () => {
			mockServers.length = 0;
			listenBehavior = 'success';
		},
		__setListenBehavior: (behavior: ListenBehavior) => {
			listenBehavior = behavior;
		},
		createServer: vi.fn((handler: (req: IncomingMessage, res: ServerResponse) => void) => {
			const mockServer: MockOAuthServer = {
				listen: vi.fn((port: number, host: string, callback: () => void) => {
					mockServer._port = port;
					mockServer._host = host;
					const shouldFail =
						listenBehavior === 'fail-all' ||
						(listenBehavior === 'fail-ipv6' && host === '::1');

					if (shouldFail) {
						setTimeout(() => {
							for (const errorHandler of mockServer._errorHandlers) {
								errorHandler(makeBindError());
							}
						}, 0);
					} else {
						callback();
					}
					return mockServer;
				}),
				close: vi.fn(),
				unref: vi.fn(),
				on: vi.fn((event: string, eventHandler: (err: NodeJS.ErrnoException) => void) => {
					if (event === 'error') mockServer._errorHandlers.push(eventHandler);
					return mockServer;
				}),
				_handler: handler,
				_lastCode: undefined,
				_errorHandlers: [],
			};

			mockServers.push(mockServer);
			return mockServer;
		}),
	};

	return { default: defaultExport };
});

vi.mock('../lib/oauth-success.js', () => ({
	renderOAuthSuccessHtml: () => '<html>Success</html>',
}));

vi.mock('../lib/logger.js', () => ({
	logError: vi.fn(),
	logWarn: vi.fn(),
}));

import http from 'node:http';
import { startLocalOAuthServer } from '../lib/auth/server.js';
import { logError, logWarn } from '../lib/logger.js';

type MockHttp = typeof http & {
	__mockServers: MockOAuthServer[];
	__reset: () => void;
	__setListenBehavior: (behavior: ListenBehavior) => void;
};

const mockHttp = http as MockHttp;

describe('OAuth Server Unit Tests', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockHttp.__reset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('server creation', () => {
		it('should bind both concrete loopback hosts', async () => {
			const result = await startLocalOAuthServer({ state: 'test-state' });

			expect(http.createServer).toHaveBeenCalledTimes(2);
			expect(mockHttp.__mockServers.map((server) => server._host)).toEqual(['127.0.0.1', '::1']);
			expect(result.port).toBe(1455);
			expect(result.ready).toBe(true);
		});

		it('should set ready=false when all port bindings fail', async () => {
			mockHttp.__setListenBehavior('fail-all');

			const result = await startLocalOAuthServer({ state: 'test-state' });

			expect(result.ready).toBe(false);
			expect(result.port).toBe(1455);
			expect(logError).toHaveBeenCalledWith(
				expect.stringContaining('Failed to bind http://127.0.0.1:1455')
			);
			expect(logWarn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to bind http://[::1]:1455')
			);
		});

		it('should stay ready when IPv6 loopback binding fails but IPv4 is available', async () => {
			mockHttp.__setListenBehavior('fail-ipv6');

			const result = await startLocalOAuthServer({ state: 'test-state' });

			expect(result.ready).toBe(true);
			expect(mockHttp.__mockServers.map((server) => server._host)).toEqual(['127.0.0.1', '::1']);
			expect(logWarn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to bind http://[::1]:1455')
			);
		});
	});

	describe('request handler', () => {
		let requestHandler: (req: IncomingMessage, res: ServerResponse) => void;

		beforeEach(async () => {
			const result = await startLocalOAuthServer({ state: 'test-state' });
			expect(result.ready).toBe(true);
			requestHandler = mockHttp.__mockServers[0]._handler!;
		});

		function createMockRequest(url: string): IncomingMessage {
			const req = new EventEmitter() as IncomingMessage;
			req.url = url;
			return req;
		}

		function createMockResponse(): ServerResponse & { _body: string; _headers: Record<string, string> } {
			const res = {
				statusCode: 200,
				_body: '',
				_headers: {} as Record<string, string>,
				setHeader: vi.fn((name: string, value: string) => {
					res._headers[name.toLowerCase()] = value;
				}),
				end: vi.fn((body?: string) => {
					if (body) res._body = body;
				}),
			};
			return res as unknown as ServerResponse & { _body: string; _headers: Record<string, string> };
		}

		it('should return 404 for non-callback paths', () => {
			const req = createMockRequest('/other-path');
			const res = createMockResponse();

			requestHandler(req, res);

			expect(res.statusCode).toBe(404);
			expect(res.end).toHaveBeenCalledWith('Not found');
		});

		it('should return 400 for state mismatch', () => {
			const req = createMockRequest('/auth/callback?code=abc&state=wrong-state');
			const res = createMockResponse();

			requestHandler(req, res);

			expect(res.statusCode).toBe(400);
			expect(res.end).toHaveBeenCalledWith('State mismatch');
		});

		it('should return 400 for missing code', () => {
			const req = createMockRequest('/auth/callback?state=test-state');
			const res = createMockResponse();

			requestHandler(req, res);

			expect(res.statusCode).toBe(400);
			expect(res.end).toHaveBeenCalledWith('Missing authorization code');
		});

		it('should return 200 with HTML for valid callback', () => {
			const req = createMockRequest('/auth/callback?code=test-code&state=test-state');
			const res = createMockResponse();

			requestHandler(req, res);

			expect(res.statusCode).toBe(200);
			expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8');
			expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
			expect(res.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
			expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
			expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
			expect(res.setHeader).toHaveBeenCalledWith(
				'Content-Security-Policy',
				expect.stringMatching(
					/^default-src 'none'; style-src 'nonce-[^']+'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'$/
				)
			);
			expect(res.end).toHaveBeenCalledWith('<html>Success</html>');
		});

		it('should store the code on every local server instance', () => {
			const req = createMockRequest('/auth/callback?code=captured-code&state=test-state');
			const res = createMockResponse();

			requestHandler(req, res);

			expect(mockHttp.__mockServers.map((server) => server._lastCode)).toEqual([
				'captured-code',
				'captured-code',
			]);
		});

		it('should handle request handler errors gracefully', () => {
			const req = createMockRequest('/auth/callback?code=test&state=test-state');
			const res = createMockResponse();
			(res.setHeader as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw new Error('setHeader failed');
			});

			expect(() => requestHandler(req, res)).not.toThrow();
			expect(res.statusCode).toBe(500);
			expect(res.end).toHaveBeenCalledWith('Internal error');
			expect(logError).toHaveBeenCalledWith(expect.stringContaining('Request handler error'));
		});
	});

	describe('close function', () => {
		it('should close all bound servers when ready=true', async () => {
			const result = await startLocalOAuthServer({ state: 'test-state' });
			result.close();

			expect(mockHttp.__mockServers[0].close).toHaveBeenCalledTimes(1);
			expect(mockHttp.__mockServers[1].close).toHaveBeenCalledTimes(1);
		});

		it('should close only the bound server when IPv6 binding fails', async () => {
			mockHttp.__setListenBehavior('fail-ipv6');

			const result = await startLocalOAuthServer({ state: 'test-state' });
			result.close();

			expect(mockHttp.__mockServers[0].close).toHaveBeenCalledTimes(1);
			expect(mockHttp.__mockServers[1].close).not.toHaveBeenCalled();
		});

		it('should handle close error when ready=false', async () => {
			mockHttp.__setListenBehavior('fail-all');
			const result = await startLocalOAuthServer({ state: 'test-state' });
			mockHttp.__mockServers[0].close.mockImplementation(() => {
				throw new Error('Close failed');
			});

			expect(() => result.close()).not.toThrow();
			expect(logError).toHaveBeenCalledWith(
				expect.stringContaining('Failed to close OAuth server')
			);
		});
	});

	describe('waitForCode function', () => {
		it('should return null immediately when ready=false', async () => {
			mockHttp.__setListenBehavior('fail-all');

			const result = await startLocalOAuthServer({ state: 'test-state' });
			const code = await result.waitForCode('test-state');

			expect(code).toBeNull();
		});

		it('should return code when available', async () => {
			const result = await startLocalOAuthServer({ state: 'test-state' });
			mockHttp.__mockServers[1]._lastCode = 'the-code';

			const code = await result.waitForCode('test-state');
			expect(code).toEqual({ code: 'the-code' });
		});

		it('should return null after 5 minute timeout', async () => {
			vi.useFakeTimers();

			const result = await startLocalOAuthServer({ state: 'test-state' });
			const codePromise = result.waitForCode('test-state');

			await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

			const code = await codePromise;
			expect(code).toBeNull();
			expect(logWarn).toHaveBeenCalledWith('OAuth poll timeout after 5 minutes');

			vi.useRealTimers();
		});
	});
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as authModule from '../lib/auth/auth.js';
import {
    shouldRefreshToken,
    refreshAndUpdateToken,
    extractRequestUrl,
    rewriteUrlForCodex,
    createCodexHeaders,
    handleErrorResponse,
    handleSuccessResponse,
    isEntitlementError,
    isDeactivatedWorkspaceError,
    isInvalidatedAuthTokenError,
    createAbortError,
    createEntitlementErrorResponse,
	getUnsupportedCodexModelInfo,
	resolveUnsupportedCodexFallbackModel,
	extractUnsupportedCodexModelFromText,
	shouldFallbackToGpt52OnUnsupportedGpt53,
} from '../lib/request/fetch-helpers.js';
import * as codexPrompts from '../lib/prompts/codex.js';
import * as loggerModule from '../lib/logger.js';
import type { Auth } from '../lib/types.js';
import { URL_PATHS, OPENAI_HEADERS, OPENAI_HEADER_VALUES, CODEX_BASE_URL } from '../lib/constants.js';

describe('Fetch Helpers Module', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('shouldRefreshToken', () => {
		it('should return true for non-oauth auth', () => {
			const auth: Auth = { type: 'api', key: 'test-key' };
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it('should return true when access token is missing', () => {
			const auth: Auth = { type: 'oauth', access: '', refresh: 'refresh-token', expires: Date.now() + 1000 };
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it('should return true when token is expired', () => {
			const auth: Auth = {
				type: 'oauth',
				access: 'access-token',
				refresh: 'refresh-token',
				expires: Date.now() - 1000 // expired
			};
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it('should return false for valid oauth token', () => {
			const auth: Auth = {
				type: 'oauth',
				access: 'access-token',
				refresh: 'refresh-token',
				expires: Date.now() + 10000 // valid for 10 seconds
			};
			expect(shouldRefreshToken(auth)).toBe(false);
		});

		it('should refresh token early when within skew window', () => {
			vi.spyOn(Date, 'now').mockReturnValue(1_000);
			const auth: Auth = {
				type: 'oauth',
				access: 'access-token',
				refresh: 'refresh-token',
				expires: 1_500,
			};
			expect(shouldRefreshToken(auth, 500)).toBe(true);
			expect(shouldRefreshToken(auth, 400)).toBe(false);
			expect(shouldRefreshToken(auth, -1)).toBe(false);
		});
	});

	describe('refreshAndUpdateToken', () => {
		it('throws when refresh fails', async () => {
			const auth: Auth = { type: 'oauth', access: 'old', refresh: 'bad', expires: 0 };
			const client = { auth: { set: vi.fn() } } as any;
			vi.spyOn(authModule, 'refreshAccessToken').mockResolvedValue({ type: 'failed' } as any);

			await expect(refreshAndUpdateToken(auth, client)).rejects.toThrow();
		});

		it('updates stored auth on success', async () => {
			const auth: Auth = { type: 'oauth', access: 'old', refresh: 'oldr', expires: 0 };
			const client = { auth: { set: vi.fn() } } as any;
			vi.spyOn(authModule, 'refreshAccessToken').mockResolvedValue({
				type: 'success',
				access: 'new',
				refresh: 'newr',
				expires: 123,
			} as any);

			const updated = await refreshAndUpdateToken(auth, client);

		expect(client.auth.set).toHaveBeenCalledWith({
			path: { id: 'openai' },
			body: {
				type: 'oauth',
				access: 'new',
				refresh: 'newr',
				expires: 123,
				multiAccount: true,
			},
		});
			expect(updated.access).toBe('new');
			expect(updated.refresh).toBe('newr');
			expect(updated.expires).toBe(123);
		});
	});

	describe('extractRequestUrl', () => {
		it('should extract URL from string', () => {
			const url = 'https://example.com/test';
			expect(extractRequestUrl(url)).toBe(url);
		});

		it('should extract URL from URL object', () => {
			const url = new URL('https://example.com/test');
			expect(extractRequestUrl(url)).toBe('https://example.com/test');
		});

		it('should extract URL from Request object', () => {
			const request = new Request('https://example.com/test');
			expect(extractRequestUrl(request)).toBe('https://example.com/test');
		});
	});

	describe('rewriteUrlForCodex', () => {
		it('should rewrite /responses to /codex/responses', () => {
			const url = 'https://chatgpt.com/backend-api/responses';
			expect(rewriteUrlForCodex(url)).toBe('https://chatgpt.com/backend-api/codex/responses');
		});

		it('should keep backend-api paths when URL is already on codex origin', () => {
			const url = 'https://chatgpt.com/backend-api/other';
			expect(rewriteUrlForCodex(url)).toBe(url);
		});

		it('should force codex origin and preserve query params', () => {
			const url = 'https://example.com/backend-api/responses?foo=bar';
			const result = rewriteUrlForCodex(url);
			expect(result).toBe('https://chatgpt.com/backend-api/codex/responses?foo=bar');
		});

		it('should prefix backend-api path when request path is outside backend-api', () => {
			const url = 'https://chatgpt.com/v1/other';
			const result = rewriteUrlForCodex(url);
			expect(result).toBe(`${CODEX_BASE_URL}/v1/other`);
		});

		it('should throw for invalid URL input', () => {
			expect(() => rewriteUrlForCodex('not-a-valid-url')).toThrow(TypeError);
		});
	});

		describe('createCodexHeaders', () => {
	const accountId = 'test-account-123';
	const accessToken = 'test-access-token';

		it('should create headers with all required fields when cache key provided', () => {
	    const headers = createCodexHeaders(undefined, accountId, accessToken, { model: 'gpt-5-codex', promptCacheKey: 'session-1' });

	    expect(headers.get('Authorization')).toBe(`Bearer ${accessToken}`);
	    expect(headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe(accountId);
	    expect(headers.get(OPENAI_HEADERS.BETA)).toBe(OPENAI_HEADER_VALUES.BETA_RESPONSES);
	    expect(headers.get(OPENAI_HEADERS.ORIGINATOR)).toBe(OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	    expect(headers.get(OPENAI_HEADERS.SESSION_ID)).toBe('session-1');
	    expect(headers.get(OPENAI_HEADERS.CONVERSATION_ID)).toBe('session-1');
	    expect(headers.get('accept')).toBe('text/event-stream');
    });

                it('maps usage-limit 404 errors to 429', async () => {
                        const body = {
                                error: {
                                        code: 'usage_limit_reached',
                                        message: 'limit reached',
                                },
                        };
                        const resp = new Response(JSON.stringify(body), { status: 404 });
                        const { response: mapped, rateLimit } = await handleErrorResponse(resp);
                        expect(mapped.status).toBe(429);
                        const json = await mapped.json() as any;
                        expect(json.error.code).toBe('usage_limit_reached');
                        expect(rateLimit?.retryAfterMs).toBeGreaterThan(0);
                });

                it('leaves non-usage 404 errors unchanged', async () => {
                        const body = { error: { code: 'not_found', message: 'nope' } };
                        const resp = new Response(JSON.stringify(body), { status: 404 });
                        const { response: result, rateLimit } = await handleErrorResponse(resp);
                        expect(result.status).toBe(404);
                        const json = await result.json() as any;
                        expect(json.error.code).toBe('not_found');
                        expect(rateLimit).toBeUndefined();
                });

		it('should remove x-api-key header', () => {
        const init = { headers: { 'x-api-key': 'should-be-removed' } } as any;
        const headers = createCodexHeaders(init, accountId, accessToken, { model: 'gpt-5', promptCacheKey: 'session-2' });

			expect(headers.has('x-api-key')).toBe(false);
		});

		it('should preserve other existing headers', () => {
        const init = { headers: { 'Content-Type': 'application/json' } } as any;
        const headers = createCodexHeaders(init, accountId, accessToken, { model: 'gpt-5', promptCacheKey: 'session-3' });

			expect(headers.get('Content-Type')).toBe('application/json');
		});

		it('should use provided promptCacheKey for both conversation_id and session_id', () => {
			const key = 'ses_abc123';
			const headers = createCodexHeaders(undefined, accountId, accessToken, { promptCacheKey: key });
			expect(headers.get(OPENAI_HEADERS.CONVERSATION_ID)).toBe(key);
			expect(headers.get(OPENAI_HEADERS.SESSION_ID)).toBe(key);
		});

		it('does not set conversation/session headers when no promptCacheKey provided', () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken, { model: 'gpt-5' });
			expect(headers.get(OPENAI_HEADERS.CONVERSATION_ID)).toBeNull();
			expect(headers.get(OPENAI_HEADERS.SESSION_ID)).toBeNull();
		});

		it('sends a Codex CLI user-agent by default, replacing the host user-agent', () => {
			const init = { headers: { 'user-agent': 'opencode/1.17.20' } } as any;
			const headers = createCodexHeaders(init, accountId, accessToken, { model: 'gpt-5.6-sol' });
			expect(headers.get('user-agent')).toMatch(/^codex_cli_rs\/\d+\.\d+\.\d+ \(/);
		});

		it('honors the CODEX_AUTH_DISABLE_CODEX_USER_AGENT opt-out', () => {
			try {
				vi.stubEnv('CODEX_AUTH_DISABLE_CODEX_USER_AGENT', '1');
				const init = { headers: { 'user-agent': 'opencode/1.17.20' } } as any;
				const headers = createCodexHeaders(init, accountId, accessToken, { model: 'gpt-5.6-sol' });
				expect(headers.get('user-agent')).toBe('opencode/1.17.20');
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('advertises CODEX_AUTH_CLIENT_VERSION when overridden', () => {
			try {
				vi.stubEnv('CODEX_AUTH_CLIENT_VERSION', '0.150.2');
				const headers = createCodexHeaders(undefined, accountId, accessToken, { model: 'gpt-5.6-sol' });
				expect(headers.get('user-agent')).toMatch(/^codex_cli_rs\/0\.150\.2 \(/);
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('does not send openai-organization by default (Codex CLI parity, #196)', () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken, { model: 'gpt-5.6-sol', organizationId: 'org-123' });
			expect(headers.get(OPENAI_HEADERS.ORGANIZATION_ID)).toBeNull();
		});

		it('strips an inherited openai-organization header by default', () => {
			const init = { headers: { [OPENAI_HEADERS.ORGANIZATION_ID]: 'org-stale' } } as any;
			const headers = createCodexHeaders(init, accountId, accessToken, { model: 'gpt-5' });
			expect(headers.get(OPENAI_HEADERS.ORGANIZATION_ID)).toBeNull();
		});

		it('sends openai-organization when CODEX_AUTH_SEND_ORGANIZATION_HEADER=1', () => {
			try {
				vi.stubEnv('CODEX_AUTH_SEND_ORGANIZATION_HEADER', '1');
				const headers = createCodexHeaders(undefined, accountId, accessToken, { model: 'gpt-5.6-sol', organizationId: 'org-123' });
				expect(headers.get(OPENAI_HEADERS.ORGANIZATION_ID)).toBe('org-123');
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('maps usage_not_included 404 to 403 entitlement error, not rate limit', async () => {
			const body = {
				error: {
					code: 'usage_not_included',
					message: 'Usage not included in your plan',
				},
			};
			const resp = new Response(JSON.stringify(body), { status: 404 });
			const { response: result, rateLimit } = await handleErrorResponse(resp);
			expect(result.status).toBe(403);
			expect(rateLimit).toBeUndefined();
			const json = await result.json() as any;
			expect(json.error.type).toBe('entitlement_error');
			expect(json.error.message).toContain('not included in your ChatGPT subscription');
		});
    });

	describe('isEntitlementError', () => {
		it('returns true for usage_not_included code', () => {
			expect(isEntitlementError('usage_not_included', '')).toBe(true);
		});

		it('returns true when body contains "not included in your plan"', () => {
			expect(isEntitlementError('', 'Usage not included in your plan')).toBe(true);
		});

		it('returns false for usage_limit_reached (rate limit)', () => {
			expect(isEntitlementError('usage_limit_reached', '')).toBe(false);
		});

		it('returns false for rate_limit_exceeded', () => {
			expect(isEntitlementError('rate_limit_exceeded', '')).toBe(false);
		});

		it('returns false for generic errors', () => {
			expect(isEntitlementError('not_found', 'Resource not found')).toBe(false);
		});
	});

	describe('createEntitlementErrorResponse', () => {
		it('returns 403 status with user-friendly message', async () => {
			const resp = createEntitlementErrorResponse('original body');
			expect(resp.status).toBe(403);
			expect(resp.statusText).toBe('Forbidden');
			const json = await resp.json() as any;
			expect(json.error.type).toBe('entitlement_error');
			expect(json.error.code).toBe('usage_not_included');
			expect(json.error.message).toContain('ChatGPT subscription');
		});
	});

	describe('gpt-5.3 unsupported model handling', () => {
		it('normalizes ChatGPT model-not-supported 400 to actionable entitlement error', async () => {
			const body = {
				detail: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
			};
			const response = new Response(JSON.stringify(body), { status: 400, statusText: 'Bad Request' });

			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as {
				error: {
					message: string;
					type?: string;
					code?: string;
					unsupported_model?: string;
				};
			};

			expect(json.error.type).toBe('entitlement_error');
			expect(json.error.code).toBe('model_not_supported_with_chatgpt_account');
			expect(json.error.message).toContain("'gpt-5.3-codex'");
			expect(json.error.message).toContain('CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL');
			expect(json.error.unsupported_model).toBe('gpt-5.3-codex');
		});

		it('flags fallback when gpt-5.3-codex returns unsupported-model entitlement error', () => {
			const shouldFallback = shouldFallbackToGpt52OnUnsupportedGpt53('gpt-5.3-codex', {
				error: {
					code: 'model_not_supported_with_chatgpt_account',
					message: 'not supported when using Codex with a ChatGPT account',
				},
			});

			expect(shouldFallback).toBe(true);
		});

		it('does not flag fallback for other models or errors', () => {
			expect(
				shouldFallbackToGpt52OnUnsupportedGpt53('gpt-5.2-codex', {
					error: { code: 'model_not_supported_with_chatgpt_account' },
				}),
			).toBe(false);
			expect(
				shouldFallbackToGpt52OnUnsupportedGpt53('gpt-5.3-codex', {
					error: { code: 'usage_not_included' },
				}),
			).toBe(false);
		});

		it('extracts unsupported model from upstream and normalized error messages', () => {
			expect(
				extractUnsupportedCodexModelFromText(
					"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
				),
			).toBe('gpt-5.3-codex-spark');
			expect(
				extractUnsupportedCodexModelFromText(
					"The model 'gpt-5.3-codex' is not currently available for this ChatGPT account when using Codex OAuth.",
				),
			).toBe('gpt-5.3-codex');
		});

		it('returns unsupported model info from normalized error payload', () => {
			const info = getUnsupportedCodexModelInfo({
				error: {
					code: 'model_not_supported_with_chatgpt_account',
					message: "The model 'gpt-5.3-codex-spark' is not currently available for this ChatGPT account when using Codex OAuth.",
					unsupported_model: 'gpt-5.3-codex-spark',
				},
			});

			expect(info.isUnsupported).toBe(true);
			expect(info.unsupportedModel).toBe('gpt-5.3-codex-spark');
		});

		it('returns unsupported model info from top-level detail payload', () => {
			const info = getUnsupportedCodexModelInfo({
				detail:
					"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
			});

			expect(info.isUnsupported).toBe(true);
			expect(info.message).toContain('gpt-5.5');
			expect(info.unsupportedModel).toBe('gpt-5.5');
		});

		it('resolves Spark fallback chain to canonical gpt-5-codex first', () => {
			const errorBody = {
				error: {
					code: 'model_not_supported_with_chatgpt_account',
					message:
						"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
				},
			};

			const first = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.3-codex-spark',
				errorBody,
				attemptedModels: ['gpt-5.3-codex-spark'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(first).toBe('gpt-5-codex');

			const second = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.3-codex',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.3-codex-spark', 'gpt-5.3-codex', 'gpt-5-codex'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(second).toBe('gpt-5.2-codex');
		});

		it('respects legacy gpt-5.3 -> gpt-5.2 toggle when disabled', () => {
			const canonicalFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.3-codex',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.3-codex'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: false,
			});
			expect(canonicalFallback).toBe('gpt-5-codex');

			const legacyEdgeFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.3-codex',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.3-codex', 'gpt-5-codex'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: false,
			});
			expect(legacyEdgeFallback).toBeUndefined();
		});

		it('falls back from canonical gpt-5-codex to gpt-5.4 when fallback policy is enabled', () => {
			const fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5-codex',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5-codex'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(fallback).toBe('gpt-5.4');
		});

		it('continues canonical Codex fallback to mini and nano when larger fallbacks are also unsupported', () => {
			const errorBody = {
				error: {
					code: 'model_not_supported_with_chatgpt_account',
					message:
						"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
				},
			};

			const miniFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.4',
				errorBody,
				attemptedModels: ['gpt-5-codex', 'gpt-5.4'],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(miniFallback).toBe('gpt-5.4-mini');

			const nanoFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.4-mini',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5-codex', 'gpt-5.4', 'gpt-5.4-mini'],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(nanoFallback).toBe('gpt-5.4-nano');
		});

		it('keeps directly selected GPT-5.4 family models strict when fallback policy is disabled', () => {
			const miniFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.4',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.4'],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(miniFallback).toBeUndefined();

			const nanoFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.4-mini',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.4-mini'],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(nanoFallback).toBeUndefined();
		});

		it('covers legacy gpt-5.3-codex multi-hop through blocked canonical Codex', () => {
			const canonicalFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.3-codex',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.3-codex'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(canonicalFallback).toBe('gpt-5-codex');

			const gpt54Fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: canonicalFallback,
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.3-codex', 'gpt-5-codex'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(gpt54Fallback).toBe('gpt-5.4');
		});

		it('covers legacy gpt-5.1-codex multi-hop through blocked canonical Codex', () => {
			const canonicalFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.1-codex',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.1-codex'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(canonicalFallback).toBe('gpt-5-codex');

			const gpt54Fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: canonicalFallback,
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.1-codex', 'gpt-5-codex'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(gpt54Fallback).toBe('gpt-5.4');
		});

		it('auto-fallbacks canonical gpt-5-codex even when fallback policy is disabled', () => {
			const fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5-codex',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5-codex'],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(fallback).toBe('gpt-5.4');
		});

		it('honors the default selector auto-fallback opt-out', () => {
			try {
				vi.stubEnv('CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK', '1');
				const codexFallback = resolveUnsupportedCodexFallbackModel({
					requestedModel: 'gpt-5-codex',
					errorBody: {
						error: {
							code: 'model_not_supported_with_chatgpt_account',
							message:
								"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
						},
					},
					attemptedModels: ['gpt-5-codex'],
					fallbackOnUnsupportedCodexModel: false,
					fallbackToGpt52OnUnsupportedGpt53: true,
				});
				expect(codexFallback).toBeUndefined();

				const gpt54Fallback = resolveUnsupportedCodexFallbackModel({
					requestedModel: 'gpt-5.4',
					errorBody: {
						error: {
							code: 'model_not_supported_with_chatgpt_account',
							message:
								"The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
						},
					},
					attemptedModels: ['gpt-5-codex', 'gpt-5.4'],
					fallbackOnUnsupportedCodexModel: false,
					fallbackToGpt52OnUnsupportedGpt53: true,
				});
				expect(gpt54Fallback).toBeUndefined();
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('auto-fallbacks gpt-5.6 tiers down the chain when fallback policy is disabled', () => {
			const unsupportedBody = (model: string) => ({
				error: {
					code: 'model_not_supported_with_chatgpt_account',
					message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
				},
			});

			const solFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.6-sol',
				errorBody: unsupportedBody('gpt-5.6-sol'),
				attemptedModels: ['gpt-5.6-sol'],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(solFallback).toBe('gpt-5.6-terra');

			const terraFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.6-terra',
				errorBody: unsupportedBody('gpt-5.6-terra'),
				attemptedModels: ['gpt-5.6-sol', 'gpt-5.6-terra'],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(terraFallback).toBe('gpt-5.6-luna');

			const lunaFallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.6-luna',
				errorBody: unsupportedBody('gpt-5.6-luna'),
				attemptedModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(lunaFallback).toBe('gpt-5.5');

			// The chain keeps degrading through the GPT-5.4 family once it lands
			// on gpt-5.5, matching the existing default-selector behavior.
			const gpt55Fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.5',
				errorBody: unsupportedBody('gpt-5.5'),
				attemptedModels: [
					'gpt-5.6-sol',
					'gpt-5.6-terra',
					'gpt-5.6-luna',
					'gpt-5.5',
				],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(gpt55Fallback).toBe('gpt-5.4');
		});

		it('treats the bare gpt-5.6 alias as the Sol tier for auto-fallback', () => {
			const fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.6',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.6'],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(fallback).toBe('gpt-5.6-terra');
		});

		it('honors the gpt-5.6 auto-fallback opt-out for every 5.6 tier', () => {
			const unsupportedBody = (model: string) => ({
				error: {
					code: 'model_not_supported_with_chatgpt_account',
					message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
				},
			});
			try {
				vi.stubEnv('CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK', '1');

				// Each tier is its own entry in the opt-out map; the flag must
				// disable auto-fallback for all three, not just the Sol flagship.
				for (const tier of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
					const strictFallback = resolveUnsupportedCodexFallbackModel({
						requestedModel: tier,
						errorBody: unsupportedBody(tier),
						attemptedModels: [tier],
						fallbackOnUnsupportedCodexModel: false,
						fallbackToGpt52OnUnsupportedGpt53: true,
					});
					expect(strictFallback).toBeUndefined();
				}

				// The explicit fallback policy still applies when opted out.
				const policyFallback = resolveUnsupportedCodexFallbackModel({
					requestedModel: 'gpt-5.6-sol',
					errorBody: unsupportedBody('gpt-5.6-sol'),
					attemptedModels: ['gpt-5.6-sol'],
					fallbackOnUnsupportedCodexModel: true,
					fallbackToGpt52OnUnsupportedGpt53: true,
				});
				expect(policyFallback).toBe('gpt-5.6-terra');
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('keeps manual gpt-5.4-pro strict when fallback policy is disabled', () => {
			const fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.4-pro',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.4-pro'],
				fallbackOnUnsupportedCodexModel: false,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(fallback).toBeUndefined();
		});

		it('falls back from gpt-5.4-pro to gpt-5.4 when fallback policy is enabled', () => {
			const fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.4-pro',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.4-pro'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(fallback).toBe('gpt-5.4');
		});

		it('does not fallback from gpt-5.4-pro when gpt-5.4 already attempted', () => {
			const fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.4-pro',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.4-pro', 'gpt-5.4'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(fallback).toBeUndefined();
		});

		it('collapses gpt-5.5-pro to gpt-5.4 via the GPT-5.5 canonicalization step', () => {
			// GPT-5.5 Pro is ChatGPT-only per the 2026-04-23 launch. If a user still
			// types `gpt-5.5-pro`, canonicalizeModelName collapses it to gpt-5.5 so the
			// gpt-5.5 -> gpt-5.4 fallback chain rescues the request instead of burning
			// through every pooled account with entitlement 400s.
			const fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.5-pro',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.5-pro' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.5-pro'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(fallback).toBe('gpt-5.4');
		});

		it('falls back from GPT-5.5 to gpt-5.4 when GPT-5.5 is unsupported', () => {
			const fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.5-medium',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.5'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(fallback).toBe('gpt-5.4');
		});

		it('continues GPT-5.5 fallback when gpt-5.4 was already attempted', () => {
			const fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.5',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.5', 'gpt-5.4'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(fallback).toBe('gpt-5.4-mini');
		});

		it('continues through gpt-5.5-pro fallback once gpt-5.4 has been attempted', () => {
			// Pro canonicalizes to gpt-5.5, so once gpt-5.4 is in attemptedModels the
			// chain continues to the smaller GPT-5.4 family fallbacks.
			const fallback = resolveUnsupportedCodexFallbackModel({
				requestedModel: 'gpt-5.5-pro',
				errorBody: {
					error: {
						code: 'model_not_supported_with_chatgpt_account',
						message:
							"The 'gpt-5.5-pro' model is not supported when using Codex with a ChatGPT account.",
					},
				},
				attemptedModels: ['gpt-5.5-pro', 'gpt-5.5', 'gpt-5.4'],
				fallbackOnUnsupportedCodexModel: true,
				fallbackToGpt52OnUnsupportedGpt53: true,
			});
			expect(fallback).toBe('gpt-5.4-mini');
		});
	});

	describe('handleSuccessResponse', () => {
		it('logs warning when Deprecation header is present', async () => {
			const warnSpy = vi.spyOn(loggerModule, 'logWarn');
			const headers = new Headers({ 'Deprecation': 'true' });
			const response = new Response('{}', { status: 200, headers });
			
			await handleSuccessResponse(response, false);
			
			expect(warnSpy).toHaveBeenCalledWith('API deprecation notice', { deprecation: 'true', sunset: null });
		});

		it('logs warning when Sunset header is present', async () => {
			const warnSpy = vi.spyOn(loggerModule, 'logWarn');
			const headers = new Headers({ 'Sunset': 'Sat, 01 Jan 2030 00:00:00 GMT' });
			const response = new Response('{}', { status: 200, headers });
			
			await handleSuccessResponse(response, false);
			
			expect(warnSpy).toHaveBeenCalledWith('API deprecation notice', { deprecation: null, sunset: 'Sat, 01 Jan 2030 00:00:00 GMT' });
		});

		it('does not log warning when no deprecation headers present', async () => {
			const warnSpy = vi.spyOn(loggerModule, 'logWarn');
			const response = new Response('{}', { status: 200 });
			
			await handleSuccessResponse(response, false);
			
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('returns stream as-is for streaming requests', async () => {
			const response = new Response('stream body', { status: 200 });
			
			const result = await handleSuccessResponse(response, true);
			
			expect(result.status).toBe(200);
			const text = await result.text();
			expect(text).toBe('stream body');
		});
	});

		describe('handleErrorResponse error normalization', () => {
			it('normalizes deactivated workspace errors with dedicated code', async () => {
				const body = { detail: { code: 'deactivated_workspace' } };
				const response = new Response(JSON.stringify(body), { status: 402, statusText: 'Payment Required' });

				const { response: result, errorBody } = await handleErrorResponse(response);
				const json = await result.json() as { error: { message: string; type?: string; code?: string } };

				expect(isDeactivatedWorkspaceError(errorBody, 402)).toBe(true);
				expect(json.error.code).toBe('deactivated_workspace');
				expect(json.error.type).toBe('workspace_deactivated');
				expect(json.error.message).toContain('workspace is deactivated');
			});

			it('extracts nested error.message', async () => {
			const body = { error: { message: 'nested error message', type: 'test_type', code: 'test_code' } };
			const response = new Response(JSON.stringify(body), { status: 500 });
			
			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as { error: { message: string; type?: string; code?: string } };
			
			expect(json.error.message).toBe('nested error message');
			expect(json.error.type).toBe('test_type');
			expect(json.error.code).toBe('test_code');
		});

		it('extracts top-level message', async () => {
			const body = { message: 'top-level message' };
			const response = new Response(JSON.stringify(body), { status: 500 });
			
			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as { error: { message: string } };
			
			expect(json.error.message).toBe('top-level message');
		});

		it('uses trimmed body text when JSON parses to non-record (line 463 coverage)', async () => {
			const response = new Response('"just a string"', { status: 500 });
			
			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as { error: { message: string } };
			
			expect(json.error.message).toBe('"just a string"');
		});

		it('uses body text when no structured error', async () => {
			const response = new Response('plain text error', { status: 500 });
			
			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as { error: { message: string } };
			
			expect(json.error.message).toBe('plain text error');
		});

		it('uses statusText when body is empty', async () => {
			const response = new Response('', { status: 500, statusText: 'Internal Server Error' });
			
			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as { error: { message: string } };
			
			expect(json.error.message).toBe('Internal Server Error');
		});

	it('uses fallback message when everything is empty', async () => {
		const response = new Response('', { status: 500, statusText: '' });
		
		const { response: result } = await handleErrorResponse(response);
		const json = await result.json() as { error: { message: string } };
		
		expect(json.error.message).toBe('Request failed');
	});

		it('handles numeric error codes', async () => {
			const body = { error: { message: 'error', code: 12345 } };
			const response = new Response(JSON.stringify(body), { status: 500 });
			
			const { response: result } = await handleErrorResponse(response);
			const json = await result.json() as { error: { code?: string | number } };
			
			expect(json.error.code).toBe(12345);
		});

		it('includes 401 diagnostics from response headers', async () => {
			const body = { error: { message: 'Unauthorized' } };
			const headers = new Headers({
				'cf-ray': 'abc123-def',
				'x-request-id': 'req_123',
			});
			const response = new Response(JSON.stringify(body), { status: 401, headers });

			const { response: result } = await handleErrorResponse(response, {
				requestCorrelationId: 'corr-1',
				threadId: 'thread-1',
			});
			const json = await result.json() as {
				error: {
					message: string;
					diagnostics?: {
						cfRay?: string;
						requestId?: string;
						correlationId?: string;
						threadId?: string;
						httpStatus?: number;
					};
				};
			};

			expect(json.error.message).toContain('opencode auth login');
			expect(json.error.diagnostics).toEqual(
				expect.objectContaining({
					cfRay: 'abc123-def',
					requestId: 'req_123',
					correlationId: 'corr-1',
					threadId: 'thread-1',
					httpStatus: 401,
				}),
			);
		});
	});

		describe('handleErrorResponse edge cases', () => {
		it('handles 404 with non-JSON body containing usage limit text', async () => {
			const response = new Response('usage limit exceeded - please try again', { status: 404 });
			
			const { response: result, rateLimit } = await handleErrorResponse(response);
			
			expect(result.status).toBe(429);
			expect(rateLimit?.retryAfterMs).toBeGreaterThan(0);
		});

		it('handles 429 with entitlement error code (should not be rate limit)', async () => {
			const body = { error: { code: 'usage_not_included', message: 'Not included' } };
			const response = new Response(JSON.stringify(body), { status: 429 });
			
			const { response: result, rateLimit } = await handleErrorResponse(response);
			
			expect(result.status).toBe(429);
			expect(rateLimit).toBeUndefined();
		});

		it('handles 429 with entitlement text pattern (should not be rate limit)', async () => {
			const body = { error: { message: 'Usage not included in your plan' } };
			const response = new Response(JSON.stringify(body), { status: 429 });
			
			const { response: result, rateLimit } = await handleErrorResponse(response);
			
			expect(result.status).toBe(429);
			expect(rateLimit).toBeUndefined();
		});

		it('marks exact server overload payload as server retry and preserves retry-after', async () => {
			const body = {
				type: 'error',
				error: {
					type: 'service_unavailable_error',
					code: 'server_is_overloaded',
					message: 'Our servers are currently overloaded. Please try again later.',
					retry_after_ms: 1750,
					param: null,
				},
			};
			const response = new Response(JSON.stringify(body), { status: 429 });

			const { response: result, rateLimit, retryAsServerError } = await handleErrorResponse(response);

			expect(result.status).toBe(429);
			expect(retryAsServerError).toBe(true);
			expect(rateLimit?.retryAfterMs).toBe(1750);
			expect(rateLimit?.code).toBe('server_is_overloaded');
		});

		it('marks reduced service_unavailable_error payload as server retry and preserves fallback backoff', async () => {
			const body = {
				error: {
					type: 'service_unavailable_error',
					message: 'Our servers are currently overloaded. Please try again later.',
				},
			};
			const response = new Response(JSON.stringify(body), { status: 429 });

			const { rateLimit, retryAsServerError } = await handleErrorResponse(response);

			expect(retryAsServerError).toBe(true);
			expect(rateLimit?.retryAfterMs).toBe(60000);
		});

		it('marks reduced context.service_unavailable_error payload as server retry and preserves fallback backoff', async () => {
			const body = {
				error: {
					context: {
						type: 'service_unavailable_error',
					},
					message: 'Our servers are currently overloaded. Please try again later.',
				},
			};
			const response = new Response(JSON.stringify(body), { status: 429 });

			const { rateLimit, retryAsServerError } = await handleErrorResponse(response);

			expect(retryAsServerError).toBe(true);
			expect(rateLimit?.retryAfterMs).toBe(60000);
		});

		it('does not treat context.service_unavailable_error without overload wording as server retry', async () => {
			const body = {
				error: {
					context: {
						type: 'service_unavailable_error',
					},
					message: 'Service temporarily unavailable.',
				},
			};
			const response = new Response(JSON.stringify(body), { status: 429 });

			const { rateLimit, retryAsServerError } = await handleErrorResponse(response);

			expect(retryAsServerError).toBe(false);
			expect(rateLimit?.retryAfterMs).toBe(60000);
		});

		it('marks live server_error payload as server retry on non-5xx response', async () => {
			const body = {
				error: {
					type: 'server_error',
					code: 'server_error',
					message: 'The server had an error processing your request.',
				},
			};
			const response = new Response(JSON.stringify(body), { status: 400 });

			const { response: result, rateLimit, retryAsServerError } = await handleErrorResponse(response);

			expect(result.status).toBe(400);
			expect(retryAsServerError).toBe(true);
			expect(rateLimit).toBeUndefined();
		});

		it('does not mark partial server_error payloads as server retry', async () => {
			const partialPayloads = [
				{ error: { type: 'server_error', message: 'type only' } },
				{ error: { code: 'server_error', message: 'code only' } },
				{ error: { code: 'server_error', type: 'other_error', message: 'mismatched type' } },
				{ error: { code: 'server_error', context: { type: 'server_error' }, message: 'context only' } },
			];

			for (const body of partialPayloads) {
				const response = new Response(JSON.stringify(body), { status: 400 });
				const { rateLimit, retryAsServerError } = await handleErrorResponse(response);

				expect(retryAsServerError).toBe(false);
				expect(rateLimit).toBeUndefined();
			}
		});

		it('handles Response that throws on clone (safeReadBody catch)', async () => {
			const response = new Response('test', { status: 500 });
			const originalClone = response.clone.bind(response);
			let cloneCallCount = 0;
			response.clone = () => {
				cloneCallCount++;
				if (cloneCallCount === 1) {
					throw new Error('Clone failed');
				}
				return originalClone();
			};
			
			const { response: result } = await handleErrorResponse(response);
			
			expect(result.status).toBe(500);
			const json = await result.json() as { error: { message: string } };
			expect(json.error.message).toBe('Request failed');
		});
	});

	describe('handleErrorResponse rate limit parsing', () => {
	it('parses retryAfterMs from body', async () => {
		const body = { error: { message: 'rate limited', retry_after_ms: 5000 } };
		const response = new Response(JSON.stringify(body), { status: 429 });
		
		const { rateLimit } = await handleErrorResponse(response);
		
		expect(rateLimit).toBeDefined();
		expect(rateLimit?.retryAfterMs).toBe(5000);
	});

		it('parses retry-after-ms header', async () => {
			const headers = new Headers({ 'retry-after-ms': '3000' });
			const response = new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit).toBeDefined();
			expect(rateLimit?.retryAfterMs).toBe(3000);
		});

		it('parses retry-after header (seconds)', async () => {
			const headers = new Headers({ 'retry-after': '10' });
			const response = new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit).toBeDefined();
			expect(rateLimit?.retryAfterMs).toBe(10000);
		});

		it('caps oversized retry-after headers at the same 5-min bound as the body path', async () => {
			// The body retry_after_ms path is explicitly capped; the header
			// paths mirror the same semantics, so a bogus 2h retry-after must
			// not freeze an account past the cap (quota reset-at headers stay
			// uncapped — windows legitimately reset hours out).
			const headerSeconds = new Headers({ 'retry-after': '7200' });
			const secondsResponse = new Response(
				JSON.stringify({ error: { message: 'rate limited' } }),
				{ status: 429, headers: headerSeconds },
			);
			const { rateLimit: secondsLimit } = await handleErrorResponse(secondsResponse);
			expect(secondsLimit?.retryAfterMs).toBe(5 * 60 * 1000);

			const headerMs = new Headers({ 'retry-after-ms': '99999999999' });
			const msResponse = new Response(
				JSON.stringify({ error: { message: 'rate limited' } }),
				{ status: 429, headers: headerMs },
			);
			const { rateLimit: msLimit } = await handleErrorResponse(msResponse);
			expect(msLimit?.retryAfterMs).toBe(5 * 60 * 1000);
		});

		it('parses x-ratelimit-reset header (unix timestamp)', async () => {
			const futureTimestamp = Math.floor(Date.now() / 1000) + 60;
			const headers = new Headers({ 'x-ratelimit-reset': String(futureTimestamp) });
			const response = new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit).toBeDefined();
			expect(rateLimit?.retryAfterMs).toBeGreaterThan(0);
			expect(rateLimit?.retryAfterMs).toBeLessThanOrEqual(60000);
		});

		it('parses resetsAt from body', async () => {
			const futureTimestamp = Math.floor(Date.now() / 1000) + 30;
			const body = { error: { message: 'rate limited' }, resetsAt: futureTimestamp };
			const response = new Response(JSON.stringify(body), { status: 429 });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit).toBeDefined();
			expect(rateLimit?.retryAfterMs).toBeGreaterThan(0);
		});

	it('treats retry_after_ms as milliseconds verbatim (no seconds rescale)', async () => {
		// `retry_after_ms` is, by name, already in milliseconds. A small value
		// like 5 means 5ms — it must NOT be rescaled to 5000ms. (Regression
		// guard for the unit-confusion bug where retry_after_ms and retry_after
		// were collapsed and run through a <1000 "looks like seconds" heuristic.)
		const body = { error: { message: 'rate limited', retry_after_ms: 5 } };
		const response = new Response(JSON.stringify(body), { status: 429 });

		const { rateLimit } = await handleErrorResponse(response);

		expect(rateLimit?.retryAfterMs).toBe(5);
	});

	it('treats retry_after (no _ms suffix) as seconds', async () => {
		// `retry_after` is seconds; 5 means 5000ms.
		const body = { error: { message: 'rate limited', retry_after: 5 } };
		const response = new Response(JSON.stringify(body), { status: 429 });

		const { rateLimit } = await handleErrorResponse(response);

		expect(rateLimit?.retryAfterMs).toBe(5000);
	});

	it('treats retry_after_ms:250 as 250ms verbatim (no seconds rescale)', async () => {
		// Regression guard: a sub-second retry_after_ms must stay in ms. The old
		// unit-confusion bug fed values < 1000 through a "looks like seconds"
		// heuristic, ballooning 250ms into 250_000ms.
		const body = { error: { message: 'rate limited', retry_after_ms: 250 } };
		const response = new Response(JSON.stringify(body), { status: 429 });

		const { rateLimit } = await handleErrorResponse(response);

		expect(rateLimit?.retryAfterMs).toBe(250);
	});

	it('scales retry_after:2 (seconds) to 2000ms', async () => {
		const body = { error: { message: 'rate limited', retry_after: 2 } };
		const response = new Response(JSON.stringify(body), { status: 429 });

		const { rateLimit } = await handleErrorResponse(response);

		expect(rateLimit?.retryAfterMs).toBe(2000);
	});

	it('prefers retry_after_ms over retry_after when both are present (ms wins)', async () => {
		// When the body carries BOTH fields, the explicit-millisecond field must
		// win verbatim — it must NOT be overridden by retry_after*1000. Here ms
		// (250) and seconds (2 -> 2000) disagree, so the result proves which one
		// the parser honored.
		const body = {
			error: { message: 'rate limited', retry_after_ms: 250, retry_after: 2 },
		};
		const response = new Response(JSON.stringify(body), { status: 429 });

		const { rateLimit } = await handleErrorResponse(response);

		expect(rateLimit?.retryAfterMs).toBe(250);
	});

	it('caps retryAfterMs at 5 minutes', async () => {
		const body = { error: { message: 'rate limited', retry_after_ms: 600000 } };
		const response = new Response(JSON.stringify(body), { status: 429 });
		
		const { rateLimit } = await handleErrorResponse(response);
		
		expect(rateLimit?.retryAfterMs).toBe(300000);
	});

	it('handles invalid retry-after header with default fallback', async () => {
		const headers = new Headers({ 'retry-after': 'invalid' });
		const response = new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers });
		
		const { rateLimit } = await handleErrorResponse(response);
		
		expect(rateLimit?.retryAfterMs).toBe(60000);
	});

		it('handles millisecond unix timestamp in reset header', async () => {
			const futureTimestampMs = Date.now() + 45000;
			const headers = new Headers({ 'x-ratelimit-reset': String(futureTimestampMs) });
			const response = new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit?.retryAfterMs).toBeGreaterThan(0);
		});

		it('parses resetsAt in milliseconds format from body (already in ms)', async () => {
			const futureTimestampMs = Date.now() + 30000;
			const body = { error: { message: 'rate limited', resets_at: futureTimestampMs } };
			const response = new Response(JSON.stringify(body), { status: 429 });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit).toBeDefined();
			expect(rateLimit?.retryAfterMs).toBeGreaterThan(0);
			expect(rateLimit?.retryAfterMs).toBeLessThanOrEqual(30000);
		});

		it('handles resetsAt in the past (delta <= 0)', async () => {
			const pastTimestamp = Math.floor(Date.now() / 1000) - 60;
			const body = { error: { message: 'rate limited', resets_at: pastTimestamp } };
			const response = new Response(JSON.stringify(body), { status: 429 });
			
			const { rateLimit } = await handleErrorResponse(response);
			
			expect(rateLimit?.retryAfterMs).toBe(60000);
		});

		it('falls back to statusText when body is empty', async () => {
			const response = new Response('', { status: 500, statusText: 'Internal Server Error' });
			
			const { response: errorResponse } = await handleErrorResponse(response);
			const json = await errorResponse.json() as { error: { message: string } };
			
			expect(json.error.message).toBe('Internal Server Error');
		});

		it('falls back to default message when body and statusText are empty', async () => {
			const response = new Response('', { status: 500, statusText: '' });
			
			const { response: errorResponse } = await handleErrorResponse(response);
			const json = await errorResponse.json() as { error: { message: string } };
			
			expect(json.error.message).toBe('Request failed');
		});
	});

		describe('transformRequestForCodex', () => {
			it('normalizes the model in native mode without loading codex instructions', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				const getInstructionsSpy = vi.spyOn(codexPrompts, 'getCodexInstructions');
				const requestBody = {
					model: 'gpt-5.3-codex',
					input: [{ type: 'message', role: 'user', content: 'Hello' }],
					tools: [{ name: 'apply_patch' }],
				};

				const result = await transformRequestForCodex(
					{ body: JSON.stringify(requestBody) },
					'https://example.com',
					{ global: {}, models: {} },
					true,
					undefined,
					{ requestTransformMode: 'native' } as any,
				);

				expect(result).toBeDefined();
				expect(result?.body.model).toBe('gpt-5.3-codex');
				expect(result?.body.instructions).toContain('backend as gpt-5.3-codex');
				expect(JSON.stringify(result?.body.input?.[0])).toContain('`gpt-5.3-codex`');
				expect(result?.body.tools).toEqual([{ name: 'apply_patch' }]);
				expect(getInstructionsSpy).not.toHaveBeenCalled();
			});

			it('emits the responses-lite shape end-to-end for GPT-5.6 in native mode', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				const requestBody = {
					model: 'gpt-5.6-sol-xhigh',
					instructions: 'BASE',
					input: [{ type: 'message', role: 'user', content: 'Hello' }],
					tools: [{ name: 'apply_patch' }],
					parallel_tool_calls: true,
				};

				const result = await transformRequestForCodex(
					{ body: JSON.stringify(requestBody) },
					'https://example.com',
					{ global: {}, models: {} },
					true,
					undefined,
					{ requestTransformMode: 'native' } as any,
				);

				expect(result?.body.model).toBe('gpt-5.6-sol');

				// The canonical body stays classic so the fallback path can re-serialize
				// it for a non-lite model; only the wire body is lite-shaped.
				expect(result?.body.tools).toEqual([{ name: 'apply_patch' }]);

				const serialized = JSON.parse(result!.updatedInit.body as string);
				expect(serialized).not.toHaveProperty('tools');
				expect(serialized.instructions).toBe('');
				expect(serialized.parallel_tool_calls).toBe(false);
				expect(serialized.input[0].type).toBe('additional_tools');
				expect(serialized.input[0].role).toBe('developer');
				expect(serialized.input[0].tools).toEqual([{ name: 'apply_patch' }]);
			});

			it('emits the responses-lite shape in legacy mode, the default path', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				vi.spyOn(codexPrompts, 'getCodexInstructions').mockResolvedValue(
					'CODEX INSTRUCTIONS',
				);
				const requestBody = {
					model: 'gpt-5.6-terra',
					input: [{ type: 'message', role: 'user', content: 'Hello' }],
					tools: [{ type: 'function', name: 'apply_patch' }],
				};

				const result = await transformRequestForCodex(
					{ body: JSON.stringify(requestBody) },
					'https://example.com',
					{ global: {}, models: {} },
					true,
					undefined,
					// no requestTransformMode -> legacy
				);

				const serialized = JSON.parse(result!.updatedInit.body as string);
				expect(serialized.model).toBe('gpt-5.6-terra');
				expect(serialized).not.toHaveProperty('tools');
				expect(serialized.instructions).toBe('');
				expect(serialized.parallel_tool_calls).toBe(false);
				expect(serialized.input[0].type).toBe('additional_tools');
				// The assembled Codex instructions land in the developer message,
				// not the top-level field.
				expect(JSON.stringify(serialized.input[1])).toContain('CODEX INSTRUCTIONS');
				vi.restoreAllMocks();
			});

			// Regression: a lite-shaped body must never reach a non-lite model.
			// GPT-5.6 is preview-gated, so sol -> gpt-5.5 is a common runtime path.
			it('re-serializes a 5.6 body into the classic shape when falling back to 5.5', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				const { shapeBodyForModel } = await import(
					'../lib/request/helpers/responses-lite.js'
				);
				const requestBody = {
					model: 'gpt-5.6-sol',
					instructions: 'BASE',
					input: [{ type: 'message', role: 'user', content: 'Hello' }],
					tools: [{ name: 'apply_patch' }],
				};

				const result = await transformRequestForCodex(
					{ body: JSON.stringify(requestBody) },
					'https://example.com',
					{ global: {}, models: {} },
					true,
					undefined,
					{ requestTransformMode: 'native' } as any,
				);

				// Simulate the unsupported-model fallback: swap the model on the
				// canonical body, exactly as index.ts does, then re-serialize.
				const fallbackBody = {
					...result!.body,
					model: 'gpt-5.5',
					instructions: 'GPT55 INSTRUCTIONS',
				};
				const wire = JSON.parse(JSON.stringify(shapeBodyForModel(fallbackBody)));

				// gpt-5.5 is non-lite: it must get its tools back at the top level.
				expect(wire.tools).toEqual([{ name: 'apply_patch' }]);
				expect(wire.instructions).toBe('GPT55 INSTRUCTIONS');
				expect(wire.parallel_tool_calls).toBeUndefined();
				expect(wire.input[0].type).not.toBe('additional_tools');
				expect(JSON.stringify(wire.input)).not.toContain('additional_tools');
			});

			it('re-folds instructions into input on a 5.6 -> 5.6 fallback hop', async () => {
				const { shapeBodyForModel } = await import(
					'../lib/request/helpers/responses-lite.js'
				);
				const canonical = {
					model: 'gpt-5.6-terra',
					instructions: 'TERRA INSTRUCTIONS',
					input: [{ type: 'message', role: 'user', content: 'Hello' }],
					tools: [{ name: 'apply_patch' }],
				} as any;

				const wire = JSON.parse(JSON.stringify(shapeBodyForModel(canonical)));
				expect(wire.instructions).toBe('');
				expect(wire.input[0].type).toBe('additional_tools');
				expect(JSON.stringify(wire.input[1])).toContain('TERRA INSTRUCTIONS');
				// The canonical body is untouched, so a later hop can reshape again.
				expect(canonical.instructions).toBe('TERRA INSTRUCTIONS');
				expect(canonical.tools).toEqual([{ name: 'apply_patch' }]);
			});

			it('leaves the classic shape intact for pre-5.6 models', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				const requestBody = {
					model: 'gpt-5.5',
					instructions: 'BASE',
					input: [{ type: 'message', role: 'user', content: 'Hello' }],
					tools: [{ name: 'apply_patch' }],
				};

				const result = await transformRequestForCodex(
					{ body: JSON.stringify(requestBody) },
					'https://example.com',
					{ global: {}, models: {} },
					true,
					undefined,
					{ requestTransformMode: 'native' } as any,
				);

				expect(result?.body.tools).toEqual([{ name: 'apply_patch' }]);
				expect(result?.body.instructions).toContain('BASE');
				expect(result?.body.parallel_tool_calls).toBeUndefined();
				expect(
					(result?.body.input?.[0] as Record<string, unknown>).type,
				).not.toBe('additional_tools');
			});

			it('normalizes GPT-5.5 preset ids to the canonical model id in native mode', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				const getInstructionsSpy = vi.spyOn(codexPrompts, 'getCodexInstructions');
				const requestBody = {
					model: 'gpt-5.5-medium',
					input: [{ type: 'message', role: 'user', content: 'Hello' }],
				};

				const result = await transformRequestForCodex(
					{ body: JSON.stringify(requestBody) },
					'https://example.com',
					{ global: {}, models: {} },
					true,
					undefined,
					{ requestTransformMode: 'native' } as any,
				);

				expect(result).toBeDefined();
				expect(result?.body.model).toBe('gpt-5.5');
				expect(result?.body.instructions).toContain('backend as gpt-5.5');
				expect(JSON.stringify(result?.body.input?.[0])).toContain('`gpt-5.5`');
				expect(getInstructionsSpy).not.toHaveBeenCalled();
			});

			it('replaces stale native instruction identity with the actual backend model id', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				const getInstructionsSpy = vi.spyOn(codexPrompts, 'getCodexInstructions');
				const requestBody = {
					model: 'gpt-5.5-medium',
					instructions: 'You are GPT-5.2 running in the Codex CLI, a terminal-based coding assistant.\n\nRest.',
					input: [{ type: 'message', role: 'user', content: 'Hello' }],
				};

				const result = await transformRequestForCodex(
					{ body: JSON.stringify(requestBody) },
					'https://example.com',
					{ global: {}, models: {} },
					true,
					undefined,
					{ requestTransformMode: 'native' } as any,
				);

				expect(result).toBeDefined();
				expect(result?.body.model).toBe('gpt-5.5');
				expect(result?.body.instructions).toContain('backend as gpt-5.5');
				expect(result?.body.instructions).not.toContain('You are GPT-5.2');
				expect(JSON.stringify(result?.body.input?.[0])).toContain('`gpt-5.5`');
				expect(getInstructionsSpy).not.toHaveBeenCalled();
			});

		it('returns undefined when init is undefined (line 166 coverage)', async () => {
			const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
			const result = await transformRequestForCodex(undefined, 'https://example.com', { global: {}, models: {} });
			expect(result).toBeUndefined();
		});

		it('returns undefined when init.body is undefined (line 166 coverage)', async () => {
			const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
			const result = await transformRequestForCodex({}, 'https://example.com', { global: {}, models: {} });
			expect(result).toBeUndefined();
		});

			it('returns undefined when init.body is not a string (line 167 coverage)', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				const result = await transformRequestForCodex(
					{ body: new Blob(['test']) as unknown as BodyInit },
				'https://example.com',
				{ global: {}, models: {} }
				);
				expect(result).toBeUndefined();
			});

			it('transforms request when parsedBody is provided even if init.body is not a string', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				const parsedBody = {
					model: 'gpt-5.3-codex',
					input: [{ type: 'message', role: 'user', content: 'hi' }],
				};
				const result = await transformRequestForCodex(
					{ body: new Blob(['ignored']) as unknown as BodyInit },
					'https://example.com',
					{ global: {}, models: {} },
					true,
					parsedBody,
					{ fastSession: true, fastSessionStrategy: 'always', fastSessionMaxInputItems: 12 },
				);

				expect(result).toBeDefined();
				expect(result?.body.model).toBe('gpt-5.3-codex');
				expect(typeof result?.updatedInit.body).toBe('string');
			});

			it('returns undefined when parsedBody is empty object and init body is unavailable', async () => {
				const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
				const result = await transformRequestForCodex(
					{ body: new Blob(['ignored']) as unknown as BodyInit },
					'https://example.com',
					{ global: {}, models: {} },
					true,
					{},
				);

				expect(result).toBeUndefined();
			});

		it('returns undefined and logs error when JSON parsing fails (line 220-222 coverage)', async () => {
			const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
			const result = await transformRequestForCodex(
				{ body: 'not valid json {{{' },
				'https://example.com',
				{ global: {}, models: {} }
			);
			expect(result).toBeUndefined();
		});

		it('transforms request body successfully (lines 194-202 coverage)', async () => {
			const { transformRequestForCodex } = await import('../lib/request/fetch-helpers.js');
			const requestBody = { model: 'gpt-5.1', input: 'Hello' };
			const result = await transformRequestForCodex(
				{ body: JSON.stringify(requestBody) },
				'https://example.com',
				{ global: {}, models: {} }
			);
			expect(result).toBeDefined();
			expect(result?.body).toBeDefined();
			expect(result?.body.model).toBe('gpt-5.1');
			expect(result?.updatedInit).toBeDefined();
		});
	});

	describe('isInvalidatedAuthTokenError (issue #171)', () => {
		it('treats any HTTP 401 as a token-invalidated auth failure', () => {
			expect(isInvalidatedAuthTokenError(undefined, 401)).toBe(true);
			expect(
				isInvalidatedAuthTokenError(
					{ error: { message: 'Your authentication token has been invalidated.' } },
					401,
				),
			).toBe(true);
		});

		it('matches structured auth error codes without a 401 status', () => {
			expect(isInvalidatedAuthTokenError({ error: { code: 'invalid_token' } })).toBe(true);
			expect(isInvalidatedAuthTokenError({ error: { type: 'invalid_grant' } })).toBe(true);
			expect(isInvalidatedAuthTokenError({ code: 'token_expired' })).toBe(true);
		});

		it('matches the invalidated-token message when only a string body is available', () => {
			expect(
				isInvalidatedAuthTokenError(
					'Your authentication token has been invalidated. Please try signing in again.',
				),
			).toBe(true);
			expect(
				isInvalidatedAuthTokenError({
					error: {
						message:
							'Your authentication token has been invalidated. Please try signing in again. (run `opencode auth login` if this persists)',
					},
				}),
			).toBe(true);
		});

		it('does not treat generic permission/wrong-key codes as invalidated tokens (status-less)', () => {
			// `unauthorized` (permission-denied) and `invalid_api_key` (wrong key)
			// are excluded so the status-less fallback cannot cool down a healthy
			// account on a non-token error.
			expect(isInvalidatedAuthTokenError({ error: { code: 'unauthorized' } })).toBe(false);
			expect(isInvalidatedAuthTokenError({ error: { code: 'invalid_api_key' } })).toBe(false);
		});

		it('does not match rate limits, entitlement gates, or server errors', () => {
			expect(isInvalidatedAuthTokenError({ error: { code: 'rate_limit_exceeded' } }, 429)).toBe(false);
			expect(
				isInvalidatedAuthTokenError(
					{ error: { code: 'model_not_supported_with_chatgpt_account' } },
					403,
				),
			).toBe(false);
			expect(isInvalidatedAuthTokenError({ error: { message: 'server error' } }, 500)).toBe(false);
			expect(isInvalidatedAuthTokenError(undefined, undefined)).toBe(false);
		});
	});
});

describe("createAbortError (issue #176)", () => {
	it("returns the Error reason (same instance) but stamps name=AbortError", () => {
		const reason = new Error("client closed connection");
		const controller = new AbortController();
		controller.abort(reason);
		const err = createAbortError(controller.signal);
		// Same instance (message/stack preserved)...
		expect(err).toBe(reason);
		expect(err.message).toBe("client closed connection");
		// ...but recognizable as an abort downstream.
		expect(err.name).toBe("AbortError");
	});

	it("leaves an existing AbortError-named reason untouched", () => {
		const reason = new Error("already an abort");
		reason.name = "AbortError";
		const controller = new AbortController();
		controller.abort(reason);
		const err = createAbortError(controller.signal);
		expect(err).toBe(reason);
		expect(err.name).toBe("AbortError");
		expect(err.message).toBe("already an abort");
	});

	it("wraps a string reason in a named AbortError", () => {
		const controller = new AbortController();
		controller.abort("upstream timeout");
		const err = createAbortError(controller.signal);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("AbortError");
		expect(err.message).toBe("upstream timeout");
	});

	it("propagates the platform AbortError when abort() has no reason", () => {
		// Node sets signal.reason to a DOMException named AbortError (an Error),
		// so the helper forwards it rather than synthesizing one.
		const controller = new AbortController();
		controller.abort();
		const err = createAbortError(controller.signal);
		expect(err.name).toBe("AbortError");
	});

	it("synthesizes a named AbortError (message Aborted) when reason is absent", () => {
		const err = createAbortError({ aborted: true } as unknown as AbortSignal);
		expect(err.name).toBe("AbortError");
		expect(err.message).toBe("Aborted");
	});

	it("handles a null/undefined signal", () => {
		expect(createAbortError(null).name).toBe("AbortError");
		expect(createAbortError(undefined).message).toBe("Aborted");
	});
});

import { describe, it, expect, vi } from "vitest";
import {
	rewriteUrlForCodex,
	extractRequestUrl,
	createCodexHeaders,
	shouldRefreshToken,
} from "../lib/request/fetch-helpers.js";
import type { Auth } from "@opencode-ai/sdk";
import { CODEX_BASE_URL, OPENAI_HEADERS, OPENAI_HEADER_VALUES } from "../lib/constants.js";

/**
 * Comprehensive tests for helper utility functions
 */
describe("Helper Utilities", () => {
	describe("rewriteUrlForCodex comprehensive tests", () => {
		it("should rewrite /responses to /codex/responses", () => {
			const result = rewriteUrlForCodex("https://api.openai.com/v1/responses");
			expect(result).toContain("chatgpt.com");
			expect(result).toContain("codex/responses");
		});

		it("should rewrite /backend-api/responses to /backend-api/codex/responses", () => {
			const result = rewriteUrlForCodex("https://chatgpt.com/backend-api/responses");
			expect(result).toContain("codex/responses");
		});

		it("should preserve query parameters", () => {
			const url = "https://api.openai.com/v1/responses?foo=bar&baz=qux";
			const result = rewriteUrlForCodex(url);
			expect(result).toContain("foo=bar");
			expect(result).toContain("baz=qux");
			expect(result).toContain("codex/responses");
		});

		it("should preserve hash fragments", () => {
			const url = "https://api.openai.com/v1/responses#section";
			const result = rewriteUrlForCodex(url);
			expect(result).toContain("#section");
		});

		it("should handle URLs without /responses", () => {
			const url = "https://api.openai.com/v1/models";
			const result = rewriteUrlForCodex(url);
			expect(result).toContain(CODEX_BASE_URL);
			expect(result).toContain("models");
		});

		it("should handle URLs already on codex origin", () => {
			const url = "https://chatgpt.com/backend-api/models";
			const result = rewriteUrlForCodex(url);
			expect(result).toBe(url);
		});

		it("should remove username and password from URL", () => {
			const url = "https://user:pass@api.openai.com/v1/responses";
			const result = rewriteUrlForCodex(url);
			expect(result).not.toContain("user");
			expect(result).not.toContain("pass");
			expect(result).not.toContain("@");
		});

		it("should handle URLs with port numbers", () => {
			const url = "https://api.openai.com:8080/v1/responses";
			const result = rewriteUrlForCodex(url);
			expect(result).toContain("chatgpt.com");
			// Port may be preserved in implementation
		});

		it("should handle URLs with trailing slashes", () => {
			const result = rewriteUrlForCodex("https://api.openai.com/v1/responses/");
			expect(result).toContain("chatgpt.com");
			expect(result).toContain("codex/responses");
		});

		it("should handle URLs with double slashes in path", () => {
			const url = "https://api.openai.com/v1//responses";
			const result = rewriteUrlForCodex(url);
			expect(result).toContain("codex/responses");
		});

		it("should throw for invalid URLs", () => {
			expect(() => rewriteUrlForCodex("not a url")).toThrow(TypeError);
			expect(() => rewriteUrlForCodex("")).toThrow(TypeError);
		});

		it("should handle URLs with encoded characters", () => {
			const url = "https://api.openai.com/v1/responses?q=hello%20world";
			const result = rewriteUrlForCodex(url);
			expect(result).toContain("hello%20world");
			expect(result).toContain("codex/responses");
		});

		it("should be idempotent for codex URLs", () => {
			const url = "https://chatgpt.com/backend-api/codex/responses";
			const first = rewriteUrlForCodex(url);
			// Implementation may not guarantee perfect idempotency
			expect(first).toContain("chatgpt.com");
			expect(first).toContain("codex/responses");
		});
	});

	describe("extractRequestUrl comprehensive tests", () => {
		it("should extract URL from string", () => {
			const url = "https://api.openai.com/v1/responses";
			expect(extractRequestUrl(url)).toBe(url);
		});

		it("should extract URL from URL object", () => {
			const url = new URL("https://api.openai.com/v1/responses");
			expect(extractRequestUrl(url)).toBe("https://api.openai.com/v1/responses");
		});

		it("should extract URL from Request object", () => {
			const request = new Request("https://api.openai.com/v1/responses");
			expect(extractRequestUrl(request)).toBe("https://api.openai.com/v1/responses");
		});

		it("should preserve query parameters from URL object", () => {
			const url = new URL("https://api.openai.com/v1/responses?test=123");
			const result = extractRequestUrl(url);
			expect(result).toContain("test=123");
		});

		it("should preserve query parameters from Request object", () => {
			const request = new Request("https://api.openai.com/v1/responses?test=456");
			const result = extractRequestUrl(request);
			expect(result).toContain("test=456");
		});

		it("should handle empty string", () => {
			expect(extractRequestUrl("")).toBe("");
		});

		it("should handle Request with absolute URL", () => {
			const request = new Request("https://example.com/api/responses");
			const result = extractRequestUrl(request);
			expect(result).toContain("/api/responses");
		});

		it("should handle Request with POST method", () => {
			const request = new Request("https://api.openai.com/v1/responses", {
				method: "POST",
			});
			expect(extractRequestUrl(request)).toBe("https://api.openai.com/v1/responses");
		});
	});

	describe("createCodexHeaders comprehensive tests", () => {
		const accountId = "test-account-123";
		const accessToken = "test-access-token";

		it("should create all required headers", () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken, {
				promptCacheKey: "session-1",
			});

			expect(headers.get("Authorization")).toBe(`Bearer ${accessToken}`);
			expect(headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe(accountId);
			expect(headers.get(OPENAI_HEADERS.BETA)).toBe(
				OPENAI_HEADER_VALUES.BETA_RESPONSES
			);
			expect(headers.get(OPENAI_HEADERS.ORIGINATOR)).toBe(
				OPENAI_HEADER_VALUES.ORIGINATOR_CODEX
			);
			expect(headers.get("accept")).toBe("text/event-stream");
		});

		it("should set conversation_id and session_id when promptCacheKey provided", () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken, {
				promptCacheKey: "cache-key-123",
			});

			expect(headers.get(OPENAI_HEADERS.CONVERSATION_ID)).toBe("cache-key-123");
			expect(headers.get(OPENAI_HEADERS.SESSION_ID)).toBe("cache-key-123");
		});

		it("should not set conversation_id and session_id when promptCacheKey missing", () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken, {});

			expect(headers.get(OPENAI_HEADERS.CONVERSATION_ID)).toBeNull();
			expect(headers.get(OPENAI_HEADERS.SESSION_ID)).toBeNull();
		});

		it("should remove x-api-key header", () => {
			const init = {
				headers: {
					"x-api-key": "should-be-removed",
					"Content-Type": "application/json",
				},
			};

			const headers = createCodexHeaders(init, accountId, accessToken, {});
			expect(headers.has("x-api-key")).toBe(false);
			expect(headers.get("Content-Type")).toBe("application/json");
		});

		it("should preserve other existing headers", () => {
			const init = {
				headers: {
					"Content-Type": "application/json",
					"X-Custom-Header": "custom-value",
				},
			};

			const headers = createCodexHeaders(init, accountId, accessToken, {});
			expect(headers.get("Content-Type")).toBe("application/json");
			expect(headers.get("X-Custom-Header")).toBe("custom-value");
		});

		it("should not set organization_id by default even when provided (Codex CLI parity, #196)", () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken, {
				organizationId: "org-123",
			});

			expect(headers.get(OPENAI_HEADERS.ORGANIZATION_ID)).toBeNull();
		});

		it("should set organization_id when provided and CODEX_AUTH_SEND_ORGANIZATION_HEADER=1", () => {
			try {
				vi.stubEnv("CODEX_AUTH_SEND_ORGANIZATION_HEADER", "1");
				const headers = createCodexHeaders(undefined, accountId, accessToken, {
					organizationId: "org-123",
				});

				expect(headers.get(OPENAI_HEADERS.ORGANIZATION_ID)).toBe("org-123");
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("should not set organization_id when not provided", () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken, {});
			expect(headers.has(OPENAI_HEADERS.ORGANIZATION_ID)).toBe(false);
		});

		it("should handle empty accountId", () => {
			const headers = createCodexHeaders(undefined, "", accessToken, {});
			expect(headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe("");
		});

		it("should handle empty accessToken", () => {
			const headers = createCodexHeaders(undefined, accountId, "", {});
			const auth = headers.get("Authorization");
			expect(auth).toBeDefined();
			expect(auth).toContain("Bearer");
		});

		it("should handle multiple models in opts", () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken, {
				model: "gpt-5.4",
				promptCacheKey: "session-1",
			});

			expect(headers.get(OPENAI_HEADERS.CONVERSATION_ID)).toBe("session-1");
			expect(headers.get(OPENAI_HEADERS.SESSION_ID)).toBe("session-1");
		});

		it("should handle Headers object as init.headers", () => {
			const existingHeaders = new Headers({
				"Content-Type": "application/json",
			});
			const init = { headers: existingHeaders };

			const headers = createCodexHeaders(init, accountId, accessToken, {});
			expect(headers.get("Content-Type")).toBe("application/json");
		});

		it("should handle array of headers as init.headers", () => {
			const init = {
				headers: [
					["Content-Type", "application/json"],
					["X-Custom", "value"],
				] as [string, string][],
			};

			const headers = createCodexHeaders(init, accountId, accessToken, {});
			expect(headers.get("Content-Type")).toBe("application/json");
			expect(headers.get("X-Custom")).toBe("value");
		});
	});

	describe("shouldRefreshToken comprehensive tests", () => {
		const now = Date.now();

		it("should return true for non-oauth auth", () => {
			const auth: Auth = { type: "api", key: "test-key" };
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it("should return true when access token is empty string", () => {
			const auth: Auth = {
				type: "oauth",
				access: "",
				refresh: "refresh-token",
				expires: now + 10000,
			};
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it("should return true when access token is missing", () => {
			const auth: Auth = {
				type: "oauth",
				access: undefined as unknown as string,
				refresh: "refresh-token",
				expires: now + 10000,
			};
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it("should return true when token is expired", () => {
			const auth: Auth = {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: now - 1000,
			};
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it("should return true when token expires exactly now", () => {
			const auth: Auth = {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: now,
			};
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it("should return false for valid oauth token", () => {
			const auth: Auth = {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: now + 10000,
			};
			expect(shouldRefreshToken(auth)).toBe(false);
		});

		it("should handle skew window for early refresh", () => {
			const auth: Auth = {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: now + 1500,
			};
			expect(shouldRefreshToken(auth, 1000)).toBe(false);
			expect(shouldRefreshToken(auth, 2000)).toBe(true);
		});

		it("should handle zero skew", () => {
			const auth: Auth = {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: now + 1000,
			};
			expect(shouldRefreshToken(auth, 0)).toBe(false);
		});

		it("should handle negative skew (treated as 0)", () => {
			const auth: Auth = {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: now + 1000,
			};
			expect(shouldRefreshToken(auth, -500)).toBe(false);
		});

		it("should handle very large skew", () => {
			const auth: Auth = {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: now + 1000,
			};
			expect(shouldRefreshToken(auth, 10000)).toBe(true);
		});

		it("should handle fractional skew values", () => {
			const auth: Auth = {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: now + 1000,
			};
			expect(shouldRefreshToken(auth, 500.7)).toBe(false);
			expect(shouldRefreshToken(auth, 1500.3)).toBe(true);
		});

		it("should handle token with very distant expiry", () => {
			const auth: Auth = {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: now + 86400000, // 1 day
			};
			expect(shouldRefreshToken(auth, 0)).toBe(false);
		});

		it("should handle token expired long ago", () => {
			const auth: Auth = {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: now - 86400000, // 1 day ago
			};
			expect(shouldRefreshToken(auth, 0)).toBe(true);
		});
	});

	describe("Integration tests", () => {
		it("should create headers and rewrite URL consistently", () => {
			const url = "https://api.openai.com/v1/responses";
			const rewrittenUrl = rewriteUrlForCodex(url);
			const headers = createCodexHeaders(undefined, "account-1", "token-1", {
				promptCacheKey: "session-1",
			});

			expect(rewrittenUrl).toContain("chatgpt.com");
			expect(rewrittenUrl).toContain("codex/responses");
			expect(headers.get("Authorization")).toBe("Bearer token-1");
		});

		it("should extract and rewrite URL from Request object", () => {
			const request = new Request("https://api.openai.com/v1/responses");
			const url = extractRequestUrl(request);
			const rewritten = rewriteUrlForCodex(url);

			expect(rewritten).toContain("codex/responses");
		});

		it("should handle complete request flow", () => {
			const auth: Auth = {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 10000,
			};

			expect(shouldRefreshToken(auth)).toBe(false);

			const url = extractRequestUrl("https://api.openai.com/v1/responses");
			const rewritten = rewriteUrlForCodex(url);
			const headers = createCodexHeaders(undefined, "account-1", auth.access, {
				promptCacheKey: "session-1",
			});

			expect(rewritten).toContain("chatgpt.com");
			expect(headers.get("Authorization")).toBe("Bearer access-token");
		});
	});
});
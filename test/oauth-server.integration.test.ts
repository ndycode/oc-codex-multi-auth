/**
 * Integration test for OAuth server flow
 * Tests the local HTTP callback server used for OAuth authentication
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { startLocalOAuthServer } from "../lib/auth/server.js";

describe("OAuth Server Integration", () => {
	let serverInfo: Awaited<ReturnType<typeof startLocalOAuthServer>> | null = null;

	afterEach(() => {
		if (serverInfo) {
			serverInfo.close();
			serverInfo = null;
		}
	});

	it("should start server and handle valid OAuth callback", async () => {
		const testState = "test-state-12345";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);
		expect(serverInfo.port).toBe(1455);

		// Simulate OAuth callback
		const testCode = "auth-code-67890";
		const callbackUrl = `http://127.0.0.1:1455/auth/callback?code=${testCode}&state=${testState}`;

		const response = await fetch(callbackUrl);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");

		const contentSecurityPolicy = response.headers.get("content-security-policy");
		expect(contentSecurityPolicy).toContain("default-src 'none'");
		expect(contentSecurityPolicy).toContain("script-src 'none'");
		expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");

		const nonce = contentSecurityPolicy?.match(/style-src 'nonce-([^']+)'/)?.[1];
		expect(nonce).toBeTruthy();

		const body = await response.text();
		expect(body).toContain(`<style nonce="${nonce}">`);
		expect(body).toContain("Authentication complete");
		expect(body).toContain("You can close this tab.");
		expect(body).not.toContain("<script");
		expect(body).not.toContain("fonts.googleapis.com");
		expect(body).not.toMatch(/\\u[0-9a-f]{4}/i);

		// Server should have captured the code
		const result = await serverInfo.waitForCode(testState);
		expect(result).toEqual({ code: testCode });
	});

	it("should reject callback with wrong state", async () => {
		const testState = "correct-state";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);

		const callbackUrl = `http://127.0.0.1:1455/auth/callback?code=test&state=wrong-state`;
		const response = await fetch(callbackUrl);
		expect(response.status).toBe(400);

		const body = await response.text();
		expect(body).toContain("State mismatch");
	});

	it("should reject callback without code", async () => {
		const testState = "test-state";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);

		const callbackUrl = `http://127.0.0.1:1455/auth/callback?state=${testState}`;
		const response = await fetch(callbackUrl);
		expect(response.status).toBe(400);

		const body = await response.text();
		expect(body).toContain("Missing authorization code");
	});

	it("should return 404 for non-callback paths", async () => {
		const testState = "test-state";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);

		const response = await fetch("http://127.0.0.1:1455/other-path");
		expect(response.status).toBe(404);
	});

	it("should handle server cleanup properly", async () => {
		const testState = "cleanup-test";
		serverInfo = await startLocalOAuthServer({ state: testState });

		expect(serverInfo.ready).toBe(true);

		// Close should work without error
		serverInfo.close();

		// Subsequent requests should fail (server closed)
		await expect(
			fetch("http://127.0.0.1:1455/auth/callback?code=test&state=test")
		).rejects.toThrow();

		serverInfo = null; // Prevent double-close in afterEach
	});
});

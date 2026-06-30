import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/prompts/codex.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/prompts/codex.js")>();
	return {
		...actual,
		getCodexInstructions: vi.fn(async () => "test-instructions"),
	};
});

import {
	buildWarmRequestBody,
	warmAccountWindow,
} from "../lib/accounts/warm-request.js";
import { CODEX_BASE_URL } from "../lib/constants.js";

function fakeResponse(status: number): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		body: { cancel: vi.fn(async () => undefined) },
	} as unknown as Response;
}

const PARAMS = {
	accountId: "acct-1",
	accessToken: "tok-1",
	organizationId: undefined as string | undefined,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("buildWarmRequestBody (#182)", () => {
	it("builds a minimal billable /responses body", async () => {
		const body = await buildWarmRequestBody();
		expect(body.model).toBe("gpt-5.4");
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect(body.reasoning).toEqual({ effort: "none", summary: "auto" });
		expect(body.input?.[0]).toMatchObject({ role: "user", type: "message" });
	});
});

describe("warmAccountWindow (#182)", () => {
	it("POSTs to /codex/responses with auth headers and returns true on 2xx", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(200));
		const result = await warmAccountWindow({ ...PARAMS, fetchImpl });
		expect(result).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${CODEX_BASE_URL}/codex/responses`);
		expect(init.method).toBe("POST");
		const headers = init.headers as Headers;
		expect(headers.get("Authorization")).toBe("Bearer tok-1");
		expect(headers.get("chatgpt-account-id")).toBe("acct-1");
	});

	it("treats 429 as success (window already active)", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(429));
		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).resolves.toBe(true);
	});

	it("throws on other non-2xx (e.g. 401)", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(401));
		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(/HTTP 401/);
	});

	it("throws on a 500", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(500));
		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(/HTTP 500/);
	});

	it("cancels the SSE stream body on success", async () => {
		const cancel = vi.fn(async () => undefined);
		const fetchImpl = vi.fn(
			async () =>
				({ ok: true, status: 200, body: { cancel } }) as unknown as Response,
		);
		await warmAccountWindow({ ...PARAMS, fetchImpl });
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("propagates a network error from fetch", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNRESET");
		});
		await expect(warmAccountWindow({ ...PARAMS, fetchImpl })).rejects.toThrow(/ECONNRESET/);
	});

	it("passes organizationId into the request headers when present", async () => {
		const fetchImpl = vi.fn(async () => fakeResponse(200));
		await warmAccountWindow({ ...PARAMS, organizationId: "org-9", fetchImpl });
		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("openai-organization")).toBe("org-9");
	});
});

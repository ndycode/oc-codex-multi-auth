/**
 * Wire-parity regression pin for the #196 follow-up (PR #199).
 *
 * nxtkofi reported gpt-5.6-sol working in the Codex TUI but rejected through
 * the plugin (`model_not_supported_with_chatgpt_account`) while terra/luna
 * passed. Root cause was request identity, not payload: no Codex CLI
 * `User-Agent` (the backend gates 5.6 tiers on the catalog's
 * `minimal_client_version`, read from the UA product token) and a pinned
 * `openai-organization` header upstream Codex never sends.
 *
 * These tests drive the REAL production path — `createCodexHeaders` plus the
 * serialize-time responses-lite reshape — with no mocks, and assert the full
 * outgoing sol request matches what codex-rs puts on the wire.
 */
import { describe, it, expect, vi } from "vitest";
import { createCodexHeaders } from "../lib/request/fetch-helpers.js";
import { shapeBodyForModel } from "../lib/request/helpers/responses-lite.js";
import {
	DEFAULT_CODEX_CLIENT_VERSION,
	buildCodexUserAgent,
} from "../lib/request/helpers/user-agent.js";
import { OPENAI_HEADERS } from "../lib/constants.js";
import type { RequestBody } from "../lib/types.js";

const ACCOUNT_ID = "acct-e2e";
const TOKEN = "tok-e2e";

/** A request the plugin would receive from opencode for a sol turn. */
function solBody(): RequestBody {
	return {
		model: "gpt-5.6-sol",
		instructions: "You are Codex, an agent based on GPT-5.",
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "hi" }],
			},
		],
		tools: [{ type: "function", name: "shell" }],
		parallel_tool_calls: true,
		stream: true,
		store: false,
	} as unknown as RequestBody;
}

describe("gpt-5.6-sol wire parity with codex-rs (#196 / PR #199)", () => {
	it("sends the full Codex CLI request identity for a sol turn from an org-bearing account", () => {
		// opencode's runtime injects its own UA; an earlier attempt may have
		// left a stale org header on init. Both must be replaced/stripped.
		const init = {
			headers: {
				"user-agent": "opencode/1.17.20",
				[OPENAI_HEADERS.ORGANIZATION_ID]: "org-from-previous-build",
			},
		} as RequestInit;

		const headers = createCodexHeaders(init, ACCOUNT_ID, TOKEN, {
			model: "gpt-5.6-sol",
			promptCacheKey: "ses_parity",
			organizationId: "org-abc123", // account carries an org claim
		});

		// Client-version identity: the catalog gates 5.6 on 0.144.0, read from
		// the UA product token. Format mirrors get_codex_user_agent().
		expect(headers.get("user-agent")).toBe(buildCodexUserAgent());
		expect(headers.get("user-agent")).toMatch(
			new RegExp(
				`^codex_cli_rs/${DEFAULT_CODEX_CLIENT_VERSION.replace(/\./g, "\\.")} \\(.+; .+\\)`,
			),
		);

		// Workspace identity: chatgpt-account-id only — upstream never sends
		// openai-organization on ChatGPT-Codex requests.
		expect(headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe(ACCOUNT_ID);
		expect(headers.get(OPENAI_HEADERS.ORGANIZATION_ID)).toBeNull();

		// Codex conventions that were already correct and must stay.
		expect(headers.get(OPENAI_HEADERS.ORIGINATOR)).toBe("codex_cli_rs");
		expect(headers.get(OPENAI_HEADERS.BETA)).toBe("responses=experimental");
		expect(headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
		expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
	});

	it("serializes the sol body in the responses-lite shape codex-rs sends", () => {
		const wire = JSON.parse(JSON.stringify(shapeBodyForModel(solBody())));

		expect(wire.model).toBe("gpt-5.6-sol");
		// Tools move into input as a leading additional_tools developer item;
		// top-level instructions empty, tools omitted, no tool fan-out.
		expect(wire.instructions).toBe("");
		expect(wire.tools).toBeUndefined();
		expect(wire.input[0]).toMatchObject({
			type: "additional_tools",
			role: "developer",
		});
		expect(wire.input[0].tools).toHaveLength(1);
		expect(wire.parallel_tool_calls).toBe(false);
		// 6.7.1 regression pin: lite requests must carry reasoning.context.
		expect(wire.reasoning?.context).toBe("all_turns");
	});

	it("keeps the terra fallback attempt on the same client identity after a sol entitlement 400", () => {
		// The reported failure mode: backend 400s sol; the rotation loop
		// resolves terra and rebuilds headers for the retry. The retry must
		// carry the same Codex identity (and still no org pin).
		const headers = createCodexHeaders(undefined, ACCOUNT_ID, TOKEN, {
			model: "gpt-5.6-terra",
			organizationId: "org-abc123",
		});
		expect(headers.get("user-agent")).toMatch(/^codex_cli_rs\//);
		expect(headers.get(OPENAI_HEADERS.ORGANIZATION_ID)).toBeNull();
		expect(headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
	});

	it("restores legacy org pinning only under the escape hatch", () => {
		try {
			vi.stubEnv("CODEX_AUTH_SEND_ORGANIZATION_HEADER", "1");
			const headers = createCodexHeaders(undefined, ACCOUNT_ID, TOKEN, {
				model: "gpt-5.6-sol",
				organizationId: "org-abc123",
			});
			expect(headers.get(OPENAI_HEADERS.ORGANIZATION_ID)).toBe("org-abc123");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

/**
 * Client-identity selection for backend requests (#196 follow-up).
 *
 * PR #199 made the plugin claim the Codex CLI identity (`originator:
 * codex_cli_rs` + a matching UA) so the backend's `minimal_client_version`
 * gate would pass for the gpt-5.6 tiers. nxtkofi's accounts still reject
 * `gpt-5.6-sol` under that identity while accepting it from plain opencode —
 * whose native ChatGPT-Codex path sends `originator: "opencode"` with a
 * `opencode/<version> (<platform> <release>; <arch>)` UA to the same
 * `/backend-api/codex/responses` endpoint. Sol's catalog entry is identical to
 * terra/luna (`minimal_client_version: 0.144.0`, `use_responses_lite: true`),
 * so the sol-only rejection is a per-originator entitlement decision on the
 * backend, not a version or payload problem.
 *
 * Policy: gpt-5.6 (responses-lite) models default to the host identity that
 * plain opencode is proven to pass with; every other model keeps the Codex CLI
 * identity from PR #199. `CODEX_AUTH_CLIENT_IDENTITY=codex|opencode` forces
 * one identity for all models.
 */
import os from "node:os";
import { buildCodexUserAgent } from "./user-agent.js";
import { usesResponsesLite } from "./responses-lite.js";
import { OPENAI_HEADER_VALUES } from "../../constants.js";

export type ClientIdentityMode = "codex" | "opencode";

export interface ClientIdentity {
	originator: string;
	userAgent: string;
}

export const OPENCODE_ORIGINATOR = "opencode";

/**
 * Version advertised in the host UA product token. The backend does not
 * version-gate the `opencode` originator the way it gates `codex_cli_rs`, so
 * this only needs to look like a plausible host build; override with
 * CODEX_AUTH_HOST_VERSION if that ever changes.
 */
export const DEFAULT_OPENCODE_VERSION = "1.17.20";

function sanitizeToken(value: string): string {
	return value.replace(/[^\x20-\x7e]/g, "").trim();
}

function resolveHostVersion(): string {
	const envVersion = process.env.CODEX_AUTH_HOST_VERSION;
	return (envVersion ? sanitizeToken(envVersion) : "") || DEFAULT_OPENCODE_VERSION;
}

/** Mirrors opencode's own ChatGPT-Codex UA: `opencode/<v> (<platform> <release>; <arch>)`. */
export function buildOpencodeUserAgent(): string {
	return `opencode/${resolveHostVersion()} (${os.platform()} ${sanitizeToken(os.release())}; ${os.arch()})`;
}

function forcedMode(): ClientIdentityMode | undefined {
	const raw = process.env.CODEX_AUTH_CLIENT_IDENTITY?.trim().toLowerCase();
	if (raw === "codex") return "codex";
	if (raw === "opencode" || raw === "host") return "opencode";
	return undefined;
}

/**
 * Resolve the identity to present for a request against `model`.
 *
 * Accepts raw selectors (`openai/gpt-5.6-sol-xhigh`) as well as canonical ids;
 * `undefined` (usage/reset endpoints) resolves to the Codex CLI identity.
 */
export function resolveClientIdentity(model?: string): ClientIdentity {
	const mode = forcedMode() ?? (usesResponsesLite(model) ? "opencode" : "codex");
	if (mode === "opencode") {
		return {
			originator: OPENCODE_ORIGINATOR,
			userAgent: buildOpencodeUserAgent(),
		};
	}
	return {
		originator: OPENAI_HEADER_VALUES.ORIGINATOR_CODEX,
		userAgent: buildCodexUserAgent(),
	};
}

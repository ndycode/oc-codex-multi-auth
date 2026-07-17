/**
 * Client-identity selection for backend requests (#196 follow-up).
 *
 * PR #199 made the plugin claim the Codex CLI identity (`originator:
 * codex_cli_rs` + a matching UA) so the backend's `minimal_client_version`
 * gate would pass for the gpt-5.6 tiers. nxtkofi's accounts still reject
 * `gpt-5.6-sol` under that identity while accepting it from plain opencode —
 * whose native ChatGPT-Codex path sends `originator: "opencode"` with a
 * `opencode/<version> (<platform> <release>; <arch>)` UA (raw `os.platform()`,
 * per the bundled `W.headers["User-Agent"]` assignment) to the same
 * `/backend-api/codex/responses` endpoint. Sol's catalog entry is identical to
 * terra/luna (`minimal_client_version: 0.144.0`, `use_responses_lite: true`),
 * so the sol-only rejection is a per-originator entitlement decision on the
 * backend, not a version or payload problem.
 *
 * Policy: gpt-5.6 (responses-lite) models default to the host identity that
 * plain opencode is proven to pass with; every other model keeps the Codex CLI
 * identity from PR #199. `CODEX_AUTH_CLIENT_IDENTITY=codex|opencode` (alias
 * `host` for `opencode`) forces one identity for all models.
 */
import os from "node:os";
import { buildCodexUserAgent, sanitizeVersionToken } from "./user-agent.js";
import { usesResponsesLite } from "./responses-lite.js";
import { OPENAI_HEADER_VALUES } from "../../constants.js";

export type ClientIdentityMode = "codex" | "opencode";

export interface ClientIdentity {
	originator: string;
	userAgent: string;
}

export const OPENCODE_ORIGINATOR = "opencode";

/**
 * Last-resort version for the host UA product token. The live host version is
 * preferred whenever the runtime injects its own `opencode/<version>` UA on
 * the incoming request (self-syncing, no release-time bump needed); the
 * backend does not currently version-gate the `opencode` originator, so this
 * constant only has to look like a plausible host build. Override order:
 * CODEX_AUTH_HOST_VERSION > host-injected UA version > this constant.
 */
export const DEFAULT_OPENCODE_VERSION = "1.17.20";

/** Extract `<version>` from a host-injected `opencode/<version> ...` UA. */
function hostVersionFromUserAgent(hostUserAgent: string | undefined): string {
	if (!hostUserAgent) return "";
	const match = /^opencode\/([0-9A-Za-z.+_-]+)/.exec(hostUserAgent.trim());
	return match?.[1] ?? "";
}

function resolveHostVersion(hostUserAgent?: string): string {
	const envVersion = process.env.CODEX_AUTH_HOST_VERSION;
	return (
		(envVersion ? sanitizeVersionToken(envVersion) : "") ||
		hostVersionFromUserAgent(hostUserAgent) ||
		DEFAULT_OPENCODE_VERSION
	);
}

/**
 * Mirrors opencode's own ChatGPT-Codex UA: `opencode/<v> (<platform>
 * <release>; <arch>)` with the raw `os.platform()` value (`win32`/`linux`/
 * `darwin`), exactly as the bundled host emits it.
 */
export function buildOpencodeUserAgent(hostUserAgent?: string): string {
	const release = os.release().replace(/[^\x20-\x7e]/g, "").trim();
	return `opencode/${resolveHostVersion(hostUserAgent)} (${os.platform()} ${release}; ${os.arch()})`;
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
 * `hostUserAgent` is the UA the host runtime put on the incoming request, if
 * any — used to keep the advertised opencode version in sync with the real
 * host build.
 */
export function resolveClientIdentity(
	model?: string,
	hostUserAgent?: string,
): ClientIdentity {
	const mode = forcedMode() ?? (usesResponsesLite(model) ? "opencode" : "codex");
	if (mode === "opencode") {
		return {
			originator: OPENCODE_ORIGINATOR,
			userAgent: buildOpencodeUserAgent(hostUserAgent),
		};
	}
	return {
		originator: OPENAI_HEADER_VALUES.ORIGINATOR_CODEX,
		userAgent: buildCodexUserAgent(),
	};
}

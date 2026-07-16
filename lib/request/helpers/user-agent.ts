/**
 * Codex CLI client-identity parity for backend requests.
 *
 * The ChatGPT Codex backend derives the client version from the `User-Agent`
 * product token (codex-rs `login/src/auth/default_client.rs`,
 * `get_codex_user_agent()`), and model catalog entries carry a
 * `minimal_client_version` gate — `0.144.0` for the gpt-5.6 tiers. We already
 * declare `originator: codex_cli_rs`; without a matching UA the backend sees a
 * versionless client and can reject preview-gated models with
 * `model_not_supported_with_chatgpt_account` even for entitled accounts (#196).
 *
 * Upstream format:
 *   codex_cli_rs/<version> (<os> <os version>; <arch>) <terminal>
 */
import os from "node:os";

/**
 * Version advertised in the User-Agent product token. Tracks the highest
 * `minimal_client_version` in the upstream model catalog (gpt-5.6 tiers);
 * override with CODEX_AUTH_CLIENT_VERSION if the backend gate moves before a
 * plugin release does.
 */
export const DEFAULT_CODEX_CLIENT_VERSION = "0.144.0";

const PLATFORM_LABELS: Record<string, string> = {
	win32: "Windows",
	darwin: "Mac OS",
	linux: "Linux",
};

/** Upstream sanitizes the UA to printable ASCII; mirror that. */
function sanitizeToken(value: string): string {
	return value.replace(/[^\x20-\x7e]/g, "").trim();
}

export function buildCodexUserAgent(): string {
	const envVersion = process.env.CODEX_AUTH_CLIENT_VERSION;
	const version =
		(envVersion ? sanitizeToken(envVersion) : "") || DEFAULT_CODEX_CLIENT_VERSION;
	const platform = PLATFORM_LABELS[os.platform()] ?? os.platform();
	const release = sanitizeToken(os.release());
	const arch = os.arch();
	return `codex_cli_rs/${version} (${platform} ${release}; ${arch}) unknown`;
}

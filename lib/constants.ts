/**
 * Constants used throughout the plugin
 * Centralized for easy maintenance and configuration
 */

/** Published package identifier used across runtime messages and install flows */
export const PACKAGE_NAME = "oc-codex-multi-auth";

/** Previous published package identifier kept for installer and storage migration */
export const LEGACY_PACKAGE_NAME = "oc-chatgpt-multi-auth";

/** Plugin identifier for logging and error messages */
export const PLUGIN_NAME = PACKAGE_NAME;

/** Storage file names for active and legacy account data */
export const ACCOUNTS_FILE_NAME = "oc-codex-multi-auth-accounts.json";
export const LEGACY_ACCOUNTS_FILE_NAME = "openai-codex-accounts.json";
export const FLAGGED_ACCOUNTS_FILE_NAME = "oc-codex-multi-auth-flagged-accounts.json";
export const LEGACY_FLAGGED_ACCOUNTS_FILE_NAME = "openai-codex-flagged-accounts.json";
export const LEGACY_BLOCKED_ACCOUNTS_FILE_NAME = "openai-codex-blocked-accounts.json";

/** Base URL for ChatGPT backend API */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/** Dummy API key used for OpenAI SDK (actual auth via OAuth) */
export const DUMMY_API_KEY = "chatgpt-oauth";

/** Provider ID for UI display - shows under "OpenAI" in auth dropdown */
export const PROVIDER_ID = "openai";

/** HTTP Status Codes */
export const HTTP_STATUS = {
	BAD_REQUEST: 400,
	OK: 200,
	FORBIDDEN: 403,
	UNAUTHORIZED: 401,
	NOT_FOUND: 404,
	TOO_MANY_REQUESTS: 429,
} as const;

/** OpenAI-specific headers */
export const OPENAI_HEADERS = {
	BETA: "OpenAI-Beta",
	ACCOUNT_ID: "chatgpt-account-id",
	ORGANIZATION_ID: "openai-organization",
	ORIGINATOR: "originator",
	SESSION_ID: "session_id",
	CONVERSATION_ID: "conversation_id",
} as const;

/** OpenAI-specific header values */
export const OPENAI_HEADER_VALUES = {
	BETA_RESPONSES: "responses=experimental",
	ORIGINATOR_CODEX: "codex_cli_rs",
} as const;

/** URL path segments */
export const URL_PATHS = {
	RESPONSES: "/responses",
	CODEX_RESPONSES: "/codex/responses",
} as const;

/** JWT claim path for ChatGPT account ID */
export const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

/** Error messages */
export const ERROR_MESSAGES = {
	NO_ACCOUNT_ID: "Failed to extract accountId from token",
	TOKEN_REFRESH_FAILED: "Failed to refresh token, authentication required",
	REQUEST_PARSE_ERROR: "Error parsing request",
} as const;

/** Log stages for request logging */
export const LOG_STAGES = {
	BEFORE_TRANSFORM: "before-transform",
	AFTER_TRANSFORM: "after-transform",
	RESPONSE: "response",
	ERROR_RESPONSE: "error-response",
} as const;

/** Platform-specific browser opener commands */
export const PLATFORM_OPENERS = {
	darwin: "open",
	win32: "start",
	linux: "xdg-open",
} as const;

/** OAuth authorization labels */
export const AUTH_LABELS = {
	OAUTH: "Codex OAuth (ChatGPT Plus/Pro)",
	OAUTH_DEVICE_CODE: "Codex OAuth (Device Code)",
	OAUTH_MANUAL: "Codex OAuth (Manual URL Paste)",
	API_KEY: "Manual API Key (Advanced)",
	INSTRUCTIONS:
		"A browser window should open. If it doesn't, copy the URL and open it manually.",
	INSTRUCTIONS_MANUAL:
		"After logging in, copy the full redirect URL and paste it here.",
} as const;

/** Multi-account configuration */
export const ACCOUNT_LIMITS = {
	/** Maximum number of OAuth accounts that can be registered */
	MAX_ACCOUNTS: 20,
	/** Cooldown period (ms) after auth failure before retrying account */
	AUTH_FAILURE_COOLDOWN_MS: 30_000,
	/** Number of consecutive auth failures before auto-removing account */
	MAX_AUTH_FAILURES_BEFORE_REMOVAL: 3,
	/**
	 * Transient rate-limit window (ms) applied to an account when its local
	 * client-side token bucket is depleted (proactive limiter, not a server
	 * 429). Sized to ~one token refill at the default 6 tokens/min so the
	 * account becomes selectable again as soon as a token regenerates. This
	 * window makes the depleted account ineligible in `isRateLimitedForFamily`,
	 * so every rotation strategy (including drain-first `sticky`, which would
	 * otherwise re-pin the same depleted account and stall the request) advances
	 * to the next account with quota instead of returning a spurious 503.
	 */
	LOCAL_TOKEN_DEPLETION_COOLDOWN_MS: 10_000,
} as const;

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
	/** Current Codex session headers (codex-api/src/requests/headers.rs). */
	SESSION_ID_V2: "session-id",
	THREAD_ID: "thread-id",
	VERSION: "version",
	ROUTING_HINT: "x-codex-routing-hint",
	TURN_STATE: "x-codex-turn-state",
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

/** JWT claim path carrying the signed-in user's email; present on access tokens. */
export const JWT_PROFILE_CLAIM_PATH = "https://api.openai.com/profile" as const;

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
	OAUTH_MANUAL_BROWSER: "Codex OAuth (Open URL Manually)",
	OAUTH_DEVICE_CODE: "Codex OAuth (Device Code)",
	OAUTH_MANUAL: "Codex OAuth (Manual URL Paste)",
	API_KEY: "Manual API Key (Advanced)",
	INSTRUCTIONS_MANUAL_BROWSER:
		"Open this URL in any browser to sign in; sign-in completes automatically through the localhost callback on port 1455.",
	INSTRUCTIONS_MANUAL:
		"After logging in, copy the full redirect URL and paste it here. It carries the state parameter that ties the code to this login attempt.",
} as const;

/** Multi-account configuration */
export const ACCOUNT_LIMITS = {
	/** Maximum number of OAuth accounts that can be registered */
	MAX_ACCOUNTS: 20,
	/** Cooldown period (ms) after auth failure before retrying account */
	AUTH_FAILURE_COOLDOWN_MS: 30_000,
	/** Number of consecutive auth failures before auto-removing account */
	MAX_AUTH_FAILURES_BEFORE_REMOVAL: 3,
} as const;

/**
 * Cap on quota-exhausted model hops within one request (index.ts).
 *
 * The attempted set already stops a request revisiting a model; this bounds
 * total hops even under a cyclic custom chain. It must be at least the longest
 * DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN row (gpt-6-astra's, 7 targets), or a
 * request whose models are blocked one after another stops before reaching the
 * tail of its own default chain. A hop only happens onto a model some account
 * can serve right now, so a larger cap costs nothing when nothing is usable.
 * Kept here rather than in fetch-helpers because test/index.test.ts replaces
 * that module with a factory mock, which would read a new export as undefined.
 */
export const MAX_QUOTA_FALLBACK_SWITCHES = 7;

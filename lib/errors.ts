/**
 * Typed error hierarchy for the Codex plugin.
 *
 * Single source of truth for all domain error classes. `CodexError` plays the
 * role of `BaseError`: every subclass inherits `code: string`, `cause?: unknown`,
 * optional `context`, stack capture, and a stable `name`.
 *
 * Consolidated in RC-3 (docs/audits/07-refactoring-plan.md#rc-3):
 * - `StorageError` moved here from `lib/storage/errors.ts` (that path stays as
 *   a thin re-export so existing imports keep working).
 * - `CircuitOpenError` moved here from `lib/circuit-breaker.ts` (same re-export
 *   compatibility pattern).
 * - New domain classes added: `RecoveryError`, `PromptError`, `RequestError`,
 *   `ConfigError` — used by the throw-site port.
 *
 * All ad-hoc `throw new Error(...)` sites in `lib/**` should throw one of the
 * classes in this file so callers can switch on `err.code` or `instanceof`
 * instead of parsing message strings.
 */

/**
 * Error codes for categorizing errors.
 *
 * These are the default codes attached to each domain class when no explicit
 * `code` is passed. Sub-codes (e.g. `LOAD_FAILED`, `PARSE_JSON_FAILED`) flow
 * through the `options.code` field and remain free-form strings.
 */
export const ErrorCode = {
	NETWORK_ERROR: "CODEX_NETWORK_ERROR",
	API_ERROR: "CODEX_API_ERROR",
	AUTH_ERROR: "CODEX_AUTH_ERROR",
	VALIDATION_ERROR: "CODEX_VALIDATION_ERROR",
	RATE_LIMIT: "CODEX_RATE_LIMIT",
	TIMEOUT: "CODEX_TIMEOUT",
	STORAGE_ERROR: "CODEX_STORAGE_ERROR",
	CIRCUIT_OPEN: "CODEX_CIRCUIT_OPEN",
	RECOVERY_ERROR: "CODEX_RECOVERY_ERROR",
	PROMPT_ERROR: "CODEX_PROMPT_ERROR",
	REQUEST_ERROR: "CODEX_REQUEST_ERROR",
	CONFIG_ERROR: "CODEX_CONFIG_ERROR",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Options for creating a CodexError.
 */
export interface CodexErrorOptions {
	code?: string;
	cause?: unknown;
	context?: Record<string, unknown>;
}

/**
 * Base error class for all Codex plugin errors.
 * Supports error chaining via `cause` and arbitrary context data.
 */
export class CodexError extends Error {
	override readonly name: string = "CodexError";
	readonly code: string;
	readonly context?: Record<string, unknown>;

	constructor(message: string, options?: CodexErrorOptions) {
		super(message, { cause: options?.cause });
		this.code = options?.code ?? ErrorCode.API_ERROR;
		this.context = options?.context;

		// istanbul ignore next -- Error.captureStackTrace always exists in Node.js
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor);
		}
	}
}

/**
 * Options for creating a CodexApiError.
 */
export interface CodexApiErrorOptions extends CodexErrorOptions {
	status: number;
	headers?: Record<string, string>;
}

/**
 * Error for HTTP/API response errors.
 */
export class CodexApiError extends CodexError {
	override readonly name = "CodexApiError";
	readonly status: number;
	readonly headers?: Record<string, string>;

	constructor(message: string, options: CodexApiErrorOptions) {
		super(message, { ...options, code: options.code ?? ErrorCode.API_ERROR });
		this.status = options.status;
		this.headers = options.headers;
	}
}

/**
 * Options for creating a CodexAuthError.
 */
export interface CodexAuthErrorOptions extends CodexErrorOptions {
	accountId?: string;
	retryable?: boolean;
	/**
	 * The underlying token-refresh failure reason, if known. Lets callers
	 * distinguish transient failures (network_error / 5xx http_error) from
	 * genuine auth invalidation (4xx http_error / missing_refresh) so a flaky
	 * network or upstream outage does not count toward permanent account removal.
	 */
	refreshFailureReason?: string;
	/** HTTP status code from the refresh attempt, when reason is http_error. */
	statusCode?: number;
}

/**
 * Error for authentication failures.
 */
export class CodexAuthError extends CodexError {
	override readonly name = "CodexAuthError";
	readonly accountId?: string;
	readonly retryable: boolean;
	readonly refreshFailureReason?: string;
	readonly statusCode?: number;

	constructor(message: string, options?: CodexAuthErrorOptions) {
		super(message, { ...options, code: options?.code ?? ErrorCode.AUTH_ERROR });
		this.accountId = options?.accountId;
		this.retryable = options?.retryable ?? false;
		this.refreshFailureReason = options?.refreshFailureReason;
		this.statusCode = options?.statusCode;
	}
}

/**
 * Options for creating a CodexNetworkError.
 */
export interface CodexNetworkErrorOptions extends CodexErrorOptions {
	retryable?: boolean;
}

/**
 * Error for network/connection failures.
 */
export class CodexNetworkError extends CodexError {
	override readonly name = "CodexNetworkError";
	readonly retryable: boolean;

	constructor(message: string, options?: CodexNetworkErrorOptions) {
		super(message, {
			...options,
			code: options?.code ?? ErrorCode.NETWORK_ERROR,
		});
		this.retryable = options?.retryable ?? true;
	}
}

/**
 * Options for creating a CodexValidationError.
 */
export interface CodexValidationErrorOptions extends CodexErrorOptions {
	field?: string;
	expected?: string;
}

/**
 * Error for input validation failures.
 */
export class CodexValidationError extends CodexError {
	override readonly name = "CodexValidationError";
	readonly field?: string;
	readonly expected?: string;

	constructor(message: string, options?: CodexValidationErrorOptions) {
		super(message, {
			...options,
			code: options?.code ?? ErrorCode.VALIDATION_ERROR,
		});
		this.field = options?.field;
		this.expected = options?.expected;
	}
}

/**
 * Options for creating a CodexRateLimitError.
 */
export interface CodexRateLimitErrorOptions extends CodexErrorOptions {
	retryAfterMs?: number;
	accountId?: string;
}

/**
 * Error for rate limit exceeded.
 */
export class CodexRateLimitError extends CodexError {
	override readonly name = "CodexRateLimitError";
	readonly retryAfterMs?: number;
	readonly accountId?: string;

	constructor(message: string, options?: CodexRateLimitErrorOptions) {
		super(message, { ...options, code: options?.code ?? ErrorCode.RATE_LIMIT });
		this.retryAfterMs = options?.retryAfterMs;
		this.accountId = options?.accountId;
	}
}

/**
 * Error for storage/persistence failures.
 *
 * Positional constructor kept for backward compatibility with existing call
 * sites and test assertions (the class was previously defined in
 * `lib/storage/errors.ts` with this exact signature).
 */
export class StorageError extends CodexError {
	override readonly name = "StorageError";
	readonly path: string;
	readonly hint: string;

	constructor(message: string, code: string, path: string, hint: string, cause?: Error) {
		super(message, { code, cause });
		this.path = path;
		this.hint = hint;
	}
}

/**
 * Options carried by {@link CircuitOpenError} when raised from the request
 * pipeline so callers can classify the short-circuit without parsing the
 * message string.
 */
export interface CircuitOpenErrorOptions {
	/** The breaker key that denied the call, e.g. `account:modelFamily`. */
	breakerKey?: string;
	/** Snapshot of the breaker state at denial time (`open` | `half-open`). */
	state?: "open" | "half-open";
	/** Machine-readable denial reason from `CanAttemptResult`. */
	reason?: "open" | "probe-in-flight";
}

/**
 * Error thrown when a circuit breaker is open (or half-open past its attempt
 * budget) and further calls must short-circuit instead of hitting the
 * protected dependency.
 *
 * When constructed from the request pipeline's gate check, {@link breakerKey},
 * {@link state}, and {@link reason} carry the metadata needed by the rotation
 * path to pick a different account/family without re-querying the breaker.
 */
export class CircuitOpenError extends CodexError {
	override readonly name = "CircuitOpenError";
	readonly breakerKey?: string;
	readonly state?: "open" | "half-open";
	readonly reason?: "open" | "probe-in-flight";

	constructor(message = "Circuit is open", options?: CircuitOpenErrorOptions) {
		super(message, { code: ErrorCode.CIRCUIT_OPEN });
		this.breakerKey = options?.breakerKey;
		this.state = options?.state;
		this.reason = options?.reason;
	}
}

/**
 * Error for session recovery failures (conversation state persistence, id
 * validation, part/message storage integrity).
 */
export class RecoveryError extends CodexError {
	override readonly name = "RecoveryError";

	constructor(message: string, options?: CodexErrorOptions) {
		super(message, {
			...options,
			code: options?.code ?? ErrorCode.RECOVERY_ERROR,
		});
	}
}

/**
 * Error for prompt template fetching or cache failures (GitHub ETag cache,
 * release tag resolution, upstream prompt source fetches).
 */
export class PromptError extends CodexError {
	override readonly name = "PromptError";

	constructor(message: string, options?: CodexErrorOptions) {
		super(message, {
			...options,
			code: options?.code ?? ErrorCode.PROMPT_ERROR,
		});
	}
}

/**
 * Error for request/response pipeline failures that are not auth, network,
 * or rate-limit related (SSE stream shape, missing body, size limits).
 */
export class RequestError extends CodexError {
	override readonly name = "RequestError";

	constructor(message: string, options?: CodexErrorOptions) {
		super(message, {
			...options,
			code: options?.code ?? ErrorCode.REQUEST_ERROR,
		});
	}
}

/**
 * Error for configuration/environment failures (missing TTY, malformed CLI
 * input, bad format flags, missing required options).
 */
export class ConfigError extends CodexError {
	override readonly name = "ConfigError";

	constructor(message: string, options?: CodexErrorOptions) {
		super(message, {
			...options,
			code: options?.code ?? ErrorCode.CONFIG_ERROR,
		});
	}
}

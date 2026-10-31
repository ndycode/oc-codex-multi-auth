import type { Auth, Provider, Model } from "@opencode-ai/sdk";

export type {
	PluginConfigFromSchema as PluginConfig,
	AccountIdSourceFromSchema as AccountIdSource,
	TokenSuccessFromSchema as TokenSuccess,
	TokenFailureFromSchema as TokenFailure,
	TokenResultFromSchema as TokenResult,
	TokenFailureReasonFromSchema as TokenFailureReason,
} from "./schemas.js";

export interface UserConfig {
	global: ConfigOptions;
	models: {
		[modelName: string]: {
			options?: ConfigOptions;
			variants?: Record<string, (ConfigOptions & { disabled?: boolean }) | undefined>;
			[key: string]: unknown;
		};
	};
}

export interface ConfigOptions {
	reasoningEffort?:
		| "none"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max"
		| "ultra";
	reasoningSummary?: "auto" | "concise" | "detailed" | "none" | "off" | "on";
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
	/**
	 * Codex service tier: `fast`/`priority` (Codex "Fast"), `flex`, or
	 * `default` to opt out of a model's catalog default tier.
	 */
	serviceTier?: string;
}

/**
 * Resolved reasoning settings as they go on the wire.
 *
 * `ultra` is deliberately absent: it is a client-side tier that Codex resolves
 * before sending (codex-rs/protocol/src/openai_models/reasoning_effort.rs
 * `resolve_reasoning_effort`), so it must never reach the backend.
 * `summary: "none"` is a request to omit the field; the serializer drops it.
 */
export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	summary: "auto" | "concise" | "detailed" | "none";
	context?: "all_turns";
}

export interface OAuthServerInfo {
	port: number;
	ready: boolean;
	close: () => void;
	waitForCode: (state: string) => Promise<{ code: string } | null>;
}

export interface PKCEPair {
	challenge: string;
	verifier: string;
}

export interface AuthorizationFlow {
	pkce: PKCEPair;
	state: string;
	url: string;
}

/**
 * JWT payload with ChatGPT account info
 */
export interface JWTPayload {
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
		chatgpt_account_user_id?: string;
		chatgpt_plan_type?: string;
		organizations?: unknown;
		email?: string;
		chatgpt_user_email?: string;
	};
	organizations?: unknown;
	orgs?: unknown;
	accounts?: unknown;
	workspaces?: unknown;
	teams?: unknown;
	email?: string;
	preferred_username?: string;
	[key: string]: unknown;
}


/**
 * Message input item
 */
export interface InputItem {
	id?: string;
	type: string;
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

/**
 * Request body structure
 */
export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: unknown;
	reasoning?: Partial<ReasoningConfig>;
	text?: {
		verbosity?: "low" | "medium" | "high";
	};
	include?: string[];
	providerOptions?: {
		openai?: Partial<ConfigOptions> & { store?: boolean; include?: string[] };
		[key: string]: unknown;
	};
	/** Stable key to enable prompt-token caching on Codex backend */
	prompt_cache_key?: string;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	[key: string]: unknown;
}

/**
 * SSE event data structure
 */
export interface SSEEventData {
	type: string;
	response?: unknown;
	[key: string]: unknown;
}

/**
 * Cache metadata for Codex instructions
 */
export interface CacheMetadata {
        etag: string | null;
        tag: string;
        lastChecked: number;
        url: string;
        /**
         * Git-blob SHA-1 of the cached body, recorded at persist time. The
         * offline disk-serve gate hash-binds content against this (falling
         * back to `etag` for entries written before the field existed), so
         * catalog-derived or etag-less upstreams still get a verifiable
         * disk cache instead of an offline dead-end.
         */
        contentSha?: string | null;
}

/**
 * GitHub release data
 */
export interface GitHubRelease {
	tag_name: string;
	[key: string]: unknown;
}

// Re-export SDK types for convenience
export type { Auth, Provider, Model };

export type OAuthAuthDetails = Extract<Auth, { type: "oauth" }> & { scope?: string };

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexNetworkError, CodexTimeoutError, PromptError } from "../errors.js";
import type { CacheMetadata, GitHubRelease } from "../types.js";
import { logWarn, logError, logDebug } from "../logger.js";
import { writeFileAtomic } from "../storage/atomic-write.js";
import { BUNDLED_CODEX_INSTRUCTIONS } from "./codex-instructions.js";

const GITHUB_API_RELEASES =
	"https://api.github.com/repos/openai/codex/releases/latest";
const GITHUB_HTML_RELEASES =
	"https://github.com/openai/codex/releases/latest";
const CACHE_DIR = join(homedir(), ".opencode", "cache");
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Every prompt-path fetch gets a bounded, unref'd timeout. Without one a hung
 * upstream connection would stall the request pipeline forever; the value
 * matches the update-checker's 5s pattern scaled up for the ~300KB catalog.
 */
const PROMPT_FETCH_TIMEOUT_MS = 10_000;

function classifyFetchError(error: unknown, aborted: boolean): Error {
	if (aborted) {
		return new CodexTimeoutError(
			`Prompt fetch timed out after ${PROMPT_FETCH_TIMEOUT_MS}ms`,
			{ cause: error, timeoutMs: PROMPT_FETCH_TIMEOUT_MS },
		);
	}
	return new CodexNetworkError(
		`Prompt fetch failed: ${(error as Error)?.message ?? String(error)}`,
		{ cause: error },
	);
}

/**
 * One deadline and one controller cover request AND body: `fetch()` resolves
 * when headers arrive, so a signal scoped to `fetch` alone stops guarding the
 * body read, and a body-read race that only rejects the reader leaves the
 * socket open. Aborting this controller on timeout cancels the connection
 * itself, which is what releases it.
 */
async function fetchTextWithTimeout(
	url: string,
	init?: RequestInit,
): Promise<{ response: Response; text: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), PROMPT_FETCH_TIMEOUT_MS);
	timeout.unref();
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		const text = await response.text();
		return { response, text };
	} catch (error) {
		throw classifyFetchError(error, controller.signal.aborted);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * The release tag is interpolated into a `raw.githubusercontent.com` path.
 * A tag carrying `/`, `%`, `?`, or `#` — or one made of nothing but dots —
 * escapes the pinned repo path under WHATWG URL normalization
 * (`/openai/codex/../x` collapses to `/openai/x`), letting a compromised or
 * spoofed response redirect the prompt fetch into an arbitrary repository.
 */
const RELEASE_TAG_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const ALL_DOTS_PATTERN = /^\.+$/;

function isValidReleaseTag(tag: string): boolean {
	return RELEASE_TAG_PATTERN.test(tag) && !ALL_DOTS_PATTERN.test(tag);
}

/**
 * Minimum believable size for fetched instructions. Every real prompt file
 * and catalog entry is multi-KB; a shorter body is an error page, an empty
 * 200, or a truncated download — none of which may shadow the bundled
 * instructions or be persisted into the cache.
 */
const MIN_INSTRUCTIONS_LENGTH = 128;

/**
 * HTML document openers. A captive portal, proxy error page, or GitHub HTML
 * response must never be served as a system prompt — the check looks at the
 * document start so XML-ish tags inside a real prompt (`<user_instructions>`)
 * are not false-flagged.
 */
const HTML_DOCUMENT_MARKER = /^\s*<(?:!doctype|html|head|body|\?xml)\b/i;

function isUsableInstructions(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length < MIN_INSTRUCTIONS_LENGTH) return false;
	return !HTML_DOCUMENT_MARKER.test(trimmed.slice(0, 512));
}

/**
 * `lastChecked` is written by a local cache file — same-UID writable, so it
 * is not trustworthy. A stamp in the future (or a non-finite one) would make
 * `now - lastChecked < TTL` hold forever: the planted cache would be served
 * indefinitely with zero network fetches, which is exactly what made the
 * poisoning PoC silent. Non-finite or future stamps mean "can't reason about
 * freshness" and force a real fetch.
 */
function isUsableCacheTimestamp(lastChecked: unknown, now: number): lastChecked is number {
	return (
		typeof lastChecked === "number" &&
		Number.isFinite(lastChecked) &&
		lastChecked >= 0 &&
		lastChecked <= now
	);
}

/**
 * Git-blob SHA-1 of a body — the same digest `raw.githubusercontent.com`
 * publishes as the file's ETag. Recorded in the cache meta on every persist
 * so the offline disk-serve gate has something to hash-bind against even
 * when the upstream response carried no usable etag (catalog-derived
 * instructions, or a 200 with a non-sha validator).
 */
function computeGitBlobSha(content: string): string {
	const payload = Buffer.from(content, "utf8");
	return createHash("sha1")
		.update(`blob ${payload.length}\0`)
		.update(payload)
		.digest("hex");
}

/**
 * `raw.githubusercontent.com` serves the git blob SHA as the ETag. When a 304
 * confirms the cached etag is still current, the disk body is only the real
 * upstream content if its git-blob hash (`sha1|sha256 "blob <len>\0<body>"`)
 * actually equals that etag — otherwise the cache was planted or torn and the
 * bytes must be refetched unconditionally. An etag in any other form cannot
 * bind content, so it fails closed to a refetch rather than trusting bytes.
 */
function isContentBoundToEtag(content: string, etag: string | null): boolean {
	if (!etag) return false;
	const cleaned = etag.trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
	const hex = cleaned.match(/^(?:sha1|sha256):([0-9a-f]+)$/i)?.[1] ?? cleaned;
	if (!/^[0-9a-f]{40}$/i.test(hex) && !/^[0-9a-f]{64}$/i.test(hex)) {
		return false;
	}
	const algorithm = hex.length === 64 ? "sha256" : "sha1";
	const payload = Buffer.from(content, "utf8");
	const digest = createHash(algorithm)
		.update(`blob ${payload.length}\0`)
		.update(payload)
		.digest("hex");
	return digest === hex.toLowerCase();
}

function parseCacheMetadata(metaContent: string, now: number): CacheMetadata | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(metaContent);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const candidate = parsed as Partial<CacheMetadata>;
	if (typeof candidate.tag !== "string" || typeof candidate.url !== "string") {
		return null;
	}
	if (!isUsableCacheTimestamp(candidate.lastChecked, now)) {
		return null;
	}
	const etag = candidate.etag;
	if (etag !== null && etag !== undefined && typeof etag !== "string") {
		return null;
	}
	const contentSha = candidate.contentSha;
	if (
		contentSha !== null &&
		contentSha !== undefined &&
		typeof contentSha !== "string"
	) {
		return null;
	}
	return {
		etag: etag ?? null,
		tag: candidate.tag,
		lastChecked: candidate.lastChecked,
		url: candidate.url,
		contentSha: contentSha ?? null,
	};
}

const MAX_CACHE_SIZE = 50;
/**
 * `memoryCache` holds only content this process fetched (or hash-verified)
 * from GitHub, plus the vendored bundle. Disk bytes are never stored here
 * unverified — which is what makes a same-UID-planted cache file un-servable:
 * the planter can write the cache and its meta, but cannot populate this map
 * without the fetch.
 */
const memoryCache = new Map<string, { content: string; timestamp: number }>();
const refreshPromises = new Map<string, Promise<void>>();
/**
 * Keys whose last upstream exchange failed. A failed fetch is retried only
 * after `CACHE_TTL_MS`, so an offline window serves the fallback once instead
 * of paying a timeout stall on every call — and a planted cache can only
 * reach output while the trusted source is genuinely unreachable.
 */
const fetchFailedAt = new Map<string, number>();
const RELEASE_TAG_TTL_MS = 5 * 60 * 1000;
let latestReleaseTagCache: { tag: string; checkedAt: number } | null = null;

/**
 * Clear the memory cache - exposed for testing
 * @internal
 */
export function __clearCacheForTesting(): void {
	memoryCache.clear();
	refreshPromises.clear();
	fetchFailedAt.clear();
	catalogMemo = null;
	catalogInflight = null;
	latestReleaseTagCache = null;
}

function setCacheEntry(key: string, value: { content: string; timestamp: number }): void {
	if (memoryCache.size >= MAX_CACHE_SIZE && !memoryCache.has(key)) {
		const firstKey = memoryCache.keys().next().value;
		// istanbul ignore next -- defensive: firstKey always exists when size >= MAX_CACHE_SIZE
		if (firstKey) memoryCache.delete(firstKey);
	}
	memoryCache.set(key, value);
}

/**
 * Model family type for prompt selection
 * Maps to different system prompts in the Codex CLI
 */
export type ModelFamily =
	| "gpt-5-codex"
	| "codex-max"
	| "codex"
	| "gpt-6-astra"
	| "gpt-6.1-sol"
	| "gpt-6.1-terra"
	| "gpt-6-sol"
	| "gpt-6-luna"
	| "gpt-daybreak-blue"
	| "gpt-daybreak-red"
	| "gpt-5.6-cyber"
	| "gpt-5.6-sol"
	| "gpt-5.6-terra"
	| "gpt-5.6-luna"
	| "gpt-5.4"
	| "gpt-5.4-mini"
	| "gpt-5.4-pro"
	| "gpt-5.2"
	| "gpt-5.1";

/**
 * All supported model families
 * Used for per-family account rotation and rate limit tracking
 */
export const MODEL_FAMILIES: readonly ModelFamily[] = [
	"gpt-5-codex",
	"codex-max",
	"codex",
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6.1-terra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-daybreak-blue",
	"gpt-daybreak-red",
	"gpt-5.6-cyber",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-pro",
	"gpt-5.2",
	"gpt-5.1",
] as const;

/**
 * Prompt file mapping for each model family
 * Based on codex-rs/core/src/model_family.rs logic
 */
const PROMPT_FILES: Record<ModelFamily, string> = {
	"gpt-5-codex": "gpt_5_codex_prompt.md",
	"codex-max": "gpt-5.1-codex-max_prompt.md",
	codex: "gpt_5_codex_prompt.md",
	// Fallback only. The GPT-6 and 5.6 tiers and Daybreak source their real
	// instructions from the model catalog (see CATALOG_SLUGS); this file is used
	// only when the release tag has no usable catalog entry for the slug.
	"gpt-6-astra": "gpt_5_2_prompt.md",
	"gpt-6.1-sol": "gpt_5_2_prompt.md",
	"gpt-6.1-terra": "gpt_5_2_prompt.md",
	"gpt-6-sol": "gpt_5_2_prompt.md",
	"gpt-6-luna": "gpt_5_2_prompt.md",
	"gpt-daybreak-blue": "gpt_5_2_prompt.md",
	"gpt-daybreak-red": "gpt_5_2_prompt.md",
	"gpt-5.6-cyber": "gpt_5_2_prompt.md",
	"gpt-5.6-sol": "gpt_5_2_prompt.md",
	"gpt-5.6-terra": "gpt_5_2_prompt.md",
	"gpt-5.6-luna": "gpt_5_2_prompt.md",
	// As of Codex rust-v0.111.0, GPT-5.4 uses the same prompt file family as GPT-5.2.
	"gpt-5.4": "gpt_5_2_prompt.md",
	// GPT-5.4-mini uses the same core prompt file as GPT-5.4, but keeps isolated cache/family state.
	"gpt-5.4-mini": "gpt_5_2_prompt.md",
	// GPT-5.4-pro uses the same core prompt file as GPT-5.4, but keeps isolated cache/family state.
	"gpt-5.4-pro": "gpt_5_2_prompt.md",
	"gpt-5.2": "gpt_5_2_prompt.md",
	"gpt-5.1": "gpt_5_1_prompt.md",
};

/**
 * Cache file mapping for each model family
 */
const CACHE_FILES: Record<ModelFamily, string> = {
	"gpt-5-codex": "gpt-5-codex-instructions.md",
	"codex-max": "codex-max-instructions.md",
	codex: "codex-instructions.md",
	"gpt-6-astra": "gpt-6-astra-instructions.md",
	"gpt-6.1-sol": "gpt-6.1-sol-instructions.md",
	"gpt-6.1-terra": "gpt-6.1-terra-instructions.md",
	"gpt-6-sol": "gpt-6-sol-instructions.md",
	"gpt-6-luna": "gpt-6-luna-instructions.md",
	"gpt-daybreak-blue": "gpt-daybreak-blue-instructions.md",
	"gpt-daybreak-red": "gpt-daybreak-red-instructions.md",
	"gpt-5.6-cyber": "gpt-5.6-cyber-instructions.md",
	"gpt-5.6-sol": "gpt-5.6-sol-instructions.md",
	"gpt-5.6-terra": "gpt-5.6-terra-instructions.md",
	"gpt-5.6-luna": "gpt-5.6-luna-instructions.md",
	"gpt-5.4": "gpt-5.4-instructions.md",
	"gpt-5.4-mini": "gpt-5.4-mini-instructions.md",
	"gpt-5.4-pro": "gpt-5.4-pro-instructions.md",
	"gpt-5.2": "gpt-5.2-instructions.md",
	"gpt-5.1": "gpt-5.1-instructions.md",
};

/**
 * Canonical model ids whose base instructions live in the Codex model catalog
 * (`codex-rs/models-manager/models.json`) rather than in a `*_prompt.md` file.
 *
 * Modern Codex carries a full `base_instructions` string per model in the
 * catalog and sends that, not the legacy prompt files. The two differ
 * substantially: `gpt_5_2_prompt.md` opens "You are GPT-5.2 running in the
 * Codex CLI", while every catalog entry opens "You are Codex, ... based on
 * GPT-5". Models absent from the catalog (gpt-5-codex, gpt-5.1*, gpt-5.4-nano,
 * gpt-5.4-pro, gpt-5.2-codex) still use their prompt file.
 *
 * Keyed by model id, not by family: `gpt-5.5` and `gpt-5.4` share the
 * `gpt-5.4` family but have different catalog text, so a family-keyed cache
 * would let one poison the other.
 */
const CATALOG_SLUGS: ReadonlySet<string> = new Set([
	"gpt-5.2",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	// Present in the catalog as of rust-v0.153.0.
	"gpt-daybreak-blue-latest",
	"gpt-daybreak-red-latest",
	// Astra's first catalog entry (openai/codex ed391d4d) shipped an empty
	// `base_instructions`; its text now lives in `instructions_template`.
	"gpt-6-astra",
	// Added to the catalog 2026-09-22 (openai/codex 49e95cc7). A release tag
	// that predates them has no entry, and they fall back to the prompt file.
	"gpt-6-sol",
	"gpt-6-luna",
	// Added on main 2026-09-29 (openai/codex b1e72963, PR #49318) but not yet
	// in a release tag at 6.25.x time — rust-v0.159.0 predates the commit.
	// Until a tag ships it, `base_instructions`-less slug misses fall back to
	// the prompt file, exactly like the Sol/Luna window above.
	"gpt-6.1-sol",
	"gpt-6.1-terra",
]);

const CATALOG_PATH = "codex-rs/models-manager/models.json";

/**
 * Where one model's instructions come from, and where they are cached.
 *
 * Catalog-sourced instructions cache per model id; file-sourced instructions
 * cache per family, preserving the historical layout.
 */
interface InstructionSource {
	/** Memory-cache and in-flight-refresh key. */
	key: string;
	cacheFile: string;
	cacheMetaFile: string;
	/** Prompt file: the source for non-catalog models, and the catalog fallback. */
	promptFile: string;
	/** Set when the model has catalog `base_instructions`. */
	catalogSlug?: string;
}

function resolveInstructionSource(normalizedModel: string): InstructionSource {
	const modelFamily = getModelFamily(normalizedModel);
	const promptFile = PROMPT_FILES[modelFamily];
	const slug = normalizedModel.toLowerCase();
	const catalogSlug = CATALOG_SLUGS.has(slug) ? slug : undefined;

	// Distinct filenames keep catalog content from being served out of a disk
	// cache written by the older prompt-file source, and vice versa.
	const baseName = catalogSlug
		? `catalog-${catalogSlug}-instructions.md`
		: CACHE_FILES[modelFamily];

	// Namespace the key: slug-space and family-space overlap. `gpt-5.4-nano` has
	// no catalog entry and belongs to the `gpt-5.4` family, which is also a
	// catalog slug — an un-namespaced key would let nano and gpt-5.4 serve each
	// other's instructions out of memoryCache/refreshPromises. Same for bare
	// `gpt-5.6` (family `gpt-5.6-sol`) against the `gpt-5.6-sol` slug.
	const key = catalogSlug ? `catalog:${catalogSlug}` : `family:${modelFamily}`;

	return {
		key,
		cacheFile: join(CACHE_DIR, baseName),
		cacheMetaFile: join(CACHE_DIR, baseName.replace(".md", "-meta.json")),
		promptFile,
		catalogSlug,
	};
}

/**
 * models.json is ~300KB and shared by every catalog-sourced model, so fetch it
 * once per release tag instead of once per model.
 */
let catalogMemo: { tag: string; text: string; timestamp: number } | null = null;

/**
 * In-flight fetch, shared by callers that arrive before the first one resolves.
 *
 * Without this, `prewarmCodexInstructions` — which fires every catalog model
 * concurrently via `void getCodexInstructions(...)` — would have each of them
 * miss the (not yet populated) memo and download models.json independently.
 */
let catalogInflight: { tag: string; promise: Promise<string> } | null = null;

async function fetchCatalogText(tag: string): Promise<string> {
	const now = Date.now();
	if (catalogMemo && catalogMemo.tag === tag && now - catalogMemo.timestamp < CACHE_TTL_MS) {
		return catalogMemo.text;
	}
	if (catalogInflight && catalogInflight.tag === tag) {
		return catalogInflight.promise;
	}

	const url = `https://raw.githubusercontent.com/openai/codex/${tag}/${CATALOG_PATH}`;
	const promise = (async () => {
		const { response, text } = await fetchTextWithTimeout(url);
		if (!response.ok) {
			throw new PromptError(`HTTP ${response.status}`, {
				code: "HTTP_ERROR",
				context: { status: response.status },
			});
		}
		// Only a successful fetch populates the memo; a failure leaves any prior
		// value untouched and lets the next caller retry.
		catalogMemo = { tag, text, timestamp: Date.now() };
		return text;
	})();

	const entry = { tag, promise };
	catalogInflight = entry;
	try {
		return await promise;
	} finally {
		if (catalogInflight === entry) {
			catalogInflight = null;
		}
	}
}

interface CatalogModelEntry {
	slug?: string;
	base_instructions?: string;
	model_messages?: {
		instructions_template?: string | null;
		instructions_variables?: { personality_default?: string | null } | null;
	} | null;
}

/** Codex's `PERSONALITY_PLACEHOLDER` (codex-rs/protocol/src/openai_models.rs). */
const PERSONALITY_PLACEHOLDER = "{{ personality }}";

/**
 * Pull one model's base instructions out of a raw models.json payload.
 *
 * openai/codex #43604 (2026-09-07) dropped `base_instructions` from every
 * bundled catalog entry; the text now lives in
 * `model_messages.instructions_template`. rust-v0.155.1 carries only the
 * template for all nine of its models, so reading `base_instructions` alone
 * served the legacy prompt file to every catalog model. The template is rendered the
 * way Codex renders it with personality disabled
 * (codex-rs/models-manager/src/model_info.rs): the placeholder takes
 * `personality_default`, which is "" for every entry that carries one.
 * `base_instructions` still wins when present, for tags that predate the move.
 *
 * @returns The instructions, or null when the tag predates the slug.
 */
export function extractCatalogInstructions(
	rawCatalog: string,
	slug: string,
): string | null {
	let parsed: { models?: CatalogModelEntry[] } | null;
	try {
		parsed = JSON.parse(rawCatalog) as { models?: CatalogModelEntry[] } | null;
	} catch {
		return null;
	}
	// Valid JSON is not necessarily an object: "null" parses, and reading
	// `.models` off it threw instead of reporting "no entry".
	if (typeof parsed !== "object" || parsed === null) return null;
	const models = Array.isArray(parsed.models) ? parsed.models : [];
	const entry = models.find((model) => model?.slug === slug);
	const instructions = entry?.base_instructions;
	if (typeof instructions === "string" && instructions.length > 0) {
		return instructions;
	}
	const template = entry?.model_messages?.instructions_template;
	if (typeof template !== "string" || template.length === 0) {
		return null;
	}
	const personality =
		entry?.model_messages?.instructions_variables?.personality_default ?? "";
	const rendered = template.split(PERSONALITY_PLACEHOLDER).join(personality);
	return rendered.trim().length > 0 ? rendered : null;
}

const CODEX_IDENTITY_LINE_PATTERNS = [
	/^You are .*? running in the Codex CLI, a terminal-based coding assistant\./,
	/^You are Codex, based on GPT-5\. You are running as a coding agent in the Codex CLI on a user's computer\./,
] as const;

export function getBackendInstructionIdentityLine(
	normalizedModel: string,
): string {
	return `You are the model identified to the backend as ${normalizedModel}, running in the Codex CLI, a terminal-based coding assistant.`;
}

export function ensureInstructionIdentity(
	instructions: string | undefined,
	normalizedModel: string,
): string {
	const identityLine = getBackendInstructionIdentityLine(normalizedModel);
	if (!instructions?.trim()) {
		return identityLine;
	}
	for (const pattern of CODEX_IDENTITY_LINE_PATTERNS) {
		if (pattern.test(instructions)) {
			return instructions.replace(pattern, identityLine);
		}
	}
	if (instructions.startsWith(identityLine)) {
		return instructions;
	}
	return `${identityLine}\n\n${instructions}`;
}

/**
 * Determine the model family based on the normalized model name
 * @param normalizedModel - The normalized model name (e.g., "gpt-5-codex", "gpt-5.1-codex-max", "gpt-5.2", "gpt-5.1")
 * @returns The model family for prompt selection
 */
export function getModelFamily(normalizedModel: string): ModelFamily {
	// GPT-6 Astra and the Daybreak tiers are matched before the `codex`
	// branches below. No `gpt-6-codex` or `daybreak-codex` slug exists, so
	// there is nothing here for the codex catch-all to legitimately claim —
	// but a display name like "GPT 6 Astra (Codex OAuth)" would otherwise be
	// swallowed by it and routed to the wrong prompt family.
	if (/\bdaybreak(?:-| )blue(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-daybreak-blue";
	}
	if (/\bdaybreak(?:-| )red(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-daybreak-red";
	}
	// Must precede the bare `gpt-5.6` branch, which would otherwise claim
	// `gpt-5.6-cyber` for the Sol family and serve it Sol's instructions.
	if (/\bgpt(?:-| )5\.6(?:-| )cyber(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-5.6-cyber";
	}
	// GPT-6.1 must precede the bare `gpt-6` branch: the `.` after `6` is a word
	// boundary, so `gpt-6.1-*` would otherwise be claimed for Astra. Terra
	// keeps its own family; a bare `gpt-6.1` selector joins Sol.
	if (/\bgpt(?:-| )6\.1(?:-| )terra(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-6.1-terra";
	}
	if (/\bgpt(?:-| )6\.1(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-6.1-sol";
	}
	// Sol and Luna must precede the bare `gpt-6` branch, which would otherwise
	// claim both for Astra and share its rotation state.
	if (/\bgpt(?:-| )6(?:-| )sol(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-6-sol";
	}
	if (/\bgpt(?:-| )6(?:-| )luna(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-6-luna";
	}
	if (/\bgpt(?:-| )6(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-6-astra";
	}
	if (normalizedModel.includes("codex-max")) {
		return "codex-max";
	}
	if (
		normalizedModel.includes("gpt-5-codex") ||
		normalizedModel.includes("gpt 5 codex") ||
		normalizedModel.includes("gpt-5.3-codex-spark") ||
		normalizedModel.includes("gpt 5.3 codex spark") ||
		normalizedModel.includes("gpt-5.3-codex") ||
		normalizedModel.includes("gpt 5.3 codex") ||
		normalizedModel.includes("gpt-5.2-codex") ||
		normalizedModel.includes("gpt 5.2 codex") ||
		normalizedModel.includes("gpt-5.1-codex") ||
		normalizedModel.includes("gpt 5.1 codex")
	) {
		return "gpt-5-codex";
	}
	if (
		normalizedModel.includes("codex") ||
		normalizedModel.startsWith("codex-")
	) {
		return "codex";
	}
	// GPT-5.6 tiers each get an isolated family so per-family rotation and
	// rate-limit state stay separate. Bare `gpt-5.6` follows the Sol alias.
	if (/\bgpt(?:-| )5\.6(?:-| )terra(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-5.6-terra";
	}
	if (/\bgpt(?:-| )5\.6(?:-| )luna(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-5.6-luna";
	}
	if (/\bgpt(?:-| )5\.6(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-5.6-sol";
	}
	// GPT-5.5 Pro is ChatGPT-only per the 2026-04-23 launch and is not
	// routed through Codex. Any `gpt-5.5-pro*` that still reaches this path
	// (through aliases or user config) gets the general 5.4 prompt family.
	if (/\bgpt(?:-| )5\.5(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-5.4";
	}
	if (/\bgpt(?:-| )5\.4(?:-| )pro(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-5.4-pro";
	}
	if (/\bgpt(?:-| )5\.4(?:-| )mini(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-5.4-mini";
	}
	if (/\bgpt(?:-| )5\.4(?:\b|[- ])/i.test(normalizedModel)) {
		return "gpt-5.4";
	}
	if (normalizedModel.includes("gpt-5.2")) {
		return "gpt-5.2";
	}
	return "gpt-5.1";
}

function rewriteInstructionIdentity(
	instructions: string,
	normalizedModel: string,
): string {
	const identityLine = getBackendInstructionIdentityLine(normalizedModel);
	for (const pattern of CODEX_IDENTITY_LINE_PATTERNS) {
		if (pattern.test(instructions)) {
			return instructions.replace(pattern, identityLine);
		}
	}
	return instructions;
}

async function readFileOrNull(path: string): Promise<string | null> {
	try {
		return await fs.readFile(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Get the latest release tag from GitHub
 * @returns Release tag name (e.g., "rust-v0.43.0")
 */
async function getLatestReleaseTag(): Promise<string> {
	if (
		latestReleaseTagCache &&
		Date.now() - latestReleaseTagCache.checkedAt < RELEASE_TAG_TTL_MS
	) {
		return latestReleaseTagCache.tag;
	}

	try {
		const { response, text } = await fetchTextWithTimeout(GITHUB_API_RELEASES);
		if (response.ok) {
			const data = JSON.parse(text) as GitHubRelease;
			if (typeof data.tag_name === "string" && isValidReleaseTag(data.tag_name)) {
				latestReleaseTagCache = {
					tag: data.tag_name,
					checkedAt: Date.now(),
				};
				return data.tag_name;
			}
			if (data.tag_name) {
				logWarn("Ignoring malformed GitHub release tag_name", {
					tagName: String(data.tag_name).slice(0, 64),
				});
			}
		}
	} catch {
		// Fall through to HTML fallback
	}

	const { response: htmlResponse, text: html } = await fetchTextWithTimeout(
		GITHUB_HTML_RELEASES,
	);
	if (!htmlResponse.ok) {
		throw new PromptError(
			`Failed to fetch latest release: ${htmlResponse.status}`,
			{
				code: "RELEASE_FETCH_FAILED",
				context: { status: htmlResponse.status, url: GITHUB_HTML_RELEASES },
			},
		);
	}

	const finalUrl = htmlResponse.url;
	if (finalUrl) {
		const parts = finalUrl.split("/tag/");
		const last = parts[parts.length - 1];
		if (last && isValidReleaseTag(last)) {
			latestReleaseTagCache = {
				tag: last,
				checkedAt: Date.now(),
			};
			return last;
		}
	}

	const match = html.match(/\/openai\/codex\/releases\/tag\/([^"]+)/);
	if (match && match[1] && isValidReleaseTag(match[1])) {
		const tag = match[1];
		latestReleaseTagCache = {
			tag,
			checkedAt: Date.now(),
		};
		return tag;
	}

	throw new PromptError("Failed to determine latest release tag from GitHub", {
		code: "RELEASE_TAG_UNKNOWN",
	});
}

/**
 * Fetch Codex instructions from GitHub with ETag-based caching
 * Uses HTTP conditional requests to efficiently check for updates
 * Always fetches from the latest release tag, not main branch
 *
 * Rate limit protection: Only checks GitHub if cache is older than 15 minutes
 *
 * @param normalizedModel - The normalized model name (optional, defaults to "gpt-5-codex")
 * @returns Codex instructions for the specified model family
 */
export async function getCodexInstructions(
	normalizedModel = "gpt-5-codex",
): Promise<string> {
	const source = resolveInstructionSource(normalizedModel);
	const { key, cacheFile, cacheMetaFile } = source;
	const now = Date.now();
	// Memory entries exist only because this process fetched them — serving
	// one never involves trusting a writable file.
	const cached = memoryCache.get(key);
	if (cached && now - cached.timestamp < CACHE_TTL_MS) {
		return rewriteInstructionIdentity(cached.content, normalizedModel);
	}

	let cachedMetadata: CacheMetadata | null = null;
	const [metaContent, diskContent] = await Promise.all([
		readFileOrNull(cacheMetaFile),
		readFileOrNull(cacheFile),
	]);

	if (metaContent) {
		// A meta file whose `lastChecked` is missing, non-finite, or in the
		// future is treated as absent: the cache cannot prove freshness, so the
		// only honest path is a real fetch rather than indefinite cache service.
		cachedMetadata = parseCacheMetadata(metaContent, now);
	}

	// The cache file is same-UID writable and an earlier version could have
	// persisted an empty/error-page body, so disk content gets the same
	// sanity check as a fresh fetch. A file that fails is treated as absent:
	// it must not be served, and it must not shield a bundled fallback.
	const usableDiskContent =
		diskContent && isUsableInstructions(diskContent) ? diskContent : null;
	// Sanity alone cannot vet a disk body — plausible bytes are exactly what
	// a same-UID planter writes. Offline service additionally requires the
	// recorded etag to hash-bind the content (the same proof the 304 path
	// demands of upstream), so a failed fetch can never open a window in
	// which a planted body is trusted (greptile P1 on PR #281).
	const verifiedDiskContent =
		usableDiskContent &&
		isContentBoundToEtag(
			usableDiskContent,
			cachedMetadata?.contentSha ?? cachedMetadata?.etag ?? null,
		)
			? usableDiskContent
			: null;

	const lastFailed = fetchFailedAt.get(key);
	const upstreamRecentlyFailed =
		lastFailed !== undefined && now - lastFailed < CACHE_TTL_MS;

	if (cached) {
		// Stale but fetched-here content: serve it while revalidating, unless a
		// very recent refresh already failed — then serve it as-is instead of
		// paying a doomed fetch on every call inside an offline window.
		setCacheEntry(key, { content: cached.content, timestamp: now });
		if (!upstreamRecentlyFailed) {
			void refreshInstructionsInBackground(source, cachedMetadata);
		}
		return rewriteInstructionIdentity(cached.content, normalizedModel);
	}

	// No verified content: the trusted source must be hit before any cache
	// bytes may serve. A same-UID planter can write a plausible body plus a
	// past `lastChecked`, but cannot make GitHub acknowledge it — the fetch
	// below either returns real content (or a 304 whose etag binds the disk
	// body by hash) or fails, which is the only state in which the disk cache
	// is a fallback.
	if (!upstreamRecentlyFailed) {
		try {
			const instructions = await fetchAndPersistInstructions(source, cachedMetadata);
			return rewriteInstructionIdentity(instructions, normalizedModel);
		} catch (error) {
			fetchFailedAt.set(key, Date.now());
			const err = error as Error;
			logError(`Failed to fetch ${key} instructions from GitHub: ${err.message}`);
		}
	}

	if (verifiedDiskContent) {
		logWarn(`Using cached ${key} instructions`);
		return rewriteInstructionIdentity(verifiedDiskContent, normalizedModel);
	}

	// Last resort is the vendored copy, not a sibling file: the bundled
	// codex-instructions.md was dropped in v1.0.3, so reading it here threw
	// ENOENT on every offline first run and the caller shipped the request
	// upstream untransformed.
	logWarn(`Falling back to bundled instructions for ${key}`);
	setCacheEntry(key, {
		content: BUNDLED_CODEX_INSTRUCTIONS,
		timestamp: now,
	});
	return rewriteInstructionIdentity(
		BUNDLED_CODEX_INSTRUCTIONS,
		normalizedModel,
	);
}

async function persistInstructions(
	source: InstructionSource,
	instructions: string,
	meta: CacheMetadata,
): Promise<string> {
	// 0700 dir + 0600 atomic writes: the cache is consumed verbatim as a
	// system prompt, so it must not be world-readable or replaceable mid-read
	// by a same-UID process racing the write.
	await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
	// `contentSha` hash-binds the body we are about to write so the offline
	// disk-serve gate can verify it later even when `meta.etag` is null or a
	// non-sha validator — without it a successful catalog fetch could never
	// pass its own offline check (greptile P1 on PR #281).
	const persistedMeta: CacheMetadata = {
		...meta,
		contentSha: computeGitBlobSha(instructions),
	};
	await Promise.all([
		writeFileAtomic(source.cacheFile, instructions),
		writeFileAtomic(source.cacheMetaFile, JSON.stringify(persistedMeta)),
	]);
	setCacheEntry(source.key, { content: instructions, timestamp: Date.now() });
	return instructions;
}

async function fetchAndPersistInstructions(
	source: InstructionSource,
	cachedMetadata: CacheMetadata | null,
): Promise<string> {
	const { key, cacheFile, promptFile, catalogSlug } = source;
	const latestTag = await getLatestReleaseTag();

	if (catalogSlug) {
		const catalogUrl = `https://raw.githubusercontent.com/openai/codex/${latestTag}/${CATALOG_PATH}`;
		// A catalog transport failure must fall through to the prompt-file
		// source rather than propagate: the file is the documented fallback and
		// propagating would turn a flaky raw.githubusercontent.com into a total
		// instructions outage even though the prompt file may still download.
		let fromCatalog: string | null = null;
		try {
			fromCatalog = extractCatalogInstructions(
				await fetchCatalogText(latestTag),
				catalogSlug,
			);
		} catch (error) {
			logWarn(
				`Catalog fetch failed for ${catalogSlug} at ${latestTag}; falling back to ${promptFile}`,
				{ error: String(error) },
			);
		}
		if (fromCatalog !== null && !isUsableInstructions(fromCatalog)) {
			logWarn(
				`Catalog instructions for ${catalogSlug} at ${latestTag} failed sanity checks; falling back to ${promptFile}`,
			);
			fromCatalog = null;
		}
		if (fromCatalog) {
			return persistInstructions(source, fromCatalog, {
				etag: null,
				tag: latestTag,
				lastChecked: Date.now(),
				url: catalogUrl,
			});
		}
		if (fromCatalog === null) {
			// The pinned release predates this model (or the catalog payload was
			// unusable); fall through to the prompt file.
			logWarn(
				`No usable catalog entry for ${catalogSlug} at ${latestTag}; falling back to ${promptFile}`,
			);
		}
	}

	let cachedETag = cachedMetadata?.etag ?? null;
	const cachedTag = cachedMetadata?.tag ?? null;
	const instructionsUrl = `https://raw.githubusercontent.com/openai/codex/${latestTag}/codex-rs/core/${promptFile}`;

	if (cachedTag !== latestTag) {
		cachedETag = null;
	}

	const headers: Record<string, string> = {};
	if (cachedETag) {
		headers["If-None-Match"] = cachedETag;
	}

	let { response, text: fetchedText } = await fetchTextWithTimeout(
		instructionsUrl,
		{ headers },
	);
	if (response.status === 304) {
		const diskContent = await readFileOrNull(cacheFile);
		// A 304 says the etag is current — but the disk body is same-UID
		// writable, so "current etag" alone cannot prove the bytes are the
		// upstream payload. The git blob hash can: serve the disk body only
		// when it hashes to the acknowledged etag, and otherwise refetch
		// unconditionally for the real body.
		if (
			diskContent &&
			isUsableInstructions(diskContent) &&
			isContentBoundToEtag(diskContent, cachedETag)
		) {
			setCacheEntry(key, { content: diskContent, timestamp: Date.now() });
			await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
			await writeFileAtomic(
				source.cacheMetaFile,
				JSON.stringify(
					{
						etag: cachedETag,
						tag: latestTag,
						lastChecked: Date.now(),
						url: instructionsUrl,
						contentSha: computeGitBlobSha(diskContent),
					} satisfies CacheMetadata,
				),
			);
			return diskContent;
		}
		({ response, text: fetchedText } = await fetchTextWithTimeout(
			instructionsUrl,
		));
	}

	if (!response.ok) {
		throw new PromptError(`HTTP ${response.status}`, {
			code: "HTTP_ERROR",
			context: { status: response.status },
		});
	}

	// An empty/whitespace 200 (or an HTML error page that slipped past the
	// status check) must never shadow the bundled prompt or be persisted —
	// reject it here so the caller degrades to the disk cache or the vendored
	// instructions instead of serving junk as a system prompt.
	if (!isUsableInstructions(fetchedText)) {
		throw new PromptError(
			`Fetched instructions for ${key} failed sanity checks (${fetchedText.trim().length} chars)`,
			{ code: "INSTRUCTIONS_UNUSABLE" },
		);
	}

	return persistInstructions(source, fetchedText, {
		etag: response.headers.get("etag"),
		tag: latestTag,
		lastChecked: Date.now(),
		url: instructionsUrl,
	});
}

function refreshInstructionsInBackground(
	source: InstructionSource,
	cachedMetadata: CacheMetadata | null,
): Promise<void> {
	const existing = refreshPromises.get(source.key);
	if (existing) return existing;

	const refreshPromise = fetchAndPersistInstructions(source, cachedMetadata)
		.then(() => undefined)
		.catch((error) => {
			// Mark the upstream as recently failed so the next call does not
			// immediately schedule another doomed refresh — the stale verified
			// entry keeps serving until the retry window passes.
			fetchFailedAt.set(source.key, Date.now());
			logDebug(`Background prompt refresh failed for ${source.key}`, {
				error: String(error),
			});
		})
		.finally(() => {
			refreshPromises.delete(source.key);
		});

	refreshPromises.set(source.key, refreshPromise);
	return refreshPromise;
}

/**
 * Prewarm instruction caches for the provided models/families.
 */
export function prewarmCodexInstructions(models: string[] = []): void {
	// The Daybreak tiers are deliberately absent: they are `visibility: "hide"`
	// opt-in ids, so prewarming them for every user would warm a cache almost
	// nobody reads. Callers that do use them pass them in explicitly.
	const candidates = models.length > 0 ? models : ["gpt-5-codex", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-pro", "gpt-5.2", "gpt-5.1"];
	for (const model of candidates) {
		void getCodexInstructions(model).catch((error) => {
			logDebug("Codex instruction prewarm failed", {
				model,
				error: String(error),
			});
		});
	}
}

/**
 * Tool remapping instructions for opencode tools
 */
export const TOOL_REMAP_MESSAGE = `<user_instructions priority="0">
<environment_override priority="0">
YOU ARE IN A DIFFERENT ENVIRONMENT. These instructions override ALL previous tool references.
</environment_override>

<tool_replacements priority="0">
<critical_rule priority="0">
Patch-edit tool names differ by runtime (for example: apply_patch, patch, edit).
- Always use the exact tool names listed in the active tool schema/manifest
- If the schema exposes apply_patch, call apply_patch directly
- If the schema exposes patch/edit instead, use patch/edit as listed
- Never invent aliases or auto-translate tool names
</critical_rule>

<critical_rule priority="0">
❌ UPDATE_PLAN DOES NOT EXIST → ✅ USE "todowrite" INSTEAD
- NEVER use: update_plan, updatePlan
- ALWAYS use: todowrite for ALL task/plan operations
- Use todoread to read current plan
- Before plan operations: Verify you're using "todowrite", NOT "update_plan"
</critical_rule>
</tool_replacements>

<available_tools priority="0">
Note: This list is illustrative. Always defer to the active tool schema/manifest.
File Operations:
  • write  - Create new files
  • edit   - Modify existing files with string replacement
  • patch  - Apply diff patches
  • apply_patch - Apply diff patches (alternate runtime name; use whichever the schema exposes)
  • read   - Read file contents

Search/Discovery:
  • grep   - Search file contents
  • glob   - Find files by pattern
  • list   - List directories

Execution:
  • bash   - Run shell commands

Network:
  • webfetch - Fetch web content

Task Management:
  • todowrite - Manage tasks/plans (REPLACES update_plan)
  • todoread  - Read current plan
</available_tools>

<tool_call_guardrails priority="0">
- Call only tool names listed in the active tool schema.
- Do not invent wrapper namespaces (for example functions.task or multi_tool_use.parallel) unless explicitly listed.
- Follow each tool's required path format instead of forcing absolute or relative paths globally.
</tool_call_guardrails>

<substitution_rules priority="0">
Base instruction says:    Correct behaviour:
apply_patch/patch      →   use the exact tool name from the active schema (no renaming)
update_plan           →   todowrite
read_plan             →   todoread
</substitution_rules>

<verification_checklist priority="0">
Before file/plan modifications:
1. Am I using the exact patch/edit (including apply_patch when exposed) tool name listed by the active schema?
2. Am I using "todowrite" NOT "update_plan"?
3. Is this tool in the approved list above?
4. Am I following the active tool schema (including path format)?

If ANY answer is NO → STOP and correct before proceeding.
</verification_checklist>

<safety_rules priority="0">
- Never run destructive git commands (\`git reset --hard\`, \`git checkout --\`) unless explicitly requested by the user.
- Never call \`request_user_input\` unless collaboration mode is explicitly Plan mode.
</safety_rules>
</user_instructions>`;

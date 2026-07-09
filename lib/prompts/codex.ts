import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PromptError } from "../errors.js";
import type { CacheMetadata, GitHubRelease } from "../types.js";
import { logWarn, logError, logDebug } from "../logger.js";

const GITHUB_API_RELEASES =
	"https://api.github.com/repos/openai/codex/releases/latest";
const GITHUB_HTML_RELEASES =
	"https://github.com/openai/codex/releases/latest";
const CACHE_DIR = join(homedir(), ".opencode", "cache");
const CACHE_TTL_MS = 15 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_CACHE_SIZE = 50;
const memoryCache = new Map<string, { content: string; timestamp: number }>();
const refreshPromises = new Map<string, Promise<void>>();
const RELEASE_TAG_TTL_MS = 5 * 60 * 1000;
let latestReleaseTagCache: { tag: string; checkedAt: number } | null = null;

/**
 * Clear the memory cache - exposed for testing
 * @internal
 */
export function __clearCacheForTesting(): void {
	memoryCache.clear();
	refreshPromises.clear();
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
	// Fallback only. The 5.6 tiers source their real instructions from the model
	// catalog (see CATALOG_MODEL_SLUGS); this file is used only when the pinned
	// release tag has no catalog entry for the slug.
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
		const response = await fetch(url);
		if (!response.ok) {
			throw new PromptError(`HTTP ${response.status}`, {
				code: "HTTP_ERROR",
				context: { status: response.status },
			});
		}
		const text = await response.text();
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
}

/**
 * Pull one model's `base_instructions` out of a raw models.json payload.
 *
 * @returns The instructions, or null when the tag predates the slug.
 */
export function extractCatalogInstructions(
	rawCatalog: string,
	slug: string,
): string | null {
	let parsed: { models?: CatalogModelEntry[] };
	try {
		parsed = JSON.parse(rawCatalog) as { models?: CatalogModelEntry[] };
	} catch {
		return null;
	}
	const models = Array.isArray(parsed.models) ? parsed.models : [];
	const entry = models.find((model) => model?.slug === slug);
	const instructions = entry?.base_instructions;
	return typeof instructions === "string" && instructions.length > 0
		? instructions
		: null;
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
		const response = await fetch(GITHUB_API_RELEASES);
		if (response.ok) {
			const data = (await response.json()) as GitHubRelease;
			if (data.tag_name) {
				latestReleaseTagCache = {
					tag: data.tag_name,
					checkedAt: Date.now(),
				};
				return data.tag_name;
			}
		}
	} catch {
		// Fall through to HTML fallback
	}

	const htmlResponse = await fetch(GITHUB_HTML_RELEASES);
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
		if (last && !last.includes("/")) {
			latestReleaseTagCache = {
				tag: last,
				checkedAt: Date.now(),
			};
			return last;
		}
	}

	const html = await htmlResponse.text();
	const match = html.match(/\/openai\/codex\/releases\/tag\/([^"]+)/);
	if (match && match[1]) {
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
		try {
			cachedMetadata = JSON.parse(metaContent) as CacheMetadata;
		} catch {
			cachedMetadata = null;
		}
	}

	if (diskContent && cachedMetadata?.lastChecked) {
		if (now - cachedMetadata.lastChecked < CACHE_TTL_MS) {
			setCacheEntry(key, { content: diskContent, timestamp: now });
			return rewriteInstructionIdentity(diskContent, normalizedModel);
		}
		// Stale-while-revalidate: return stale cache immediately and refresh in background.
		setCacheEntry(key, { content: diskContent, timestamp: now });
		void refreshInstructionsInBackground(source, cachedMetadata);
		return rewriteInstructionIdentity(diskContent, normalizedModel);
	}

	if (cached && now - cached.timestamp >= CACHE_TTL_MS) {
		// Keep session latency stable by serving stale memory cache while refreshing.
		setCacheEntry(key, { content: cached.content, timestamp: now });
		void refreshInstructionsInBackground(source, cachedMetadata);
		return rewriteInstructionIdentity(cached.content, normalizedModel);
	}

	try {
		const instructions = await fetchAndPersistInstructions(source, cachedMetadata);
		return rewriteInstructionIdentity(instructions, normalizedModel);
	} catch (error) {
		const err = error as Error;
		logError(`Failed to fetch ${key} instructions from GitHub: ${err.message}`);

		if (diskContent) {
			logWarn(`Using cached ${key} instructions`);
			setCacheEntry(key, { content: diskContent, timestamp: now });
			return rewriteInstructionIdentity(diskContent, normalizedModel);
		}

		logWarn(`Falling back to bundled instructions for ${key}`);
		const bundled = await fs.readFile(
			join(__dirname, "codex-instructions.md"),
			"utf8",
		);
		setCacheEntry(key, { content: bundled, timestamp: now });
		return rewriteInstructionIdentity(bundled, normalizedModel);
	}
}

async function persistInstructions(
	source: InstructionSource,
	instructions: string,
	meta: CacheMetadata,
): Promise<string> {
	await fs.mkdir(CACHE_DIR, { recursive: true });
	await Promise.all([
		fs.writeFile(source.cacheFile, instructions, "utf8"),
		fs.writeFile(source.cacheMetaFile, JSON.stringify(meta), "utf8"),
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
		const fromCatalog = extractCatalogInstructions(
			await fetchCatalogText(latestTag),
			catalogSlug,
		);
		if (fromCatalog) {
			return persistInstructions(source, fromCatalog, {
				etag: null,
				tag: latestTag,
				lastChecked: Date.now(),
				url: catalogUrl,
			});
		}
		// The pinned release predates this model; fall through to the prompt file.
		logWarn(
			`No catalog entry for ${catalogSlug} at ${latestTag}; falling back to ${promptFile}`,
		);
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

	const response = await fetch(instructionsUrl, { headers });
	if (response.status === 304) {
		const diskContent = await readFileOrNull(cacheFile);
		if (diskContent) {
			setCacheEntry(key, { content: diskContent, timestamp: Date.now() });
			await fs.mkdir(CACHE_DIR, { recursive: true });
			await fs.writeFile(
				source.cacheMetaFile,
				JSON.stringify(
					{
						etag: cachedETag,
						tag: latestTag,
						lastChecked: Date.now(),
						url: instructionsUrl,
					} satisfies CacheMetadata,
				),
				"utf8",
			);
			return diskContent;
		}
	}

	if (!response.ok) {
		throw new PromptError(`HTTP ${response.status}`, {
			code: "HTTP_ERROR",
			context: { status: response.status },
		});
	}

	return persistInstructions(source, await response.text(), {
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
	const candidates = models.length > 0 ? models : ["gpt-5-codex", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-pro", "gpt-5.2", "gpt-5.1"];
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

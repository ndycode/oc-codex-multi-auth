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
const refreshPromises = new Map<ModelFamily, Promise<void>>();
const RELEASE_TAG_TTL_MS = 5 * 60 * 1000;
let latestReleaseTagCache: { tag: string; checkedAt: number } | null = null;

/**
 * Clear the memory cache - exposed for testing
 * @internal
 */
export function __clearCacheForTesting(): void {
	memoryCache.clear();
	refreshPromises.clear();
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
 * Model families whose base instructions live in the Codex model catalog
 * (`codex-rs/models-manager/models.json`) rather than in a `*_prompt.md` file.
 *
 * openai/codex ships no 5.6 prompt file. Each 5.6 tier instead carries a full
 * `base_instructions` string in the catalog, and the three tiers do NOT share
 * it — Sol, Terra, and Luna each have distinct text. Falling back to
 * `gpt_5_2_prompt.md` would tell a 5.6 model it is "GPT-5.2 running in the
 * Codex CLI", so the catalog is the only correct source here.
 */
const CATALOG_MODEL_SLUGS: Partial<Record<ModelFamily, string>> = {
	"gpt-5.6-sol": "gpt-5.6-sol",
	"gpt-5.6-terra": "gpt-5.6-terra",
	"gpt-5.6-luna": "gpt-5.6-luna",
};

const CATALOG_PATH = "codex-rs/models-manager/models.json";

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
	const modelFamily = getModelFamily(normalizedModel);
	const now = Date.now();
	const cached = memoryCache.get(modelFamily);
	if (cached && now - cached.timestamp < CACHE_TTL_MS) {
		return rewriteInstructionIdentity(cached.content, normalizedModel);
	}

	const promptFile = PROMPT_FILES[modelFamily];
	const cacheFile = join(CACHE_DIR, CACHE_FILES[modelFamily]);
	const cacheMetaFile = join(
		CACHE_DIR,
		`${CACHE_FILES[modelFamily].replace(".md", "-meta.json")}`,
	);

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
			setCacheEntry(modelFamily, { content: diskContent, timestamp: now });
			return rewriteInstructionIdentity(diskContent, normalizedModel);
		}
		// Stale-while-revalidate: return stale cache immediately and refresh in background.
		setCacheEntry(modelFamily, { content: diskContent, timestamp: now });
		void refreshInstructionsInBackground(
			modelFamily,
			promptFile,
			cacheFile,
			cacheMetaFile,
			cachedMetadata,
		);
		return rewriteInstructionIdentity(diskContent, normalizedModel);
	}

	if (cached && now - cached.timestamp >= CACHE_TTL_MS) {
		// Keep session latency stable by serving stale memory cache while refreshing.
		setCacheEntry(modelFamily, { content: cached.content, timestamp: now });
		void refreshInstructionsInBackground(
			modelFamily,
			promptFile,
			cacheFile,
			cacheMetaFile,
			cachedMetadata,
		);
		return rewriteInstructionIdentity(cached.content, normalizedModel);
	}

	try {
		const instructions = await fetchAndPersistInstructions(
			modelFamily,
			promptFile,
			cacheFile,
			cacheMetaFile,
			cachedMetadata,
		);
		return rewriteInstructionIdentity(instructions, normalizedModel);
	} catch (error) {
		const err = error as Error;
		logError(
			`Failed to fetch ${modelFamily} instructions from GitHub: ${err.message}`,
		);

		if (diskContent) {
			logWarn(`Using cached ${modelFamily} instructions`);
			setCacheEntry(modelFamily, { content: diskContent, timestamp: now });
			return rewriteInstructionIdentity(diskContent, normalizedModel);
		}

		logWarn(`Falling back to bundled instructions for ${modelFamily}`);
		const bundled = await fs.readFile(
			join(__dirname, "codex-instructions.md"),
			"utf8",
		);
		setCacheEntry(modelFamily, { content: bundled, timestamp: now });
		return rewriteInstructionIdentity(bundled, normalizedModel);
	}
}

async function fetchAndPersistInstructions(
	modelFamily: ModelFamily,
	promptFile: string,
	cacheFile: string,
	cacheMetaFile: string,
	cachedMetadata: CacheMetadata | null,
): Promise<string> {
	let cachedETag = cachedMetadata?.etag ?? null;
	const cachedTag = cachedMetadata?.tag ?? null;
	const latestTag = await getLatestReleaseTag();
	const catalogSlug = CATALOG_MODEL_SLUGS[modelFamily];
	const instructionsUrl = catalogSlug
		? `https://raw.githubusercontent.com/openai/codex/${latestTag}/${CATALOG_PATH}`
		: `https://raw.githubusercontent.com/openai/codex/${latestTag}/codex-rs/core/${promptFile}`;

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
			setCacheEntry(modelFamily, { content: diskContent, timestamp: Date.now() });
			await fs.mkdir(CACHE_DIR, { recursive: true });
			await fs.writeFile(
				cacheMetaFile,
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

	const payload = await response.text();
	let instructions = payload;
	if (catalogSlug) {
		const fromCatalog = extractCatalogInstructions(payload, catalogSlug);
		if (fromCatalog) {
			instructions = fromCatalog;
		} else {
			// The pinned release predates this model. Fall back to the family's
			// prompt file rather than persisting a whole models.json as a prompt.
			logWarn(
				`No catalog entry for ${catalogSlug} at ${latestTag}; falling back to ${promptFile}`,
			);
			const fallbackUrl = `https://raw.githubusercontent.com/openai/codex/${latestTag}/codex-rs/core/${promptFile}`;
			const fallbackResponse = await fetch(fallbackUrl);
			if (!fallbackResponse.ok) {
				throw new PromptError(`HTTP ${fallbackResponse.status}`, {
					code: "HTTP_ERROR",
					context: { status: fallbackResponse.status },
				});
			}
			instructions = await fallbackResponse.text();
		}
	}
	const newETag = response.headers.get("etag");
	await fs.mkdir(CACHE_DIR, { recursive: true });
	await Promise.all([
		fs.writeFile(cacheFile, instructions, "utf8"),
		fs.writeFile(
			cacheMetaFile,
			JSON.stringify(
				{
					etag: newETag,
					tag: latestTag,
					lastChecked: Date.now(),
					url: instructionsUrl,
				} satisfies CacheMetadata,
			),
			"utf8",
		),
	]);
	setCacheEntry(modelFamily, { content: instructions, timestamp: Date.now() });
	return instructions;
}

function refreshInstructionsInBackground(
	modelFamily: ModelFamily,
	promptFile: string,
	cacheFile: string,
	cacheMetaFile: string,
	cachedMetadata: CacheMetadata | null,
): Promise<void> {
	const existing = refreshPromises.get(modelFamily);
	if (existing) return existing;

	const refreshPromise = fetchAndPersistInstructions(
		modelFamily,
		promptFile,
		cacheFile,
		cacheMetaFile,
		cachedMetadata,
	)
		.then(() => undefined)
		.catch((error) => {
			logDebug(`Background prompt refresh failed for ${modelFamily}`, {
				error: String(error),
			});
		})
		.finally(() => {
			refreshPromises.delete(modelFamily);
		});

	refreshPromises.set(modelFamily, refreshPromise);
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

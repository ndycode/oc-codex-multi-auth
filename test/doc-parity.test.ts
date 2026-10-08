import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT } from "../lib/oauth-constants.js";
import { transformRequestBody } from "../lib/request/request-transformer.js";
import type { RequestBody, UserConfig } from "../lib/types.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));

function readRepoFile(relativePath: string): string {
	try {
		return readFileSync(path.resolve(testDir, "..", relativePath), "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read ${relativePath}: ${message}`);
	}
}

function collectRepoFiles(relativeDir: string): string[] {
	const root = path.resolve(testDir, "..", relativeDir);
	const results: string[] = [];

	function visit(dir: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
				continue;
			}
			results.push(path.relative(path.resolve(testDir, ".."), fullPath).replaceAll("\\", "/"));
		}
	}

	visit(root);
	return results.sort();
}

function collectCurrentDocumentationFiles(): string[] {
	return [
		"AGENTS.md",
		"README.md",
		"CONTRIBUTING.md",
		"SECURITY.md",
		"CODE_OF_CONDUCT.md",
		"lib/AGENTS.md",
		"lib/tools/AGENTS.md",
		"config/README.md",
		"skills/oc-codex-setup/SKILL.md",
		"test/AGENTS.md",
		"test/README.md",
		...collectRepoFiles("docs").filter((relativePath) =>
			/\.(?:md|yml)$/.test(relativePath),
		),
	].sort();
}

function repoPathExists(relativePath: string): boolean {
	try {
		const stats = statSync(path.resolve(testDir, "..", relativePath));
		return stats.isFile() || stats.isDirectory();
	} catch {
		return false;
	}
}

function repoPathPatternExists(relativePath: string): boolean {
	if (!relativePath.includes("*")) {
		return repoPathExists(relativePath);
	}

	const repoFiles = [
		...collectRepoFiles("config"),
		...collectRepoFiles("docs"),
		...collectRepoFiles("lib"),
		...collectRepoFiles("scripts"),
		...collectRepoFiles("skills"),
		...collectRepoFiles("test"),
	];
	const escaped = relativePath
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join("[^/]*");
	const pattern = new RegExp(`^${escaped}$`);
	return repoFiles.some((repoFile) => pattern.test(repoFile));
}

function normalizeRepoPathReference(rawValue: string): string | null {
	const repoRootFiles = new Set([
		"AGENTS.md",
		"CHANGELOG.md",
		"CODE_OF_CONDUCT.md",
		"CONTRIBUTING.md",
		"LICENSE",
		"README.md",
		"SECURITY.md",
		"eslint.config.js",
		"index.ts",
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		"tui.ts",
		"vitest.config.ts",
	]);
	const repoPrefixes = [
		".github/",
		"assets/",
		"config/",
		"docs/",
		"lib/",
		"scripts/",
		"skills/",
		"test/",
	];

	let value = rawValue
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.replaceAll("\\", "/")
		.replace(/^@\//, "")
		.replace(/^@\./, ".")
		.replace(/^@/, "")
		.replace(/^[./]+/, "");

	if (
		value.length === 0 ||
		value.includes("<") ||
		value.includes(">") ||
		/^(?:https?:|mailto:|#|~\/|[A-Z_]+=)/.test(value) ||
		value.startsWith("dist/")
	) {
		return null;
	}

	value = value
		.replace(/#.*$/, "")
		.replace(/:\d+(?:-\d+)?(?::\d+)?$/, "")
		.replace(/[),.;]+$/, "");

	if (repoRootFiles.has(value) || repoPrefixes.some((prefix) => value.startsWith(prefix))) {
		return value;
	}
	return null;
}

function findMissingLabels(content: string, labels: readonly string[]): string[] {
	return labels.filter((label) => !content.includes(label));
}

describe("runtime documentation parity", () => {
	it("keeps the documented stateless request contract aligned with the runtime transform", async () => {
		const requestBody: RequestBody = {
			model: "gpt-5",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "quota ping" }],
				},
			],
		};
		const userConfig: UserConfig = { global: {}, models: {} };

		const transformedBody = await transformRequestBody(requestBody, "test instructions", userConfig);

		expect(transformedBody.store).toBe(false);
		expect(transformedBody.include).toContain("reasoning.encrypted_content");

		const docsExpectations: Array<[string, string[]]> = [
			[
				"docs/getting-started.md",
				[
					`http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`,
					"`store: false`",
					"`reasoning.encrypted_content`",
				],
			],
			[
				"docs/configuration.md",
				[
					"`reasoning.encrypted_content`",
					"store\": false",
				],
			],
			[
				"docs/development/ARCHITECTURE.md",
				[
					"`store: false`",
					"`reasoning.encrypted_content`",
				],
			],
			[
				"docs/troubleshooting.md",
				[
					"1455",
					"`reasoning.encrypted_content`",
					"auth.json",
					"`~/.local/share/opencode/auth.json`",
				],
			],
			[
				"docs/faq.md",
				[
					"`1455`",
				],
			],
		];

		for (const [relativePath, fragments] of docsExpectations) {
			const fileContents = readRepoFile(relativePath);
			for (const fragment of fragments) {
				expect(fileContents).toContain(fragment);
			}
		}
	});

	it("keeps shipped config examples aligned with the stateless Codex contract", () => {
		const configExpectations: Array<[string, string[]]> = [
			[
				"config/minimal-opencode.json",
				[
					"\"store\": false",
					"\"reasoning.encrypted_content\"",
				],
			],
			[
				"config/opencode-modern.json",
				[
					"\"store\": false",
					"\"reasoning.encrypted_content\"",
				],
			],
			[
				"config/opencode-legacy.json",
				[
					"\"store\": false",
					"\"reasoning.encrypted_content\"",
				],
			],
		];

		for (const [relativePath, fragments] of configExpectations) {
			const fileContents = readRepoFile(relativePath);
			for (const fragment of fragments) {
				expect(fileContents).toContain(fragment);
			}
		}
	});

	// Counts are derived from the shipped templates rather than hardcoded.
	// They were hardcoded once, and adding GPT-6 Astra plus the two Daybreak
	// tiers moved the real catalog from 12/53 to 13/59 while this test kept
	// asserting 12/53 and passing — the installer went on advertising numbers
	// the templates no longer had. Deriving them makes that drift impossible.
	function readTemplateCounts(): {
		bases: number;
		variants: number;
		legacyEntries: number;
	} {
		const modern = JSON.parse(readRepoFile("config/opencode-modern.json")) as {
			provider: {
				openai: { models: Record<string, { variants?: Record<string, unknown> }> };
			};
		};
		const legacy = JSON.parse(readRepoFile("config/opencode-legacy.json")) as {
			provider: { openai: { models: Record<string, unknown> } };
		};
		const modernModels = modern.provider.openai.models;
		return {
			bases: Object.keys(modernModels).length,
			variants: Object.values(modernModels).reduce(
				(total, entry) => total + Object.keys(entry.variants ?? {}).length,
				0,
			),
			legacyEntries: Object.keys(legacy.provider.openai.models).length,
		};
	}

	it("keeps installer help catalog counts aligned with shipped templates", () => {
		const installerHelp = readRepoFile("scripts/install-oc-codex-multi-auth-core.js");
		const { bases, variants, legacyEntries } = readTemplateCounts();

		expect(installerHelp).toContain(`${bases} base OAuth models`);
		expect(installerHelp).toContain(`${variants} explicit selector entries`);
		expect(installerHelp).toContain(`${legacyEntries} preset model entries`);
		expect(installerHelp).toContain(`${bases} base OAuth model entries`);
		expect(installerHelp).toContain(`${legacyEntries} explicit preset entries`);
	});

	it("keeps documented catalog counts aligned with shipped templates", () => {
		const { bases, variants, legacyEntries } = readTemplateCounts();
		// The legacy template lists one explicit id per modern variant, so a
		// drift between the two templates is itself a bug.
		expect(legacyEntries).toBe(variants);

		// Any catalog count quoted in current docs must be the live one.
		//
		// The first version of this matched only "N base" / "N variants", which
		// let fifteen phrasings drift when the legacy template grew from 53 to
		// 59: "53 preset model entries", "53 explicit selector IDs", "53
		// effective variants", "53 individual model keys", and so on. The noun
		// list below covers the phrasings the docs actually use; a new count
		// noun has to be added here too.
		//
		// The `(?<![\d.])` guard keeps model names out of the match: without it
		// "GPT-5.5 variant" reads as the number 5 followed by "variant".
		const qualifier =
			"(?:total|effective|individual|explicit|shipped|preset|modern|legacy|base|OAuth|model|variant|selector|compact)";
		const noun =
			"(?:bases|base|variants|variant|presets|preset|entries|entry|selector IDs?|model IDs?|model keys?|model definitions?|model families|families)";
		const countPattern = new RegExp(
			String.raw`(?<![\d.])(\d+)((?:\s+${qualifier})*)\s+(${noun})\b`,
			"g",
		);

		for (const relativePath of collectCurrentDocumentationFiles()) {
			const contents = readRepoFile(relativePath);
			for (const match of contents.matchAll(countPattern)) {
				const phrase = match[0];
				// "13 base model families" counts bases; "59 preset model entries"
				// counts variants. Anything naming bases or families is the former.
				const countsBases = /bases?\b|model famil/.test(phrase);
				const expected = countsBases ? bases : variants;
				expect(
					Number(match[1]),
					`${relativePath} quotes "${phrase}"; templates ship ${bases} bases / ${variants} variants`,
				).toBe(expected);
			}
		}
	});

	it("keeps the documented tool layout aligned with the live registry", () => {
		const toolFiles = readdirSync(path.resolve(testDir, "..", "lib/tools"))
			.filter((name) => /^codex-[a-z-]+\.ts$/.test(name))
			.map((name) => name.replace(/\.ts$/, ""))
			.sort();
		const registryContents = readRepoFile("lib/tools/index.ts");
		const registeredTools = Array.from(
			registryContents.matchAll(/"(codex-[a-z-]+)":\s*createCodex/g),
			(match) => match[1],
		).sort();

		expect(registeredTools).toEqual(toolFiles);
		expect(registeredTools).toHaveLength(25);

		const docsExpectations: Array<[string, string[]]> = [
			[
				"docs/development/ARCHITECTURE.md",
				[
					"25 OpenCode tools",
					"`codex-list`, `codex-switch`, `codex-warm`",
					"every registered `codex-*` tool is its own file under `lib/tools/`",
				],
			],
			[
				"docs/architecture.md",
				[
					"25 per-file factories",
					"`codex-list`, `codex-switch`, `codex-warm`",
				],
			],
			[
				"docs/development/TESTING.md",
				[
					"Confirm commands exist in `lib/tools/index.ts`",
					"test/tools-codex-*.test.ts",
				],
			],
			[
				"lib/tools/AGENTS.md",
				[
					"25 `codex-*` tools",
					"codex-keychain.ts",
				],
			],
		];

		for (const [relativePath, fragments] of docsExpectations) {
			const fileContents = readRepoFile(relativePath);
			for (const fragment of fragments) {
				expect(fileContents).toContain(fragment);
			}
		}
	});

	it("keeps codex-help advertised topics aligned with implemented sections", () => {
		const helpSource = readRepoFile("lib/tools/codex-help.ts");
		const descriptionMatch = helpSource.match(/Optional topic: ([^.]+)\./);
		expect(descriptionMatch).not.toBeNull();
		const advertisedTopics = (descriptionMatch?.[1] ?? "")
			.split(",")
			.map((topic) => topic.trim())
			.filter(Boolean)
			.sort();
		const sectionTopics = Array.from(
			helpSource.matchAll(/key:\s*"([^"]+)"/g),
			(match) => match[1],
		).sort();

		expect(advertisedTopics).toEqual(sectionTopics);
		expect(advertisedTopics).not.toContain("metrics");
	});

	it("keeps the documented docs layout aligned with the live docs tree", () => {
		const docsFiles = collectRepoFiles("docs");
		const requiredDocs = [
			"docs/_config.yml",
			"docs/DOCUMENTATION.md",
			"docs/README.md",
			"docs/index.md",
			"docs/architecture.md",
			"docs/getting-started.md",
			"docs/configuration.md",
			"docs/troubleshooting.md",
			"docs/faq.md",
			"docs/privacy.md",
			"docs/OPENCODE_PR_PROPOSAL.md",
			"docs/development/ARCHITECTURE.md",
			"docs/development/GITHUB_DISCOVERABILITY.md",
			"docs/development/CONFIG_FIELDS.md",
			"docs/development/CONFIG_FLOW.md",
			"docs/development/TESTING.md",
			"docs/development/TUI_PARITY_CHECKLIST.md",
		];

		for (const relativePath of requiredDocs) {
			expect(docsFiles).toContain(relativePath);
		}

		// The historical audit corpus was removed; nothing may reintroduce a
		// pointer to it without also restoring the files.
		expect(docsFiles.filter((relativePath) => relativePath.startsWith("docs/audits/"))).toEqual(
			[],
		);

		const docsExpectations: Array<[string, string[]]> = [
			[
				"docs/DOCUMENTATION.md",
				[
					"architecture.md",
					"OPENCODE_PR_PROPOSAL.md",
					"GITHUB_DISCOVERABILITY.md",
					"development/",
				],
			],
			[
				"docs/development/ARCHITECTURE.md",
				[
					"## Documentation Layout",
					"DOCUMENTATION.md",
					"OPENCODE_PR_PROPOSAL.md",
				],
			],
		];

		for (const [relativePath, fragments] of docsExpectations) {
			const fileContents = readRepoFile(relativePath);
			for (const fragment of fragments) {
				expect(fileContents).toContain(fragment);
			}
		}
	});

	it("keeps current documentation free of stale structure anchors", () => {
		const stalePatterns: Array<[RegExp, string]> = [
			[/7[- ]step/i, "old fetch-pipeline count"],
			[/AUTH_FLOW\.md/, "removed auth-flow doc"],
			[/(^|[^/])lib\/oauth-success\.html/, "nonexistent OAuth HTML source path"],
			[/request-transformer\.ts:\d+/, "stale request-transformer line anchor"],
			[/fetch-helpers\.ts:\d+/, "stale fetch-helpers line anchor"],
			[/tmp\/(?:codex|opencode)\//, "non-repo temp source path"],
			[/\b19 OpenCode tools\b/, "old tool count"],
			[/\b19 `codex-\*` tools\b/, "old tool count"],
			[/docs\/audits/, "removed historical audit corpus"],
		];
		const hits: string[] = [];

		for (const relativePath of collectCurrentDocumentationFiles()) {
			const fileContents = readRepoFile(relativePath);
			for (const [pattern, label] of stalePatterns) {
				if (pattern.test(fileContents)) {
					hits.push(`${relativePath}: ${label}`);
				}
			}
		}

		expect(hits).toEqual([]);
	});

	it("keeps GitHub CI aligned with the full local validation gate", () => {
		const ciWorkflow = readRepoFile(".github/workflows/ci.yml");
		const requiredCommands = [
			"npm ci",
			"npm run typecheck",
			"npm run lint",
			"npm test",
			"npm run build",
			"npm run audit:ci",
		];

		for (const command of requiredCommands) {
			expect(ciWorkflow).toContain(command);
		}

		expect(ciWorkflow).not.toContain("run: npm run audit:prod");
	});

	it("keeps package metadata aligned with shipped source and install surfaces", () => {
		const packageJson = JSON.parse(readRepoFile("package.json")) as {
			bin?: Record<string, string>;
			description?: string;
			exports?: Record<string, { import?: string; types?: string }>;
			files?: string[];
			keywords?: string[];
			scripts?: Record<string, string>;
			version?: string;
		};
		const requiredPackageFiles = [
			"dist/",
			"assets/",
			"config/",
			"scripts/",
			"README.md",
			"LICENSE",
		];

		expect(packageJson.description).toContain("OpenCode plugin");
		expect(packageJson.description).toContain("ChatGPT Plus/Pro OAuth");
		expect(packageJson.description).toContain("account switching");
		for (const keyword of [
			"opencode-plugin",
			"codex-oauth",
			"account-switching",
			"account-health",
			"quota-management",
			"diagnostics",
			"recovery-tools",
		]) {
			expect(packageJson.keywords).toContain(keyword);
		}

		for (const entry of requiredPackageFiles) {
			expect(packageJson.files).toContain(entry);
			if (entry !== "dist/") {
				expect(repoPathExists(entry.replace(/\/$/, ""))).toBe(true);
			}
		}

		const pluginJson = JSON.parse(readRepoFile(".codex-plugin/plugin.json")) as {
			description?: string;
			version?: string;
			interface?: { composerIcon?: string };
		};
		expect(pluginJson.version).toBe(packageJson.version);
		expect(pluginJson.description).toContain("OpenCode");
		expect(pluginJson.description).toContain("multi-account rotation");
		expect(pluginJson.interface?.composerIcon).toBe("./assets/icon.svg");
		expect(repoPathExists(pluginJson.interface?.composerIcon.replace(/^\.\//, "") ?? "")).toBe(true);

		const installerPath = packageJson.bin?.["oc-codex-multi-auth"];
		expect(installerPath).toBe("scripts/install-oc-codex-multi-auth.js");
		expect(repoPathExists(installerPath ?? "")).toBe(true);
		expect(readRepoFile(installerPath ?? "")).toMatch(/^#!\/usr\/bin\/env node/);
		expect(packageJson.scripts?.build).toContain("node scripts/clean-dist.js");
		expect(repoPathExists("scripts/clean-dist.js")).toBe(true);

		const exports = packageJson.exports ?? {};
		const sourceForExport = new Map([
			["./dist/index.js", "index.ts"],
			["./dist/tui.js", "tui.ts"],
			["./dist/lib/custom-rotation/contract.js", "lib/custom-rotation/contract.ts"],
		]);

		for (const entry of Object.values(exports)) {
			expect(entry.import).toBeDefined();
			expect(entry.types).toBeDefined();
			expect(entry.types).toBe(entry.import?.replace(/\.js$/, ".d.ts"));
			const sourcePath = sourceForExport.get(entry.import ?? "");
			expect(sourcePath).toBeDefined();
			expect(repoPathExists(sourcePath ?? "")).toBe(true);
		}
	});

	it("keeps committed fixtures free of static OpenAI-style secret strings", () => {
		const scannedFiles = [
			"AGENTS.md",
			"README.md",
			"CONTRIBUTING.md",
			"SECURITY.md",
			"package.json",
			...collectRepoFiles(".github"),
			...collectRepoFiles("config"),
			...collectRepoFiles("docs"),
			...collectRepoFiles("lib"),
			...collectRepoFiles("scripts"),
			...collectRepoFiles("skills"),
			...collectRepoFiles("test"),
		].filter((relativePath) => /\.(?:[cm]?[jt]s|json|md|ya?ml)$/.test(relativePath));
		const secretPatterns: Array<[RegExp, string]> = [
			[/sk-(?:live_|proj-)?[A-Za-z0-9._:-]{20,}/, "OpenAI-style API key"],
		];
		const hits: string[] = [];

		for (const relativePath of scannedFiles) {
			const fileContents = readRepoFile(relativePath);
			for (const [pattern, label] of secretPatterns) {
				if (pattern.test(fileContents)) {
					hits.push(`${relativePath}: ${label}`);
				}
			}
		}

		expect(hits).toEqual([]);
	});

	it("keeps repo-local path references in current documentation resolvable", () => {
		const hits: string[] = [];

		for (const relativePath of collectCurrentDocumentationFiles()) {
			const fileContents = readRepoFile(relativePath);
			const references = [
				...Array.from(fileContents.matchAll(/`([^`\n]+)`/g), (match) => match[1]),
				...Array.from(
					fileContents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g),
					(match) => match[1],
				),
			];

			for (const reference of references) {
				const normalized = normalizeRepoPathReference(reference);
				if (normalized && !repoPathPatternExists(normalized)) {
					hits.push(`${relativePath}: ${reference}`);
				}
			}
		}

		expect(hits).toEqual([]);
	});

	it("keeps package versions quoted in documentation aligned with package.json", () => {
		// Docs that pin a version go stale silently at every release. Any
		// `x.y.z` that looks like this package's own version must match the
		// version currently in package.json.
		const { version } = JSON.parse(readRepoFile("package.json")) as { version: string };
		const hits: string[] = [];

		for (const relativePath of collectCurrentDocumentationFiles()) {
			const fileContents = readRepoFile(relativePath);
			for (const match of fileContents.matchAll(
				/(?:package |version[: ]|v)(\d+\.\d+\.\d+)\b/gi,
			)) {
				const quoted = match[1];
				// Only flag versions in this package's own major line; OpenCode
				// and Codex CLI versions are quoted legitimately.
				if (!quoted.startsWith(`${version.split(".")[0]}.`)) continue;
				if (quoted !== version) {
					hits.push(`${relativePath}: ${match[0].trim()} (package.json is ${version})`);
				}
			}
		}

		expect(hits).toEqual([]);
	});

	it("keeps relative markdown links resolvable from the file that contains them", () => {
		// `normalizeRepoPathReference` strips leading `./` and `../`, so a link
		// like `../../configuration.md` normalizes to a repo-root-relative path
		// and silently passes the reference check above even when it points
		// outside the repository. Resolve link targets against the containing
		// file's own directory instead.
		const hits: string[] = [];

		for (const relativePath of collectCurrentDocumentationFiles()) {
			const fileContents = readRepoFile(relativePath);
			const containingDir = path.dirname(path.resolve(testDir, "..", relativePath));

			for (const match of fileContents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
				const rawHref = match[1].trim();
				if (/^(?:https?:|mailto:|#)/.test(rawHref)) continue;

				const href = rawHref.split("#")[0];
				if (href.length === 0) continue;

				if (!existsSync(path.resolve(containingDir, href))) {
					hits.push(`${relativePath}: ${rawHref}`);
				}
			}
		}

		expect(hits).toEqual([]);
	});

	it("keeps auth-method labels and count in docs aligned with AUTH_LABELS", async () => {
		const { AUTH_LABELS } = await import("../lib/constants.js");
		const expectedLabels = [
			AUTH_LABELS.OAUTH,
			AUTH_LABELS.OAUTH_MANUAL_BROWSER,
			AUTH_LABELS.OAUTH_DEVICE_CODE,
			AUTH_LABELS.OAUTH_MANUAL,
		];

		const gettingStarted = readRepoFile("docs/getting-started.md");
		for (const label of expectedLabels) {
			expect(gettingStarted, `missing label in getting-started.md: ${label}`).toContain(label);
		}
		expect(gettingStarted).toContain("four");
		expect(gettingStarted).not.toContain("**three**");

		const archPublic = readRepoFile("docs/architecture.md");
		expect(archPublic, "docs/architecture.md must say four OAuth labels only").toContain(
			"four OAuth labels only",
		);
		expect(archPublic).not.toContain("three OAuth labels only");
		expect(archPublic).toContain("open URL manually");
		// "manual URL paste", not "URL/code": the flow requires the full
		// callback URL, because its `state` parameter is the only thing binding
		// the pasted value to the login attempt.
		expect(archPublic).toContain("manual URL paste");
		expect(archPublic).not.toContain("manual URL/code paste");

		const archDev = readRepoFile("docs/development/ARCHITECTURE.md");
		expect(
			archDev,
			"docs/development/ARCHITECTURE.md must include open-URL-manually callback",
		).toContain("open-URL-manually callback");
		expect(archDev).toContain("manual URL paste");
		expect(archDev).not.toContain("manual URL/code paste");
		expect(archDev).not.toContain("browser callback, device code, manual URL paste");

		const faq = readRepoFile("docs/faq.md");
		expect(faq, "docs/faq.md must not claim three OAuth methods").not.toContain(
			"three OAuth methods",
		);
		expect(faq).toContain("four OAuth methods");
		expect(faq).toContain("open URL manually");

		// Drift probe: operate on an in-memory copy only — never modify the actual source file.
		const labelToRemove = AUTH_LABELS.OAUTH_MANUAL_BROWSER;
		const gettingStartedWithout = gettingStarted.replaceAll(labelToRemove, "REMOVED");
		expect(findMissingLabels(gettingStartedWithout, expectedLabels)).toEqual([labelToRemove]);
		for (const label of expectedLabels.filter((l) => l !== labelToRemove)) {
			expect(gettingStartedWithout).toContain(label);
		}
	});

	it("keeps npm scripts mentioned in current documentation aligned with package.json", () => {
		const packageJson = JSON.parse(readRepoFile("package.json")) as {
			scripts?: Record<string, string>;
		};
		const scriptNames = new Set(Object.keys(packageJson.scripts ?? {}));
		const hits: string[] = [];

		for (const relativePath of collectCurrentDocumentationFiles()) {
			const fileContents = readRepoFile(relativePath);
			for (const match of fileContents.matchAll(
				/npm(?:\.cmd)?\s+run\s+(?:-[^\s`]+\s+)*([a-zA-Z0-9:_-]+)/g,
			)) {
				const scriptName = match[1];
				if (!scriptNames.has(scriptName)) {
					hits.push(`${relativePath}: npm run ${scriptName}`);
				}
			}
		}

		expect(hits).toEqual([]);
	});
});

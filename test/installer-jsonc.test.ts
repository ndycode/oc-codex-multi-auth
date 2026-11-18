import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PER_PROJECT_ENV = "CODEX_AUTH_PER_PROJECT_ACCOUNTS";
const FLAGGED_FILE = "oc-codex-multi-auth-flagged-accounts.json";

async function createTempHome() {
	// See install-oc-codex-multi-auth.test.ts: the canonical path keeps cache
	// guards and path comparisons honest on platforms with a symlinked tmpdir.
	return realpathSync(await mkdtemp(join(tmpdir(), "oc-codex-jsonc-")));
}

type CoreModule = typeof import("../scripts/install-oc-codex-multi-auth-core.js");

async function importCore() {
	vi.resetModules();
	return import("../scripts/install-oc-codex-multi-auth-core.js") as Promise<CoreModule>;
}

function gatherStdout(logSpy: ReturnType<typeof vi.spyOn>) {
	return logSpy.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("installer JSONC support and config safety", () => {
	let tempHome: string | null = null;
	let previousPerProject: string | undefined;

	beforeEach(() => {
		previousPerProject = process.env[PER_PROJECT_ENV];
		delete process.env[PER_PROJECT_ENV];
	});

	afterEach(async () => {
		if (previousPerProject === undefined) delete process.env[PER_PROJECT_ENV];
		else process.env[PER_PROJECT_ENV] = previousPerProject;
		vi.restoreAllMocks();
		vi.doUnmock("node:fs/promises");
		if (tempHome) {
			await rm(tempHome, { recursive: true, force: true });
			tempHome = null;
		}
	});

	it("parses line/block comments and trailing commas only outside strings", async () => {
		const { __test } = await importCore();
		const jsonc = `{
			// leading line comment
			"plugin": ["a"], // trailing line comment
			"urls": ["https://example.com/a//b"], /* http-ish strings are not comments */
			"escaped": "quote \\" and backslash \\\\ kept",
			"block": /* a
				multi-line
				comment */ "value",
			"list": [1, 2, 3,], // trailing comma in array
			"obj": { "x": true, },
		}`;
		expect(__test.parseJsonc(jsonc)).toEqual({
			plugin: ["a"],
			urls: ["https://example.com/a//b"],
			escaped: 'quote " and backslash \\ kept',
			block: "value",
			list: [1, 2, 3],
			obj: { x: true },
		});
	});

	it("does not treat // or /* inside strings as comments", async () => {
		const { __test } = await importCore();
		expect(
			__test.parseJsonc('{ "a": "x // y", "b": "x /* y */ z", "c": "https://host/p" }'),
		).toEqual({ a: "x // y", b: "x /* y */ z", c: "https://host/p" });
		// An escaped quote must not end the string early: the // below stays inside.
		expect(__test.parseJsonc('{ "a": "x \\" // still string", "b": 1 }')).toEqual({
			a: 'x " // still string',
			b: 1,
		});
	});

	it("keeps a trailing comma inside a string literal", async () => {
		const { __test } = await importCore();
		expect(__test.parseJsonc('{ "a": "keep me, }", "b": "keep, ]" }')).toEqual({
			a: "keep me, }",
			b: "keep, ]",
		});
	});

	it("still rejects content that is not JSON after comment stripping", async () => {
		const { __test } = await importCore();
		expect(() => __test.parseJsonc("{ definitely not json")).toThrow();
		expect(() => __test.parseJsonc('{ "a": tru }')).toThrow();
	});

	it("warns before rewriting a commented config — JSON rewrites drop the notes", async () => {
		// The JSONC parse strips comments for reading, but the write path
		// emits plain JSON — an operator's notes would vanish from the file
		// silently (coderabbit minor on PR #275). The installer must say so.
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller, __test } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			`{
				// operator note: do not remove the corporate proxy block
				"plugin": ["existing-plugin"],
				"urls": ["https://example.com/a//b"]
			}`,
			"utf-8",
		);

		// Unit-level: the scanner must see real comments and ignore `//`
		// inside string literals (every URL would otherwise warn).
		expect(__test.jsoncContainsComments('{ // note\n"a": "https://x/y" }')).toBe(true);
		expect(__test.jsoncContainsComments('{ "a": "https://x//y" }')).toBe(false);
		expect(__test.jsoncContainsComments('{ "a": 1 }')).toBe(false);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(
			runInstaller(["--modern", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "install", exitCode: 0 });

		const stdout = gatherStdout(logSpy);
		expect(stdout).toContain("comments");
		expect(stdout).toMatch(/not preserve|does not preserve/i);
	});

	it("warns before rewriting a commented tui.json — its notes would drop too", async () => {
		// The same comment-loss blind spot existed on the TUI config: an
		// existing tui.json with JSONC comments is rewritten as plain JSON
		// whenever the TUI plugin block changes (coderabbit minor on PR
		// #275). The warning must cover both files.
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const tuiPath = join(configDir, "tui.json");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			tuiPath,
			`{
				// operator note: theme tuned for the projector
				"theme": "custom",
				"urls": ["https://example.com/a//b"]
			}`,
			"utf-8",
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(
			runInstaller(["--modern", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "install", exitCode: 0 });

		const stdout = gatherStdout(logSpy);
		expect(stdout).toMatch(/tui\.json[\s\S]{0,120}comments|comments[\s\S]{0,120}tui\.json/i);
		expect(stdout).toMatch(/not preserve|does not preserve/i);
	});

	it("dry-run warning says the backup only exists after a real install", async () => {
		// A dry run writes nothing — telling the operator their comments
		// "remain only in the backup" would point at a backup that was never
		// created (greptile P2 on PR #275).
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const tuiPath = join(configDir, "tui.json");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			tuiPath,
			`{
				// operator note
				"theme": "custom"
			}`,
			"utf-8",
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(
			runInstaller(["--modern", "--no-cache-clear", "--dry-run"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "install", exitCode: 0 });

		const stdout = gatherStdout(logSpy);
		expect(stdout).toMatch(/actual install would not preserve/i);
		expect(stdout).toMatch(/would create a backup containing them/i);
		expect(stdout).not.toMatch(/comments that a rewrite would not preserve/i);
		expect(stdout).not.toMatch(/they remain only in the backup/i);
	});

	it("merges a real-world JSONC opencode.json instead of failing the parse", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			`{
				// user notes must survive the parse
				"plugin": ["existing-plugin"],
				"provider": {
					"openai": {
						"myCustomKey": "keep-me",
						"models": { "user-only": { "name": "User Only", }, },
					},
				},
			}`,
			"utf-8",
		);

		await expect(
			runInstaller(["--modern", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "install", exitCode: 0 });

		const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
			plugin: string[];
			provider: { openai: { myCustomKey?: string; models: Record<string, unknown> } };
		};
		expect(saved.plugin).toEqual(["existing-plugin", "oc-codex-multi-auth"]);
		expect(saved.provider.openai.myCustomKey).toBe("keep-me");
		expect(saved.provider.openai.models["user-only"]).toBeDefined();
		expect(saved.provider.openai.models["gpt-5.5"]).toBeDefined();
	});

	it.each(["--modern", "--full", "--legacy"])(
		"catalog mode %s refuses to overwrite a malformed existing config",
		async (mode) => {
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const { runInstaller } = await importCore();
			const configDir = join(tempHome, ".config", "opencode");
			const configPath = join(configDir, "opencode.json");
			await mkdir(configDir, { recursive: true });
			const malformed = "{ this cannot be parsed as JSON or JSONC";
			await writeFile(configPath, malformed, "utf-8");

			const failure = await runInstaller([mode, "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}).then(
				() => null,
				(error: unknown) => error,
			);
			expect(String(failure instanceof Error ? failure.message : failure)).toContain(
				"Could not parse existing config",
			);
			expect(String(failure instanceof Error ? failure.message : failure)).toContain(configPath);

			// The original file is untouched and no backup or second file appeared.
			await expect(readFile(configPath, "utf-8")).resolves.toBe(malformed);
			await expect(readdir(configDir)).resolves.toEqual(["opencode.json"]);
		},
	);

	it("catalog mode refuses a malformed tui.json without touching it", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const tuiPath = join(configDir, "tui.json");
		await mkdir(configDir, { recursive: true });
		const malformed = "{ definitely not json";
		await writeFile(tuiPath, malformed, "utf-8");

		await expect(
			runInstaller(["--modern", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).rejects.toThrow("Could not parse existing TUI config");
		await expect(readFile(tuiPath, "utf-8")).resolves.toBe(malformed);
	});

	it("targets the opencode.jsonc sibling when opencode.json is absent", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const jsoncPath = join(configDir, "opencode.jsonc");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			jsoncPath,
			`{
				// hand-maintained JSONC config
				"plugin": ["other-plugin"],
				"theme": "dark",
			}`,
			"utf-8",
		);

		await expect(
			runInstaller(["install", "--plugin-only", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ exitCode: 0, configPath: jsoncPath });

		// The merge lands in the .jsonc file; no parallel opencode.json appears.
		const entries = await readdir(configDir);
		expect(entries).not.toContain("opencode.json");
		expect(entries).toContain("opencode.jsonc");
		expect(entries.some((entry) => entry.startsWith("opencode.jsonc.bak-"))).toBe(true);
		const saved = JSON.parse(await readFile(jsoncPath, "utf-8")) as {
			plugin: string[];
			theme: string;
		};
		expect(saved.plugin).toEqual(["other-plugin", "oc-codex-multi-auth"]);
		expect(saved.theme).toBe("dark");
		expect(gatherStdout(logSpy)).toContain("opencode.jsonc");
	});

	it("rejects unknown installer flags with an error and usage output", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();

		await expect(
			runInstaller(["--bogus-option"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).rejects.toThrow("Unknown option for install command: --bogus-option");

		expect(gatherStdout(logSpy)).toContain("Usage: oc-codex-multi-auth");
	});

	it("rejects unknown standalone flags with an error and usage output", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();

		await expect(
			runInstaller(["status", "--bogus"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).rejects.toThrow("Unknown option for standalone command: --bogus");
		expect(gatherStdout(logSpy)).toContain("Usage: oc-codex-multi-auth");
	});

	it("prints the package version for --version", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();
		const pkg = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf-8"),
		) as { version: string };

		await expect(
			runInstaller(["--version"], {
				env: { HOME: "/nonexistent", USERPROFILE: "/nonexistent" },
			}),
		).resolves.toMatchObject({ action: "version", exitCode: 0 });
		expect(logSpy).toHaveBeenCalledWith(pkg.version);
	});

	it("warns when neither HOME nor USERPROFILE is set", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { __test } = await importCore();
		const detected = __test.resolveHomeDirectory({});
		expect(typeof detected).toBe("string");
		expect(detected.length).toBeGreaterThan(0);
		expect(gatherStdout(logSpy)).toContain("neither HOME nor USERPROFILE is set");
	});

	it("warns before replacing a config symlink with a regular file", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		const realTarget = join(tempHome, "real-config.json");
		await mkdir(configDir, { recursive: true });
		await writeFile(realTarget, JSON.stringify({ plugin: ["other-plugin"] }), "utf-8");
		await symlink(realTarget, configPath);

		await expect(
			runInstaller(["install", "--plugin-only", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ exitCode: 0 });

		expect(gatherStdout(logSpy)).toContain("symbolic link");
		// The link itself is replaced; the target file keeps its own contents.
		const { lstatSync } = await import("node:fs");
		expect(lstatSync(configPath).isSymbolicLink()).toBe(false);
		const saved = JSON.parse(await readFile(configPath, "utf-8")) as { plugin: string[] };
		expect(saved.plugin).toEqual(["other-plugin", "oc-codex-multi-auth"]);
		expect(await readFile(realTarget, "utf-8")).toContain("other-plugin");
	});

	it("warns about managed provider.openai fields, dropped config keys, and pruned models", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			JSON.stringify({
				plugin: ["other-plugin"],
				apiKey: "redacted-fixture-key-value",
				baseURL: "https://leftover.example.com",
				provider: {
					openai: {
						apiKey: "{env:OPENAI_API_KEY}",
						baseURL: "https://provider-level.example.com",
						options: { store: true },
						models: {
							"gpt-5.5-high": { name: "stale explicit preset" },
							"my-custom": { name: "user model" },
						},
					},
				},
			}),
			"utf-8",
		);

		await expect(
			runInstaller(["--modern", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ exitCode: 0 });

		const stdout = gatherStdout(logSpy);
		// Names of what was dropped/replaced - never the secret values.
		expect(stdout).toContain("apiKey");
		expect(stdout).toContain("baseURL");
		expect(stdout).toContain("gpt-5.5-high");
		expect(stdout).not.toContain("redacted-fixture-key-value");
		expect(stdout).not.toContain("leftover.example.com");
		const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
			apiKey?: string;
			baseURL?: string;
			provider: { openai: { apiKey?: string; baseURL?: string; models: Record<string, unknown> } };
		};
		expect(saved.apiKey).toBeUndefined();
		expect(saved.baseURL).toBeUndefined();
		expect(saved.provider.openai.apiKey).toBeUndefined();
		expect(saved.provider.openai.baseURL).toBeUndefined();
		expect(saved.provider.openai.models["gpt-5.5-high"]).toBeUndefined();
		expect(saved.provider.openai.models["my-custom"]).toBeDefined();
	});

	it("blocks __proto__/constructor/prototype keys during provider merges", async () => {
		const { __test } = await importCore();
		const malicious = JSON.parse(
			'{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "prototype": {"y": 2}, ' +
				'"myCustomKey": "keep", "models": {"__proto__": {"polluted": true}, "constructor": {"x": 1}, "mine": {"name": "Mine"}}}',
		) as Record<string, unknown>;

		const merged = __test.mergeOpenaiProvider(malicious, {
			options: { store: false },
			models: { "gpt-5.5": { name: "base" } },
		}) as Record<string, unknown> & { models?: Record<string, unknown> };

		// The dangerous names never become own properties of the merged object or
		// the merged models map, and the global prototype stays clean.
		expect(Object.getOwnPropertyNames(merged)).not.toContain("__proto__");
		expect(Object.getOwnPropertyNames(merged)).not.toContain("constructor");
		expect(Object.getOwnPropertyNames(merged)).not.toContain("prototype");
		expect(Object.getOwnPropertyNames(merged.models ?? {})).not.toContain("__proto__");
		expect(Object.getOwnPropertyNames(merged.models ?? {})).not.toContain("constructor");
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(merged.myCustomKey).toBe("keep");
		expect(merged.models?.mine).toEqual({ name: "Mine" });
	});

	it("blocks prototype-polluting keys in the end-to-end config write", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { runInstaller } = await importCore();
		const configDir = join(tempHome, ".config", "opencode");
		const configPath = join(configDir, "opencode.json");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			configPath,
			'{"plugin": [], "provider": {"openai": {"__proto__": {"polluted": true}, "constructor": {"x": 1}, "models": {"__proto__": {"y": 1}, "mine": {"name": "Mine"}}}}}',
			"utf-8",
		);

		await expect(
			runInstaller(["--modern", "--no-cache-clear"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ exitCode: 0 });

		const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
			provider: { openai: Record<string, unknown> };
		};
		expect(Object.getOwnPropertyNames(saved.provider.openai)).not.toContain("constructor");
		expect(Object.getOwnPropertyNames(saved.provider.openai)).not.toContain("__proto__");
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

describe("standalone per-project account storage", () => {
	let tempHome: string | null = null;
	let projectDir: string | null = null;
	let previousPerProject: string | undefined;

	beforeEach(() => {
		previousPerProject = process.env[PER_PROJECT_ENV];
		delete process.env[PER_PROJECT_ENV];
	});

	afterEach(async () => {
		if (previousPerProject === undefined) delete process.env[PER_PROJECT_ENV];
		else process.env[PER_PROJECT_ENV] = previousPerProject;
		vi.restoreAllMocks();
		if (tempHome) {
			await rm(tempHome, { recursive: true, force: true });
			tempHome = null;
		}
		if (projectDir) {
			await rm(projectDir, { recursive: true, force: true });
			projectDir = null;
		}
	});

	async function createProject(markers: string[] = ["package.json"]) {
		const root = realpathSync(await mkdtemp(join(tmpdir(), "oc-codex-project-")));
		for (const marker of markers) {
			if (marker === ".git") await writeFile(join(root, marker), "gitdir: elsewhere", "utf-8");
			else await writeFile(join(root, marker), "{}", "utf-8");
		}
		return root;
	}

	it("derives the same project storage key as lib/storage/paths.ts", async () => {
		projectDir = await createProject();
		const { __test } = await importCore();
		const { getProjectStorageKey } = await import("../lib/storage/paths.js");
		expect(__test.getStandaloneProjectStorageKey(projectDir)).toBe(getProjectStorageKey(projectDir));
	});

	it("finds the project root by walking up through marker directories", async () => {
		projectDir = await createProject(["package.json"]);
		const nested = join(projectDir, "packages", "sub");
		await mkdir(nested, { recursive: true });
		const { __test } = await importCore();
		expect(__test.findStandaloneProjectRoot(nested)).toBe(projectDir);
	});

	it("status --json resolves the per-project pool when enabled and reports its scope", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		projectDir = await createProject();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller, __test } = await importCore();

		const result = await runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, [PER_PROJECT_ENV]: "1" },
			projectDir,
		});

		const expectedPath = join(
			tempHome,
			".opencode",
			"projects",
			__test.getStandaloneProjectStorageKey(projectDir),
			"oc-codex-multi-auth-accounts.json",
		);
		expect(result).toMatchObject({
			action: "status",
			exitCode: 0,
			storagePath: expectedPath,
			storageScope: "project",
		});
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.storagePath).toBe(expectedPath);
		expect(output.storageScope).toBe("project");
	});

	it("status --json resolves the global pool when perProjectAccounts is off via env", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		projectDir = await createProject();
		const { runInstaller } = await importCore();

		const result = await runInstaller(["status", "--json"], {
			env: {
				...process.env,
				HOME: tempHome,
				USERPROFILE: tempHome,
				[PER_PROJECT_ENV]: "0",
			},
			projectDir,
		});

		expect(result).toMatchObject({
			storagePath: join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json"),
			storageScope: "global",
		});
	});

	it("env semantics: only the literal \"1\" enables per-project storage", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		projectDir = await createProject();
		const { __test } = await importCore();
		const opencodeDir = join(tempHome, ".opencode");

		expect(__test.resolvePerProjectAccounts({ [PER_PROJECT_ENV]: "1" }, opencodeDir)).toBe(true);
		expect(__test.resolvePerProjectAccounts({ [PER_PROJECT_ENV]: "true" }, opencodeDir)).toBe(false);
		expect(__test.resolvePerProjectAccounts({ [PER_PROJECT_ENV]: "yes" }, opencodeDir)).toBe(false);
		expect(__test.resolvePerProjectAccounts({ [PER_PROJECT_ENV]: "0" }, opencodeDir)).toBe(false);
	});

	it("reads perProjectAccounts from the plugin config file, defaulting off", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { __test } = await importCore();
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		const pluginConfig = join(opencodeDir, "openai-codex-auth-config.json");

		expect(__test.resolvePerProjectAccounts({}, opencodeDir)).toBe(false);
		await writeFile(pluginConfig, JSON.stringify({ perProjectAccounts: false }), "utf-8");
		expect(__test.resolvePerProjectAccounts({}, opencodeDir)).toBe(false);
		await writeFile(pluginConfig, JSON.stringify({ perProjectAccounts: true }), "utf-8");
		expect(__test.resolvePerProjectAccounts({}, opencodeDir)).toBe(true);
		// The env override outranks the file either way.
		expect(__test.resolvePerProjectAccounts({ [PER_PROJECT_ENV]: "0" }, opencodeDir)).toBe(false);
		expect(__test.resolvePerProjectAccounts({ [PER_PROJECT_ENV]: "1" }, opencodeDir)).toBe(true);
	});

	it("honors an explicit --config-path as an explicit scope, not a project pool", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		projectDir = await createProject();
		const { runInstaller } = await importCore();
		const selected = join(tempHome, "selected-pool.json");
		await writeFile(
			selected,
			JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
			"utf-8",
		);

		const result = await runInstaller(["status", "--json", "--config-path", selected], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			projectDir,
		});
		expect(result).toMatchObject({ storagePath: selected, storageScope: "explicit", exitCode: 0 });
	});

	it("doctor --json reports the flagged sibling pool beside the active file", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(
			join(opencodeDir, "oc-codex-multi-auth-accounts.json"),
			JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
			"utf-8",
		);
		const flaggedPath = join(opencodeDir, FLAGGED_FILE);
		await writeFile(
			flaggedPath,
			JSON.stringify({ version: 1, accounts: [
				{ accountLabel: "Flagged Seat", email: "flagged@example.com", refreshToken: "rt", addedAt: 1, lastUsed: 1 },
			] }),
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();

		const result = await runInstaller(["doctor", "--json"], {
			env: {
				...process.env,
				HOME: tempHome,
				USERPROFILE: tempHome,
				[PER_PROJECT_ENV]: "0",
			},
		});

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.flagged).toMatchObject({ storagePath: flaggedPath, totalAccounts: 1 });
		expect(output.flagged.accounts[0].label).toBe("Flagged Seat");
	});

	it("doctor --json reports an unreadable flagged file as an error", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(
			join(opencodeDir, "oc-codex-multi-auth-accounts.json"),
			JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
			"utf-8",
		);
		await writeFile(join(opencodeDir, FLAGGED_FILE), "{ not json", "utf-8");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await importCore();

		const result = await runInstaller(["doctor", "--json"], {
			env: {
				...process.env,
				HOME: tempHome,
				USERPROFILE: tempHome,
				[PER_PROJECT_ENV]: "0",
			},
		});

		expect(result.exitCode).toBe(1);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.flagged.error).toEqual(expect.any(String));
	});

	it("the flagged kind resolves the sibling quarantine file", async () => {
		tempHome = await createTempHome();
		vi.stubEnv("HOME", tempHome);
		vi.stubEnv("USERPROFILE", tempHome);
		const { __test } = await importCore();
		const mainPath = join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json");
		expect(__test.resolveStandaloneStorageFile(mainPath)).toBe(mainPath);
		expect(__test.resolveStandaloneStorageFile(mainPath, "main")).toBe(mainPath);
		expect(__test.resolveStandaloneStorageFile(mainPath, "flagged")).toBe(
			join(tempHome, ".opencode", FLAGGED_FILE),
		);

		// readStandaloneStorage honors the same split.
		await mkdir(join(tempHome, ".opencode"), { recursive: true });
		await writeFile(
			join(tempHome, ".opencode", FLAGGED_FILE),
			JSON.stringify({ version: 1, accounts: [{ email: "q@example.com" }] }),
			"utf-8",
		);
		const flagged = await __test.readStandaloneStorage(mainPath, "flagged");
		expect(flagged.error).toBeNull();
		expect(flagged.storage?.accounts).toHaveLength(1);
		const main = await __test.readStandaloneStorage(mainPath);
		expect(main.error).toBeNull();
		expect(main.storage).toBeNull();
	});

	it.each(["warm", "limits"])(
		"%s refuses a .migrated-to-keychain backup selection",
		async (command) => {
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { runInstaller } = await importCore();
			const artifact = join(
				tempHome,
				"oc-codex-multi-auth-accounts.json.migrated-to-keychain.1700000000",
			);
			await writeFile(artifact, JSON.stringify({ version: 3, accounts: [] }), "utf-8");

			const result = await runInstaller([command, "--json", "--config-path", artifact], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			});
			expect(result.exitCode).toBe(1);
			const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
			expect(output.error).toContain("migrated-to-keychain");
			expect(output.error).toContain("rollback");
			// The artifact is never touched.
			expect(JSON.parse(await readFile(artifact, "utf-8"))).toMatchObject({ version: 3 });
		},
	);

	it.each(["warm", "limits"])(
		"%s pins CODEX_KEYCHAIN=0 for an explicit file and restores it afterward",
		async (command) => {
			vi.stubEnv("CODEX_KEYCHAIN", "1");
			tempHome = await createTempHome();
			vi.stubEnv("HOME", tempHome);
			vi.stubEnv("USERPROFILE", tempHome);
			vi.spyOn(console, "log").mockImplementation(() => {});
			const { runInstaller } = await importCore();
			const selected = join(tempHome, "selected.json");
			await writeFile(
				selected,
				JSON.stringify({ version: 3, activeIndex: 0, accounts: [] }),
				"utf-8",
			);
			const seenKeychain: (string | undefined)[] = [];
			const storageMod = {
				setStoragePathDirect: vi.fn(),
				loadAccounts: async () => {
					seenKeychain.push(process.env.CODEX_KEYCHAIN);
					return null;
				},
			};
			const loadRuntime = async () => {
				seenKeychain.push(process.env.CODEX_KEYCHAIN);
				return {
					storageMod,
					usageMod: {},
					warmReqMod: {},
					warmMod: {},
					recoveryMod: {},
					loggerMod: {},
					configMod: {
						loadPluginConfig: () => ({}),
						getQuotaDisplay: () => "free",
						getLimitsSort: () => ({ sort: "account", direction: "asc" }),
					},
					planMod: {},
					planTierMod: {},
					quotaCacheMod: {},
					quotaOverviewMod: {},
					themeMod: {},
				};
			};

			await runInstaller([command, "--json", "--config-path", selected], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
				loadWarmRuntime: loadRuntime,
				loadLimitsRuntime: loadRuntime,
			});

			// The runtime only ever saw the file backend, and the caller's env is
			// back to the way it was.
			expect(seenKeychain.length).toBeGreaterThan(0);
			expect(seenKeychain.every((value) => value === "0")).toBe(true);
			expect(process.env.CODEX_KEYCHAIN).toBe("1");
			expect(storageMod.setStoragePathDirect).toHaveBeenCalledWith(selected);
		},
	);
});

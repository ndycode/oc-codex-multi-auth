/// <reference lib="es2022.array" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the shipped import boundary with source implementations, not stale dist.
async function loadSourceDoctorRuntime() {
	return Promise.all([
		import("../lib/storage.js"),
		import("../lib/tools/doctor-repair.js"),
		import("../lib/shutdown.js"),
	]);
}

async function createTempHome() {
	return mkdtemp(join(tmpdir(), "oc-codex-standalone-"));
}

// The identity group is the last `(…)` before the trailing `enabled=` flags.
// Slicing between the first `(` and the first `)` instead would grab
// `(role:owner)` out of any label that carries parentheses of its own.
function extractIdentity(line: string) {
	const head = line.slice(0, line.indexOf(" enabled="));
	const open = head.lastIndexOf("(");
	return open === -1 ? "" : head.slice(open);
}

async function seedPool(home: string, accounts: unknown[]) {
	const opencodeDir = join(home, ".opencode");
	await mkdir(opencodeDir, { recursive: true });
	await writeFile(
		join(opencodeDir, "oc-codex-multi-auth-accounts.json"),
		JSON.stringify({ version: 3, activeIndex: 0, accounts }, null, 2),
		"utf-8",
	);
}

describe("standalone oc-codex-multi-auth CLI commands", () => {
	let tempHome: string | null = null;

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (tempHome) {
			await rm(tempHome, { recursive: true, force: true });
			tempHome = null;
		}
	});

	it("runs status as JSON without installer writes", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		const opencodeDir = join(tempHome, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(
			join(opencodeDir, "oc-codex-multi-auth-accounts.json"),
			JSON.stringify({
				version: 3,
				activeIndex: 0,
				accounts: [
					{
						accountLabel: "Personal",
						email: "user@example.com",
						accountId: "acct_123456789",
						accountIdSource: "token",
						refreshToken: "refresh-token",
						accessToken: "access-token",
						addedAt: Date.now(),
						lastUsed: Date.now(),
					},
				],
			}, null, 2),
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ action: "status", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.totalAccounts).toBe(1);
		expect(output.accounts[0].email).toBe("user....com");
	});

	it("status: the masked id suffix reveals no more than the masked accountId beside it", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [
			{
				email: "user@example.com",
				accountId: "acct_123456789",
				accountIdSource: "token",
				refreshToken: "refresh-token",
				addedAt: 1000,
				lastUsed: 2000,
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const account = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).accounts[0];
		expect(account.accountId).toBe("acct...6789");
		expect(account.idSuffix).toBe("6789");
	});

	it("status: --include-sensitive keeps the six-character id suffix the other surfaces print", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [
			{
				email: "user@example.com",
				accountId: "acct_123456789",
				accountIdSource: "token",
				refreshToken: "refresh-token",
				addedAt: 1000,
				lastUsed: 2000,
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["status", "--json", "--include-sensitive"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const account = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).accounts[0];
		expect(account.accountId).toBe("acct_123456789");
		expect(account.idSuffix).toBe("456789");
	});

	it("list: the masked id suffix still separates two accounts that share an email", async () => {
		// A masked row must still say which account it is. One subscription can
		// hold several workspaces under a single email, so with no suffix at
		// all these two rows read identically.
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [
			{
				email: "dup@example.com",
				accountId: "acct_0000000000aaaa",
				accountIdSource: "token",
				refreshToken: "refresh-a",
				addedAt: 1000,
				lastUsed: 2000,
			},
			{
				email: "dup@example.com",
				accountId: "acct_0000000000bbbb",
				accountIdSource: "token",
				refreshToken: "refresh-b",
				addedAt: 1000,
				lastUsed: 2000,
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["list"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const identities = logSpy.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.startsWith("- ["))
			.map(extractIdentity);

		expect(identities).toHaveLength(2);
		expect(identities[0]).toBe("(dup@....com, id:aaaa)");
		expect(identities[1]).toBe("(dup@....com, id:bbbb)");
	});

	it("list: drops the org-derived label the plugin no longer generates", async () => {
		// The standalone CLI reads the pool through its own normalizer, so
		// without a mirror of the drop it keeps printing the wrong
		// organization beside the very account id that label was misnaming.
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [
			{
				email: "personal@example.com",
				accountId: "acct_9f21c487c4",
				accountLabel: "DreamHost API (role:owner) [id:c487c4]",
				accountIdSource: "token",
				refreshToken: "refresh-a",
				addedAt: 1000,
				lastUsed: 2000,
			},
			{
				// A name someone typed. The marker does not hold this
				// account's id suffix, so it is not the plugin's to delete.
				email: "work@example.com",
				accountId: "acct_0000abcdef",
				accountLabel: "Work [id:mine]",
				accountIdSource: "token",
				refreshToken: "refresh-b",
				addedAt: 1000,
				lastUsed: 2000,
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["list"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const rows = logSpy.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.startsWith("- ["));

		expect(rows[0]).toContain("Account 1 (pers....com, id:87c4)");
		expect(rows[0]).not.toContain("DreamHost");
		expect(rows[1]).toContain("Work [id:mine] (work....com, id:cdef)");
	});

	it("list: replaces a value the head/tail mask cannot conceal", async () => {
		// `doctor` and friends share this printer and are what users paste
		// into issues. `first4...last4` conceals nothing below thirteen
		// characters, and padding must not clear the cutoff on its own.
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [
			{
				email: "me@x.io",
				accountId: "acct_0000abcdef",
				accountIdSource: "token",
				refreshToken: "refresh-a",
				addedAt: 1000,
				lastUsed: 2000,
			},
			{
				email: "  me@x.io12  ",
				accountId: "acct_0000abcdef",
				accountIdSource: "token",
				refreshToken: "refresh-b",
				addedAt: 1000,
				lastUsed: 2000,
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["list"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const rows = logSpy.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.startsWith("- ["));

		expect(rows[0]).toContain("(*****, id:cdef)");
		expect(rows[0]).not.toContain("me@x.io");
		expect(rows[1]).toContain("(*****, id:cdef)");
		expect(rows[1]).not.toContain("me@x");
	});

	it("status: omits the id suffix when the account id was masked outright", async () => {
		// The suffix is only safe because it reveals no more than the masked
		// `accountId` printed beside it. When that field is `*****`, four raw
		// characters of a short id can be the entire id.
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [
			{
				email: "user@example.com",
				accountId: "ab12cd",
				accountIdSource: "token",
				refreshToken: "refresh-token",
				addedAt: 1000,
				lastUsed: 2000,
			},
		]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["status", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		})).resolves.toMatchObject({ exitCode: 0 });

		const account = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).accounts[0];
		expect(account.accountId).toBe("*****");
		expect(account.idSuffix).toBeUndefined();
		expect(JSON.stringify(account)).not.toContain("12cd");
	});

	it("rejects unknown positional commands instead of installing", async () => {
		vi.resetModules();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(runInstaller(["wat"])).rejects.toThrow("Unknown command: wat");
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Commands:"));
	});

	async function writeAccounts(home: string, accounts: unknown[]) {
		const opencodeDir = join(home, ".opencode");
		await mkdir(opencodeDir, { recursive: true });
		await writeFile(
			join(opencodeDir, "oc-codex-multi-auth-accounts.json"),
			JSON.stringify({ version: 3, activeIndex: 0, accounts }, null, 2),
			"utf-8",
		);
	}

	const freshAccount = (over: Record<string, unknown> = {}) => ({
		email: "warm@example.com",
		accountId: "acct_warm",
		refreshToken: "rt-warm",
		accessToken: "at-warm",
		// Far-future expiry so ensureCodexUsageAccessToken skips a real refresh
		// and the warm path reaches the (mocked) fetch deterministically.
		expiresAt: Date.now() + 3_600_000,
		addedAt: Date.now(),
		lastUsed: Date.now(),
		...over,
	});

	it.each(["acct_warm", undefined])("doctor: repairs stale state and persists rotated credentials only in --config-path (%s)", async (accountId) => {
		// Given a selected pool distinct from both the home pool and runtime default.
		vi.resetModules();
		vi.stubEnv("CODEX_KEYCHAIN", "1");
		tempHome = await createTempHome();
		await seedPool(tempHome, [freshAccount({ refreshToken: "home-secret" })]);
		const homePath = join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json");
		const homeBefore = await readFile(homePath, "utf-8");
		const poolPath = join(tempHome, "selected-pool.json");
		const resetAt = Date.now() + 86_400_000;
		await writeFile(poolPath, JSON.stringify({ version: 3, activeIndex: 0, accounts: [
			freshAccount({ accountId, coolingDownUntil: resetAt, cooldownReason: "auth-failure", rateLimitResetTimes: { codex: resetAt } }),
		] }));
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
			access_token: "rotated-access-secret", refresh_token: "rotated-refresh-secret", expires_in: 3600,
		}), { status: 200 }));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		// When explicitly repairing this pool, even an unexpired token is verified.
		const result = await runInstaller(["doctor", "--fix", "--json", "--config-path", poolPath], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadDoctorRuntime: loadSourceDoctorRuntime,
		});

		// Then the repair is durable, reported, and confined to the selected file.
		const stored = JSON.parse(await readFile(poolPath, "utf-8"));
		expect.soft(stored.accounts[0].rateLimitResetTimes).toEqual({});
		expect.soft(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).fixApplied).toBe(true);
		expect(stored.accounts[0]).toMatchObject({ accessToken: "rotated-access-secret", refreshToken: "rotated-refresh-secret" });
		expect(stored.accounts[0].coolingDownUntil).toBeUndefined();
		expect(stored.accounts[0].cooldownReason).toBeUndefined();
		expect(result).toMatchObject({ action: "doctor", exitCode: 0, storagePath: poolPath });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain("rt-warm");
		expect(await readFile(homePath, "utf-8")).toBe(homeBefore);
		expect(JSON.stringify(logSpy.mock.calls)).not.toMatch(/rotated-access-secret|rotated-refresh-secret|rt-warm|home-secret/);
	});

	it("doctor: repairs and summarizes the default keychain pool when no JSON file exists", async () => {
		// Given enabled keychain routing with accounts only in the injected backend.
		vi.resetModules();
		vi.stubEnv("CODEX_KEYCHAIN", "1");
		tempHome = await createTempHome();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const keychainRouting: (string | undefined)[] = [];
		const accounts = [freshAccount({ accountLabel: "Keychain account", rateLimitResetTimes: { codex: 123 } })];
		let snapshot = { accounts };
		const repairDoctorAccounts = vi.fn(async () => {
			keychainRouting.push(process.env.CODEX_KEYCHAIN);
			snapshot = { accounts: [freshAccount({ accountLabel: "Keychain account", rateLimitResetTimes: {} })] };
			return { appliedFixes: ["Cleared stale rate-limit markers."], fixErrors: [] };
		});

		// When repair uses injected runtime seams, never the real keychain.
		const result = await runInstaller(["doctor", "--fix", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadDoctorRuntime: async () => [
				{ setStoragePathDirect: vi.fn(), loadAccounts: async () => {
					keychainRouting.push(process.env.CODEX_KEYCHAIN);
					return snapshot;
				} },
				{ repairDoctorAccounts },
				{ setShutdownOwnsProcess: vi.fn() },
			],
		});

		// Then repair runs and the summary uses the post-repair backend snapshot.
		expect(repairDoctorAccounts).toHaveBeenCalledWith(accounts);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({
			totalAccounts: 1,
			fixApplied: true,
			accounts: [{ label: "Keychain account" }],
		});
		expect(output.accounts[0].rateLimitResetTimes).toEqual({});
		expect(keychainRouting).toEqual(["1", "1", "1"]);
		expect(process.env.CODEX_KEYCHAIN).toBe("1");
		expect(result).toMatchObject({ action: "doctor", exitCode: 0 });
	});

	it.each(["discovery", "repair", "snapshot"])("doctor: redacts runtime %s failures without a JSON pool", async (stage) => {
		// Given an injected backend that fails at one repair boundary.
		vi.resetModules();
		vi.stubEnv("CODEX_KEYCHAIN", "1");
		tempHome = await createTempHome();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");
		const failure = new Error("upstream-private-token-text");
		const loadAccounts = vi.fn().mockResolvedValue({ accounts: [freshAccount()] });
		if (stage === "discovery") loadAccounts.mockRejectedValue(failure);
		if (stage === "snapshot") loadAccounts.mockResolvedValueOnce({ accounts: [freshAccount()] }).mockRejectedValue(failure);
		const repairDoctorAccounts = vi.fn().mockResolvedValue({ appliedFixes: [], fixErrors: [] });
		if (stage === "repair") repairDoctorAccounts.mockRejectedValue(failure);

		// When default-path repair runs without reading any real credentials.
		const result = await runInstaller(["doctor", "--fix", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadDoctorRuntime: async () => [
				{ setStoragePathDirect: vi.fn(), loadAccounts },
				{ repairDoctorAccounts },
				{ setShutdownOwnsProcess: vi.fn() },
			],
		});

		// Then failure is nonzero and redacted, with keychain routing preserved.
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).fixErrors).toHaveLength(1);
		expect(JSON.stringify(logSpy.mock.calls)).not.toContain(failure.message);
		expect(process.env.CODEX_KEYCHAIN).toBe("1");
	});

	it("doctor: preserves failed and disabled accounts while reporting partial repair failure", async () => {
		// Given one recoverable, one failing, and one intentionally disabled account.
		vi.resetModules();
		tempHome = await createTempHome();
		const poolPath = join(tempHome, "selected-pool.json");
		const stale = { coolingDownUntil: Date.now() + 86_400_000, cooldownReason: "auth-failure", rateLimitResetTimes: { codex: Date.now() + 86_400_000 } };
		const failed = freshAccount({ ...stale, accountId: "acct_failed", refreshToken: "failed-refresh-secret" });
		const disabled = freshAccount({ ...stale, accountId: "acct_disabled", refreshToken: "disabled-refresh-secret", enabled: false });
		await writeFile(poolPath, JSON.stringify({ version: 3, activeIndex: 0, accounts: [freshAccount(stale), failed, disabled] }));
		const fetchSpy = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "rotated-access-secret", refresh_token: "rotated-refresh-secret", expires_in: 3600 })))
			.mockRejectedValueOnce(new Error("failed-refresh-secret at-warm access_token=upstream-access-secret"));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		// When repair encounters a refresh failure, it continues but exits nonzero.
		const result = await runInstaller(["doctor", "--fix", "--json", "--config-path", poolPath], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			loadDoctorRuntime: loadSourceDoctorRuntime,
		});

		// Then only the verified account loses stale state and no secret is reported.
		expect(result).toMatchObject({ exitCode: 1 });
		const stored = JSON.parse(await readFile(poolPath, "utf-8"));
		expect(stored.accounts[0].rateLimitResetTimes).toEqual({});
		expect(stored.accounts[1]).toMatchObject(failed);
		expect(stored.accounts[2]).toMatchObject(disabled);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.fixApplied).toBe(true);
		expect(output.fixErrors).toEqual([expect.stringContaining("Account 2")]);
		expect(JSON.stringify(output)).not.toMatch(/failed-refresh-secret|at-warm|upstream-access-secret|rotated-access-secret|rotated-refresh-secret|disabled-refresh-secret/);
	});

	it("doctor: remains read-only without --fix", async () => {
		// Given a stale pool that would require verification to repair.
		vi.resetModules();
		tempHome = await createTempHome();
		await seedPool(tempHome, [freshAccount({ rateLimitResetTimes: { codex: Date.now() + 86_400_000 } })]);
		const poolPath = join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json");
		const before = await readFile(poolPath, "utf-8");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		// When only diagnostics are requested.
		await runInstaller(["doctor", "--json", "--config-path", poolPath]);

		// Then neither credentials nor storage are touched.
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(await readFile(poolPath, "utf-8")).toBe(before);
	});

	it("warm: empty pool reports 0/0/0 and exits 0 (no network)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, []);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["warm", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "warm", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ totalAccounts: 0, warmed: 0, failed: 0, skipped: 0 });
	});

	it("warm: opens the window for an enabled account when upstream returns 200", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue({
				ok: true,
				status: 200,
				body: { cancel: async () => undefined },
				text: async () => "",
			} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["warm", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "warm", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ totalAccounts: 1, warmed: 1, failed: 0, skipped: 0 });
		expect(output.results[0]).toMatchObject({ index: 0, status: "warmed" });
		// Hit the real /codex/responses endpoint, not a usage GET.
		expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toContain("/codex/responses");
		expect(fetchSpy.mock.calls.at(-1)?.[1]).toMatchObject({ method: "POST" });
	});

	it("warm: a quota-429 account is reported failed (NOT warmed) and exits 1", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 429,
			body: { cancel: async () => undefined },
			text: async () => JSON.stringify({ error: { code: "usage_limit_reached" } }),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["warm", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "warm", exitCode: 1 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ warmed: 0, failed: 1 });
		expect(output.results[0].detail).toMatch(/quota|usage/i);
	});

	it("warm: skips a disabled account without any upstream call", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount({ enabled: false })]);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["warm", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "warm", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ warmed: 0, failed: 0, skipped: 1 });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("warm: masks emails by default in output", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount({ enabled: false })]);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["warm", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.results[0].email).not.toBe("warm@example.com");
		expect(output.results[0].email).toContain("...");
	});

	const usagePayload = {
		plan_type: "plus",
		rate_limit: {
			primary_window: {
				used_percent: 18,
				limit_window_seconds: 18_000,
				reset_at: Math.floor(Date.now() / 1000) + 3_600,
			},
			secondary_window: {
				used_percent: 42,
				limit_window_seconds: 604_800,
				reset_at: Math.floor(Date.now() / 1000) + 86_400,
			},
		},
	};

	it("limits: empty pool reports no accounts and exits 0 (#209)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, []);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["limits", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "limits", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output).toMatchObject({ totalAccounts: 0, accounts: [] });
	});

	it("limits: reports live 5h and weekly windows per account (#209)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["limits", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "limits", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.totalAccounts).toBe(1);
		const names = output.accounts[0].limits.map((limit: { name: string }) => limit.name);
		expect(names).toContain("5h limit");
		expect(names).toContain("Weekly limit");
		expect(output.accounts[0].limits[0].leftPercent).toBe(82);
		expect(output.accounts[0].planType).toBe("plus");
		expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toContain("/wham/usage");
	});

	it("limits: persists a spent weekly quota so rotation skips its Credits", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		const weeklyResetAt = Math.floor(Date.now() / 1000) + 86_400;
		const spentUsagePayload = {
			...usagePayload,
			rate_limit: {
				...usagePayload.rate_limit,
				secondary_window: {
					...usagePayload.rate_limit.secondary_window,
					used_percent: 100,
					reset_at: weeklyResetAt,
				},
			},
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => spentUsagePayload,
			text: async () => JSON.stringify(spentUsagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["limits", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "limits", exitCode: 0 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts[0]?.limits).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "Weekly limit", leftPercent: 0 })]),
		);
		const stored = JSON.parse(
			await readFile(
				join(tempHome, ".opencode", "oc-codex-multi-auth-accounts.json"),
				"utf-8",
			),
		);
		expect(stored.accounts[0]?.rateLimitResetTimes).toMatchObject({
			codex: weeklyResetAt * 1000,
			"gpt-5.6-terra": weeklyResetAt * 1000,
		});
	});

	it("limits: renders the windows in text output rather than a bare account list (#209)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const printed = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
		expect(printed).toContain("5h limit: 82% left");
		expect(printed).toContain("Weekly limit: 58% left");
	});

	it("limits: --tag only contacts matching accounts", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [
			freshAccount({ email: "tagged@example.com", accountTags: ["work"] }),
			freshAccount({
				email: "untagged@example.com",
				accountId: "acct_other",
				refreshToken: "rt-other",
			}),
		]);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--tag", "work", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		// The untagged account must not be fetched: that would bill it a usage
		// request and could persist refreshed credentials for it.
		expect(output.accounts).toHaveLength(1);
		expect(output.accounts[0].index).toBe(0);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("limits: --tag matches a workspace tagged on a deduplicated-away record", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		// Both records are the same workspace (same accountId), so dedupe keeps
		// only the later one — but the tag lives on the earlier record.
		await writeAccounts(tempHome, [
			freshAccount({ email: "old@example.com", accountTags: ["work"] }),
			freshAccount({ email: "new@example.com", refreshToken: "rt-newer" }),
		]);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => usagePayload,
			text: async () => JSON.stringify(usagePayload),
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--tag", "work", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts).toHaveLength(1);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("limits: redacts token material leaked by a failing refresh", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		// Expired, so ensureCodexUsageAccessToken actually performs the OAuth
		// refresh — a future expiry would skip it and only exercise /wham/usage.
		await writeAccounts(tempHome, [freshAccount({ expiresAt: Date.now() - 60_000 })]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 401,
			json: async () => ({
				error: "invalid_grant",
				refresh_token: "rt-super-secret-value",
			}),
			text: async () =>
				'{"error":"invalid_grant","refresh_token":"rt-super-secret-value"}',
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await runInstaller(["limits", "--json"], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
		});

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts[0].error).not.toContain("rt-super-secret-value");
	});

	it("limits: an account whose usage fetch fails is reported and exits 1 (#209)", async () => {
		vi.resetModules();
		tempHome = await createTempHome();
		await writeAccounts(tempHome, [freshAccount()]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: false,
			status: 500,
			text: async () => "upstream boom",
		} as unknown as Response);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { runInstaller } = await import("../scripts/install-oc-codex-multi-auth-core.js");

		await expect(
			runInstaller(["limits", "--json"], {
				env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			}),
		).resolves.toMatchObject({ action: "limits", exitCode: 1 });

		const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(output.accounts[0].error).toContain("500");
	});
});

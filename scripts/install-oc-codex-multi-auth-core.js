import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_NAME = "oc-codex-multi-auth";
const LEGACY_PACKAGE_NAMES = ["oc-chatgpt-multi-auth"];
const WINDOWS_RENAME_RETRY_ATTEMPTS = 5;
const WINDOWS_RENAME_RETRY_BASE_DELAY_MS = 10;
const STALE_MANAGED_MODEL_KEYS = new Set([
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
]);
const STANDALONE_COMMANDS = new Set(["doctor", "status", "list", "limits", "dashboard", "health", "diag", "warm"]);
const INSTALLER_COMMANDS = new Set(["install"]);
const UPDATE_COMMANDS = new Set(["update"]);

function splitCommandArgv(argv) {
	const [first, ...rest] = argv;
	if (!first) return { kind: "install", argv };
	if (INSTALLER_COMMANDS.has(first)) return { kind: "install", argv: rest };
	if (UPDATE_COMMANDS.has(first)) return { kind: "update", argv: rest };
	if (STANDALONE_COMMANDS.has(first)) return { kind: "standalone", command: first, argv: rest };
	if (first.startsWith("-")) return { kind: "install", argv };
	return { kind: "unknown", command: first, argv: rest };
}

function parseStandaloneArgs(argv) {
	const options = {
		json: false,
		includeSensitive: false,
		deep: false,
		fix: false,
		tag: undefined,
		configPath: undefined,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--include-sensitive") options.includeSensitive = true;
		else if (arg === "--deep") options.deep = true;
		else if (arg === "--fix") options.fix = true;
		else if (arg === "--tag") options.tag = argv[++index];
		else if (arg.startsWith("--tag=")) options.tag = arg.slice("--tag=".length);
		else if (arg === "--config-path") options.configPath = argv[++index];
		else if (arg.startsWith("--config-path=")) options.configPath = arg.slice("--config-path=".length);
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`Unknown option for standalone command: ${arg}`);
	}
	return options;
}

function getManagedPackageNames() {
	return [PACKAGE_NAME, ...LEGACY_PACKAGE_NAMES];
}

export function normalizePathForCompare(path, resolveRealPath = realpathSync) {
	const resolved = resolve(path);
	try {
		const realPath = resolveRealPath(resolved);
		return process.platform === "win32" ? realPath.toLowerCase() : realPath;
	} catch {
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	}
}

export function isDirectRunPath(argvPath, modulePath, resolveRealPath = realpathSync) {
	if (!argvPath || !modulePath) return false;
	return (
		normalizePathForCompare(argvPath, resolveRealPath) ===
		normalizePathForCompare(modulePath, resolveRealPath)
	);
}

function printHelp() {
	console.log(`Usage: ${PACKAGE_NAME} [command] [options]\n\n` +
		"Commands:\n" +
		"  install             Register plugin entries (default with no command)\n" +
		"  update              Refresh the cached package without changing OpenCode config\n" +
		"  doctor              Run local account/config diagnostics\n" +
		"  status              Show account/config status\n" +
		"  list                List configured accounts\n" +
		"  limits              Show live 5-hour and weekly usage for each account\n" +
		"  dashboard           Print dashboard guidance\n" +
		"  health              Check local token/account health\n" +
		"  diag                Alias for doctor --deep\n" +
		"  warm                Open every enabled account's usage window now (one request each)\n\n" +
		`Installer usage: ${PACKAGE_NAME} install [--plugin-only|--modern|--full|--legacy] [--dry-run] [--no-cache-clear]\n` +
		`Updater usage:   ${PACKAGE_NAME} update [--dry-run]\n\n` +
		"Default behavior:\n" +
		"  - Registers plugin entries without changing provider.openai\n" +
		"  - Enables the prompt status bar TUI plugin at ~/.config/opencode/tui.json\n" +
		"  - Installs model catalogs only with --modern, --full, or --legacy\n" +
		"  - Ensures plugin is unpinned (latest)\n" +
		"  - Clears OpenCode plugin cache\n\n" +
		"Options:\n" +
		"  --plugin-only      Register plugins without changing provider.openai\n" +
		"  --modern           Force compact modern config (13 base OAuth models + --variant presets)\n" +
		"  --full             Install compact base models plus 59 explicit selector entries\n" +
		"  --legacy           Force explicit legacy config (59 preset model entries)\n" +
		"  --dry-run          Show actions without writing\n" +
		"  --no-cache-clear   Skip clearing OpenCode cache\n"
	);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const modernTemplatePath = join(repoRoot, "config", "opencode-modern.json");
const legacyTemplatePath = join(repoRoot, "config", "opencode-legacy.json");

function log(message) {
	console.log(message);
}

function delay(ms) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isWindowsLockError(error) {
	const code = error?.code;
	return code === "EPERM" || code === "EBUSY";
}

function formatErrorForLog(error) {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function resolveHomeDirectory(env = process.env) {
	return env.HOME || env.USERPROFILE || homedir();
}

function buildPaths(homeDir) {
	const configDir = join(homeDir, ".config", "opencode");
	const cacheDir = join(homeDir, ".cache", "opencode");
	return {
		configDir,
		configPath: join(configDir, "opencode.json"),
		tuiConfigPath: join(configDir, "tui.json"),
		cacheDir,
		cacheNodeModulesPaths: getManagedPackageNames().map((name) => join(cacheDir, "node_modules", name)),
		cachePackagePaths: getManagedPackageNames().flatMap((name) => [
			join(cacheDir, "packages", name),
			join(cacheDir, "packages", `${name}@latest`),
		]),
		cacheBunLock: join(cacheDir, "bun.lock"),
		cachePackageJson: join(cacheDir, "package.json"),
		modernTemplatePath,
		legacyTemplatePath,
	};
}

function parseCliArgs(argv = process.argv.slice(2)) {
	const args = new Set(argv);
	if (args.has("--help") || args.has("-h")) {
		return {
			wantsHelp: true,
		};
	}

	const requestedModern = args.has("--modern");
	const requestedFull = args.has("--full");
	const requestedLegacy = args.has("--legacy");
	const explicitPluginOnly = args.has("--plugin-only");

	const requestedModes = [requestedModern, requestedFull, requestedLegacy]
		.filter(Boolean).length;
	if (requestedModes > 1) {
		throw new Error("Choose only one of --modern, --full, or --legacy.");
	}
	if (explicitPluginOnly && requestedModes > 0) {
		throw new Error("--plugin-only cannot be combined with --modern, --full, or --legacy.");
	}
	const pluginOnly = explicitPluginOnly || requestedModes === 0;

	return {
		wantsHelp: false,
		dryRun: args.has("--dry-run"),
		skipCacheClear: args.has("--no-cache-clear"),
		pluginOnly,
		configMode: requestedFull ? "full" : requestedLegacy ? "legacy" : "modern",
	};
}

function parseUpdateArgs(argv) {
	const args = new Set(argv);
	const supported = new Set(["--dry-run", "--help", "-h"]);
	const unknown = argv.find((arg) => !supported.has(arg));
	if (unknown) {
		throw new Error(`Unknown option for update command: ${unknown}`);
	}
	return {
		wantsHelp: args.has("--help") || args.has("-h"),
		dryRun: args.has("--dry-run"),
	};
}

function normalizePluginEntryForMatch(entry) {
	const trimmed = entry.trim();
	let normalized = trimmed.toLowerCase();
	try {
		normalized = decodeURIComponent(normalized);
	} catch {
		// Keep the raw lowercased value when a malformed URI escape is present.
	}
	normalized = normalized.replace(/\\/g, "/").replace(/\/+$/g, "");
	if (normalized.endsWith("/dist")) {
		normalized = normalized.slice(0, -"/dist".length);
	}
	return normalized;
}

function isManagedPluginEntry(entry) {
	if (typeof entry !== "string") return false;
	const trimmed = entry.trim().toLowerCase();
	const normalized = normalizePluginEntryForMatch(entry);
	return getManagedPackageNames().some((name) => {
		const lowerName = name.toLowerCase();
		return trimmed === lowerName ||
			trimmed.startsWith(`${lowerName}@`) ||
			normalized.endsWith(`/${lowerName}`) ||
			normalized.endsWith(`/node_modules/${lowerName}`);
	});
}

function normalizePluginList(list) {
	const entries = Array.isArray(list) ? list.filter(Boolean) : [];
	const filtered = entries.filter((entry) => !isManagedPluginEntry(entry));
	return [...filtered, PACKAGE_NAME];
}

function mergeTuiConfig(existingConfig) {
	const existing = isPlainObject(existingConfig) ? { ...existingConfig } : {};
	const next = { ...existing };
	if (typeof next.$schema !== "string" || !next.$schema.trim()) {
		next.$schema = "https://opencode.ai/tui.json";
	}
	next.plugin = normalizePluginList(existing.plugin);
	return next;
}

function formatJson(obj) {
	return `${JSON.stringify(obj, null, 2)}\n`;
}

function getStandaloneStoragePath(options, env = process.env) {
	if (options.configPath) return resolve(options.configPath);
	return join(resolveHomeDirectory(env), ".opencode", "oc-codex-multi-auth-accounts.json");
}

async function readStandaloneStorage(path) {
	try {
		const raw = await readFile(path, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			storage: parsed && typeof parsed === "object" ? normalizeStandaloneStorage(parsed) : null,
			error: null,
		};
	} catch (error) {
		if (error?.code === "ENOENT") return { storage: null, error: null };
		return { storage: null, error: formatErrorForLog(error) };
	}
}

function normalizeStandaloneIdentityPart(value) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sameStandaloneIdentity(left, right) {
	const normalizedLeft = normalizeStandaloneIdentityPart(left);
	const normalizedRight = normalizeStandaloneIdentityPart(right);
	return !!normalizedLeft && !!normalizedRight && normalizedLeft === normalizedRight;
}

function isStandaloneOrgTokenDuplicate(left, right) {
	const leftOrganizationId = normalizeStandaloneIdentityPart(left?.organizationId);
	const rightOrganizationId = normalizeStandaloneIdentityPart(right?.organizationId);
	if (leftOrganizationId && rightOrganizationId && leftOrganizationId !== rightOrganizationId) return false;
	const leftOrgLike = !!leftOrganizationId || left?.accountIdSource === "org";
	const rightOrgLike = !!rightOrganizationId || right?.accountIdSource === "org";
	const leftTokenLike = !leftOrganizationId && left?.accountIdSource === "token";
	const rightTokenLike = !rightOrganizationId && right?.accountIdSource === "token";
	if (!((leftOrgLike && rightTokenLike) || (rightOrgLike && leftTokenLike))) return false;
	return sameStandaloneIdentity(left?.email, right?.email) ||
		sameStandaloneIdentity(left?.refreshToken, right?.refreshToken);
}

function mergeStandaloneAccounts(target, source) {
	const targetOrgLike = !!normalizeStandaloneIdentityPart(target?.organizationId) || target?.accountIdSource === "org";
	const sourceOrgLike = !!normalizeStandaloneIdentityPart(source?.organizationId) || source?.accountIdSource === "org";
	if (targetOrgLike || !sourceOrgLike) {
		return {
			...source,
			...target,
			organizationId: target.organizationId ?? source.organizationId,
			accountId: target.accountId ?? source.accountId,
			accountIdSource: target.accountIdSource ?? source.accountIdSource,
			accountLabel: target.accountLabel ?? source.accountLabel,
			email: target.email ?? source.email,
		};
	}
	return mergeStandaloneAccounts(source, target);
}

// Mirror of `isStaleGeneratedAccountLabel` / `dropStaleGeneratedLabel` in
// lib/auth/token-utils.ts and lib/storage/normalize.ts. The standalone CLI
// reads the pool through this normalizer and never through the compiled
// `normalizeAccountStorage`, so without the mirror `status`, `list`, `health`,
// `doctor` and `dashboard` keep printing the org-derived label the plugin
// itself now drops - next to the account id, which is the identity the label
// was misnaming. The marker must hold this account's own id suffix so a name
// set with `codex-label` survives.
const GENERATED_LABEL_PATTERN = /\s\[id:[^\]]*\]$/;

function dropStaleStandaloneLabel(account) {
	const label = typeof account?.accountLabel === "string" ? account.accountLabel.trim() : "";
	const accountId = typeof account?.accountId === "string" ? account.accountId.trim() : "";
	if (!label || !accountId) return account;
	const marker = label.match(GENERATED_LABEL_PATTERN)?.[0];
	if (!marker) return account;
	const suffix = accountId.length > 6 ? accountId.slice(-6) : accountId;
	if (marker !== ` [id:${suffix}]`) return account;
	const next = { ...account };
	delete next.accountLabel;
	return next;
}

function normalizeStandaloneStorage(storage) {
	if (!Array.isArray(storage.accounts)) return storage;
	const accounts = [...storage.accounts];
	const removed = new Set();
	for (let i = 0; i < accounts.length; i += 1) {
		if (removed.has(i)) continue;
		for (let j = i + 1; j < accounts.length; j += 1) {
			if (removed.has(j) || !isStandaloneOrgTokenDuplicate(accounts[i], accounts[j])) continue;
			const leftOrgLike = !!normalizeStandaloneIdentityPart(accounts[i]?.organizationId) ||
				accounts[i]?.accountIdSource === "org";
			const targetIndex = leftOrgLike ? i : j;
			const sourceIndex = targetIndex === i ? j : i;
			accounts[targetIndex] = mergeStandaloneAccounts(accounts[targetIndex], accounts[sourceIndex]);
			removed.add(sourceIndex);
			if (sourceIndex === i) break;
		}
	}
	const normalizedAccounts = accounts
		.filter((_, index) => !removed.has(index))
		.map(dropStaleStandaloneLabel);
	return {
		...storage,
		accounts: normalizedAccounts,
		activeIndex: Math.max(0, Math.min(storage.activeIndex ?? 0, Math.max(0, normalizedAccounts.length - 1))),
	};
}

const MASKED_VALUE = "*****";
// The head/tail mask keeps eight characters, so it conceals nothing worth
// concealing below thirteen: `me@x.io` would print in full and `me@x.io12`
// all but its middle character. `doctor` output is what users paste into
// issues, so anything shorter is replaced outright instead. Input is trimmed
// first, or `" me@x.io "` clears the cutoff on padding alone and drops back
// into the partial mask.
const MASK_MIN_LENGTH = 13;

function maskValue(value, includeSensitive) {
	if (includeSensitive || typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return trimmed;
	if (trimmed.length < MASK_MIN_LENGTH) return MASKED_VALUE;
	return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

// Six characters when the id is shown in full, matching what the
// in-conversation surfaces print as `id:`. Four when it is head/tail masked,
// which is the tail `maskValue` already discloses as `accountId` in the same
// payload, so the printed identity never reveals more of an id than the field
// beside it. Nothing at all when the id was too short for that mask: the
// `accountId` next to it is then `*****`, and four raw characters of a short
// id can be the whole id.
function accountIdSuffix(accountId, includeSensitive) {
	if (!accountId) return undefined;
	if (includeSensitive) {
		return accountId.length > 6 ? accountId.slice(-6) : accountId;
	}
	if (accountId.length < MASK_MIN_LENGTH) return undefined;
	return accountId.slice(-4);
}

function summarizeStandaloneAccounts(storage, includeSensitive, tag) {
	const accounts = Array.isArray(storage?.accounts) ? storage.accounts : [];
	const normalizedTag = typeof tag === "string" ? tag.trim().toLowerCase() : "";
	return accounts
		.map((account, index) => ({ account, index }))
		.filter(({ account }) => !normalizedTag ||
			(Array.isArray(account?.accountTags) &&
				account.accountTags.some((entry) => String(entry).toLowerCase() === normalizedTag)))
		.map(({ account, index }) => {
			const trimmedId =
				typeof account?.accountId === "string" ? account.accountId.trim() : "";
			const accountId = trimmedId || undefined;
			return {
				index,
				label: account?.accountLabel ?? `Account ${index + 1}`,
				email: maskValue(account?.email, includeSensitive),
				accountId: maskValue(accountId, includeSensitive),
				idSuffix: accountIdSuffix(accountId, includeSensitive),
				accountIdSource: account?.accountIdSource,
				enabled: account?.enabled !== false,
				hasRefreshToken: typeof account?.refreshToken === "string" && account.refreshToken.length > 0,
				hasAccessToken: typeof account?.accessToken === "string" && account.accessToken.length > 0,
				expiresAt: account?.expiresAt,
				expired: typeof account?.expiresAt === "number" ? account.expiresAt <= Date.now() : undefined,
				tags: Array.isArray(account?.accountTags) ? account.accountTags : [],
				note: account?.accountNote,
				rateLimitResetTimes: account?.rateLimitResetTimes ?? {},
			};
		});
}

function printStandaloneResult(command, payload, json) {
	if (json) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}
	console.log(`oc-codex-multi-auth ${command}`);
	if (payload.message) console.log(payload.message);
	console.log(`Storage: ${payload.storagePath}`);
	console.log(`Accounts: ${payload.totalAccounts}`);
	if (Array.isArray(payload.accounts)) {
		for (const account of payload.accounts) {
			const identity = [account.email, account.idSuffix ? `id:${account.idSuffix}` : undefined]
				.filter(Boolean)
				.join(", ");
			const name = identity ? `${account.label} (${identity})` : account.label;
			console.log(`- [${account.index}] ${name} enabled=${account.enabled} refresh=${account.hasRefreshToken} access=${account.hasAccessToken}`);
		}
	}
	if (payload.error) console.log(`Error: ${payload.error}`);
	for (const fix of payload.appliedFixes ?? []) console.log(`Fixed: ${fix}`);
	for (const error of payload.fixErrors ?? []) console.log(`Repair failed: ${error}`);
	if (payload.nextAction) console.log(`Next: ${payload.nextAction}`);
}

/**
 * Import compiled modules from dist/ so the standalone CLI behaves identically
 * to the in-conversation tools. dist/ ships in the npm package (files
 * allowlist) and none of these modules import the OpenCode plugin runtime, so
 * they load cleanly in plain Node.
 */
async function loadDistModules(relativePaths, label) {
	const distRoot = join(repoRoot, "dist", "lib");
	const toUrl = (rel) => pathToFileURL(join(distRoot, rel)).href;
	try {
		return await Promise.all(relativePaths.map((rel) => import(toUrl(rel))));
	} catch (error) {
		throw new Error(
			`Could not load ${label} runtime from dist/. Build the package first (npm run build). Cause: ${formatErrorForLog(error)}`,
		);
	}
}

async function loadWarmRuntime(env) {
	const [storageMod, usageMod, warmReqMod, warmMod, shutdownMod] = await loadDistModules(
		[
			"storage.js",
			"codex-usage.js",
			"accounts/warm-request.js",
			"accounts/warm.js",
			"shutdown.js",
		],
		"warm",
	);
	// Unlike the plugin, this CLI *is* the process, so it owns termination:
	// Ctrl+C must abort the warm run rather than wait for it to drain.
	// Refreshing a token here persists credentials, which registers the
	// shutdown handler via the storage lock.
	shutdownMod.setShutdownOwnsProcess(true);
	return { storageMod, usageMod, warmReqMod, warmMod, shutdownMod };
}

async function loadLimitsRuntime(env) {
	const [storageMod, usageMod, shutdownMod, loggerMod] = await loadDistModules(
		["storage.js", "codex-usage.js", "shutdown.js", "logger.js"],
		"limits",
	);
	// Fetching usage can refresh (and therefore persist) a token, so the same
	// process-owns-termination rule as `warm` applies.
	shutdownMod.setShutdownOwnsProcess(true);
	return { storageMod, usageMod, shutdownMod, loggerMod };
}

export async function runWarmCommand(parsed, options = {}) {
	const { env = process.env } = options;
	const storagePath = getStandaloneStoragePath(parsed, env);

	let runtime;
	try {
		runtime = await loadWarmRuntime(env);
	} catch (error) {
		const payload = { command: "warm", storagePath, error: formatErrorForLog(error) };
		printWarmResult(payload, parsed.json);
		return { exitCode: 1, action: "warm", storagePath };
	}

	const { storageMod, usageMod, warmReqMod, warmMod } = runtime;
	// Point dist storage at the resolved accounts file so a refreshed token is
	// persisted to the SAME file the rest of the toolchain reads.
	storageMod.setStoragePathDirect(storagePath);

	const storage = await storageMod.loadAccounts();
	const accounts = Array.isArray(storage?.accounts) ? storage.accounts : [];
	if (accounts.length === 0) {
		const payload = {
			command: "warm",
			storagePath,
			totalAccounts: 0,
			warmed: 0,
			failed: 0,
			skipped: 0,
			results: [],
			message: "No accounts configured.",
			nextAction: "Run opencode auth login.",
		};
		printWarmResult(payload, parsed.json);
		return { exitCode: 0, action: "warm", storagePath };
	}

	// Same adapter as lib/tools/codex-warm.ts createWarmOne: refresh → resolve
	// account id → open the usage window; map an exhausted (quota-429) account
	// to a failure so it is not reported as warmed.
	const warmOne = async (account) => {
		const { accessToken } = await usageMod.ensureCodexUsageAccessToken({ storage, account });
		const accountId = usageMod.resolveCodexUsageAccountId({ account, accessToken });
		if (!accountId) {
			return { status: "failed", detail: "could not resolve account id (re-login may be required)" };
		}
		const result = await warmReqMod.warmAccountWindow({
			accountId,
			accessToken,
			organizationId: account.organizationId,
		});
		if (result.status === "exhausted") {
			return { status: "failed", detail: result.detail ?? "quota/usage limit reached" };
		}
		return { status: "warmed" };
	};

	const summary = await warmMod.warmAccounts(accounts, warmOne);
	const payload = {
		command: "warm",
		storagePath,
		totalAccounts: summary.total,
		warmed: summary.warmedCount,
		failed: summary.failedCount,
		skipped: summary.skippedCount,
		results: summary.results.map((r) => ({
			index: r.index,
			email: maskValue(accounts[r.index]?.email, parsed.includeSensitive),
			status: r.status,
			detail: r.detail,
		})),
	};
	printWarmResult(payload, parsed.json);
	return { exitCode: summary.failedCount > 0 ? 1 : 0, action: "warm", storagePath };
}

function printWarmResult(payload, json) {
	if (json) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}
	console.log(`oc-codex-multi-auth warm`);
	if (payload.message) console.log(payload.message);
	console.log(`Storage: ${payload.storagePath}`);
	if (payload.error) {
		console.log(`Error: ${payload.error}`);
		return;
	}
	console.log(`Accounts: ${payload.totalAccounts}`);
	for (const r of payload.results ?? []) {
		const label = r.email ? `[${r.index}] ${r.email}` : `[${r.index}]`;
		const detail = r.detail ? ` — ${r.detail}` : "";
		console.log(`- ${label}: ${r.status}${detail}`);
	}
	console.log(`Summary: ${payload.warmed} warmed, ${payload.failed} failed, ${payload.skipped} skipped`);
	if (payload.nextAction) console.log(`Next: ${payload.nextAction}`);
}

/**
 * `limits` — show live 5-hour and weekly Codex usage per account (#209).
 *
 * Reuses the compiled `codex-usage` runtime so the CLI reports the same windows
 * as the in-conversation `codex-limits` tool. The locally persisted
 * `rateLimitResetTimes` is carried in the payload as well: it is the only
 * rate-limit state available for an account whose live fetch fails, and
 * `--json` consumers of the previous behavior still find the field.
 */
export async function runLimitsCommand(parsed, options = {}) {
	const { env = process.env } = options;
	const storagePath = getStandaloneStoragePath(parsed, env);

	let runtime;
	try {
		runtime = await loadLimitsRuntime(env);
	} catch (error) {
		const payload = { command: "limits", storagePath, error: formatErrorForLog(error) };
		printLimitsResult(payload, parsed.json);
		return { exitCode: 1, action: "limits", storagePath };
	}

	const { storageMod, usageMod, loggerMod } = runtime;
	// Point dist storage at the resolved accounts file so a refreshed token is
	// persisted to the SAME file the rest of the toolchain reads.
	storageMod.setStoragePathDirect(storagePath);

	const storage = await storageMod.loadAccounts();
	const accounts = Array.isArray(storage?.accounts) ? storage.accounts : [];
	if (accounts.length === 0) {
		const payload = {
			command: "limits",
			storagePath,
			totalAccounts: 0,
			accounts: [],
			message: "No accounts configured.",
			nextAction: "Run opencode auth login.",
		};
		printLimitsResult(payload, parsed.json);
		return { exitCode: 0, action: "limits", storagePath };
	}

	// Same workspace dedupe the codex-limits tool applies, so two entries for one
	// workspace are not billed and printed twice.
	const indices = usageMod.deduplicateUsageAccountIndices(storage);
	// `--tag` must gate which accounts are contacted at all, not just which are
	// printed: an untagged account would otherwise be billed a usage fetch and
	// could have its refreshed credentials persisted.
	const normalizedTag =
		typeof parsed.tag === "string" ? parsed.tag.trim().toLowerCase() : "";
	const results = [];
	let failedCount = 0;

	for (const index of indices) {
		const account = accounts[index];
		if (!account) continue;
		if (
			normalizedTag &&
			!(
				Array.isArray(account.accountTags) &&
				account.accountTags.some((entry) => String(entry).toLowerCase() === normalizedTag)
			)
		) {
			continue;
		}
		const entry = {
			index,
			label: account.accountLabel ?? `Account ${index + 1}`,
			email: maskValue(account.email, parsed.includeSensitive),
			rateLimitResetTimes: account.rateLimitResetTimes ?? {},
		};
		try {
			const { accessToken } = await usageMod.ensureCodexUsageAccessToken({ storage, account });
			const accountId = usageMod.resolveCodexUsageAccountId({ account, accessToken });
			if (!accountId) {
				throw new Error("could not resolve account id (re-login may be required)");
			}
			const usage = usageMod.parseCodexUsagePayload(
				await usageMod.fetchCodexUsage({
					accountId,
					accessToken,
					organizationId: account.organizationId,
				}),
			);
			const quotaExhaustedResetAtMs = usageMod.getUsageQuotaExhaustedResetAtMs([
				usage.primary,
				usage.secondary,
			]);
			if (quotaExhaustedResetAtMs !== undefined) {
				try {
					await usageMod.persistUsageQuotaExhaustion(account, quotaExhaustedResetAtMs);
				} catch (error) {
					loggerMod.logWarn(
						`[${PACKAGE_NAME}] Failed to persist exhausted usage quota: ${formatErrorForLog(error)}`,
					);
				}
			}
			entry.planType = usage.planType;
			entry.credits = usage.credits;
			// Raw counts stay in `resetCredits` and the rendered line lives in
			// its own field: embedding the English summary inside the counts
			// object would make `--json` consumers parse presentation text to
			// reach a number that is already beside it.
			entry.resetCredits = usage.resetCredits;
			entry.resetCreditsSummary = usage.resetCredits
				? usageMod.formatResetCredits(usage.resetCredits)
				: null;
			entry.limits = usage.limits;
		} catch (error) {
			// `ensureCodexUsageAccessToken` can surface a raw OAuth refresh
			// response, so the message is redacted through the logger's token
			// patterns before it reaches stdout, JSON output, or CI logs.
			// Truncation alone does not protect bearer/JWT/refresh-token material.
			entry.error = loggerMod.maskString(formatErrorForLog(error)).slice(0, 160);
			failedCount += 1;
		}
		results.push(entry);
	}

	const payload = {
		command: "limits",
		storagePath,
		totalAccounts: accounts.length,
		shownAccounts: results.length,
		accounts: results,
	};
	printLimitsResult(payload, parsed.json);
	return { exitCode: failedCount > 0 ? 1 : 0, action: "limits", storagePath };
}

function printLimitsResult(payload, json) {
	if (json) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}
	console.log(`oc-codex-multi-auth limits`);
	if (payload.message) console.log(payload.message);
	console.log(`Storage: ${payload.storagePath}`);
	if (payload.error) {
		console.log(`Error: ${payload.error}`);
		return;
	}
	console.log(`Accounts: ${payload.totalAccounts}`);
	for (const account of payload.accounts ?? []) {
		const label = account.email ? `${account.label} (${account.email})` : account.label;
		console.log(`- [${account.index}] ${label}`);
		if (account.error) {
			console.log(`  Error: ${account.error}`);
			continue;
		}
		for (const limit of account.limits ?? []) {
			console.log(`  ${limit.name}: ${limit.summary}`);
		}
		if ((account.limits ?? []).length === 0) {
			console.log("  No usage windows reported yet.");
		}
		if (account.planType) console.log(`  Plan: ${account.planType}`);
		if (account.credits) console.log(`  Credits: ${account.credits}`);
		if (account.resetCredits && account.resetCredits.available > 0) {
			console.log(`  Resets: ${account.resetCreditsSummary}`);
		}
	}
	if (payload.nextAction) console.log(`Next: ${payload.nextAction}`);
}

export async function runStandaloneCommand(command, argv = [], options = {}) {
	const parsed = parseStandaloneArgs(argv);
	if (command === "diag") {
		command = "doctor";
		parsed.deep = true;
	}
	if (parsed.help) {
		printHelp();
		return { exitCode: 0, action: "help" };
	}
	if (command === "warm") {
		return runWarmCommand(parsed, options);
	}
	if (command === "limits") {
		return runLimitsCommand(parsed, options);
	}
	const { env = process.env } = options;
	const storagePath = getStandaloneStoragePath(parsed, env);
	let { storage, error } = await readStandaloneStorage(storagePath);
	const appliedFixes = [];
	const fixErrors = [];
	if (command === "doctor" && parsed.fix && storage && !error) {
		const previousKeychain = process.env.CODEX_KEYCHAIN;
		try {
			const loadDoctorRuntime = options.loadDoctorRuntime ?? (() => loadDistModules(
				["storage.js", "tools/doctor-repair.js", "shutdown.js"], "doctor",
			));
			const [storageMod, repairMod, shutdownMod] = await loadDoctorRuntime();
			// A CLI file selection must not read or replace the global keychain pool.
			process.env.CODEX_KEYCHAIN = "0";
			storageMod.setStoragePathDirect(storagePath);
			shutdownMod.setShutdownOwnsProcess(true);
			const current = await storageMod.loadAccounts();
			if (!current) throw new Error("Account storage is unavailable");
			const repair = await repairMod.repairDoctorAccounts(current.accounts);
			appliedFixes.push(...repair.appliedFixes);
			fixErrors.push(...repair.fixErrors);
		} catch {
			fixErrors.push("Doctor repair could not complete. Check the selected storage file and installed runtime.");
		} finally {
			if (previousKeychain === undefined) delete process.env.CODEX_KEYCHAIN;
			else process.env.CODEX_KEYCHAIN = previousKeychain;
		}
		({ storage, error } = await readStandaloneStorage(storagePath));
	}
	const accounts = summarizeStandaloneAccounts(storage, parsed.includeSensitive, parsed.tag);
	const totalAccounts = Array.isArray(storage?.accounts) ? storage.accounts.length : 0;
	const payload = {
		command,
		storagePath,
		totalAccounts,
		shownAccounts: accounts.length,
		activeIndex: typeof storage?.activeIndex === "number" ? storage.activeIndex : 0,
		activeIndexByFamily: storage?.activeIndexByFamily ?? {},
		accounts,
		error,
	};
	if (command === "dashboard") {
		payload.message = "Standalone dashboard server is not launched by this safe CLI; use status/list/limits/health or OpenCode codex-dashboard.";
		payload.nextAction = "Run oc-codex-multi-auth status or open OpenCode and call codex-dashboard.";
	} else if (command === "doctor") {
		payload.message = error ? "Storage could not be parsed." : totalAccounts > 0 ? "Local diagnostics completed." : "No accounts configured.";
		payload.deep = parsed.deep;
		payload.fixApplied = parsed.fix ? appliedFixes.length > 0 : undefined;
		if (parsed.fix) {
			payload.appliedFixes = appliedFixes;
			payload.fixErrors = fixErrors;
		}
		payload.nextAction = totalAccounts > 0 ? "Run oc-codex-multi-auth health --json for scriptable checks." : "Run opencode auth login.";
	} else if (command === "health") {
		payload.healthyCount = accounts.filter((account) => account.enabled && account.hasRefreshToken).length;
		payload.unhealthyCount = accounts.filter((account) => !account.enabled || !account.hasRefreshToken).length;
	} else if (command === "status") {
		payload.message = totalAccounts > 0 ? "Account storage loaded." : "No accounts configured.";
	}
	printStandaloneResult(command, payload, parsed.json);
	return { exitCode: error || fixErrors.length > 0 ? 1 : 0, action: command, storagePath };
}

// Top-level keys inside `provider.openai` that the installer owns absolutely.
// These are always sourced from the template (overwritten or removed) so the
// plugin's required runtime shape is authoritative. Any OTHER key the user has
// placed under `provider.openai` is preserved as-is. `models` is handled
// separately because it's a map where user-added model ids must survive while
// template-shipped ids win on collision.
const MANAGED_OPENAI_KEYS = new Set(["baseURL", "apiKey", "options"]);

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Deep-merge `provider.openai` preserving unknown user keys while letting the
// installer overwrite the managed shape it ships. This replaces the earlier
// wholesale overwrite which clobbered custom user-added keys (see audit top-20
// #6).
function mergeOpenaiProvider(existingOpenai, templateOpenai, options = {}) {
	const existingSafe = isPlainObject(existingOpenai) ? existingOpenai : {};
	const templateSafe = isPlainObject(templateOpenai) ? templateOpenai : {};
	const modelKeysToRemove = options.modelKeysToRemove instanceof Set
		? options.modelKeysToRemove
		: new Set();

	const result = {};

	// 1. Start with the user's non-managed keys (unknown-to-installer settings).
	for (const [key, value] of Object.entries(existingSafe)) {
		if (MANAGED_OPENAI_KEYS.has(key)) continue;
		if (key === "models") continue; // handled explicitly below
		result[key] = value;
	}

	// 2. Apply template-managed keys. Installer is source of truth for these.
	for (const [key, value] of Object.entries(templateSafe)) {
		if (key === "models") continue; // handled explicitly below
		result[key] = value;
	}

	// 3. Merge `models` by id: template wins on collision, user-added ids survive.
	const existingModels = isPlainObject(existingSafe.models) ? existingSafe.models : {};
	const templateModels = isPlainObject(templateSafe.models) ? templateSafe.models : {};
	const prunedExistingModels = Object.fromEntries(
		Object.entries(existingModels).filter(([key]) => !modelKeysToRemove.has(key)),
	);
	const mergedModels = { ...prunedExistingModels, ...templateModels };
	if (Object.keys(mergedModels).length > 0) {
		result.models = mergedModels;
	}

	return result;
}

// Naive line-by-line diff for displaying config changes in dry-run. Good enough
// for eyeballing; not intended to be parsed or round-tripped.
function formatConfigDiff(existingConfig, nextConfig) {
	const oldText = existingConfig === undefined ? "" : formatJson(existingConfig);
	const newText = formatJson(nextConfig);
	if (oldText === newText) {
		return "(no changes)";
	}
	const lines = [];
	lines.push("--- existing");
	lines.push("+++ proposed");
	if (existingConfig === undefined) {
		lines.push("- (no existing config)");
	} else {
		for (const line of oldText.split("\n")) {
			lines.push(`- ${line}`);
		}
	}
	for (const line of newText.split("\n")) {
		lines.push(`+ ${line}`);
	}
	return lines.join("\n");
}

function formatRedactedConfigDiff(existingConfig, nextConfig) {
	const missing = Symbol("missing");
	const changes = [];
	const visit = (existing, next, path) => {
		if (existing === missing) {
			changes.push(`+ ${path}`);
			return;
		}
		if (next === missing) {
			changes.push(`- ${path}`);
			return;
		}
		if (Object.is(existing, next)) return;

		if (Array.isArray(existing) && Array.isArray(next)) {
			const length = Math.max(existing.length, next.length);
			for (let index = 0; index < length; index += 1) {
				visit(
					index < existing.length ? existing[index] : missing,
					index < next.length ? next[index] : missing,
					`${path}[${index}]`,
				);
			}
			return;
		}

		if (isPlainObject(existing) && isPlainObject(next)) {
			const keys = new Set([...Object.keys(existing), ...Object.keys(next)]);
			for (const key of keys) {
				visit(
					Object.hasOwn(existing, key) ? existing[key] : missing,
					Object.hasOwn(next, key) ? next[key] : missing,
					`${path}.${key}`,
				);
			}
			return;
		}

		changes.push(`~ ${path}`);
	};

	visit(existingConfig === undefined ? missing : existingConfig, nextConfig, "$");
	return changes.length > 0 ? changes.join("\n") : "(no changes)";
}

function mergeFullTemplate(modernTemplate, legacyTemplate) {
	const modernModels = modernTemplate.provider?.openai?.models ?? {};
	const legacyModels = legacyTemplate.provider?.openai?.models ?? {};
	const overlappingKeys = Object.keys(modernModels).filter((key) => Object.hasOwn(legacyModels, key));

	if (overlappingKeys.length > 0) {
		throw new Error(`Full config template collision for model keys: ${overlappingKeys.join(", ")}`);
	}

	return {
		...modernTemplate,
		provider: {
			...(modernTemplate.provider ?? {}),
			openai: {
				...(modernTemplate.provider?.openai ?? {}),
				models: {
					...modernModels,
					...legacyModels,
				},
			},
		},
	};
}

function getTemplateModelKeys(template) {
	return new Set(Object.keys(template.provider?.openai?.models ?? {}));
}

async function readJson(filePath) {
	const content = await readFile(filePath, "utf-8");
	return JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
}

async function renameWithWindowsRetry(sourcePath, destinationPath) {
	let lastError = null;

	for (let attempt = 0; attempt < WINDOWS_RENAME_RETRY_ATTEMPTS; attempt += 1) {
		try {
			await rename(sourcePath, destinationPath);
			return;
		} catch (error) {
			if (isWindowsLockError(error)) {
				lastError = error;
				await delay(WINDOWS_RENAME_RETRY_BASE_DELAY_MS * 2 ** attempt);
				continue;
			}
			throw error;
		}
	}

	if (lastError) {
		throw lastError;
	}
}

async function removeWithWindowsRetry(path, options) {
	let lastError = null;

	for (let attempt = 0; attempt < WINDOWS_RENAME_RETRY_ATTEMPTS; attempt += 1) {
		try {
			await rm(path, options);
			return;
		} catch (error) {
			if (isWindowsLockError(error)) {
				lastError = error;
				await delay(WINDOWS_RENAME_RETRY_BASE_DELAY_MS * 2 ** attempt);
				continue;
			}
			throw error;
		}
	}

	if (lastError) {
		throw lastError;
	}
}

async function writeFileAtomic(filePath, content) {
	const uniqueSuffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
	const tempPath = `${filePath}.${uniqueSuffix}.tmp`;

	try {
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
		await renameWithWindowsRetry(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

async function loadTemplate(mode, paths) {
	if (mode === "modern") {
		return readJson(paths.modernTemplatePath);
	}
	if (mode === "legacy") {
		return readJson(paths.legacyTemplatePath);
	}

	const [modernTemplate, legacyTemplate] = await Promise.all([
		readJson(paths.modernTemplatePath),
		readJson(paths.legacyTemplatePath),
	]);

	return mergeFullTemplate(modernTemplate, legacyTemplate);
}

async function copyFileWithWindowsRetry(sourcePath, destinationPath) {
	let lastError = null;

	for (let attempt = 0; attempt < WINDOWS_RENAME_RETRY_ATTEMPTS; attempt += 1) {
		try {
			await copyFile(sourcePath, destinationPath);
			return;
		} catch (error) {
			if (isWindowsLockError(error)) {
				lastError = error;
				await delay(WINDOWS_RENAME_RETRY_BASE_DELAY_MS * 2 ** attempt);
				continue;
			}
			throw error;
		}
	}

	if (lastError) {
		throw lastError;
	}
}

async function backupConfig(sourcePath, dryRun) {
	const timestamp = new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace("T", "_")
		.replace("Z", "");
	const backupPath = `${sourcePath}.bak-${timestamp}`;
	if (!dryRun) {
		await copyFileWithWindowsRetry(sourcePath, backupPath);
	}
	return backupPath;
}

async function removePluginFromCachePackage(paths, dryRun) {
	if (!existsSync(paths.cachePackageJson)) {
		return;
	}

	let cacheData;
	try {
		cacheData = await readJson(paths.cachePackageJson);
	} catch (error) {
		log(`Warning: Could not parse ${paths.cachePackageJson} (${formatErrorForLog(error)}). Skipping.`);
		return;
	}

	const sections = [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	];

	let changed = false;
	for (const section of sections) {
		const deps = cacheData?.[section];
		if (deps && typeof deps === "object") {
			for (const name of getManagedPackageNames()) {
				if (name in deps) {
					delete deps[name];
					changed = true;
				}
			}
		}
	}

	if (!changed) {
		return;
	}

	if (dryRun) {
		log(`[dry-run] Would update ${paths.cachePackageJson} to remove ${getManagedPackageNames().join(", ")}`);
		return;
	}

	await writeFileAtomic(paths.cachePackageJson, formatJson(cacheData));
}

async function clearCache(paths, dryRun, skipCacheClear) {
	if (skipCacheClear) {
		log("Skipping cache clear (--no-cache-clear).");
		await removePluginFromCachePackage(paths, dryRun);
		return;
	}

	if (dryRun) {
		for (const cacheNodeModulesPath of paths.cacheNodeModulesPaths) {
			log(`[dry-run] Would remove ${cacheNodeModulesPath}`);
		}
		for (const cachePackagePath of paths.cachePackagePaths) {
			log(`[dry-run] Would remove ${cachePackagePath}`);
		}
		log(`[dry-run] Would remove ${paths.cacheBunLock}`);
	} else {
		for (const cacheNodeModulesPath of paths.cacheNodeModulesPaths) {
			await removeWithWindowsRetry(cacheNodeModulesPath, { recursive: true, force: true });
		}
		for (const cachePackagePath of paths.cachePackagePaths) {
			await removeWithWindowsRetry(cachePackagePath, { recursive: true, force: true });
		}
		await removeWithWindowsRetry(paths.cacheBunLock, { force: true });
	}

	await removePluginFromCachePackage(paths, dryRun);
}

export async function runInstaller(argv = process.argv.slice(2), options = {}) {
	const split = splitCommandArgv(argv);
	if (split.kind === "standalone") {
		return runStandaloneCommand(split.command, split.argv, options);
	}
	if (split.kind === "unknown") {
		printHelp();
		throw new Error(`Unknown command: ${split.command}`);
	}
	const { env = process.env } = options;
	const paths = buildPaths(resolveHomeDirectory(env));
	if (split.kind === "update") {
		const parsedUpdate = parseUpdateArgs(split.argv);
		if (parsedUpdate.wantsHelp) {
			printHelp();
			return { exitCode: 0, action: "help" };
		}
		await clearCache(paths, parsedUpdate.dryRun, false);
		log(`\n${parsedUpdate.dryRun ? "Dry run complete." : "Cache cleared."} Restart OpenCode to install the latest plugin.`);
		return {
			exitCode: 0,
			action: "update",
			dryRun: Boolean(parsedUpdate.dryRun),
		};
	}
	const parsed = parseCliArgs(split.argv);
	if (parsed.wantsHelp) {
		printHelp();
		return { exitCode: 0, action: "help" };
	}

	const { configMode, dryRun, skipCacheClear, pluginOnly } = parsed;
	const effectiveConfigMode = pluginOnly ? "plugin-only" : configMode;
	const requiredTemplatePaths = pluginOnly
		? []
		: configMode === "modern"
			? [paths.modernTemplatePath]
			: configMode === "legacy"
				? [paths.legacyTemplatePath]
				: [paths.modernTemplatePath, paths.legacyTemplatePath];

	for (const templatePath of requiredTemplatePaths) {
		if (!existsSync(templatePath)) {
			throw new Error(`Config template not found at ${templatePath}`);
		}
	}

	const template = pluginOnly
		? { $schema: "https://opencode.ai/config.json", plugin: [PACKAGE_NAME] }
		: await loadTemplate(configMode, paths);
	template.plugin = [PACKAGE_NAME];
	const modelKeysToRemove = new Set(STALE_MANAGED_MODEL_KEYS);
	if (!pluginOnly && configMode === "modern") {
		for (const key of getTemplateModelKeys(await readJson(paths.legacyTemplatePath))) {
			modelKeysToRemove.add(key);
		}
	}
	if (!pluginOnly && configMode === "legacy") {
		for (const key of getTemplateModelKeys(await readJson(paths.modernTemplatePath))) {
			modelKeysToRemove.add(key);
		}
	}

	let nextConfig = pluginOnly
		? { $schema: template.$schema, plugin: [PACKAGE_NAME] }
		: template;
	let existingConfig;
	if (existsSync(paths.configPath)) {
		try {
			const existing = await readJson(paths.configPath);
			if (!isPlainObject(existing)) {
				throw new Error("config root must be a JSON object");
			}
			existingConfig = existing;
			const merged = { ...existing };
			merged.plugin = normalizePluginList(existing.plugin);
			if (!pluginOnly) {
				const provider = (existing.provider && typeof existing.provider === "object")
					? { ...existing.provider }
					: {};
				provider.openai = mergeOpenaiProvider(existing.provider?.openai, template.provider?.openai, {
					modelKeysToRemove,
				});
				merged.provider = provider;
			}
			nextConfig = merged;
		} catch (error) {
			if (pluginOnly) {
				throw new Error(
					`Could not parse existing config (${formatErrorForLog(error)}). Refusing to replace it in --plugin-only mode.`,
				);
			}
			log(`Warning: Could not parse existing config (${formatErrorForLog(error)}). Replacing with template.`);
			existingConfig = undefined;
			nextConfig = template;
		}
	} else {
		log("No existing config found. Creating new global config.");
	}

	let nextTuiConfig = mergeTuiConfig(undefined);
	let existingTuiConfig;
	if (existsSync(paths.tuiConfigPath)) {
		try {
			const existing = await readJson(paths.tuiConfigPath);
			if (!isPlainObject(existing)) {
				throw new Error("TUI config root must be a JSON object");
			}
			existingTuiConfig = existing;
			nextTuiConfig = mergeTuiConfig(existing);
		} catch (error) {
			if (pluginOnly) {
				throw new Error(
					`Could not parse existing TUI config (${formatErrorForLog(error)}). Refusing to replace it in --plugin-only mode.`,
				);
			}
			log(`Warning: Could not parse existing TUI config (${formatErrorForLog(error)}). Replacing with minimal TUI config.`);
			existingTuiConfig = undefined;
			nextTuiConfig = mergeTuiConfig(undefined);
		}
	} else {
		log("No existing TUI config found. Creating new global TUI config.");
	}

	const configChanged = existingConfig === undefined || formatJson(existingConfig) !== formatJson(nextConfig);
	const tuiConfigChanged = existingTuiConfig === undefined || formatJson(existingTuiConfig) !== formatJson(nextTuiConfig);
	let wrote = false;
	if (dryRun) {
		log(`[dry-run] ${configChanged ? "Would write" : "Would leave unchanged"} ${paths.configPath} using ${effectiveConfigMode} config`);
		log(`[dry-run] Diff for ${paths.configPath}:`);
		log(formatRedactedConfigDiff(existingConfig, nextConfig));
		log(`[dry-run] ${tuiConfigChanged ? "Would write" : "Would leave unchanged"} ${paths.tuiConfigPath} with the TUI status plugin`);
		log(`[dry-run] Diff for ${paths.tuiConfigPath}:`);
		log(formatRedactedConfigDiff(existingTuiConfig, nextTuiConfig));
	} else {
		if (configChanged) {
			if (existsSync(paths.configPath)) {
				const backupPath = await backupConfig(paths.configPath, false);
				log(`Backup created: ${backupPath}`);
			}
			await writeFileAtomic(paths.configPath, formatJson(nextConfig));
			wrote = true;
			log(`Wrote ${paths.configPath} (${effectiveConfigMode} config)`);
		} else {
			log(`Left ${paths.configPath} unchanged`);
		}
		if (tuiConfigChanged) {
			if (existsSync(paths.tuiConfigPath)) {
				const backupPath = await backupConfig(paths.tuiConfigPath, false);
				log(`Backup created: ${backupPath}`);
			}
			await writeFileAtomic(paths.tuiConfigPath, formatJson(nextTuiConfig));
			wrote = true;
			log(`Wrote ${paths.tuiConfigPath} (TUI status plugin)`);
		} else {
			log(`Left ${paths.tuiConfigPath} unchanged`);
		}
	}

	await clearCache(paths, dryRun, skipCacheClear);

	log("\nDone. Restart OpenCode to (re)install the plugin.");
	log("Example: opencode");
	if (!pluginOnly && configMode === "modern") {
		log("Note: Modern config intentionally shows 13 base OAuth model entries; use the variant picker for reasoning presets.");
	}
	if (!pluginOnly && configMode === "legacy") {
		log("Note: Legacy config writes 59 explicit preset entries and is also safe for older OpenCode versions.");
	}
	if (!pluginOnly && configMode === "full") {
		log("Note: Full config installs both compact base models and explicit preset entries for direct selector IDs.");
	}

	return {
		exitCode: 0,
		action: "install",
		configMode: effectiveConfigMode,
		pluginOnly,
		configPath: paths.configPath,
		tuiConfigPath: paths.tuiConfigPath,
		dryRun: Boolean(dryRun),
		wrote,
	};
}

export const __test = {
	buildPaths,
	backupConfig,
	copyFileWithWindowsRetry,
	formatConfigDiff,
	formatRedactedConfigDiff,
	mergeFullTemplate,
	mergeOpenaiProvider,
	mergeTuiConfig,
	parseCliArgs,
	removeWithWindowsRetry,
	runStandaloneCommand,
	splitCommandArgv,
	writeFileAtomic,
	renameWithWindowsRetry,
	resolveHomeDirectory,
};

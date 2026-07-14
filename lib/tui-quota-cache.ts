import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { renameWithWindowsRetry } from "./storage/atomic-write.js";
import type { CompactQuotaLimit } from "./tui-status.js";

export const TUI_QUOTA_CACHE_VERSION = 1;
export const TUI_QUOTA_CACHE_FILE = "oc-codex-multi-auth-tui-quota.json";
const TUI_QUOTA_CACHE_WRITE_SKIP_MS = 500;

export type TuiQuotaSource = "headers" | "usage";

export type TuiQuotaLimit = CompactQuotaLimit & {
	usedPercent?: number;
	windowMinutes?: number;
	resetAtMs?: number;
};

export type TuiQuotaSnapshot = {
	version: typeof TUI_QUOTA_CACHE_VERSION;
	fingerprint: string;
	fetchedAt: number;
	source: TuiQuotaSource;
	accountIndex?: number;
	accountCount?: number;
	accountEmail?: string;
	accountLabel?: string;
	planType?: string;
	activeLimit?: number;
	limits: TuiQuotaLimit[];
};

export type TuiQuotaSnapshotInput = Omit<
	TuiQuotaSnapshot,
	"version" | "fetchedAt"
> & {
	fetchedAt?: number;
};

type RecentTuiQuotaWrite = {
	key: string;
	at: number;
	promise?: Promise<void>;
};

const recentTuiQuotaWrites = new Map<string, RecentTuiQuotaWrite>();

function getDefaultOpenCodeStateDir(): string {
	return join(homedir(), ".local", "state", "opencode");
}

export function getTuiQuotaCachePath(stateDir?: string): string {
	const envStateDir = process.env.OPENCODE_STATE_DIR?.trim();
	return join(stateDir?.trim() || envStateDir || getDefaultOpenCodeStateDir(), TUI_QUOTA_CACHE_FILE);
}

function parseFiniteNumberHeader(
	headers: Headers,
	name: string,
): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFiniteIntHeader(
	headers: Headers,
	name: string,
): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseResetAtMs(headers: Headers, prefix: string): number | undefined {
	const resetAfterSeconds = parseFiniteIntHeader(
		headers,
		`${prefix}-reset-after-seconds`,
	);
	if (
		typeof resetAfterSeconds === "number" &&
		Number.isFinite(resetAfterSeconds) &&
		resetAfterSeconds > 0
	) {
		return Date.now() + resetAfterSeconds * 1000;
	}

	const resetAtRaw = headers.get(`${prefix}-reset-at`);
	if (!resetAtRaw) return undefined;
	const trimmed = resetAtRaw.trim();
	if (/^\d+$/.test(trimmed)) {
		const parsedNumber = Number.parseInt(trimmed, 10);
		if (Number.isFinite(parsedNumber) && parsedNumber > 0) {
			return parsedNumber < 10_000_000_000
				? parsedNumber * 1000
				: parsedNumber;
		}
	}

	const parsedDate = Date.parse(trimmed);
	return Number.isFinite(parsedDate) ? parsedDate : undefined;
}

function formatWindowLabel(windowMinutes: number | undefined): string {
	if (
		!windowMinutes ||
		!Number.isFinite(windowMinutes) ||
		windowMinutes <= 0
	) {
		return "quota";
	}
	if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${windowMinutes}m`;
}

function getLeftPercent(usedPercent: number | undefined): number | null {
	return typeof usedPercent === "number" && Number.isFinite(usedPercent)
		? Math.max(0, Math.min(100, Math.round(100 - usedPercent)))
		: null;
}

function hasCodexQuotaHeaders(headers: Headers): boolean {
	const keys = [
		"x-codex-primary-used-percent",
		"x-codex-primary-window-minutes",
		"x-codex-primary-reset-at",
		"x-codex-primary-reset-after-seconds",
		"x-codex-secondary-used-percent",
		"x-codex-secondary-window-minutes",
		"x-codex-secondary-reset-at",
		"x-codex-secondary-reset-after-seconds",
	];
	return keys.some((key) => headers.get(key) !== null);
}

function parseLimit(headers: Headers, prefix: string): TuiQuotaLimit {
	const usedPercent = parseFiniteNumberHeader(headers, `${prefix}-used-percent`);
	const windowMinutes = parseFiniteIntHeader(
		headers,
		`${prefix}-window-minutes`,
	);
	const resetAtMs = parseResetAtMs(headers, prefix);
	return {
		label: formatWindowLabel(windowMinutes),
		leftPercent: getLeftPercent(usedPercent),
		usedPercent,
		windowMinutes,
		resetAtMs,
	};
}

/**
 * A window OpenAI reports with `window-minutes: 0` is switched off for the
 * plan, not a window of unknown length. Such a window still carries
 * `used-percent: 0`, so it must be recognized by the explicit zero rather than
 * by the absence of data — otherwise it renders as a full `quota 100%` segment.
 * A window whose header is absent entirely stays eligible: that is an unknown
 * window, and it is still shown under the generic `quota` label.
 */
export function isDisabledQuotaLimit(limit: TuiQuotaLimit): boolean {
	return limit.windowMinutes === 0;
}

function hasUsefulLimit(limit: TuiQuotaLimit): boolean {
	if (isDisabledQuotaLimit(limit)) return false;
	return Boolean(
		limit.windowMinutes ||
			typeof limit.usedPercent === "number" ||
			typeof limit.resetAtMs === "number",
	);
}

export function createTuiQuotaSnapshot(
	input: TuiQuotaSnapshotInput,
): TuiQuotaSnapshot {
	return {
		version: TUI_QUOTA_CACHE_VERSION,
		...input,
		fetchedAt: input.fetchedAt ?? Date.now(),
	};
}

function getSnapshotWriteKey(snapshot: TuiQuotaSnapshot): string {
	return JSON.stringify({
		fingerprint: snapshot.fingerprint,
		source: snapshot.source,
		accountIndex: snapshot.accountIndex,
		accountCount: snapshot.accountCount,
		accountEmail: snapshot.accountEmail,
		accountLabel: snapshot.accountLabel,
		planType: snapshot.planType,
		activeLimit: snapshot.activeLimit,
		limits: snapshot.limits.map((limit) => ({
			label: limit.label,
			leftPercent: limit.leftPercent,
			usedPercent: limit.usedPercent,
			windowMinutes: limit.windowMinutes,
			resetAtMs: limit.resetAtMs,
		})),
	});
}

export function parseTuiQuotaSnapshotFromHeaders(
	headers: Headers,
	input: Omit<TuiQuotaSnapshotInput, "source" | "limits">,
): TuiQuotaSnapshot | undefined {
	if (!hasCodexQuotaHeaders(headers)) return undefined;
	const limits = [
		parseLimit(headers, "x-codex-primary"),
		parseLimit(headers, "x-codex-secondary"),
	].filter(hasUsefulLimit);
	if (limits.length === 0) return undefined;

	const planTypeRaw = headers.get("x-codex-plan-type");
	const planType = planTypeRaw?.trim() || undefined;
	const activeLimit = parseFiniteIntHeader(headers, "x-codex-active-limit");

	return createTuiQuotaSnapshot({
		...input,
		source: "headers",
		planType,
		activeLimit,
		limits,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
	return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isNullablePercent(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" &&
			Number.isFinite(value) &&
			value >= 0 &&
			value <= 100)
	);
}

function isTuiQuotaLimit(value: unknown): value is TuiQuotaLimit {
	return (
		isRecord(value) &&
		typeof value.label === "string" &&
		value.label.trim().length > 0 &&
		isNullablePercent(value.leftPercent) &&
		isOptionalFiniteNumber(value.usedPercent) &&
		isOptionalFiniteNumber(value.windowMinutes) &&
		isOptionalFiniteNumber(value.resetAtMs)
	);
}

export function isTuiQuotaSnapshot(value: unknown): value is TuiQuotaSnapshot {
	return (
		isRecord(value) &&
		value.version === TUI_QUOTA_CACHE_VERSION &&
		typeof value.fingerprint === "string" &&
		value.fingerprint.trim().length > 0 &&
		typeof value.fetchedAt === "number" &&
		Number.isFinite(value.fetchedAt) &&
		(value.source === "headers" || value.source === "usage") &&
		isOptionalFiniteNumber(value.accountIndex) &&
		isOptionalFiniteNumber(value.accountCount) &&
		(value.accountEmail === undefined ||
			typeof value.accountEmail === "string") &&
		(value.accountLabel === undefined ||
			typeof value.accountLabel === "string") &&
		(value.planType === undefined || typeof value.planType === "string") &&
		isOptionalFiniteNumber(value.activeLimit) &&
		Array.isArray(value.limits) &&
		value.limits.every(isTuiQuotaLimit)
	);
}

/**
 * Drop disabled windows from a snapshot read back from disk.
 *
 * A cache written by an older build can still hold a `windowMinutes: 0` entry.
 * Filtering on read lets those snapshots heal without the user deleting the
 * cache file, and keeps a stale-cache render consistent with a fresh one.
 */
export function sanitizeTuiQuotaSnapshot(
	snapshot: TuiQuotaSnapshot,
): TuiQuotaSnapshot {
	const limits = snapshot.limits.filter(
		(limit) => !isDisabledQuotaLimit(limit),
	);
	return limits.length === snapshot.limits.length
		? snapshot
		: { ...snapshot, limits };
}

export async function readTuiQuotaSnapshot(
	cachePath?: string,
): Promise<TuiQuotaSnapshot | undefined> {
	try {
		const raw = await fs.readFile(cachePath ?? getTuiQuotaCachePath(), "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		return isTuiQuotaSnapshot(parsed)
			? sanitizeTuiQuotaSnapshot(parsed)
			: undefined;
	} catch {
		return undefined;
	}
}

export async function writeTuiQuotaSnapshot(
	snapshot: TuiQuotaSnapshot,
	cachePath?: string,
): Promise<void> {
	const target = cachePath ?? getTuiQuotaCachePath();
	const writeKey = getSnapshotWriteKey(snapshot);
	const now = Date.now();
	const recentWrite = recentTuiQuotaWrites.get(target);
	if (
		recentWrite?.key === writeKey &&
		now - recentWrite.at < TUI_QUOTA_CACHE_WRITE_SKIP_MS
	) {
		await recentWrite.promise;
		return;
	}

	const temporary =
		`${target}.${process.pid}.${now}.${Math.random().toString(36).slice(2)}.tmp`;
	const writePromise = (async () => {
		await fs.mkdir(dirname(target), { recursive: true });
		await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		await renameWithWindowsRetry(temporary, target);
	})();
	recentTuiQuotaWrites.set(target, {
		key: writeKey,
		at: now,
		promise: writePromise,
	});
	try {
		await writePromise;
		recentTuiQuotaWrites.set(target, {
			key: writeKey,
			at: Date.now(),
		});
	} catch (error) {
		await fs.unlink(temporary).catch(() => undefined);
		if (recentTuiQuotaWrites.get(target)?.promise === writePromise) {
			recentTuiQuotaWrites.delete(target);
		}
		throw error;
	}
}

export async function clearTuiQuotaSnapshot(cachePath?: string): Promise<void> {
	const target = cachePath ?? getTuiQuotaCachePath();
	recentTuiQuotaWrites.delete(target);
	try {
		await fs.unlink(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
		throw error;
	}
}

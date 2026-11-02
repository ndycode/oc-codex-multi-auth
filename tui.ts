import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { Event } from "@opencode-ai/sdk/v2";
import type { JSX } from "@opentui/solid";

import {
	getCodexTuiGlyphMode,
	getCodexTuiMaskEmail,
	getCodexTuiMaskEmailInQuotaDetails,
	getQuotaDisplay,
	getQuotaStatus,
	loadPluginConfig,
	type QuotaStatusAudience,
	type QuotaStatusConfig,
	type QuotaStatusScreen,
} from "./lib/config.js";
import { PROVIDER_ID } from "./lib/constants.js";
import type { QuotaDisplayMode } from "./lib/quota-display.js";
import type {
	QuotaOverviewAccount,
	QuotaOverviewOptions,
} from "./lib/quota-overview.js";
import {
	fetchTuiQuotaOverview,
	mergeOverviewWithLatestAccount,
	toQuotaOverviewAccounts,
} from "./lib/tui-quota-overview.js";
import {
	createUsageAccountFingerprint,
	ensureCodexUsageAccessToken,
	fetchCodexUsage,
	formatUsageWindowLabel,
	getUsageLeftPercent,
	hasUsageWindow,
	parseCodexUsagePayload,
	resolveCodexUsageAccountId,
	resolveCodexUsageActiveAccount,
} from "./lib/codex-usage.js";
import {
	formatPromptStatusText,
	formatQuotaDetailsText,
	formatQuotaCreditsStatusLines,
	formatQuotaOverviewStatusLines,
	formatQuotaResetsStatusLines,
	resolveQuotaOverviewTone,
	resolveQuotaPromptTone,
	withStatusPrefix,
	type CompactQuotaLimit,
	type CompactQuotaStatus,
	type QuotaPromptTone,
} from "./lib/tui-status.js";
import {
	createTuiQuotaSnapshot,
	getTuiQuotaCachePath,
	getTuiQuotaOverviewCachePath,
	isFreshTuiQuotaSnapshot,
	isTuiQuotaSnapshot,
	readTuiQuotaSnapshot,
	readSessionQuotaSnapshot,
	writeTuiQuotaSnapshot,
	type TuiQuotaSnapshot,
} from "./lib/tui-quota-cache.js";
import { getStoragePath, loadAccounts } from "./lib/storage.js";
import { protectQuotaStatusSlot } from "./lib/tui-status-slot.js";
import { displayWidth, sanitizeDisplayText } from "./lib/ui/display-text.js";
import type { UiGlyphMode } from "./lib/ui/theme.js";
export { protectQuotaStatusSlot } from "./lib/tui-status-slot.js";

const CACHE_KEY = "oc-codex-multi-auth:tui-status:v2";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const EVENT_REFRESH_DEBOUNCE_MS = 750;
const ACCOUNT_POLL_INTERVAL_MS = 1_000;
// The status line is the one surface that reads this configuration once and
// then renders it for the rest of the session, so it is the only one where an
// edit would otherwise need a restart to be seen. `loadPluginConfig` already
// re-reads the file on every call and only skips re-parsing when the bytes are
// unchanged, so polling it costs one read of a file measured in hundreds of
// bytes.
const CONFIG_POLL_INTERVAL_MS = 2_000;
// Re-reading three numbers off the laid-out node, which is cheap enough to do
// often and has to be: the first pass happens before any layout exists, and
// until it is picked up the line is budgeting against the whole terminal.
const LAYOUT_MEASURE_INTERVAL_MS = 500;

type StoredQuotaStatus = TuiQuotaSnapshot;

type SolidRuntime = Pick<
	typeof import("@opentui/solid"),
	"createElement" | "spread"
> &
	Pick<typeof import("solid-js"), "createSignal" | "onCleanup">;

let inFlightRefresh: Promise<CompactQuotaStatus> | undefined;
const inFlightUsage = new Map<string, Promise<ReturnType<typeof parseCodexUsagePayload>>>();

type QuotaOverviewState =
	| { type: "loading" }
	| { type: "unavailable" }
	| { type: "ready"; accounts: readonly QuotaOverviewAccount[]; stale: boolean };

let inFlightOverview: Promise<QuotaOverviewState> | undefined;

async function refreshQuotaOverviewInner(
	api: TuiPluginApi,
): Promise<QuotaOverviewState> {
	try {
		const now = Date.now();
		const snapshot = await fetchTuiQuotaOverview({
			cachePath: getTuiQuotaOverviewCachePath(api.state.path.state),
			now,
		});
		if (!snapshot || snapshot.accounts.length === 0) {
			return { type: "unavailable" };
		}
		const merged = mergeOverviewWithLatestAccount(
			snapshot,
			await readSharedQuotaStatus(api),
		);
		return {
			type: "ready",
			accounts: toQuotaOverviewAccounts(merged),
			// Judged on the poll, not on the merged account: one account read a
			// moment ago does not make a five-minute-old reading of the other six
			// current.
			stale: !isFreshTuiQuotaSnapshot(merged, now),
		};
	} catch {
		return { type: "unavailable" };
	}
}

/**
 * Coalesce concurrent refreshes.
 *
 * Every session event that can move a quota schedules one of these, and
 * without this guard a burst of tool completions would start several passes
 * over the whole pool at once. The pass itself is already cheap while the
 * cache is fresh - it reads one file - so the events can stay wired to it.
 */
function refreshQuotaOverview(api: TuiPluginApi): Promise<QuotaOverviewState> {
	if (inFlightOverview) return inFlightOverview;
	inFlightOverview = refreshQuotaOverviewInner(api).finally(() => {
		inFlightOverview = undefined;
	});
	return inFlightOverview;
}

function isStoredQuotaStatus(value: unknown): value is StoredQuotaStatus {
	return isTuiQuotaSnapshot(value);
}

function readStoredQuotaStatus(
	api: TuiPluginApi,
	fingerprint: string,
): StoredQuotaStatus | undefined {
	if (!api.kv.ready) return undefined;
	try {
		const cached = api.kv.get<unknown>(CACHE_KEY);
		return isStoredQuotaStatus(cached) && cached.fingerprint === fingerprint
			? cached
			: undefined;
	} catch {
		return undefined;
	}
}

function writeStoredQuotaStatus(
	api: TuiPluginApi,
	status: StoredQuotaStatus,
): void {
	if (!api.kv.ready) return;
	try {
		api.kv.set(CACHE_KEY, status);
	} catch {
		// The prompt status is best-effort; cache write failures should not
		// affect the OpenCode TUI.
	}
}

function toCompactQuotaStatus(
	stored: StoredQuotaStatus,
	stale: boolean,
): CompactQuotaStatus {
	return {
		type: "ready",
		limits: stored.limits,
		stale,
		source: stored.source,
		fetchedAt: stored.fetchedAt,
		fingerprint: stored.fingerprint,
		accountIndex: stored.accountIndex,
		accountCount: stored.accountCount,
		accountEmail: stored.accountEmail,
		accountLabel: stored.accountLabel,
		planType: stored.planType,
		activeLimit: stored.activeLimit,
	};
}

function getQuotaSnapshotRevision(snapshot: {
	source?: string;
	fetchedAt?: number;
}): string | undefined {
	if (
		!snapshot.source ||
		typeof snapshot.fetchedAt !== "number" ||
		!Number.isFinite(snapshot.fetchedAt)
	) {
		return undefined;
	}
	return `${snapshot.source}:${snapshot.fetchedAt}`;
}

function toCompactQuotaLimit(
	window: { usedPercent?: number; windowMinutes?: number; resetAtMs?: number },
): CompactQuotaLimit | undefined {
	if (!hasUsageWindow(window)) return undefined;
	return {
		label: formatUsageWindowLabel(window.windowMinutes),
		leftPercent: getUsageLeftPercent(window.usedPercent) ?? null,
		usedPercent: window.usedPercent,
		windowMinutes: window.windowMinutes,
		resetAtMs: window.resetAtMs,
	};
}

function formatTuiAccountLabel(
	account: { email?: string; accountId?: string; organizationId?: string },
	index: number,
): string {
	// Every field is text the credential snapshot or an upstream response
	// supplied; it lands in the shared cache and then on the prompt line, so
	// escapes, controls, and bidi marks are stripped before anything reads it.
	return (
		sanitizeDisplayText(account.email) ??
		sanitizeDisplayText(account.accountId) ??
		sanitizeDisplayText(account.organizationId) ??
		`Account ${index + 1}`
	);
}

function getSharedQuotaCachePath(api: TuiPluginApi): string {
	return getTuiQuotaCachePath(api.state.path.state);
}

async function readSharedQuotaStatus(
	api: TuiPluginApi,
	fingerprint?: string,
): Promise<StoredQuotaStatus | undefined> {
	const cachePath = getSharedQuotaCachePath(api);
	const snapshot = await readTuiQuotaSnapshot(cachePath);
	if (snapshot && (fingerprint === undefined || snapshot.fingerprint === fingerprint)) return snapshot;
	const fallbackSnapshot = await readTuiQuotaSnapshot();
	return fallbackSnapshot && (fingerprint === undefined || fallbackSnapshot.fingerprint === fingerprint)
		? fallbackSnapshot
		: undefined;
}

async function readSessionQuotaStatus(api: TuiPluginApi, sessionID: string | undefined): Promise<StoredQuotaStatus | undefined> {
	return await readSessionQuotaSnapshot(sessionID, api.state.path.state) ??
		await readSessionQuotaSnapshot(sessionID);
}

async function writeSharedQuotaStatus(
	api: TuiPluginApi,
	status: StoredQuotaStatus,
): Promise<void> {
	try {
		await writeTuiQuotaSnapshot(status, getSharedQuotaCachePath(api));
	} catch {
		// The prompt status is best-effort; shared cache write failures should
		// not affect the OpenCode TUI.
	}
}

export async function resolveQuotaPollFingerprint(
	api: TuiPluginApi,
	sessionID?: string,
): Promise<string | undefined> {
	const storage = await loadAccounts();
	if (!storage || storage.accounts.length === 0) return undefined;
	const session = await readSessionQuotaStatus(api, sessionID);
	if (session && storage.accounts.some((account) => createUsageAccountFingerprint(account) === session.fingerprint)) {
		return session.fingerprint;
	}
	const shared = await readSharedQuotaStatus(api);
	if (
		shared?.source === "headers" &&
		isFreshTuiQuotaSnapshot(shared) &&
		storage.accounts.some(
			(account) => createUsageAccountFingerprint(account) === shared.fingerprint,
		)
	) {
		return shared.fingerprint;
	}
	const selection = resolveCodexUsageActiveAccount(storage);
	return selection
		? createUsageAccountFingerprint(selection.account)
		: undefined;
}

export async function refreshQuotaStatusInner(
	api: TuiPluginApi,
	sessionID?: string,
): Promise<CompactQuotaStatus> {
	try {
		const storage = await loadAccounts();
		if (!storage || storage.accounts.length === 0) {
			return { type: "missing" };
		}

		const session = await readSessionQuotaStatus(api, sessionID);
		const sessionIndex = session
			? storage.accounts.findIndex((account) => createUsageAccountFingerprint(account) === session.fingerprint)
			: -1;
		const sessionAccount = storage.accounts[sessionIndex];
		const latestShared = sessionAccount ? session : await readSharedQuotaStatus(api);
		const now = Date.now();
		// A shared snapshot only proves freshness while requests flow: the
		// request path pushes it per response, but during an idle gap nothing
		// rewrites it and the quota windows it describes may have reset
		// server-side. Trust it as current within one refresh interval;
		// otherwise fall through to a live /wham/usage read and keep the
		// snapshot only as a stale fallback.
		if (latestShared?.source === "headers" && latestShared.limits.length > 0 && isFreshTuiQuotaSnapshot(latestShared, now) &&
			storage.accounts.some((account) => createUsageAccountFingerprint(account) === latestShared.fingerprint)) {
			writeStoredQuotaStatus(api, latestShared);
			return toCompactQuotaStatus(latestShared, false);
		}
		const selection = sessionAccount ? { account: sessionAccount, index: sessionIndex } : resolveCodexUsageActiveAccount(storage);
		if (!selection) return { type: "missing" };
		const fingerprint = createUsageAccountFingerprint(selection.account);
		const globalShared = await readSharedQuotaStatus(api, fingerprint);
		const shared = sessionAccount && session && session.limits.length > 0 && (!globalShared || session.fetchedAt >= globalShared.fetchedAt)
			? session : globalShared;
		const stored = readStoredQuotaStatus(api, fingerprint);
		const cached =
			shared && (!stored || shared.fetchedAt >= stored.fetchedAt)
				? shared
				: stored;

		try {
			const readKey = JSON.stringify([getStoragePath(), getSharedQuotaCachePath(api), fingerprint]);
			let read = inFlightUsage.get(readKey);
			if (!read) {
				read = (async () => {
					const credentials = await ensureCodexUsageAccessToken({
						storage,
						account: selection.account,
					});
					const accountId = resolveCodexUsageAccountId({
						account: selection.account,
						accessToken: credentials.accessToken,
					});
					if (!accountId) throw new Error("Missing account id");
					const payload = await fetchCodexUsage({
						accountId,
						accessToken: credentials.accessToken,
						organizationId: selection.account.organizationId,
					});
					return parseCodexUsagePayload(payload);
				})().finally(() => { inFlightUsage.delete(readKey); });
				inFlightUsage.set(readKey, read);
			}
			const usage = await read;
			const limits = [
				toCompactQuotaLimit(usage.primary),
				toCompactQuotaLimit(usage.secondary),
			].filter((limit): limit is CompactQuotaLimit => Boolean(limit));
			const stored = createTuiQuotaSnapshot({
				fingerprint,
				source: "usage",
				accountIndex: selection.index + 1,
				accountCount: storage.accounts.length,
				accountEmail: selection.account.email?.trim() || undefined,
				accountLabel: formatTuiAccountLabel(
					selection.account,
					selection.index,
				),
				planType: usage.planType ?? undefined,
				limits,
				fetchedAt: now,
			});
			writeStoredQuotaStatus(api, stored);
			await writeSharedQuotaStatus(api, stored);
			return toCompactQuotaStatus(stored, false);
		} catch {
			return cached ? toCompactQuotaStatus(cached, true) : { type: "unavailable" };
		}
	} catch {
		return { type: "unavailable" };
	}
}

function refreshQuotaStatus(api: TuiPluginApi): Promise<CompactQuotaStatus> {
	if (inFlightRefresh) return inFlightRefresh;
	inFlightRefresh = refreshQuotaStatusInner(api).finally(() => {
		inFlightRefresh = undefined;
	});
	return inFlightRefresh;
}

export function shouldRefreshQuotaForEvent(event: Event): boolean {
	switch (event.type) {
		case "message.updated":
			return (
				event.properties.info.role === "assistant" &&
				typeof event.properties.info.time.completed === "number"
			);
		case "message.part.updated": {
			const { part } = event.properties;
			if (part.type === "step-finish") return true;
			if (part.type !== "tool") return false;
			return (
				part.state.status === "completed" || part.state.status === "error"
			);
		}
		case "session.idle":
		case "session.error":
			return true;
		case "session.status":
			return event.properties.status.type === "idle";
		default:
			return false;
	}
}

type PromptStatusOptions = {
	maskEmail: boolean;
	maskEmailInQuotaDetails: boolean;
	quotaDisplay: QuotaDisplayMode;
	quotaStatus: QuotaStatusConfig;
	glyphMode: UiGlyphMode;
};

export function readPromptStatusOptions(): PromptStatusOptions {
	const pluginConfig = loadPluginConfig();
	return {
		maskEmail: getCodexTuiMaskEmail(pluginConfig),
		maskEmailInQuotaDetails: getCodexTuiMaskEmailInQuotaDetails(pluginConfig),
		quotaDisplay: getQuotaDisplay(pluginConfig),
		quotaStatus: getQuotaStatus(pluginConfig),
		glyphMode: getCodexTuiGlyphMode(pluginConfig),
	};
}

/**
 * Whether two readings of the configuration would render the same line.
 *
 * Compared field by field rather than by identity: every poll builds a fresh
 * object, so identity always differs and pushing it into a signal would
 * re-render the status line every two seconds forever.
 */
export function samePromptStatusOptions(
	left: PromptStatusOptions,
	right: PromptStatusOptions,
): boolean {
	const leftStatus = left.quotaStatus;
	const rightStatus = right.quotaStatus;
	return (
		left.maskEmail === right.maskEmail &&
		left.maskEmailInQuotaDetails === right.maskEmailInQuotaDetails &&
		left.quotaDisplay === right.quotaDisplay &&
		left.glyphMode === right.glyphMode &&
		leftStatus.screens.length === rightStatus.screens.length &&
		leftStatus.screens.every(
			(screen, position) => screen === rightStatus.screens[position],
		) &&
		leftStatus.rotateMs === rightStatus.rotateMs &&
		leftStatus.layout === rightStatus.layout &&
		leftStatus.accountNames === rightStatus.accountNames &&
		leftStatus.order === rightStatus.order &&
		leftStatus.multipliers === rightStatus.multipliers &&
		leftStatus.allotment === rightStatus.allotment &&
		leftStatus.resetTimes === rightStatus.resetTimes &&
		leftStatus.resetCredits === rightStatus.resetCredits &&
		leftStatus.recovery === rightStatus.recovery &&
		leftStatus.resetsMinUsedPercent === rightStatus.resetsMinUsedPercent &&
		leftStatus.rows === rightStatus.rows &&
		leftStatus.prefix === rightStatus.prefix &&
		leftStatus.showFor === rightStatus.showFor
	);
}

/**
 * What the renderer actually gave this slot, once it has laid the prompt out.
 *
 * The terminal's own width is the wrong budget for a line sharing its row with
 * a sidebar, and wrong by an amount nothing in this plugin can derive - so the
 * row is measured instead of computed.
 */
type StatusSlotMetrics = {
	/** Columns this line may spend, or nothing when the prompt is unreadable. */
	availableChars?: number;
};

type LayoutNode = {
	width?: unknown;
	primaryAxis?: unknown;
	parent?: unknown;
	getChildren?: unknown;
};

/**
 * Columns on the prompt's bottom row that belong to the model label beside
 * this line, plus the gap between them.
 *
 * A constant rather than the label's measured width, and that is the whole
 * point. The row lays both boxes out by their content, so a label with no room
 * left is SHRUNK to whatever this line did not take - measuring it would make
 * the budget a function of the line's own length, and every render would
 * ratchet it further down. The row's width is the one number on that row that
 * this line cannot influence.
 *
 * 40 is measured against the real TUI: "Build - Big Pickle OpenCode Zen" is 31
 * characters, and at 80 columns a 48-character line was ellipsized through its
 * middle AND pushed the label onto a second row.
 */
const PROMPT_LABEL_RESERVED_CHARS = 40;
const MAX_LAYOUT_WALK_DEPTH = 8;

function asLayoutNode(value: unknown): LayoutNode | undefined {
	return typeof value === "object" && value !== null ? value : undefined;
}

function layoutSize(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

function layoutChildren(node: LayoutNode): LayoutNode[] {
	if (typeof node.getChildren !== "function") return [];
	try {
		const children: unknown = node.getChildren();
		if (!Array.isArray(children)) return [];
		return children
			.map((child) => asLayoutNode(child))
			.filter((child): child is LayoutNode => Boolean(child));
	} catch {
		return [];
	}
}

/**
 * Measure the row this line sits on, by walking up to it.
 *
 * The walk looks for the nearest ancestor laid out as a row with something else
 * in it - the prompt's bottom row, where the model label is the something else.
 * That row stretches to the prompt's inner width, which is the number the
 * terminal width fails to be whenever a sidebar is open, and the only number on
 * that row this line does not influence.
 *
 * Every hop is guarded and the whole thing returns nothing rather than a guess:
 * before the first layout pass there are no widths to read, and a host that
 * rearranges its prompt must degrade to the width heuristic rather than compute
 * a budget from numbers that no longer mean what they did.
 */
export function measureStatusSlot(node: unknown): StatusSlotMetrics {
	const chain: LayoutNode[] = [];
	let current = asLayoutNode(node);
	for (let depth = 0; current && depth < MAX_LAYOUT_WALK_DEPTH; depth += 1) {
		chain.push(current);
		current = asLayoutNode(current.parent);
	}
	for (const [position, ancestor] of chain.entries()) {
		if (position === 0) continue;
		if (ancestor.primaryAxis !== "row") continue;
		const rowWidth = layoutSize(ancestor.width);
		if (!rowWidth) continue;
		const children = layoutChildren(ancestor);
		if (children.length < 2) continue;
		const mine = chain[position - 1];
		if (!mine || !children.includes(mine)) continue;
		const availableChars = rowWidth - PROMPT_LABEL_RESERVED_CHARS;
		if (availableChars < 1) continue;
		return { availableChars };
	}
	return {};
}

/**
 * One status line's data pipeline, separated from the node that shows it.
 *
 * The screens read different things - one polls the pool, one tracks whichever
 * account is serving - and which screens are wanted can change while a session
 * is open. Keeping the data behind this interface lets the node stay put and
 * read from whichever pipelines are current, rather than the slot having to
 * replace a node the renderer already mounted.
 */
type QuotaStatusController = {
	screens: readonly QuotaStatusScreen[];
	lines(
		screen: QuotaStatusScreen,
		options: PromptStatusOptions,
		layout: { availableChars?: number; maxRows: number },
	): string[];
	tone(screen: QuotaStatusScreen): QuotaPromptTone;
	dispose(): void;
};

function toQuotaOverviewOptions(
	options: PromptStatusOptions,
	now: number,
): QuotaOverviewOptions {
	// Spelled out rather than spread: `QuotaStatusConfig` calls the free/used
	// wording `quotaDisplay` and its own screen list `screens`, while
	// `QuotaOverviewOptions.mode` IS the wording - spreading one over the other
	// silently renders every percentage as headroom.
	return {
		mode: options.quotaDisplay,
		layout: options.quotaStatus.layout,
		names: options.quotaStatus.accountNames,
		order: options.quotaStatus.order,
		multipliers: options.quotaStatus.multipliers,
		allotment: options.quotaStatus.allotment,
		resetTimes: options.quotaStatus.resetTimes,
		resetCredits: options.quotaStatus.resetCredits,
		recovery: options.quotaStatus.recovery,
		maskEmail: options.maskEmail,
		now,
	};
}

/**
 * The pool-wide status line's data pipeline.
 *
 * Kept apart from the active-account one rather than branching inside it:
 * that one maintains a serving-account fingerprint, a snapshot revision and a
 * one-second identity poll, all of which exist to answer "which account is
 * this" - the question this mode is built to stop asking.
 */
function createOverviewQuotaController(
	api: TuiPluginApi,
	solid: SolidRuntime,
): QuotaStatusController {
	const [state, setState] = solid.createSignal<QuotaOverviewState>({
		type: "loading",
	});
	const refresh = (): void => {
		void refreshQuotaOverview(api).then(setState, () => {
			setState({ type: "unavailable" });
		});
	};
	let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	const scheduleRefresh = (): void => {
		if (refreshTimeout) clearTimeout(refreshTimeout);
		refreshTimeout = setTimeout(() => {
			refreshTimeout = undefined;
			refresh();
		}, EVENT_REFRESH_DEBOUNCE_MS);
	};

	refresh();
	const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
	const disposers = [
		api.event.on("message.updated", (event) => {
			if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
		}),
		api.event.on("message.part.updated", (event) => {
			if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
		}),
		api.event.on("session.idle", (event) => {
			if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
		}),
		api.event.on("session.status", (event) => {
			if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
		}),
		api.event.on("session.error", (event) => {
			if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
		}),
	];
	return {
		screens: ["overview", "resets", "credits"],
		lines(screen, options, layout) {
			const current = state();
			if (current.type !== "ready") {
				// Blank while the first pass runs; a placeholder swapped out a
				// moment later is exactly the flicker this mode removes. The
				// reset screen stays blank either way - it has nothing to add
				// to a pool nobody has read yet.
				if (screen === "resets" || screen === "credits") return [];
				return current.type === "loading" ? [] : ["limits ?"];
			}
			const render =
				screen === "resets"
					? formatQuotaResetsStatusLines
					: screen === "credits"
						? formatQuotaCreditsStatusLines
						: formatQuotaOverviewStatusLines;
			return render({
				accounts: current.accounts,
				options: toQuotaOverviewOptions(options, Date.now()),
				resetsMinUsedPercent: options.quotaStatus.resetsMinUsedPercent,
				width: api.renderer.width,
				availableChars: layout.availableChars,
				maxRows: layout.maxRows,
			});
		},
		tone(screen) {
			const current = state();
			if (current.type === "ready") {
				// The reset screen only appears once nothing has headroom left,
				// so the pool tone it would otherwise carry is always danger and
				// says nothing. Warning is the honest colour for "here is the
				// thing you can still do about it".
				if (screen === "resets" || screen === "credits") {
					return current.stale ? "stale" : "warning";
				}
				return resolveQuotaOverviewTone(current.accounts, current.stale);
			}
			return current.type === "loading" ? "unknown" : "warning";
		},
		dispose() {
			clearInterval(interval);
			if (refreshTimeout) clearTimeout(refreshTimeout);
			for (const dispose of disposers) dispose();
		},
	};
}

/** The serving-account pipeline: the status line's original behaviour. */
function createActiveQuotaController(
	api: TuiPluginApi,
	solid: SolidRuntime,
	sessionID: string | undefined,
): QuotaStatusController {
	const [quota, setQuota] = solid.createSignal<CompactQuotaStatus>({
		type: "loading",
	});
	let currentFingerprint: string | undefined;
	let currentSnapshotRevision: string | undefined;
	const applyQuota = (next: CompactQuotaStatus): void => {
		if (next.type === "ready") {
			currentFingerprint = next.fingerprint;
			currentSnapshotRevision = getQuotaSnapshotRevision(next);
		}
		if (next.type === "missing") {
			currentFingerprint = undefined;
			currentSnapshotRevision = undefined;
		}
		setQuota(next);
	};
	let inFlight: Promise<void> | undefined;
	const refresh = (): void => {
		if (inFlight) return;
		inFlight = refreshQuotaStatusInner(api, sessionID).then(applyQuota, () => {
			applyQuota({ type: "unavailable" });
		}).finally(() => { inFlight = undefined; });
	};
	let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
	const scheduleRefresh = (): void => {
		if (refreshTimeout) clearTimeout(refreshTimeout);
		refreshTimeout = setTimeout(() => {
			refreshTimeout = undefined;
			refresh();
		}, EVENT_REFRESH_DEBOUNCE_MS);
	};

	refresh();
	const interval = setInterval(refresh, REFRESH_INTERVAL_MS);
	let cachePollInFlight = false;
	const pollSharedQuotaCache = (): void => {
		if (cachePollInFlight) return;
		cachePollInFlight = true;
		void (async () => {
			const fingerprint = await resolveQuotaPollFingerprint(api, sessionID);
			if (!fingerprint) {
				if (currentFingerprint) applyQuota({ type: "missing" });
				return;
			}
			if (fingerprint !== currentFingerprint) {
				currentFingerprint = fingerprint;
				currentSnapshotRevision = undefined;
				setQuota({ type: "loading" });
				refresh();
				return;
			}
			const session = await readSessionQuotaStatus(api, sessionID);
			const globalShared = await readSharedQuotaStatus(api, fingerprint);
			const shared = session?.fingerprint === fingerprint && session.limits.length > 0 && (!globalShared || session.fetchedAt >= globalShared.fetchedAt)
				? session : globalShared;
			if (!shared || shared.limits.length === 0) return;
			const current = quota();
			if (current.type === "ready" && current.fetchedAt !== undefined && shared.fetchedAt < current.fetchedAt) return;
			const revision = getQuotaSnapshotRevision(shared);
			if (!revision || revision === currentSnapshotRevision) return;
			writeStoredQuotaStatus(api, shared);
			// A changed revision is usually a fresh push from the request path,
			// but on TUI startup this poll can see an old snapshot before the
			// initial live fetch lands — render that honestly as stale.
			applyQuota(toCompactQuotaStatus(shared, !isFreshTuiQuotaSnapshot(shared)));
		})().finally(() => {
			cachePollInFlight = false;
		});
	};
	const accountInterval = setInterval(
		pollSharedQuotaCache,
		ACCOUNT_POLL_INTERVAL_MS,
	);
	const disposeMessageUpdated = api.event.on("message.updated", (event) => {
		if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
	});
	const disposeMessagePartUpdated = api.event.on(
		"message.part.updated",
		(event) => {
			if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
		},
	);
	const disposeSessionIdle = api.event.on("session.idle", (event) => {
		if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
	});
	const disposeSessionStatus = api.event.on("session.status", (event) => {
		if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
	});
	const disposeSessionError = api.event.on("session.error", (event) => {
		if (shouldRefreshQuotaForEvent(event)) scheduleRefresh();
	});
	return {
		screens: ["active"],
		lines(_screen, options, layout) {
			const text = formatPromptStatusText({
				quota: quota(),
				width: api.renderer.width,
				// A measured slot beats the terminal-width heuristic: when the
				// prompt row is narrower than the terminal (sidebar open, wide
				// model label) the tier table would over-budget the line.
				availableChars: layout.availableChars,
				maskEmail: options.maskEmail,
				quotaDisplay: options.quotaDisplay,
				glyphMode: options.glyphMode,
			});
			return text ? [text] : [];
		},
		tone() {
			return resolveQuotaPromptTone(quota());
		},
		dispose() {
			clearInterval(interval);
			clearInterval(accountInterval);
			if (refreshTimeout) clearTimeout(refreshTimeout);
			disposeMessageUpdated();
			disposeMessagePartUpdated();
			disposeSessionIdle();
			disposeSessionStatus();
			disposeSessionError();
		},
	};
}

/**
 * The status-line node, which outlives any change to how it is configured.
 *
 * Both the shape of the line and the pipeline behind it come from a file the
 * user edits while sessions are open, so this polls that file and swaps the
 * pipeline underneath a node the renderer keeps mounted. The alternative -
 * re-registering the slot - would ask the renderer to replace a live node, and
 * a mode change is exactly when it must not blink.
 */
/**
 * The pipelines a set of screens needs, and which screen each one answers.
 *
 * `resets` and `credits` are served by the pool pipeline rather than one of
 * their own: they need every account's windows, banked resets and credit
 * balance, which is exactly what that pipeline already gathers, and a second
 * poller reading the same endpoint for the same numbers would double the
 * request cost to say the same thing.
 */
function createQuotaControllers(
	api: TuiPluginApi,
	solid: SolidRuntime,
	screens: readonly QuotaStatusScreen[],
	sessionID: string | undefined,
): QuotaStatusController[] {
	const controllers: QuotaStatusController[] = [];
	if (screens.includes("active")) {
		controllers.push(createActiveQuotaController(api, solid, sessionID));
	}
	if (screens.includes("overview") || screens.includes("resets") || screens.includes("credits")) {
		controllers.push(createOverviewQuotaController(api, solid));
	}
	return controllers;
}

/**
 * Whether the account pool is worth naming for the model in front of the user.
 *
 * Unknown counts as yes. A line the user asked for should not disappear
 * because a fresh session has no message to read a provider off yet, and being
 * told about a pool one model does not draw from is a smaller wrong than being
 * told nothing while it runs out.
 */
export function showsQuotaForSession(params: {
	audience: QuotaStatusAudience;
	providerID: string | undefined;
}): boolean {
	if (params.audience === "always") return true;
	return !params.providerID || params.providerID === PROVIDER_ID;
}

export { withStatusPrefix };

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

/**
 * The provider actually serving this session, newest statement first.
 *
 * A message records what ran, which is the only reliable answer once a session
 * has moved off the configured default; the configured model is the fallback
 * for a session that has not run anything yet.
 */
function resolveSessionProviderId(
	api: TuiPluginApi,
	sessionID: string | undefined,
): string | undefined {
	if (sessionID) {
		try {
			const messages = api.state.session.messages(sessionID);
			for (let position = messages.length - 1; position >= 0; position -= 1) {
				const message = messages[position];
				if (message?.role !== "assistant") continue;
				const providerID = getString(message.providerID);
				if (providerID) return providerID;
			}
		} catch {
			// The session may not be in the store yet; fall through to config.
		}
	}
	const configured = getString(api.state.config.model);
	if (!configured) return undefined;
	const slashIndex = configured.indexOf("/");
	return slashIndex > 0 ? configured.slice(0, slashIndex) : undefined;
}

/**
 * The status-line node, which outlives any change to how it is configured.
 *
 * Both the shape of the line and the pipelines behind it come from a file the
 * user edits while sessions are open, so this polls that file and swaps the
 * pipelines underneath a node the renderer keeps mounted. The alternative -
 * re-registering the slot - would ask the renderer to replace a live node, and
 * a screen change is exactly when it must not blink.
 */
function createPromptStatus(
	api: TuiPluginApi,
	solid: SolidRuntime,
	initialOptions: PromptStatusOptions,
	sessionID: string | undefined,
): JSX.Element {
	const [options, setOptions] = solid.createSignal(initialOptions);
	const [metrics, setMetrics] = solid.createSignal<StatusSlotMetrics>({});
	const [rotation, setRotation] = solid.createSignal(0);
	let controllers = createQuotaControllers(
		api,
		solid,
		initialOptions.quotaStatus.screens,
		sessionID,
	);
	let controllerScreens = initialOptions.quotaStatus.screens;
	let rotationInterval: ReturnType<typeof setInterval> | undefined;

	const node = solid.createElement("text");
	let restoreSlotShrink: (() => void) | undefined;

	const restartRotation = (screens: readonly QuotaStatusScreen[]): void => {
		if (rotationInterval) clearInterval(rotationInterval);
		rotationInterval = undefined;
		if (screens.length < 2) return;
		rotationInterval = setInterval(() => {
			setRotation((tick) => tick + 1);
		}, options().quotaStatus.rotateMs);
	};
	restartRotation(controllerScreens);

	const remeasure = (): void => {
		const status = options().quotaStatus;
		if (status.layout === "total" || status.recovery === "all") {
			restoreSlotShrink ??= protectQuotaStatusSlot(node);
		} else if (restoreSlotShrink) {
			restoreSlotShrink();
			restoreSlotShrink = undefined;
		}
		const next = measureStatusSlot(node);
		if (next.availableChars === metrics().availableChars) return;
		setMetrics(next);
	};
	const measureInterval = setInterval(remeasure, LAYOUT_MEASURE_INTERVAL_MS);

	const configInterval = setInterval(() => {
		const next = readPromptStatusOptions();
		if (samePromptStatusOptions(options(), next)) return;
		const nextScreens = next.quotaStatus.screens;
		const screensChanged =
			nextScreens.length !== controllerScreens.length ||
			nextScreens.some((screen, position) => screen !== controllerScreens[position]);
		// The swap happens BEFORE the signal that re-renders against it. The
		// other order leaves the line blank until something else happens to
		// change: the render triggered by `setOptions` would read the outgoing
		// pipelines, find none of them serving the incoming screens, subscribe
		// to nothing, and never hear the new pipeline resolve.
		if (screensChanged) {
			for (const controller of controllers) controller.dispose();
			controllers = createQuotaControllers(api, solid, nextScreens, sessionID);
			controllerScreens = nextScreens;
			setRotation(0);
		}
		setOptions(next);
		restartRotation(nextScreens);
	}, CONFIG_POLL_INTERVAL_MS);

	solid.onCleanup(() => {
		clearInterval(configInterval);
		clearInterval(measureInterval);
		restoreSlotShrink?.();
		if (rotationInterval) clearInterval(rotationInterval);
		for (const controller of controllers) controller.dispose();
	});

	/**
	 * The screen on show right now, picked from the ones that have something to
	 * say. A screen with nothing to render is skipped rather than shown blank,
	 * which is what lets `resets` sit in the rotation permanently and only
	 * appear on the day it matters.
	 */
	const current = (): { screen: QuotaStatusScreen; lines: string[] } | undefined => {
		const currentOptions = options();
		if (
			!showsQuotaForSession({
				audience: currentOptions.quotaStatus.showFor,
				providerID: resolveSessionProviderId(api, sessionID),
			})
		) {
			return undefined;
		}
		const prefix = currentOptions.quotaStatus.prefix
		const measured = metrics().availableChars
		const layout = {
			availableChars: measured === undefined ? undefined : Math.max(1, measured - displayWidth(prefix)),
			maxRows: currentOptions.quotaStatus.rows,
		};
		const rendered: Array<{ screen: QuotaStatusScreen; lines: string[] }> = [];
		for (const screen of currentOptions.quotaStatus.screens) {
			const controller = controllers.find((candidate) =>
				candidate.screens.includes(screen),
			);
			if (!controller) continue;
			const lines = controller.lines(screen, currentOptions, layout);
			if (lines.length > 0) rendered.push({ screen, lines: withStatusPrefix(lines, prefix) });
		}
		if (rendered.length === 0) return undefined;
		return rendered[Math.abs(rotation()) % rendered.length];
	};

	solid.spread(
		node,
		{
			get content() {
				// A newline is how one text node becomes two rows: the renderer
				// measures the content it was given, so the node grows to match
				// instead of the slot having to add and remove child nodes.
				return current()?.lines.join("\n") ?? "";
			},
			get fg() {
				const screen = current()?.screen;
				const controller = screen
					? controllers.find((candidate) => candidate.screens.includes(screen))
					: undefined;
				const tone = screen && controller ? controller.tone(screen) : "unknown";
				if (tone === "danger") return api.theme.current.error;
				if (tone === "warning" || tone === "stale") {
					return api.theme.current.warning;
				}
				if (tone === "normal") return api.theme.current.success;
				return api.theme.current.textMuted;
			},
			// The host centres this slot against a model label that wraps to two
			// rows on a narrow terminal, which put a one-row line on the bottom
			// row and left the top one empty. Reading starts at the top.
			alignSelf: "flex-start",
			selectable: false,
			truncate: true,
			wrapMode: "none",
		},
		false,
	);
	return node;
}

function showQuotaDetails(api: TuiPluginApi): void {
	// Read at open time, not at startup: the dialog is one keystroke away from
	// the line it explains, and the two disagreeing about `used` vs `free`
	// after an edit would be worse than either being stale alone.
	const options = readPromptStatusOptions();
	void refreshQuotaStatus(api).then(
		(status) => {
			api.ui.dialog.replace(() =>
				api.ui.DialogAlert({
					title: "Codex quota",
					message: formatQuotaDetailsText(status, Date.now(), {
						maskEmail: options.maskEmail && options.maskEmailInQuotaDetails,
						quotaDisplay: options.quotaDisplay,
					}),
					onConfirm: () => api.ui.dialog.clear(),
				}),
			);
		},
		() => {
			api.ui.dialog.replace(() =>
				api.ui.DialogAlert({
					title: "Codex quota",
					message: formatQuotaDetailsText({ type: "unavailable" }),
					onConfirm: () => api.ui.dialog.clear(),
				}),
			);
		},
	);
}

const module: TuiPluginModule = {
	id: "oc-codex-multi-auth.status",
	async tui(api) {
		const promptOptions = readPromptStatusOptions();
		const [{ createElement, spread }, { createSignal, onCleanup }] =
			await Promise.all([import("@opentui/solid"), import("solid-js")]);
		const solid: SolidRuntime = {
			createElement,
			spread,
			createSignal,
			onCleanup,
		};

		// `slots.register` returns the slot plugin's registry id and `TuiSlots`
		// exposes no `unregister` counterpart for it; the registry's teardown
		// channel is the plugin's own `dispose` hook (invoked on unregister and
		// registry clear). The flag stops a registration that outlives this
		// plugin from rendering into — and polling — a disposed api.
		let statusSlotDisposed = false;
		api.slots.register({
			slots: {
				session_prompt_right: (_ctx, props) =>
					statusSlotDisposed
						? null
						: createPromptStatus(api, solid, promptOptions, props.session_id),
			},
			dispose: () => {
				statusSlotDisposed = true;
			},
		});
		api.lifecycle.onDispose(() => {
			statusSlotDisposed = true;
		});
		const disposeCommand = api.command.register(() => [
			{
				title: "Codex quota details",
				value: "codex.quota.details",
				description:
					"Show active account usage, reset times, source, and last refresh.",
				category: "Codex",
				onSelect: () => showQuotaDetails(api),
			},
		]);
		api.lifecycle.onDispose(disposeCommand);
	},
};

export default {
	...module,
	/** V2 loads terminal status through CLI slots rather than V1 prompt hooks. */
	async setup(context: import("@opencode/plugin/tui").Plugin.Context) {
		const { setupV2Tui } = await import("./lib/opencode-v2-tui.js");
		return setupV2Tui(context);
	},
};

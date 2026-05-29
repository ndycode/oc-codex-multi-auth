import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { Event } from "@opencode-ai/sdk/v2";
import type { JSX } from "@opentui/solid";

import {
	getCodexTuiMaskEmail,
	getCodexTuiMaskEmailInQuotaDetails,
	loadPluginConfig,
} from "./lib/config.js";
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
	resolveQuotaPromptTone,
	type CompactQuotaLimit,
	type CompactQuotaStatus,
} from "./lib/tui-status.js";
import {
	createTuiQuotaSnapshot,
	getTuiQuotaCachePath,
	isTuiQuotaSnapshot,
	readTuiQuotaSnapshot,
	writeTuiQuotaSnapshot,
	type TuiQuotaSnapshot,
} from "./lib/tui-quota-cache.js";
import { loadAccounts } from "./lib/storage.js";

const CACHE_KEY = "oc-codex-multi-auth:tui-status:v2";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const EVENT_REFRESH_DEBOUNCE_MS = 750;
const ACCOUNT_POLL_INTERVAL_MS = 1_000;

type StoredQuotaStatus = TuiQuotaSnapshot;

type SolidRuntime = Pick<
	typeof import("@opentui/solid"),
	"createElement" | "spread"
> &
	Pick<typeof import("solid-js"), "createSignal" | "onCleanup">;

let inFlightRefresh: Promise<CompactQuotaStatus> | undefined;

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
	return (
		account.email?.trim() ||
		account.accountId?.trim() ||
		account.organizationId?.trim() ||
		`Account ${index + 1}`
	);
}

function getSharedQuotaCachePath(api: TuiPluginApi): string {
	return getTuiQuotaCachePath(api.state.path.state);
}

async function readSharedQuotaStatus(
	api: TuiPluginApi,
	fingerprint: string,
): Promise<StoredQuotaStatus | undefined> {
	const cachePath = getSharedQuotaCachePath(api);
	const snapshot = await readTuiQuotaSnapshot(cachePath);
	if (snapshot?.fingerprint === fingerprint) return snapshot;
	const fallbackSnapshot = await readTuiQuotaSnapshot();
	return fallbackSnapshot?.fingerprint === fingerprint
		? fallbackSnapshot
		: undefined;
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

async function resolveActiveQuotaFingerprint(): Promise<string | undefined> {
	const storage = await loadAccounts();
	const selection = storage ? resolveCodexUsageActiveAccount(storage) : null;
	return selection
		? createUsageAccountFingerprint(selection.account)
		: undefined;
}

async function refreshQuotaStatusInner(
	api: TuiPluginApi,
): Promise<CompactQuotaStatus> {
	try {
		const storage = await loadAccounts();
		if (!storage || storage.accounts.length === 0) {
			return { type: "missing" };
		}

		const selection = resolveCodexUsageActiveAccount(storage);
		if (!selection) return { type: "missing" };
		const fingerprint = createUsageAccountFingerprint(selection.account);
		const shared = await readSharedQuotaStatus(api, fingerprint);
		if (shared) {
			writeStoredQuotaStatus(api, shared);
			return toCompactQuotaStatus(shared, false);
		}
		const cached = readStoredQuotaStatus(api, fingerprint);
		const now = Date.now();

		try {
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
			const usage = parseCodexUsagePayload(payload);
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

function createPromptStatus(
	api: TuiPluginApi,
	solid: SolidRuntime,
	options: { maskEmail: boolean; maskEmailInQuotaDetails: boolean },
): JSX.Element {
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
	const refresh = (): void => {
		void refreshQuotaStatus(api).then(applyQuota, () => {
			applyQuota({ type: "unavailable" });
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
	let cachePollInFlight = false;
	const pollSharedQuotaCache = (): void => {
		if (cachePollInFlight) return;
		cachePollInFlight = true;
		void (async () => {
			const fingerprint = await resolveActiveQuotaFingerprint();
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
			const shared = await readSharedQuotaStatus(api, fingerprint);
			if (!shared) return;
			const revision = getQuotaSnapshotRevision(shared);
			if (!revision || revision === currentSnapshotRevision) return;
			writeStoredQuotaStatus(api, shared);
			applyQuota(toCompactQuotaStatus(shared, false));
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
	solid.onCleanup(() => {
		clearInterval(interval);
		clearInterval(accountInterval);
		if (refreshTimeout) clearTimeout(refreshTimeout);
		disposeMessageUpdated();
		disposeMessagePartUpdated();
		disposeSessionIdle();
		disposeSessionStatus();
		disposeSessionError();
	});

	const node = solid.createElement("text");
	solid.spread(
		node,
		{
			get content() {
				return formatPromptStatusText({
					quota: quota(),
					width: api.renderer.width,
					maskEmail: options.maskEmail,
				});
			},
			get fg() {
				const current = quota();
				const tone = resolveQuotaPromptTone(current);
				if (tone === "danger") return api.theme.current.error;
				if (tone === "warning" || tone === "stale") {
					return api.theme.current.warning;
				}
				if (tone === "normal") return api.theme.current.success;
				return api.theme.current.textMuted;
			},
			selectable: false,
			truncate: true,
			wrapMode: "none",
		},
		false,
	);
	return node;
}

function showQuotaDetails(
	api: TuiPluginApi,
	options: { maskEmail: boolean; maskEmailInQuotaDetails: boolean },
): void {
	void refreshQuotaStatus(api).then(
		(status) => {
			api.ui.dialog.replace(() =>
				api.ui.DialogAlert({
					title: "Codex quota",
					message: formatQuotaDetailsText(status, Date.now(), {
						maskEmail: options.maskEmail && options.maskEmailInQuotaDetails,
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
		const pluginConfig = loadPluginConfig();
		const promptOptions = {
			maskEmail: getCodexTuiMaskEmail(pluginConfig),
			maskEmailInQuotaDetails: getCodexTuiMaskEmailInQuotaDetails(pluginConfig),
		};
		const [{ createElement, spread }, { createSignal, onCleanup }] =
			await Promise.all([import("@opentui/solid"), import("solid-js")]);
		const solid: SolidRuntime = {
			createElement,
			spread,
			createSignal,
			onCleanup,
		};

		api.slots.register({
			slots: {
				session_prompt_right: () => createPromptStatus(api, solid, promptOptions),
			},
		});
		const disposeCommand = api.command.register(() => [
			{
				title: "Codex quota details",
				value: "codex.quota.details",
				description:
					"Show active account usage, reset times, source, and last refresh.",
				category: "Codex",
				onSelect: () => showQuotaDetails(api, promptOptions),
			},
		]);
		api.lifecycle.onDispose(disposeCommand);
	},
};

export default module;

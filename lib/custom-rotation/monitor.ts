import { getRotationStrategy, loadPluginConfig } from "../config.js";
import { deduplicateUsageAccountIndices, ensureCodexUsageAccessToken, fetchCodexUsage, resolveCodexUsageAccountId } from "../codex-usage.js";
import { fetchCodexResetCredits, parseCodexResetCredits } from "../codex-reset.js";
import { loadAccounts, type AccountStorageV3 } from "../storage.js";
import { getStoragePath } from "../storage/state.js";
import { registerCleanup, unregisterCleanup } from "../shutdown.js";
import { logWarn } from "../logger.js";
import { RotationObservations, rotationAccountId } from "./observations.js";

type PollState = { next: number; failures: number };
type Dependencies = {
	readonly enabled: () => boolean;
	readonly load: () => Promise<AccountStorageV3 | null>;
	readonly scope: () => string;
	readonly now: () => number;
	readonly onCredentialsPersisted: () => void;
	readonly usage: typeof fetchCodexUsage;
	readonly resets: typeof fetchCodexResetCredits;
	readonly credentials: typeof ensureCodexUsageAccessToken;
};

export type RotationMonitor = {
	readonly observations: RotationObservations;
	readonly signal: AbortSignal;
	runNow(): Promise<void>;
	dispose(): void;
	start(): void;
	refresh(): void;
};

export function createRotationMonitor(overrides: Partial<Dependencies> = {}): RotationMonitor {
	const deps: Dependencies = {
		enabled: () => getRotationStrategy(loadPluginConfig()) === "custom",
		load: loadAccounts, scope: getStoragePath, now: Date.now,
		onCredentialsPersisted: () => undefined,
		usage: fetchCodexUsage, resets: fetchCodexResetCredits, credentials: ensureCodexUsageAccessToken,
		...overrides,
	};
	const observations = new RotationObservations();
	const usagePolls = new Map<string, PollState>();
	const resetPolls = new Map<string, PollState>();
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	let started = false;
	let running: Promise<void> | undefined;
	let activeScope: string | undefined;
	let generation = 0;
	let refreshPending = false;

	const poll = async (storage: AccountStorageV3, index: number, scope: string): Promise<void> => {
		const expectedGeneration = generation;
		const canObserve = (): boolean => !controller.signal.aborted && scope === deps.scope() && expectedGeneration === generation;
		const account = storage.accounts[index];
		if (!account || account.enabled === false || controller.signal.aborted) return;
		const id = rotationAccountId(account, scope);
		const now = deps.now();
		const usageDue = (usagePolls.get(id)?.next ?? 0) <= now;
		const resetDue = (resetPolls.get(id)?.next ?? 0) <= now;
		if (!usageDue && !resetDue) return;
		try {
			const credentials = await deps.credentials({ storage, account });
			if (credentials.persisted) deps.onCredentialsPersisted();
			if (!canObserve()) return;
			const accountId = resolveCodexUsageAccountId({ account, accessToken: credentials.accessToken });
			if (!accountId) return;
			const request = { accountId, accessToken: credentials.accessToken, organizationId: account.organizationId, timeoutMs: 10_000, signal: controller.signal };
			const run = async (kind: "usage" | "resets"): Promise<void> => {
				const states = kind === "usage" ? usagePolls : resetPolls;
				const interval = kind === "usage" ? 300_000 : 1_800_000;
				const observedAt = deps.now();
				try {
					switch (kind) {
						case "usage": {
							const payload = await deps.usage(request);
							if (canObserve()) observations.usage(account, scope, payload, observedAt);
							break;
						}
						case "resets": {
							const payload = await deps.resets(request);
							const reported = typeof payload.available_count === "number" && Number.isFinite(payload.available_count) && payload.available_count >= 0;
							if (canObserve() && (reported || Array.isArray(payload.credits))) observations.resets(account, scope, parseCodexResetCredits(payload).availableCount, observedAt);
							break;
						}
						default: kind satisfies never;
					}
					if (canObserve()) states.set(id, { next: deps.now() + interval, failures: 0 });
				} catch (error) {
					if (!canObserve()) return;
					const failures = Math.min(6, (states.get(id)?.failures ?? 0) + 1);
					states.set(id, { next: deps.now() + Math.min(interval, 30_000 * 2 ** (failures - 1)), failures });
					if (!controller.signal.aborted) logWarn("Custom rotation observation unavailable", { kind, reason: error instanceof Error ? error.name : "unknown" });
				}
			};
			if (usageDue) await run("usage");
			if (resetDue && canObserve()) await run("resets");
		} catch (error) {
			if (!canObserve()) return;
			for (const states of [usagePolls, resetPolls]) {
				const failures = Math.min(6, (states.get(id)?.failures ?? 0) + 1);
				states.set(id, { next: deps.now() + Math.min(300_000, 30_000 * 2 ** (failures - 1)), failures });
			}
			if (!controller.signal.aborted) logWarn("Custom rotation observation credentials unavailable", { reason: error instanceof Error ? error.name : "unknown" });
		}
	};

	const check = async (): Promise<void> => {
		const expectedGeneration = generation;
		refreshPending = false;
		if (controller.signal.aborted || !deps.enabled()) return;
		const scope = deps.scope();
		const storage = await deps.load();
		if (!storage || controller.signal.aborted || scope !== deps.scope()) return;
		if (activeScope !== scope) { observations.clear(); usagePolls.clear(); resetPolls.clear(); activeScope = scope; }
		const indices = deduplicateUsageAccountIndices(storage);
		const ids = new Set(indices.flatMap((index) => {
			const account = storage.accounts[index];
			return account ? [rotationAccountId(account, scope)] : [];
		}));
		observations.retain(ids);
		for (const states of [usagePolls, resetPolls]) for (const id of states.keys()) if (!ids.has(id)) states.delete(id);
		for (let offset = 0; offset < indices.length && !controller.signal.aborted && expectedGeneration === generation; offset += 2) {
			await Promise.all(indices.slice(offset, offset + 2).map((index) => poll(storage, index, scope)));
		}
	};
	const runNow = (): Promise<void> => {
		if (running) return running;
		running = check().catch((error: unknown) => {
			if (!controller.signal.aborted) logWarn("Custom rotation observation check failed", { reason: error instanceof Error ? error.name : "unknown" });
		}).finally(() => { running = undefined; });
		return running;
	};
	const schedule = (delay: number): void => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void runNow().finally(() => { if (!controller.signal.aborted && deps.enabled()) schedule(refreshPending ? 0 : 30_000); });
		}, delay);
		timer.unref();
	};
	const dispose = (): void => {
		controller.abort();
		if (timer) clearTimeout(timer);
		observations.clear();
		unregisterCleanup(dispose);
	};
	return {
		observations, signal: controller.signal, runNow, dispose,
		start(): void {
			if (started || controller.signal.aborted || !deps.enabled()) return;
			started = true;
			registerCleanup(dispose);
			schedule(0);
		},
		refresh(): void {
			if (!started || controller.signal.aborted) return;
			generation += 1; refreshPending = true;
			usagePolls.clear(); resetPolls.clear(); observations.clear(); schedule(0);
		},
	};
}

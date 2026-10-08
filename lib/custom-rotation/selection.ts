import type { ModelFamily } from "../prompts/codex.js";
import type { ManagedAccount } from "../accounts/state.js";
import { rotationAccountId, type RotationObservations } from "./observations.js";
import { runRotationPolicy } from "./runner.js";
import { logWarn } from "../logger.js";

export type CustomSelectionRequest = {
	readonly family: ModelFamily;
	readonly model?: string | null;
	readonly preferredAccountIds?: readonly string[];
	readonly poolMode?: "preferred" | "strict";
	readonly excludedIndices?: ReadonlySet<number>;
};
export type CustomSelectionHost = {
	readonly candidates: (request: CustomSelectionRequest) => readonly ManagedAccount[];
	readonly accept: (account: ManagedAccount, request: CustomSelectionRequest) => ManagedAccount | null;
	readonly current: (family: ModelFamily) => ManagedAccount | null;
};

export async function selectCustomAccount(host: CustomSelectionHost, request: CustomSelectionRequest, policy: {
	readonly module: string | undefined;
	readonly observations: RotationObservations;
	readonly scope: string;
	readonly currentScope?: () => string;
	readonly signal?: AbortSignal;
	readonly requestSignal?: AbortSignal;
}): Promise<ManagedAccount | null> {
	const candidates = host.candidates(request);
	if (candidates.length === 0 || policy.signal?.aborted || policy.requestSignal?.aborted) return null;
	const now = Date.now();
	const current = host.current(request.family);
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	const signals = [policy.signal, policy.requestSignal];
	for (const signal of signals) signal?.addEventListener("abort", abort, { once: true });
	const result = policy.module ? await runRotationPolicy(policy.module, {
		version: 1, now, model: request.model ?? null,
		currentAccountId: current ? rotationAccountId(current, policy.scope) : null,
		accounts: candidates.map((account) => policy.observations.snapshot(account, policy.scope, now)),
	}, { signal: controller.signal }).finally(() => {
		for (const signal of signals) signal?.removeEventListener("abort", abort);
	}) : { accountId: null, error: "module-path" as const };
	if (!policy.module) for (const signal of signals) signal?.removeEventListener("abort", abort);
	if (policy.signal?.aborted || policy.requestSignal?.aborted || (policy.currentScope && policy.currentScope() !== policy.scope)) return null;
	const selected = candidates.find((account) => rotationAccountId(account, policy.scope) === result.accountId);
	if (selected) {
		const accepted = host.accept(selected, request);
		if (accepted) return accepted;
	}
	if (result.error || (result.accountId !== null && !selected)) {
		logWarn("Custom rotation policy fallback", { reason: result.error ?? "ineligible-id" });
	}
	// Recompute the preferred/general pool after the await; never use blocked hybrid fallback.
	const fallback = host.candidates(request)[0];
	return fallback ? host.accept(fallback, request) : null;
}

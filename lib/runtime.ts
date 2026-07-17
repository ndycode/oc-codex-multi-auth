/**
 * Plugin runtime scaffolding.
 *
 * Holds module-level helpers and pure types hoisted out of `index.ts` as the
 * first step of RC-1 (see `docs/audits/07-refactoring-plan.md#rc-1`). Everything
 * in this file is independent of the plugin closure — it may be imported freely
 * by `index.ts` and by any future `lib/tools/*` modules without dragging
 * plugin state into the call graph.
 *
 * Future RC-1 follow-ups will move additional closure-independent helpers here
 * and keep `lib/tools/*` factories consuming a
 * `ToolContext` assembled inside `OpenAIOAuthPlugin`.
 */

import {
	getWorkspaceIdentityKey,
	type FlaggedAccountMetadataV1,
} from "./storage.js";
import type { AccountSelectionExplainability } from "./accounts.js";
import type { RetryBudgetClass, RetryBudgetLimits } from "./request/retry-budget.js";
import type { ModelFamily } from "./prompts/codex.js";

// ---------------------------------------------------------------------------
// Module-level workspace-identity helpers.
// Pure functions; no closure or I/O. Safe to import from anywhere.
// ---------------------------------------------------------------------------

export function matchesWorkspaceIdentity(
	account: {
		organizationId?: string;
		accountId?: string;
		refreshToken: string;
	},
	identityKey: string,
): boolean {
	return getWorkspaceIdentityKey(account) === identityKey;
}

export function upsertFlaggedAccountRecord(
	accounts: FlaggedAccountMetadataV1[],
	record: FlaggedAccountMetadataV1,
): void {
	const identityKey = getWorkspaceIdentityKey(record);
	const existingIndex = accounts.findIndex((flagged) =>
		matchesWorkspaceIdentity(flagged, identityKey),
	);
	if (existingIndex >= 0) {
		accounts[existingIndex] = record;
		return;
	}
	accounts.push(record);
}

// ---------------------------------------------------------------------------
// Tool output formatting — used by every codex-* tool.
// ---------------------------------------------------------------------------

export type ToolOutputFormat = "text" | "json";

export function normalizeToolOutputFormat(format?: string): ToolOutputFormat {
	if (format === undefined) return "text";
	if (format === "text" || format === "json") return format;
	throw new Error(`Invalid format "${format}". Expected "text" or "json".`);
}

export function renderJsonOutput(payload: unknown): string {
	return JSON.stringify(payload, null, 2);
}

// ---------------------------------------------------------------------------
// Routing visibility / metrics types and pure helpers.
// ---------------------------------------------------------------------------

export type SelectionSnapshot = {
	timestamp: number;
	family: ModelFamily;
	model: string | null;
	requestedModel: string | null;
	effectiveModel: string | null;
	selectedAccountIndex: number | null;
	quotaKey: string;
	explainability: AccountSelectionExplainability[];
	fallbackApplied: boolean;
	fallbackFrom: string | null;
	fallbackTo: string | null;
	fallbackReason: string | null;
	accountPoolMode?: "general" | "preferred" | "general-fallback";
	configuredAccountPoolSize?: number;
};

export type SerializedSelectionExplainability = {
	index: number;
	zeroBasedIndex: number;
	enabled: boolean;
	isCurrentForFamily: boolean;
	eligible: boolean;
	reasons: string[];
	healthScore: number;
	tokensAvailable: number;
	rateLimitedUntil: number | null;
	coolingDownUntil: number | null;
	cooldownReason: string | null;
	lastUsed: number;
};

export type RoutingVisibilitySnapshot = {
	requestedModel: string | null;
	effectiveModel: string | null;
	modelFamily: ModelFamily | null;
	quotaKey: string | null;
	selectedAccountIndex: number | null;
	zeroBasedSelectedAccountIndex: number | null;
	lastErrorCategory: string | null;
	fallbackApplied: boolean;
	fallbackFrom: string | null;
	fallbackTo: string | null;
	fallbackReason: string | null;
	accountPoolMode: "general" | "preferred" | "general-fallback" | null;
	configuredAccountPoolSize: number;
	selectionExplainability: SerializedSelectionExplainability[];
};

export type RuntimeMetrics = {
	startedAt: number;
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	rateLimitedResponses: number;
	serverErrors: number;
	networkErrors: number;
	authRefreshFailures: number;
	emptyResponseRetries: number;
	accountRotations: number;
	cumulativeLatencyMs: number;
	retryBudgetExhaustions: number;
	retryBudgetUsage: Record<RetryBudgetClass, number>;
	retryBudgetLimits: RetryBudgetLimits;
	retryProfile: string;
	lastRetryBudgetExhaustedClass: RetryBudgetClass | null;
	lastRetryBudgetReason: string | null;
	lastRequestAt: number | null;
	lastError: string | null;
	lastErrorCategory: string | null;
	promptCacheEnabledRequests: number;
	promptCacheMissingRequests: number;
	lastPromptCacheKey: string | null;
	lastSelectedAccountIndex: number | null;
	lastQuotaKey: string | null;
	lastSelectionSnapshot: SelectionSnapshot | null;
};

export function createRetryBudgetUsage(): Record<RetryBudgetClass, number> {
	return {
		authRefresh: 0,
		network: 0,
		server: 0,
		rateLimitShort: 0,
		rateLimitGlobal: 0,
		emptyResponse: 0,
	};
}

export function serializeSelectionExplainability(
	entries: AccountSelectionExplainability[],
): SerializedSelectionExplainability[] {
	return entries.map((entry) => ({
		index: entry.index + 1,
		zeroBasedIndex: entry.index,
		enabled: entry.enabled,
		isCurrentForFamily: entry.isCurrentForFamily,
		eligible: entry.eligible,
		reasons: [...entry.reasons],
		healthScore: entry.healthScore,
		tokensAvailable: entry.tokensAvailable,
		rateLimitedUntil:
			typeof entry.rateLimitedUntil === "number" ? entry.rateLimitedUntil : null,
		coolingDownUntil:
			typeof entry.coolingDownUntil === "number" ? entry.coolingDownUntil : null,
		cooldownReason: entry.cooldownReason ?? null,
		lastUsed: entry.lastUsed,
	}));
}

export function formatRoutingValue(
	value: string | number | boolean | null | undefined,
): string {
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (value === null || value === undefined || value === "") return "-";
	return String(value);
}

export function formatExplainabilitySummary(
	entry: SerializedSelectionExplainability,
): string {
	return `Account ${entry.index}: ${entry.eligible ? "eligible" : "blocked"} | health=${Math.round(entry.healthScore)} | tokens=${entry.tokensAvailable.toFixed(1)} | ${entry.reasons.join(", ")}`;
}

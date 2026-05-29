import type { Config } from "@opencode-ai/sdk/v2";

export type ReasoningVariant = "none" | "low" | "medium" | "high" | "xhigh";

export type CompactQuotaLimit = {
	label: string;
	leftPercent: number | null;
	usedPercent?: number;
	windowMinutes?: number;
	resetAtMs?: number;
};

export type CompactQuotaSource = "headers" | "usage";

export type CompactQuotaStatus =
	| { type: "loading" }
	| { type: "missing" }
	| { type: "unavailable" }
	| {
			type: "ready";
			limits: readonly CompactQuotaLimit[];
			stale: boolean;
			source?: CompactQuotaSource;
			fetchedAt?: number;
			fingerprint?: string;
			accountIndex?: number;
			accountCount?: number;
			accountEmail?: string;
			accountLabel?: string;
			planType?: string;
			activeLimit?: number;
	  };

export type PromptStatusMessage = {
	role: "user" | "assistant";
	modelID?: string;
	variant?: string;
	userModel?: {
		modelID?: string;
		variant?: string;
	};
};

export type PromptStatusConfig = Pick<
	Config,
	"model" | "default_agent" | "agent" | "mode" | "provider"
>;

const variantSuffixes: ReasoningVariant[] = [
	"xhigh",
	"high",
	"medium",
	"low",
	"none",
];
const STATUS_SEPARATOR = ` ${String.fromCharCode(183)} `;
const WARNING_LIMIT_LEFT_PERCENT = 25;
const DANGER_LIMIT_LEFT_PERCENT = 10;
const MASKED_EMAIL = "*****";
const EMAIL_PATTERN = /[^\s(),<>]+@[^\s(),<>]+/;
const EMAIL_PATTERN_GLOBAL = /[^\s(),<>]+@[^\s(),<>]+/g;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeReasoningVariant(
	value: string | undefined,
): ReasoningVariant | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "extra-high" || normalized === "extra_high") {
		return "xhigh";
	}
	return variantSuffixes.find((variant) => variant === normalized);
}

export function inferReasoningVariantFromModelId(
	modelID: string | undefined,
): ReasoningVariant | undefined {
	const modelPart = modelID?.split("/").pop()?.toLowerCase();
	if (!modelPart) return undefined;
	for (const variant of variantSuffixes) {
		if (modelPart.endsWith(`-${variant}`)) return variant;
	}
	return undefined;
}

function splitProviderModel(model: string | undefined): {
	providerID: string;
	modelID: string;
} | undefined {
	const trimmed = model?.trim();
	if (!trimmed) return undefined;
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
		return { providerID: "openai", modelID: trimmed };
	}
	return {
		providerID: trimmed.slice(0, slashIndex),
		modelID: trimmed.slice(slashIndex + 1),
	};
}

function resolveAgentConfig(
	config: PromptStatusConfig,
): Record<string, unknown> | undefined {
	const agentName = config.default_agent ?? "build";
	const agents = config.agent;
	const selectedAgent = agents?.[agentName];
	if (isRecord(selectedAgent)) return selectedAgent;
	if (isRecord(agents?.build)) return agents.build;
	if (isRecord(agents?.general)) return agents.general;
	const legacyMode = config.mode;
	if (isRecord(legacyMode?.build)) return legacyMode.build;
	return undefined;
}

function resolveProviderReasoningVariant(
	config: PromptStatusConfig,
	model: string | undefined,
): ReasoningVariant | undefined {
	const resolved = splitProviderModel(model);
	if (!resolved) return undefined;
	const provider = config.provider?.[resolved.providerID];
	const modelConfig = provider?.models?.[resolved.modelID];
	const modelOptions = isRecord(modelConfig?.options)
		? modelConfig.options
		: undefined;
	const providerOptions = isRecord(provider?.options)
		? provider.options
		: undefined;

	return (
		normalizeReasoningVariant(getString(modelOptions?.reasoningEffort)) ??
		normalizeReasoningVariant(getString(providerOptions?.reasoningEffort))
	);
}

function resolveAgentReasoningVariant(
	agent: Record<string, unknown> | undefined,
): ReasoningVariant | undefined {
	if (!agent) return undefined;
	const options = isRecord(agent.options) ? agent.options : undefined;
	return (
		normalizeReasoningVariant(getString(agent.variant)) ??
		normalizeReasoningVariant(getString(agent.reasoningEffort)) ??
		normalizeReasoningVariant(getString(options?.reasoningEffort))
	);
}

export function resolvePromptReasoningVariant(params: {
	messages?: readonly PromptStatusMessage[];
	config?: PromptStatusConfig;
}): ReasoningVariant | undefined {
	const messages = params.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (!message) continue;
		if (message.role === "user") {
			const variant =
				normalizeReasoningVariant(message.userModel?.variant) ??
				inferReasoningVariantFromModelId(message.userModel?.modelID);
			if (variant) return variant;
			continue;
		}
		const variant =
			normalizeReasoningVariant(message.variant) ??
			inferReasoningVariantFromModelId(message.modelID);
		if (variant) return variant;
	}

	const config = params.config;
	if (!config) return undefined;
	const agent = resolveAgentConfig(config);
	const agentVariant = resolveAgentReasoningVariant(agent);
	if (agentVariant) return agentVariant;

	const agentModel = getString(agent?.model);
	const model = agentModel ?? config.model;
	return (
		inferReasoningVariantFromModelId(model) ??
		resolveProviderReasoningVariant(config, model)
	);
}

function isPercent(value: number | null): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function extractEmailFromLabel(label: string | undefined): string | undefined {
	const match = label?.match(EMAIL_PATTERN);
	return match?.[0];
}

function formatAccountEmail(
	email: string | undefined,
	maskEmail: boolean,
): string | undefined {
	const trimmed = email?.trim() || undefined;
	return trimmed ? `[${maskEmail ? MASKED_EMAIL : trimmed}]` : undefined;
}

function maskEmailsInText(
	value: string | undefined,
	maskEmail: boolean,
): string | undefined {
	if (!value) return undefined;
	return maskEmail ? value.replace(EMAIL_PATTERN_GLOBAL, MASKED_EMAIL) : value;
}

function formatQuotaLimit(
	limit: CompactQuotaLimit,
	resetLimit: CompactQuotaLimit | undefined,
	includeReset: boolean,
): string | undefined {
	if (!isPercent(limit.leftPercent)) return undefined;
	const label = limit.label.trim() || "quota";
	const base = `${label} ${limit.leftPercent}%`;
	const reset =
		includeReset && limit === resetLimit ? formatResetTime(limit.resetAtMs) : undefined;
	return reset ? `${base} resets ${reset}` : base;
}

function formatAccountHint(
	quota: CompactQuotaStatus,
	maskEmail = false,
): string | undefined {
	if (quota.type !== "ready") return undefined;
	if (
		typeof quota.accountIndex !== "number" ||
		!Number.isFinite(quota.accountIndex)
	) {
		return undefined;
	}
	if (
		typeof quota.accountCount === "number" &&
		Number.isFinite(quota.accountCount) &&
		quota.accountCount <= 1
	) {
		return undefined;
	}
	const email =
		formatAccountEmail(quota.accountEmail, maskEmail) ??
		formatAccountEmail(extractEmailFromLabel(quota.accountLabel), maskEmail);
	if (email) return email;
	return `A${quota.accountIndex}`;
}

function findResetLimitForStatus(
	limits: readonly CompactQuotaLimit[],
): CompactQuotaLimit | undefined {
	const eligible = limits.filter((limit) => isPercent(limit.leftPercent));
	if (eligible.length === 0) return undefined;
	const lowest = eligible.reduce((current, limit) =>
		(limit.leftPercent ?? 100) < (current.leftPercent ?? 100)
			? limit
			: current,
	);
	if ((lowest.leftPercent ?? 100) > WARNING_LIMIT_LEFT_PERCENT) {
		return undefined;
	}
	return formatResetTime(lowest.resetAtMs) ? lowest : undefined;
}

function formatQuotaParts(
	quota: CompactQuotaStatus,
	includeReset: boolean,
): string[] {
	if (quota.type !== "ready") return [];
	const resetLimit = includeReset
		? findResetLimitForStatus(quota.limits)
		: undefined;
	return quota.limits
		.map((limit) => formatQuotaLimit(limit, resetLimit, includeReset))
		.filter((part): part is string => Boolean(part));
}

function formatQuota(quota: CompactQuotaStatus): string | undefined {
	if (quota.type === "ready") {
		const parts = formatQuotaParts(quota, true);
		return parts.length > 0 ? parts.join(STATUS_SEPARATOR) : undefined;
	}
	if (quota.type === "missing") return "no auth";
	if (quota.type === "unavailable") return "limits ?";
	return undefined;
}

function maxStatusChars(width: number | undefined): number {
	if (!width || !Number.isFinite(width)) return 32;
	if (width >= 120) return 48;
	if (width >= 96) return 40;
	if (width >= 78) return 32;
	if (width >= 60) return 22;
	return 12;
}

export function formatPromptStatusText(params: {
	variant?: ReasoningVariant;
	quota: CompactQuotaStatus;
	width?: number;
	maskEmail?: boolean;
}): string {
	const variant = params.variant;
	const account = formatAccountHint(params.quota, params.maskEmail);
	const quotaParts = formatQuotaParts(params.quota, true);
	const quotaPartsWithoutReset = formatQuotaParts(params.quota, false);
	const quota = quotaParts.length > 0
		? quotaParts.join(STATUS_SEPARATOR)
		: formatQuota(params.quota);
	const primaryQuota = quotaParts[0] ?? quota;
	const quotaWithoutReset = quotaPartsWithoutReset.length > 0
		? quotaPartsWithoutReset.join(STATUS_SEPARATOR)
		: quota;
	const primaryQuotaWithoutReset = quotaPartsWithoutReset[0] ?? primaryQuota;
	const candidates = [
		[account, quota].filter(Boolean).join(STATUS_SEPARATOR),
		[account, primaryQuota].filter(Boolean).join(STATUS_SEPARATOR),
		quota,
		primaryQuota,
		[account, quotaWithoutReset].filter(Boolean).join(STATUS_SEPARATOR),
		[account, primaryQuotaWithoutReset].filter(Boolean).join(STATUS_SEPARATOR),
		quotaWithoutReset,
		primaryQuotaWithoutReset,
		[variant, account, quota].filter(Boolean).join(STATUS_SEPARATOR),
		[variant, quota].filter(Boolean).join(STATUS_SEPARATOR),
		variant,
		account,
	].filter((candidate): candidate is string => Boolean(candidate));
	const maxChars = maxStatusChars(params.width);
	return candidates.find((candidate) => candidate.length <= maxChars) ?? "";
}

export type QuotaPromptTone =
	| "normal"
	| "warning"
	| "danger"
	| "stale"
	| "unknown";

export function resolveQuotaPromptTone(
	quota: CompactQuotaStatus,
): QuotaPromptTone {
	if (quota.type === "ready") {
		if (quota.stale) return "stale";
		const percents = quota.limits
			.map((limit) => limit.leftPercent)
			.filter(isPercent);
		if (percents.length === 0) return "unknown";
		const lowest = Math.min(...percents);
		if (lowest <= DANGER_LIMIT_LEFT_PERCENT) return "danger";
		if (lowest <= WARNING_LIMIT_LEFT_PERCENT) return "warning";
		return "normal";
	}
	if (quota.type === "loading") return "unknown";
	return "warning";
}

function formatReset(resetAtMs: number | undefined): string | undefined {
	if (!resetAtMs || !Number.isFinite(resetAtMs) || resetAtMs <= 0) {
		return undefined;
	}
	const date = new Date(resetAtMs);
	if (!Number.isFinite(date.getTime())) return undefined;
	const now = new Date();
	const sameDay =
		now.getFullYear() === date.getFullYear() &&
		now.getMonth() === date.getMonth() &&
		now.getDate() === date.getDate();
	const time = date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	if (sameDay) return time;
	const day = date.toLocaleDateString(undefined, {
		month: "short",
		day: "2-digit",
	});
	return `${time} on ${day}`;
}

function formatResetTime(resetAtMs: number | undefined): string | undefined {
	if (!resetAtMs || !Number.isFinite(resetAtMs) || resetAtMs <= 0) {
		return undefined;
	}
	const date = new Date(resetAtMs);
	if (!Number.isFinite(date.getTime())) return undefined;
	return date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function formatUpdatedAge(fetchedAt: number | undefined, now: number): string {
	if (!fetchedAt || !Number.isFinite(fetchedAt)) return "unknown";
	const ageMs = Math.max(0, now - fetchedAt);
	if (ageMs < 60_000) return "just now";
	const minutes = Math.floor(ageMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatDetailsLimit(limit: CompactQuotaLimit): string {
	const label = limit.label.trim() || "quota";
	const left = isPercent(limit.leftPercent)
		? `${limit.leftPercent}% left`
		: "unavailable";
	const reset = formatReset(limit.resetAtMs);
	return reset ? `${label}: ${left}, resets ${reset}` : `${label}: ${left}`;
}

export function formatQuotaDetailsText(
	quota: CompactQuotaStatus,
	now = Date.now(),
	options: { maskEmail?: boolean } = {},
): string {
	if (quota.type === "loading") return "Quota is loading.";
	if (quota.type === "missing") return "No Codex OAuth account is configured.";
	if (quota.type === "unavailable") return "Quota is unavailable.";

	const lines: string[] = [];
	const accountHint = formatAccountHint(quota, options.maskEmail);
	const accountLabel = maskEmailsInText(quota.accountLabel, Boolean(options.maskEmail));
	if (accountLabel && accountHint) {
		lines.push(`Account: ${accountHint} (${accountLabel})`);
	} else if (accountLabel) {
		lines.push(`Account: ${accountLabel}`);
	} else if (accountHint) {
		lines.push(`Account: ${accountHint}`);
	}
	for (const limit of quota.limits) {
		lines.push(formatDetailsLimit(limit));
	}
	if (quota.planType) lines.push(`Plan: ${quota.planType}`);
	if (
		typeof quota.activeLimit === "number" &&
		Number.isFinite(quota.activeLimit)
	) {
		lines.push(`Active limit: ${quota.activeLimit}`);
	}
	lines.push(
		`Source: ${quota.source === "headers" ? "response headers" : "usage endpoint"}`,
	);
	lines.push(`Updated: ${formatUpdatedAge(quota.fetchedAt, now)}`);
	if (quota.stale) lines.push("Status: stale fallback");
	return lines.join("\n");
}

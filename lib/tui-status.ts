import type { Config } from "@opencode-ai/sdk/v2";
import { maskEmailForDisplay } from "./account-display.js";
import { getEffortSuffix } from "./request/helpers/effort-suffix.js";
import { formatPlanType } from "./auth/plan-tier.js";
import {
	formatQuotaOverviewCandidates,
	formatQuotaCreditsCandidates,
	formatQuotaResetsCandidates,
	resolveQuotaOverviewTonePercent,
	type QuotaOverviewAccount,
	type QuotaOverviewOptions,
} from "./quota-overview.js";
import {
	DEFAULT_QUOTA_DISPLAY_MODE,
	formatNamedQuotaPercent,
	formatQuotaPercent,
	type QuotaDisplayMode,
} from "./quota-display.js";
import {
	displayWidth,
	formatClockTime,
	formatShortDate,
	sanitizeDisplayText,
} from "./ui/display-text.js";
import {
	resolveUiGlyphs,
	type UiGlyphMode,
} from "./ui/theme.js";

export type ReasoningVariant =
	| "none"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max"
	| "ultra";

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
	"ultra",
	"max",
	"xhigh",
	"high",
	"medium",
	"low",
	"none",
];
/**
 * Segment separator for the compact status line, padded with a space on each
 * side. The glyph comes from `codexTuiGlyphMode`; callers that never heard of
 * glyph modes (including older tests) get the original middle dot.
 */
function statusSeparator(mode: UiGlyphMode | undefined): string {
	return ` ${resolveUiGlyphs(mode ?? "unicode").separator} `;
}
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WARNING_LIMIT_LEFT_PERCENT = 25;
const DANGER_LIMIT_LEFT_PERCENT = 10;
const MASKED_EMAIL = "*****";
const FLAT_MASKED_HINT = `[${MASKED_EMAIL}]`;
// Whitespace, brackets, `,` and `;` end a token: none can appear in an
// address, and all of them separate one address from the next in a label.
const EMAIL_PATTERN = /[^\s(),<>;]+@[^\s(),<>;]+/;
const TEXT_TOKEN_GLOBAL = /[^\s(),<>;]+/g;

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
	// getEffortSuffix knows `gpt-5.1-codex-max` is a model id, not a `max` request.
	const suffix = getEffortSuffix(modelPart);
	if (!suffix) return undefined;
	return variantSuffixes.find((variant) => variant === suffix);
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

/**
 * Mask one token that carries an `@`.
 *
 * `maskEmailForDisplay` preserves everything from the first `@` onward, which
 * is the right trade for a single address - `ne***@example.com` names an
 * account without disclosing it - and the wrong one for a token holding two.
 * `alice@example.com/bob@corp.com` is a single token, because `/` is not a
 * separator anything here splits on, and the tail preserved would be the
 * whole second address. A token carrying more than one `@` is therefore
 * flattened, since no part of it is known to be safe to keep.
 */
function maskEmailToken(token: string): string {
	const first = token.indexOf("@");
	if (first <= 0) return MASKED_EMAIL;
	if (token.indexOf("@", first + 1) !== -1) return MASKED_EMAIL;
	return maskEmailForDisplay(token) ?? MASKED_EMAIL;
}

/**
 * Render the bracketed account hint.
 *
 * With masking on, a value containing an address becomes that address masked,
 * rather than having the address substituted inside the value. What reaches
 * here is free text - `accountEmail` is whatever the snapshot on disk holds -
 * and preserving what surrounds an address preserves exactly the identifying
 * text masking exists to remove: substituting in place would render "Neil
 * Smith neil@example.com" as "Neil Smith ne***@example.com". A value with no
 * address in it flattens for the same reason.
 */
function formatAccountEmail(
	email: string | undefined,
	maskEmail: boolean,
): string | undefined {
	// Whatever the snapshot carries is untrusted text headed for the status
	// line: escape sequences and controls are stripped before the address is
	// even looked for.
	const trimmed = sanitizeDisplayText(email);
	if (!trimmed) return undefined;
	if (!maskEmail) return `[${trimmed}]`;
	const address = extractEmailFromLabel(trimmed);
	return `[${address ? maskEmailToken(address) : MASKED_EMAIL}]`;
}

/**
 * Mask every address in text whose surrounding structure is worth keeping.
 *
 * Unlike the hint above, this is used on the account label in the details
 * dialog, where "Account 2 (…)" is the structure that makes the line
 * readable. It walks tokens rather than address matches: a match can span two
 * addresses joined by punctuation the address class does not exclude, and
 * replacing that match with a partial mask leaves the second address intact.
 * Every token holding an `@` is masked, so no address survives whatever joins
 * them.
 */
function maskEmailsInText(
	value: string | undefined,
	maskEmail: boolean,
): string | undefined {
	if (!value) return undefined;
	// Free text from the snapshot may carry escapes or bidi controls; strip
	// them whether or not masking is on, so the details dialog cannot paint
	// them into the terminal.
	const clean = sanitizeDisplayText(value);
	if (!clean) return undefined;
	if (!maskEmail) return clean;
	return clean.replace(TEXT_TOKEN_GLOBAL, (token) =>
		token.includes("@") ? maskEmailToken(token) : token,
	);
}

function formatQuotaLimit(
	limit: CompactQuotaLimit,
	resetLimit: CompactQuotaLimit | undefined,
	includeReset: boolean,
	mode: QuotaDisplayMode,
): string | undefined {
	if (!isPercent(limit.leftPercent)) return undefined;
	// The label comes from a cached snapshot the request path wrote, not from
	// anything this process verified — sanitize before it reaches a terminal.
	const label = sanitizeDisplayText(limit.label) ?? "quota";
	const base = `${label} ${formatQuotaPercent(limit.leftPercent, mode)}`;
	const reset =
		includeReset && limit === resetLimit ? formatResetTime(limit.resetAtMs) : undefined;
	return reset ? `${base} resets ${reset}` : base;
}

/**
 * The account hint, longest form first.
 *
 * A masked partial hint is about twelve characters longer than the flat
 * `[*****]` it replaced, and the candidate ladder drops the account hint
 * entirely when a rung does not fit. Offering the flat form as a second try
 * at the same rung is what stops turning masking on from removing the account
 * from a 78- or 96-column status line, which would identify the account less
 * rather than more.
 */
function formatAccountHints(
	quota: CompactQuotaStatus,
	maskEmail = false,
): string[] {
	if (quota.type !== "ready") return [];
	if (
		typeof quota.accountIndex !== "number" ||
		!Number.isFinite(quota.accountIndex)
	) {
		return [];
	}
	if (
		typeof quota.accountCount === "number" &&
		Number.isFinite(quota.accountCount) &&
		quota.accountCount <= 1
	) {
		return [];
	}
	const email =
		formatAccountEmail(quota.accountEmail, maskEmail) ??
		formatAccountEmail(extractEmailFromLabel(quota.accountLabel), maskEmail);
	if (!email) return [`A${quota.accountIndex}`];
	// Only when masking is on: the flat form is a mask, and offering it as a
	// narrow-width fallback with masking off would print `*****` for someone
	// who asked to see the address.
	return maskEmail && email !== FLAT_MASKED_HINT
		? [email, FLAT_MASKED_HINT]
		: [email];
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
	mode: QuotaDisplayMode,
): string[] {
	if (quota.type !== "ready") return [];
	const resetLimit = includeReset
		? findResetLimitForStatus(quota.limits)
		: undefined;
	return quota.limits
		.map((limit) => formatQuotaLimit(limit, resetLimit, includeReset, mode))
		.filter((part): part is string => Boolean(part));
}

function formatQuota(
	quota: CompactQuotaStatus,
	mode: QuotaDisplayMode,
	separator: string,
): string | undefined {
	if (quota.type === "ready") {
		const parts = formatQuotaParts(quota, true, mode);
		return parts.length > 0 ? parts.join(separator) : undefined;
	}
	if (quota.type === "missing") return "no auth";
	if (quota.type === "unavailable") return "limits ?";
	return undefined;
}

/**
 * Return the character budget for the prompt status line at a given terminal
 * width. Budgets scale to about 54% of each tier's minimum width so the
 * day-context reset labels and typical account hints fit.
 */
function maxStatusChars(width: number | undefined): number {
	// Budgets are ~54% of each named tier's minimum width (up from ~40%): the
	// day-context reset labels and typical account hints no longer fit at
	// 40%, which degraded informative candidates on mid-width terminals. The
	// last branch is the exception and stays at 12, because 54% of a
	// 40-column terminal leaves nothing for the prompt itself.
	//
	// An unknown width cannot be scaled at all, so it takes the narrowest
	// tier budget rather than a mid-tier one: a 42-character line on the
	// 40-column terminal this branch also covers wraps and pushes the prompt,
	// and there is nothing here to detect that it happened.
	if (!width || !Number.isFinite(width)) return 32;
	if (width >= 120) return 64;
	if (width >= 96) return 52;
	if (width >= 78) return 42;
	if (width >= 60) return 32;
	// Clamped, not a flat 12: below twelve columns a 12-character budget is
	// wider than the terminal itself, and the line wraps and pushes the
	// prompt. Nothing fits at that size, and printing nothing is the correct
	// answer rather than printing something that does not fit.
	return Math.min(12, width);
}

export function formatPromptStatusText(params: {
	variant?: ReasoningVariant;
	quota: CompactQuotaStatus;
	width?: number;
	/**
	 * Columns the renderer measured for this slot. When present it wins over
	 * the `width` heuristics outright — the slot may share its row with
	 * other content, and only the measurement knows how much.
	 */
	availableChars?: number;
	maskEmail?: boolean;
	quotaDisplay?: QuotaDisplayMode;
	/** `codexTuiGlyphMode`; `auto` resolves against the environment. */
	glyphMode?: UiGlyphMode;
}): string {
	const variant = params.variant;
	const mode = params.quotaDisplay ?? DEFAULT_QUOTA_DISPLAY_MODE;
	const separator = statusSeparator(params.glyphMode);
	const accountForms = formatAccountHints(params.quota, params.maskEmail);
	const quotaParts = formatQuotaParts(params.quota, true, mode);
	const quotaPartsWithoutReset = formatQuotaParts(params.quota, false, mode);
	const quota = quotaParts.length > 0
		? quotaParts.join(separator)
		: formatQuota(params.quota, mode, separator);
	const primaryQuota = quotaParts[0] ?? quota;
	const quotaWithoutReset = quotaPartsWithoutReset.length > 0
		? quotaPartsWithoutReset.join(separator)
		: quota;
	const primaryQuotaWithoutReset = quotaPartsWithoutReset[0] ?? primaryQuota;
	// Each account-bearing rung tries every hint form before the ladder gives
	// up on showing the account at all.
	const withAccount = (rest: string | undefined, prefix?: string) =>
		accountForms.map((form) =>
			[prefix, form, rest].filter(Boolean).join(separator),
		);
	const candidates = [
		...withAccount(quota),
		...withAccount(primaryQuota),
		quota,
		primaryQuota,
		...withAccount(quotaWithoutReset),
		...withAccount(primaryQuotaWithoutReset),
		quotaWithoutReset,
		primaryQuotaWithoutReset,
		...withAccount(quota, variant),
		[variant, quota].filter(Boolean).join(separator),
		variant,
		...accountForms,
	].filter((candidate): candidate is string => Boolean(candidate));
	const available = params.availableChars;
	// Budgets are display columns, not code units: a candidate is only
	// eligible if its grapheme-aware width fits, so CJK labels and emoji
	// cannot overflow a terminal `string.length` would call short enough.
	const maxChars =
		typeof available === "number" &&
		Number.isFinite(available) &&
		available > 0
			? Math.floor(available)
			: maxStatusChars(params.width);
	return (
		candidates.find((candidate) => displayWidth(candidate) <= maxChars) ?? ""
	);
}

/**
 * Columns this line may not spend, because something else on the row owns
 * them: the prompt border and padding, and the model label sitting to the
 * left of this slot ("Build - Big Pickle OpenCode Zen" is 31 characters).
 */
const OVERVIEW_STATUS_RESERVED_CHARS = 40;

/**
 * Character budget for the pool-wide line.
 *
 * Two bounds, whichever is tighter. The share cap keeps a wide terminal from
 * handing the whole row to this line; the reserve keeps a narrow one from
 * overrunning the model label beside it. The reserve is what binds at ordinary
 * widths, and it has to: unlike the single-account line above - which is short
 * enough that its budget is never the thing that stops it - this line grows
 * with the size of the pool and reaches its budget on every render.
 *
 * Overflow is NOT absorbed by the renderer's truncation. At 80 columns a
 * 48-character line was ellipsized through its middle, destroying account
 * numbers and reset times either side of the cut, AND pushed the model label
 * into a second row. The reserve is sized so that does not happen: 40 at 80
 * columns, which is what measurably fits beside a 31-character label.
 */
function maxOverviewStatusChars(width: number | undefined): number {
	if (!width || !Number.isFinite(width)) return 32;
	return Math.max(
		Math.min(12, width),
		Math.min(
			Math.floor(width * 0.6),
			width - OVERVIEW_STATUS_RESERVED_CHARS,
		),
	);
}

/**
 * Columns available to this line, preferring what the renderer measured.
 *
 * `width` is the whole terminal, which is the wrong number whenever anything
 * else is on the row - a sidebar, the model label - and it is wrong by however
 * much those take. A measured value comes from the laid-out node itself and
 * needs no reserve at all, so it is used verbatim.
 */
function resolveOverviewChars(
	width: number | undefined,
	availableChars: number | undefined,
): number {
	if (
		typeof availableChars === "number" &&
		Number.isFinite(availableChars) &&
		availableChars > 0
	) {
		return Math.floor(availableChars);
	}
	return maxOverviewStatusChars(width);
}

/**
 * Break one rendering across rows, at the separators it already has.
 *
 * Only `, ` boundaries are used, so a row never ends mid-account: a line cut
 * between `#2` and its percentage is worse than no second row at all. A
 * candidate with any single segment wider than the row cannot be laid out this
 * way and is rejected, which sends the caller to the next rung down.
 */
export function wrapStatusCandidate(
	candidate: string,
	maxChars: number,
	maxRows: number,
): string[] | undefined {
	if (displayWidth(candidate) <= maxChars) return [candidate];
	if (maxRows <= 1 || maxChars <= 0) return undefined;
	const segments = candidate.split(", ");
	const rows: string[] = [];
	let row = "";
	for (const [position, segment] of segments.entries()) {
		const piece = position === segments.length - 1 ? segment : `${segment},`;
		// Display columns, not code units: a CJK account label takes two of
		// them per character.
		if (displayWidth(piece) > maxChars) return undefined;
		if (row.length === 0) {
			row = piece;
			continue;
		}
		const joined = `${row} ${piece}`;
		if (displayWidth(joined) <= maxChars) {
			row = joined;
			continue;
		}
		rows.push(row);
		if (rows.length >= maxRows) return undefined;
		row = piece;
	}
	if (row.length > 0) rows.push(row);
	return rows.length > 0 && rows.length <= maxRows ? rows : undefined;
}

/**
 * Lay a candidate ladder out in the space available, in up to `maxRows` rows.
 *
 * The ladder is walked once, and the first rung that fits wins - whether it
 * fits on one row or has to be broken across two. Trying every rung on one row
 * before allowing a second would shed detail the reader has room for.
 */
export function fitStatusLines(
	candidates: readonly string[],
	maxChars: number,
	maxRows: number,
): string[] {
	for (const candidate of candidates) {
		const rows = wrapStatusCandidate(candidate, maxChars, maxRows);
		if (rows) return rows;
	}
	const last = candidates.at(-1);
	return last ? [last] : [];
}

/**
 * Render the whole account pool, degrading through
 * {@link formatQuotaOverviewCandidates} until one form fits.
 */
export function formatQuotaOverviewStatusLines(params: {
	accounts: readonly QuotaOverviewAccount[];
	options: QuotaOverviewOptions;
	width?: number;
	availableChars?: number;
	maxRows?: number;
}): string[] {
	return fitStatusLines(
		formatQuotaOverviewCandidates(params.accounts, params.options),
		resolveOverviewChars(params.width, params.availableChars),
		params.maxRows ?? 1,
	);
}

export function formatQuotaOverviewStatusText(params: {
	accounts: readonly QuotaOverviewAccount[];
	options: QuotaOverviewOptions;
	width?: number;
	availableChars?: number;
}): string {
	return formatQuotaOverviewStatusLines(params)[0] ?? "";
}

/** The banked-reset line, laid out the same way as the pool line. */
export function formatQuotaResetsStatusLines(params: {
	accounts: readonly QuotaOverviewAccount[];
	options: QuotaOverviewOptions;
	resetsMinUsedPercent?: number;
	width?: number;
	availableChars?: number;
	maxRows?: number;
}): string[] {
	const candidates = formatQuotaResetsCandidates(params.accounts, {
		minUsedPercent: params.resetsMinUsedPercent,
		maskEmail: params.options.maskEmail,
		names: params.options.names,
		now: params.options.now,
	});
	if (candidates.length === 0) return [];
	return fitStatusLines(
		candidates,
		resolveOverviewChars(params.width, params.availableChars),
		params.maxRows ?? 1,
	);
}

/** The Codex-credits line, laid out the same way as the resets line. */
export function formatQuotaCreditsStatusLines(params: {
	accounts: readonly QuotaOverviewAccount[];
	options: QuotaOverviewOptions;
	resetsMinUsedPercent?: number;
	width?: number;
	availableChars?: number;
	maxRows?: number;
}): string[] {
	const candidates = formatQuotaCreditsCandidates(params.accounts, {
		minUsedPercent: params.resetsMinUsedPercent,
		maskEmail: params.options.maskEmail,
		names: params.options.names,
	});
	if (candidates.length === 0) return [];
	return fitStatusLines(
		candidates,
		resolveOverviewChars(params.width, params.availableChars),
		params.maxRows ?? 1,
	);
}

export type QuotaPromptTone =
	| "normal"
	| "warning"
	| "danger"
	| "stale"
	| "unknown";

/**
 * Colour the pool by its healthiest account.
 *
 * A pool is only in trouble when nothing in it has room left, so the account
 * with the most headroom decides the colour: keying on the worst account would
 * paint the line red for a spent seat that rotation has already stopped
 * selecting while six healthy ones serve every request.
 */
export function resolveQuotaOverviewTone(
	accounts: readonly QuotaOverviewAccount[],
	stale = false,
): QuotaPromptTone {
	if (stale) return "stale";
	const best = resolveQuotaOverviewTonePercent(accounts);
	if (best === undefined) return "unknown";
	if (best <= DANGER_LIMIT_LEFT_PERCENT) return "danger";
	if (best <= WARNING_LIMIT_LEFT_PERCENT) return "warning";
	return "normal";
}

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

type ResetParts = {
	date: Date;
	/** Fixed 24-hour clock time, e.g. `02:25` — identical under every locale. */
	time: string;
	sameDay: boolean;
	/**
	 * Calendar days from today, not elapsed milliseconds: a DST transition
	 * makes a seven-calendar-day gap span 167 or 169 hours, which a fixed 24h
	 * division would misclassify and repeat today's weekday.
	 */
	dayDiff: number;
};

/**
 * Decompose a reset timestamp once for both renderings below.
 *
 * The compact status line and the quota details dialog word the same instant
 * differently - `Sep 15 02:25` against `02:25 on Sep 15` - but they agree on
 * every decision behind it: the same validity guard, the same 24-hour clock,
 * the same same-day test. Keeping those in one place is what stops the two
 * surfaces drifting apart on which reset is "today".
 */
function describeReset(resetAtMs: number | undefined): ResetParts | undefined {
	if (!resetAtMs || !Number.isFinite(resetAtMs) || resetAtMs <= 0) {
		return undefined;
	}
	const date = new Date(resetAtMs);
	if (!Number.isFinite(date.getTime())) return undefined;
	const now = new Date();
	return {
		date,
		time: formatClockTime(date),
		sameDay:
			now.getFullYear() === date.getFullYear() &&
			now.getMonth() === date.getMonth() &&
			now.getDate() === date.getDate(),
		dayDiff: calendarDayDiff(now, date),
	};
}

function formatResetDay(date: Date): string {
	// Fixed English `Sep 05` — no `toLocaleDateString`, so the line reads the
	// same under every configured locale.
	return formatShortDate(date);
}

function formatReset(resetAtMs: number | undefined): string | undefined {
	const parts = describeReset(resetAtMs);
	if (!parts) return undefined;
	if (parts.sameDay) return parts.time;
	return `${parts.time} on ${formatResetDay(parts.date)}`;
}

/**
 * Format a reset timestamp for the compact status line as the time left in
 * one unit: `40m` under an hour, `5h` under a day, otherwise `2d`. The line
 * renders it as `resets in 5h`. A reset already in the past yields nothing.
 */
function formatResetTime(resetAtMs: number | undefined): string | undefined {
	if (!resetAtMs || !Number.isFinite(resetAtMs)) return undefined;
	const left = resetAtMs - Date.now();
	if (left <= 0) return undefined;
	const minutes = Math.max(1, Math.ceil(left / 60_000));
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.max(1, Math.round(left / 3_600_000));
	if (hours < 24) return `in ${hours}h`;
	return `in ${Math.max(1, Math.round(left / 86_400_000))}d`;
}

/**
 * Count calendar days between two dates, ignoring wall-clock length. Comparing
 * UTC-normalized year/month/day makes the count immune to DST transitions,
 * which make a seven-day gap span 167 or 169 hours.
 */
function calendarDayDiff(from: Date, to: Date): number {
	const fromDay = Date.UTC(
		from.getFullYear(),
		from.getMonth(),
		from.getDate(),
	);
	const toDay = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
	return Math.round((toDay - fromDay) / MS_PER_DAY);
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

function formatDetailsLimit(
	limit: CompactQuotaLimit,
	mode: QuotaDisplayMode,
): string {
	const label = sanitizeDisplayText(limit.label) ?? "quota";
	const percent = isPercent(limit.leftPercent)
		? formatNamedQuotaPercent(limit.leftPercent, mode)
		: "unavailable";
	const reset = formatReset(limit.resetAtMs);
	return reset ? `${label}: ${percent}, resets ${reset}` : `${label}: ${percent}`;
}

export function formatQuotaDetailsText(
	quota: CompactQuotaStatus,
	now = Date.now(),
	options: { maskEmail?: boolean; quotaDisplay?: QuotaDisplayMode } = {},
): string {
	if (quota.type === "loading") return "Quota is loading.";
	if (quota.type === "missing") return "No Codex OAuth account is configured.";
	if (quota.type === "unavailable") return "Quota is unavailable.";

	const lines: string[] = [];
	// The dialog has a full line to itself, so it always takes the longest form.
	const accountHint = formatAccountHints(quota, options.maskEmail)[0];
	const accountLabel = maskEmailsInText(quota.accountLabel, Boolean(options.maskEmail));
	if (accountLabel && accountHint) {
		lines.push(`Account: ${accountHint} (${accountLabel})`);
	} else if (accountLabel) {
		lines.push(`Account: ${accountLabel}`);
	} else if (accountHint) {
		lines.push(`Account: ${accountHint}`);
	}
	for (const limit of quota.limits) {
		lines.push(
			formatDetailsLimit(limit, options.quotaDisplay ?? DEFAULT_QUOTA_DISPLAY_MODE),
		);
	}
	// Named through formatPlanType like the stored copy, so one seat does not
	// print "Business" in codex-list and "team" here in the same session.
	const planLabel = formatPlanType(quota.planType);
	if (planLabel) lines.push(`Plan: ${planLabel}`);
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

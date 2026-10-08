/**
 * `codex-reset` tool — view and redeem banked Codex rate-limit reset credits.
 *
 * Closes the gap for users who cannot reach OpenAI's redemption UI (desktop
 * app / IDE extensions / Codex CLI `/usage`): the credits are granted per
 * account, and this plugin already holds the credentials needed to spend them.
 *
 * Redeeming is irreversible and spends a finite credit, so `action="consume"`
 * only issues the POST when `confirm` is `true`. A tool call has no interactive
 * y/N prompt, so confirmation is an explicit argument instead — an unconfirmed
 * consume renders the same preview a dry run does and changes nothing.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";

import {
	consumeCodexResetCredit,
	createRedeemRequestId,
	fetchCodexResetCredits,
	formatCodexResetConsumeResult,
	formatCodexResetCredit,
	parseCodexResetCredits,
	selectRedeemableCredit,
	type CodexResetConsumePayload,
	type CodexResetCredit,
	type CodexResetCreditsSummary,
} from "../codex-reset.js";
import {
	ensureCodexUsageAccessToken,
	fetchCodexUsage,
	formatUsageLimitSummary,
	formatUsageLimitTitle,
	hasUsageWindow,
	parseCodexUsagePayload,
	resolveCodexUsageAccountId,
	type CodexUsageSummary,
} from "../codex-usage.js";
import { getQuotaDisplay, loadPluginConfig } from "../config.js";
import type { QuotaDisplayMode } from "../quota-display.js";
import { loadAccounts, withAccountStorageTransaction } from "../storage.js";
import { clearUnchangedRecoveryState } from "../accounts/stale-state.js";
import { findAccountIndexByIdentity } from "./refresh-account.js";
import {
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
} from "../ui/format.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
import {
	TOOL_INCLUDE_SENSITIVE_DESCRIPTION,
	TOOL_OUTPUT_FORMAT_DESCRIPTION,
	TOOL_OUTPUT_FORMAT_VALUES,
} from "./args.js";
import {
	buildToolErrorEnvelope,
	sanitizeToolErrorMessage,
	withToolErrorEnvelope,
} from "./output.js";
import type { ToolContext } from "./index.js";

type CodexResetArgs = {
	action?: string;
	creditId?: string;
	confirm?: boolean;
	dryRun?: boolean;
	account?: number;
	format?: string;
	includeSensitive?: boolean;
};

function normalizeResetAction(action?: string): "status" | "consume" {
	if (action === undefined || action === "status") return "status";
	if (action === "consume") return "consume";
	throw new Error(
		`Invalid action "${action}". Expected "status" or "consume".`,
	);
}

/**
 * Resolve the 1-based `account` argument to a storage index.
 *
 * Defaults to the active Codex account, since credits are granted per account
 * and the one serving requests is the one whose windows the user wants reset.
 */
function resolveResetAccountIndex(
	accountCount: number,
	activeIndex: number,
	account?: number,
): number {
	if (account === undefined) return activeIndex;
	if (
		!Number.isInteger(account) ||
		account < 1 ||
		account > accountCount
	) {
		throw new Error(
			`Invalid account ${account}. Expected 1-${accountCount}.`,
		);
	}
	return account - 1;
}

function buildUsageLines(
	usage: CodexUsageSummary,
	mode: QuotaDisplayMode,
): string[] {
	const lines: string[] = [];
	for (const window of [usage.primary, usage.secondary]) {
		if (!hasUsageWindow(window)) continue;
		lines.push(
			`  ${formatUsageLimitTitle(window.windowMinutes)}: ${formatUsageLimitSummary(window, mode)}`,
		);
	}
	return lines;
}

/**
 * Baseline for every `action:"consume"` JSON payload: all consume branches
 * emit this exact key set so consumers see one stable schema whether the
 * redemption was previewed, skipped, failed, or completed. `redeemed` stays
 * `boolean | null` — `null` means the outcome is genuinely unknown (the POST
 * may have reached the backend).
 */
function emptyConsumeJsonPayload(): {
	redeemed: boolean | null;
	reason: string | null;
	credit: CodexResetCredit | null;
	availableCount: number;
	credits: CodexResetCredit[];
	blocksCleared: boolean;
	blocksClearError: string | null;
	result: {
		code: string | null;
		windowsReset: unknown;
		redeemedAt: string | null;
	} | null;
	planType: string | null;
	limits: CodexUsageSummary["limits"] | null;
	usageError: string | null;
	error: string | null;
	message: string | null;
} {
	return {
		redeemed: null,
		reason: null,
		credit: null,
		availableCount: 0,
		credits: [],
		blocksCleared: false,
		blocksClearError: null,
		result: null,
		planType: null,
		limits: null,
		usageError: null,
		error: null,
		message: null,
	};
}

function buildCreditLines(summary: CodexResetCreditsSummary): string[] {
	const lines = [
		`banked credits: ${summary.availableCount} available`,
	];
	for (const credit of summary.credits) {
		lines.push(`  ${formatCodexResetCredit(credit)}`);
		if (credit.title) lines.push(`      "${credit.title}"`);
	}
	if (summary.credits.length === 0) {
		lines.push("  (none granted)");
	}
	return lines;
}

export function createCodexResetTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		resolveActiveIndex,
		formatCommandAccountLabel,
		resolveMaskEmail,
		buildJsonAccountIdentity,
		invalidateAccountManagerCache,
	} = ctx;

	const definition = tool({
		description:
			"View banked Codex rate-limit reset credits, and redeem one to clear the current usage windows. Redeeming is irreversible and requires confirm=true.",
		args: {
			action: tool.schema
				.string()
				.optional()
				.describe(
					'"status" (default) lists banked credits and current usage. "consume" redeems one credit.',
				),
			creditId: tool.schema
				.string()
				.optional()
				.describe(
					"Redeem this specific credit id. Defaults to the first available credit.",
				),
			confirm: tool.schema
				.boolean()
				.optional()
				.describe(
					"Must be true for action=\"consume\" to actually redeem. Without it the redemption is only previewed.",
				),
			dryRun: tool.schema
				.boolean()
				.optional()
				.describe("Preview the redemption without spending the credit."),
			account: tool.schema
				.number()
				.optional()
				.describe(
					"1-based account number to act on. Defaults to the active Codex account.",
				),
			format: tool.schema
				.enum(TOOL_OUTPUT_FORMAT_VALUES)
				.optional()
				.describe(TOOL_OUTPUT_FORMAT_DESCRIPTION),
			includeSensitive: tool.schema
				.boolean()
				.optional()
				.describe(TOOL_INCLUDE_SENSITIVE_DESCRIPTION),
		},
		async execute({
			action,
			creditId,
			confirm,
			dryRun,
			account,
			format,
			includeSensitive,
		}: CodexResetArgs = {}) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const quotaDisplay = getQuotaDisplay(loadPluginConfig());
			const outputFormat = normalizeToolOutputFormat(format);
			const resetAction = normalizeResetAction(action);
			const includeSensitiveOutput = includeSensitive === true;

			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (outputFormat === "json") {
					// One stable schema per action: `status` always carries
					// availableCount/credits/planType/limits; `consume` additionally
					// carries the full consume key set so consumers never see a
					// branch-dependent shape.
					const base = {
						message:
							"No Codex accounts configured. Run: opencode auth login",
						action: resetAction,
						availableCount: 0,
						credits: [] as CodexResetCredit[],
						planType: null,
						limits: null,
					};
					return renderJsonOutput(
						resetAction === "consume"
							? {
									...emptyConsumeJsonPayload(),
									...base,
									redeemed: false,
									reason: "no-accounts",
								}
							: base,
					);
				}
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Codex reset"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			const activeIndex = resolveActiveIndex(storage, "codex");
			const index = resolveResetAccountIndex(
				storage.accounts.length,
				activeIndex,
				account,
			);
			const target = storage.accounts[index];
			if (!target) {
				throw new Error(`No account at position ${index + 1}.`);
			}
			const label = formatCommandAccountLabel(target, index, {
				peerAccounts: storage.accounts,
			});
			const displayLabel = formatCommandAccountLabel(target, index, {
				maskEmail,
				peerAccounts: storage.accounts,
			});
			const identity = buildJsonAccountIdentity(index, {
				includeSensitive: includeSensitiveOutput,
				account: target,
				label,
				peerAccounts: storage.accounts,
			});

			try {
				const credentials = await ensureCodexUsageAccessToken({
					storage,
					account: target,
				});
				if (credentials.persisted) invalidateAccountManagerCache();

				const accountId = resolveCodexUsageAccountId({
					account: target,
					accessToken: credentials.accessToken,
				});
				if (!accountId) throw new Error("Missing account id");

				const request = {
					accountId,
					accessToken: credentials.accessToken,
					organizationId: target.organizationId,
				};
				if (resetAction === "status") {
					// The two endpoints are independent, so overlap them rather than
					// paying two serial round-trips on every status check.
					const [creditsPayload, usagePayload] = await Promise.all([
						fetchCodexResetCredits(request),
						fetchCodexUsage(request),
					]);
					const summary = parseCodexResetCredits(creditsPayload);
					const usage = parseCodexUsagePayload(usagePayload, quotaDisplay);

					if (outputFormat === "json") {
						return renderJsonOutput({
							...identity,
							action: "status",
							message: null,
							availableCount: summary.availableCount,
							credits: summary.credits,
							planType: usage.planType,
							limits: usage.limits,
						});
					}
					const lines = ui.v2Enabled
						? [...formatUiHeader(ui, "Codex reset"), ""]
						: [];
					lines.push(`${displayLabel}:`);
					lines.push(...buildCreditLines(summary));
					lines.push("", "current usage:");
					lines.push(...buildUsageLines(usage, quotaDisplay));
					if (summary.availableCount > 0) {
						lines.push(
							"",
							'Redeem with: codex-reset action="consume" confirm=true',
						);
					}
					return lines.join("\n");
				}

				const summary = parseCodexResetCredits(
					await fetchCodexResetCredits(request),
				);
				const selection = selectRedeemableCredit(summary, creditId);
				if (selection.type !== "selected") {
					const message =
						selection.type === "not-found"
							? `No available credit with id ${selection.creditId}.`
							: "No available credits to redeem.";
					if (outputFormat === "json") {
						return renderJsonOutput({
							...emptyConsumeJsonPayload(),
							...identity,
							action: "consume",
							redeemed: false,
							reason: selection.type,
							message,
							availableCount: summary.availableCount,
							credits: summary.credits,
						});
					}
					return [`${displayLabel}:`, `  ${message}`].join("\n");
				}

				const credit = selection.credit;
				// A consume without explicit confirmation is a preview, not a
				// redemption: spending a credit cannot be undone, and a tool call
				// offers no interactive prompt to fall back on.
				const previewOnly = dryRun === true || confirm !== true;
				if (previewOnly) {
					const reason = dryRun === true ? "dry-run" : "unconfirmed";
					if (outputFormat === "json") {
						return renderJsonOutput({
							...emptyConsumeJsonPayload(),
							...identity,
							action: "consume",
							redeemed: false,
							reason,
							credit,
							availableCount: summary.availableCount,
							credits: summary.credits,
							message:
								reason === "dry-run"
									? "Dry run: credit not redeemed."
									: "Not redeemed. Pass confirm=true to redeem this credit.",
						});
					}
					return [
						`${displayLabel}:`,
						"  about to redeem:",
						`    ${formatCodexResetCredit(credit)}`,
						reason === "dry-run"
							? "  dry run: credit not redeemed."
							: '  not redeemed. Re-run with confirm=true to redeem this credit.',
					].join("\n");
				}

				const recoverySnapshot = { ...target, rateLimitResetTimes: { ...target.rateLimitResetTimes } };
				let result: CodexResetConsumePayload;
				try {
					result = await consumeCodexResetCredit({
						...request,
						creditId: credit.id,
						redeemRequestId: createRedeemRequestId(credit.id),
					});
					ctx.onResetRedeemed?.();
				} catch (error) {
					// The POST may have reached the backend before the failure
					// (timeout, dropped response), so the redemption outcome is
					// genuinely unknown — reporting `redeemed: false` here could
					// send the user to spend a second credit. The idempotency key
					// is derived from the credit id, so retrying the SAME credit
					// is safe; the guidance below is about picking a different one.
					// Upstream error text is masked + truncated — it can carry
					// credential-shaped fragments from the request/response path.
					const consumeError = sanitizeToolErrorMessage(
						error instanceof Error ? error.message : String(error),
					);
					if (outputFormat === "json") {
						// Same envelope semantics as every other codex-reset JSON
						// failure: `error` is the machine code, `message` the prose.
						const envelope = buildToolErrorEnvelope("codex-reset", error);
						return renderJsonOutput({
							...emptyConsumeJsonPayload(),
							...identity,
							ok: envelope.ok,
							tool: envelope.tool,
							action: "consume",
							redeemed: null,
							reason: "consume-failed",
							credit,
							availableCount: summary.availableCount,
							credits: summary.credits,
							error: envelope.error,
							retryable: envelope.retryable,
							nextAction: envelope.nextAction,
							path: envelope.path,
							message: `${consumeError} — the consume request failed but may have reached the backend. Run codex-reset (status) and check whether ${credit.id} is still available before redeeming another credit.`,
						});
					}
					return [
						`${displayLabel}:`,
						`  Error: ${consumeError}`,
						"  redemption outcome unknown: the request may have reached the backend.",
						`  Run codex-reset (status) and check whether ${credit.id} is still available before redeeming another credit.`,
					].join("\n");
				}

				// Past this point the credit is spent and cannot be recovered. The
				// usage refresh below is a courtesy read, so its failure must never
				// reach the outer catch: reporting `redeemed: false` for a credit the
				// server already consumed would send the user to redeem another one.
				let blocksCleared = false;
				let clearedSnapshot: typeof recoverySnapshot | undefined;
				let blocksClearError: string | undefined;
				try {
					blocksCleared = await withAccountStorageTransaction(async (current, persist) => {
						if (!current) throw new Error("Account storage is unavailable");
						const recordIndex = findAccountIndexByIdentity(current.accounts, {
							organizationId: target.organizationId,
							accountId: target.accountId,
							accountUserId: target.accountUserId,
							refreshToken: target.refreshToken,
						});
						const record = current.accounts[recordIndex];
						if (!record || record.enabled === false) return false;
						const cleared = clearUnchangedRecoveryState(record, recoverySnapshot);
						if (!cleared) return false;
						await persist(current);
						clearedSnapshot = { ...recoverySnapshot, coolingDownUntil: undefined,
							quotaExhaustedUntil: undefined, quotaExhaustedStampAt: undefined,
							...cleared, cooldownReason: cleared.cooldownReason ? recoverySnapshot.cooldownReason : undefined,
							rateLimitResetTimes: cleared.rateLimitResetTimes ?? {} };
						return true;
					});
					invalidateAccountManagerCache(clearedSnapshot ? [clearedSnapshot] : undefined);
				} catch {
					blocksCleared = false;
					blocksClearError = "could not clear local rate-limit/quota markers";
				}

				let usageAfter: CodexUsageSummary | undefined;
				let usageError: string | undefined;
				try {
					usageAfter = parseCodexUsagePayload(
						await fetchCodexUsage(request),
						quotaDisplay,
					);
				} catch (error) {
					usageError = sanitizeToolErrorMessage(
						error instanceof Error ? error.message : String(error),
					);
				}

				if (outputFormat === "json") {
					// Report the post-consume inventory: `summary` was fetched before
					// the redeem POST, so echoing it back would present the spent
					// credit as still available and invite a second redemption.
					const remainingCredits = summary.credits.filter(
						(entry) => entry.id !== credit.id,
					);
					// Exactly one credit was redeemed — subtract one, not the number
					// of rows removed: a malformed upstream payload can carry the
					// same id twice, and subtracting the row count would
					// under-report what remains.
					return renderJsonOutput({
						...emptyConsumeJsonPayload(),
						...identity,
						action: "consume",
						redeemed: true,
						reason: "redeemed",
						blocksCleared,
						blocksClearError: blocksClearError ?? null,
						credit,
						availableCount: Math.max(0, summary.availableCount - 1),
						credits: remainingCredits,
						result: {
							code: result.code ?? null,
							windowsReset: result.windows_reset ?? null,
							redeemedAt: result.credit?.redeemed_at ?? null,
						},
						planType: usageAfter?.planType ?? null,
						limits: usageAfter?.limits ?? null,
						usageError: usageError ?? null,
					});
				}
				return [
					`${displayLabel}:`,
					`  redeemed ${credit.id}`,
					`  ${formatCodexResetConsumeResult(result)}`,
					...(blocksCleared ? ["  cleared local rate-limit/quota markers"] : []),
					...(blocksClearError ? [`  Note: ${blocksClearError}; the credit was redeemed.`] : []),
					"",
					...(usageAfter
						? ["new usage:", ...buildUsageLines(usageAfter, quotaDisplay)]
						: [
								`new usage: unavailable (${usageError ?? "unknown"})`,
								"The credit was redeemed. Run codex-reset to re-read usage.",
							]),
				].join("\n");
			} catch (error) {
				// The shared error envelope merges with the account identity so the
				// consumer still knows which account the request targeted, and the
				// fields keep the shared envelope's meaning — `error` is the machine
				// code, `message` the masked prose — so callers parse one schema.
				const message = sanitizeToolErrorMessage(
					error instanceof Error ? error.message : String(error),
				);
				if (outputFormat === "json") {
					const envelope = buildToolErrorEnvelope("codex-reset", error);
					return renderJsonOutput({
						...emptyConsumeJsonPayload(),
						...identity,
						ok: envelope.ok,
						tool: envelope.tool,
						error: envelope.error,
						message: envelope.message,
						retryable: envelope.retryable,
						nextAction: envelope.nextAction,
						path: envelope.path,
						action: resetAction,
						redeemed: resetAction === "consume" ? false : null,
						reason: resetAction === "consume" ? "request-failed" : null,
					});
				}
				if (ui.v2Enabled) {
					return [
						formatUiItem(ui, displayLabel),
						`  ${formatUiKeyValue(ui, "Error", message, "danger")}`,
					].join("\n");
				}
				return [`${displayLabel}:`, `  Error: ${message}`].join(
					"\n",
				);
			}
		},
	});
	return withToolErrorEnvelope("codex-reset", definition);
}

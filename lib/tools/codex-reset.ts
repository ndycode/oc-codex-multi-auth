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
import { loadAccounts } from "../storage.js";
import {
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
} from "../ui/format.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
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

function buildUsageLines(usage: CodexUsageSummary): string[] {
	const lines: string[] = [];
	for (const window of [usage.primary, usage.secondary]) {
		if (!hasUsageWindow(window)) continue;
		lines.push(
			`  ${formatUsageLimitTitle(window.windowMinutes)}: ${formatUsageLimitSummary(window)}`,
		);
	}
	return lines;
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

	return tool({
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
				.string()
				.optional()
				.describe('Output format: "text" (default) or "json".'),
			includeSensitive: tool.schema
				.boolean()
				.optional()
				.describe(
					"Include raw account labels, emails, and account IDs in JSON output. Defaults to false.",
				),
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
			const outputFormat = normalizeToolOutputFormat(format);
			const resetAction = normalizeResetAction(action);
			const includeSensitiveOutput = includeSensitive === true;

			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (outputFormat === "json") {
					return renderJsonOutput({
						message: "No Codex accounts configured. Run: opencode auth login",
						action: resetAction,
						credits: [],
						availableCount: 0,
					});
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
			const label = formatCommandAccountLabel(target, index);
			const displayLabel = formatCommandAccountLabel(target, index, {
				maskEmail,
			});
			const identity = buildJsonAccountIdentity(index, {
				includeSensitive: includeSensitiveOutput,
				account: target,
				label,
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
					const usage = parseCodexUsagePayload(usagePayload);

					if (outputFormat === "json") {
						return renderJsonOutput({
							...identity,
							action: "status",
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
					lines.push(...buildUsageLines(usage));
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
							...identity,
							action: "consume",
							redeemed: false,
							reason,
							credit,
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

				const result = await consumeCodexResetCredit({
					...request,
					creditId: credit.id,
					redeemRequestId: createRedeemRequestId(),
				});

				// Past this point the credit is spent and cannot be recovered. The
				// usage refresh below is a courtesy read, so its failure must never
				// reach the outer catch: reporting `redeemed: false` for a credit the
				// server already consumed would send the user to redeem another one.
				let usageAfter: CodexUsageSummary | undefined;
				let usageError: string | undefined;
				try {
					usageAfter = parseCodexUsagePayload(await fetchCodexUsage(request));
				} catch (error) {
					usageError = error instanceof Error ? error.message : String(error);
				}

				if (outputFormat === "json") {
					return renderJsonOutput({
						...identity,
						action: "consume",
						redeemed: true,
						credit,
						result: {
							code: result.code ?? null,
							windowsReset: result.windows_reset ?? null,
							redeemedAt: result.credit?.redeemed_at ?? null,
						},
						planType: usageAfter?.planType ?? null,
						limits: usageAfter?.limits ?? null,
						usageError: usageError ? usageError.slice(0, 160) : null,
					});
				}
				return [
					`${displayLabel}:`,
					`  redeemed ${credit.id}`,
					`  ${formatCodexResetConsumeResult(result)}`,
					"",
					...(usageAfter
						? ["new usage:", ...buildUsageLines(usageAfter)]
						: [
								`new usage: unavailable (${usageError?.slice(0, 160)})`,
								"The credit was redeemed. Run codex-reset to re-read usage.",
							]),
				].join("\n");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (outputFormat === "json") {
					return renderJsonOutput({
						...identity,
						action: resetAction,
						redeemed: false,
						error: message.slice(0, 160),
					});
				}
				if (ui.v2Enabled) {
					return [
						formatUiItem(ui, displayLabel),
						`  ${formatUiKeyValue(ui, "Error", message.slice(0, 160), "danger")}`,
					].join("\n");
				}
				return [`${displayLabel}:`, `  Error: ${message.slice(0, 160)}`].join(
					"\n",
				);
			}
		},
	});
}

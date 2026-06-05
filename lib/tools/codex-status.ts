/**
 * `codex-status` tool — detailed per-account status and rate limits.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts } from "../storage.js";
import { AccountManager, formatCooldown, formatWaitTime } from "../accounts.js";
import { MODEL_FAMILIES } from "../prompts/codex.js";
import { recommendBeginnerNextAction } from "../ui/beginner.js";
import {
	buildTableHeader,
	buildTableRow,
	type TableOptions,
} from "../table-formatter.js";
import {
	formatUiBadge,
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
	formatUiSection,
} from "../ui/format.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
import type { ToolContext } from "./index.js";

export function createCodexStatusTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		resolveActiveIndex,
		formatCommandAccountLabel,
		resolveMaskEmail,
		formatRateLimitEntry,
		getRateLimitResetTimeForFamily,
		buildJsonAccountIdentity,
		buildRoutingVisibilitySnapshot,
		appendRoutingVisibilityText,
		appendRoutingVisibilityUi,
		toBeginnerAccountSnapshots,
		getBeginnerRuntimeSnapshot,
		runtimeMetrics,
		cachedAccountManagerRef,
	} = ctx;
	return tool({
		description:
			"Show detailed status of Codex accounts and rate limits.",
		args: {
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
			format,
			includeSensitive,
		}: {
			format?: string;
			includeSensitive?: boolean;
		} = {}) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const outputFormat = normalizeToolOutputFormat(format);
			const includeSensitiveOutput = includeSensitive === true;
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (outputFormat === "json") {
					return renderJsonOutput({
						message:
							"No Codex accounts configured. Run: opencode auth login",
						totalAccounts: 0,
						accounts: [],
						activeIndexByFamily: {},
						rateLimitsByModelFamily: [],
						routingVisibility: buildRoutingVisibilitySnapshot(),
						recommendedNextAction: "Run opencode auth login",
					});
				}
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Account status"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			const now = Date.now();
			const activeIndex = resolveActiveIndex(storage, "codex");
			const explainabilityFamily =
				runtimeMetrics.lastSelectionSnapshot?.family ?? "codex";
			const explainabilityModel =
				runtimeMetrics.lastSelectionSnapshot?.effectiveModel ??
				runtimeMetrics.lastSelectionSnapshot?.model ??
				undefined;
			const managerForExplainability =
				cachedAccountManagerRef.current ?? (await AccountManager.loadFromDisk());
			const explainability =
				managerForExplainability.getSelectionExplainability(
					explainabilityFamily,
					explainabilityModel,
					now,
				);
			const selectionQuotaKey = explainabilityModel
				? `${explainabilityFamily}:${explainabilityModel}`
				: explainabilityFamily;
			const routingVisibility = buildRoutingVisibilitySnapshot({
				modelFamily: explainabilityFamily,
				effectiveModel: explainabilityModel ?? null,
				quotaKey: selectionQuotaKey,
				selectedAccountIndex: activeIndex,
				selectionExplainability: explainability,
			});
			const explainabilityByIndex = new Map(
				explainability.map((entry) => [entry.index, entry]),
			);
			const recommendedNextAction = recommendBeginnerNextAction({
				accounts: toBeginnerAccountSnapshots(storage, activeIndex, now),
				now,
				runtime: getBeginnerRuntimeSnapshot(),
			});
			if (outputFormat === "json") {
				return renderJsonOutput({
					totalAccounts: storage.accounts.length,
					selectionView: {
						modelFamily: explainabilityFamily,
						effectiveModel: explainabilityModel ?? null,
						label: explainabilityModel
							? `${explainabilityFamily}:${explainabilityModel}`
							: explainabilityFamily,
					},
					accounts: storage.accounts.map((account, index) => ({
						...buildJsonAccountIdentity(index, {
							includeSensitive: includeSensitiveOutput,
							account,
						}),
						enabled: account.enabled !== false,
						isActive: index === activeIndex,
						rateLimit: formatRateLimitEntry(account, now) ?? null,
						cooldown: formatCooldown(account, now) ?? null,
						lastUsedAgeMs:
							typeof account.lastUsed === "number" && account.lastUsed > 0
								? Math.max(0, now - account.lastUsed)
								: null,
					})),
					activeIndexByFamily: Object.fromEntries(
						MODEL_FAMILIES.map((family) => [
							family,
							typeof storage.activeIndexByFamily?.[family] === "number"
								? (storage.activeIndexByFamily?.[family] ?? 0) + 1
								: null,
						]),
					),
					rateLimitsByModelFamily: storage.accounts.map((account, index) => ({
						...buildJsonAccountIdentity(index, {
							includeSensitive: includeSensitiveOutput,
							account,
						}),
						families: Object.fromEntries(
							MODEL_FAMILIES.map((family) => {
								const resetAt = getRateLimitResetTimeForFamily(
									account,
									now,
									family,
								);
								return [
									family,
									typeof resetAt === "number"
										? {
												resetAtMs: resetAt,
												wait: formatWaitTime(resetAt - now),
											}
										: null,
								];
							}),
						),
					})),
					routingVisibility,
					recommendedNextAction,
				});
			}
			if (ui.v2Enabled) {
				const lines: string[] = [
					...formatUiHeader(ui, "Account status"),
					formatUiKeyValue(ui, "Total", String(storage.accounts.length)),
					formatUiKeyValue(
						ui,
						"Selection view",
						explainabilityModel
							? `${explainabilityFamily}:${explainabilityModel}`
							: explainabilityFamily,
						"muted",
					),
					"",
					...formatUiSection(ui, "Accounts"),
				];

				storage.accounts.forEach((account, index) => {
					const label = formatCommandAccountLabel(account, index, { maskEmail });
					const badges: string[] = [];
					if (index === activeIndex)
						badges.push(formatUiBadge(ui, "active", "accent"));
					if (account.enabled === false)
						badges.push(formatUiBadge(ui, "disabled", "danger"));
					const rateLimit = formatRateLimitEntry(account, now) ?? "none";
					const cooldown = formatCooldown(account, now) ?? "none";
					if (rateLimit !== "none")
						badges.push(formatUiBadge(ui, "rate-limited", "warning"));
					if (cooldown !== "none")
						badges.push(formatUiBadge(ui, "cooldown", "warning"));
					if (badges.length === 0)
						badges.push(formatUiBadge(ui, "ok", "success"));

					lines.push(
						formatUiItem(ui, `${label} ${badges.join(" ")}`.trim()),
					);
					lines.push(
						`  ${formatUiKeyValue(ui, "rate limit", rateLimit, rateLimit === "none" ? "muted" : "warning")}`,
					);
					lines.push(
						`  ${formatUiKeyValue(ui, "cooldown", cooldown, cooldown === "none" ? "muted" : "warning")}`,
					);
				});

				lines.push("");
				lines.push(...formatUiSection(ui, "Active index by model family"));
				for (const family of MODEL_FAMILIES) {
					const idx = storage.activeIndexByFamily?.[family];
					const familyIndexLabel =
						typeof idx === "number" && Number.isFinite(idx)
							? String(idx + 1)
							: "-";
					lines.push(formatUiItem(ui, `${family}: ${familyIndexLabel}`));
				}

				lines.push("");
				lines.push(
					...formatUiSection(
						ui,
						"Rate limits by model family (per account)",
					),
				);
				storage.accounts.forEach((account, index) => {
					const statuses = MODEL_FAMILIES.map((family) => {
						const resetAt = getRateLimitResetTimeForFamily(
							account,
							now,
							family,
						);
						if (typeof resetAt !== "number") return `${family}=ok`;
						return `${family}=${formatWaitTime(resetAt - now)}`;
					});
					lines.push(
						formatUiItem(
							ui,
							`Account ${index + 1}: ${statuses.join(" | ")}`,
						),
					);
				});

				lines.push("");
				appendRoutingVisibilityUi(ui, lines, routingVisibility);

				lines.push("");
				lines.push(...formatUiSection(ui, "Selection explainability"));
				for (const entry of explainability) {
					const state = entry.eligible ? "eligible" : "blocked";
					const reasons = entry.reasons.join(", ");
					lines.push(
						formatUiItem(
							ui,
							`Account ${entry.index + 1}: ${state} | health=${Math.round(entry.healthScore)} | tokens=${entry.tokensAvailable.toFixed(1)} | ${reasons}`,
						),
					);
				}

				lines.push("");
				lines.push(...formatUiSection(ui, "Recommended next step"));
				lines.push(formatUiItem(ui, recommendedNextAction, "accent"));

				return lines.join("\n");
			}

			const statusTableOptions: TableOptions = {
				columns: [
					{ header: "#", width: 3 },
					{ header: "Label", width: 42 },
					{ header: "Active", width: 6 },
					{ header: "Rate Limit", width: 16 },
					{ header: "Cooldown", width: 16 },
					{ header: "Last Used", width: 16 },
				],
			};

			const lines: string[] = [
				`Account Status (${storage.accounts.length} total):`,
				"",
				...buildTableHeader(statusTableOptions),
			];

			storage.accounts.forEach((account, index) => {
				const label = formatCommandAccountLabel(account, index, { maskEmail });
				const active = index === activeIndex ? "Yes" : "No";
				const rateLimit = formatRateLimitEntry(account, now) ?? "None";
				const cooldown = formatCooldown(account, now) ?? "No";
				const lastUsed =
					typeof account.lastUsed === "number" && account.lastUsed > 0
						? `${formatWaitTime(now - account.lastUsed)} ago`
						: "-";

				lines.push(
					buildTableRow(
						[
							String(index + 1),
							label,
							active,
							rateLimit,
							cooldown,
							lastUsed,
						],
						statusTableOptions,
					),
				);
			});

			lines.push("");
			lines.push("Active index by model family:");
			for (const family of MODEL_FAMILIES) {
				const idx = storage.activeIndexByFamily?.[family];
				const familyIndexLabel =
					typeof idx === "number" && Number.isFinite(idx)
						? String(idx + 1)
						: "-";
				lines.push(`  ${family}: ${familyIndexLabel}`);
			}

			lines.push("");
			lines.push("Rate limits by model family (per account):");
			storage.accounts.forEach((account, index) => {
				const statuses = MODEL_FAMILIES.map((family) => {
					const resetAt = getRateLimitResetTimeForFamily(
						account,
						now,
						family,
					);
					if (typeof resetAt !== "number") return `${family}=ok`;
					return `${family}=${formatWaitTime(resetAt - now)}`;
				});
				lines.push(`  Account ${index + 1}: ${statuses.join(" | ")}`);
			});

			lines.push("");
			appendRoutingVisibilityText(lines, routingVisibility);

			lines.push("");
			lines.push(
				`Selection explainability (${
					explainabilityModel
						? `${explainabilityFamily}:${explainabilityModel}`
						: explainabilityFamily
				}):`,
			);
			for (const [index] of storage.accounts.entries()) {
				const details = explainabilityByIndex.get(index);
				if (!details) continue;
				const state = details.eligible ? "eligible" : "blocked";
				lines.push(
					`  Account ${index + 1}: ${state} | health=${Math.round(details.healthScore)} | tokens=${details.tokensAvailable.toFixed(1)} | ${details.reasons.join(", ")}`,
				);
			}

			lines.push("");
			lines.push(`Recommended next step: ${recommendedNextAction}`);

			return lines.join("\n");
		},
	});
}

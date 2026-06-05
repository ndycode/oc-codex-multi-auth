/**
 * `codex-list` tool — list all Codex OAuth accounts.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { getStoragePath, loadAccounts } from "../storage.js";
import { formatCooldown } from "../accounts.js";
import { buildTableHeader, buildTableRow, type TableOptions } from "../table-formatter.js";
import {
	formatUiBadge,
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
	formatUiSection,
	paintUiText,
} from "../ui/format.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
import type { ToolContext } from "./index.js";

export function createCodexListTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		resolveActiveIndex,
		formatCommandAccountLabel,
		resolveMaskEmail,
		formatRateLimitEntry,
		buildJsonAccountIdentity,
	} = ctx;
	return tool({
		description:
			"List all Codex OAuth accounts and the current active index.",
		args: {
			tag: tool.schema
				.string()
				.optional()
				.describe("Optional tag filter (e.g., work, personal, team-a)."),
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
			tag,
			format,
			includeSensitive,
		}: {
			tag?: string;
			format?: string;
			includeSensitive?: boolean;
		} = {}) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const storage = await loadAccounts();
			const storePath = getStoragePath();
			const outputFormat = normalizeToolOutputFormat(format);
			const includeSensitiveOutput = includeSensitive === true;
			const normalizedTag = tag?.trim().toLowerCase() ?? "";
			const commandHints = [
				"opencode auth login",
				"codex-status",
				"codex-dashboard",
				"codex-metrics",
				"codex-doctor",
				"codex-setup",
				"codex-next",
				"codex-label",
				"codex-tag",
				"codex-note",
				"codex-help",
			];

			if (!storage || storage.accounts.length === 0) {
				if (outputFormat === "json") {
					return renderJsonOutput({
						message:
							"No Codex accounts configured. Run: opencode auth login",
						storagePath: storePath,
						filterTag: normalizedTag || null,
						totalAccounts: 0,
						totalStoredAccounts: 0,
						activeIndex: null,
						accounts: [],
						commands: commandHints,
					});
				}
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Codex accounts"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
						formatUiItem(ui, "Setup checklist: codex-setup"),
						formatUiItem(ui, "Command guide: codex-help"),
						formatUiKeyValue(ui, "Storage", storePath, "muted"),
					].join("\n");
				}
				return [
					"No Codex accounts configured.",
					"",
					"Add accounts:",
					"  opencode auth login",
					"  codex-setup",
					"  codex-help",
					"",
					`Storage: ${storePath}`,
				].join("\n");
			}

			const now = Date.now();
			const activeIndex = resolveActiveIndex(storage, "codex");
			const filteredEntries = storage.accounts
				.map((account, index) => ({ account, index }))
				.filter(({ account }) => {
					if (!normalizedTag) return true;
					const tags = Array.isArray(account.accountTags)
						? account.accountTags.map((entry) => entry.trim().toLowerCase())
						: [];
					return tags.includes(normalizedTag);
				});
			if (normalizedTag && filteredEntries.length === 0) {
				if (outputFormat === "json") {
					return renderJsonOutput({
						message: `No accounts found for tag: ${normalizedTag}`,
						storagePath: storePath,
						filterTag: normalizedTag,
						totalAccounts: 0,
						totalStoredAccounts: storage.accounts.length,
						activeIndex: activeIndex + 1,
						accounts: [],
						commands: commandHints,
					});
				}
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Codex accounts"),
						"",
						formatUiItem(
							ui,
							`No accounts found for tag: ${normalizedTag}`,
							"warning",
						),
						formatUiItem(
							ui,
							'Use codex-tag index=2 tags="work,team-a" to add tags.',
							"accent",
						),
					].join("\n");
				}
				return `No accounts found for tag: ${normalizedTag}\n\nUse codex-tag index=2 tags="work,team-a" to add tags.`;
			}
			if (outputFormat === "json") {
				return renderJsonOutput({
					totalAccounts: filteredEntries.length,
					totalStoredAccounts: storage.accounts.length,
					activeIndex: activeIndex + 1,
					filterTag: normalizedTag || null,
					storagePath: storePath,
					accounts: filteredEntries.map(({ account, index }) => {
						const rateLimit = formatRateLimitEntry(account, now);
						const cooldown = formatCooldown(account, now);
						const statuses: string[] = [];
						if (index === activeIndex) statuses.push("active");
						if (account.enabled === false) statuses.push("disabled");
						if (rateLimit) statuses.push("rate-limited");
						if (cooldown) statuses.push("cooldown");
						if (statuses.length === 0) statuses.push("ok");
						return {
							...buildJsonAccountIdentity(index, {
								includeSensitive: includeSensitiveOutput,
								account,
							}),
							enabled: account.enabled !== false,
							isActive: index === activeIndex,
							rateLimit: rateLimit ?? null,
							cooldown: cooldown ?? null,
							tags: Array.isArray(account.accountTags)
								? [...account.accountTags]
								: [],
							note: account.accountNote ?? null,
							statuses,
						};
					}),
					commands: commandHints,
				});
			}
			if (ui.v2Enabled) {
				const lines: string[] = [
					...formatUiHeader(ui, "Codex accounts"),
					formatUiKeyValue(ui, "Total", String(filteredEntries.length)),
					normalizedTag
						? formatUiKeyValue(ui, "Filter tag", normalizedTag, "accent")
						: formatUiKeyValue(ui, "Filter tag", "none", "muted"),
					formatUiKeyValue(ui, "Storage", storePath, "muted"),
					"",
					...formatUiSection(ui, "Accounts"),
				];

				filteredEntries.forEach(({ account, index }) => {
					const label = formatCommandAccountLabel(account, index, { maskEmail });
					const badges: string[] = [];
					if (index === activeIndex)
						badges.push(formatUiBadge(ui, "current", "accent"));
					if (account.enabled === false)
						badges.push(formatUiBadge(ui, "disabled", "danger"));
					const rateLimit = formatRateLimitEntry(account, now);
					if (rateLimit)
						badges.push(formatUiBadge(ui, "rate-limited", "warning"));
					if (
						typeof account.coolingDownUntil === "number" &&
						account.coolingDownUntil > now
					) {
						badges.push(formatUiBadge(ui, "cooldown", "warning"));
					}
					if (badges.length === 0) {
						badges.push(formatUiBadge(ui, "ok", "success"));
					}

					lines.push(
						formatUiItem(ui, `${label} ${badges.join(" ")}`.trim()),
					);
					if (rateLimit) {
						lines.push(
							`  ${paintUiText(ui, `rate limit: ${rateLimit}`, "muted")}`,
						);
					}
				});

				lines.push("");
				lines.push(...formatUiSection(ui, "Commands"));
				lines.push(
					formatUiItem(ui, "Add account: opencode auth login", "accent"),
				);
				lines.push(formatUiItem(ui, "Switch account: codex-switch index=2"));
				lines.push(formatUiItem(ui, "Detailed status: codex-status"));
				lines.push(formatUiItem(ui, "Live dashboard: codex-dashboard"));
				lines.push(formatUiItem(ui, "Runtime metrics: codex-metrics"));
				lines.push(
					formatUiItem(
						ui,
						'Set account tags: codex-tag index=2 tags="work,team-a"',
					),
				);
				lines.push(
					formatUiItem(
						ui,
						'Set account note: codex-note index=2 note="weekday primary"',
					),
				);
				lines.push(formatUiItem(ui, "Doctor checks: codex-doctor"));
				lines.push(formatUiItem(ui, "Onboarding checklist: codex-setup"));
				lines.push(
					formatUiItem(ui, "Guided setup wizard: codex-setup --wizard"),
				);
				lines.push(formatUiItem(ui, "Best next action: codex-next"));
				lines.push(
					formatUiItem(
						ui,
						'Rename account label: codex-label index=2 label="Work"',
					),
				);
				lines.push(formatUiItem(ui, "Command guide: codex-help"));
				return lines.join("\n");
			}

			const listTableOptions: TableOptions = {
				columns: [
					{ header: "#", width: 3 },
					{ header: "Label", width: 42 },
					{ header: "Status", width: 20 },
				],
			};

			const lines: string[] = [
				`Codex Accounts (${filteredEntries.length}):`,
				"",
				...buildTableHeader(listTableOptions),
			];

			filteredEntries.forEach(({ account, index }) => {
				const label = formatCommandAccountLabel(account, index, { maskEmail });
				const statuses: string[] = [];
				const rateLimit = formatRateLimitEntry(account, now);
				if (index === activeIndex) statuses.push("active");
				if (rateLimit) statuses.push("rate-limited");
				if (
					typeof account.coolingDownUntil === "number" &&
					account.coolingDownUntil > now
				) {
					statuses.push("cooldown");
				}
				const statusText =
					statuses.length > 0 ? statuses.join(", ") : "ok";
				lines.push(
					buildTableRow(
						[String(index + 1), label, statusText],
						listTableOptions,
					),
				);
			});

			lines.push("");
			lines.push(`Storage: ${storePath}`);
			if (normalizedTag) {
				lines.push(`Filter tag: ${normalizedTag}`);
			}
			lines.push("");
			lines.push("Commands:");
			lines.push("  - Add account: opencode auth login");
			lines.push("  - Switch account: codex-switch");
			lines.push("  - Status details: codex-status");
			lines.push("  - Live dashboard: codex-dashboard");
			lines.push("  - Runtime metrics: codex-metrics");
			lines.push("  - Set account tags: codex-tag");
			lines.push("  - Set account note: codex-note");
			lines.push("  - Doctor checks: codex-doctor");
			lines.push("  - Setup checklist: codex-setup");
			lines.push("  - Guided setup wizard: codex-setup --wizard");
			lines.push("  - Best next action: codex-next");
			lines.push("  - Rename account label: codex-label");
			lines.push("  - Command guide: codex-help");

			return lines.join("\n");
		},
	});
}

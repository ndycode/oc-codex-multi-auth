/**
 * `codex-label` tool — set or clear per-account display label.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts, saveAccounts } from "../storage.js";
import { AccountManager } from "../accounts.js";
import { logWarn } from "../logger.js";
import {
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
} from "../ui/format.js";
import type { ToolContext } from "./index.js";

export function createCodexLabelTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		promptAccountIndexSelection,
		supportsInteractiveMenus,
		formatCommandAccountLabel,
		resolveMaskEmail,
		getStatusMarker,
		cachedAccountManagerRef,
		accountManagerPromiseRef,
	} = ctx;
	return tool({
		description:
			"Set or clear a beginner-friendly display label for an account (interactive picker when index is omitted).",
		args: {
			index: tool.schema
				.number()
				.optional()
				.describe(
					"Account number to update (1-based, e.g., 1 for first account)",
				),
			label: tool.schema
				.string()
				.describe(
					"Display label. Use an empty string to clear (e.g., Work, Personal, Team A)",
				),
		},
		async execute({ index, label }: { index?: number; label: string }) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Set account label"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
						formatUiItem(ui, "Run: opencode auth login", "accent"),
					].join("\n");
				}
				return "No Codex accounts configured. Run: opencode auth login";
			}

			let resolvedIndex = index;
			if (resolvedIndex === undefined) {
				const selectedIndex = await promptAccountIndexSelection(
					ui,
					storage,
					"Set account label",
				);
				if (selectedIndex === null) {
					if (supportsInteractiveMenus()) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Set account label"),
								"",
								formatUiItem(ui, "No account selected.", "warning"),
								formatUiItem(
									ui,
									'Run again and pick an account, or pass codex-label index=2 label="Work".',
									"muted",
								),
							].join("\n");
						}
						return "No account selected.";
					}
					if (ui.v2Enabled) {
						return [
							...formatUiHeader(ui, "Set account label"),
							"",
							formatUiItem(ui, "Missing account number.", "warning"),
							formatUiItem(
								ui,
								'Use: codex-label index=2 label="Work"',
								"accent",
							),
						].join("\n");
					}
					return 'Missing account number. Use: codex-label index=2 label="Work"';
				}
				resolvedIndex = selectedIndex + 1;
			}

			const targetIndex = Math.floor((resolvedIndex ?? 0) - 1);
			if (
				!Number.isFinite(targetIndex) ||
				targetIndex < 0 ||
				targetIndex >= storage.accounts.length
			) {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Set account label"),
						"",
						formatUiItem(
							ui,
							`Invalid account number: ${resolvedIndex}`,
							"danger",
						),
						formatUiKeyValue(
							ui,
							"Valid range",
							`1-${storage.accounts.length}`,
							"muted",
						),
					].join("\n");
				}
				return `Invalid account number: ${resolvedIndex}\n\nValid range: 1-${storage.accounts.length}`;
			}

			const normalizedLabel = (label ?? "").trim().replace(/\s+/g, " ");
			if (normalizedLabel.length > 60) {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Set account label"),
						"",
						formatUiItem(
							ui,
							"Label is too long (max 60 characters).",
							"danger",
						),
					].join("\n");
				}
				return "Label is too long (max 60 characters).";
			}

			const account = storage.accounts[targetIndex];
			if (!account) {
				return `Account ${resolvedIndex} not found.`;
			}

			const previousLabel = account.accountLabel?.trim() ?? "";
			if (normalizedLabel.length === 0) {
				delete account.accountLabel;
			} else {
				account.accountLabel = normalizedLabel;
			}

			try {
				await saveAccounts(storage);
			} catch (saveError) {
				logWarn("Failed to save account label update", {
					error: String(saveError),
				});
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Set account label"),
						"",
						formatUiItem(
							ui,
							"Label updated in memory but failed to persist.",
							"danger",
						),
					].join("\n");
				}
				return "Label updated in memory but failed to persist. Changes may be lost on restart.";
			}

			if (cachedAccountManagerRef.current) {
				const reloadedManager = await AccountManager.loadFromDisk();
				cachedAccountManagerRef.current = reloadedManager;
				accountManagerPromiseRef.current = Promise.resolve(reloadedManager);
			}

			const accountLabel = formatCommandAccountLabel(account, targetIndex, { maskEmail });
			if (ui.v2Enabled) {
				const statusText =
					normalizedLabel.length === 0
						? `Cleared label for ${accountLabel}`
						: `Set label for ${accountLabel} to "${normalizedLabel}"`;
				const previousText =
					previousLabel.length > 0
						? formatUiKeyValue(ui, "Previous label", previousLabel, "muted")
						: formatUiKeyValue(ui, "Previous label", "none", "muted");
				return [
					...formatUiHeader(ui, "Set account label"),
					"",
					formatUiItem(
						ui,
						`${getStatusMarker(ui, "ok")} ${statusText}`,
						"success",
					),
					previousText,
				].join("\n");
			}

			if (normalizedLabel.length === 0) {
				return `Cleared label for ${accountLabel}`;
			}
			return `Set label for ${accountLabel} to "${normalizedLabel}"`;
		},
	});
}

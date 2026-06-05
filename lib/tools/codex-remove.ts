/**
 * `codex-remove` tool — remove a Codex account entry.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts, saveAccounts } from "../storage.js";
import { AccountManager } from "../accounts.js";
import { resolveDisplayEmail } from "../account-display.js";
import { logWarn } from "../logger.js";
import { MODEL_FAMILIES } from "../prompts/codex.js";
import {
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
} from "../ui/format.js";
import type { ToolContext } from "./index.js";

export function createCodexRemoveTool(ctx: ToolContext): ToolDefinition {
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
			"Remove one Codex account entry by index (1-based) or interactive picker when index is omitted. " +
			"Requires confirm=true to proceed; this is a destructive operation and OAuth state cannot be recovered.",
		args: {
			index: tool.schema
				.number()
				.optional()
				.describe(
					"Account number to remove (1-based, e.g., 1 for first account)",
				),
			confirm: tool.schema
				.boolean()
				.optional()
				.describe(
					"Must be set to true to actually remove the account. " +
						"When omitted or false, the tool is a no-op and returns a guidance message. " +
						"This guard prevents silent loss of OAuth credentials from a mistyped index.",
				),
		},
		async execute({
			index,
			confirm,
		}: { index?: number; confirm?: boolean } = {}) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			if (confirm !== true) {
				const guidance =
					"codex-remove requires confirm=true to proceed. " +
					"Removing an account deletes its OAuth credentials and cannot be undone. " +
					"Re-run as: codex-remove index=<N> confirm=true";
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Remove account"),
						"",
						formatUiItem(ui, "Confirmation required.", "warning"),
						formatUiItem(ui, guidance, "muted"),
					].join("\n");
				}
				return guidance;
			}
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Remove account"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
					].join("\n");
				}
				return "No Codex accounts configured. Nothing to remove.";
			}

			let resolvedIndex = index;
			if (resolvedIndex === undefined) {
				const selectedIndex = await promptAccountIndexSelection(
					ui,
					storage,
					"Remove account",
				);
				if (selectedIndex === null) {
					if (supportsInteractiveMenus()) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Remove account"),
								"",
								formatUiItem(ui, "No account selected.", "warning"),
								formatUiItem(
									ui,
									"Run again and pick an account, or pass codex-remove index=2 confirm=true.",
									"muted",
								),
							].join("\n");
						}
						return "No account selected.";
					}
					if (ui.v2Enabled) {
						return [
							...formatUiHeader(ui, "Remove account"),
							"",
							formatUiItem(ui, "Missing account number.", "warning"),
							formatUiItem(ui, "Use: codex-remove index=2 confirm=true", "accent"),
						].join("\n");
					}
					return "Missing account number. Use: codex-remove index=2 confirm=true";
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
						...formatUiHeader(ui, "Remove account"),
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
						formatUiItem(ui, "Use codex-list to list all accounts.", "accent"),
					].join("\n");
				}
				return `Invalid account number: ${resolvedIndex}\n\nValid range: 1-${storage.accounts.length}\n\nUse codex-list to list all accounts.`;
			}

			const account = storage.accounts[targetIndex];
			if (!account) {
				return `Account ${resolvedIndex} not found.`;
			}

			const label = formatCommandAccountLabel(account, targetIndex, { maskEmail });

			storage.accounts.splice(targetIndex, 1);

			if (storage.accounts.length === 0) {
				storage.activeIndex = 0;
				storage.activeIndexByFamily = {};
			} else {
				if (storage.activeIndex >= storage.accounts.length) {
					storage.activeIndex = 0;
				} else if (storage.activeIndex > targetIndex) {
					storage.activeIndex -= 1;
				}

				if (storage.activeIndexByFamily) {
					for (const family of MODEL_FAMILIES) {
						const idx = storage.activeIndexByFamily[family];
						if (typeof idx === "number") {
							if (idx >= storage.accounts.length) {
								storage.activeIndexByFamily[family] = 0;
							} else if (idx > targetIndex) {
								storage.activeIndexByFamily[family] = idx - 1;
							}
						}
					}
				}
			}

			try {
				await saveAccounts(storage);
			} catch (saveError) {
				logWarn("Failed to save account removal", {
					error: String(saveError),
				});
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Remove account"),
						"",
						formatUiItem(ui, `Removed selected entry: ${label}`, "warning"),
						formatUiItem(ui, "Only the selected index was changed.", "muted"),
						formatUiItem(
							ui,
							"Failed to persist. Change may be lost on restart.",
							"danger",
						),
					].join("\n");
				}
				return `Removed selected entry: ${label} from memory, but failed to persist. Only the selected index was changed and this may be lost on restart.`;
			}

			if (cachedAccountManagerRef.current) {
				const reloadedManager = await AccountManager.loadFromDisk();
				cachedAccountManagerRef.current = reloadedManager;
				accountManagerPromiseRef.current = Promise.resolve(reloadedManager);
			}

			const remaining = storage.accounts.length;
			const matchingEmailRemaining = account.email?.trim()
				? storage.accounts.filter((entry) => entry.email === account.email)
						.length
				: 0;
			const displayEmail = resolveDisplayEmail(account.email, maskEmail);
			if (ui.v2Enabled) {
				const postRemoveHint =
					matchingEmailRemaining > 0 && displayEmail
						? formatUiItem(
								ui,
								`Other entries for ${displayEmail} remain: ${matchingEmailRemaining}`,
								"muted",
							)
						: formatUiItem(
								ui,
								"Only the selected entry was removed.",
								"muted",
							);
				return [
					...formatUiHeader(ui, "Remove account"),
					"",
					formatUiItem(
						ui,
						`${getStatusMarker(ui, "ok")} Removed selected entry: ${label}`,
						"success",
					),
					postRemoveHint,
					remaining > 0
						? formatUiKeyValue(ui, "Remaining accounts", String(remaining))
						: formatUiItem(
								ui,
								"No accounts remaining. Run: opencode auth login",
								"warning",
							),
				].join("\n");
			}
			const postRemoveHint =
				matchingEmailRemaining > 0 && displayEmail
					? `Other entries for ${displayEmail} remain: ${matchingEmailRemaining}`
					: "Only the selected entry was removed.";
			return [
				`Removed selected entry: ${label}`,
				postRemoveHint,
				"",
				remaining > 0
					? `Remaining accounts: ${remaining}`
					: "No accounts remaining. Run: opencode auth login",
			].join("\n");
		},
	});
}

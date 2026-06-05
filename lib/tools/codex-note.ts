/**
 * `codex-note` tool — set or clear per-account reminder note.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts, saveAccounts } from "../storage.js";
import { AccountManager } from "../accounts.js";
import { logWarn } from "../logger.js";
import type { ToolContext } from "./index.js";

export function createCodexNoteTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		promptAccountIndexSelection,
		supportsInteractiveMenus,
		formatCommandAccountLabel,
		resolveMaskEmail,
		cachedAccountManagerRef,
		accountManagerPromiseRef,
	} = ctx;
	return tool({
		description: "Set or clear an account note for reminders.",
		args: {
			index: tool.schema
				.number()
				.optional()
				.describe(
					"Account number to update (1-based, e.g., 1 for first account)",
				),
			note: tool.schema
				.string()
				.describe("Short note. Empty string clears the note."),
		},
		async execute({ index, note }: { index?: number; note: string }) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			const storage = await loadAccounts();
			if (!storage || storage.accounts.length === 0) {
				return "No Codex accounts configured. Run: opencode auth login";
			}

			let resolvedIndex = index;
			if (resolvedIndex === undefined) {
				const selectedIndex = await promptAccountIndexSelection(
					ui,
					storage,
					"Set account note",
				);
				if (selectedIndex === null) {
					if (supportsInteractiveMenus()) return "No account selected.";
					return 'Missing account number. Use: codex-note index=2 note="weekday primary"';
				}
				resolvedIndex = selectedIndex + 1;
			}

			const targetIndex = Math.floor((resolvedIndex ?? 0) - 1);
			if (
				!Number.isFinite(targetIndex) ||
				targetIndex < 0 ||
				targetIndex >= storage.accounts.length
			) {
				return `Invalid account number: ${resolvedIndex}\n\nValid range: 1-${storage.accounts.length}`;
			}

			const account = storage.accounts[targetIndex];
			if (!account) return `Account ${resolvedIndex} not found.`;

			const normalizedNote = (note ?? "").trim();
			if (normalizedNote.length > 240) {
				return "Note is too long (max 240 characters).";
			}

			if (normalizedNote.length === 0) {
				delete account.accountNote;
			} else {
				account.accountNote = normalizedNote;
			}

			try {
				await saveAccounts(storage);
			} catch (error) {
				logWarn("Failed to save account note update", {
					error: String(error),
				});
				return "Note update failed to persist. Changes may be lost on restart.";
			}

			if (cachedAccountManagerRef.current) {
				const reloadedManager = await AccountManager.loadFromDisk();
				cachedAccountManagerRef.current = reloadedManager;
				accountManagerPromiseRef.current = Promise.resolve(reloadedManager);
			}

			const accountLabel = formatCommandAccountLabel(account, targetIndex, { maskEmail });
			if (normalizedNote.length === 0) {
				return `Cleared note for ${accountLabel}`;
			}
			return `Saved note for ${accountLabel}: ${normalizedNote}`;
		},
	});
}

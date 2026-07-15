/**
 * `codex-switch` tool — switch active Codex account by index or picker.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { loadAccounts, withAccountStorageTransaction } from "../storage.js";
import { AccountManager } from "../accounts.js";
import { logWarn } from "../logger.js";
import { MODEL_FAMILIES } from "../prompts/codex.js";
import { clearTuiQuotaSnapshot } from "../tui-quota-cache.js";
import {
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
} from "../ui/format.js";
import type { ToolContext } from "./index.js";

export function createCodexSwitchTool(ctx: ToolContext): ToolDefinition {
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
			"Switch active Codex account by index (1-based) or interactive picker when index is omitted.",
		args: {
			index: tool.schema
				.number()
				.optional()
				.describe(
					"Account number to switch to (1-based, e.g., 1 for first account)",
				),
		},
		async execute({ index }: { index?: number } = {}) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			// This read is only used to render the "no accounts" / interactive
			// picker UX. It is intentionally NOT the snapshot that gets mutated
			// and saved below -- the mutate+save happens inside
			// withAccountStorageTransaction against a freshly re-read snapshot so
			// a concurrent save (e.g. a rotation persisting rate-limit state)
			// between this read and the eventual save can't be clobbered.
			const initialStorage = await loadAccounts();
			if (!initialStorage || initialStorage.accounts.length === 0) {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Switch account"),
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
					initialStorage,
					"Switch account",
				);
				if (selectedIndex === null) {
					if (supportsInteractiveMenus()) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Switch account"),
								"",
								formatUiItem(ui, "No account selected.", "warning"),
								formatUiItem(
									ui,
									"Run again and pick an account, or pass codex-switch index=2.",
									"muted",
								),
							].join("\n");
						}
						return "No account selected.";
					}
					if (ui.v2Enabled) {
						return [
							...formatUiHeader(ui, "Switch account"),
							"",
							formatUiItem(ui, "Missing account number.", "warning"),
							formatUiItem(ui, "Use: codex-switch index=2", "accent"),
						].join("\n");
					}
					return "Missing account number. Use: codex-switch index=2";
				}
				resolvedIndex = selectedIndex + 1;
			}

			type SwitchOutcome =
				| { kind: "invalid"; accountCount: number }
				| { kind: "save-failed"; label: string }
				| { kind: "ok"; label: string };

			const outcome = await withAccountStorageTransaction<SwitchOutcome>(
				async (current, persist) => {
					const accounts = current?.accounts ?? [];
					const targetIndex = Math.floor((resolvedIndex ?? 0) - 1);
					if (
						!current ||
						!Number.isFinite(targetIndex) ||
						targetIndex < 0 ||
						targetIndex >= accounts.length
					) {
						return { kind: "invalid", accountCount: accounts.length };
					}

					const now = Date.now();
					const account = accounts[targetIndex];
					if (account) {
						account.lastUsed = now;
						account.lastSwitchReason = "rotation";
					}

					const storage = current;
					storage.activeIndex = targetIndex;
					storage.activeIndexByFamily = storage.activeIndexByFamily ?? {};
					for (const family of MODEL_FAMILIES) {
						storage.activeIndexByFamily[family] = targetIndex;
					}

					const label = formatCommandAccountLabel(account, targetIndex, {
						maskEmail,
					});
					try {
						await persist(storage);
					} catch (saveError) {
						logWarn("Failed to save account switch", {
							error: String(saveError),
						});
						return { kind: "save-failed", label };
					}
					return { kind: "ok", label };
				},
			);

			if (outcome.kind === "invalid") {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Switch account"),
						"",
						formatUiItem(
							ui,
							`Invalid account number: ${resolvedIndex}`,
							"danger",
						),
						formatUiKeyValue(
							ui,
							"Valid range",
							`1-${outcome.accountCount}`,
							"muted",
						),
					].join("\n");
				}
				return `Invalid account number: ${resolvedIndex}\n\nValid range: 1-${outcome.accountCount}`;
			}

			if (outcome.kind === "save-failed") {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Switch account"),
						"",
						formatUiItem(ui, `Switched to ${outcome.label}`, "warning"),
						formatUiItem(
							ui,
							"Failed to persist change. It may be lost on restart.",
							"danger",
						),
					].join("\n");
				}
				return `Switched to ${outcome.label} but failed to persist. Changes may be lost on restart.`;
			}

			try {
				await clearTuiQuotaSnapshot();
			} catch (cacheError) {
				logWarn("Failed to clear TUI quota cache after account switch", {
					error: String(cacheError),
				});
			}

			if (cachedAccountManagerRef.current) {
				const reloadedManager = await AccountManager.loadFromDisk();
				cachedAccountManagerRef.current = reloadedManager;
				accountManagerPromiseRef.current = Promise.resolve(reloadedManager);
			}

			if (ui.v2Enabled) {
				return [
					...formatUiHeader(ui, "Switch account"),
					"",
					formatUiItem(
						ui,
						`${getStatusMarker(ui, "ok")} Switched to ${outcome.label}`,
						"success",
					),
				].join("\n");
			}
			return `Switched to account: ${outcome.label}`;
		},
	});
}

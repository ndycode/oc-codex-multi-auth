/**
 * `codex-help` tool — beginner-friendly command guide.
 * Extracted from `index.ts` per RC-1 Phase 2.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import {
	formatUiHeader,
	formatUiItem,
	formatUiSection,
} from "../ui/format.js";
import type { ToolContext } from "./index.js";

export function createCodexHelpTool(ctx: ToolContext): ToolDefinition {
	const { resolveUiRuntime } = ctx;
	return tool({
		description:
			"Beginner-friendly command guide with quickstart and troubleshooting flows.",
		args: {
			topic: tool.schema
				.string()
				.optional()
				.describe(
					"Optional topic: setup, switch, pools, health, backup, dashboard.",
				),
		},
		async execute({ topic }) {
			const ui = resolveUiRuntime();
			await Promise.resolve();
			const normalizedTopic = (topic ?? "").trim().toLowerCase();
			const sections: Array<{ key: string; title: string; lines: string[] }> = [
				{
					key: "setup",
					title: "Quickstart",
					lines: [
						"1) Add account: opencode auth login",
						"2) Verify account health: codex-health",
						"3) View account list: codex-list",
						"4) Run checklist: codex-setup",
						"5) Use guided wizard: codex-setup --wizard",
						"6) Start requests and monitor: codex-dashboard",
					],
				},
				{
					key: "pools",
					title: "Model account pools",
					lines: [
						"Show all pools: codex-pool",
						'Assign accounts: codex-pool action="set" model="gpt-5.6-sol" accounts=[7,8]',
						'Add an account: codex-pool action="add" model="gpt-5.6-sol" accounts=[9]',
						'Remove an account: codex-pool action="remove" model="gpt-5.6-sol" accounts=[7]',
						'Clear a pool: codex-pool action="clear" model="gpt-5.6-sol"',
					],
				},
				{
					key: "switch",
					title: "Daily account operations",
					lines: [
						"List accounts: codex-list",
						"Switch active account: codex-switch index=2",
						"Warm up all accounts: codex-warm",
						"Show detailed status: codex-status",
						"Set account label: codex-label index=2 label=\"Work\"",
						"Set account tags: codex-tag index=2 tags=\"work,team-a\"",
						"Set account note: codex-note index=2 note=\"weekday primary\"",
						"Filter by tag: codex-list tag=\"work\"",
						"Remove account: codex-remove index=2 confirm=true",
					],
				},
				{
					key: "health",
					title: "Health and recovery",
					lines: [
						"Verify token health: codex-health",
						"Refresh all tokens: codex-refresh",
						"Run diagnostics: codex-doctor",
						"Run diagnostics with fixes: codex-doctor --fix",
						"Show best next action: codex-next",
						"Run guided wizard: codex-setup --wizard",
					],
				},
				{
					key: "dashboard",
					title: "Monitoring",
					lines: [
						"Live dashboard: codex-dashboard",
						"Runtime metrics: codex-metrics",
						"Per-account status detail: codex-status",
					],
				},
				{
					key: "backup",
					title: "Backup and migration",
					lines: [
						"Export accounts: codex-export <path>",
						"Auto backup export: codex-export",
						"Import preview: codex-import <path> --dryRun",
						"Import apply: codex-import <path>",
						"Setup checklist: codex-setup",
					],
				},
			];

			const visibleSections =
				normalizedTopic.length === 0
					? sections
					: sections.filter((section) => section.key === normalizedTopic);
			if (visibleSections.length === 0) {
				const available = sections.map((section) => section.key).join(", ");
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Codex help"),
						"",
						formatUiItem(ui, `Unknown topic: ${normalizedTopic}`, "warning"),
						formatUiItem(
							ui,
							`Available topics: ${available}`,
							"muted",
						),
					].join("\n");
				}
				return `Unknown topic: ${normalizedTopic}\n\nAvailable topics: ${available}`;
			}

			if (ui.v2Enabled) {
				const lines: string[] = [...formatUiHeader(ui, "Codex help"), ""];
				for (const section of visibleSections) {
					lines.push(...formatUiSection(ui, section.title));
					for (const line of section.lines) {
						lines.push(formatUiItem(ui, line));
					}
					lines.push("");
				}
				lines.push(...formatUiSection(ui, "Tips"));
				lines.push(formatUiItem(ui, "Run codex-setup after adding accounts."));
				lines.push(
					formatUiItem(
						ui,
						"Use codex-setup --wizard for menu-driven onboarding.",
					),
				);
				lines.push(
					formatUiItem(
						ui,
						"Use codex-doctor when request failures increase.",
					),
				);
				return lines.join("\n").trimEnd();
			}

			const lines: string[] = ["Codex Help:", ""];
			for (const section of visibleSections) {
				lines.push(`${section.title}:`);
				for (const line of section.lines) {
					lines.push(`  - ${line}`);
				}
				lines.push("");
			}
			lines.push("Tips:");
			lines.push("  - Run codex-setup after adding accounts.");
			lines.push(
				"  - Use codex-setup --wizard for menu-driven onboarding.",
			);
			lines.push("  - Use codex-doctor when request failures increase.");
			return lines.join("\n");
		},
	});
}

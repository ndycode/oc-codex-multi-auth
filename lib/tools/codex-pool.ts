/** `codex-pool` tool - manage model-specific account pools by account number. */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import {
	loadPluginConfig,
	updateModelAccountPool,
	type ModelAccountPoolMutation,
} from "../config.js";
import { normalizeToolOutputFormat, renderJsonOutput } from "../runtime.js";
import { loadAccounts, type AccountStorageV3 } from "../storage.js";
import type { ToolContext } from "./index.js";

type CodexPoolAction = "status" | ModelAccountPoolMutation;

type CodexPoolArgs = {
	action?: string;
	model?: string;
	accounts?: number[];
	dryRun?: boolean;
	format?: string;
	includeSensitive?: boolean;
};

function normalizePoolAction(action?: string): CodexPoolAction {
	if (action === undefined || action === "status") return "status";
	if (
		action === "set" ||
		action === "add" ||
		action === "remove" ||
		action === "clear"
	) {
		return action;
	}
	throw new Error(
		`Invalid action "${action}". Expected "status", "set", "add", "remove", or "clear".`,
	);
}

function normalizeModel(model?: string): string | undefined {
	const normalized = model?.trim().toLowerCase();
	return normalized || undefined;
}

function resolveAccountIds(
	storage: AccountStorageV3 | null,
	accountNumbers: readonly number[] | undefined,
): string[] {
	if (!accountNumbers?.length) {
		throw new Error("At least one account number is required.");
	}
	if (!storage || storage.accounts.length === 0) {
		throw new Error("No Codex accounts are configured.");
	}

	const ids: string[] = [];
	for (const accountNumber of Array.from(new Set(accountNumbers))) {
		if (
			!Number.isInteger(accountNumber) ||
			accountNumber < 1 ||
			accountNumber > storage.accounts.length
		) {
			throw new Error(
				`Invalid account number ${accountNumber}. Expected 1-${storage.accounts.length}.`,
			);
		}
		const account = storage.accounts[accountNumber - 1];
		const accountId = account?.accountId?.trim();
		if (!accountId) {
			throw new Error(
				`Account ${accountNumber} has no stable account ID and cannot be assigned to a model pool.`,
			);
		}
		ids.push(accountId);
	}
	return ids;
}

function buildPoolSnapshot(
	model: string,
	accountIds: readonly string[],
	storage: AccountStorageV3 | null,
	ctx: ToolContext,
	includeSensitive: boolean,
): {
	model: string;
	configuredCount: number;
	accounts: Record<string, unknown>[];
	unresolvedCount: number;
	unresolvedAccountIds?: string[];
} {
	const accounts: Record<string, unknown>[] = [];
	const unresolvedAccountIds: string[] = [];
	const storedAccounts = storage?.accounts ?? [];
	const maskEmail = ctx.resolveMaskEmail();

	for (const accountId of accountIds) {
		const index = storedAccounts.findIndex(
			(account) => account.accountId?.trim() === accountId,
		);
		const account = index >= 0 ? storedAccounts[index] : undefined;
		if (!account) {
			unresolvedAccountIds.push(accountId);
			continue;
		}
		accounts.push({
			...ctx.buildJsonAccountIdentity(index, {
				includeSensitive,
				account,
				label: ctx.formatCommandAccountLabel(account, index, { maskEmail }),
			}),
			enabled: account.enabled !== false,
		});
	}

	return {
		model,
		configuredCount: accountIds.length,
		accounts,
		unresolvedCount: unresolvedAccountIds.length,
		...(includeSensitive ? { unresolvedAccountIds } : {}),
	};
}

function renderPoolStatusText(
	pools: ReturnType<typeof buildPoolSnapshot>[],
	ctx: ToolContext,
	storage: AccountStorageV3 | null,
): string {
	if (pools.length === 0) return "No model account pools configured.";
	const lines = ["Model account pools"];
	const maskEmail = ctx.resolveMaskEmail();
	for (const pool of pools) {
		lines.push("", pool.model);
		for (const identity of pool.accounts) {
			const index = identity.zeroBasedIndex;
			if (typeof index !== "number") continue;
			const account = storage?.accounts[index];
			if (account) {
				lines.push(
					`  ${ctx.formatCommandAccountLabel(account, index, { maskEmail })}${
						account.enabled === false ? " [disabled]" : ""
					}`,
				);
			}
		}
		if (pool.unresolvedCount > 0) {
			lines.push(
				`  ${pool.unresolvedCount} account reference${pool.unresolvedCount === 1 ? " is" : "s are"} not present in this project`,
			);
		}
	}
	return lines.join("\n");
}

export function createCodexPoolTool(ctx: ToolContext): ToolDefinition {
	return tool({
		description:
			"Inspect and manage model-specific account pools. Account numbers are 1-based inputs; stable account IDs are persisted.",
		args: {
			action: tool.schema
				.string()
				.optional()
				.describe('"status" (default), "set", "add", "remove", or "clear".'),
			model: tool.schema
				.string()
				.optional()
				.describe("Effective model ID, such as gpt-5.6-sol."),
			accounts: tool.schema
				.array(tool.schema.number())
				.optional()
				.describe("1-based account numbers used by set, add, and remove."),
			dryRun: tool.schema
				.boolean()
				.optional()
				.describe("Preview a mutation without changing configuration."),
			format: tool.schema
				.string()
				.optional()
				.describe('Output format: "text" (default) or "json".'),
			includeSensitive: tool.schema
				.boolean()
				.optional()
				.describe("Include stable account IDs in JSON output (default: false)."),
		},
		async execute(args: CodexPoolArgs) {
			const action = normalizePoolAction(args.action);
			const format = normalizeToolOutputFormat(args.format);
			const model = normalizeModel(args.model);
			const storage = await loadAccounts();
			const includeSensitive = args.includeSensitive === true;

			if (action === "status") {
				const configuredPools = loadPluginConfig().modelAccountPools ?? {};
				const entries = Object.entries(configuredPools).filter(
					([configuredModel]) =>
						model === undefined || configuredModel.trim().toLowerCase() === model,
				);
				const pools = entries.map(([configuredModel, ids]) =>
					buildPoolSnapshot(
						configuredModel.trim().toLowerCase(),
						ids,
						storage,
						ctx,
						includeSensitive,
					),
				);
				if (format === "json") {
					return renderJsonOutput({ action, pools });
				}
				if (pools.length === 0 && model) {
					return `No model account pool configured for ${model}.`;
				}
				return renderPoolStatusText(pools, ctx, storage);
			}

			if (!model) throw new Error(`Model is required for action "${action}".`);
			const accountIds =
				action === "clear"
					? []
					: resolveAccountIds(storage, args.accounts);
			const result = await updateModelAccountPool(model, action, accountIds, {
				dryRun: args.dryRun,
			});
			const pool = buildPoolSnapshot(
				result.model,
				result.accountIds,
				storage,
				ctx,
				includeSensitive,
			);
			const applied = result.changed && !result.dryRun;
			const payload = {
				action,
				model: result.model,
				changed: result.changed,
				applied,
				dryRun: result.dryRun,
				restartRequired: applied,
				previousConfiguredCount: result.previousAccountIds.length,
				pool,
			};
			if (format === "json") return renderJsonOutput(payload);

			const verb = result.dryRun ? "Previewed" : applied ? "Updated" : "No change to";
			const lines = [
				`${verb} model account pool: ${result.model}`,
				`Previous accounts: ${result.previousAccountIds.length}`,
				`Current accounts: ${result.accountIds.length}`,
			];
			if (applied) lines.push("Restart OpenCode to apply this routing change.");
			return lines.join("\n");
		},
	});
}

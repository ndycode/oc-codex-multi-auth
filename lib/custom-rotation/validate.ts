import { isAbsolute } from "node:path";
import { runRotationPolicy } from "./runner.js";
import { RotationFixturesSchema } from "./fixtures.js";
import { emptyRotationAccount } from "./observations.js";
import type { RotationInput } from "./contract.js";

type Scenario = { readonly name: string; readonly input: RotationInput; readonly expectedAccountId?: string | null };

export async function validateRotation(module: string, fixtures?: unknown) {
	if (!isAbsolute(module) || !module.endsWith(".mjs")) return { exitCode: 2, error: "Expected an absolute .mjs module path", results: [] };
	const now = 1_800_000_000_000;
	const a = emptyRotationAccount("synthetic-seat-a");
	const b = emptyRotationAccount("synthetic-seat-b");
	const input = (accounts: RotationInput["accounts"]): RotationInput => ({ version: 1, now, model: "gpt-5.6-sol", currentAccountId: null, accounts });
	const scenarios: Scenario[] = [
		{ name: "empty-eligible", input: input([]), expectedAccountId: null },
		{ name: "single-unknown", input: input([a]) },
		{ name: "two-unknown-seats", input: input([a, b]) },
		{ name: "fresh-and-stale", input: input([
			{ ...a, primary: { ...a.primary, usedPercent: { value: 95, status: "fresh", observedAt: now, expiresAt: now + 300_000, source: "headers", scope: "seat" } } },
			{ ...b, primary: { ...b.primary, usedPercent: { value: 0, status: "stale", observedAt: now - 600_000, expiresAt: now - 300_000, source: "usage", scope: "seat" } } },
		]) },
		{ name: "not-applicable-and-unlimited", input: input([{ ...a,
			primary: { usedPercent: { ...a.primary.usedPercent, status: "not-applicable" }, resetAtMs: a.primary.resetAtMs, windowMinutes: a.primary.windowMinutes },
			credits: { value: { balance: null, unlimited: true }, status: "fresh", observedAt: now, expiresAt: now + 300_000, source: "usage", scope: "seat" },
		}]) },
	];
	if (fixtures !== undefined) {
		const parsed = RotationFixturesSchema.safeParse(fixtures);
		if (!parsed.success) return { exitCode: 2, error: "Invalid rotation fixtures", results: [] };
		scenarios.push(...parsed.data.scenarios);
	}
	const results = [];
	for (const scenario of scenarios) {
		const result = scenario.input.accounts.length ? await runRotationPolicy(module, scenario.input) : { accountId: null, error: null };
		const eligible = result.accountId === null || scenario.input.accounts.some((account) => account.id === result.accountId);
		const passed = result.error === null && eligible && (scenario.expectedAccountId === undefined || result.accountId === scenario.expectedAccountId);
		results.push({ name: scenario.name, passed, accountId: result.accountId, error: result.error ?? (eligible ? passed ? null : "unexpected-account" : "ineligible-id") });
	}
	return { exitCode: results.every((result) => result.passed) ? 0 : 1, error: null, results };
}

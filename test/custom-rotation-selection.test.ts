import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountManager } from "../lib/accounts.js";
import { resetTrackers, getTokenTracker } from "../lib/rotation.js";
import { RotationObservations, rotationAccountId } from "../lib/custom-rotation/observations.js";
import { selectCustomAccount, type CustomSelectionRequest } from "../lib/custom-rotation/selection.js";

let directory: string;
let manager: AccountManager;
const observations = new RotationObservations();
const request: CustomSelectionRequest = { family: "codex", model: "gpt-5.6-sol" };
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "rotation-selection-"));
	resetTrackers();
	manager = new AccountManager(undefined, {
		version: 3, activeIndex: 0,
		accounts: [0, 1, 2].map((index) => ({ accountId: "shared-business", accountUserId: `seat-${index}`, refreshToken: `synthetic-${index}`, addedAt: 1, lastUsed: 1 })),
	});
});
afterEach(async () => { observations.clear(); resetTrackers(); await rm(directory, { recursive: true, force: true }); });
async function choose(source: string, selection = request) {
	const module = join(directory, "policy.mjs");
	await writeFile(module, source);
	return selectCustomAccount({
		candidates: (input) => manager.getCustomCandidates(input),
		accept: (account, input) => manager.acceptCustomCandidate(account, input),
		current: (family) => manager.getCurrentAccountForFamily(family),
	}, selection, { module, observations, scope: directory });
}

describe("host custom eligibility", () => {
	it("selects a different Business seat when a policy returns its opaque id", async () => {
		const selected = await choose("export function select({ accounts }) { return accounts[1].id; }");
		expect(selected?.accountUserId).toBe("seat-1");
		expect(manager.getCurrentAccountForFamily("codex")?.index).toBe(1);
	});
	it.each(["return null;", "throw new Error('failure');", "return 'blocked-id';"])("falls back only to eligible accounts when policy does %s", async (behavior) => {
		manager.setAccountEnabled(0, false);
		const selected = await choose(`export function select() { ${behavior} }`);
		expect(selected?.index).toBe(1);
	});
	it("skips policy and blocked fallback when every eligible account is excluded", async () => {
		const selected = await choose("throw new Error('must never import');", { ...request, excludedIndices: new Set([0, 1, 2]) });
		expect(selected).toBeNull();
	});
	it("does not reuse hybrid fallback when all accounts are cooling down", async () => {
		for (const account of manager.getCustomCandidates(request)) manager.markAccountCoolingDown(account, 60_000, "network-error");
		const selected = await choose("throw new Error('must never import');");
		expect(selected).toBeNull();
	});
	it("excludes depleted token buckets when preparing the policy input", async () => {
		getTokenTracker().drain(0, "codex:gpt-5.6-sol", Number.MAX_SAFE_INTEGER);
		const selected = await choose("export function select({ accounts }) { return accounts[0].id; }");
		expect(selected?.index).toBe(1);
	});
	it("keeps strict pool boundaries when a member is server-rate-limited", async () => {
		const account = manager.getCustomCandidates(request)[0];
		if (!account) throw new Error("fixture missing");
		manager.markRateLimited(account, 60_000, "codex", request.model);
		const selected = await choose("throw new Error('must never import');", { ...request, preferredAccountIds: ['seat:|shared-business|seat-0'], poolMode: "strict" });
		expect(selected).toBeNull();
	});
	it("uses general eligibility when the preferred pool is unavailable", async () => {
		manager.setAccountEnabled(0, false);
		const selected = await choose("export function select({ accounts }) { return accounts[0].id; }", { ...request, preferredAccountIds: ['seat:|shared-business|seat-0'], poolMode: "preferred" });
		expect(selected?.index).toBe(1);
	});
	it("revalidates selection when an account becomes disabled during the await", async () => {
		const module = join(directory, "policy.mjs");
		await writeFile(module, "export async function select({ accounts }) { return accounts[0].id; }");
		const pending = selectCustomAccount({ candidates: (input) => manager.getCustomCandidates(input), accept: (account, input) => manager.acceptCustomCandidate(account, input), current: (family) => manager.getCurrentAccountForFamily(family) }, request, { module, observations, scope: directory });
		manager.setAccountEnabled(0, false);
		const selected = await pending;
		expect(selected?.index).toBe(1);
	});
	it("separates IDs when seats or storage scopes differ", () => {
		const accounts = manager.getAccountsSnapshot();
		const ids = accounts.map((account) => rotationAccountId(account, directory));
		expect(new Set(ids).size).toBe(3);
		const account = accounts[0];
		if (!account) throw new Error("fixture missing");
		expect(rotationAccountId(account, "other-project")).not.toBe(ids[0]);
	});
});

/**
 * Deep stress / regression coverage for issue #171 — the RECOVERY path
 * (comment 4748562388 / the v6.3.3 follow-up 4748602475).
 *
 * The 401 *failover* path is covered by auth-invalidated-401-stress.test.ts.
 * THIS suite covers the complementary gap the reporter hit AFTER the 401 fix:
 * an account left with stale `auth-failure` cooldown and/or stale
 * `rateLimitResetTimes` stays ineligible for rotation even though the
 * credential is alive (`--pure` works), so every account is dark and the only
 * recovery was hand-editing the accounts file. `codex-doctor --fix` is supposed
 * to repair this.
 *
 * Unlike test/index.test.ts (which mocks the plugin/storage), this drives the
 * REAL AccountManager eligibility logic and the REAL recovery helpers
 * (`clearRefreshedAccountsStaleState`, `findDisabledTokenSourceDuplicates`),
 * reproducing the reporter's exact on-disk state and asserting the
 * user-visible property: after recovery the account is selectable again, and
 * it stays selectable across a simulated restart.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import { AccountManager } from "../../lib/accounts.js";
import type { AccountStorageV3, AccountMetadataV3 } from "../../lib/storage.js";
import type { ModelFamily } from "../../lib/prompts/codex.js";
import { MODEL_FAMILIES } from "../../lib/prompts/codex.js";
import {
	clearRefreshedAccountsStaleState,
	findDisabledTokenSourceDuplicates,
} from "../../lib/accounts/stale-state.js";

const FAMILY: ModelFamily = "codex";
const NOW = 1_700_000_000_000;
const FUTURE = NOW + 3_600_000;

type Active = ReturnType<AccountManager["getCurrentOrNextForFamilyHybrid"]>;

function countEligible(manager: AccountManager): number {
	return manager
		.getSelectionExplainability(FAMILY, "gpt-5.1", Date.now())
		.filter((entry) => entry.eligible).length;
}

/**
 * Apply the doctor's recovery to a storage snapshot exactly as
 * codex-doctor --fix does for accounts whose refresh succeeded, then rebuild a
 * fresh manager from the repaired storage (a faithful "restart" — the doctor
 * persists with saveAccounts and the plugin reloads).
 */
function recoverAndReload(storage: AccountStorageV3): AccountManager {
	clearRefreshedAccountsStaleState(storage.accounts);
	return new AccountManager(undefined, storage);
}

describe("chaos/doctor-recovery — real manager + real recovery helpers (issue #171)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("A: reporter's exact bad state has ZERO eligible accounts before recovery", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		// account 0: org, enabled, auth-failure cooldown (the dead-but-alive slot)
		// account 1: org, enabled, stale future rate-limits for gpt-5.4 / gpt-5.4-mini
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "org-AAA",
					organizationId: "org-AAA",
					accountIdSource: "org",
					email: "user@example.com",
					refreshToken: "rt-a",
					addedAt: NOW,
					lastUsed: NOW,
					coolingDownUntil: FUTURE,
					cooldownReason: "auth-failure",
				},
				{
					accountId: "org-BBB",
					organizationId: "org-BBB",
					accountIdSource: "org",
					email: "two@example.com",
					refreshToken: "rt-b",
					addedAt: NOW,
					lastUsed: NOW - 1,
					rateLimitResetTimes: { codex: FUTURE, "codex:gpt-5.1": FUTURE },
				},
			],
		};
		const manager = new AccountManager(undefined, storage);
		expect(countEligible(manager)).toBe(0);
		expect(manager.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1")).not.toBeNull(); // selector falls back, but...
		// ...the explainability (what the doctor's auto-switch consults) sees nothing eligible.
		manager.disposeShutdownHandler();
	});

	it("B: recovery clears the stale state and at least one account becomes eligible (self-heals across restart)", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "org-AAA",
					organizationId: "org-AAA",
					accountIdSource: "org",
					email: "user@example.com",
					refreshToken: "rt-a",
					addedAt: NOW,
					lastUsed: NOW,
					coolingDownUntil: FUTURE,
					cooldownReason: "auth-failure",
					rateLimitResetTimes: { codex: FUTURE },
				},
			],
		};
		const before = new AccountManager(undefined, storage);
		expect(countEligible(before)).toBe(0);
		before.disposeShutdownHandler();

		// Doctor --fix: refresh succeeds -> clear stale state -> persist -> reload.
		const after = recoverAndReload(storage);
		expect(countEligible(after)).toBe(1);
		const selected = after.getCurrentOrNextForFamilyHybrid(FAMILY, "gpt-5.1");
		expect(selected).not.toBeNull();
		expect(selected!.refreshToken).toBe("rt-a");
		expect(after.isAccountCoolingDown(selected as NonNullable<Active>)).toBe(false);

		// The repaired storage record carries no stale block, so a second restart
		// stays healthy (no hand-editing, no re-darkening).
		const restarted = new AccountManager(undefined, storage);
		expect(countEligible(restarted)).toBe(1);
		after.disposeShutdownHandler();
		restarted.disposeShutdownHandler();
	});

	it("C: recovery does not resurrect an account the user explicitly disabled", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		const storage: AccountStorageV3 = {
			version: 3,
			activeIndex: 0,
			accounts: [
				{
					accountId: "org-AAA",
					organizationId: "org-AAA",
					accountIdSource: "org",
					refreshToken: "rt-a",
					addedAt: NOW,
					lastUsed: NOW,
					enabled: false,
					coolingDownUntil: FUTURE,
					cooldownReason: "auth-failure",
				},
			],
		};
		// Recovery clears cooldown/rate-limit but must NOT flip enabled.
		const after = recoverAndReload(storage);
		expect(storage.accounts[0]?.enabled).toBe(false);
		expect(countEligible(after)).toBe(0);
		after.disposeShutdownHandler();
	});

	it("D: DEEP STRESS — randomized pools always recover every alive account after refresh+clear", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));

		// Deterministic LCG so failures reproduce from the printed seed.
		let seed = 0x171c0de;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};

		const ITERATIONS = 400;
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const count = 1 + Math.floor(rand() * 5); // 1..5 accounts
			const accounts: AccountMetadataV3[] = [];
			const aliveRefreshTokens: string[] = [];

			for (let i = 0; i < count; i++) {
				const rt = `rt-${iter}-${i}`;
				// "alive" = enabled and would refresh successfully this run.
				const disabled = rand() < 0.15;
				const hasCooldown = rand() < 0.6;
				const hasRateLimit = rand() < 0.6;
				const account: AccountMetadataV3 = {
					accountId: `org-${iter}-${i}`,
					organizationId: `org-${iter}-${i}`,
					accountIdSource: "org",
					email: `u${iter}-${i}@example.com`,
					refreshToken: rt,
					addedAt: NOW,
					lastUsed: NOW - i,
				};
				if (disabled) account.enabled = false;
				if (hasCooldown) {
					account.coolingDownUntil = FUTURE;
					account.cooldownReason = rand() < 0.5 ? "auth-failure" : "network-error";
				}
				if (hasRateLimit) {
					account.rateLimitResetTimes = {
						codex: FUTURE,
						"codex:gpt-5.1": FUTURE,
					};
				}
				accounts.push(account);
				if (!disabled) aliveRefreshTokens.push(rt);
			}

			const storage: AccountStorageV3 = { version: 3, activeIndex: 0, accounts };

			// Doctor --fix refreshes only the alive (enabled) accounts; clear stale
			// state on exactly those, as codex-doctor does with refreshedAccounts.
			const refreshed = accounts.filter((a) => a.enabled !== false);
			clearRefreshedAccountsStaleState(refreshed);
			const manager = new AccountManager(undefined, storage);

			const eligibleTokens = new Set(
				manager
					.getSelectionExplainability(FAMILY, "gpt-5.1", Date.now())
					.filter((e) => e.eligible)
					.map((e) => manager.getAccountsSnapshot()[e.index]?.refreshToken),
			);

			// INVARIANT: every alive account is eligible after recovery; every
			// disabled account remains ineligible.
			for (const rt of aliveRefreshTokens) {
				expect(eligibleTokens.has(rt), `seed=${0x171c0de} iter=${iter} expected alive ${rt} eligible`).toBe(true);
			}
			for (const a of accounts) {
				if (a.enabled === false) {
					expect(eligibleTokens.has(a.refreshToken), `seed=${0x171c0de} iter=${iter} disabled ${a.refreshToken} must stay ineligible`).toBe(false);
				}
			}
			// If at least one account was alive, the pool is no longer dark.
			if (aliveRefreshTokens.length > 0) {
				expect(eligibleTokens.size).toBeGreaterThan(0);
			}
			manager.disposeShutdownHandler();
		}
	});

	it("E: DEEP STRESS — duplicate detector flags only disabled token-source shadows, never real accounts", () => {
		let seed = 0x5ad0c;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};

		const ITERATIONS = 400;
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const accounts: AccountMetadataV3[] = [];
			const expectedDuplicateTokens = new Set<string>();

			const count = 1 + Math.floor(rand() * 5);
			// Track which emails have an enabled org-backed account.
			const enabledOrgEmails = new Set<string>();
			const draft: Array<{
				rt: string;
				email: string;
				source: "org" | "token";
				hasOrg: boolean;
				enabled: boolean;
			}> = [];

			for (let i = 0; i < count; i++) {
				const email = `shared${iter % 3}@example.com`; // force some collisions
				const isToken = rand() < 0.5;
				const enabled = rand() < 0.7;
				const hasOrg = isToken ? rand() < 0.3 : true;
				draft.push({
					rt: `rt-${iter}-${i}`,
					email,
					source: isToken ? "token" : "org",
					hasOrg,
					enabled,
				});
			}
			for (const d of draft) {
				if (d.enabled && (d.source === "org" || d.hasOrg)) {
					enabledOrgEmails.add(d.email);
				}
			}
			for (const d of draft) {
				const account: AccountMetadataV3 = {
					accountId: `${d.source}-${d.rt}`,
					accountIdSource: d.source,
					email: d.email,
					refreshToken: d.rt,
					addedAt: NOW,
					lastUsed: NOW,
				};
				if (d.hasOrg) account.organizationId = `org-${d.rt}`;
				if (!d.enabled) account.enabled = false;
				accounts.push(account);

				// Expected: disabled, token-source, NO org id, email matches an
				// enabled org-backed account.
				if (
					!d.enabled &&
					d.source === "token" &&
					!d.hasOrg &&
					enabledOrgEmails.has(d.email)
				) {
					expectedDuplicateTokens.add(d.rt);
				}
			}

			const flaggedIndexes = findDisabledTokenSourceDuplicates(accounts);
			const flaggedTokens = new Set(flaggedIndexes.map((i) => accounts[i]?.refreshToken));

			expect(flaggedTokens).toEqual(expectedDuplicateTokens);
			// Never flag an enabled account.
			for (const i of flaggedIndexes) {
				expect(accounts[i]?.enabled).toBe(false);
			}
		}
	});
});


import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearRefreshedAccountStaleState,
	clearRefreshedAccountsStaleState,
	findDisabledTokenSourceDuplicates,
	findStaleRecoverableAccounts,
	type StaleStateAccount,
} from "../lib/accounts/stale-state.js";

describe("clearRefreshedAccountStaleState", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("clears an active auth-failure cooldown after a successful refresh", () => {
		const account: StaleStateAccount = {
			coolingDownUntil: Date.now() + 600_000,
			cooldownReason: "auth-failure",
		};

		const result = clearRefreshedAccountStaleState(account);

		expect(result.clearedCooldown).toBe(true);
		expect(account.coolingDownUntil).toBeUndefined();
		expect(account.cooldownReason).toBeUndefined();
	});

	it("clears stale rate-limit reset times", () => {
		const account: StaleStateAccount = {
			rateLimitResetTimes: {
				"gpt-5.4": Date.now() + 3_600_000,
				"gpt-5.4-mini": Date.now() + 3_600_000,
			},
		};

		const result = clearRefreshedAccountStaleState(account);

		expect(result.clearedRateLimitKeys).toBe(2);
		expect(account.rateLimitResetTimes).toEqual({});
	});

	it("reports clearedCooldown=false when the cooldown was already expired but still removes the leftover fields", () => {
		const account: StaleStateAccount = {
			coolingDownUntil: Date.now() - 1_000,
			cooldownReason: "network-error",
		};

		const result = clearRefreshedAccountStaleState(account);

		// Already-expired cooldown is not an *active* block, so we do not count it,
		// but we still scrub the leftover fields so snapshots stay clean.
		expect(result.clearedCooldown).toBe(false);
		expect(account.coolingDownUntil).toBeUndefined();
		expect(account.cooldownReason).toBeUndefined();
	});

	it("is a no-op for a clean account", () => {
		const account: StaleStateAccount = {};
		const result = clearRefreshedAccountStaleState(account);
		expect(result).toEqual({ clearedCooldown: false, clearedRateLimitKeys: 0 });
		expect(account).toEqual({});
	});

	it("aggregates across multiple accounts", () => {
		const accounts: StaleStateAccount[] = [
			{ coolingDownUntil: Date.now() + 600_000, cooldownReason: "auth-failure" },
			{ rateLimitResetTimes: { "gpt-5.4": Date.now() + 1000, codex: Date.now() + 1000 } },
			{},
		];

		const summary = clearRefreshedAccountsStaleState(accounts);

		expect(summary.cooldownsCleared).toBe(1);
		expect(summary.rateLimitKeysCleared).toBe(2);
	});
});

describe("findDisabledTokenSourceDuplicates", () => {
	it("flags a disabled token-source duplicate that shadows an enabled org account by email", () => {
		const accounts = [
			{ accountIdSource: "org", organizationId: "org-AAA", email: "user@example.com", enabled: true },
			{ accountIdSource: "token", email: "user@example.com", enabled: false },
		];
		expect(findDisabledTokenSourceDuplicates(accounts)).toEqual([1]);
	});

	it("ignores an enabled token-source account (real distinct account)", () => {
		const accounts = [
			{ accountIdSource: "org", organizationId: "org-AAA", email: "user@example.com", enabled: true },
			{ accountIdSource: "token", email: "user@example.com", enabled: true },
		];
		expect(findDisabledTokenSourceDuplicates(accounts)).toEqual([]);
	});

	it("ignores a token-source account whose email matches no enabled org account", () => {
		const accounts = [
			{ accountIdSource: "org", organizationId: "org-AAA", email: "alice@example.com", enabled: true },
			{ accountIdSource: "token", email: "bob@example.com", enabled: false },
		];
		expect(findDisabledTokenSourceDuplicates(accounts)).toEqual([]);
	});

	it("does not flag a token-source account that carries its own organizationId (real workspace)", () => {
		const accounts = [
			{ accountIdSource: "org", organizationId: "org-AAA", email: "user@example.com", enabled: true },
			{ accountIdSource: "token", organizationId: "org-BBB", email: "user@example.com", enabled: false },
		];
		expect(findDisabledTokenSourceDuplicates(accounts)).toEqual([]);
	});

	it("does not flag when the org sibling is itself disabled (nothing to dedupe against)", () => {
		const accounts = [
			{ accountIdSource: "org", organizationId: "org-AAA", email: "user@example.com", enabled: false },
			{ accountIdSource: "token", email: "user@example.com", enabled: false },
		];
		expect(findDisabledTokenSourceDuplicates(accounts)).toEqual([]);
	});

	it("matches email case-insensitively and trims whitespace", () => {
		const accounts = [
			{ accountIdSource: "org", organizationId: "org-AAA", email: " User@Example.com ", enabled: true },
			{ accountIdSource: "token", email: "user@example.com", enabled: false },
		];
		expect(findDisabledTokenSourceDuplicates(accounts)).toEqual([1]);
	});
});

describe("findStaleRecoverableAccounts", () => {
	const NOW = 1_700_000_000_000;
	const FUTURE = NOW + 3_600_000;
	const PAST = NOW - 3_600_000;

	it("flags an account blocked by a future cooldown", () => {
		const accounts = [{ enabled: true, coolingDownUntil: FUTURE, cooldownReason: "auth-failure" }];
		expect(findStaleRecoverableAccounts(accounts, NOW)).toEqual([0]);
	});

	it("flags an account blocked by a future rate-limit reset", () => {
		const accounts = [{ enabled: true, rateLimitResetTimes: { "gpt-5.4": FUTURE } }];
		expect(findStaleRecoverableAccounts(accounts, NOW)).toEqual([0]);
	});

	it("ignores expired cooldown/rate-limit (the request path clears those)", () => {
		const accounts = [
			{ enabled: true, coolingDownUntil: PAST, cooldownReason: "auth-failure" },
			{ enabled: true, rateLimitResetTimes: { "gpt-5.4": PAST } },
		];
		expect(findStaleRecoverableAccounts(accounts, NOW)).toEqual([]);
	});

	it("ignores a disabled account (not recoverable by --fix)", () => {
		const accounts = [{ enabled: false, coolingDownUntil: FUTURE }];
		expect(findStaleRecoverableAccounts(accounts, NOW)).toEqual([]);
	});

	it("ignores a clean enabled account", () => {
		const accounts = [{ enabled: true, rateLimitResetTimes: {} }];
		expect(findStaleRecoverableAccounts(accounts, NOW)).toEqual([]);
	});

	it("returns multiple blocked slots in order", () => {
		const accounts = [
			{ enabled: true, coolingDownUntil: FUTURE },
			{ enabled: true, rateLimitResetTimes: { codex: PAST } },
			{ enabled: true, rateLimitResetTimes: { "gpt-5.4": FUTURE, "gpt-5.4-mini": FUTURE } },
		];
		expect(findStaleRecoverableAccounts(accounts, NOW)).toEqual([0, 2]);
	});
});


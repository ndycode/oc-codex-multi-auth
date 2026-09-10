import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearRefreshedAccountStaleState,
	clearRefreshedAccountsStaleState,
	findDisabledTokenSourceDuplicates,
	findDisabledAccountsWithFreshCredential,
	findConflictingBusinessMemberCredentials,
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
		expect(result).toEqual({ clearedCooldown: false, clearedRateLimitKeys: 0, clearedQuotaExhaustion: false });
		expect(account).toEqual({});
	});

	it("clears an active account-wide quota-exhaustion stamp and counts it", () => {
		const account: StaleStateAccount = {
			quotaExhaustedUntil: Date.now() + 7 * 24 * 60 * 60 * 1000,
		};

		const result = clearRefreshedAccountStaleState(account);

		expect(result.clearedQuotaExhaustion).toBe(true);
		expect(account.quotaExhaustedUntil).toBeUndefined();
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

describe("findConflictingBusinessMemberCredentials", () => {
	it("flags different emails backed by the same Business member credential", () => {
		const accounts = [
			{
				accountId: "business-account",
				accountUserId: "member-owner",
				email: "owner@example.com",
			},
			{
				accountId: "business-account",
				accountUserId: "member-owner",
				email: "invited@example.com",
			},
		];

		expect(findConflictingBusinessMemberCredentials(accounts)).toEqual([[0, 1]]);
	});

	it("derives the member id from cached access tokens for existing records", () => {
		const payload = {
			"https://api.openai.com/auth": {
				chatgpt_account_id: "business-account",
				chatgpt_account_user_id: "member-owner",
			},
		};
		const accessToken = `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
		const accounts = [
			{ accountId: "business-account", email: "owner@example.com", accessToken },
			{ accountId: "business-account", email: "invited@example.com", accessToken },
		];

		expect(findConflictingBusinessMemberCredentials(accounts)).toEqual([[0, 1]]);
	});

	it("keeps two member ids in one Business workspace separate", () => {
		const accounts = [
			{
				accountId: "business-account",
				accountUserId: "member-owner",
				email: "owner@example.com",
			},
			{
				accountId: "business-account",
				accountUserId: "member-invited",
				email: "invited@example.com",
			},
		];

		expect(findConflictingBusinessMemberCredentials(accounts)).toEqual([]);
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

	it("flags an account blocked only by a future quota-exhaustion stamp", () => {
		const accounts = [{ enabled: true, quotaExhaustedUntil: FUTURE }];
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

describe("findDisabledAccountsWithFreshCredential (issue #171)", () => {
	const NOW = 1_700_000_000_000;
	const FUTURE = NOW + 3_600_000;
	const PAST = NOW - 3_600_000;

	it("flags a disabled account that holds a fresh (unexpired) access token", () => {
		const accounts = [{ enabled: false, accessToken: "tok", expiresAt: FUTURE }];
		expect(findDisabledAccountsWithFreshCredential(accounts, NOW)).toEqual([0]);
	});

	it("ignores an enabled account (not the blind-spot case)", () => {
		const accounts = [{ enabled: true, accessToken: "tok", expiresAt: FUTURE }];
		expect(findDisabledAccountsWithFreshCredential(accounts, NOW)).toEqual([]);
	});

	it("ignores an account with no enabled field (undefined is not disabled)", () => {
		const accounts = [{ accessToken: "tok", expiresAt: FUTURE }];
		expect(findDisabledAccountsWithFreshCredential(accounts, NOW)).toEqual([]);
	});

	it("ignores a disabled account whose credential is expired", () => {
		const accounts = [{ enabled: false, accessToken: "tok", expiresAt: PAST }];
		expect(findDisabledAccountsWithFreshCredential(accounts, NOW)).toEqual([]);
	});

	it("ignores a disabled account with no access token", () => {
		const accounts = [{ enabled: false, expiresAt: FUTURE }];
		expect(findDisabledAccountsWithFreshCredential(accounts, NOW)).toEqual([]);
	});

	it("returns multiple flagged slots in order", () => {
		const accounts = [
			{ enabled: false, accessToken: "a", expiresAt: FUTURE },
			{ enabled: true, accessToken: "b", expiresAt: FUTURE },
			{ enabled: false, accessToken: "c", expiresAt: FUTURE },
		];
		expect(findDisabledAccountsWithFreshCredential(accounts, NOW)).toEqual([0, 2]);
	});
});

describe("findConflictingBusinessMemberCredentials (#230 symptom)", () => {
	it("flags records that were all overwritten with the last login's email", () => {
		// Issue #230 reports that every affected record ends up carrying the SAME
		// email, so requiring differing emails would stay silent on exactly the
		// corruption this scan exists to surface.
		const accounts = [
			{
				accountId: "business-account",
				accountUserId: "member-owner",
				email: "b@example.com",
			},
			{
				accountId: "business-account",
				accountUserId: "member-owner",
				email: "b@example.com",
			},
		];

		expect(findConflictingBusinessMemberCredentials(accounts)).toEqual([[0, 1]]);
	});

	it("ignores distinct workspace variants of a single OAuth grant", () => {
		const accounts = [
			{
				accountId: "business-account",
				accountUserId: "member-owner",
				organizationId: "org-one",
				email: "owner@example.com",
			},
			{
				accountId: "business-account",
				accountUserId: "member-owner",
				organizationId: "org-two",
				email: "owner@example.com",
			},
		];

		expect(findConflictingBusinessMemberCredentials(accounts)).toEqual([]);
	});

	it("still flags duplicates that share one organizationId", () => {
		const accounts = [
			{
				accountId: "business-account",
				accountUserId: "member-owner",
				organizationId: "org-one",
				email: "owner@example.com",
			},
			{
				accountId: "business-account",
				accountUserId: "member-owner",
				organizationId: "org-one",
				email: "owner@example.com",
			},
		];

		expect(findConflictingBusinessMemberCredentials(accounts)).toEqual([[0, 1]]);
	});
});

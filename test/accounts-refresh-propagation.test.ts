/**
 * Regression tests for refresh-token rotation propagation to siblings
 * (audit fix #4, lib/accounts/state.ts updateFromAuth).
 *
 * A single OAuth login produces sibling accounts (distinct orgs) that SHARE one
 * refresh token. OpenAI rotates the refresh token on every refresh, so once one
 * sibling refreshes (R0 -> R1) the OTHER siblings' stored R0 is stale — their
 * next refresh would fail and eventually evict still-valid workspaces.
 *
 *   OLD behavior: updateFromAuth only touched the account it was called on; the
 *   sibling kept the now-dead R0.
 *   NEW behavior: the rotated token is propagated to every sibling that held R0,
 *   and each sibling's `expires` is reset to 0 to force its own fresh refresh.
 *
 * Org-specific fields (access / accountId / email) on the sibling are NOT
 * touched — each sibling re-derives those on its next use.
 */
import { describe, it, expect } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import type { OAuthAuthDetails } from "../lib/types.js";

function buildSharedTokenManager(): AccountManager {
	const now = Date.now();
	const stored = {
		version: 3 as const,
		activeIndex: 0,
		accounts: [
			{
				refreshToken: "R0",
				organizationId: "org-a",
				accountId: "acct-a",
				email: "user@example.com",
				accessToken: "access-a",
				expiresAt: now + 3_600_000,
				addedAt: now,
				lastUsed: now,
			},
			{
				refreshToken: "R0",
				organizationId: "org-b",
				accountId: "acct-b",
				email: "user@example.com",
				accessToken: "access-b",
				expiresAt: now + 3_600_000,
				addedAt: now,
				lastUsed: now,
			},
		],
	};
	return new AccountManager(undefined, stored);
}

describe("updateFromAuth refresh-token propagation to siblings (audit fix #4)", () => {
	it("propagates the rotated refresh token to siblings sharing the old token", () => {
		const manager = buildSharedTokenManager();
		const accounts = manager.getAccountsSnapshot();
		const orgA = accounts.find((a) => a.organizationId === "org-a")!;
		// Operate on a LIVE reference (snapshot clones), so re-fetch via index.
		const liveA = manager.setActiveIndex(orgA.index)!;
		expect(liveA.refreshToken).toBe("R0");

		const newAuth: OAuthAuthDetails = {
			type: "oauth",
			access: "new-access-a",
			refresh: "R1",
			expires: Date.now() + 3_600_000,
		};

		manager.updateFromAuth(liveA, newAuth);

		const after = manager.getAccountsSnapshot();
		const afterA = after.find((a) => a.organizationId === "org-a")!;
		const afterB = after.find((a) => a.organizationId === "org-b")!;

		// The refreshed account got the new token.
		expect(afterA.refreshToken).toBe("R1");
		// OLD behavior: sibling B still held the dead "R0". NEW: it gets "R1".
		expect(afterB.refreshToken).toBe("R1");
	});

	it("resets the sibling's expires to 0 so it forces its own fresh refresh", () => {
		const manager = buildSharedTokenManager();
		const liveA = manager.setActiveIndex(0)!;

		const newAuth: OAuthAuthDetails = {
			type: "oauth",
			access: "new-access-a",
			refresh: "R1",
			expires: Date.now() + 3_600_000,
		};

		manager.updateFromAuth(liveA, newAuth);

		const afterB = manager
			.getAccountsSnapshot()
			.find((a) => a.organizationId === "org-b")!;
		expect(afterB.expires).toBe(0);
	});

	it("leaves the sibling's org-specific access/accountId/email untouched", () => {
		const manager = buildSharedTokenManager();
		const liveA = manager.setActiveIndex(0)!;

		const newAuth: OAuthAuthDetails = {
			type: "oauth",
			access: "new-access-a",
			refresh: "R1",
			expires: Date.now() + 3_600_000,
		};

		manager.updateFromAuth(liveA, newAuth);

		const afterB = manager
			.getAccountsSnapshot()
			.find((a) => a.organizationId === "org-b")!;
		// Only the shared credential propagates; the workspace's own access token
		// and identity are preserved (it re-derives access on next use).
		expect(afterB.access).toBe("access-b");
		expect(afterB.accountId).toBe("acct-b");
		expect(afterB.organizationId).toBe("org-b");
	});

	it("does not touch accounts that hold a different refresh token", () => {
		const now = Date.now();
		const stored = {
			version: 3 as const,
			activeIndex: 0,
			accounts: [
				{ refreshToken: "R0", organizationId: "org-a", addedAt: now, lastUsed: now },
				{
					refreshToken: "OTHER",
					organizationId: "org-c",
					accessToken: "access-c",
					expiresAt: now + 3_600_000,
					addedAt: now,
					lastUsed: now,
				},
			],
		};
		const manager = new AccountManager(undefined, stored);
		const liveA = manager.setActiveIndex(0)!;

		manager.updateFromAuth(liveA, {
			type: "oauth",
			access: "new-access-a",
			refresh: "R1",
			expires: now + 3_600_000,
		});

		const other = manager
			.getAccountsSnapshot()
			.find((a) => a.organizationId === "org-c")!;
		// Unrelated token must remain intact, including its valid expiry.
		expect(other.refreshToken).toBe("OTHER");
		expect(other.expires).toBe(now + 3_600_000);
	});
});

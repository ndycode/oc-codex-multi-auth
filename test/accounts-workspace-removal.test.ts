/**
 * Regression tests for workspace-scoped account removal (audit fix #3).
 *
 * A single multi-org OAuth login produces sibling ManagedAccounts that SHARE
 * one refresh token but represent distinct, independently-valid workspaces
 * (different organizationId / accountId). When ONE workspace is deactivated,
 * the manager must remove only that workspace.
 *
 *   OLD behavior: deactivating one workspace removed every refresh-token
 *   sibling, silently dropping still-valid workspaces from the pool.
 *   NEW behavior: removeAccountsByWorkspaceIdentity scopes removal to the
 *   matching workspace identity; the sibling survives.
 *
 * The contrast method removeAccountsWithSameRefreshToken still removes ALL
 * siblings — that is the correct behavior when the refresh token itself is dead.
 */
import { describe, it, expect } from "vitest";
import { AccountManager } from "../lib/accounts.js";

function buildSharedRefreshManager(): AccountManager {
	const now = Date.now();
	// Two workspaces, one shared refresh token, distinct org + account ids.
	const stored = {
		version: 3 as const,
		activeIndex: 0,
		accounts: [
			{
				refreshToken: "shared-refresh",
				organizationId: "org-a",
				accountId: "acct-a",
				email: "user@example.com",
				addedAt: now,
				lastUsed: now,
			},
			{
				refreshToken: "shared-refresh",
				organizationId: "org-b",
				accountId: "acct-b",
				email: "user@example.com",
				addedAt: now,
				lastUsed: now,
			},
		],
	};
	return new AccountManager(undefined, stored);
}

describe("removeAccountsByWorkspaceIdentity (audit fix #3)", () => {
	it("removes ONLY the targeted workspace, leaving the refresh-token sibling", () => {
		const manager = buildSharedRefreshManager();
		expect(manager.getAccountCount()).toBe(2);

		const accounts = manager.getAccountsSnapshot();
		const workspaceA = accounts.find((a) => a.organizationId === "org-a")!;
		expect(workspaceA).toBeDefined();

		const removed = manager.removeAccountsByWorkspaceIdentity(workspaceA);

		// OLD behavior would have removed both siblings (returned 2, count 0).
		expect(removed).toBe(1);
		expect(manager.getAccountCount()).toBe(1);

		const survivor = manager.getAccountsSnapshot()[0];
		expect(survivor?.organizationId).toBe("org-b");
		expect(survivor?.accountId).toBe("acct-b");
		// The shared refresh token is still present on the survivor.
		expect(survivor?.refreshToken).toBe("shared-refresh");
		expect(manager.hasRefreshToken("shared-refresh")).toBe(true);
	});

	it("contrast: removeAccountsWithSameRefreshToken removes BOTH siblings", () => {
		const manager = buildSharedRefreshManager();
		const accounts = manager.getAccountsSnapshot();
		const workspaceA = accounts.find((a) => a.organizationId === "org-a")!;

		const removed = manager.removeAccountsWithSameRefreshToken(workspaceA);

		// Token-dead path intentionally drops every sibling.
		expect(removed).toBe(2);
		expect(manager.getAccountCount()).toBe(0);
		expect(manager.hasRefreshToken("shared-refresh")).toBe(false);
	});

	it("preserves the shared refresh token's auth-failure counter while a sibling still uses it", async () => {
		const manager = buildSharedRefreshManager();
		const accounts = manager.getAccountsSnapshot();
		const workspaceA = accounts.find((a) => a.organizationId === "org-a")!;

		// Seed an auth-failure count on the shared refresh token.
		expect(await manager.incrementAuthFailures(workspaceA)).toBe(1);
		expect(await manager.incrementAuthFailures(workspaceA)).toBe(2);

		manager.removeAccountsByWorkspaceIdentity(workspaceA);

		// org-b still holds the token, so its failure counter must NOT be cleared.
		const survivor = manager.getAccountsSnapshot()[0]!;
		expect(manager.getAuthFailures(survivor)).toBe(2);
	});

	it("clears the auth-failure counter once the last workspace using the token is removed", async () => {
		const manager = buildSharedRefreshManager();
		const accounts = manager.getAccountsSnapshot();
		const workspaceA = accounts.find((a) => a.organizationId === "org-a")!;
		const workspaceB = accounts.find((a) => a.organizationId === "org-b")!;

		expect(await manager.incrementAuthFailures(workspaceA)).toBe(1);

		manager.removeAccountsByWorkspaceIdentity(workspaceA); // sibling B still uses token
		manager.removeAccountsByWorkspaceIdentity(workspaceB); // last user gone

		expect(manager.getAccountCount()).toBe(0);
		// A fresh increment for the same token starts from 1 again — proving the
		// counter was cleared when the final workspace went away.
		expect(await manager.incrementAuthFailures(workspaceB)).toBe(1);
	});
});

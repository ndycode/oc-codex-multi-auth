/**
 * Recovery + hydration surface for {@link AccountManager}.
 *
 * Covers:
 *  - auth-failure counter bookkeeping (per refresh token, serialized)
 *  - cross-process hydration from the Codex CLI `~/.codex/accounts.json`
 *  - merge-safe removal of all accounts sharing a refresh token
 */

import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	sanitizeEmail,
	shouldUpdateAccountIdFromToken,
} from "../auth/token-utils.js";
import { decodeJWT } from "../auth/auth.js";
import { createLogger } from "../logger.js";
import { CodexCliAccountsSchema } from "../schemas.js";
import { nowMs } from "../utils.js";
import type { AccountPersistence } from "./persistence.js";
import type { AccountState, ManagedAccount } from "./state.js";
import { getWorkspaceIdentityKey } from "../storage/identity.js";

const log = createLogger("accounts");

export type CodexCliTokenCacheEntry = {
	accessToken: string;
	expiresAt?: number;
	refreshToken?: string;
	accountId?: string;
};

const CODEX_CLI_ACCOUNTS_PATH = join(homedir(), ".codex", "accounts.json");
const CODEX_CLI_CACHE_TTL_MS = 5_000;
let codexCliTokenCache: Map<string, CodexCliTokenCacheEntry> | null = null;
let codexCliTokenCacheLoadedAt = 0;

function extractExpiresAtFromAccessToken(accessToken: string): number | undefined {
	const decoded = decodeJWT(accessToken);
	const exp = decoded?.exp;
	if (typeof exp === "number" && Number.isFinite(exp)) {
		// JWT exp is in seconds since epoch.
		return exp * 1000;
	}
	return undefined;
}

async function getCodexCliTokenCache(): Promise<Map<string, CodexCliTokenCacheEntry> | null> {
	const syncEnabled = process.env.CODEX_AUTH_SYNC_CODEX_CLI !== "0";
	const skip =
		!syncEnabled ||
		process.env.VITEST_WORKER_ID !== undefined ||
		process.env.NODE_ENV === "test";
	if (skip) return null;

	const now = nowMs();
	if (codexCliTokenCache && now - codexCliTokenCacheLoadedAt < CODEX_CLI_CACHE_TTL_MS) {
		return codexCliTokenCache;
	}
	codexCliTokenCacheLoadedAt = now;

	if (!existsSync(CODEX_CLI_ACCOUNTS_PATH)) {
		codexCliTokenCache = null;
		return null;
	}

	try {
		const raw = await fs.readFile(CODEX_CLI_ACCOUNTS_PATH, "utf-8");
		const rawParsed = JSON.parse(raw) as unknown;

		// Cross-process trust boundary: the Codex CLI accounts file is produced
		// by a separate process on disk and may be stale, truncated, tampered
		// with, or produced by a version whose shape we do not recognise. We
		// MUST validate through the Zod schema before reading any field; a
		// parse failure is a warn+skip, never a throw (audit top-20 #11).
		const validation = CodexCliAccountsSchema.safeParse(rawParsed);
		if (!validation.success) {
			log.warn("Codex CLI accounts cache failed validation; ignoring", {
				issues: validation.error.issues.length,
				firstPath: validation.error.issues[0]?.path.join(".") ?? "(root)",
			});
			codexCliTokenCache = null;
			return null;
		}

		const validated = validation.data;
		const entries = Array.isArray(validated.accounts) ? validated.accounts : [];

		const next = new Map<string, CodexCliTokenCacheEntry>();
		for (const entry of entries) {
			const email = sanitizeEmail(
				typeof entry.email === "string" ? entry.email : undefined,
			);
			if (!email) continue;

			const accountId =
				typeof entry.accountId === "string" && entry.accountId.trim()
					? entry.accountId.trim()
					: undefined;

			const tokens = entry.auth?.tokens;
			const accessToken =
				typeof tokens?.access_token === "string" && tokens.access_token.trim()
					? tokens.access_token.trim()
					: undefined;
			const refreshToken =
				typeof tokens?.refresh_token === "string" && tokens.refresh_token.trim()
					? tokens.refresh_token.trim()
					: undefined;

			if (!accessToken) continue;

			next.set(email, {
				accessToken,
				expiresAt: extractExpiresAtFromAccessToken(accessToken),
				refreshToken,
				accountId,
			});
		}

		codexCliTokenCache = next;
		return codexCliTokenCache;
	} catch (error) {
		log.debug("Failed to read Codex CLI accounts cache", { error: String(error) });
		codexCliTokenCache = null;
		return null;
	}
}

export async function lookupCodexCliTokensByEmail(
	email: string | undefined,
): Promise<CodexCliTokenCacheEntry | null> {
	const normalized = sanitizeEmail(email);
	if (!normalized) return null;
	const cache = await getCodexCliTokenCache();
	const cached = cache?.get(normalized);
	return cached ? { ...cached } : null;
}

export class AccountRecovery {
	constructor(
		private readonly state: AccountState,
		private readonly persistence: AccountPersistence,
	) {}

	async hydrateFromCodexCli(): Promise<void> {
		const cache = await getCodexCliTokenCache();
		if (!cache || cache.size === 0) return;

		const now = nowMs();
		let changed = false;

		for (const account of this.state.accounts) {
			const email = sanitizeEmail(account.email);
			if (!email) continue;

			const cached = cache.get(email);
			if (!cached) continue;

			if (typeof cached.expiresAt === "number" && cached.expiresAt <= now) {
				continue;
			}

			const missingOrExpired =
				!account.access || account.expires === undefined || account.expires <= now;
			if (missingOrExpired) {
				account.access = cached.accessToken;
				if (typeof cached.expiresAt === "number") {
					account.expires = cached.expiresAt;
				}
				changed = true;
			}

			if (
				!account.accountId &&
				cached.accountId &&
				shouldUpdateAccountIdFromToken(account.accountIdSource, account.accountId)
			) {
				account.accountId = cached.accountId;
				account.accountIdSource = account.accountIdSource ?? "token";
				changed = true;
			}
		}

		if (!changed) return;

		try {
			await this.persistence.saveToDisk();
		} catch (error) {
			log.debug("Failed to persist Codex CLI cache hydration", {
				error: String(error),
			});
		}
	}

	/**
	 * Atomically increment the auth-failure counter for the account's refresh
	 * token and return the post-increment value.
	 *
	 * The read-modify-write is serialized through a per-refresh-token promise
	 * chain so that concurrent callers (for example, two org-variant accounts
	 * sharing a refresh token that fail auth simultaneously) cannot lose an
	 * increment. Without serialization both callers could read the same stale
	 * value, both compute `+1`, and both write the same result — masking a hard
	 * auth failure and causing the manager to keep hammering a dead token.
	 *
	 * Callers must `await` the returned promise before branching on the
	 * threshold (see `index.ts` auth-refresh failure path).
	 */
	async incrementAuthFailures(account: ManagedAccount): Promise<number> {
		const key = account.refreshToken;
		const prev = this.state.incrementAuthFailuresChain.get(key) ?? Promise.resolve(0);
		const next = prev.then(() => {
			const currentFailures = this.state.authFailuresByRefreshToken.get(key) ?? 0;
			const newFailures = currentFailures + 1;
			this.state.authFailuresByRefreshToken.set(key, newFailures);
			return newFailures;
		});
		this.state.incrementAuthFailuresChain.set(key, next);
		try {
			return await next;
		} finally {
			// Drop the chain entry only if no later caller has already replaced it.
			if (this.state.incrementAuthFailuresChain.get(key) === next) {
				this.state.incrementAuthFailuresChain.delete(key);
			}
		}
	}

	/**
	 * Return the current auth-failure counter for the account's refresh token
	 * without mutating state. Intended for tests and diagnostics.
	 */
	getAuthFailures(account: ManagedAccount): number {
		return this.state.authFailuresByRefreshToken.get(account.refreshToken) ?? 0;
	}

	/**
	 * Clear the authentication failure counter for the given account's refresh token.
	 *
	 * Notes:
	 * - Failure counts are tracked per refresh token (not per account), so this clears
	 *   shared failure state for all org variants that reuse the same token.
	 * - Failure counts are in-memory only for the current AccountManager instance.
	 */
	clearAuthFailures(account: ManagedAccount): void {
		this.state.authFailuresByRefreshToken.delete(account.refreshToken);
	}

	/**
	 * Remove all accounts that share the same refreshToken as the given account.
	 * This is used when auth refresh fails to remove all org variants together.
	 * @returns Number of accounts removed
	 */
	removeAccountsWithSameRefreshToken(account: ManagedAccount): number {
		const refreshToken = account.refreshToken;
		// Snapshot first because removeAccount mutates the accounts array.
		const accountsToRemove = this.state.accounts.filter(
			(acc) => acc.refreshToken === refreshToken,
		);
		let removedCount = 0;

		for (const accountToRemove of accountsToRemove) {
			if (this.state.removeAccount(accountToRemove)) {
				removedCount++;
			}
		}

		// Clear stale auth failure state for this refresh token
		this.state.authFailuresByRefreshToken.delete(refreshToken);

		return removedCount;
	}

	/**
	 * Remove only the account(s) matching the given account's WORKSPACE identity
	 * (org/account id), not every sibling that merely shares its refresh token.
	 *
	 * A single multi-org OAuth login produces several ManagedAccounts that share
	 * one refresh token but represent distinct, independently-valid workspaces.
	 * When ONE workspace is deactivated, removing all refresh-token siblings would
	 * silently drop the still-valid workspaces from rotation. This scopes removal
	 * to the deactivated workspace only.
	 *
	 * @returns Number of accounts removed
	 */
	removeAccountsByWorkspaceIdentity(account: ManagedAccount): number {
		const targetKey = getWorkspaceIdentityKey(account);
		// Snapshot first because removeAccount mutates the accounts array.
		const accountsToRemove = this.state.accounts.filter(
			(acc) => getWorkspaceIdentityKey(acc) === targetKey,
		);
		let removedCount = 0;

		for (const accountToRemove of accountsToRemove) {
			if (this.state.removeAccount(accountToRemove)) {
				removedCount++;
			}
		}

		// Only clear auth-failure state for the refresh token if no sibling
		// workspace still uses it (siblings remain valid and may still fail/recover).
		const refreshToken = account.refreshToken;
		const refreshTokenStillInUse = this.state.accounts.some(
			(acc) => acc.refreshToken === refreshToken,
		);
		if (!refreshTokenStillInUse) {
			this.state.authFailuresByRefreshToken.delete(refreshToken);
		}

		return removedCount;
	}
}

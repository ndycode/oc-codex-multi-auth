/**
 * AccountManager — slim orchestrator that composes four domain services:
 *
 *  - {@link AccountState}       — in-memory account registry + per-family indices
 *  - {@link AccountPersistence} — debounced disk saves, shutdown-flush lifecycle
 *  - {@link AccountRotation}    — selection, rate-limit and cooldown management
 *  - {@link AccountRecovery}    — auth-failure tracking, Codex CLI hydration,
 *                                  merge-safe removal
 *
 * This module preserves the public API that existed before the RC-7 split so
 * that `new AccountManager(...)` and every instance method keeps working for
 * external callers (`index.ts`, `lib/tools/*`, `lib/parallel-probe.ts`, etc.).
 */

import type { Auth } from "@opencode-ai/sdk";
import { loadAccounts, type AccountStorageV3, type CooldownReason } from "./storage.js";
import type { HybridSelectionOptions } from "./rotation.js";
import type { OAuthAuthDetails } from "./types.js";
import type { ModelFamily } from "./prompts/codex.js";
import {
	AccountPersistence,
} from "./accounts/persistence.js";
import { AccountRecovery } from "./accounts/recovery.js";
import { AccountRotation } from "./accounts/rotation.js";
import {
	AccountState,
	type AccountSelectionExplainability,
	type ManagedAccount,
} from "./accounts/state.js";
import { formatWaitTime, type RateLimitReason } from "./accounts/rate-limits.js";
import { nowMs } from "./utils.js";
import { resolveDisplayEmail } from "./account-display.js";

export type { AccountSelectionExplainability, ManagedAccount } from "./accounts/state.js";

export {
	extractAccountId,
	extractAccountEmail,
	getAccountIdCandidates,
	selectBestAccountCandidate,
	shouldUpdateAccountIdFromToken,
	resolveRequestAccountId,
	sanitizeEmail,
	type AccountIdCandidate,
} from "./auth/token-utils.js";

export {
	parseRateLimitReason,
	getQuotaKey,
	clampNonNegativeInt,
	clearExpiredRateLimits,
	isRateLimitedForQuotaKey,
	isRateLimitedForFamily,
	formatWaitTime,
	type QuotaKey,
	type BaseQuotaKey,
	type RateLimitReason,
	type RateLimitState,
	type RateLimitedEntity,
} from "./accounts/rate-limits.js";

export {
	lookupCodexCliTokensByEmail,
	type CodexCliTokenCacheEntry,
} from "./accounts/recovery.js";

export class AccountManager {
	private readonly state: AccountState;
	private readonly persistence: AccountPersistence;
	private readonly rotation: AccountRotation;
	private readonly recovery: AccountRecovery;

	/**
	 * Alias to `state.authFailuresByRefreshToken`. Preserved as a property on
	 * the orchestrator so that pre-split tests and diagnostics that reach in
	 * via `Reflect.get(manager, "authFailuresByRefreshToken")` continue to see
	 * the live map without edits. Internal use only.
	 */
	private get authFailuresByRefreshToken(): Map<string, number> {
		return this.state.authFailuresByRefreshToken;
	}

	constructor(authFallback?: OAuthAuthDetails, stored?: AccountStorageV3 | null) {
		this.state = new AccountState();
		this.persistence = new AccountPersistence(this.state);
		this.rotation = new AccountRotation(this.state);
		this.recovery = new AccountRecovery(this.state, this.persistence);
		this.state.initializeFromStorage(authFallback, stored);
	}

	static async loadFromDisk(authFallback?: OAuthAuthDetails): Promise<AccountManager> {
		const stored = await loadAccounts();
		const manager = new AccountManager(authFallback, stored);
		await manager.recovery.hydrateFromCodexCli();
		return manager;
	}

	// ----- state delegations -----

	hasRefreshToken(refreshToken: string): boolean {
		return this.state.hasRefreshToken(refreshToken);
	}

	getAccountCount(): number {
		return this.state.getAccountCount();
	}

	getActiveIndex(): number {
		return this.state.getActiveIndexForFamily("codex");
	}

	getActiveIndexForFamily(family: ModelFamily): number {
		return this.state.getActiveIndexForFamily(family);
	}

	getAccountsSnapshot(): ManagedAccount[] {
		return this.state.getAccountsSnapshot();
	}

	getSelectionExplainability(
		family: ModelFamily,
		model?: string | null,
		now = nowMs(),
	): AccountSelectionExplainability[] {
		return this.state.getSelectionExplainability(family, model, now);
	}

	setActiveIndex(index: number): ManagedAccount | null {
		return this.state.setActiveIndex(index);
	}

	getCurrentAccount(): ManagedAccount | null {
		return this.state.getCurrentAccountForFamily("codex");
	}

	getCurrentAccountForFamily(family: ModelFamily): ManagedAccount | null {
		return this.state.getCurrentAccountForFamily(family);
	}

	shouldShowAccountToast(accountIndex: number, debounceMs = 30000): boolean {
		return this.state.shouldShowAccountToast(accountIndex, debounceMs);
	}

	markToastShown(accountIndex: number): void {
		this.state.markToastShown(accountIndex);
	}

	updateFromAuth(account: ManagedAccount, auth: OAuthAuthDetails): void {
		this.state.updateFromAuth(account, auth);
	}

	toAuthDetails(account: ManagedAccount): Auth {
		return this.state.toAuthDetails(account);
	}

	markSwitched(
		account: ManagedAccount,
		reason: "rate-limit" | "initial" | "rotation",
		family: ModelFamily,
	): void {
		this.state.markSwitched(account, reason, family);
	}

	removeAccount(account: ManagedAccount): boolean {
		return this.state.removeAccount(account);
	}

	removeAccountByIndex(index: number): boolean {
		return this.state.removeAccountByIndex(index);
	}

	setAccountEnabled(index: number, enabled: boolean): ManagedAccount | null {
		return this.state.setAccountEnabled(index, enabled);
	}

	isAccountCoolingDown(account: ManagedAccount): boolean {
		return this.state.isAccountCoolingDown(account);
	}

	clearAccountCooldown(account: ManagedAccount): void {
		this.state.clearAccountCooldown(account);
	}

	// ----- rotation delegations -----

	getCurrentOrNext(): ManagedAccount | null {
		return this.rotation.getCurrentOrNextForFamily("codex");
	}

	getCurrentOrNextForFamily(
		family: ModelFamily,
		model?: string | null,
	): ManagedAccount | null {
		return this.rotation.getCurrentOrNextForFamily(family, model);
	}

	getNextForFamily(family: ModelFamily, model?: string | null): ManagedAccount | null {
		return this.rotation.getNextForFamily(family, model);
	}

	getCurrentOrNextForFamilyHybrid(
		family: ModelFamily,
		model?: string | null,
		options?: HybridSelectionOptions,
	): ManagedAccount | null {
		return this.rotation.getCurrentOrNextForFamilyHybrid(family, model, options);
	}

	recordSuccess(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): void {
		this.rotation.recordSuccess(account, family, model);
	}

	recordRateLimit(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): void {
		this.rotation.recordRateLimit(account, family, model);
	}

	recordFailure(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): void {
		this.rotation.recordFailure(account, family, model);
	}

	consumeToken(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): boolean {
		return this.rotation.consumeToken(account, family, model);
	}

	refundToken(
		account: ManagedAccount,
		family: ModelFamily,
		model?: string | null,
	): boolean {
		return this.rotation.refundToken(account, family, model);
	}

	markRateLimited(
		account: ManagedAccount,
		retryAfterMs: number,
		family: ModelFamily,
		model?: string | null,
	): void {
		this.rotation.markRateLimited(account, retryAfterMs, family, model);
	}

	markRateLimitedWithReason(
		account: ManagedAccount,
		retryAfterMs: number,
		family: ModelFamily,
		reason: RateLimitReason,
		model?: string | null,
	): void {
		this.rotation.markRateLimitedWithReason(account, retryAfterMs, family, reason, model);
	}

	markAccountCoolingDown(
		account: ManagedAccount,
		cooldownMs: number,
		reason: CooldownReason,
	): void {
		this.rotation.markAccountCoolingDown(account, cooldownMs, reason);
	}

	markAccountsWithRefreshTokenCoolingDown(
		refreshToken: string,
		cooldownMs: number,
		reason: CooldownReason,
	): number {
		return this.rotation.markAccountsWithRefreshTokenCoolingDown(
			refreshToken,
			cooldownMs,
			reason,
		);
	}

	getMinWaitTime(): number {
		return this.rotation.getMinWaitTimeForFamily("codex");
	}

	getMinWaitTimeForFamily(family: ModelFamily, model?: string | null): number {
		return this.rotation.getMinWaitTimeForFamily(family, model);
	}

	// ----- persistence delegations -----

	async saveToDisk(): Promise<void> {
		await this.persistence.saveToDisk();
	}

	saveToDiskDebounced(delayMs = 500): void {
		this.persistence.saveToDiskDebounced(delayMs);
	}

	async flushPendingSave(): Promise<void> {
		await this.persistence.flushPendingSave();
	}

	disposeShutdownHandler(): void {
		this.persistence.disposeShutdownHandler();
	}

	// ----- recovery delegations -----

	async incrementAuthFailures(account: ManagedAccount): Promise<number> {
		return this.recovery.incrementAuthFailures(account);
	}

	getAuthFailures(account: ManagedAccount): number {
		return this.recovery.getAuthFailures(account);
	}

	clearAuthFailures(account: ManagedAccount): void {
		this.recovery.clearAuthFailures(account);
	}

	removeAccountsWithSameRefreshToken(account: ManagedAccount): number {
		return this.recovery.removeAccountsWithSameRefreshToken(account);
	}
}

export function formatAccountLabel(
	account: { email?: string; accountId?: string; accountLabel?: string } | undefined,
	index: number,
	options: { maskEmail?: boolean } = {},
): string {
	const accountLabel = account?.accountLabel?.trim();
	const email = resolveDisplayEmail(account?.email, options.maskEmail ?? false);
	const accountId = account?.accountId?.trim();
	const idSuffix = accountId
		? accountId.length > 6
			? accountId.slice(-6)
			: accountId
		: null;

	if (accountLabel && email && idSuffix) {
		return `Account ${index + 1} (${accountLabel}, ${email}, id:${idSuffix})`;
	}
	if (accountLabel && email) return `Account ${index + 1} (${accountLabel}, ${email})`;
	if (accountLabel && idSuffix) return `Account ${index + 1} (${accountLabel}, id:${idSuffix})`;
	if (accountLabel) return `Account ${index + 1} (${accountLabel})`;
	if (email && idSuffix) return `Account ${index + 1} (${email}, id:${idSuffix})`;
	if (email) return `Account ${index + 1} (${email})`;
	if (idSuffix) return `Account ${index + 1} (${idSuffix})`;
	return `Account ${index + 1}`;
}

export function formatCooldown(
	account: { coolingDownUntil?: number; cooldownReason?: string },
	now = nowMs(),
): string | null {
	if (typeof account.coolingDownUntil !== "number") return null;
	const remaining = account.coolingDownUntil - now;
	if (remaining <= 0) return null;
	const reason = account.cooldownReason ? ` (${account.cooldownReason})` : "";
	return `${formatWaitTime(remaining)}${reason}`;
}

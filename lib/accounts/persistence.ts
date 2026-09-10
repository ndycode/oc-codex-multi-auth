/**
 * Persistence surface for {@link AccountManager}: debounced disk saves,
 * pending-save coalescing, and shutdown-flush registration.
 *
 * All on-disk format concerns live in `lib/storage.ts`. This module owns the
 * *lifecycle* (when to save, how to flush before exit, how to dispose the
 * shutdown hook) rather than the serialization shape itself.
 */

import { createLogger } from "../logger.js";
import { MODEL_FAMILIES, type ModelFamily } from "../prompts/codex.js";
import { registerCleanup, unregisterCleanup } from "../shutdown.js";
import {
	withAccountStorageTransaction,
	type AccountMetadataV3,
	type AccountStorageV3,
} from "../storage.js";
import { getWorkspaceIdentityKey } from "../storage/identity.js";
import { nowMs } from "../utils.js";
import { clampNonNegativeInt } from "./rate-limits.js";
import type { AccountState } from "./state.js";

const log = createLogger("accounts");

/**
 * Upper bound the shutdown handler will wait for `flushPendingSave` so that a
 * jammed save cannot stall SIGINT/SIGTERM indefinitely.
 */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

export class AccountPersistence {
	private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingSave: Promise<void> | null = null;
	private shutdownHandler: (() => Promise<void>) | null = null;
	/**
	 * Set by {@link disposeShutdownHandler}. From that point this manager has
	 * been replaced, so its account list is no longer authoritative and every
	 * further write degrades to {@link mergeVolatileState}.
	 */
	private disposed = false;

	constructor(private readonly state: AccountState) {}

	async saveToDisk(): Promise<void> {
		const activeIndexByFamily: Partial<Record<ModelFamily, number>> = {};
		for (const family of MODEL_FAMILIES) {
			const raw = this.state.currentAccountIndexByFamily[family];
			activeIndexByFamily[family] = clampNonNegativeInt(raw, 0);
		}

		const activeIndex = clampNonNegativeInt(activeIndexByFamily.codex, 0);

		const storage: AccountStorageV3 = {
			version: 3,
			accounts: this.state.accounts.map((account) => ({
				accountId: account.accountId,
				accountUserId: account.accountUserId,
				organizationId: account.organizationId,
				accountIdSource: account.accountIdSource,
				accountLabel: account.accountLabel,
				planType: account.planType,
				accountTags: account.accountTags,
				accountNote: account.accountNote,
				email: account.email,
				refreshToken: account.refreshToken,
				accessToken: account.access,
				expiresAt: account.expires,
				oauthScope: account.oauthScope,
				tokenRotatedAt: account.tokenRotatedAt,
				enabled: account.enabled === false ? false : undefined,
				addedAt: account.addedAt,
				lastUsed: account.lastUsed,
				lastSwitchReason: account.lastSwitchReason,
				// Copied, not referenced: adoptLongerDiskRateLimits merges the
				// on-disk blocks into this payload, and it must not reach back
				// through a shared reference into live rotation state.
				rateLimitResetTimes:
					Object.keys(account.rateLimitResetTimes).length > 0
						? { ...account.rateLimitResetTimes }
						: undefined,
				quotaExhaustedUntil: account.quotaExhaustedUntil,
				coolingDownUntil: account.coolingDownUntil,
				cooldownReason: account.cooldownReason,
			})),
			activeIndex,
			activeIndexByFamily,
		};

		// Read-modify-write under the storage lock. A plain saveAccounts()
		// would blind-overwrite the file from this process's snapshot: fine
		// for the documented lost-write set (rotation/health/rate-limit
		// state), fatal for credentials — refresh tokens are single-use, so
		// clobbering another process's freshly-rotated token kills the
		// account permanently. Adopt any newer on-disk credentials before
		// persisting.
		await withAccountStorageTransaction(async (current, persist) => {
			if (this.disposed) {
				// Disposal landed while this save was already in flight — after
				// the timer had fired, so cancelling the timer could not stop it.
				// Its account list belongs to a manager that has been replaced,
				// so persisting it wholesale would delete whatever the successor
				// has since loaded or added. Degrade to the volatile merge, which
				// keeps the rate-limit and cooldown state this snapshot carries
				// without touching membership.
				if (current) await persist(this.mergeVolatileState(current));
				return;
			}
			if (current) {
				// Before adoptNewerDiskCredentials: for records without workspace
				// ids the refresh token participates in the identity key, and
				// adopting a rotated token would change which disk record this
				// account matches.
				this.adoptLongerDiskRateLimits(storage, current);
				this.adoptNewerDiskCredentials(storage, current);
			}
			await persist(storage);
		});
	}

	/**
	 * Persist only the volatile rotation state this manager holds: rate-limit
	 * blocks, cooldowns, and last-used stamps, each resolved to whichever side
	 * runs longer or later.
	 *
	 * Account membership, credentials, and the active-index routing are taken
	 * from `disk` untouched. That is what makes the write safe for a manager
	 * that has already been replaced: a 429 recorded on it still reaches disk,
	 * and it cannot delete an account its successor loaded or added.
	 *
	 * Live in-memory state is left alone for the same reason
	 * {@link adoptLongerDiskRateLimits} leaves it alone: a missing block is
	 * self-correcting from the next response's quota headers.
	 */
	private mergeVolatileState(disk: AccountStorageV3): AccountStorageV3 {
		const now = nowMs();
		const mineByIdentity = new Map<string, AccountState["accounts"][number]>();
		for (const account of this.state.accounts) {
			mineByIdentity.set(getWorkspaceIdentityKey(account), account);
		}

		return {
			...disk,
			accounts: disk.accounts.map((record) => {
				const mine = mineByIdentity.get(getWorkspaceIdentityKey(record));
				if (!mine) return record;
				const merged: AccountMetadataV3 = { ...record };

				// Longest-block-wins per quota key, matching adoptLongerDiskRateLimits.
				// Only blocks still in the future are carried, so an entry this
				// manager never pruned cannot resurrect an expired block.
				let resets: Record<string, number | undefined> | undefined;
				for (const [key, mineReset] of Object.entries(mine.rateLimitResetTimes ?? {})) {
					if (typeof mineReset !== "number" || !Number.isFinite(mineReset) || mineReset <= now) {
						continue;
					}
					const theirReset = record.rateLimitResetTimes?.[key];
					if (typeof theirReset === "number" && theirReset >= mineReset) continue;
					resets = { ...(resets ?? record.rateLimitResetTimes ?? {}), [key]: mineReset };
				}
				if (resets) merged.rateLimitResetTimes = resets;

				if (
					typeof mine.coolingDownUntil === "number" &&
					mine.coolingDownUntil > now &&
					mine.coolingDownUntil > (record.coolingDownUntil ?? 0)
				) {
					merged.coolingDownUntil = mine.coolingDownUntil;
					merged.cooldownReason = mine.cooldownReason;
				}

				// Account-wide quota exhaustion is monotonic like the per-family
				// blocks: keep whichever side's stamp runs longer.
				if (
					typeof mine.quotaExhaustedUntil === "number" &&
					mine.quotaExhaustedUntil > now &&
					mine.quotaExhaustedUntil > (record.quotaExhaustedUntil ?? 0)
				) {
					merged.quotaExhaustedUntil = mine.quotaExhaustedUntil;
				}

				if (typeof mine.lastUsed === "number" && mine.lastUsed > (record.lastUsed ?? 0)) {
					merged.lastUsed = mine.lastUsed;
					merged.lastSwitchReason = mine.lastSwitchReason ?? record.lastSwitchReason;
				}

				return merged;
			}),
		};
	}

	/**
	 * Merges still-active rate-limit blocks from `disk` into `outgoing`, keeping
	 * whichever block runs longer per quota key.
	 *
	 * Rate-limit state is otherwise last-writer-wins, which is fine for a 5h
	 * window that both processes rediscover within minutes. It is not fine for a
	 * quota block: a second opencode process holding a stale snapshot would save
	 * over the weekly block another process had just recorded, and the exhausted
	 * account would be back in rotation after the next reload (issue #218).
	 *
	 * Only blocks still in the future are adopted, so an expired entry another
	 * process has not pruned yet cannot be resurrected, and a block this process
	 * deliberately cleared stays cleared once it has elapsed. `codex-doctor --fix`
	 * is unaffected: it persists through its own storage transaction rather than
	 * this method.
	 *
	 * Live in-memory state is intentionally left alone — unlike a consumed
	 * refresh token, a missing block is self-correcting, since the very next
	 * response re-applies it from the quota headers.
	 */
	private adoptLongerDiskRateLimits(
		outgoing: AccountStorageV3,
		disk: AccountStorageV3,
	): void {
		const now = nowMs();
		const diskByIdentity = new Map<string, AccountMetadataV3>();
		for (const record of disk.accounts) {
			diskByIdentity.set(getWorkspaceIdentityKey(record), record);
		}

		for (const mine of outgoing.accounts) {
			if (!mine) continue;
			const theirs = diskByIdentity.get(getWorkspaceIdentityKey(mine));

			// Adopt a longer on-disk quota-exhaustion stamp for the same reason the
			// per-family blocks below are adopted (#218): a second process may have
			// recorded a week-long block after this one loaded. Handled before the
			// `theirResets` guard so a disk record carrying only a quota stamp is
			// not skipped.
			const theirQuota = theirs?.quotaExhaustedUntil;
			if (
				typeof theirQuota === "number" &&
				Number.isFinite(theirQuota) &&
				theirQuota > now &&
				theirQuota > (mine.quotaExhaustedUntil ?? 0)
			) {
				mine.quotaExhaustedUntil = theirQuota;
			}
			const theirResets = theirs?.rateLimitResetTimes;
			if (!theirResets) continue;

			for (const [key, theirReset] of Object.entries(theirResets)) {
				if (
					typeof theirReset !== "number" ||
					!Number.isFinite(theirReset) ||
					theirReset <= now
				) {
					continue;
				}
				const myReset = mine.rateLimitResetTimes?.[key];
				if (typeof myReset === "number" && myReset >= theirReset) continue;
				mine.rateLimitResetTimes = {
					...(mine.rateLimitResetTimes ?? {}),
					[key]: theirReset,
				};
			}
		}
	}

	/**
	 * Merges credentials from `disk` into `outgoing` (and the live in-memory
	 * accounts) for every account whose on-disk refresh token differs and
	 * carries a NEWER `tokenRotatedAt` stamp — i.e. another process rotated
	 * the token after this process loaded its snapshot. Records without a
	 * stamp (pre-upgrade files) keep this process's value, matching the old
	 * behavior. Only credential fields are merged; rotation/health/rate-limit
	 * state intentionally stays last-writer-wins.
	 */
	private adoptNewerDiskCredentials(
		outgoing: AccountStorageV3,
		disk: AccountStorageV3,
	): void {
		const diskByIdentity = new Map<string, AccountMetadataV3>();
		for (const record of disk.accounts) {
			diskByIdentity.set(getWorkspaceIdentityKey(record), record);
		}

		for (let i = 0; i < outgoing.accounts.length; i++) {
			const mine = outgoing.accounts[i];
			if (!mine) continue;
			const theirs = diskByIdentity.get(getWorkspaceIdentityKey(mine));
			if (!theirs?.refreshToken || theirs.refreshToken === mine.refreshToken) {
				continue;
			}
			if ((theirs.tokenRotatedAt ?? 0) <= (mine.tokenRotatedAt ?? 0)) {
				continue;
			}

			const mineIdentity = getWorkspaceIdentityKey(mine);
			mine.refreshToken = theirs.refreshToken;
			mine.accessToken = theirs.accessToken;
			mine.expiresAt = theirs.expiresAt;
			// Truthy, not `??`: a legacy record can hold an empty-string scope, and
			// `??` would let it overwrite a good in-memory value. Matches the live
			// mirror below (issue #213).
			mine.oauthScope = theirs.oauthScope || mine.oauthScope;
			mine.tokenRotatedAt = theirs.tokenRotatedAt;

			// Mirror into live state so this process stops refreshing with the
			// consumed token. Matched by identity key rather than array index:
			// outgoing is currently built from state.accounts in order, but the
			// mirror must not silently target the wrong account if that ever
			// changes. The identity key is computed from `mine` BEFORE the
			// credential adoption above, since the token participates in the
			// key for records without workspace ids.
			const live = this.state.accounts.find(
				(candidate) => getWorkspaceIdentityKey(candidate) === mineIdentity,
			);
			if (live) {
				live.refreshToken = theirs.refreshToken;
				live.access = theirs.accessToken;
				live.expires = theirs.expiresAt;
				if (theirs.oauthScope) live.oauthScope = theirs.oauthScope;
				live.tokenRotatedAt = theirs.tokenRotatedAt;
			}

			log.info("Adopted newer on-disk credentials during save", {
				accountIndex: i,
				rotatedAt: theirs.tokenRotatedAt,
			});
		}
	}

	/**
	 * A disposed manager still accepts saves. `index.ts` hands the request
	 * pipeline a manager reference and swaps the cached instance underneath it,
	 * so an in-flight request records its 429 block on the outgoing manager
	 * after the reload has already flushed and disposed it. Refusing the write
	 * there would lose the block entirely — the account would be handed straight
	 * back to rotation for another 429. `saveToDisk` routes it through
	 * {@link mergeVolatileState} instead, which is safe to run at any time.
	 */
	saveToDiskDebounced(delayMs = 500): void {
		if (!this.disposed) this.ensureShutdownFlushRegistered();
		if (this.saveDebounceTimer) {
			clearTimeout(this.saveDebounceTimer);
		}
		this.saveDebounceTimer = setTimeout(() => {
			this.saveDebounceTimer = null;
			const doSave = async () => {
				try {
					if (this.pendingSave) {
						await this.pendingSave;
					}
					this.pendingSave = this.saveToDisk().finally(() => {
						this.pendingSave = null;
					});
					await this.pendingSave;
				} catch (error) {
					log.warn("Debounced save failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			};
			void doSave();
		}, delayMs);
	}

	async flushPendingSave(): Promise<void> {
		if (this.saveDebounceTimer) {
			clearTimeout(this.saveDebounceTimer);
			this.saveDebounceTimer = null;
			await this.saveToDisk();
		}
		if (this.pendingSave) {
			await this.pendingSave;
		}
	}

	/**
	 * Registers a process-shutdown cleanup that awaits any pending debounced
	 * save. Without this, a rotation queued inside the 500ms debounce window
	 * would be lost when SIGINT/SIGTERM fires before the timer resolves.
	 * Registration is lazy (only when `saveToDiskDebounced` is first invoked)
	 * so idle managers do not leak handlers into the shutdown queue.
	 */
	private ensureShutdownFlushRegistered(): void {
		if (this.shutdownHandler) return;
		const handler = async (): Promise<void> => {
			// One-shot: clear the slot first so that if `runCleanup()` fires
			// externally (e.g. tests reusing a manager across cycles, or any
			// other caller that drains the global cleanup queue), a subsequent
			// `saveToDiskDebounced()` can re-register a fresh handler. Without
			// this the guard above returns early and the next pending save
			// goes unprotected on shutdown.
			this.shutdownHandler = null;
			let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
			try {
				await Promise.race([
					this.flushPendingSave(),
					new Promise<void>((_resolve, reject) => {
						timeoutTimer = setTimeout(() => {
							reject(
								new Error(
									`flushPendingSave timed out after ${SHUTDOWN_FLUSH_TIMEOUT_MS}ms`,
								),
							);
						}, SHUTDOWN_FLUSH_TIMEOUT_MS);
					}),
				]);
			} catch (error) {
				log.warn("Shutdown flush failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				if (timeoutTimer) clearTimeout(timeoutTimer);
			}
		};
		this.shutdownHandler = handler;
		registerCleanup(handler);
	}

	/**
	 * Tears down this manager's process-level side effects. Call this when
	 * replacing an `AccountManager` instance (e.g., on cache invalidation) to
	 * avoid unbounded growth of the global cleanup queue.
	 *
	 * From here on this manager's account list is no longer authoritative.
	 * `saveToDisk` takes membership from that list wholesale — it adopts newer
	 * credentials and longer rate-limit blocks from disk, but never disk
	 * accounts the list lacks — so a replaced manager writing it 500ms later
	 * would delete whatever its successor has since loaded or added.
	 *
	 * Neither the queued timer nor an already-started save is cancelled, which
	 * would drop real state: the only save a cancel can still reach is one
	 * armed *after* the caller's flush, and that is the fresh rate-limit or
	 * cooldown block an in-flight request just recorded, not a stale rotation
	 * stamp. Both paths are marked instead, and `saveToDisk` degrades them to
	 * {@link mergeVolatileState}: the block lands, membership stays as the
	 * successor left it. Marking rather than cancelling is also what covers the
	 * save that had already begun by the time this ran, which a `clearTimeout`
	 * cannot touch at all.
	 *
	 * The flag is set before the handler guard because the handler is one-shot —
	 * it clears its own slot when it runs, so a manager whose shutdown flush has
	 * already fired must still be marked here.
	 */
	disposeShutdownHandler(): void {
		this.disposed = true;
		if (!this.shutdownHandler) return;
		unregisterCleanup(this.shutdownHandler);
		this.shutdownHandler = null;
	}
}

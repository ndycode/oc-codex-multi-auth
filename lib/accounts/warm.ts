/**
 * Account "warm-up" orchestrator (issue #182).
 *
 * Sends one minimal request to each enabled account so its rolling usage
 * window (the ~5h ChatGPT/Codex quota window) starts ticking immediately,
 * rather than only when the rotation eventually lands on that account. This
 * lets users prime every account at the start of a session ("send a hi to each
 * account") instead of waiting for the current account to run dry.
 *
 * This module is intentionally pure: it contains the iteration, outcome
 * classification, and summary logic, but performs no network or auth I/O
 * itself. The real upstream call is injected as `warmOne`, which keeps this
 * logic fully deterministic and unit-testable, and keeps the network-touching
 * adapter isolated in the `codex-warm` tool. The split mirrors how
 * `lib/rotation.ts` (pure selection) is separated from `lib/accounts/rotation.ts`
 * (the manager-facing wrapper).
 */

/**
 * Per-account result of a warm attempt.
 *
 * - `warmed`: the upstream request succeeded; the window is now open.
 * - `failed`: the upstream request was attempted but errored (auth invalid,
 *   network error, upstream 5xx, etc.). `detail` carries a short reason.
 * - `skipped`: the account was not attempted (e.g. disabled). `detail` says why.
 */
export type WarmStatus = "warmed" | "failed" | "skipped";

export interface WarmOutcome {
	status: WarmStatus;
	/** Short human-readable reason, primarily for `failed` / `skipped`. */
	detail?: string;
}

/** A warm result paired with the account it belongs to. */
export interface WarmAccountResult<A> {
	account: A;
	/** Zero-based position in the input list (stable for display ordering). */
	index: number;
	status: WarmStatus;
	detail?: string;
}

export interface WarmSummary<A> {
	results: WarmAccountResult<A>[];
	warmedCount: number;
	failedCount: number;
	skippedCount: number;
	/** Total accounts considered (= results.length). */
	total: number;
}

export interface WarmAccountsOptions {
	/**
	 * Run warm attempts concurrently (default) or strictly one at a time.
	 * Sequential mode is useful when the caller wants to avoid bursting the
	 * upstream with parallel requests. Defaults to `true` (concurrent).
	 */
	concurrent?: boolean;
}

/**
 * Decide whether an account should be warmed at all.
 * Disabled accounts are skipped; everything else is attempted.
 */
function shouldSkip<A extends { enabled?: boolean }>(account: A): boolean {
	return account.enabled === false;
}

/**
 * Warm every account in `accounts` by invoking `warmOne` on each one that is
 * eligible, then summarize the outcomes.
 *
 * `warmOne` must resolve (never reject) — but to be defensive against an
 * injected function that throws or rejects, any thrown error is captured and
 * recorded as a `failed` outcome so a single bad account can never abort the
 * whole batch.
 *
 * The returned `results` array preserves the input order regardless of
 * concurrency, so display output is deterministic.
 */
export async function warmAccounts<A extends { enabled?: boolean }>(
	accounts: readonly A[],
	warmOne: (account: A, index: number) => Promise<WarmOutcome>,
	options: WarmAccountsOptions = {},
): Promise<WarmSummary<A>> {
	const concurrent = options.concurrent ?? true;

	const runOne = async (account: A, index: number): Promise<WarmAccountResult<A>> => {
		if (shouldSkip(account)) {
			return { account, index, status: "skipped", detail: "disabled" };
		}
		try {
			const outcome = await warmOne(account, index);
			return { account, index, status: outcome.status, detail: outcome.detail };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { account, index, status: "failed", detail };
		}
	};

	let results: WarmAccountResult<A>[];
	if (concurrent) {
		results = await Promise.all(accounts.map((account, index) => runOne(account, index)));
	} else {
		results = [];
		for (let index = 0; index < accounts.length; index++) {
			// Non-null: index is bounded by accounts.length.
			const account = accounts[index] as A;
			results.push(await runOne(account, index));
		}
	}

	// Preserve input order even though Promise.all already does; explicit for
	// safety against future refactors to the concurrent branch.
	results.sort((a, b) => a.index - b.index);

	let warmedCount = 0;
	let failedCount = 0;
	let skippedCount = 0;
	for (const result of results) {
		if (result.status === "warmed") warmedCount++;
		else if (result.status === "failed") failedCount++;
		else skippedCount++;
	}

	return {
		results,
		warmedCount,
		failedCount,
		skippedCount,
		total: results.length,
	};
}

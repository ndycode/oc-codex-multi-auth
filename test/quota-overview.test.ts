import { describe, expect, it } from "vitest";

import { getQuotaStatus } from "../lib/config.js";
import { PluginConfigSchema } from "../lib/schemas.js";
import {
	computePoolAllotment,
	computeWeightedLeftPercent,
	formatCompactDuration,
	formatQuotaOverviewCandidates,
	formatQuotaOverviewText,
	formatQuotaResetsCandidates,
	isPoolFullySpent,
	orderOverviewAccounts,
	resolveAccountName,
	resolveGoverningWindow,
	resolveQuotaOverviewRecovery,
	resolveQuotaOverviewTonePercent,
	type QuotaOverviewAccount,
	type QuotaOverviewOptions,
} from "../lib/quota-overview.js";

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const allOff: Omit<QuotaOverviewOptions, "mode"> = {
	layout: "count",
	names: "number",
	order: "number",
	multipliers: false,
	allotment: false,
	resetTimes: "never",
	resetCredits: false,
	recovery: false,
	now: NOW,
};

function options(overrides: Partial<QuotaOverviewOptions> = {}): QuotaOverviewOptions {
	return { mode: "free", ...allOff, ...overrides };
}

/** The pool from the issue: a 5x seat, a spent 20x seat, and a 1x seat. */
const pool: QuotaOverviewAccount[] = [
	{
		index: 1,
		planType: "self_serve_business_prolite",
		windows: [{ leftPercent: 87, resetAtMs: NOW + 2 * DAY }],
	},
	{
		index: 2,
		planType: "pro",
		resetCredits: 1,
		windows: [
			{ leftPercent: 100, resetAtMs: NOW + 4 * HOUR },
			{ leftPercent: 0, resetAtMs: NOW + 3 * DAY },
		],
	},
	{
		index: 3,
		planType: "plus",
		windows: [{ leftPercent: 88, resetAtMs: NOW + 5 * DAY }],
	},
];

/** Nothing left anywhere, and two accounts holding a redeemable reset. */
const spentPool: QuotaOverviewAccount[] = [
	{
		index: 1,
		planType: "plus",
		email: "damian@nowaker.net",
		resetCredits: 1,
		windows: [{ leftPercent: 0, resetAtMs: NOW + 3 * DAY }],
	},
	{
		index: 2,
		planType: "plus",
		email: "work@example.com",
		resetCredits: 2,
		windows: [{ leftPercent: 0, resetAtMs: NOW + 4 * DAY }],
	},
	{
		index: 3,
		planType: "plus",
		email: "spare@example.com",
		windows: [{ leftPercent: 0, resetAtMs: NOW + 5 * DAY }],
	},
];

describe("formatCompactDuration", () => {
	it("floors to the largest unit that fits", () => {
		expect(formatCompactDuration(3 * DAY)).toBe("3d");
		expect(formatCompactDuration(2 * DAY + 20 * HOUR)).toBe("2d");
		expect(formatCompactDuration(5 * HOUR)).toBe("5h");
		expect(formatCompactDuration(90 * 60 * 1000)).toBe("1h");
		expect(formatCompactDuration(15 * 60 * 1000)).toBe("15m");
	});

	it("never counts a future reset as zero away", () => {
		expect(formatCompactDuration(1)).toBe("1m");
	});

	it("drops a reset already in the past", () => {
		expect(formatCompactDuration(0)).toBeUndefined();
		expect(formatCompactDuration(-DAY)).toBeUndefined();
		expect(formatCompactDuration(Number.NaN)).toBeUndefined();
	});
});

describe("resolveGoverningWindow", () => {
	it("picks the window with the least headroom", () => {
		expect(resolveGoverningWindow(pool[1]!)?.leftPercent).toBe(0);
	});

	it("breaks a tie on the window that blocks for longer", () => {
		const account: QuotaOverviewAccount = {
			index: 1,
			windows: [
				{ leftPercent: 0, resetAtMs: NOW + 4 * HOUR },
				{ leftPercent: 0, resetAtMs: NOW + 3 * DAY },
			],
		};
		expect(resolveGoverningWindow(account)?.resetAtMs).toBe(NOW + 3 * DAY);
	});

	it("ignores windows with no readable percentage", () => {
		const account: QuotaOverviewAccount = {
			index: 1,
			windows: [{ resetAtMs: NOW + HOUR }, { leftPercent: 40 }],
		};
		expect(resolveGoverningWindow(account)?.leftPercent).toBe(40);
	});

	it("returns nothing when no window is readable", () => {
		expect(resolveGoverningWindow({ index: 1, windows: [] })).toBeUndefined();
	});
});

describe("computeWeightedLeftPercent", () => {
	it("weighs each account by its plan allotment", () => {
		// (5*87 + 20*0 + 1*88) / 26 = 20.1
		expect(computeWeightedLeftPercent(pool)).toBe(20);
	});

	it("differs from the unweighted mean, which is the point", () => {
		const unweighted = Math.round((87 + 0 + 88) / 3);
		expect(unweighted).toBe(58);
		expect(computeWeightedLeftPercent(pool)).not.toBe(unweighted);
	});

	it("weighs a plan that states no ratio as one baseline seat", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "enterprise", windows: [{ leftPercent: 50 }] },
			{ index: 2, planType: "plus", windows: [{ leftPercent: 100 }] },
		];
		expect(computeWeightedLeftPercent(accounts)).toBe(75);
	});

	it("leaves an unreadable account out rather than counting it as full", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", windows: [{ leftPercent: 40 }] },
			{ index: 2, planType: "plus", windows: [] },
		];
		expect(computeWeightedLeftPercent(accounts)).toBe(40);
	});

	it("reports nothing when the whole pool is unreadable", () => {
		expect(computeWeightedLeftPercent([{ index: 1, windows: [] }])).toBeUndefined();
	});
});

describe("computePoolAllotment", () => {
	it("adds up the seats the percentage is averaged over", () => {
		expect(computePoolAllotment(pool)).toBe(26);
	});

	it("counts exactly the accounts the mean counts", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "pro", windows: [{ leftPercent: 40 }] },
			{ index: 2, planType: "pro", windows: [] },
		];
		expect(computePoolAllotment(accounts)).toBe(20);
	});

	it("reports nothing for an unreadable pool", () => {
		expect(computePoolAllotment([{ index: 1, windows: [] }])).toBeUndefined();
	});
});

describe("resolveQuotaOverviewRecovery", () => {
	it("ignores a refill that leaves the account's governing window spent", () => {
		// Account 2's 5h window is already full, so the earliest reset that
		// changes anything is its weekly one three days out.
		const recovery = resolveQuotaOverviewRecovery(pool, NOW);
		expect(recovery?.atMs).toBe(NOW + 2 * DAY);
	});

	it("measures how far the pool total moves", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", windows: [{ leftPercent: 0, resetAtMs: NOW + DAY }] },
			{ index: 2, planType: "plus", windows: [{ leftPercent: 50 }] },
		];
		// 25% now, 75% once account 1 refills.
		expect(resolveQuotaOverviewRecovery(accounts, NOW)).toEqual({
			deltaPercent: 50,
			atMs: NOW + DAY,
		});
	});

	it("reports nothing when no window has a future reset", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", windows: [{ leftPercent: 0, resetAtMs: NOW - DAY }] },
		];
		expect(resolveQuotaOverviewRecovery(accounts, NOW)).toBeUndefined();
	});

	it("reports nothing when every account is already full", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", windows: [{ leftPercent: 100, resetAtMs: NOW + DAY }] },
		];
		expect(resolveQuotaOverviewRecovery(accounts, NOW)).toBeUndefined();
	});
});

describe("isPoolFullySpent", () => {
	it("is true only when nothing has headroom", () => {
		expect(isPoolFullySpent(spentPool)).toBe(true);
		expect(isPoolFullySpent(pool)).toBe(false);
	});

	it("is not decided by an account nobody could read", () => {
		expect(
			isPoolFullySpent([
				{ index: 1, windows: [{ leftPercent: 0 }] },
				{ index: 2, windows: [] },
			]),
		).toBe(true);
		expect(isPoolFullySpent([{ index: 1, windows: [] }])).toBe(false);
	});
});

describe("orderOverviewAccounts", () => {
	const indices = (order: QuotaOverviewOptions["order"]) =>
		orderOverviewAccounts(pool, order).map((account) => account.index);

	it("keeps account order by default", () => {
		expect(indices("number")).toEqual([1, 2, 3]);
	});

	it("puts the account rotation is about to give up on first", () => {
		expect(indices("most-used")).toEqual([2, 1, 3]);
		expect(indices("least-used")).toEqual([3, 1, 2]);
	});

	it("orders by the governing window's reset in both directions", () => {
		expect(indices("renewing-earliest")).toEqual([1, 2, 3]);
		expect(indices("renewing-latest")).toEqual([3, 2, 1]);
	});

	it("breaks every tie on the account number, so nothing shuffles", () => {
		const tied: QuotaOverviewAccount[] = [
			{ index: 3, planType: "plus", windows: [{ leftPercent: 50 }] },
			{ index: 1, planType: "plus", windows: [{ leftPercent: 50 }] },
			{ index: 2, planType: "plus", windows: [{ leftPercent: 50 }] },
		];
		for (const order of ["most-used", "least-used", "renewing-latest"] as const) {
			expect(orderOverviewAccounts(tied, order).map((a) => a.index)).toEqual([
				1, 2, 3,
			]);
		}
	});

	it("sorts an account with no known reset last, whichever way it is asked", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", windows: [{ leftPercent: 10 }] },
			{ index: 2, planType: "plus", windows: [{ leftPercent: 10, resetAtMs: NOW + DAY }] },
		];
		expect(
			orderOverviewAccounts(accounts, "renewing-earliest").map((a) => a.index),
		).toEqual([2, 1]);
		expect(
			orderOverviewAccounts(accounts, "renewing-latest").map((a) => a.index),
		).toEqual([2, 1]);
	});
});

describe("resolveAccountName", () => {
	it("numbers an account the way codex-switch does", () => {
		expect(resolveAccountName(pool[0]!, "number")).toBe("#1");
	});

	it("shows nothing at all when asked for nothing", () => {
		expect(resolveAccountName(pool[0]!, "none")).toBeUndefined();
	});

	it("prefers a label the user set", () => {
		expect(
			resolveAccountName({ ...spentPool[0]!, label: "work" }, "label"),
		).toBe("work");
	});

	it("falls back to the part of the email a person says out loud", () => {
		expect(resolveAccountName(spentPool[0]!, "label")).toBe("damian");
	});

	it("masks that fallback when emails are masked", () => {
		expect(resolveAccountName(spentPool[0]!, "label", true)).toBe("da***");
	});

	it("treats an email stored as the label as an email", () => {
		expect(
			resolveAccountName({ index: 4, label: "someone@example.com", windows: [] }, "label"),
		).toBe("someone");
	});

	it("falls back to the number rather than rendering an empty segment", () => {
		expect(resolveAccountName({ index: 7, windows: [] }, "label")).toBe("#7");
	});
});

describe("formatQuotaOverviewText", () => {
	const breakdown = {
		layout: "accounts",
		resetTimes: "low",
	} as const;

	it("renders the fullest form as headroom left", () => {
		expect(
			formatQuotaOverviewText(
				pool,
				options({ ...breakdown, multipliers: true, resetCredits: true }),
			),
		).toBe("20%: #1 5x 87%, #2 20x 0% 3d 1r, #3 1x 88%");
	});

	it("inverts every percentage under `used`", () => {
		expect(
			formatQuotaOverviewText(
				pool,
				options({
					...breakdown,
					mode: "used",
					multipliers: true,
					resetCredits: true,
				}),
			),
		).toBe("80%: #1 5x 13%, #2 20x 100% 3d 1r, #3 1x 12%");
	});

	it("drops the badges without dropping the accounts", () => {
		expect(
			formatQuotaOverviewText(pool, options({ ...breakdown, mode: "used" })),
		).toBe("80%: #1 13%, #2 100% 3d, #3 12%");
	});

	it("collapses to a count when the breakdown is switched off", () => {
		expect(formatQuotaOverviewText(pool, options({ mode: "used" }))).toBe(
			"80%: 3 accounts",
		);
	});

	it("adds the recovery clause with the sign the reading moves in", () => {
		// Account 1 refills first, from 87% to full: a 5x seat moving 13 points
		// lifts a pool weighted 5:20:1 by three.
		expect(formatQuotaOverviewText(pool, options({ recovery: true }))).toBe(
			"20%: 3 accounts, +3% in 2d",
		);
		expect(
			formatQuotaOverviewText(pool, options({ mode: "used", recovery: true })),
		).toBe("80%: 3 accounts, -3% in 2d");
	});

	it("prints a reset only for an account near exhaustion", () => {
		expect(formatQuotaOverviewText(pool, options(breakdown))).toBe(
			"20%: #1 87%, #2 0% 3d, #3 88%",
		);
	});

	it("prints every reset when asked, because 90% spent is not one situation", () => {
		expect(
			formatQuotaOverviewText(
				pool,
				options({ layout: "accounts", resetTimes: "always" }),
			),
		).toBe("20%: #1 87% 2d, #2 0% 3d, #3 88% 5d");
	});

	it("prints no reset at all when asked for none", () => {
		expect(
			formatQuotaOverviewText(
				pool,
				options({ layout: "accounts", resetTimes: "never" }),
			),
		).toBe("20%: #1 87%, #2 0%, #3 88%");
	});

	it("states what the pool adds up to when asked", () => {
		expect(
			formatQuotaOverviewText(pool, options({ ...breakdown, allotment: true })),
		).toBe("20% of 26x: #1 87%, #2 0% 3d, #3 88%");
	});

	it("drops the account names when asked, leaving position to identify them", () => {
		expect(
			formatQuotaOverviewText(
				pool,
				options({ ...breakdown, mode: "used", names: "none" }),
			),
		).toBe("80%: 13%, 100% 3d, 12%");
	});

	it("names accounts the way their owner does", () => {
		expect(
			formatQuotaOverviewText(
				spentPool,
				options({ layout: "accounts", names: "label", mode: "used" }),
			),
		).toBe("100%: damian 100%, work 100%, spare 100%");
	});

	it("reorders the accounts without renumbering them", () => {
		expect(
			formatQuotaOverviewText(
				pool,
				options({ ...breakdown, mode: "used", order: "most-used" }),
			),
		).toBe("80%: #2 100% 3d, #1 13%, #3 12%");
	});

	it("omits a zero reset-credit count", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", resetCredits: 0, windows: [{ leftPercent: 40 }] },
		];
		expect(
			formatQuotaOverviewText(
				accounts,
				options({ layout: "accounts", resetCredits: true }),
			),
		).toBe("40%: #1 40%");
	});

	it("says `1 account` rather than `1 accounts`", () => {
		const accounts: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", windows: [{ leftPercent: 40 }] },
		];
		expect(formatQuotaOverviewText(accounts, options())).toBe("40%: 1 account");
	});

	it("renders nothing when the pool cannot be read", () => {
		expect(formatQuotaOverviewText([], options({ layout: "accounts" }))).toBe("");
	});
});

describe("formatQuotaOverviewText with the aggregate layout", () => {
	/** Two accounts with room and three spent, which is what grouping is for. */
	const mixed: QuotaOverviewAccount[] = [
		{ index: 1, planType: "plus", windows: [{ leftPercent: 88, resetAtMs: NOW + 3 * DAY }] },
		{ index: 2, planType: "plus", windows: [{ leftPercent: 50, resetAtMs: NOW + 4 * DAY }] },
		{
			index: 3,
			planType: "plus",
			resetCredits: 1,
			windows: [{ leftPercent: 0, resetAtMs: NOW + 3 * DAY }],
		},
		{ index: 4, planType: "plus", windows: [{ leftPercent: 0, resetAtMs: NOW + 4 * DAY }] },
		{ index: 5, planType: "plus", windows: [{ leftPercent: 0, resetAtMs: NOW + 5 * DAY }] },
	];

	it("says a shared percentage once and keeps what differs", () => {
		expect(
			formatQuotaOverviewText(
				mixed,
				options({
					layout: "aggregate",
					mode: "used",
					resetTimes: "always",
					resetCredits: true,
				}),
			),
		).toBe("72%: 12% 3d, 50% 4d, 100% 3d 1r 4d 5d");
	});

	it("counts a group whose annotations would not reveal its size", () => {
		const withoutReset = mixed.map((account) =>
			account.index === 3
				? { ...account, resetCredits: undefined, windows: [{ leftPercent: 0 }] }
				: account,
		);
		expect(
			formatQuotaOverviewText(
				withoutReset,
				options({ layout: "aggregate", mode: "used", resetTimes: "always" }),
			),
		).toBe("72%: 12% 3d, 50% 4d, 100% x3 4d 5d");
	});

	it("never counts a group of one", () => {
		expect(
			formatQuotaOverviewText(
				pool,
				options({ layout: "aggregate", mode: "used", resetTimes: "low" }),
			),
		).toBe("80%: 13%, 100% 3d, 12%");
	});
});

describe("formatQuotaOverviewCandidates", () => {
	it("degrades detail before it degrades the pool total", () => {
		const candidates = formatQuotaOverviewCandidates(
			pool,
			options({
				layout: "accounts",
				multipliers: true,
				resetTimes: "low",
				resetCredits: true,
				recovery: true,
			}),
		);
		expect(candidates[0]).toContain("5x");
		expect(candidates[0]).toContain(" in ");
		expect(candidates.at(-1)).toBe("20%");
		for (const candidate of candidates) expect(candidate.startsWith("20%")).toBe(true);
		expect(new Set(candidates).size).toBe(candidates.length);
		const firstWithoutBreakdown = candidates.findIndex((candidate) =>
			candidate.includes("accounts"),
		);
		const lastWithBreakdown = candidates.findLastIndex((candidate) =>
			candidate.includes("#1"),
		);
		expect(lastWithBreakdown).toBeLessThan(firstWithoutBreakdown);
	});

	it("never reintroduces a switch that is off", () => {
		const candidates = formatQuotaOverviewCandidates(
			pool,
			options({ layout: "accounts", resetTimes: "low" }),
		);
		for (const candidate of candidates) {
			expect(candidate).not.toContain("5x");
			expect(candidate).not.toContain("1r");
			expect(candidate).not.toContain(" in ");
			expect(candidate).not.toContain(" of ");
		}
	});

	it("gives up the word `in` before it gives up the recovery clause", () => {
		const candidates = formatQuotaOverviewCandidates(
			pool,
			options({ recovery: true }),
		);
		const wordy = candidates.indexOf("20%: 3 accounts, +3% in 2d");
		const terse = candidates.indexOf("20%: 3 accounts, +3% 2d");
		const without = candidates.indexOf("20%: 3 accounts");
		expect(wordy).toBeGreaterThanOrEqual(0);
		expect(terse).toBeGreaterThan(wordy);
		expect(without).toBeGreaterThan(terse);
	});

	it("shortens the count word before dropping it, then drops it", () => {
		const candidates = formatQuotaOverviewCandidates(pool, options());
		expect(candidates).toEqual([
			"20%: 3 accounts",
			"20%: 3 acct.",
			"20%: 3",
			"20%",
		]);
	});

	it("gives up the pool allotment before any account detail", () => {
		const candidates = formatQuotaOverviewCandidates(
			pool,
			options({ layout: "accounts", allotment: true }),
		);
		const withAllotment = candidates.indexOf("20% of 26x: #1 87%, #2 0%, #3 88%");
		const withoutAllotment = candidates.indexOf("20%: #1 87%, #2 0%, #3 88%");
		const count = candidates.indexOf("20% of 26x: 3 accounts");
		expect(withAllotment).toBeGreaterThanOrEqual(0);
		expect(withoutAllotment).toBe(withAllotment + 1);
		expect(count).toBeGreaterThan(withoutAllotment);
	});

	it("offers an unnamed breakdown as the last rung above the count", () => {
		const candidates = formatQuotaOverviewCandidates(
			pool,
			options({ layout: "accounts", resetTimes: "never" }),
		);
		const unnamed = candidates.indexOf("20%: 87%, 0%, 88%");
		const count = candidates.indexOf("20%: 3 accounts");
		expect(unnamed).toBeGreaterThanOrEqual(0);
		expect(unnamed).toBeLessThan(count);
	});

	it("refuses to drop the names when position no longer identifies an account", () => {
		for (const overrides of [
			{ order: "most-used" as const },
			{},
		]) {
			const accounts =
				"order" in overrides
					? pool
					: [...pool, { index: 4, planType: "plus", windows: [] }];
			const candidates = formatQuotaOverviewCandidates(
				accounts,
				options({ layout: "accounts", resetTimes: "never", ...overrides }),
			);
			expect(candidates.some((candidate) => /: \d+%/.test(candidate))).toBe(false);
		}
	});

	it("refuses to drop the names when the account numbers skip one", () => {
		// A deduplicated or disabled seat leaves a pool reading #1 and #3: an
		// unnamed `60%, 10%` would pin #3's figure on a #2 that is not there.
		const gapped: QuotaOverviewAccount[] = [
			{ index: 1, planType: "plus", windows: [{ leftPercent: 60 }] },
			{ index: 3, planType: "plus", windows: [{ leftPercent: 10 }] },
		];
		const candidates = formatQuotaOverviewCandidates(
			gapped,
			options({ layout: "accounts", names: "none", resetTimes: "never" }),
		);
		// An explicit names:"none" is the user's choice; the ladder must not
		// reach it on its own when position would misattribute. With the
		// default number names, the breakdown keeps its `#n` and the count is
		// the next thing down.
		const named = formatQuotaOverviewCandidates(
			gapped,
			options({ layout: "accounts", resetTimes: "never" }),
		);
		expect(candidates[0]).toBe("35%: 60%, 10%");
		expect(named).toContain("35%: #1 60%, #3 10%");
		expect(named.some((candidate) => /: \d+%/.test(candidate))).toBe(false);
		expect(named).toContain("35%: 2 accounts");
	});

	it("counts the whole pool, not just the accounts that could be read", () => {
		const candidates = formatQuotaOverviewCandidates(
			[...pool, { index: 4, planType: "plus", windows: [] }],
			options(),
		);
		expect(candidates).toContain("20%: 4 accounts");
		expect(candidates).not.toContain("20%: 3 accounts");
	});

	it("shortens a long name to the number before giving up on names", () => {
		const candidates = formatQuotaOverviewCandidates(
			spentPool,
			options({ layout: "accounts", names: "label", mode: "used" }),
		);
		const named = candidates.indexOf("100%: damian 100%, work 100%, spare 100%");
		const numbered = candidates.indexOf("100%: #1 100%, #2 100%, #3 100%");
		expect(named).toBe(0);
		expect(numbered).toBeGreaterThan(named);
	});
});

describe("formatQuotaResetsCandidates", () => {
	it("lists the redeemable credits latest reset first", () => {
		expect(formatQuotaResetsCandidates(spentPool, { now: NOW })[0]).toBe(
			"Free resets: 4d 2r work@example.com, 3d 1r damian@nowaker.net",
		);
	});

	it("says nothing while any account still has headroom", () => {
		expect(formatQuotaResetsCandidates(pool, { now: NOW })).toEqual([]);
	});

	it("says nothing when the spent pool has no credit to redeem", () => {
		const withoutCredits = spentPool.map((account) => ({
			...account,
			resetCredits: undefined,
		}));
		expect(formatQuotaResetsCandidates(withoutCredits, { now: NOW })).toEqual([]);
	});

	it("gives up the word `Free` before any account detail", () => {
		const candidates = formatQuotaResetsCandidates(spentPool, { now: NOW });
		expect(candidates[1]).toBe(
			"Resets: 4d 2r work@example.com, 3d 1r damian@nowaker.net",
		);
		expect(candidates[2]).toBe("Resets: 4d 2r work, 3d 1r damian");
		expect(candidates[3]).toBe("Resets: 4d 2r #2, 3d 1r #1");
	});

	it("keeps the countdown until every identity form has been tried", () => {
		const candidates = formatQuotaResetsCandidates(spentPool, { now: NOW });
		const lastWithCountdown = candidates.findLastIndex((candidate) =>
			candidate.includes("4d"),
		);
		const firstWithout = candidates.findIndex(
			(candidate) => candidate.startsWith("Resets:") && !candidate.includes("4d"),
		);
		expect(lastWithCountdown).toBeLessThan(firstWithout);
	});

	it("ends on a bare count rather than on nothing", () => {
		expect(formatQuotaResetsCandidates(spentPool, { now: NOW }).at(-1)).toBe(
			"Resets: 2",
		);
	});

	it("drops a credit count that is 1 everywhere, since it is not news", () => {
		const single = spentPool.map((account) =>
			account.index === 2 ? { ...account, resetCredits: 1 } : account,
		);
		const candidates = formatQuotaResetsCandidates(single, { now: NOW });
		expect(candidates).toContain("Resets: 4d work@example.com, 3d damian@nowaker.net");
	});

	it("masks the address when emails are masked", () => {
		expect(
			formatQuotaResetsCandidates(spentPool, { now: NOW, maskEmail: true })[0],
		).toBe("Free resets: 4d 2r wo***@example.com, 3d 1r da***@nowaker.net");
	});

	it("numbers the accounts when the pool line is configured that way", () => {
		const candidates = formatQuotaResetsCandidates(spentPool, {
			now: NOW,
			names: "number",
		});
		expect(candidates[0]).toBe("Free resets: 4d 2r #2, 3d 1r #1");
		for (const candidate of candidates) {
			expect(candidate).not.toContain("@");
		}
	});

	it("names no account when the pool line is configured nameless", () => {
		const candidates = formatQuotaResetsCandidates(spentPool, {
			now: NOW,
			names: "none",
		});
		expect(candidates[0]).toBe("Free resets: 4d 2r, 3d 1r");
		expect(candidates.at(-1)).toBe("Resets: 2");
		for (const candidate of candidates) {
			expect(candidate).not.toContain("@");
			expect(candidate).not.toContain("#");
		}
	});
});

describe("resolveQuotaOverviewTonePercent", () => {
	it("reports the healthiest account, not the worst", () => {
		expect(resolveQuotaOverviewTonePercent(pool)).toBe(88);
	});

	it("reports nothing for an unreadable pool", () => {
		expect(resolveQuotaOverviewTonePercent([])).toBeUndefined();
	});
});

describe("getQuotaStatus", () => {
	it("leaves every existing install on the account it is serving from", () => {
		expect(getQuotaStatus({}).screens).toEqual(["active"]);
	});

	it("shows each account with its reset once the pool view is on", () => {
		expect(getQuotaStatus({ quotaStatus: { mode: "overview" } })).toEqual({
			screens: ["overview"],
			rotateMs: 5_000,
			resetsMinUsedPercent: 100,
			layout: "accounts",
			accountNames: "number",
			order: "number",
			multipliers: false,
			allotment: false,
			resetTimes: "low",
			resetCredits: false,
			recovery: false,
			rows: 1,
			showFor: "always",
			prefix: "",
		});
	});

	it("honours every switch independently", () => {
		expect(
			getQuotaStatus({
				quotaStatus: {
					mode: ["overview", "resets"],
					rotateMs: 8_000,
					layout: "aggregate",
					accountNames: "label",
					order: "most-used",
					multipliers: true,
					allotment: true,
					resetTimes: "always",
					resetCredits: true,
					recovery: true,
					rows: 2,
					showFor: "codex-models",
					prefix: "OpenAI ",
				},
			}),
		).toEqual({
			screens: ["overview", "resets"],
			rotateMs: 8_000,
			resetsMinUsedPercent: 100,
			layout: "aggregate",
			accountNames: "label",
			order: "most-used",
			multipliers: true,
			allotment: true,
			resetTimes: "always",
			resetCredits: true,
			recovery: true,
			rows: 2,
			showFor: "codex-models",
			prefix: "OpenAI ",
		});
	});

	it("collapses a repeated screen so it cannot come up twice as often", () => {
		expect(
			getQuotaStatus({ quotaStatus: { mode: ["overview", "overview", "active"] } })
				.screens,
		).toEqual(["overview", "active"]);
	});

	it("falls back to the serving account when no screen survives", () => {
		expect(getQuotaStatus({ quotaStatus: { mode: [] } }).screens).toEqual([
			"active",
		]);
	});

	it("keeps the rotation slow enough to read", () => {
		expect(getQuotaStatus({ quotaStatus: { rotateMs: 10 } }).rotateMs).toBe(1_000);
	});

	it("clamps the row count to something a prompt can hold", () => {
		expect(getQuotaStatus({ quotaStatus: { rows: 99 } }).rows).toBe(4);
		expect(getQuotaStatus({ quotaStatus: { rows: 1 } }).rows).toBe(1);
	});

	it("reads the earlier boolean spelling of the reset and layout switches", () => {
		// A config written against the first build of this feature must not lose
		// its meaning, and must not fail validation either.
		expect(getQuotaStatus({ quotaStatus: { resetTimes: true } }).resetTimes).toBe(
			"low",
		);
		expect(getQuotaStatus({ quotaStatus: { resetTimes: false } }).resetTimes).toBe(
			"never",
		);
		expect(getQuotaStatus({ quotaStatus: { accounts: false } }).layout).toBe(
			"count",
		);
		expect(
			getQuotaStatus({ quotaStatus: { accounts: false, layout: "accounts" } })
				.layout,
		).toBe("accounts");
	});

	it("ignores a value the schema would not have accepted", () => {
		expect(
			PluginConfigSchema.safeParse({ quotaStatus: { mode: "overview" } }).success,
		).toBe(true);
		expect(
			PluginConfigSchema.safeParse({ quotaStatus: { mode: ["active", "resets"] } })
				.success,
		).toBe(true);
		expect(
			PluginConfigSchema.safeParse({ quotaStatus: { mode: "summary" } }).success,
		).toBe(false);
		expect(
			PluginConfigSchema.safeParse({ quotaStatus: { multipliers: "yes" } }).success,
		).toBe(false);
		expect(
			PluginConfigSchema.safeParse({ quotaStatus: { rows: "two" } }).success,
		).toBe(false);
		// The legacy boolean stays acceptable so one stale value cannot reset
		// every other setting in the file.
		expect(
			PluginConfigSchema.safeParse({ quotaStatus: { resetTimes: true } }).success,
		).toBe(true);
	});

	it("is read from the config file alone, never from the environment", () => {
		process.env.CODEX_AUTH_QUOTA_STATUS = "overview";
		try {
			expect(getQuotaStatus({}).screens).toEqual(["active"]);
		} finally {
			delete process.env.CODEX_AUTH_QUOTA_STATUS;
		}
	});
});

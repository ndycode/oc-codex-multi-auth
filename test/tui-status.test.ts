import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	fitStatusLines,
	formatPromptStatusText,
	formatQuotaDetailsText,
	formatQuotaOverviewStatusLines,
	formatQuotaOverviewStatusText,
	formatQuotaResetsStatusLines,
	resolvePromptReasoningVariant,
	resolveQuotaOverviewTone,
	resolveQuotaPromptTone,
	wrapStatusCandidate,
	type CompactQuotaStatus,
	type PromptStatusConfig,
	type PromptStatusMessage,
} from "../lib/tui-status.js";
import type {
	QuotaOverviewAccount,
	QuotaOverviewOptions,
} from "../lib/quota-overview.js";

const sep = ` ${String.fromCharCode(183)} `;
const quota: CompactQuotaStatus = {
	type: "ready",
	limits: [
		{ label: "5h", leftPercent: 88 },
		{ label: "7d", leftPercent: 83 },
	],
	stale: false,
};

describe("TUI prompt status helpers", () => {

	it("formats prompt status text from supplied quota labels", () => {
		expect(
			formatPromptStatusText({
				variant: "xhigh",
				quota,
				width: 120,
			}),
		).toBe(`5h 88%${sep}7d 83%`);

		expect(
			formatPromptStatusText({
				variant: "xhigh",
				quota,
				width: 80,
			}),
		).toBe(`5h 88%${sep}7d 83%`);

		expect(
			formatPromptStatusText({
				variant: "xhigh",
				quota,
				width: 50,
			}),
		).toBe("5h 88%");
	});

	it("falls back to non-sensitive status when quota is unavailable", () => {
		expect(
			formatPromptStatusText({
				variant: "high",
				quota: { type: "unavailable" },
				width: 120,
			}),
		).toBe("limits ?");
		expect(
			formatPromptStatusText({
				quota: { type: "missing" },
				width: 120,
			}),
		).toBe("no auth");
		expect(
			formatPromptStatusText({
				quota: { type: "loading" },
				width: 120,
			}),
		).toBe("");
	});

	it("adds account hint only when multiple accounts are configured", () => {
		expect(
			formatPromptStatusText({
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
					accountEmail: "user2@example.com",
				},
				width: 120,
			}),
		).toBe(`[user2@example.com]${sep}5h 88%${sep}7d 83%`);

		expect(
			formatPromptStatusText({
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
				},
				width: 120,
			}),
		).toBe(`A2${sep}5h 88%${sep}7d 83%`);

		expect(
			formatPromptStatusText({
				quota: {
					...quota,
					accountIndex: 1,
					accountCount: 1,
				},
				width: 120,
			}),
		).toBe(`5h 88%${sep}7d 83%`);
	});

	it("masks account email in prompt status when requested", () => {
		expect(
			formatPromptStatusText({
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
					accountEmail: "user2@example.com",
				},
				width: 120,
				maskEmail: true,
			}),
		).toBe(`[us***@example.com]${sep}5h 88%${sep}7d 83%`);

		expect(
			formatPromptStatusText({
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
					accountLabel: "Account 2 (user2@example.com)",
				},
				width: 120,
				maskEmail: true,
			}),
		).toBe(`[us***@example.com]${sep}5h 88%${sep}7d 83%`);
	});

	it("preserves account email in prompt status when masking is disabled", () => {
		expect(
			formatPromptStatusText({
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
					accountEmail: "user2@example.com",
				},
				width: 120,
				maskEmail: false,
			}),
		).toBe(`[user2@example.com]${sep}5h 88%${sep}7d 83%`);
	});

	it("prefers quota over variant when status space is tight", () => {
		expect(
			formatPromptStatusText({
				variant: "xhigh",
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
					accountEmail: "user2@example.com",
				},
				width: 50,
			}),
		).toBe("5h 88%");
	});

	it("resolves prompt tone from quota thresholds", () => {
		expect(resolveQuotaPromptTone(quota)).toBe("normal");
		expect(
			resolveQuotaPromptTone({
				...quota,
				limits: [{ label: "5h", leftPercent: 20 }],
			}),
		).toBe("warning");
		expect(
			resolveQuotaPromptTone({
				...quota,
				limits: [{ label: "5h", leftPercent: 8 }],
			}),
		).toBe("danger");
		expect(resolveQuotaPromptTone({ ...quota, stale: true })).toBe("stale");
	});

	it("adds reset time to compact status only when quota is low", () => {
		// Pinned to midday. On the real clock a reset one minute out lands on
		// tomorrow whenever the suite runs in the last minute before local
		// midnight, and the day-context formatter then renders "Sat 00:00",
		// which the leading digits below reject.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 5, 12, 0));
		try {
			const resetStatus = formatPromptStatusText({
				quota: {
					...quota,
					limits: [
						{ label: "5h", leftPercent: 8, resetAtMs: Date.now() + 60_000 },
						{ label: "7d", leftPercent: 83 },
					],
				},
				width: 120,
			});

			expect(resetStatus).toMatch(/5h 8% resets in 1m/);
			expect(resetStatus).toContain("7d 83%");
			expect(
				formatPromptStatusText({
					quota,
					width: 120,
				}),
			).not.toContain("resets");
		} finally {
			vi.useRealTimers();
		}
	});

	it("formats quota details for the command dialog", () => {
		const details = formatQuotaDetailsText(
			{
				...quota,
				accountIndex: 2,
				accountCount: 3,
				accountEmail: "neil@example.com",
				accountLabel: "Account 2 (neil@example.com)",
				source: "headers",
				fetchedAt: 1_000,
				planType: "plus",
				activeLimit: 40,
			},
			31_000,
		);

		expect(details).toContain("Account: [neil@example.com] (Account 2");
		expect(details).toContain("5h: 88% left");
		// Named the same way the stored plan is, so one seat does not read
		// "Plus" in codex-list and "plus" here.
		expect(details).toContain("Plan: Plus");
		expect(details).toContain("Active limit: 40");
		expect(details).toContain("Source: response headers");
		expect(details).toContain("Updated: just now");
	});

	it("partial mask keeps accounts distinguishable in prompt status", () => {
		const one = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "javi.ortiz.1982@gmail.com",
			},
			width: 120,
			maskEmail: true,
		});
		const two = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 2,
				accountCount: 3,
				accountEmail: "neil@example.com",
			},
			width: 120,
			maskEmail: true,
		});
		expect(one).toContain("[ja***@gmail.com]");
		expect(two).toContain("[ne***@example.com]");
		expect(one).not.toContain("javi.ortiz.1982@gmail.com");
	});

	it("falls back to a flat mask for account values without an email pattern", () => {
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "user-without-at-sign",
			},
			width: 120,
			maskEmail: true,
		});
		expect(out).toContain("[*****]");
		expect(out).not.toContain("user-without-at-sign");
	});

	it("falls back to the flat mask rather than dropping the account", () => {
		// The partial hint is twelve characters longer than the flat one, and
		// the ladder drops the account hint when a rung does not fit. Without
		// the flat form as a second try at the same rung, turning masking on
		// removes the account from a 78-column line entirely - identifying the
		// account less rather than more, which is the opposite of the point.
		// The domain is long enough that the partial hint overruns the
		// 78-column budget by a clear margin and fits the 120-column one with
		// room to spare, so the two assertions do not sit on a boundary that a
		// change to the budget table could tip.
		const masked = {
			...quota,
			accountIndex: 2,
			accountCount: 3,
			accountEmail: "someone@eng.university.edu",
		};

		expect(
			formatPromptStatusText({ quota: masked, width: 78, maskEmail: true }),
		).toBe(`[*****]${sep}5h 88%${sep}7d 83%`);
		expect(
			formatPromptStatusText({ quota: masked, width: 120, maskEmail: true }),
		).toBe(`[so***@eng.university.edu]${sep}5h 88%${sep}7d 83%`);
	});

	it("reduces a multi-address account value to one masked address", () => {
		// The hint is an identity for one account, so it takes the address and
		// discards the rest rather than masking in place. Substituting in
		// place is what would keep the second address, or a real name, beside
		// the mask.
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "alice@example.com;bob@corp.com",
			},
			width: 120,
			maskEmail: true,
		});
		expect(out).toContain("[al***@example.com]");
		expect(out).not.toContain("alice@example.com");
		expect(out).not.toContain("bob@corp.com");
	});

	it("keeps no identifying text around the address it masks", () => {
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "Neil Smith neil@example.com",
			},
			width: 120,
			maskEmail: true,
		});
		expect(out).toContain("[ne***@example.com]");
		expect(out).not.toContain("Neil Smith");
	});

	it("flattens an account value whose separator is not an address boundary", () => {
		// `/` is not a separator the token scan splits on, so both addresses
		// land in one match. A partial mask keeps everything after the first
		// `@`, which here is the whole of the second address.
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "alice@example.com/bob@corp.com",
			},
			width: 120,
			maskEmail: true,
		});
		expect(out).toContain("[*****]");
		expect(out).not.toContain("bob");
		expect(out).not.toContain("corp.com");
	});

	it("flattens an account value that has an @ but is not an address", () => {
		// `maskEmailForDisplay` keeps everything from the first `@` onward,
		// which for free text is the free text.
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "Team @ Acme Corp",
			},
			width: 120,
			maskEmail: true,
		});
		expect(out).toContain("[*****]");
		expect(out).not.toContain("Acme");
	});

	it("masks every address in a label, whatever punctuation joins them", () => {
		// The details dialog keeps the label's structure, so masking there is
		// in place. Each token carrying an `@` is masked on its own, and a
		// token carrying two is flattened rather than half-masked.
		const details = formatQuotaDetailsText(
			{
				...quota,
				accountIndex: 2,
				accountCount: 3,
				accountEmail: "alice@example.com",
				accountLabel: "Shared: alice@example.com;bob@corp.com and carol@x.io/dave@y.io",
				source: "headers",
				fetchedAt: 1_000,
			},
			31_000,
			{ maskEmail: true },
		);

		expect(details).toContain("al***@example.com;bo***@corp.com");
		expect(details).toContain("*****");
		expect(details).not.toContain("bob@corp.com");
		expect(details).not.toContain("carol");
		expect(details).not.toContain("dave");
		expect(details).not.toContain("y.io");
	});

	it("masks emails embedded in free-text account labels", () => {
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 2,
				accountCount: 3,
				accountLabel: "Account 2 (user2@example.com)",
			},
			width: 120,
			maskEmail: true,
		});
		expect(out).toContain("[us***@example.com]");
		expect(out).not.toContain("user2@example.com");
	});

	it("masks account email in quota details when requested", () => {
		const details = formatQuotaDetailsText(
			{
				...quota,
				accountIndex: 2,
				accountCount: 3,
				accountEmail: "neil@example.com",
				accountLabel: "Account 2 (neil@example.com)",
				source: "usage",
				fetchedAt: 1_000,
			},
			31_000,
			{ maskEmail: true },
		);

		expect(details).toContain("Account: [ne***@example.com] (Account 2 (ne***@example.com))");
		expect(details).not.toContain("neil@example.com");
		expect(details).toContain("5h: 88% left");
	});

	it("preserves account email in quota details when masking is disabled", () => {
		const details = formatQuotaDetailsText(
			{
				...quota,
				accountIndex: 2,
				accountCount: 3,
				accountEmail: "neil@example.com",
				accountLabel: "Account 2 (neil@example.com)",
				source: "usage",
				fetchedAt: 1_000,
			},
			31_000,
			{ maskEmail: false },
		);

		expect(details).toContain("Account: [neil@example.com] (Account 2 (neil@example.com))");
	});

	it("resolves the selected variant from session messages before config defaults", () => {
		const messages: PromptStatusMessage[] = [
			{
				role: "assistant",
				modelID: "gpt-5.5-high",
				variant: "high",
			},
			{
				role: "user",
				userModel: {
					modelID: "gpt-5.5",
					variant: "xhigh",
				},
			},
		];
		const config: PromptStatusConfig = {
			model: "openai/gpt-5.5-medium",
		};

		expect(resolvePromptReasoningVariant({ messages, config })).toBe("xhigh");
	});

	it("resolves legacy suffixes and provider reasoning options from config", () => {
		expect(
			resolvePromptReasoningVariant({
				config: {
					model: "openai/gpt-5.5-fast-medium",
				},
			}),
		).toBe("medium");

		expect(
			resolvePromptReasoningVariant({
				config: {
					model: "openai/gpt-5.5",
					provider: {
						openai: {
							options: {
								reasoningEffort: "high",
							},
						},
					},
				},
			}),
		).toBe("high");
	});

	it("prefers the selected agent reasoning effort over provider defaults", () => {
		const config: PromptStatusConfig = {
			model: "openai/gpt-5.5",
			default_agent: "Sisyphus - Ultraworker",
			agent: {
				"Sisyphus - Ultraworker": {
					model: "openai/gpt-5.5",
					reasoningEffort: "xhigh",
				},
			},
			provider: {
				openai: {
					options: {
						reasoningEffort: "medium",
					},
				},
			},
		};

		expect(resolvePromptReasoningVariant({ config })).toBe("xhigh");
	});
});

describe("formatResetTime time left", () => {
	// Fake timers freeze both Date.now() and new Date() so the formatter's
	// "now" and the fixed reset timestamps land on deterministic dates.
	const now = new Date(2026, 8, 5, 12, 0); // 2026-09-05T12:00 local

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("never renders wider than the terminal, at any width", () => {
		// The narrowest tier was a flat 12, which is wider than the terminal
		// itself below twelve columns: a 40-column check caught the unknown-width
		// case, but nothing covered a genuinely tiny one. Printing nothing beats
		// printing a line that wraps and pushes the prompt.
		const overruns: string[] = [];
		for (let width = 1; width <= 130; width += 1) {
			const out = formatPromptStatusText({
				variant: "xhigh",
				quota: {
					...quota,
					accountIndex: 2,
					accountCount: 3,
					accountEmail: "someone@eng.university.edu",
				},
				width,
				maskEmail: true,
			});
			if (out.length > width) overruns.push(`w=${width} len=${out.length}`);
		}
		expect(overruns).toEqual([]);
	});

	it("keeps an unknown width inside the narrowest terminal it stands in for", () => {
		// The renderer reports no width during an early render or from a
		// detached renderer, and this branch also covers a 40-column
		// terminal. A budget wider than that wraps the line and pushes the
		// prompt, with nothing here able to detect it happened.
		const out = formatPromptStatusText({
			quota: {
				...quota,
				accountIndex: 1,
				accountCount: 3,
				accountEmail: "someone@student.university.edu",
				limits: [
					{ label: "5h", leftPercent: 8, resetAtMs: new Date(2026, 8, 15, 2, 25).getTime() },
					{ label: "7d", leftPercent: 83 },
				],
			},
		});

		expect(out.length).toBeLessThanOrEqual(32);
		expect(out).not.toBe("");
	});

	const resetLine = (label: string, resetAtMs: number) =>
		formatPromptStatusText({
			quota: { ...quota, limits: [{ label, leftPercent: 0, resetAtMs }] },
			width: 120,
		});

	it("#given a reset under an hour away #when formatted #then it shows minutes", () => {
		expect(resetLine("5h", now.getTime() + 40 * 60_000)).toBe("5h 0% resets in 40m");
	});

	it("#given a reset under a day away #when formatted #then it shows hours", () => {
		expect(resetLine("5h", new Date(2026, 8, 5, 17, 10).getTime())).toBe("5h 0% resets in 5h");
	});

	it("#given a reset days away #when formatted #then it shows days", () => {
		expect(resetLine("7d", new Date(2026, 8, 8, 2, 25).getTime())).toBe("7d 0% resets in 3d");
		expect(resetLine("7d", new Date(2026, 8, 15, 2, 25).getTime())).toBe("7d 0% resets in 10d");
	});

	it("#given a reset already in the past #when formatted #then no reset is shown", () => {
		expect(resetLine("7d", now.getTime() - 60_000)).not.toContain("resets");
	});
});

describe("tui quota status hostile inputs", () => {
	it("details text never emits NaN or Infinity for any limit field", () => {
		const status: CompactQuotaStatus = {
			type: "ready",
			stale: false,
			limits: [
				{ label: "5h limit", leftPercent: Number.NaN, resetAtMs: Number.NaN },
				{ label: "Weekly limit", leftPercent: -12, resetAtMs: 1e300 },
			],
			activeLimit: Number.NaN,
			fetchedAt: Number.NaN,
		};
		const text = formatQuotaDetailsText(status);
		expect(text).not.toMatch(/NaN|Infinity/);
	});
});

describe("pool-wide prompt status", () => {
	const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
	const DAY = 24 * 60 * 60 * 1000;
	const pool: QuotaOverviewAccount[] = [
		{
			index: 1,
			planType: "self_serve_business_prolite",
			windows: [{ leftPercent: 87 }],
		},
		{
			index: 2,
			planType: "pro",
			resetCredits: 1,
			windows: [{ leftPercent: 0, resetAtMs: NOW + 3 * DAY }],
		},
		{ index: 3, planType: "plus", windows: [{ leftPercent: 88 }] },
	];
	const options: QuotaOverviewOptions = {
		mode: "used",
		layout: "accounts",
		names: "number",
		order: "number",
		multipliers: true,
		allotment: false,
		resetTimes: "low",
		resetCredits: true,
		recovery: false,
		now: NOW,
	};

	it("shows every account when the terminal has room", () => {
		expect(
			formatQuotaOverviewStatusText({ accounts: pool, options, width: 200 }),
		).toBe("80%: #1 5x 13%, #2 20x 100% 3d 1r, #3 1x 12%");
	});

	it("keeps the breakdown on a terminal the tiered budget would have given up on", () => {
		// 120 columns caps the single-account budget at 64 characters; the pool
		// line is 44 and must survive.
		expect(
			formatQuotaOverviewStatusText({ accounts: pool, options, width: 120 }),
		).toContain("#3");
	});

	it("gives up the account numbers before the percentages behind them", () => {
		// Three figures in account order say more than `3 accounts` does, and
		// cost four characters more.
		const text = formatQuotaOverviewStatusText({
			accounts: pool,
			options,
			width: 60,
		});
		expect(text).toBe("80%: 13%, 100%, 12%");
		expect(text.length).toBeLessThanOrEqual(24);
	});

	it("degrades to the count when position would name the wrong account", () => {
		// One account nobody could read leaves a hole in the line, so the
		// unnamed form is not offered and the count is the next rung down.
		const text = formatQuotaOverviewStatusText({
			accounts: [...pool, { index: 4, planType: "plus", windows: [] }],
			options,
			width: 60,
		});
		expect(text).toBe("80%: 4 accounts");
	});

	it("leaves the model label its room on an 80-column terminal", () => {
		// Measured against the real TUI: this slot shares its row with the
		// model label ("Build - Big Pickle OpenCode Zen", 31 characters) inside
		// the prompt border. A 48-character line was ellipsized through its
		// middle AND wrapped the label onto a second row, so 80 columns must
		// buy no more than 40.
		const crowded: QuotaOverviewAccount[] = [
			{ index: 1, planType: "pro", windows: [{ leftPercent: 8, resetAtMs: NOW + 6 * DAY }] },
			{ index: 2, planType: "self_serve_business_prolite", windows: [{ leftPercent: 0, resetAtMs: NOW + 3 * DAY }] },
			{ index: 3, planType: "team", windows: [{ leftPercent: 62 }] },
			{ index: 4, planType: "plus", windows: [{ leftPercent: 100 }] },
			{ index: 5, planType: "pro", windows: [{ leftPercent: 45 }] },
		];
		const text = formatQuotaOverviewStatusText({
			accounts: crowded,
			options: { ...options, mode: "free" },
			width: 80,
		});
		expect(text.length).toBeLessThanOrEqual(40);
		expect(text).not.toContain("...");
	});

	it("abbreviates the count rather than giving up on it", () => {
		const text = formatQuotaOverviewStatusText({
			accounts: pool,
			options,
			width: 20,
		});
		expect(text).toBe("80%: 3 acct.");
	});

	it("falls back to the bare total when nothing else fits", () => {
		expect(
			formatQuotaOverviewStatusText({ accounts: pool, options, width: 4 }),
		).toBe("80%");
	});

	it("uses the measured space in preference to the whole terminal", () => {
		// The same 200-column terminal, once with and once without a measured
		// budget. A sidebar and a model label can leave this slot 14 columns on
		// a wide terminal, and the measurement is what stops the renderer
		// ellipsizing a 44-character line through its middle.
		expect(
			formatQuotaOverviewStatusText({ accounts: pool, options, width: 200 }),
		).toBe("80%: #1 5x 13%, #2 20x 100% 3d 1r, #3 1x 12%");
		expect(
			formatQuotaOverviewStatusText({
				accounts: pool,
				options,
				width: 200,
				availableChars: 14,
			}),
		).toBe("80%: 3 acct.");
	});

	it("stays conservative when the width is unknown", () => {
		const text = formatQuotaOverviewStatusText({ accounts: pool, options });
		expect(text.length).toBeLessThanOrEqual(32);
	});

	it("renders nothing for a pool with no readable quota", () => {
		expect(
			formatQuotaOverviewStatusText({ accounts: [], options, width: 200 }),
		).toBe("");
	});

	it("uses a second row before it gives up any detail", () => {
		// 30 columns on one row loses the badges and the reset; across two it
		// keeps the whole line.
		expect(
			formatQuotaOverviewStatusLines({
				accounts: pool,
				options,
				availableChars: 30,
				maxRows: 2,
			}),
		).toEqual(["80%: #1 5x 13%,", "#2 20x 100% 3d 1r, #3 1x 12%"]);
	});

	it("keeps a one-row line on one row", () => {
		expect(
			formatQuotaOverviewStatusLines({
				accounts: pool,
				options,
				availableChars: 60,
				maxRows: 2,
			}),
		).toEqual(["80%: #1 5x 13%, #2 20x 100% 3d 1r, #3 1x 12%"]);
	});

	it("renders the reset-credit line only once the pool is spent", () => {
		const spent: QuotaOverviewAccount[] = [
			{
				index: 1,
				planType: "plus",
				email: "damian@nowaker.net",
				resetCredits: 1,
				windows: [{ leftPercent: 0, resetAtMs: NOW + 6 * DAY }],
			},
			{
				index: 2,
				planType: "plus",
				email: "work@example.com",
				resetCredits: 2,
				windows: [{ leftPercent: 0, resetAtMs: NOW + 4 * DAY }],
			},
		];
		expect(
			formatQuotaResetsStatusLines({ accounts: spent, options, availableChars: 80 }),
		).toEqual([
			"Free resets: 6d 1r #1, 4d 2r #2",
		]);
		expect(
			formatQuotaResetsStatusLines({ accounts: pool, options, availableChars: 80 }),
		).toEqual([]);
	});

	it("shortens the reset-credit line rather than overflowing", () => {
		const spent: QuotaOverviewAccount[] = [
			{
				index: 1,
				planType: "plus",
				email: "damian@nowaker.net",
				resetCredits: 1,
				windows: [{ leftPercent: 0, resetAtMs: NOW + 6 * DAY }],
			},
			{
				index: 3,
				planType: "plus",
				email: "work@example.com",
				resetCredits: 1,
				windows: [{ leftPercent: 0, resetAtMs: NOW + 4 * DAY }],
			},
		];
		expect(
			formatQuotaResetsStatusLines({ accounts: spent, options, availableChars: 30 }),
		).toEqual(["Resets: 6d 1r #1, 4d 1r #3"]);
		expect(
			formatQuotaResetsStatusLines({ accounts: spent, options, availableChars: 11 }),
		).toEqual(["Resets: 2"]);
	});

	it("names no account on the resets line when names are switched off", () => {
		const spent: QuotaOverviewAccount[] = [
			{
				index: 1,
				planType: "plus",
				email: "damian@nowaker.net",
				resetCredits: 1,
				windows: [{ leftPercent: 0, resetAtMs: NOW + 6 * DAY }],
			},
			{
				index: 2,
				planType: "plus",
				email: "work@example.com",
				resetCredits: 2,
				windows: [{ leftPercent: 0, resetAtMs: NOW + 4 * DAY }],
			},
		];
		expect(
			formatQuotaResetsStatusLines({
				accounts: spent,
				options: { ...options, names: "none" },
				availableChars: 80,
			}),
		).toEqual(["Free resets: 6d 1r, 4d 2r"]);
	});
});

describe("wrapStatusCandidate", () => {
	it("breaks only at the separators the line already has", () => {
		expect(wrapStatusCandidate("20%: #1 87%, #2 0%, #3 88%", 16, 2)).toEqual([
			"20%: #1 87%,",
			"#2 0%, #3 88%",
		]);
	});

	it("leaves a line that already fits alone", () => {
		expect(wrapStatusCandidate("20%: 3 accounts", 20, 2)).toEqual([
			"20%: 3 accounts",
		]);
	});

	it("refuses a line that would need more rows than it has", () => {
		expect(
			wrapStatusCandidate("20%: #1 87%, #2 0%, #3 88%", 12, 2),
		).toBeUndefined();
		expect(wrapStatusCandidate("20%: #1 87%, #2 0%, #3 88%", 12, 3)).toEqual([
			"20%: #1 87%,",
			"#2 0%,",
			"#3 88%",
		]);
	});

	it("refuses a single segment that cannot fit a row at all", () => {
		expect(wrapStatusCandidate("20%: #1 87%, #2 0%", 8, 4)).toBeUndefined();
	});

	it("never wraps when it is only allowed one row", () => {
		expect(wrapStatusCandidate("20%: #1 87%, #2 0%", 12, 1)).toBeUndefined();
	});
});

describe("fitStatusLines", () => {
	it("takes the first rung that fits, wrapped or not", () => {
		expect(fitStatusLines(["aaaa, bbbb", "cc"], 5, 2)).toEqual(["aaaa,", "bbbb"]);
		expect(fitStatusLines(["aaaa, bbbb", "cc"], 5, 1)).toEqual(["cc"]);
	});

	it("falls back to the shortest rung rather than rendering nothing", () => {
		expect(fitStatusLines(["aaaaaa", "bbbb"], 2, 1)).toEqual(["bbbb"]);
	});

	it("renders nothing for an empty ladder", () => {
		expect(fitStatusLines([], 40, 2)).toEqual([]);
	});
});

describe("resolveQuotaOverviewTone", () => {
	const account = (leftPercent: number): QuotaOverviewAccount => ({
		index: 1,
		planType: "plus",
		windows: [{ leftPercent }],
	});

	it("stays normal while one account still has room", () => {
		expect(resolveQuotaOverviewTone([account(0), account(80)])).toBe("normal");
	});

	it("warns only once the whole pool is low", () => {
		expect(resolveQuotaOverviewTone([account(0), account(20)])).toBe("warning");
	});

	it("turns red once nothing in the pool has room", () => {
		expect(resolveQuotaOverviewTone([account(0), account(5)])).toBe("danger");
	});

	it("reports a stale reading as stale whatever the numbers say", () => {
		expect(resolveQuotaOverviewTone([account(90)], true)).toBe("stale");
	});

	it("reports an unreadable pool as unknown", () => {
		expect(resolveQuotaOverviewTone([])).toBe("unknown");
	});
});

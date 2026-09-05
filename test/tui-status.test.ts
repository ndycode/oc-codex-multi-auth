import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	formatPromptStatusText,
	formatQuotaDetailsText,
	resolvePromptReasoningVariant,
	resolveQuotaPromptTone,
	type CompactQuotaStatus,
	type PromptStatusConfig,
	type PromptStatusMessage,
} from "../lib/tui-status.js";

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
		).toBe(`[*****]${sep}5h 88%${sep}7d 83%`);

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
		).toBe(`[*****]${sep}5h 88%${sep}7d 83%`);
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

		expect(resetStatus).toMatch(/5h 8% resets \d{2}:\d{2}/);
		expect(resetStatus).toContain("7d 83%");
		expect(
			formatPromptStatusText({
				quota,
				width: 120,
			}),
		).not.toContain("resets");
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

		expect(details).toContain("Account: [*****] (Account 2 (*****))");
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

describe("formatResetTime day context", () => {
	// Fake timers freeze both Date.now() and new Date() so the formatter's
	// "now" and the fixed reset timestamps land on deterministic dates.
	const now = new Date(2026, 8, 5, 12, 0); // 2026-09-05T12:00 local
	// Expected labels are derived from the runtime's own Intl formatting so
	// the assertions hold under any default locale.
	const weekdayLabel = new Date(2026, 8, 8, 2, 25).toLocaleDateString(
		undefined,
		{ weekday: "short" },
	);
	const dateLabel = new Date(2026, 8, 15, 2, 25).toLocaleDateString(undefined, {
		month: "short",
		day: "2-digit",
	});
	const timeLabel = (h: number, m: number) =>
		new Date(2026, 8, 5, h, m)
			.toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			})
			.replace(/^24/, "00");

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps time-only format for same-day resets", () => {
		const out = formatPromptStatusText({
			quota: {
				...quota,
				limits: [
					{ label: "5h", leftPercent: 8, resetAtMs: new Date(2026, 8, 5, 18, 30).getTime() },
				],
			},
			width: 120,
		});
		expect(out).toBe(`5h 8% resets ${timeLabel(18, 30)}`);
	});

	it("adds weekday for resets within the coming week", () => {
		const out = formatPromptStatusText({
			quota: {
				...quota,
				limits: [
					{ label: "7d", leftPercent: 0, resetAtMs: new Date(2026, 8, 8, 2, 25).getTime() },
				],
			},
			width: 120,
		});
		expect(out).toBe(`7d 0% resets ${weekdayLabel} ${timeLabel(2, 25)}`);
	});

	it("uses absolute date beyond a week", () => {
		const out = formatPromptStatusText({
			quota: {
				...quota,
				limits: [
					{ label: "7d", leftPercent: 0, resetAtMs: new Date(2026, 8, 15, 2, 25).getTime() },
				],
			},
			width: 120,
		});
		expect(out).toBe(`7d 0% resets ${dateLabel} ${timeLabel(2, 25)}`);
	});

	it("uses absolute date at exactly seven calendar days across DST (America/New_York)", () => {
		// 2026-03-02 -> 2026-03-09 is seven calendar days but 167 hours in
		// America/New_York; a millisecond division would misread it as six.
		vi.setSystemTime(new Date(2026, 2, 2, 12, 0));
		const reset = new Date(2026, 2, 9, 2, 25);
		const expected = `${reset.toLocaleDateString(undefined, { month: "short", day: "2-digit" })} ${reset.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
		const out = formatPromptStatusText({
			quota: {
				...quota,
				limits: [{ label: "7d", leftPercent: 0, resetAtMs: reset.getTime() }],
			},
			width: 120,
		});
		expect(out).toBe(`7d 0% resets ${expected}`);
	});
});

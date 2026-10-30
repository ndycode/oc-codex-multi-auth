import { describe, expect, it } from "vitest";
import { getQuotaStatus } from "../lib/config.js";
import { PluginConfigSchema } from "../lib/schemas.js";

describe("quota forecast configuration", () => {
	it("preserves legacy defaults when options are absent", () => {
		expect(getQuotaStatus({})).toMatchObject({
			layout: "accounts", recovery: false, resetsMinUsedPercent: 100,
		});
	});

	it("accepts total layout and all recovery events when configured", () => {
		const parsed = PluginConfigSchema.parse({
			quotaStatus: { layout: "total", recovery: "all", resetsMinUsedPercent: 80 },
		});
		expect(getQuotaStatus(parsed)).toMatchObject({
			layout: "total", recovery: "all", resetsMinUsedPercent: 80,
		});
	});

	it.each([false, true, "all"] as const)("preserves recovery %s through parsing", (recovery) => {
		const parsed = PluginConfigSchema.parse({ quotaStatus: { recovery } });
		expect(getQuotaStatus(parsed).recovery).toBe(recovery);
	});

	it.each([0, 50.5, 100])("accepts reset threshold %s within the percentage range", (resetsMinUsedPercent) => {
		const parsed = PluginConfigSchema.parse({ quotaStatus: { resetsMinUsedPercent } });
		expect(getQuotaStatus(parsed).resetsMinUsedPercent).toBe(resetsMinUsedPercent);
	});

	it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY, "80"])("rejects invalid reset threshold %s", (resetsMinUsedPercent) => {
		expect(PluginConfigSchema.safeParse({ quotaStatus: { resetsMinUsedPercent } }).success).toBe(false);
	});
});

describe("quota status prefix", () => {
	it("defaults to no prefix and reads a configured one", () => {
		expect(getQuotaStatus(PluginConfigSchema.parse({})).prefix).toBe("");
		expect(getQuotaStatus(PluginConfigSchema.parse({ quotaStatus: { prefix: "OpenAI " } })).prefix).toBe("OpenAI ");
	});
});

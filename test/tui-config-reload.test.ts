import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (original) => ({
	...(await original<typeof import("node:os")>()),
	homedir: () => home.path,
}));

type TuiModule = typeof import("../tui.js");

describe("TUI status configuration reload", () => {
	let configPath: string;
	let read: TuiModule["readPromptStatusOptions"];
	let same: TuiModule["samePromptStatusOptions"];

	const writeConfig = (config: unknown): void => {
		writeFileSync(configPath, JSON.stringify(config));
	};

	// Imported ONCE, which is also what the behaviour under test requires: a
	// reload that only works by re-importing the module proves nothing, since
	// the running TUI never re-imports. The config path is captured when
	// `lib/config.ts` is first evaluated, so the home directory is fixed before
	// that import and each test rewrites the same file underneath it.
	beforeAll(async () => {
		home.path = mkdtempSync(join(tmpdir(), "tui-config-reload-"));
		mkdirSync(join(home.path, ".opencode"));
		configPath = join(home.path, ".opencode", "openai-codex-auth-config.json");
		const tui: TuiModule = await import("../tui.js");
		read = tui.readPromptStatusOptions;
		same = tui.samePromptStatusOptions;
	});

	afterAll(() => {
		rmSync(home.path, { recursive: true, force: true });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("reports the shipped defaults when nothing is configured", () => {
		writeConfig({});
		expect(read()).toMatchObject({
			quotaDisplay: "free",
			quotaStatus: {
				screens: ["active"],
				rotateMs: 5_000,
				layout: "accounts",
				accountNames: "number",
				order: "number",
				multipliers: false,
				allotment: false,
				resetTimes: "low",
				resetCredits: false,
				recovery: false,
				resetsMinUsedPercent: 100,
				rows: 1,
				showFor: "always",
			},
		});
	});

	it("picks up an edit to the file without reloading the module", () => {
		writeConfig({ quotaStatus: { mode: "active" } });
		expect(read().quotaStatus.screens).toEqual(["active"]);

		writeConfig({
			quotaDisplay: "used",
			quotaStatus: { mode: "overview", multipliers: true, recovery: true },
		});
		const after = read();
		expect(after.quotaStatus.screens).toEqual(["overview"]);
		expect(after.quotaStatus.multipliers).toBe(true);
		expect(after.quotaStatus.recovery).toBe(true);
		expect(after.quotaDisplay).toBe("used");
	});

	it("reloads forecast options without restarting the TUI module", () => {
		writeConfig({ quotaStatus: { layout: "accounts", recovery: true } });
		const before = read();
		writeConfig({ quotaStatus: { layout: "total", recovery: "all", resetsMinUsedPercent: 75 } });
		const after = read();
		expect(after.quotaStatus).toMatchObject({ layout: "total", recovery: "all", resetsMinUsedPercent: 75 });
		expect(same(before, after)).toBe(false);
	});

	it("reloads a prefix-only edit without restarting the TUI module", () => {
		writeConfig({ quotaStatus: { prefix: "Before " } });
		const before = read();
		writeConfig({ quotaStatus: { prefix: "After " } });
		const after = read();
		expect(after.quotaStatus.prefix).toBe("After ");
		expect(same(before, after)).toBe(false);
	});

	it("follows a switch back to the serving-account line", () => {
		writeConfig({ quotaStatus: { mode: "overview" } });
		expect(read().quotaStatus.screens).toEqual(["overview"]);

		writeConfig({ quotaStatus: { mode: "active" } });
		expect(read().quotaStatus.screens).toEqual(["active"]);
	});

	it("picks up a screen list being turned into a rotation", () => {
		writeConfig({ quotaStatus: { mode: "overview" } });
		expect(read().quotaStatus.screens).toEqual(["overview"]);

		writeConfig({ quotaStatus: { mode: ["overview", "resets"], rotateMs: 3_000 } });
		const after = read();
		expect(after.quotaStatus.screens).toEqual(["overview", "resets"]);
		expect(after.quotaStatus.rotateMs).toBe(3_000);
	});

	it("keeps the last usable reading when the file is mid-write", () => {
		writeConfig({ quotaStatus: { mode: "overview", recovery: true } });
		expect(read().quotaStatus.recovery).toBe(true);

		writeFileSync(configPath, '{"quotaStatus":{"mode":"over');
		const during = read();
		expect(during.quotaStatus.screens).toEqual(["overview"]);
		expect(during.quotaStatus.recovery).toBe(true);
	});

	it("ignores an environment variable naming the screen", () => {
		writeConfig({ quotaStatus: { mode: "overview" } });
		vi.stubEnv("CODEX_AUTH_QUOTA_STATUS", "active");
		// The whole object is a display preference and belongs to the person, not
		// to whichever shell started this process.
		expect(read().quotaStatus.screens).toEqual(["overview"]);
	});

	it("treats two readings of unchanged configuration as equal", () => {
		writeConfig({
			quotaDisplay: "used",
			quotaStatus: { mode: "overview", multipliers: true, recovery: true },
		});
		const first = read();
		const second = read();
		// Identity deliberately differs: every poll builds a fresh object, so
		// only a field-by-field comparison can stop a re-render every tick.
		expect(second).not.toBe(first);
		expect(same(first, second)).toBe(true);
	});

	it("notices a change in every field that shapes the line", () => {
		const base = {
			quotaDisplay: "free",
			maskEmail: false,
			maskEmailInQuotaDetails: false,
			quotaStatus: {
				mode: "active",
				rotateMs: 5_000,
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
			},
		} as const;
		writeConfig(base);
		const first = read();

		const changes: Array<Record<string, unknown>> = [
			{ ...base, quotaDisplay: "used" },
			{ ...base, maskEmail: true },
			{ ...base, maskEmailInQuotaDetails: true },
			{ ...base, quotaStatus: { ...base.quotaStatus, mode: "overview" } },
			{ ...base, quotaStatus: { ...base.quotaStatus, mode: ["active", "overview"] } },
			{ ...base, quotaStatus: { ...base.quotaStatus, rotateMs: 9_000 } },
			{ ...base, quotaStatus: { ...base.quotaStatus, layout: "count" } },
			{ ...base, quotaStatus: { ...base.quotaStatus, layout: "aggregate" } },
			{ ...base, quotaStatus: { ...base.quotaStatus, layout: "total" } },
			{ ...base, quotaStatus: { ...base.quotaStatus, accountNames: "label" } },
			{ ...base, quotaStatus: { ...base.quotaStatus, order: "most-used" } },
			{ ...base, quotaStatus: { ...base.quotaStatus, multipliers: true } },
			{ ...base, quotaStatus: { ...base.quotaStatus, allotment: true } },
			{ ...base, quotaStatus: { ...base.quotaStatus, resetTimes: "always" } },
			{ ...base, quotaStatus: { ...base.quotaStatus, resetCredits: true } },
			{ ...base, quotaStatus: { ...base.quotaStatus, recovery: true } },
			{ ...base, quotaStatus: { ...base.quotaStatus, recovery: "all" } },
			{ ...base, quotaStatus: { ...base.quotaStatus, resetsMinUsedPercent: 80 } },
			{ ...base, quotaStatus: { ...base.quotaStatus, rows: 2 } },
			{ ...base, quotaStatus: { ...base.quotaStatus, showFor: "codex-models" } },
		];
		for (const change of changes) {
			writeConfig(change);
			expect(same(first, read())).toBe(false);
		}
	});
});

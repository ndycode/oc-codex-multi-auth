import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	computeCodexDiff,
	createCodexDiffTool,
	type CodexDiffEntry,
} from "../lib/tools/codex-diff.js";
import type { ToolContext } from "../lib/tools/index.js";

// Minimal ToolContext — `codex-diff` is closure-free, but the factory
// signature requires a context so we pass a stub that satisfies the
// static type without providing unused helpers.
function buildCtx(): ToolContext {
	return {} as unknown as ToolContext;
}

async function writeTmpJson(
	data: unknown,
	options: { name?: string; raw?: string } = {},
): Promise<string> {
	const name =
		options.name ??
		`codex-diff-${randomBytes(8).toString("hex")}.json`;
	const path = join(tmpdir(), name);
	const contents =
		options.raw !== undefined ? options.raw : JSON.stringify(data, null, 2);
	await fs.writeFile(path, contents, "utf8");
	return path;
}

async function callTool(args: {
	left: string;
	right: string;
	section?: "accounts" | "config" | "both";
}): Promise<{ raw: string; parsed: Record<string, unknown> }> {
	const t = createCodexDiffTool(buildCtx());
	const raw = await t.execute(args, {} as never);
	return { raw, parsed: JSON.parse(raw) as Record<string, unknown> };
}

describe("computeCodexDiff (pure helper)", () => {
	it("returns empty entries for identical objects", () => {
		const entries = computeCodexDiff(
			{ a: 1, b: { c: "hi" } },
			{ a: 1, b: { c: "hi" } },
		);
		expect(entries).toEqual([]);
	});

	it("sorts entries alphabetically by path", () => {
		const entries = computeCodexDiff(
			{ z: 1, a: 1 },
			{ z: 2, a: 2, m: 3 },
		);
		const paths = entries.map((e) => e.path);
		expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
	});
});

// Audit fix #6: redaction must be KEY-AWARE, not only shape-based. Opaque
// OpenAI refresh tokens / account ids are not token-SHAPED (no eyJ/sk-/hex-40/
// Bearer prefix), so the old shape-only maskString emitted them verbatim. The
// fix masks values whose terminal key names a sensitive field, while leaving
// non-sensitive fields (e.g. `label`) untouched.
describe("computeCodexDiff key-aware redaction (audit fix #6)", () => {
	const OPAQUE_RT = "opaque-rt-abcdef123456"; // not token-shaped

	it("masks an opaque refreshToken value by key name in changed entries", () => {
		const left = { accounts: [{ refreshToken: OPAQUE_RT }] };
		const right = { accounts: [{ refreshToken: "opaque-rt-zzzzzz987654" }] };

		const entries = computeCodexDiff(left, right);
		const tokenChange = entries.find(
			(e) => e.path === "accounts[0].refreshToken",
		);
		expect(tokenChange).toBeDefined();
		expect(tokenChange?.kind).toBe("changed");

		// OLD behavior: the opaque value passed maskString unchanged and leaked.
		expect(tokenChange?.leftValue).not.toBe(OPAQUE_RT);
		expect(tokenChange?.leftValue).not.toContain(OPAQUE_RT);
		// A masked form is still emitted so "this changed" is visible.
		expect(typeof tokenChange?.leftValue).toBe("string");
		expect(tokenChange?.leftValue).toContain("***");
		// Defence in depth: serialized output never contains the raw value.
		expect(JSON.stringify(entries)).not.toContain(OPAQUE_RT);
	});

	it("masks an opaque refreshToken value on a top-level key too", () => {
		const entries = computeCodexDiff(
			{ refreshToken: OPAQUE_RT },
			{ refreshToken: "different-opaque-rt-7777" },
		);
		const change = entries.find((e) => e.path === "refreshToken");
		expect(change?.leftValue).not.toContain(OPAQUE_RT);
		expect(change?.leftValue).toContain("***");
	});

	it("masks an opaque refreshToken value in added entries", () => {
		const entries = computeCodexDiff(
			{ accounts: [{}] },
			{ accounts: [{ refreshToken: OPAQUE_RT }] },
		);
		const added = entries.find(
			(e) => e.path === "accounts[0].refreshToken",
		);
		expect(added?.kind).toBe("added");
		expect(added?.rightValue).not.toContain(OPAQUE_RT);
		expect(added?.rightValue).toContain("***");
	});

	it("does NOT over-mask a non-sensitive key like `label`", () => {
		const labelValue = "primary-laptop-workspace";
		const entries = computeCodexDiff(
			{ accounts: [{ label: labelValue }] },
			{ accounts: [{ label: "secondary-desktop" }] },
		);
		const labelChange = entries.find(
			(e) => e.path === "accounts[0].label",
		);
		expect(labelChange).toBeDefined();
		// `label` is not sensitive, so its (non-token-shaped) value survives
		// verbatim — the fix must not blanket-mask every field.
		expect(labelChange?.leftValue).toBe(labelValue);
		expect(labelChange?.rightValue).toBe("secondary-desktop");
	});
});

describe("codex-diff tool", () => {
	const createdPaths: string[] = [];

	beforeEach(() => {
		createdPaths.length = 0;
	});

	afterEach(async () => {
		for (const p of createdPaths) {
			await fs.rm(p, { force: true }).catch(() => {});
		}
	});

	async function tmp(data: unknown, raw?: string): Promise<string> {
		const p = await writeTmpJson(data, raw !== undefined ? { raw } : {});
		createdPaths.push(p);
		return p;
	}

	it("detects added keys", async () => {
		const leftPath = await tmp({ schemaVersion: 3, accounts: [] });
		const rightPath = await tmp({
			schemaVersion: 3,
			accounts: [],
			newFeature: true,
		});

		const { parsed } = await callTool({
			left: leftPath,
			right: rightPath,
		});

		expect(parsed.summary).toEqual({ added: 1, removed: 0, changed: 0 });
		const entries = parsed.entries as CodexDiffEntry[];
		const added = entries.find((e) => e.kind === "added");
		expect(added).toBeDefined();
		expect(added?.path).toBe("newFeature");
		expect(added?.rightValue).toBe("true");
		expect(added?.leftValue).toBeUndefined();
	});

	it("detects removed keys", async () => {
		const leftPath = await tmp({
			schemaVersion: 3,
			accounts: [],
			legacyFlag: "oldValue",
		});
		const rightPath = await tmp({ schemaVersion: 3, accounts: [] });

		const { parsed } = await callTool({
			left: leftPath,
			right: rightPath,
		});

		expect(parsed.summary).toEqual({ added: 0, removed: 1, changed: 0 });
		const entries = parsed.entries as CodexDiffEntry[];
		const removed = entries.find((e) => e.kind === "removed");
		expect(removed?.path).toBe("legacyFlag");
		expect(removed?.leftValue).toBe("oldValue");
		expect(removed?.rightValue).toBeUndefined();
	});

	it("detects changed values", async () => {
		const leftPath = await tmp({
			schemaVersion: 2,
			accounts: [{ email: "a@example.com" }],
		});
		const rightPath = await tmp({
			schemaVersion: 3,
			accounts: [{ email: "b@example.com" }],
		});

		const { parsed } = await callTool({
			left: leftPath,
			right: rightPath,
		});

		const entries = parsed.entries as CodexDiffEntry[];
		const versionChange = entries.find(
			(e) => e.path === "schemaVersion",
		);
		expect(versionChange).toBeDefined();
		expect(versionChange?.kind).toBe("changed");
		expect(versionChange?.leftValue).toBe("2");
		expect(versionChange?.rightValue).toBe("3");
	});

	it("redacts JWT-shaped refresh tokens in changed entries", async () => {
		const leftToken =
			"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsZWZ0In0.abcdef1234567890";
		const rightToken =
			"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJyaWdodCJ9.xyz9876543210fed";
		const leftPath = await tmp({
			accounts: [{ refreshToken: leftToken }],
		});
		const rightPath = await tmp({
			accounts: [{ refreshToken: rightToken }],
		});

		const { raw, parsed } = await callTool({
			left: leftPath,
			right: rightPath,
		});

		// Neither full token survives in the rendered JSON.
		expect(raw).not.toContain(leftToken);
		expect(raw).not.toContain(rightToken);

		const entries = parsed.entries as CodexDiffEntry[];
		const tokenChange = entries.find((e) =>
			e.path.includes("refreshToken"),
		);
		expect(tokenChange).toBeDefined();
		expect(tokenChange?.kind).toBe("changed");
		// The redacted values should still be non-empty strings so the
		// reader knows "something changed here" even though the secret
		// never leaves the process verbatim.
		expect(typeof tokenChange?.leftValue).toBe("string");
		expect(typeof tokenChange?.rightValue).toBe("string");
		expect(tokenChange?.leftValue).not.toBe(tokenChange?.rightValue);
	});

	it("redacts home-directory paths in leftPath and rightPath", async () => {
		const leftPath = await tmp({ a: 1 });
		const rightPath = await tmp({ a: 2 });

		const { raw, parsed } = await callTool({
			left: leftPath,
			right: rightPath,
		});

		const home = homedir();
		if (home && (leftPath.includes(home) || rightPath.includes(home))) {
			expect(raw).not.toContain(home);
			expect(parsed.leftPath as string).toContain("<HOME>");
			expect(parsed.rightPath as string).toContain("<HOME>");
		} else {
			// On systems where tmpdir is not under the home directory,
			// we still assert the redaction pipeline ran without throwing
			// and that the paths are returned as strings.
			expect(typeof parsed.leftPath).toBe("string");
			expect(typeof parsed.rightPath).toBe("string");
		}
	});

	it("gracefully handles a missing left file", async () => {
		const rightPath = await tmp({ a: 1 });
		const missing = join(
			tmpdir(),
			`codex-diff-missing-${randomBytes(6).toString("hex")}.json`,
		);

		const { parsed, raw } = await callTool({
			left: missing,
			right: rightPath,
		});

		expect(parsed.error).toBe("cannot-read");
		expect(parsed.side).toBe("left");
		expect(parsed.redactionApplied).toBe(true);
		expect(typeof parsed.path).toBe("string");
		// Error payload is JSON, not a stack trace with the home dir.
		const home = homedir();
		if (home) {
			expect(raw).not.toContain(home);
		}
	});

	it("reports invalid JSON on the right side without leaking contents", async () => {
		const leftPath = await tmp({ a: 1 });
		const rightPath = await tmp(null, "{ not valid json ");
		createdPaths.push(rightPath);

		const { parsed } = await callTool({
			left: leftPath,
			right: rightPath,
		});

		expect(parsed.error).toBe("invalid-json");
		expect(parsed.side).toBe("right");
	});

	it("restricts the diff to accounts when section='accounts'", async () => {
		const leftPath = await tmp({
			schemaVersion: 2,
			accounts: [{ email: "one@example.com" }],
		});
		const rightPath = await tmp({
			schemaVersion: 3,
			accounts: [{ email: "two@example.com" }],
		});

		const { parsed } = await callTool({
			left: leftPath,
			right: rightPath,
			section: "accounts",
		});

		const entries = parsed.entries as CodexDiffEntry[];
		// schemaVersion change should NOT appear because we asked for
		// accounts-only.
		expect(entries.some((e) => e.path === "schemaVersion")).toBe(false);
		expect(entries.some((e) => e.path.startsWith("accounts"))).toBe(
			true,
		);
		expect(parsed.section).toBe("accounts");
	});

	it("produces an empty diff for identical files", async () => {
		const data = { schemaVersion: 3, accounts: [], active: 0 };
		const leftPath = await tmp(data);
		const rightPath = await tmp(data);

		const { parsed } = await callTool({
			left: leftPath,
			right: rightPath,
		});

		expect(parsed.entries).toEqual([]);
		expect(parsed.summary).toEqual({ added: 0, removed: 0, changed: 0 });
		expect(parsed.redactionApplied).toBe(true);
	});

	it("marks the result with redactionApplied=true and an ISO timestamp", async () => {
		const leftPath = await tmp({ a: 1 });
		const rightPath = await tmp({ a: 2 });

		const { parsed } = await callTool({
			left: leftPath,
			right: rightPath,
		});

		expect(parsed.redactionApplied).toBe(true);
		expect(typeof parsed.generatedAt).toBe("string");
		// ISO-8601 ends with "Z" when produced by toISOString().
		expect((parsed.generatedAt as string).endsWith("Z")).toBe(true);
	});
});

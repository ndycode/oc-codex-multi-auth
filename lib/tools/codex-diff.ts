/**
 * `codex-diff` tool — redacted structural diff of two config snapshots.
 *
 * Given two JSON file paths (typically account storage files, exported
 * account backups, or `opencode.json` configs) the tool:
 *
 * - reads both files and parses them as JSON
 * - walks the JSON tree and emits a sorted list of `added | removed |
 *   changed` entries keyed by dot-separated JSON paths
 * - redacts every emitted value through `maskString` (tokens, JWTs,
 *   emails) and strips the user's home directory from both input paths
 *   and any string values
 *
 * The output is safe to paste into bug reports or CI logs: tokens,
 * refresh tokens, and `~/…` usernames never survive verbatim.
 *
 * Intended use cases:
 *
 * - "did my local storage drift from a known-good backup?"
 * - "what is different between worktree A and worktree B config?"
 * - "compare a per-project account file against the global file"
 *
 * See docs/audits/08-feature-recommendations.md and
 * docs/audits/13-phased-roadmap.md §4 (Phase 4 F3).
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";

import { maskString } from "../logger.js";
import type { ToolContext } from "./index.js";

export interface CodexDiffEntry {
	/**
	 * Dot-separated JSON path of the leaf value, e.g.
	 * `accounts[0].refreshToken` or `schemaVersion`.
	 */
	path: string;
	kind: "added" | "removed" | "changed";
	/** Redacted string representation of the left-hand value. */
	leftValue?: string;
	/** Redacted string representation of the right-hand value. */
	rightValue?: string;
}

export interface CodexDiffResult {
	leftPath: string;
	rightPath: string;
	section: "accounts" | "config" | "both";
	entries: CodexDiffEntry[];
	summary: {
		added: number;
		removed: number;
		changed: number;
	};
	redactionApplied: true;
	generatedAt: string;
}

export interface CodexDiffError {
	error: "cannot-read" | "invalid-json";
	side: "left" | "right";
	path: string;
	message: string;
	redactionApplied: true;
	generatedAt: string;
}

/**
 * Replace occurrences of the user's home directory with the placeholder
 * `<HOME>` so shared diff output never leaks the reporter's username.
 * Mirrors the logic in `codex-diag.ts` intentionally — the two tools
 * ship the same guarantee.
 */
function redactHomePaths(input: string): string {
	const home = homedir();
	if (!home) return input;
	const needles = new Set<string>();
	needles.add(home);
	needles.add(home.replace(/\\/g, "/"));
	needles.add(home.replace(/\\/g, "\\\\"));
	let output = input;
	for (const needle of needles) {
		if (!needle) continue;
		while (output.includes(needle)) {
			output = output.replace(needle, "<HOME>");
		}
	}
	return output;
}

/** Redact a filesystem path for display in the diff output. */
function redactPath(p: string): string {
	return redactHomePaths(p);
}

/**
 * Convert a leaf JSON value into a redacted string representation.
 *
 * Non-string primitives are round-tripped through `JSON.stringify` so
 * numbers, booleans, and `null` keep their JSON form (`42`, `true`,
 * `null`). The result is then redacted in two layers:
 *  1. Key-aware: if the leaf's own key (e.g. `refreshToken`, `accountId`)
 *     names a sensitive field, the ENTIRE value is masked unconditionally.
 *     This is required because opaque tokens / ids / labels are not
 *     token-SHAPED, so `maskString` alone would emit them verbatim.
 *  2. Shape-based: `maskString` still catches JWT/`sk-`/hex/Bearer-shaped
 *     substrings embedded anywhere, and `redactHomePaths` scrubs home dirs.
 *
 * `terminalKey` is the final segment of the leaf's dotted path
 * (e.g. `refreshToken` for `accounts[0].refreshToken`).
 */
function redactValue(value: unknown, terminalKey?: string): string {
	if (value === undefined) return "undefined";
	const rendered =
		typeof value === "string" ? value : JSON.stringify(value);
	if (terminalKey !== undefined && isSensitiveLeafKey(terminalKey)) {
		// Mask the whole value regardless of shape; sensitive by key.
		return redactHomePaths(maskString(maskSensitiveLeaf(rendered)));
	}
	return redactHomePaths(maskString(rendered));
}

/**
 * Sensitive leaf keys whose VALUES must always be masked in diff output,
 * independent of whether the value looks token-shaped. Mirrors (a subset of)
 * the SENSITIVE_KEYS set in lib/logger.ts; kept local to avoid exporting the
 * logger internals. Keys are compared after stripping `-`/`_` and lowercasing.
 */
const SENSITIVE_LEAF_KEYS = new Set([
	"refreshtoken",
	"accesstoken",
	"idtoken",
	"token",
	"refresh",
	"access",
	"apikey",
	"authorization",
	"cookie",
	"setcookie",
	"clientsecret",
	"secret",
	"password",
]);

function isSensitiveLeafKey(key: string): boolean {
	return SENSITIVE_LEAF_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));
}

/**
 * Mask a sensitive leaf value while keeping a short, non-identifying hint of
 * length so a diff still shows "this field changed" without leaking the value.
 */
function maskSensitiveLeaf(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) return value;
	if (trimmed.length <= 8) return "***";
	return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
}

/**
 * Extract the terminal key from a leaf path produced by collectLeafPaths.
 * `accounts[0].refreshToken` -> `refreshToken`; `accounts[2]` -> undefined
 * (array index, not a named field).
 */
function terminalKeyOfPath(path: string): string | undefined {
	const lastDot = path.lastIndexOf(".");
	const seg = lastDot === -1 ? path : path.slice(lastDot + 1);
	// Strip a trailing array index (e.g. `tokens[3]`).
	const cleaned = seg.replace(/\[\d+\]$/, "");
	return cleaned.length > 0 && !/^\[\d+\]$/.test(seg) ? cleaned : undefined;
}

/**
 * Collect every leaf `(path, value)` pair for a JSON-like value.
 *
 * Objects become dotted paths (`a.b.c`), arrays become indexed paths
 * (`a[0].b`). The root of an object or array produces no entry of its
 * own — only leaves are emitted. An explicit `null` IS a leaf value.
 */
function collectLeafPaths(
	value: unknown,
	prefix: string,
	out: Map<string, unknown>,
): void {
	if (Array.isArray(value)) {
		if (value.length === 0) {
			out.set(prefix === "" ? "[]" : `${prefix}[]`, "[]");
			return;
		}
		value.forEach((item, index) => {
			const next = `${prefix}[${index}]`;
			collectLeafPaths(item, next, out);
		});
		return;
	}
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		if (keys.length === 0) {
			out.set(prefix === "" ? "{}" : `${prefix}.{}`, "{}");
			return;
		}
		for (const key of keys) {
			const child = (value as Record<string, unknown>)[key];
			const next = prefix === "" ? key : `${prefix}.${key}`;
			collectLeafPaths(child, next, out);
		}
		return;
	}
	// Primitive leaf (string, number, boolean, null, undefined).
	out.set(prefix, value);
}

function leafValuesEqual(a: unknown, b: unknown): boolean {
	// Structural equality for leaves. Most leaves are primitives; the
	// `"[]"`/`"{}"` sentinels emitted for empty containers are strings
	// which `Object.is` compares byte-for-byte.
	return Object.is(a, b);
}

/**
 * Compute a structural diff between two parsed JSON values.
 *
 * Entries are sorted alphabetically by `path` so the output is stable
 * regardless of object key order in the source files.
 */
export function computeCodexDiff(
	left: unknown,
	right: unknown,
): CodexDiffEntry[] {
	const leftPaths = new Map<string, unknown>();
	const rightPaths = new Map<string, unknown>();
	collectLeafPaths(left, "", leftPaths);
	collectLeafPaths(right, "", rightPaths);

	const allKeys = new Set<string>();
	for (const key of leftPaths.keys()) allKeys.add(key);
	for (const key of rightPaths.keys()) allKeys.add(key);

	const entries: CodexDiffEntry[] = [];
	for (const key of allKeys) {
		const hasLeft = leftPaths.has(key);
		const hasRight = rightPaths.has(key);
		const leftVal = leftPaths.get(key);
		const rightVal = rightPaths.get(key);
		if (hasLeft && hasRight) {
			if (leafValuesEqual(leftVal, rightVal)) continue;
			const terminalKey = terminalKeyOfPath(key);
			entries.push({
				path: key,
				kind: "changed",
				leftValue: redactValue(leftVal, terminalKey),
				rightValue: redactValue(rightVal, terminalKey),
			});
		} else if (hasRight) {
			entries.push({
				path: key,
				kind: "added",
				rightValue: redactValue(rightVal, terminalKeyOfPath(key)),
			});
		} else {
			entries.push({
				path: key,
				kind: "removed",
				leftValue: redactValue(leftVal, terminalKeyOfPath(key)),
			});
		}
	}
	entries.sort((a, b) => a.path.localeCompare(b.path));
	return entries;
}

/**
 * Extract a sub-tree of the parsed snapshot based on the `section`
 * parameter. `both` (default) diffs the entire document; `accounts`
 * diffs only the `accounts` array; `config` diffs every top-level key
 * except `accounts`.
 */
function extractSection(
	value: unknown,
	section: "accounts" | "config" | "both",
): unknown {
	if (section === "both") return value;
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (section === "accounts") {
		// Preserve the key so paths remain readable (`accounts[0].foo`).
		return { accounts: record.accounts ?? [] };
	}
	// section === "config": everything except `accounts`.
	const { accounts: _accounts, ...rest } = record;
	void _accounts;
	return rest;
}

async function readJsonFile(
	path: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: CodexDiffError["error"]; message: string }> {
	let raw: string;
	try {
		raw = await fs.readFile(path, "utf8");
	} catch (error) {
		return {
			ok: false,
			error: "cannot-read",
			message:
				error instanceof Error ? error.message : String(error),
		};
	}
	try {
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch (error) {
		return {
			ok: false,
			error: "invalid-json",
			message:
				error instanceof Error ? error.message : String(error),
		};
	}
}

export function createCodexDiffTool(_ctx: ToolContext): ToolDefinition {
	// The tool is intentionally closure-free — it depends on nothing
	// from `ToolContext`. We still take `ctx` so the factory signature
	// matches every other `codex-*` tool and future additions (e.g.
	// routing-snapshot embedding) don't break callers.
	void _ctx;
	return tool({
		description:
			"Compare two JSON config/account snapshots and emit a redacted structural diff. Tokens, emails, and home paths are masked; output is safe to share.",
		args: {
			left: tool.schema
				.string()
				.describe("Path to the left-hand JSON file (baseline)."),
			right: tool.schema
				.string()
				.describe(
					"Path to the right-hand JSON file (comparison target).",
				),
			section: tool.schema
				.string()
				.optional()
				.describe(
					"Which part of the document to diff: 'accounts' (accounts array only), 'config' (everything except accounts), or 'both' (default, whole document).",
				),
		},
		async execute({ left, right, section }) {
			const normalized = (section ?? "both").trim().toLowerCase();
			const effectiveSection: "accounts" | "config" | "both" =
				normalized === "accounts" ||
				normalized === "config" ||
				normalized === "both"
					? (normalized as "accounts" | "config" | "both")
					: "both";
			const [leftResult, rightResult] = await Promise.all([
				readJsonFile(left),
				readJsonFile(right),
			]);

			const generatedAt = new Date().toISOString();

			if (!leftResult.ok) {
				const errorPayload: CodexDiffError = {
					error: leftResult.error,
					side: "left",
					path: redactPath(left),
					message: redactHomePaths(maskString(leftResult.message)),
					redactionApplied: true,
					generatedAt,
				};
				return redactHomePaths(
					maskString(JSON.stringify(errorPayload, null, 2)),
				);
			}
			if (!rightResult.ok) {
				const errorPayload: CodexDiffError = {
					error: rightResult.error,
					side: "right",
					path: redactPath(right),
					message: redactHomePaths(maskString(rightResult.message)),
					redactionApplied: true,
					generatedAt,
				};
				return redactHomePaths(
					maskString(JSON.stringify(errorPayload, null, 2)),
				);
			}

			const leftSection = extractSection(
				leftResult.value,
				effectiveSection,
			);
			const rightSection = extractSection(
				rightResult.value,
				effectiveSection,
			);

			const entries = computeCodexDiff(leftSection, rightSection);
			const summary = entries.reduce(
				(acc, entry) => {
					acc[entry.kind] += 1;
					return acc;
				},
				{ added: 0, removed: 0, changed: 0 } as CodexDiffResult["summary"],
			);

			const result: CodexDiffResult = {
				leftPath: redactPath(left),
				rightPath: redactPath(right),
				section: effectiveSection,
				entries,
				summary,
				redactionApplied: true,
				generatedAt,
			};

			// Defence in depth: mask any stray token-shaped substring and
			// scrub home paths one more time across the rendered JSON.
			return redactHomePaths(
				maskString(JSON.stringify(result, null, 2)),
			);
		},
	});
}

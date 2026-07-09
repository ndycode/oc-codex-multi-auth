import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

vi.mock("node:fs", () => ({
	promises: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
	},
}));

const originalFetch = global.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

import { getModelFamily, getCodexInstructions, ensureInstructionIdentity, MODEL_FAMILIES, TOOL_REMAP_MESSAGE, __clearCacheForTesting } from "../lib/prompts/codex.js";

const mockedReadFile = vi.mocked(fs.readFile);
const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedMkdir = vi.mocked(fs.mkdir);

describe("Codex Prompts Module", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__clearCacheForTesting();
		mockFetch = vi.fn();
		global.fetch = mockFetch as unknown as typeof fetch;
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

			describe("MODEL_FAMILIES constant", () => {
			it("should export all model families", () => {
				expect(MODEL_FAMILIES).toContain("gpt-5-codex");
				expect(MODEL_FAMILIES).toContain("codex-max");
				expect(MODEL_FAMILIES).toContain("codex");
				expect(MODEL_FAMILIES).toContain("gpt-5.4");
				expect(MODEL_FAMILIES).toContain("gpt-5.4-mini");
				expect(MODEL_FAMILIES).toContain("gpt-5.4-pro");
				expect(MODEL_FAMILIES).toContain("gpt-5.2");
				expect(MODEL_FAMILIES).toContain("gpt-5.1");
			});

			it("should be a readonly array", () => {
				expect(Array.isArray(MODEL_FAMILIES)).toBe(true);
				expect(MODEL_FAMILIES.length).toBeGreaterThanOrEqual(8);
				expect(new Set(MODEL_FAMILIES).size).toBe(MODEL_FAMILIES.length);
			});
		});

		describe("TOOL_REMAP_MESSAGE constant", () => {
			it("should include schema guidance, illustrative note, and patch/apply_patch mentions", () => {
			expect(TOOL_REMAP_MESSAGE).toContain("exact tool names listed in the active tool schema/manifest");
			expect(TOOL_REMAP_MESSAGE).toContain("This list is illustrative. Always defer to the active tool schema/manifest");
			expect(TOOL_REMAP_MESSAGE).toContain("apply_patch");
			expect(TOOL_REMAP_MESSAGE).toContain("patch");
			expect(TOOL_REMAP_MESSAGE).toContain("edit");
			});

		it("should avoid hard-forcing apply_patch to patch", () => {
			expect(TOOL_REMAP_MESSAGE).not.toContain("Never call a tool literally named apply_patch/applyPatch");
			expect(TOOL_REMAP_MESSAGE).toContain("use the exact tool name from the active schema");
		});

		it("should contain update_plan replacement instruction", () => {
			expect(TOOL_REMAP_MESSAGE).toContain("UPDATE_PLAN DOES NOT EXIST");
			expect(TOOL_REMAP_MESSAGE).toContain("todowrite");
		});

		it("should list available tools", () => {
			expect(TOOL_REMAP_MESSAGE).toContain("write");
			expect(TOOL_REMAP_MESSAGE).toContain("edit");
			expect(TOOL_REMAP_MESSAGE).toContain("apply_patch");
			expect(TOOL_REMAP_MESSAGE).toContain("read");
			expect(TOOL_REMAP_MESSAGE).toContain("bash");
			expect(TOOL_REMAP_MESSAGE).toContain("grep");
		});
	});

			describe("getModelFamily", () => {
			it("should detect gpt-5.4, gpt-5.4-mini, and gpt-5.4-pro", () => {
				expect(getModelFamily("gpt-5.4")).toBe("gpt-5.4");
				expect(getModelFamily("gpt-5.4-high")).toBe("gpt-5.4");
				expect(getModelFamily("gpt-5.4-2026-03-05-high")).toBe("gpt-5.4");
				expect(getModelFamily("gpt-5.4-mini")).toBe("gpt-5.4-mini");
				expect(getModelFamily("gpt 5.4 mini high")).toBe("gpt-5.4-mini");
				expect(getModelFamily("gpt-5.4-mini-2026-03-05-high")).toBe("gpt-5.4-mini");
				expect(getModelFamily("gpt-5.4-pro")).toBe("gpt-5.4-pro");
				expect(getModelFamily("gpt 5.4 pro")).toBe("gpt-5.4-pro");
				expect(getModelFamily("gpt-5.4-pro-2026-03-05-high")).toBe("gpt-5.4-pro");
			});

			it("should not classify gpt-5.40 style names as gpt-5.4 family", () => {
				expect(getModelFamily("gpt-5.40")).toBe("gpt-5.1");
			});

			it("should detect gpt-5.3-codex-spark", () => {
				expect(getModelFamily("gpt-5.3-codex-spark")).toBe("gpt-5-codex");
			});

			it("should detect gpt-5.3-codex with space separator", () => {
				expect(getModelFamily("gpt 5.3 codex")).toBe("gpt-5-codex");
			});

			it("should detect gpt-5.2-codex with space separator", () => {
				expect(getModelFamily("gpt 5.2 codex")).toBe("gpt-5-codex");
			});

			it("should classify gpt-5 codex mini aliases under gpt-5-codex family", () => {
				expect(getModelFamily("gpt-5-codex-mini-low")).toBe("gpt-5-codex");
				expect(getModelFamily("gpt-5.1-codex-mini-low")).toBe("gpt-5-codex");
			});

		it("should detect models starting with codex-", () => {
			expect(getModelFamily("codex-mini")).toBe("codex");
			expect(getModelFamily("codex-latest")).toBe("codex");
		});
	});

	describe("getCodexInstructions", () => {
		describe("Memory cache behavior", () => {
			it("should return cached content within TTL", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve("cached instructions");
				});

				const first = await getCodexInstructions("gpt-5.1-codex");
				const second = await getCodexInstructions("gpt-5.1-codex");
				
				expect(first).toBe("cached instructions");
				expect(second).toBe(first);
			});
		});

		describe("Disk cache with TTL", () => {
			it("should use disk cache if within TTL", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve("disk cached instructions");
				});

				const result = await getCodexInstructions("gpt-5.2");
				expect(result).toBe("disk cached instructions");
			});

			it("prepends backend identity when native instructions have no model identity", () => {
				const result = ensureInstructionIdentity(
					"Existing native instructions.",
					"gpt-5.5",
				);

				expect(result).toContain(
					"You are the model identified to the backend as gpt-5.5, running in the Codex CLI, a terminal-based coding assistant.",
				);
				expect(result).toContain("Existing native instructions.");
			});

			it("rewrites the instruction identity to the exact backend model id", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(
						"You are GPT-5.2 running in the Codex CLI, a terminal-based coding assistant.\n\nRest of prompt.",
					);
				});

				const result = await getCodexInstructions("gpt-5.5");
				expect(result).toContain(
					"You are the model identified to the backend as gpt-5.5, running in the Codex CLI, a terminal-based coding assistant.",
				);
				expect(result).not.toContain("You are GPT-5.2 running in the Codex CLI");
			});

			it("keeps the backend model id accurate for legacy aliases too", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(
						"You are GPT-5.2 running in the Codex CLI, a terminal-based coding assistant.\n\nRest of prompt.",
					);
				});

				const result = await getCodexInstructions("gpt-5-codex");
				expect(result).toContain(
					"You are the model identified to the backend as gpt-5-codex, running in the Codex CLI, a terminal-based coding assistant.",
				);
			});

			it.each([
				"gpt-5.5",
				"gpt-5.4",
				"gpt-5.4-mini",
				"gpt-5.4-nano",
				"gpt-5.4-pro",
				"gpt-5.2",
				"gpt-5.1",
				"gpt-5-codex",
				"gpt-5.1-codex-max",
				"gpt-5.1-codex-mini",
			])("rewrites stale prompt-family identity for backend %s", async (backendModel) => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(
						"You are GPT-5.2 running in the Codex CLI, a terminal-based coding assistant.\n\nRest of prompt.",
					);
				});

				const result = await getCodexInstructions(backendModel);
				expect(result).toContain(
					`You are the model identified to the backend as ${backendModel}, running in the Codex CLI, a terminal-based coding assistant.`,
				);
				expect(result).not.toContain("You are GPT-5.2 running in the Codex CLI");
			});

			it("rewrites the current Codex-family identity line to the backend model id", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve(
						"You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.\n\nRest of prompt.",
					);
				});

				const result = await getCodexInstructions("gpt-5-codex");
				expect(result).toContain(
					"You are the model identified to the backend as gpt-5-codex, running in the Codex CLI, a terminal-based coding assistant.",
				);
				expect(result).not.toContain("You are Codex, based on GPT-5.");
			});
		});

		describe("GitHub fetch with ETag", () => {
			it("should fetch from GitHub API for latest release tag", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.50.0" }),
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve("new instructions from github"),
					headers: { get: () => "new-etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				const result = await getCodexInstructions("codex-max");
				expect(result).toBe("new instructions from github");
				expect(mockFetch).toHaveBeenCalledTimes(2);
			});

			it("should handle 304 Not Modified response", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "existing-etag",
							tag: "rust-v0.43.0",
							lastChecked: oldTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve("disk cached content");
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.43.0" }),
				});
				mockFetch.mockResolvedValueOnce({
					status: 304,
					ok: false,
				});

				const result = await getCodexInstructions("gpt-5.1");
				expect(result).toBe("disk cached content");
			});

			it("should refresh stale cache in background when release tag changes", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "old-etag",
							tag: "rust-v0.40.0",
							lastChecked: oldTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve("old content");
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.50.0" }),
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve("new version content"),
					headers: { get: () => "new-etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				const first = await getCodexInstructions("gpt-5.1-codex");
				expect(first).toBe("old content");
				await new Promise((resolve) => setTimeout(resolve, 0));
				const second = await getCodexInstructions("gpt-5.1-codex");
				expect(second).toBe("new version content");
			});
		});

		describe("GitHub HTML fallback", () => {
			it("should fall back to HTML releases page when API fails", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockResolvedValueOnce({
					ok: false,
					status: 403,
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					url: "https://github.com/openai/codex/releases/tag/rust-v0.45.0",
					text: () => Promise.resolve(""),
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve("fallback instructions"),
					headers: { get: () => "fallback-etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				const result = await getCodexInstructions("gpt-5.2-codex");
				expect(result).toBe("fallback instructions");
			});

			it("should parse tag from HTML content if URL parsing fails", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockResolvedValueOnce({
					ok: false,
					status: 500,
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					url: "https://github.com/openai/codex/releases/latest",
					text: () => Promise.resolve('<a href="/openai/codex/releases/tag/rust-v0.47.0">Release</a>'),
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve("html parsed instructions"),
					headers: { get: () => "html-etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				const result = await getCodexInstructions("codex");
				expect(result).toBe("html parsed instructions");
			});

		it("should fall back to bundled when HTML fallback page request fails", async () => {
			mockedReadFile.mockImplementation((filePath) => {
				if (typeof filePath === "string" && filePath.includes("codex-instructions.md")) {
					return Promise.resolve("bundled fallback content");
				}
				return Promise.reject(new Error("ENOENT"));
			});
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 403,
			});
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const result = await getCodexInstructions("gpt-5.2");
			expect(result).toBe("bundled fallback content");
		});

		it("should fall back to bundled when both URL parsing and HTML regex fail", async () => {
			mockedReadFile.mockImplementation((filePath) => {
				if (typeof filePath === "string" && filePath.includes("codex-instructions.md")) {
					return Promise.resolve("bundled fallback for regex fail");
				}
				return Promise.reject(new Error("ENOENT"));
			});
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 403,
			});
			mockFetch.mockResolvedValueOnce({
				ok: true,
				url: "https://github.com/openai/codex/releases/latest",
				text: () => Promise.resolve("no matching content here"),
			});

			const result = await getCodexInstructions("gpt-5.1");
			expect(result).toBe("bundled fallback for regex fail");
		});
	});

		describe("Fallback behavior", () => {
			it("should fall back to disk cache on fetch error", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached",
							tag: "old",
							lastChecked: oldTimestamp,
						}));
					}
					return Promise.resolve("fallback disk content");
				});
				mockFetch.mockRejectedValue(new Error("Network error"));

				const result = await getCodexInstructions("gpt-5.1");
				expect(result).toBe("fallback disk content");
			});

			it("should fall back to disk cache on HTTP error response", async () => {
				const oldTimestamp = Date.now() - 20 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached",
							tag: "rust-v0.43.0",
							lastChecked: oldTimestamp,
						}));
					}
					return Promise.resolve("disk cache fallback");
				});
				mockFetch.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.43.0" }),
				});
				mockFetch.mockResolvedValueOnce({
					ok: false,
					status: 500,
				});

				const result = await getCodexInstructions("gpt-5.2");
				expect(result).toBe("disk cache fallback");
			});

			it("should fall back to bundled instructions when all else fails", async () => {
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("codex-instructions.md")) {
						return Promise.resolve("bundled fallback instructions");
					}
					throw new Error("ENOENT");
				});
				mockFetch.mockRejectedValue(new Error("Network error"));

				const result = await getCodexInstructions("gpt-5.1");
				expect(result).toBe("bundled fallback instructions");
			});
		});

		describe("Cache size management", () => {
			it("should handle multiple model families without exceeding cache size", async () => {
				mockedReadFile.mockResolvedValue("instructions");
				
				for (const family of MODEL_FAMILIES) {
					const result = await getCodexInstructions(family);
					expect(result).toBeDefined();
				}
			});

			it("should evict oldest entry when cache exceeds max size", async () => {
				const recentTimestamp = Date.now() - 5 * 60 * 1000;
				mockedReadFile.mockImplementation((filePath) => {
					if (typeof filePath === "string" && filePath.includes("-meta.json")) {
						return Promise.resolve(JSON.stringify({
							etag: "cached-etag",
							tag: "rust-v0.43.0",
							lastChecked: recentTimestamp,
							url: "https://example.com",
						}));
					}
					return Promise.resolve("cached instructions");
				});

				for (let i = 0; i < 55; i++) {
					await getCodexInstructions(`test-model-${i}`);
				}
				
				const result = await getCodexInstructions("gpt-5.1-codex");
				expect(result).toBe("cached instructions");
			});
		});

			describe("Model family mapping", () => {
				it("should use correct prompt file for each model family", async () => {
				mockedReadFile.mockRejectedValue(new Error("ENOENT"));
				mockFetch.mockResolvedValue({
					ok: true,
					json: () => Promise.resolve({ tag_name: "rust-v0.43.0" }),
					text: () => Promise.resolve("content"),
					headers: { get: () => "etag" },
				});
				mockedMkdir.mockResolvedValue(undefined);
				mockedWriteFile.mockResolvedValue(undefined);

				await getCodexInstructions("gpt-5-codex");
				
				const fetchCalls = mockFetch.mock.calls;
				const rawGitHubCall = fetchCalls.find(call => 
					typeof call[0] === "string" && call[0].includes("raw.githubusercontent.com")
				);
					expect(rawGitHubCall?.[0]).toContain("gpt_5_codex_prompt.md");
				});

				it("should map gpt-5.3-codex prompts to the current codex prompt file", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockResolvedValue({
						ok: true,
						json: () => Promise.resolve({ tag_name: "rust-v0.98.0" }),
						text: () => Promise.resolve("content"),
						headers: { get: () => "etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					await getCodexInstructions("gpt-5.3-codex");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					expect(rawGitHubCall?.[0]).toContain("gpt_5_codex_prompt.md");
				});

				// Modern Codex sends per-model `base_instructions` from the model
				// catalog. gpt_5_2_prompt.md would open "You are GPT-5.2 running in
				// the Codex CLI", which is not what the backend expects for 5.4/5.5.
				const catalogPayload = JSON.stringify({
					models: [
						{ slug: "gpt-5.4", base_instructions: "GPT54 CATALOG PROMPT" },
						{ slug: "gpt-5.4-mini", base_instructions: "GPT54MINI CATALOG PROMPT" },
						{ slug: "gpt-5.5", base_instructions: "GPT55 CATALOG PROMPT" },
					],
				});

				it("should source gpt-5.4 instructions from the model catalog", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockResolvedValue({
						ok: true,
						json: () => Promise.resolve({ tag_name: "rust-v0.111.0" }),
						text: () => Promise.resolve(catalogPayload),
						headers: { get: () => "etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					const result = await getCodexInstructions("gpt-5.4");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					expect(rawGitHubCall?.[0]).toContain("models-manager/models.json");
					expect(result).toContain("GPT54 CATALOG PROMPT");
					// No prompt-file fetch when the catalog has the slug.
					expect(
						fetchCalls.some(
							(call) =>
								typeof call[0] === "string" && call[0].includes("gpt_5_2_prompt.md"),
						),
					).toBe(false);
				});

				it("should give gpt-5.5 its own catalog text and cache file, not gpt-5.4's", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockResolvedValue({
						ok: true,
						json: () => Promise.resolve({ tag_name: "rust-v0.111.0" }),
						text: () => Promise.resolve(catalogPayload),
						headers: { get: () => "etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					// gpt-5.5 and gpt-5.4 share the `gpt-5.4` model family, so a
					// family-keyed cache would let one serve the other's prompt.
					const result = await getCodexInstructions("gpt-5.5");
					expect(result).toContain("GPT55 CATALOG PROMPT");
					expect(result).not.toContain("GPT54 CATALOG PROMPT");

					const writeTargets = mockedWriteFile.mock.calls.map(([target]) =>
						String(target),
					);
					expect(
						writeTargets.some((target) =>
							target.includes("catalog-gpt-5.5-instructions.md"),
						),
					).toBe(true);
					expect(
						writeTargets.some((target) =>
							target.includes("catalog-gpt-5.4-instructions.md"),
						),
					).toBe(false);
				});

				// Regression: slug-space and family-space overlap. gpt-5.4-nano has no
				// catalog entry and lives in the `gpt-5.4` family, which IS a catalog
				// slug. An un-namespaced cache key let them serve each other's
				// instructions in-process within the TTL window.
				it("should not serve gpt-5.4 catalog text to gpt-5.4-nano within one TTL", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockImplementation((url: unknown) => {
						const href = String(url);
						const body = href.includes("models.json")
							? catalogPayload
							: "PROMPT FILE CONTENT";
						return Promise.resolve({
							ok: true,
							json: () => Promise.resolve({ tag_name: "rust-v0.111.0" }),
							text: () => Promise.resolve(body),
							headers: { get: () => "etag" },
						});
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					// Warm the catalog entry first, exactly as prewarmCodexInstructions does.
					const catalogResult = await getCodexInstructions("gpt-5.4");
					expect(catalogResult).toContain("GPT54 CATALOG PROMPT");

					// nano must NOT pick up the memory-cached catalog text.
					const nanoResult = await getCodexInstructions("gpt-5.4-nano");
					expect(nanoResult).toContain("PROMPT FILE CONTENT");
					expect(nanoResult).not.toContain("GPT54 CATALOG PROMPT");
				});

				it("should not let a prompt-file model poison a catalog model's cache", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockImplementation((url: unknown) => {
						const href = String(url);
						const body = href.includes("models.json")
							? catalogPayload
							: "PROMPT FILE CONTENT";
						return Promise.resolve({
							ok: true,
							json: () => Promise.resolve({ tag_name: "rust-v0.111.0" }),
							text: () => Promise.resolve(body),
							headers: { get: () => "etag" },
						});
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					// Reverse order: nano first, then gpt-5.4.
					const nanoResult = await getCodexInstructions("gpt-5.4-nano");
					expect(nanoResult).toContain("PROMPT FILE CONTENT");

					const catalogResult = await getCodexInstructions("gpt-5.4");
					expect(catalogResult).toContain("GPT54 CATALOG PROMPT");
					expect(catalogResult).not.toContain("PROMPT FILE CONTENT");
				});

				// prewarmCodexInstructions fires every catalog model concurrently, so a
				// memo that is only populated after the await lets each caller start
				// its own ~300KB models.json download.
				it("should fetch models.json once when catalog models are requested concurrently", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					let resolveCatalog: ((value: unknown) => void) | undefined;
					const catalogGate = new Promise((resolve) => {
						resolveCatalog = resolve;
					});

					mockFetch.mockImplementation((url: unknown) => {
						const href = String(url);
						if (href.includes("models.json")) {
							// Hold the fetch open so every caller arrives before it resolves.
							return catalogGate.then(() => ({
								ok: true,
								json: () => Promise.resolve({ tag_name: "rust-v0.111.0" }),
								text: () => Promise.resolve(catalogPayload),
								headers: { get: () => "etag" },
							}));
						}
						return Promise.resolve({
							ok: true,
							json: () => Promise.resolve({ tag_name: "rust-v0.111.0" }),
							text: () => Promise.resolve("PROMPT FILE CONTENT"),
							headers: { get: () => "etag" },
						});
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					const pending = Promise.all([
						getCodexInstructions("gpt-5.4"),
						getCodexInstructions("gpt-5.5"),
						getCodexInstructions("gpt-5.4-mini"),
					]);
					// Let all three reach fetchCatalogText before the fetch resolves.
					await new Promise((resolve) => setTimeout(resolve, 0));
					resolveCatalog?.(undefined);

					const [a, b, c] = await pending;
					expect(a).toContain("GPT54 CATALOG PROMPT");
					expect(b).toContain("GPT55 CATALOG PROMPT");
					expect(c).toContain("GPT54MINI CATALOG PROMPT");

					const catalogFetches = mockFetch.mock.calls.filter(
						(call) => typeof call[0] === "string" && call[0].includes("models.json"),
					);
					expect(catalogFetches).toHaveLength(1);
				});

				it("should fall back to the prompt file when the tag has no catalog entry", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					// Catalog without gpt-5.4 — simulates a release predating the slug.
					mockFetch.mockResolvedValue({
						ok: true,
						json: () => Promise.resolve({ tag_name: "rust-v0.111.0" }),
						text: () => Promise.resolve(JSON.stringify({ models: [] })),
						headers: { get: () => "etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					await getCodexInstructions("gpt-5.4");
					const fetchCalls = mockFetch.mock.calls;
					expect(
						fetchCalls.some(
							(call) =>
								typeof call[0] === "string" && call[0].includes("gpt_5_2_prompt.md"),
						),
					).toBe(true);
				});

				it("should still use the prompt file for models absent from the catalog", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockResolvedValue({
						ok: true,
						json: () => Promise.resolve({ tag_name: "rust-v0.111.0" }),
						text: () => Promise.resolve("content"),
						headers: { get: () => "etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					// gpt-5.1 has no catalog entry; it must not fetch models.json at all.
					await getCodexInstructions("gpt-5.1");
					const fetchCalls = mockFetch.mock.calls;
					expect(
						fetchCalls.some(
							(call) =>
								typeof call[0] === "string" && call[0].includes("models.json"),
						),
					).toBe(false);
					expect(
						fetchCalls.some(
							(call) =>
								typeof call[0] === "string" && call[0].includes("gpt_5_1_prompt.md"),
						),
					).toBe(true);
				});

				it("should map gpt-5.4-pro prompts to gpt_5_2 prompt file with isolated cache key", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockResolvedValue({
						ok: true,
						json: () => Promise.resolve({ tag_name: "rust-v0.111.0" }),
						text: () => Promise.resolve("content"),
						headers: { get: () => "etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					await getCodexInstructions("gpt-5.4-pro");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					const writeTargets = mockedWriteFile.mock.calls.map(([target]) => String(target));
					expect(rawGitHubCall?.[0]).toContain("gpt_5_2_prompt.md");
					expect(writeTargets.some((target) => target.includes("gpt-5.4-pro-instructions.md"))).toBe(true);
					expect(
						writeTargets.some((target) => /gpt-5\.4-instructions\.md$/.test(target)),
					).toBe(false);
				});

				it("should source gpt-5.4-mini from the catalog with an isolated cache key", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockResolvedValue({
						ok: true,
						json: () => Promise.resolve({ tag_name: "rust-v0.111.0" }),
						text: () => Promise.resolve(catalogPayload),
						headers: { get: () => "etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					const result = await getCodexInstructions("gpt-5.4-mini");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					const writeTargets = mockedWriteFile.mock.calls.map(([target]) => String(target));
					expect(rawGitHubCall?.[0]).toContain("models-manager/models.json");
					expect(result).toContain("GPT54MINI CATALOG PROMPT");
					expect(
						writeTargets.some((target) =>
							target.includes("catalog-gpt-5.4-mini-instructions.md"),
						),
					).toBe(true);
					expect(
						writeTargets.some((target) => /catalog-gpt-5\.4-instructions\.md$/.test(target)),
					).toBe(false);
					expect(
						writeTargets.some((target) => /gpt-5\.4-pro-instructions\.md$/.test(target)),
					).toBe(false);
				});

				it("should map gpt-5.3-codex-spark prompts to the current codex prompt file", async () => {
					mockedReadFile.mockRejectedValue(new Error("ENOENT"));
					mockFetch.mockResolvedValue({
						ok: true,
						json: () => Promise.resolve({ tag_name: "rust-v0.101.0" }),
						text: () => Promise.resolve("content"),
						headers: { get: () => "etag" },
					});
					mockedMkdir.mockResolvedValue(undefined);
					mockedWriteFile.mockResolvedValue(undefined);

					await getCodexInstructions("gpt-5.3-codex-spark");
					const fetchCalls = mockFetch.mock.calls;
					const rawGitHubCall = fetchCalls.find(
						(call) =>
							typeof call[0] === "string" &&
							call[0].includes("raw.githubusercontent.com"),
					);
					expect(rawGitHubCall?.[0]).toContain("gpt_5_codex_prompt.md");
				});
			});
		});
	});

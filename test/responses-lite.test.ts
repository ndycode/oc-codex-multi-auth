import { describe, it, expect } from "vitest";
import {
	RESPONSES_LITE_HEADER,
	applyResponsesLite,
	shapeBodyForModel,
	usesResponsesLite,
} from "../lib/request/helpers/responses-lite.js";
import { createCodexHeaders } from "../lib/request/fetch-helpers.js";
import type { RequestBody } from "../lib/types.js";

/**
 * Responses-lite shaping for GPT-5.6.
 *
 * Mirrors openai/codex `codex-rs/core/src/client.rs`: tools move into `input`
 * as a leading `additional_tools` developer item, base instructions follow as a
 * developer message, top-level `instructions` empties, `tools` is dropped, and
 * `parallel_tool_calls` is forced false.
 */
describe("responses-lite", () => {
	const LITE = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
	const NOT_LITE = [
		"gpt-5.5",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5-codex",
		"gpt-5.1-codex-max",
		"gpt-5.1",
	] as const;

	const makeBody = (overrides: Partial<RequestBody> = {}): RequestBody => ({
		model: "gpt-5.6-sol",
		instructions: "BASE INSTRUCTIONS",
		tools: [{ type: "function", name: "read_file" }],
		input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
		...overrides,
	});

	describe("model detection", () => {
		it("flags every 5.6 tier", () => {
			for (const model of LITE) expect(usesResponsesLite(model)).toBe(true);
		});

		it("does not flag pre-5.6 models", () => {
			for (const model of NOT_LITE) expect(usesResponsesLite(model)).toBe(false);
		});

		it("resolves selectors with effort suffixes and provider prefixes", () => {
			expect(usesResponsesLite("gpt-5.6-sol-xhigh")).toBe(true);
			expect(usesResponsesLite("gpt-5.6-terra-ultra")).toBe(true);
			expect(usesResponsesLite("openai/gpt-5.6-luna-max")).toBe(true);
			expect(usesResponsesLite("gpt-5.6")).toBe(true);
			expect(usesResponsesLite("openai/gpt-5.5-high")).toBe(false);
		});

		// gpt-5.1-codex-max ends in -max but is not a 5.6 model.
		it("does not mistake codex-max for a lite model", () => {
			expect(usesResponsesLite("gpt-5.1-codex-max")).toBe(false);
			expect(usesResponsesLite("gpt-5.1-codex-max-xhigh")).toBe(false);
		});

		it("handles undefined and empty input", () => {
			expect(usesResponsesLite(undefined)).toBe(false);
			expect(usesResponsesLite("")).toBe(false);
			expect(usesResponsesLite("   ")).toBe(false);
		});

		it("tolerates surrounding whitespace and case", () => {
			expect(usesResponsesLite("  gpt-5.6-sol  ")).toBe(true);
			expect(usesResponsesLite("GPT-5.6-Terra")).toBe(true);
		});
	});

	describe("body reshaping", () => {
		it("moves tools into input as a leading additional_tools developer item", () => {
			const body = applyResponsesLite(makeBody());
			const first = body.input?.[0] as Record<string, unknown>;
			expect(first.type).toBe("additional_tools");
			expect(first.role).toBe("developer");
			expect(first.tools).toEqual([{ type: "function", name: "read_file" }]);
		});

		it("drops the top-level tools key entirely", () => {
			const body = applyResponsesLite(makeBody());
			expect(body.tools).toBeUndefined();
			expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty("tools");
		});

		it("empties top-level instructions and re-adds them as a developer message", () => {
			const body = applyResponsesLite(makeBody());
			expect(body.instructions).toBe("");
			const second = body.input?.[1] as Record<string, unknown>;
			expect(second.type).toBe("message");
			expect(second.role).toBe("developer");
			expect(second.content).toEqual([
				{ type: "input_text", text: "BASE INSTRUCTIONS" },
			]);
		});

		it("omits the developer instructions message when instructions are empty", () => {
			const body = applyResponsesLite(makeBody({ instructions: "" }));
			expect(body.input?.length).toBe(2); // additional_tools + original user message
			expect((body.input?.[1] as Record<string, unknown>).role).toBe("user");
		});

		it("emits additional_tools even when there are no tools", () => {
			const body = applyResponsesLite(makeBody({ tools: undefined }));
			const first = body.input?.[0] as Record<string, unknown>;
			expect(first.type).toBe("additional_tools");
			expect(first.tools).toEqual([]);
		});

		it("preserves original input after the prefix, in order", () => {
			const body = applyResponsesLite(
				makeBody({
					input: [
						{ type: "message", role: "user", content: [] },
						{ type: "message", role: "assistant", content: [] },
					],
				}),
			);
			expect(body.input?.map((i) => i.role)).toEqual([
				"developer", // additional_tools
				"developer", // instructions
				"user",
				"assistant",
			]);
		});

		it("forces parallel_tool_calls off", () => {
			const body = applyResponsesLite(
				makeBody({ parallel_tool_calls: true } as Partial<RequestBody>),
			);
			expect(body.parallel_tool_calls).toBe(false);
		});

		it("handles a missing input array", () => {
			const body = applyResponsesLite(makeBody({ input: undefined }));
			expect(body.input?.length).toBe(2);
		});
	});

	describe("reasoning.context", () => {
		it("sets reasoning.context to all_turns on the lite body", () => {
			const body = applyResponsesLite(
				makeBody({ reasoning: { effort: "low", summary: "auto" } }),
			);
			expect(body.reasoning?.context).toBe("all_turns");
		});

		it("preserves an existing resolved effort and summary", () => {
			const body = applyResponsesLite(
				makeBody({ reasoning: { effort: "high", summary: "concise" } }),
			);
			expect(body.reasoning).toEqual({
				effort: "high",
				summary: "concise",
				context: "all_turns",
			});
		});

		it("sets reasoning.context even when the body has no reasoning", () => {
			const body = applyResponsesLite(makeBody({ reasoning: undefined }));
			expect(body.reasoning?.context).toBe("all_turns");
		});
	});

	describe("image detail stripping", () => {
		it("strips detail from message input_image content", () => {
			const body = applyResponsesLite(
				makeBody({
					instructions: "",
					input: [
						{
							type: "message",
							role: "user",
							content: [
								{ type: "input_image", image_url: "u", detail: "high" },
								{ type: "input_text", text: "keep" },
							],
						},
					],
				}),
			);
			const msg = body.input?.[1] as Record<string, unknown>;
			const content = msg.content as Record<string, unknown>[];
			expect(content[0]).not.toHaveProperty("detail");
			expect(content[0].image_url).toBe("u");
			expect(content[1]).toEqual({ type: "input_text", text: "keep" });
		});

		it("strips detail from function_call_output content", () => {
			const body = applyResponsesLite(
				makeBody({
					instructions: "",
					input: [
						{
							type: "function_call_output",
							role: "tool",
							output: {
								content: [{ type: "input_image", image_url: "u", detail: "low" }],
							},
						} as never,
					],
				}),
			);
			const out = (body.input?.[1] as Record<string, unknown>).output as Record<
				string,
				unknown
			>;
			expect((out.content as Record<string, unknown>[])[0]).not.toHaveProperty(
				"detail",
			);
		});

		it("tolerates a string function_call_output", () => {
			expect(() =>
				applyResponsesLite(
					makeBody({
						input: [
							{ type: "function_call_output", role: "tool", output: "plain" } as never,
						],
					}),
				),
			).not.toThrow();
		});
	});

	describe("request header", () => {
		it("sets the lite header for 5.6 models", () => {
			const headers = createCodexHeaders(undefined, "acct", "tok", {
				model: "gpt-5.6-sol",
			});
			expect(headers.get(RESPONSES_LITE_HEADER)).toBe("true");
		});

		it("does not set the lite header for pre-5.6 models", () => {
			for (const model of NOT_LITE) {
				const headers = createCodexHeaders(undefined, "acct", "tok", { model });
				expect(headers.get(RESPONSES_LITE_HEADER)).toBeNull();
			}
		});

		it("clears a caller-supplied lite header on a non-lite model", () => {
			const headers = createCodexHeaders(
				{ headers: { [RESPONSES_LITE_HEADER]: "true" } },
				"acct",
				"tok",
				{ model: "gpt-5.5" },
			);
			expect(headers.get(RESPONSES_LITE_HEADER)).toBeNull();
		});
	});

	describe("shapeBodyForModel", () => {
		it("returns the body untouched for a non-lite model", () => {
			const body = makeBody({ model: "gpt-5.5" });
			const shaped = shapeBodyForModel(body);
			expect(shaped).toBe(body); // same reference, no copy
			expect(shaped.tools).toEqual([{ type: "function", name: "read_file" }]);
			expect(shaped.instructions).toBe("BASE INSTRUCTIONS");
			expect(shaped.parallel_tool_calls).toBeUndefined();
		});

		it("shapes a lite model without mutating the canonical body", () => {
			const body = makeBody({ model: "gpt-5.6-sol" });
			const shaped = shapeBodyForModel(body);

			expect(shaped).not.toBe(body);
			expect(shaped.tools).toBeUndefined();
			expect(shaped.instructions).toBe("");

			// Canonical body survives intact for a later fallback hop.
			expect(body.tools).toEqual([{ type: "function", name: "read_file" }]);
			expect(body.instructions).toBe("BASE INSTRUCTIONS");
			expect(body.input?.length).toBe(1);
			expect(body.parallel_tool_calls).toBeUndefined();
		});

		it("is idempotent across repeated fallback hops", () => {
			const canonical = makeBody({ model: "gpt-5.6-sol" });

			const first = shapeBodyForModel(canonical);
			expect(first.input?.[0]).toMatchObject({ type: "additional_tools" });

			// Hop to a non-lite model: canonical is still classic, so the wire body is too.
			canonical.model = "gpt-5.5";
			const second = shapeBodyForModel(canonical);
			expect(second.tools).toEqual([{ type: "function", name: "read_file" }]);
			expect(JSON.stringify(second.input)).not.toContain("additional_tools");
		});

		it("does not deep-share input items with the canonical body", () => {
			const body = makeBody({
				model: "gpt-5.6-sol",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_image", image_url: "u", detail: "high" }],
					},
				],
			});
			shapeBodyForModel(body);
			// detail stripping happened on the copy only
			const original = body.input?.[0] as Record<string, unknown>;
			const content = original.content as Record<string, unknown>[];
			expect(content[0].detail).toBe("high");
		});

		it("does not add reasoning.context to a non-lite body", () => {
			const body = makeBody({
				model: "gpt-5.5",
				reasoning: { effort: "high", summary: "auto" },
			});
			const shaped = shapeBodyForModel(body);
			expect(shaped.reasoning?.context).toBeUndefined();
		});

		// The canonical body must stay free of `context`: the unsupported-model
		// fallback re-serializes it for a possibly non-lite model, and `all_turns`
		// is only valid alongside the responses-lite header.
		it("does not leak reasoning.context onto the canonical body of a lite model", () => {
			const original = makeBody({
				model: "gpt-5.6-sol",
				reasoning: { effort: "high", summary: "auto" },
			});
			const reasoningRef = original.reasoning;

			const shaped = shapeBodyForModel(original);
			expect(shaped.reasoning?.context).toBe("all_turns");

			expect(original.reasoning?.context).toBeUndefined();
			expect(original.reasoning).toBe(reasoningRef);
			expect(original.reasoning).toEqual({ effort: "high", summary: "auto" });
		});

		it("keeps a 5.6 -> 5.5 fallback free of reasoning.context", () => {
			const canonical = makeBody({
				model: "gpt-5.6-sol",
				reasoning: { effort: "high", summary: "auto" },
			});
			// First attempt goes out lite.
			expect(shapeBodyForModel(canonical).reasoning?.context).toBe("all_turns");

			// Account lacks 5.6 access; the fallback swaps the model and re-serializes.
			canonical.model = "gpt-5.5";
			const fallback = shapeBodyForModel(canonical);
			expect(fallback.reasoning?.context).toBeUndefined();
			expect(fallback.tools).toEqual([{ type: "function", name: "read_file" }]);
		});
	});
});

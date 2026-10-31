import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { getNormalizedModel, MODEL_MAP } from "../lib/request/helpers/model-map.js";
import { getModelFamily, MODEL_FAMILIES } from "../lib/prompts/codex.js";
import { normalizeModel, getReasoningConfig, transformRequestBody } from "../lib/request/request-transformer.js";
import {
	DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN,
	createCodexHeaders,
	transformRequestForCodex,
} from "../lib/request/fetch-helpers.js";
import {
	RESPONSES_LITE_HEADER,
	RESPONSES_LITE_HEADER_VALUE,
	shapeBodyForModel,
	usesResponsesLite,
} from "../lib/request/helpers/responses-lite.js";
import { resolveClientIdentity } from "../lib/request/helpers/client-identity.js";

const TERRA61 = "gpt-6.1-terra";
const SOL61 = "gpt-6.1-sol";
const TERRA61_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

describe("GPT-6.1 Terra Model Support", () => {
	it("keeps the canonical id and every catalog effort on Terra", () => {
		expect(normalizeModel(TERRA61)).toBe(TERRA61);
		expect(getNormalizedModel(TERRA61)).toBe(TERRA61);
		for (const effort of TERRA61_EFFORTS) {
			expect(normalizeModel(`${TERRA61}-${effort}`)).toBe(TERRA61);
		}
		expect(normalizeModel(`openai/${TERRA61}-high`)).toBe(TERRA61);
	});
	it("has no none/minimal alias", () => {
		expect(MODEL_MAP[`${TERRA61}-none`]).toBeUndefined();
		expect(MODEL_MAP[`${TERRA61}-minimal`]).toBeUndefined();
	});
	it("does not collapse Terra onto Sol", () => {
		expect(normalizeModel("GPT 6.1 Terra (OAuth)")).toBe(TERRA61);
		expect(normalizeModel("gpt-6.1")).toBe(SOL61);
	});
	it("has its own family", () => {
		expect(getModelFamily(TERRA61)).toBe(TERRA61);
		expect(getModelFamily(`${TERRA61}-ultra`)).toBe(TERRA61);
		expect(MODEL_FAMILIES).toContain(TERRA61);
	});
	it("accepts the catalog effort envelope", () => {
		expect(getReasoningConfig(TERRA61, { reasoningEffort: "max" }).effort).toBe("max");
		expect(getReasoningConfig(TERRA61, { reasoningEffort: "xhigh" }).effort).toBe("xhigh");
		expect(getReasoningConfig(TERRA61, { reasoningEffort: "ultra" }).effort).toBe("max");
		expect(getReasoningConfig(TERRA61, { reasoningEffort: "none" }).effort).toBe("low");
	});
	it("uses responses-lite and the opencode originator", () => {
		expect(usesResponsesLite(TERRA61)).toBe(true);
		expect(usesResponsesLite(`openai/${TERRA61}-high`)).toBe(true);
		expect(resolveClientIdentity(TERRA61).originator).toBe("opencode");
	});
	it("shapes a Terra request through the public transform and lite path", async () => {
		const transformed = await transformRequestBody(
			{ model: `${TERRA61}-ultra`, input: [], tools: [{ type: "function", name: "read_file" }] },
			"instructions",
			{ global: { reasoningEffort: "ultra" }, models: {} },
		);
		const shaped = shapeBodyForModel(transformed);
		expect(shaped.model).toBe(TERRA61);
		expect(shaped.reasoning?.effort).toBe("max");
		expect(shaped.tools).toBeUndefined();
		expect(shaped.input?.[0]).toMatchObject({ type: "additional_tools" });
	});
	it("serializes a native-mode Terra request with lite shaping and the lite header", async () => {
		const transformed = await transformRequestForCodex(
			{ method: "POST" },
			"https://chatgpt.com/backend-api/codex/responses",
			{ global: {}, models: {} },
			true,
			{
				model: `openai/${TERRA61}-high`,
				input: [{ type: "message", role: "user", content: "hi" }],
				tools: [{ type: "function", name: "read_file" }],
				store: true,
				reasoning: { effort: "high" },
			},
			{ requestTransformMode: "native" },
		);
		expect(transformed).toBeDefined();
		expect(transformed!.body.model).toBe(TERRA61);
		const wire = JSON.parse(String(transformed!.updatedInit.body)) as {
			model: string;
			tools?: unknown;
			input: Array<{ type?: string }>;
			store: boolean;
			include: string[];
			reasoning: { effort?: string; context?: string };
		};
		expect(wire.model).toBe(TERRA61);
		expect(wire.tools).toBeUndefined();
		expect(wire.input[0]).toMatchObject({ type: "additional_tools" });
		expect(wire.reasoning).toMatchObject({ effort: "high", context: "all_turns" });
		expect(wire.store).toBe(false);
		expect(wire.include).toContain("reasoning.encrypted_content");
		const headers = createCodexHeaders(transformed!.updatedInit, "acct", "token", { model: wire.model });
		expect(headers.get(RESPONSES_LITE_HEADER)).toBe(RESPONSES_LITE_HEADER_VALUE);
	});
	it.each([
		[TERRA61, "ultra", "max"],
		[TERRA61, "none", "low"],
		[TERRA61, "xhigh", "xhigh"],
		[SOL61, "ultra", "max"],
		["gpt-5.5", "max", "xhigh"],
	])("clamps a native-mode %s effort %s to %s on the wire", async (model, effort, expected) => {
		const transformed = await transformRequestForCodex(
			{ method: "POST" },
			"https://chatgpt.com/backend-api/codex/responses",
			{ global: {}, models: {} },
			true,
			{ model, input: [], reasoning: { effort, summary: "auto" } },
			{ requestTransformMode: "native" },
		);
		const wire = JSON.parse(String(transformed!.updatedInit.body)) as {
			reasoning: { effort?: string; summary?: string };
		};
		expect(wire.reasoning.effort).toBe(expected);
		expect(wire.reasoning.summary).toBe("auto");
	});
	it("leaves a native-mode body without an effort alone", async () => {
		const transformed = await transformRequestForCodex(
			{ method: "POST" },
			"https://chatgpt.com/backend-api/codex/responses",
			{ global: {}, models: {} },
			true,
			{ model: "gpt-5.5", input: [] },
			{ requestTransformMode: "native" },
		);
		const wire = JSON.parse(String(transformed!.updatedInit.body)) as { reasoning?: unknown };
		expect(wire.reasoning).toBeUndefined();
	});
	it("ships each effort in both templates", () => {
		const modern = JSON.parse(readFileSync("config/opencode-modern.json", "utf8"));
		const legacy = JSON.parse(readFileSync("config/opencode-legacy.json", "utf8"));
		expect(Object.keys(modern.provider.openai.models[TERRA61].variants)).toEqual(
			[...TERRA61_EFFORTS],
		);
		expect(modern.provider.openai.models[TERRA61].options.reasoningEffort).toBe("low");
		for (const effort of TERRA61_EFFORTS) {
			expect(legacy.provider.openai.models[`${TERRA61}-${effort}`].options.reasoningEffort).toBe(
				effort,
			);
		}
	});
	it("does not change fallback chains", () => {
		expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[TERRA61]).toBeUndefined();
		for (const chain of Object.values(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN)) {
			expect(chain).not.toContain(TERRA61);
		}
	});
});

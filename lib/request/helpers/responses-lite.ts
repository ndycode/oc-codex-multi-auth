/**
 * Responses-lite request shaping.
 *
 * GPT-5.6 models carry `use_responses_lite: true` in the Codex model catalog
 * (openai/codex `codex-rs/models-manager/models.json`). Codex sends those
 * models a materially different request body — see
 * `codex-rs/core/src/client.rs`:
 *
 *   let (instructions, tools) = if model_info.use_responses_lite {
 *       let mut prefix = vec![ResponseItem::AdditionalTools { .. }];
 *       if !prompt.base_instructions.text.is_empty() { prefix.push(developer message) }
 *       input.splice(0..0, prefix);
 *       (String::new(), None)
 *   } else {
 *       (prompt.base_instructions.text.clone(), Some(tools))
 *   };
 *   ...
 *   parallel_tool_calls: prompt.parallel_tool_calls && !model_info.use_responses_lite,
 *
 * So for a lite model the tool definitions move *into* `input` as a leading
 * `additional_tools` developer item (function tools grouped into one
 * `functions` namespace, and the item skipped when there are no tools), the
 * base instructions follow as a developer message, and neither top-level
 * `instructions` nor `tools` is sent. Codex also strips image `detail` fields and
 * sends an `x-openai-internal-codex-responses-lite: true` header.
 *
 * Sending the classic shape to a lite model is what this module exists to
 * prevent: `gpt-5.6-*` is `tool_mode: "code_mode_only"`, so tools declared at
 * the top level rather than as `additional_tools` are not guaranteed to be
 * honored.
 */
import {
	DAYBREAK_BLUE_MODEL_ID,
	DAYBREAK_RED_MODEL_ID,
	GPT_56_CYBER_MODEL_ID,
	GPT_56_LUNA_MODEL_ID,
	GPT_56_SOL_MODEL_ID,
	GPT_56_TERRA_MODEL_ID,
	GPT_6_ASTRA_MODEL_ID,
	GPT_6_LUNA_MODEL_ID,
	GPT_6_SOL_MODEL_ID,
	GPT_61_SOL_MODEL_ID,
	GPT_61_TERRA_MODEL_ID,
	getNormalizedModel,
} from "./model-map.js";
import { stripEffortSuffix } from "./effort-suffix.js";
import type { InputItem, RequestBody } from "../../types.js";

/** Canonical model ids whose catalog entry sets `use_responses_lite: true`. */
const RESPONSES_LITE_MODELS: ReadonlySet<string> = new Set([
	GPT_56_SOL_MODEL_ID,
	GPT_56_TERRA_MODEL_ID,
	GPT_56_LUNA_MODEL_ID,
	// Both Daybreak tiers are `use_responses_lite: true`, `tool_mode:
	// "code_mode_only"` in the catalog — read directly from models.json.
	DAYBREAK_BLUE_MODEL_ID,
	DAYBREAK_RED_MODEL_ID,
	// `gpt-5.6-cyber` has no catalog entry under its own slug, but it is an
	// alias for the two Daybreak tiers above, both catalog-verified lite, and
	// every 5.6-generation model in the catalog is lite.
	GPT_56_CYBER_MODEL_ID,
	// Astra shipped without a catalog entry, so 6.17.0 inferred this and kept it
	// behind `CODEX_AUTH_ASTRA_RESPONSES_LITE`. openai/codex commit ed391d4d
	// (2026-09-03T20:05:58Z) added the entry, and it reads
	// `use_responses_lite: true`, `tool_mode: "code_mode_only"`,
	// `multi_agent_version: "v2"`. The inference was right, so it is now read
	// rather than guessed and the switch is gone.
	GPT_6_ASTRA_MODEL_ID,
	// `use_responses_lite: true` in their catalog entries (openai/codex 49e95cc7).
	GPT_6_SOL_MODEL_ID,
	GPT_6_LUNA_MODEL_ID,
	// `use_responses_lite: true` in its catalog entry (openai/codex b1e72963,
	// PR #49318), alongside `tool_mode: "code_mode_only"` and
	// `multi_agent_version: "v2"`.
	GPT_61_SOL_MODEL_ID,
	GPT_61_TERRA_MODEL_ID,
]);

/** Header Codex sets on every responses-lite request. */
export const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
export const RESPONSES_LITE_HEADER_VALUE = "true";

/**
 * Whether a model expects the responses-lite request shape.
 *
 * Accepts raw selectors (`openai/gpt-5.6-sol-xhigh`) as well as canonical ids.
 */
export function usesResponsesLite(model: string | undefined): boolean {
	if (!model) return false;
	const trimmed = model.trim();
	if (!trimmed) return false;
	const withoutPrefix = trimmed.includes("/")
		? (trimmed.split("/").pop() ?? trimmed)
		: trimmed;
	const stripped = stripEffortSuffix(withoutPrefix).toLowerCase();
	const canonical = getNormalizedModel(stripped) ?? stripped;
	return RESPONSES_LITE_MODELS.has(canonical);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drop `detail` from every input image, mirroring `strip_image_details` in
 * `codex-rs/core/src/client_common.rs`. Applies to message content and to
 * function/custom tool call outputs.
 */
function stripImageDetails(items: InputItem[]): void {
	const stripContent = (content: unknown): void => {
		if (!Array.isArray(content)) return;
		for (const entry of content) {
			if (isRecord(entry) && entry.type === "input_image" && "detail" in entry) {
				delete entry.detail;
			}
		}
	};

	for (const item of items) {
		if (!isRecord(item)) continue;
		stripContent(item.content);

		if (
			item.type === "function_call_output" ||
			item.type === "custom_tool_call_output"
		) {
			const output = item.output;
			if (isRecord(output)) {
				stripContent(output.content);
			}
		}
	}
}

/** Namespace Codex groups top-level function and custom tools under. */
export const DEFAULT_FUNCTION_NAMESPACE = "functions";

/**
 * Group function and custom tools into one `functions` namespace, mirroring
 * `create_tools_json_for_responses_lite` (codex-rs/tools/src/tool_spec.rs):
 * the namespace takes the position of the first function-like tool, an
 * existing `functions` namespace is merged into it, and every other tool type
 * (web search, image generation, foreign namespaces) passes through unchanged.
 */
export function groupToolsForResponsesLite(tools: unknown[]): unknown[] {
	const functions: { type: "namespace"; name: string; description: string; tools: unknown[] } = {
		type: "namespace",
		name: DEFAULT_FUNCTION_NAMESPACE,
		description: "",
		tools: [],
	};
	let functionsIndex: number | undefined;
	const out: unknown[] = [];
	for (const tool of tools) {
		if (isRecord(tool) && (tool.type === "function" || tool.type === "custom")) {
			functions.tools.push(tool);
		} else if (
			isRecord(tool) &&
			tool.type === "namespace" &&
			tool.name === DEFAULT_FUNCTION_NAMESPACE
		) {
			if (typeof tool.description === "string" && tool.description.trim()) {
				functions.description = tool.description;
			}
			if (Array.isArray(tool.tools)) functions.tools.push(...tool.tools);
		} else {
			out.push(tool);
			continue;
		}
		functionsIndex ??= out.length;
	}
	if (functionsIndex !== undefined && functions.tools.length > 0) {
		out.splice(functionsIndex, 0, functions);
	}
	return out;
}

/**
 * The request's input as a list of items. The Responses API also accepts a
 * plain string, which is shorthand for one user message; prepending items to
 * it must keep that prompt rather than discard it.
 */
function inputItems(input: unknown): InputItem[] {
	if (Array.isArray(input)) return input as InputItem[];
	if (typeof input === "string" && input.length > 0) {
		return [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: input }],
			} as unknown as InputItem,
		];
	}
	return [];
}

/** Base instructions as the leading developer message Codex sends. */
function instructionsMessage(instructions: string): InputItem {
	return {
		type: "message",
		role: "developer",
		content: [{ type: "input_text", text: instructions }],
	} as unknown as InputItem;
}

/**
 * Serialize-time shaping: return the body as it should go on the wire for
 * `body.model`.
 *
 * Since Codex 0.162 (openai/codex c9253c49) no request carries a top-level
 * `instructions` field: the base instructions travel as the first developer
 * message in `input` for every model, lite or classic. Lite models then add
 * the `additional_tools` item in front of it. A `reasoning.summary` of `none`
 * is dropped, as Codex omits the field rather than sending `none`.
 *
 * The canonical transformed body is always kept in the classic shape. The wire
 * shape is a per-attempt, model-dependent view of it, derived from a deep copy
 * so the canonical body is never mutated.
 *
 * This matters for the unsupported-model fallback: a `gpt-5.6-sol` request that
 * degrades to `gpt-5.5` must be sent in the classic shape. If the canonical
 * body had been reshaped in place, the fallback would ship a non-lite model a
 * body with no top-level `tools` — its tool definitions stranded in an
 * `additional_tools` item that a non-lite model does not interpret.
 */
export function shapeBodyForModel(body: RequestBody): RequestBody {
	const lite = usesResponsesLite(body.model);
	if (!lite && !("instructions" in body) && body.reasoning?.summary !== "none") {
		return body;
	}
	const shaped = structuredClone(body);
	if (lite) {
		applyResponsesLite(shaped);
	} else {
		moveInstructionsIntoInput(shaped);
	}
	if (shaped.reasoning?.summary === "none") {
		delete shaped.reasoning.summary;
	}
	return shaped;
}

/** Move top-level `instructions` into a leading developer message, in place. */
function moveInstructionsIntoInput(body: RequestBody): void {
	// Upstream checks `!text.is_empty()`, not a trimmed check.
	const instructions = typeof body.instructions === "string" ? body.instructions : "";
	if (instructions.length > 0) {
		body.input = [instructionsMessage(instructions), ...inputItems(body.input)];
	}
	// `undefined` drops the key entirely on JSON.stringify.
	body.instructions = undefined;
}

/**
 * Rewrite a request body into the responses-lite shape, in place.
 *
 * Prefer {@link shapeBodyForModel} at call sites; this is exported for tests
 * and for callers that already own a throwaway copy. Mutates and returns the
 * same body object.
 */
export function applyResponsesLite(body: RequestBody): RequestBody {
	const tools = Array.isArray(body.tools) ? body.tools : [];

	// Codex skips the additional_tools item when the turn has no tools
	// (openai/codex 6326163b) and groups function tools into one namespace.
	const prefix: InputItem[] = [];
	if (tools.length > 0) {
		prefix.push({
			type: "additional_tools",
			role: "developer",
			tools: groupToolsForResponsesLite(tools),
		} as unknown as InputItem);
	}

	// Upstream checks `!text.is_empty()`, not a trimmed check.
	const instructions =
		typeof body.instructions === "string" ? body.instructions : "";
	if (instructions.length > 0) {
		prefix.push(instructionsMessage(instructions));
	}

	body.input = [...prefix, ...inputItems(body.input)];

	// Top-level instructions and tools are omitted; both now live in `input`.
	// `undefined` drops the key entirely on JSON.stringify.
	body.instructions = undefined;
	body.tools = undefined;

	// Lite requests never fan out tool calls.
	body.parallel_tool_calls = false;

	stripImageDetails(body.input);

	body.reasoning = { ...body.reasoning, context: "all_turns" };

	return body;
}

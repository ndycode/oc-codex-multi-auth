import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildRoutingHint,
	normalizeServiceTier,
	resolveServiceTierForModel,
} from "../lib/request/helpers/codex-catalog.js";
import {
	createCodexHeaders,
	getRequestedServiceTier,
	transformRequestForCodex,
} from "../lib/request/fetch-helpers.js";
import { getReasoningConfig } from "../lib/request/request-transformer.js";
import { TurnStateStore, isTurnContinuation } from "../lib/request/turn-state.js";
import type { InputItem, RequestBody } from "../lib/types.js";

const URL = "https://chatgpt.com/backend-api/codex/responses";
const NO_CONFIG = { global: {}, models: {} };

async function nativeWire(body: Record<string, unknown>, userConfig = NO_CONFIG) {
	const result = await transformRequestForCodex(
		{ method: "POST" },
		URL,
		userConfig,
		true,
		{ input: [], ...body },
		{ requestTransformMode: "native" },
	);
	return {
		result: result!,
		wire: JSON.parse(String(result!.updatedInit.body)) as Record<string, unknown>,
	};
}

describe("Codex 0.166 catalog parity", () => {
	afterEach(() => vi.unstubAllEnvs());

	describe("service tier resolution (ModelInfo::service_tier_for_request)", () => {
		it("normalizes Codex's UI names", () => {
			expect(normalizeServiceTier("Fast")).toBe("priority");
			expect(normalizeServiceTier(" priority ")).toBe("priority");
			expect(normalizeServiceTier("standard")).toBe("default");
			expect(normalizeServiceTier("")).toBeUndefined();
			expect(normalizeServiceTier(42)).toBeUndefined();
		});

		it.each([
			["gpt-6-sol", undefined, "priority"],
			["gpt-6-luna", undefined, "priority"],
			["gpt-6.1-sol", undefined, undefined],
			["gpt-6-sol", "default", undefined],
			["gpt-6-sol", "auto", undefined],
			["gpt-6.1-terra", "fast", "priority"],
			["gpt-5.5", "priority", "priority"],
			["gpt-daybreak-blue-latest", "priority", undefined],
			["gpt-daybreak-blue-latest", "flex", "flex"],
			["gpt-5.1", "priority", undefined],
			["gpt-5.1", undefined, undefined],
		])("%s with %s -> %s", (model, requested, expected) => {
			expect(resolveServiceTierForModel(model, requested)).toBe(expected);
		});

		it("builds the routing hint like build_routing_hint_header", () => {
			expect(buildRoutingHint("gpt-6-sol", "priority")).toBe("model=gpt-6-sol;tier=priority");
			expect(buildRoutingHint("gpt-5.5", undefined)).toBe("model=gpt-5.5");
		});

		it("reads the requested tier from body, provider options, config, then a -fast selector", () => {
			const body = (extra: Partial<RequestBody>): RequestBody => ({ model: "gpt-5.5", ...extra });
			expect(getRequestedServiceTier("gpt-5.5", body({ service_tier: "flex" }), NO_CONFIG)).toBe("flex");
			expect(
				getRequestedServiceTier("gpt-5.5", body({ providerOptions: { openai: { serviceTier: "fast" } } }), NO_CONFIG),
			).toBe("fast");
			expect(
				getRequestedServiceTier("gpt-5.5", body({}), { global: { serviceTier: "priority" }, models: {} }),
			).toBe("priority");
			expect(getRequestedServiceTier("openai/gpt-5.5-fast-medium", body({}), NO_CONFIG)).toBe("priority");
			expect(getRequestedServiceTier("gpt-5.5", body({}), NO_CONFIG)).toBeUndefined();
		});

		it("makes gpt-5.5-fast actually request the Fast tier on the wire", async () => {
			const { wire } = await nativeWire({ model: "gpt-5.5-fast" });
			expect(wire.model).toBe("gpt-5.5");
			expect(wire.service_tier).toBe("priority");
		});

		it("applies the catalog default Fast tier to gpt-6-sol, with a default opt-out", async () => {
			expect((await nativeWire({ model: "gpt-6-sol" })).wire.service_tier).toBe("priority");
			expect((await nativeWire({ model: "gpt-6-sol", service_tier: "default" })).wire).not.toHaveProperty(
				"service_tier",
			);
			expect(
				(await nativeWire({ model: "gpt-6-luna" }, { global: { serviceTier: "default" }, models: {} })).wire,
			).not.toHaveProperty("service_tier");
		});

		it("drops a tier the model does not advertise and keeps the requested tier for fallback", async () => {
			const { wire, result } = await nativeWire({ model: "gpt-daybreak-blue-latest", service_tier: "priority" });
			expect(wire).not.toHaveProperty("service_tier");
			expect(result.requestedServiceTier).toBe("priority");
		});

		it("resolves the tier in legacy mode too", async () => {
			const result = await transformRequestForCodex(
				{ method: "POST" },
				URL,
				NO_CONFIG,
				true,
				{ model: "gpt-6-sol", input: [] },
			);
			expect(JSON.parse(String(result!.updatedInit.body)).service_tier).toBe("priority");
		});
	});

	describe("ultra resolution (resolve_reasoning_effort)", () => {
		it.each([
			["gpt-6-astra", "xhigh"],
			["gpt-6.1-sol", "xhigh"],
			["gpt-6.1-terra", "xhigh"],
			["gpt-6-sol", "max"],
			["gpt-5.6-sol", "max"],
			["gpt-daybreak-red-latest", "max"],
		])("%s sends ultra as %s", (model, expected) => {
			expect(getReasoningConfig(model, { reasoningEffort: "ultra" }).effort).toBe(expected);
		});
	});

	describe("reasoning summary", () => {
		it("honors an explicit none/off by omitting the field, and keeps auto by default", async () => {
			expect(getReasoningConfig("gpt-5.5", { reasoningSummary: "none" }).summary).toBe("none");
			expect(getReasoningConfig("gpt-5.5", { reasoningSummary: "off" }).summary).toBe("none");
			expect(getReasoningConfig("gpt-5.5", {}).summary).toBe("auto");
			const result = await transformRequestForCodex(
				{ method: "POST" },
				URL,
				{ global: { reasoningSummary: "none" }, models: {} },
				true,
				{ model: "gpt-5.5", input: [] },
			);
			const wire = JSON.parse(String(result!.updatedInit.body));
			expect(wire.reasoning).toBeDefined();
			expect(wire.reasoning).not.toHaveProperty("summary");
		});
	});

	describe("request headers", () => {
		it("sends the current session-id/thread-id alongside the legacy pair", () => {
			const headers = createCodexHeaders(undefined, "acct", "tok", { model: "gpt-5.5", promptCacheKey: "ses-1" });
			for (const name of ["session-id", "thread-id", "session_id", "conversation_id"]) {
				expect(headers.get(name)).toBe("ses-1");
			}
			const none = createCodexHeaders(new Headers({ "session-id": "stale", "thread-id": "stale" }), "acct", "tok", {
				model: "gpt-5.5",
			});
			expect(none.get("session-id")).toBeNull();
			expect(none.get("thread-id")).toBeNull();
		});

		it("sends the routing hint with the resolved tier", () => {
			expect(
				createCodexHeaders(undefined, "acct", "tok", { model: "gpt-6-sol", serviceTier: "priority" }).get(
					"x-codex-routing-hint",
				),
			).toBe("model=gpt-6-sol;tier=priority");
			expect(createCodexHeaders(undefined, "acct", "tok", { model: "gpt-5.5" }).get("x-codex-routing-hint")).toBe(
				"model=gpt-5.5",
			);
		});

		it("sends version only under the Codex CLI identity", () => {
			vi.stubEnv("CODEX_AUTH_CLIENT_VERSION", "0.166.0");
			const codex = createCodexHeaders(undefined, "acct", "tok", { model: "gpt-5.5" });
			expect(codex.get("originator")).toBe("codex_cli_rs");
			expect(codex.get("version")).toBe("0.166.0");
			const lite = createCodexHeaders(undefined, "acct", "tok", { model: "gpt-6.1-sol" });
			expect(lite.get("originator")).toBe("opencode");
			expect(lite.get("version")).toBeNull();
		});

		it("sends x-codex-turn-state only when given", () => {
			expect(
				createCodexHeaders(undefined, "acct", "tok", { model: "gpt-5.5", turnState: "ts" }).get("x-codex-turn-state"),
			).toBe("ts");
			expect(
				createCodexHeaders(new Headers({ "x-codex-turn-state": "stale" }), "acct", "tok", { model: "gpt-5.5" }).get(
					"x-codex-turn-state",
				),
			).toBeNull();
		});
	});

	describe("turn-state store", () => {
		const user: InputItem[] = [{ type: "message", role: "user", content: "hi" }];
		const toolResult: InputItem[] = [...user, { type: "function_call_output", role: "tool", call_id: "c", output: "ok" }];

		it("detects continuations from the last input item", () => {
			expect(isTurnContinuation(undefined)).toBe(false);
			expect(isTurnContinuation(user)).toBe(false);
			expect(isTurnContinuation(toolResult)).toBe(true);
		});

		it("replays the first token of a turn and resets on the next user turn", () => {
			const store = new TurnStateStore();
			expect(store.forRequest("s", "a", user)).toBeUndefined();
			store.capture("s", "a", new Headers({ "x-codex-turn-state": "t1" }));
			store.capture("s", "a", new Headers({ "x-codex-turn-state": "t2" }));
			expect(store.forRequest("s", "a", toolResult)).toBe("t1");
			// A different account never sees another owner's token.
			expect(store.forRequest("s", "b", toolResult)).toBeUndefined();
			// A new user turn clears it.
			expect(store.forRequest("s", "a", user)).toBeUndefined();
			expect(store.forRequest("s", "a", toolResult)).toBeUndefined();
		});

		it("ignores requests without a session key and bounds its size", () => {
			const store = new TurnStateStore(2);
			store.capture(undefined, "a", new Headers({ "x-codex-turn-state": "t" }));
			expect(store.size).toBe(0);
			for (const session of ["s1", "s2", "s3"]) {
				store.capture(session, "a", new Headers({ "x-codex-turn-state": session }));
			}
			expect(store.size).toBe(2);
			expect(store.forRequest("s1", "a", toolResult)).toBeUndefined();
			expect(store.forRequest("s3", "a", toolResult)).toBe("s3");
		});
	});
});

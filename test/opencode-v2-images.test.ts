import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model, Provider, type Plugin } from "@opencode/plugin";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ loadAccounts: vi.fn(), refresh: vi.fn() }));
vi.mock("../lib/storage.js", () => ({ loadAccounts: mocks.loadAccounts }));
vi.mock("../lib/storage/coordinated-refresh.js", () => ({ coordinatePersistedRefresh: mocks.refresh }));
vi.mock("../lib/opencode-v2-status.js", () => ({ readV2Status: vi.fn() }));
import { createV2Fetch, setupV2 } from "../lib/opencode-v2.js";

function fakeOAuth(methodID = "codex-multi-0", accountID = "FAKE_ACCOUNT") {
  return {
    type: "oauth", methodID, refresh: "FAKE_REFRESH", expires: Date.now() + 600_000,
    access: `FAKE.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountID } })).toString("base64url")}.FAKE`,
  };
}

function imageHost() {
  const sourceProvider = Provider.Info.empty(Provider.ID.make("openai"));
  sourceProvider.package = "@opencode/ai/providers/openai";
  sourceProvider.settings = { baseURL: "https://api.openai.com/v1", transport: "websocket", custom: "keep" };
  sourceProvider.headers = { "x-provider": "keep" };
  const chat = Model.Info.default(sourceProvider.id, Model.ID.make("gpt-6.1-sol"));
  const image = Model.Info.default(sourceProvider.id, Model.ID.make("gpt-image-2"));
  Object.assign(image, { type: "image", package: "@opencode/ai/providers/openai/images", headers: { "x-model": "keep" } });
  const sourceModels = [chat, image];
  const providerTransforms: Array<(editor: unknown) => void> = [];
  const modelTransforms: Array<(editor: unknown) => void> = [];
  const hooks = new Map<string, (event: unknown) => Promise<void>>();
  let provider = structuredClone(sourceProvider);
  let models = structuredClone(sourceModels);
  let providerModels = structuredClone(sourceModels);
  let scopedConnection: { type: "credential"; id: string } | undefined;
  const snapshot = () => ({ provider, models, providerModels });
  const render = () => {
    provider = structuredClone(sourceProvider);
    models = structuredClone(sourceModels);
    const update = (_provider: string, id: string, fn: (draft: typeof image) => void) => fn(models.find(m => m.id === id)!);
    const editor = {
      get: () => ({ provider, models: new Map(models.map(m => [m.id, m])), sourceConnection: scopedConnection }),
      update: (_id: string, fn: (draft: typeof provider) => void) => fn(provider),
      models: { update },
    };
    for (const fn of providerTransforms) fn(editor);
    providerModels = structuredClone(models);
    for (const fn of modelTransforms) fn({ list: () => models, update });
    return snapshot();
  };
  const registration = () => ({ dispose: vi.fn(async () => {}) });
  const connection = { active: vi.fn(async () => ({ type: "credential", id: "FAKE_CONNECTION" })), resolve: vi.fn(async () => fakeOAuth()) };
  const events: unknown[] = [];
  let wake = () => {};
  const context = {
    app: { version: "2.2.7" },
    location: { directory: join(tmpdir(), "oc-codex-image-test"), project: { directory: join(tmpdir(), "oc-codex-image-test") } },
    integration: {
      connection,
      transform: vi.fn(async () => registration()),
    },
    provider: {
      reload: vi.fn(async () => { render(); }),
      transform: async (fn: (editor: unknown) => void) => {
        providerTransforms.push(fn);
        render();
        return registration();
      },
    },
    model: {
      transform: async (fn: (editor: unknown) => void) => {
        modelTransforms.push(fn);
        render();
        return registration();
      },
    },
    aisdk: { hook: vi.fn(async (name, callback) => { hooks.set(name, callback); return registration(); }) },
    rpc: { register: vi.fn(async () => registration()) },
    tool: { transform: vi.fn(async () => registration()) },
    event: { subscribe: vi.fn(async function* ({ signal }: { signal: AbortSignal }) {
      while (!signal.aborted) {
        if (!events.length) await new Promise<void>(resolve => { wake = resolve; signal.addEventListener("abort", resolve, { once: true }); });
        if (events.length) yield events.shift();
      }
    }) },
  };
  const emit = async (type = "credential.switched") => {
    const count = context.provider.reload.mock.calls.length;
    events.push({ type, location: context.location });
    wake();
    await vi.waitFor(() => expect(context.provider.reload.mock.calls.length).toBeGreaterThan(count));
  };
  return {
    sourceProvider, sourceModels, snapshot, render, hooks, connection, emit,
    scopeInventory: () => { scopedConnection = { type: "credential", id: "FAKE_CONNECTION" }; },
    context: context as unknown as Plugin.Context,
  };
}

const loader = vi.fn(async () => ({ apiKey: "FAKE_LOADER", fetch: vi.fn() }));
const runtime = async () => ({ auth: { loader, methods: [{ type: "oauth" as const, label: "FAKE", authorize: vi.fn() }] } });
const cleanups: Array<() => Promise<void>> = [];
async function start(h: ReturnType<typeof imageHost>) {
  cleanups.push(await setupV2(h.context, runtime));
  return h.snapshot();
}

describe("V2 native image routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAccounts.mockResolvedValue({ activeIndex: 0, accounts: [{ refreshToken: "FAKE_REFRESH", accessToken: "FAKE_ACCESS" }] });
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("does not assign the chat-only package to images at either transform level", async () => {
    const h = imageHost();
    const { models, provider, providerModels } = await start(h);
    expect(models[0]!.package).toMatch(/^aisdk:.*opencode-v2-provider/);
    expect(models[0]!.settings?.transport).toBe("http");
    expect(models[1]!.package).toBe("@opencode/ai/providers/openai/images");
    expect(providerModels[1]!.package).toBe("@opencode/ai/providers/openai/images");
    expect(provider).toEqual(h.sourceProvider);
  });

  it.each(["decision", "speech", "embedding", "video", "future-type"])("leaves %s handlers untouched, including models discovered after setup", async type => {
    const h = imageHost();
    await start(h);
    const model = { ...Model.Info.default(h.sourceProvider.id, Model.ID.make("gpt-6.1-sol-other")), type, package: "FAKE_NATIVE_HANDLER", settings: { preserve: true } };
    h.sourceModels.push(model as Model.Info);
    const { models, providerModels } = h.render();
    expect(models.at(-1)).toEqual(model);
    expect(providerModels.at(-1)).toEqual(model);
  });

  it("does not claim unsupported chat families or custom image protocols", async () => {
    const h = imageHost();
    const other = Model.Info.default(h.sourceProvider.id, Model.ID.make("o3"));
    other.package = "FAKE_CHAT_HANDLER";
    h.sourceModels.push(other);
    h.sourceModels[1]!.package = "FAKE_CUSTOM_IMAGES";
    expect((await start(h)).models.slice(1)).toEqual(h.sourceModels.slice(1));
  });

  it("restores the native image entrypoint when a model inherits the generic provider package", async () => {
    const h = imageHost();
    delete h.sourceModels[1]!.package;
    const { models } = await start(h);
    expect(models[1]!.package).toBe("@opencode/ai/providers/openai/images");
  });

  it.each(["codex-multi-0", "chatgpt-browser", "chatgpt-headless"])("uses the subscription endpoint for %s and preserves account and user headers", async method => {
    const h = imageHost();
    h.connection.resolve.mockResolvedValue(fakeOAuth(method));
    h.sourceModels[1]!.variants = [{ id: "high", settings: { quality: "high", baseURL: "https://api.openai.com/v1" }, headers: { "X-Custom": "keep" } }];
    const image = (await start(h)).models[1]!;
    expect(image.settings).toMatchObject({ baseURL: "https://chatgpt.com/backend-api/codex" });
    expect(image.modelID).toBe("gpt-image-2");
    expect(image.headers).toMatchObject({ "chatgpt-account-id": "FAKE_ACCOUNT", "x-model": "keep", originator: "opencode" });
    expect(image.variants[0]).toMatchObject({ settings: { quality: "high", baseURL: "https://chatgpt.com/backend-api/codex" }, headers: { "x-custom": "keep", "chatgpt-account-id": "FAKE_ACCOUNT" } });
    expect(JSON.stringify(image)).not.toContain("FAKE_REFRESH");
    expect(JSON.stringify(image)).not.toContain(fakeOAuth().access);
  });

  it.each(["key", "chatgpt-token-sharing", "unknown-oauth"])("leaves %s routing native even when a Codex pool exists", async method => {
    const h = imageHost();
    h.connection.resolve.mockResolvedValue(method === "key" ? { type: "key", key: "FAKE_KEY" } : fakeOAuth(method));
    const { models, provider } = await start(h);
    expect(models).toEqual(h.sourceModels);
    expect(provider).toEqual(h.sourceProvider);
    await h.hooks.get("sdk")?.({ model: models[0], options: {} });
    expect(loader).not.toHaveBeenCalled();
  });

  it("keeps an unknown OAuth-owned endpoint, headers and model policy", async () => {
    const h = imageHost();
    h.connection.resolve.mockResolvedValue(fakeOAuth("unknown-oauth"));
    h.sourceModels[1]!.settings = { baseURL: "https://oauth.example.invalid/images" };
    h.sourceModels[1]!.enabled = false;
    expect((await start(h)).models[1]).toEqual(h.sourceModels[1]);
  });

  it("fails closed for native images with only a pooled grant, without changing pool chat selection", async () => {
    const h = imageHost();
    h.connection.active.mockResolvedValue(undefined);
    const { models } = await start(h);
    expect(models[0]!.package).toMatch(/^aisdk:/);
    expect(models[1]!.enabled).toBe(false);
    expect(h.connection.resolve).not.toHaveBeenCalled();
  });

  it("does not fall back to an API environment credential when the selected connection is unresolved", async () => {
    const h = imageHost();
    h.connection.resolve.mockResolvedValue(undefined);
    const { models } = await start(h);
    expect(models[1]!.enabled).toBe(false);
    expect(models[0]!.package ?? "").not.toMatch(/^aisdk:/);
    expect(loader).not.toHaveBeenCalled();
  });

  it("does not infer new GPT Image entitlements from their names", async () => {
    const h = imageHost();
    const next = { ...structuredClone(h.sourceModels[1]!), id: "gpt-image-next", modelID: "gpt-image-next" };
    h.sourceModels.push(next as Model.Info);
    expect((await start(h)).models[2]).toMatchObject({ enabled: false, modelID: "gpt-image-next" });
    h.scopeInventory();
    expect(h.render().models[2]).toMatchObject({ enabled: true, modelID: "gpt-image-next" });
  });

  it("does not load an unsupported native entrypoint on older V2 hosts", async () => {
    const h = imageHost();
    h.context.app.version = "2.0.16";
    const { models } = await start(h);
    expect(models[0]!.package).toMatch(/^aisdk:/);
    expect(models[1]!.enabled).toBe(false);
  });

  it("rebuilds clean state on subscription → key → unrelated OAuth → subscription switches and token refresh", async () => {
    const h = imageHost();
    await start(h);
    h.connection.resolve.mockResolvedValue({ type: "key", key: "FAKE_KEY" });
    await h.emit();
    expect(h.snapshot().models).toEqual(h.sourceModels);
    h.connection.resolve.mockResolvedValue(fakeOAuth("chatgpt-token-sharing"));
    await h.emit();
    expect(h.snapshot().models).toEqual(h.sourceModels);
    h.connection.resolve.mockResolvedValue(fakeOAuth("chatgpt-browser", "FAKE_NEW_ACCOUNT"));
    await h.emit();
    expect(h.snapshot().models[1]!.headers?.["chatgpt-account-id"]).toBe("FAKE_NEW_ACCOUNT");
    h.connection.resolve.mockResolvedValue(fakeOAuth("chatgpt-browser", "FAKE_REFRESHED_ACCOUNT"));
    await h.emit("credential.updated");
    expect(h.snapshot().models[1]!.headers?.["chatgpt-account-id"]).toBe("FAKE_REFRESHED_ACCOUNT");
    expect(h.snapshot().provider).toEqual(h.sourceProvider);
  });

  it("does not reapply stale routing on a full /reload", async () => {
    const first = imageHost();
    await start(first);
    await cleanups.pop()!();
    const second = imageHost();
    second.connection.resolve.mockResolvedValue({ type: "key", key: "FAKE_KEY" });
    expect((await start(second)).models).toEqual(second.sourceModels);
  });

  it("re-evaluates routing when an integration changes without a credential switch event", async () => {
    const h = imageHost();
    await start(h);
    h.connection.resolve.mockResolvedValue(fakeOAuth("unknown-oauth"));
    await h.emit("integration.updated");
    expect(h.snapshot().models).toEqual(h.sourceModels);
  });

  it("never sends images or future model types through the AI SDK chat hooks", async () => {
    const h = imageHost();
    const { models } = await start(h);
    for (const model of [models[1], { ...models[0], type: "future-type" }]) {
      const sdkEvent = { model, options: {}, sdk: { keep: true } };
      const languageEvent = { model, sdk: { responses: vi.fn() }, language: { keep: true } };
      await h.hooks.get("sdk")?.(sdkEvent);
      await h.hooks.get("language")?.(languageEvent);
      expect(sdkEvent.sdk).toEqual({ keep: true });
      expect(languageEvent.language).toEqual({ keep: true });
      expect(languageEvent.sdk.responses).not.toHaveBeenCalled();
    }
    expect(loader).not.toHaveBeenCalled();
  });

  it.each([
    { edit: false, status: 200 }, { edit: true, status: 200 },
    { edit: false, status: 401 }, { edit: true, status: 401 },
    { edit: false, status: 403 }, { edit: true, status: 403 },
  ])("uses the real native protocol (edit=$edit, status=$status) without chat body shaping or paid fallback", async ({ edit, status }) => {
    // Use the native runtime's OWN Effect version, not V1's transitive Effect 3.
    const aiRequire = createRequire(import.meta.resolve("@opencode/ai-image-contract"));
    const { Effect } = await import(aiRequire.resolve("effect"));
    const { HttpClientResponse } = await import(aiRequire.resolve("effect/http"));
    const { model: nativeImage } = await import(import.meta.resolve("@opencode/ai-image-contract/providers/openai/images"));
    const { Media } = await import(import.meta.resolve("@opencode/ai-image-contract"));
    const h = imageHost();
    const image = (await start(h)).models[1]!;
    const model = nativeImage(image.modelID, { ...image.settings, headers: image.headers, apiKey: "FAKE_ACCESS" });
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const executor = vi.fn(request => {
      const body = request.body;
      calls.push({ url: request.url, headers: request.headers, body: new TextDecoder().decode(body.body) });
      const response = status === 200 ? { data: [{ b64_json: "RkFLRQ==" }] } : { error: { message: "FAKE missing scope api.model.images.request" } };
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } })));
    });
    const result = await Effect.runPromiseExit(model.route.generate({
      model, prompt: "FAKE_PROMPT", images: edit ? [Media.base64("RkFLRQ==", "image/png")] : undefined,
    }, executor));
    expect(result._tag).toBe(status === 200 ? "Success" : "Failure");
    expect(executor).toHaveBeenCalledTimes(1);
    expect(calls[0]!.url).toBe(`https://chatgpt.com/backend-api/codex/images/${edit ? "edits" : "generations"}`);
    expect(calls[0]!.headers["authorization"]).toBe("Bearer FAKE_ACCESS");
    expect(calls[0]!.headers["chatgpt-account-id"]).toBe("FAKE_ACCOUNT");
    const body = JSON.parse(calls[0]!.body);
    expect(body).toMatchObject({ model: "gpt-image-2", prompt: "FAKE_PROMPT" });
    for (const key of ["store", "include", "input", "instructions", "reasoning"]) expect(body).not.toHaveProperty(key);
    if (edit) expect(calls[0]!.body).toContain("RkFLRQ==");
    expect(loader).not.toHaveBeenCalled();
  });

  it.each(["generations", "edits"])("does not add chat fields even if an image /%s request reaches the defensive fetch guard", async path => {
    const original = JSON.stringify({ model: "gpt-image-2", prompt: "FAKE_PROMPT", image: "FAKE_IMAGE" });
    const transport = vi.fn(async (request: Request) => {
      expect(await request.text()).toBe(original);
      return new Response("FAKE_RESULT");
    });
    await createV2Fetch(transport, "2.2.7")(`https://chatgpt.com/backend-api/codex/images/${path}`, { method: "POST", body: original });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

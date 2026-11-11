/**
 * VERSION COUPLING — this adapter drives the OpenCode V2 plugin SDK
 * (`@opencode/plugin`) through structurally-typed domains: provider, model,
 * tool and integration transforms, `aisdk` hooks, event subscriptions, and the
 * status RPC. None of that surface is frozen, so this file must be reviewed
 * against every `@opencode/plugin` release. `missingV2SdkSurface` below runs
 * once per process at connect and warn-logs when the connected SDK is missing
 * a member this file calls, so a drifted host surfaces in logs instead of
 * failing silently inside a hook.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Integration, type Credential, type Model, type Plugin } from "@opencode/plugin";
import { z } from "zod";
import type { Hooks } from "@opencode-ai/plugin";
import { loadAccounts } from "./storage.js";
import { coordinatePersistedRefresh } from "./storage/coordinated-refresh.js";
import { logInfo, logWarn } from "./logger.js";
import type { Auth } from "@opencode-ai/sdk";
import { readV2Status } from "./opencode-v2-status.js";
import { CodexStatusRpc } from "./opencode-v2-rpc.js";
import { createStorageScope } from "./storage/state.js";
import { AUTH_LABELS, CODEX_BASE_URL } from "./constants.js";
import { openBrowserUrl } from "./auth/browser.js";
import { extractAccountId, extractAccountUserId } from "./auth/token-utils.js";

const providerModule = new URL("./opencode-v2-provider.js", import.meta.url);
// Local checkouts are loaded from TypeScript; published packages contain JS.
if (!existsSync(providerModule)) providerModule.pathname = providerModule.pathname.replace(/\.js$/, ".ts");
const providerPackage = `aisdk:${providerModule.href}`;
const nativeImagePackage = "@opencode/ai/providers/openai/images";

/** Older supported V2 SDKs have no type field; their inventory is chat-only. */
function modelType(model: object): string {
	const type: unknown = "type" in model ? model.type : undefined;
	return type === undefined ? "chat" : typeof type === "string" ? type : "unknown";
}

/** Only model families handled by the shared Codex chat runtime. Never infer type from output modalities. */
function isCodexChat(model: { modelID: unknown }): boolean {
	return modelType(model) === "chat" && /^(?:gpt-(?:5(?:[.-]|$)|6(?:[.-]|$)|daybreak-)|codex(?:-|$))/.test(String(model.modelID));
}

/** Token-sharing and third-party OAuth have their own contracts; OAuth alone is not a Codex grant. */
function isCodexOAuth(credential: Credential.Value | undefined, methodIDs: ReadonlySet<string>): credential is Credential.OAuth {
	return credential?.type === "oauth" && methodIDs.has(credential.methodID);
}

function supportsNativeImages(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version);
	if (!match) return false;
	const [, major, minor, patch] = match.map(Number);
	return major === 2 && (Number(minor) > 2 || minor === 2 && Number(patch) >= 7);
}

/**
 * Set stateless options before the SDK lowers history into server-side references.
 * `configuredHeaders` are the provider/model headers the SDK was built with; the
 * SDK only applies them at HTTP assembly, so they are passed here to seed the
 * prompt cache key when a call carries no affinity headers of its own.
 */
function createV2Language(
	model: ReturnType<ReturnType<typeof createOpenAI>["responses"]>,
	configuredHeaders?: Record<string, string>,
) {
	type Options = Parameters<typeof model.doGenerate>[0];
	const stateless = (options: Options): Options => {
		const openai: NonNullable<Options["providerOptions"]>[string] = { ...options.providerOptions?.openai, store: false };
		delete openai.previousResponseId;
		delete openai.conversation;
		// OpenCode's AI SDK bridge drops LLMRequest.promptCacheKey and only
		// forwards the session-affinity headers. Without a key the Codex
		// backend gets no prompt_cache_key or session_id/conversation_id,
		// so cache routing is unpinned and continuations miss the cache.
		const cacheKey = typeof openai.promptCacheKey === "string" && openai.promptCacheKey
			? openai.promptCacheKey
			: promptCacheKeyFromHeaders(options.headers) ?? promptCacheKeyFromHeaders(configuredHeaders);
		if (cacheKey) openai.promptCacheKey = cacheKey;
		return { ...options, providerOptions: { ...options.providerOptions, openai } };
	};
	// The SDK only writes `strict` for tools that declare it, and the Codex
	// backend treats an omitted flag as strict mode: every declared schema
	// property becomes required, so the model fills optional args (e.g. the
	// task tool's sessionID) with fabricated values. Pin strict:false unless
	// the tool opted in itself.
	const relaxTools = (options: Options): Options => ({
		...options,
		tools: options.tools?.map((tool) =>
			tool.type === "function" ? { ...tool, strict: tool.strict ?? false } : tool),
	});
	return new Proxy(model, {
		get(target, property, receiver) {
			if (property === "doGenerate") return (options: Options) => target.doGenerate(stateless(relaxTools(options)));
			if (property === "doStream") return (options: Options) => target.doStream(stateless(relaxTools(options)));
			return Reflect.get(target, property, receiver);
		},
	});
}

const SESSION_AFFINITY_HEADERS = ["x-session-affinity", "x-opencode-session", "x-session-id"];
const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/** Mirrors OpenCode's own promptCacheKey derivation from the session affinity id. */
export function promptCacheKeyFromHeaders(headers: Record<string, string | undefined> | undefined): string | undefined {
	if (!headers) return undefined;
	const byName = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	const affinity = SESSION_AFFINITY_HEADERS.map((name) => byName.get(name)?.trim()).find((value) => value);
	if (!affinity) return undefined;
	const key = /^ses_[0-9a-f]{64}$/.test(affinity) ? affinity.slice(4) : affinity;
	if (Array.from(key).length <= PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	// Truncation would merge distinct sessions sharing a long prefix into one
	// cache-affinity group; a SHA-256 hex digest is exactly 64 chars.
	return createHash("sha256").update(key).digest("hex");
}

/** V1 supplied these defaults through provider options; V2's bridge needs them on the wire. */
export function createV2Fetch(fetcher: (input: Request | string | URL, init?: RequestInit) => Promise<Response>, version: string) {
	const userAgent = `opencode/${version}`;
	return async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		// The generated UA rides on every request, not only the rewritten POSTs:
		// upstream identifies OpenCode by it on reads (model lists, usage) too.
		const headers = new Headers(request.headers);
		headers.set("user-agent", userAgent);
		const passthrough = (): Promise<Response> => fetcher(new Request(request, { headers }));
		if (request.method !== "POST" || !request.body || !new URL(request.url).pathname.endsWith("/responses")) return passthrough();
		let body: Record<string, unknown>;
		try {
			// Clone before consuming the stream: when the body is not a JSON
			// object (malformed, scalar, array, or a binary payload), the request
			// still needs to reach the wire untouched rather than throw.
			const parsed: unknown = await request.clone().json();
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return passthrough();
			body = parsed as Record<string, unknown>;
		} catch {
			return passthrough();
		}
		body.store = false;
		body.include = [...new Set([...(Array.isArray(body.include) ? body.include : []), "reasoning.encrypted_content"])];
		return fetcher(request.url, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal });
	};
}

/** The shared V1 runtime factory, passed in by the package entry. */
export type CreateV2Runtime = (options: { directory: string }) => Promise<Hooks>;

/**
 * Every member this file calls on the connected SDK; see VERSION COUPLING.
 * Kept as dotted paths so `missingV2SdkSurface` can check them with unknown
 * narrowing rather than trusting the compile-time types — the host may run an
 * older or newer `@opencode/plugin` than the one this was written against.
 */
const EXPECTED_V2_SDK_FUNCTIONS = [
	"aisdk.hook",
	"event.subscribe",
	"integration.connection.active",
	"integration.connection.resolve",
	"integration.transform",
	"model.transform",
	"provider.reload",
	"provider.transform",
	"rpc.register",
	"tool.transform",
] as const;
const EXPECTED_V2_SDK_OBJECTS = ["app", "integration.connection", "location", "location.project"] as const;

let v2SdkSurfaceWarned = false;

/** Names the connected SDK is missing; empty means the surface this file calls is complete. Exported for coverage of the probe itself. */
export function missingV2SdkSurface(context: Plugin.Context): string[] {
	const member = (path: string): unknown => {
		let value: unknown = context;
		for (const key of path.split(".")) {
			// Callable namespaces are legal: an SDK member can be a function
			// carrying properties (e.g. `event` with `event.subscribe`), and a
			// `typeof === "function"` node must still be walked, not reported
			// missing.
			if (value === null || (typeof value !== "object" && typeof value !== "function")) {
				return undefined;
			}
			value = (value as Record<string, unknown>)[key];
		}
		return value;
	};
	return [
		...EXPECTED_V2_SDK_FUNCTIONS.filter((path) => typeof member(path) !== "function"),
		...EXPECTED_V2_SDK_OBJECTS.filter((path) => {
			const value = member(path);
			return typeof value !== "object" || value === null;
		}),
	];
}

type V1LoaderProvider = Parameters<NonNullable<NonNullable<Hooks["auth"]>["loader"]>>[1];
type V1ModelEntry = V1LoaderProvider["models"][string] & {
	/** V2 keeps request-shaping variants on the base model; V1 folded each variant's option map into the model config entry. */
	variants?: Record<string, Record<string, unknown>>;
};

/** Rebuild the V1 provider model record out of V2's `Model.Info` so the shared loader keeps per-model options and variants. */
function toV1ModelEntry(info: Model.Info): V1ModelEntry {
	const modalities = (list: readonly string[]) => ({
		text: list.includes("text"),
		audio: list.includes("audio"),
		image: list.includes("image"),
		video: list.includes("video"),
		pdf: list.includes("pdf"),
	});
	// The base tier is the cost row without a context threshold; a >200k tier
	// becomes V1's experimentalOver200K entry.
	const baseCost = info.cost.find((entry) => entry.tier === undefined) ?? info.cost[0];
	const overLimitCost = info.cost.find((entry) => entry.tier?.type === "context" && entry.tier.size > 200_000);
	// V1 merged variant options into the model's config map; V2 keeps settings,
	// headers, and body overrides on the variant — fold them back into the
	// option map the request transform consumes.
	const variants: Record<string, Record<string, unknown>> = {};
	for (const variant of info.variants) {
		const options = { ...(variant.settings ?? {}) };
		if (variant.headers) options["headers"] = variant.headers;
		if (variant.body) options["body"] = variant.body;
		variants[variant.id] = options;
	}
	return {
		id: info.id,
		providerID: info.providerID,
		// `Model.Info.package` is either an npm name (`@ai-sdk/openai`) or an
		// `aisdk:` module href like our own provider package — only the npm form
		// is meaningful to V1's `api.npm`, which names the AI SDK package.
		api: {
			id: info.modelID,
			url: "",
			npm: info.package && !info.package.startsWith("aisdk:") ? info.package : "@ai-sdk/openai",
		},
		name: info.name,
		capabilities: {
			// V1's temperature/attachment flags came from models.dev; V2's
			// capability record only reports tools + modalities, so these stay
			// conservative instead of inventing support the record no longer
			// advertises.
			temperature: false,
			reasoning: info.compatibility?.reasoningField !== undefined || info.compatibility?.requireReasoning === true,
			attachment: info.capabilities.input.some((modality) => modality !== "text"),
			toolcall: info.capabilities.tools,
			input: modalities(info.capabilities.input),
			output: modalities(info.capabilities.output),
		},
		cost: {
			input: baseCost?.input ?? 0,
			output: baseCost?.output ?? 0,
			cache: { read: baseCost?.cache.read ?? 0, write: baseCost?.cache.write ?? 0 },
			...(overLimitCost
				? {
						experimentalOver200K: {
							input: overLimitCost.input,
							output: overLimitCost.output,
							cache: overLimitCost.cache,
						},
					}
				: {}),
		},
		limit: { context: info.limit.context, output: info.limit.output },
		status: info.status,
		options: info.settings ?? {},
		headers: info.headers ?? {},
		variants,
	};
}

/**
 * The model-keyed provider record V1 handed its auth loader. V2 only exposes
 * the provider's `Model.Info` inventory plus the model being built, so the map
 * is synthesized from both — keyed by canonical id and bare modelID, since V1
 * config lookups arrive in either form.
 */
function toV1ProviderModels(
	record: ReadonlyMap<string, Model.Info> | undefined,
	current: Model.Info,
): V1LoaderProvider["models"] {
	const infos = record ? [...record.values()] : [];
	if (!infos.some((info) => info.id === current.id)) infos.push(current);
	const models: V1LoaderProvider["models"] = {};
	for (const info of infos) {
		if (!isCodexChat(info)) continue;
		const entry = toV1ModelEntry(info);
		models[info.id] = entry;
		if (info.modelID !== info.id) models[info.modelID] = entry;
	}
	return models;
}

/** Keep account rotation and wire transforms in the shared runtime. */
export function setupV2(context: Plugin.Context, createPluginRuntime: CreateV2Runtime) {
	if (!v2SdkSurfaceWarned) {
		v2SdkSurfaceWarned = true;
		const missing = missingV2SdkSurface(context);
		if (missing.length > 0) {
			logWarn("V2 adapter connected to an SDK missing expected members; keep this file in step with @opencode/plugin releases", {
				missing: missing.join(", "),
			});
		}
	}
	const run = createStorageScope();
	return run(() => setupScopedV2(context, run, createPluginRuntime));
}

/** Register V2 hooks within the location's account-storage scope and release them on unload. */
async function setupScopedV2(
	context: Plugin.Context,
	run: ReturnType<typeof createStorageScope>,
	createPluginRuntime: CreateV2Runtime,
) {
	const runtime = await createPluginRuntime({ directory: context.location.directory });
	const auth = runtime.auth;
	if (!auth?.loader) throw new Error("Codex authentication runtime is unavailable");
	const loader = auth.loader;
	const codexMethods = new Set(["chatgpt-browser", "chatgpt-headless",
		...auth.methods.flatMap((method, index) => method.type === "oauth" ? [`codex-multi-${index}`] : []),
	]);
	// Keep only routing metadata, never copies of access/refresh tokens. Native
	// media calls resolve and refresh the host's selected credential themselves.
	type Routing = { kind: "native" | "codex" | "pool" | "unavailable"; accountID?: string; connectionID?: string };
	const readRouting = async (): Promise<Routing> => {
		const connection = await context.integration.connection.active("openai");
		if (connection) {
			const credential = await context.integration.connection.resolve(connection);
			if (!credential) return { kind: "unavailable" };
			if (!isCodexOAuth(credential, codexMethods)) return { kind: "native" };
			return {
				kind: "codex", connectionID: connection.type === "credential" ? connection.id : undefined,
				accountID: extractAccountId(credential.access) ??
					(typeof credential.metadata?.accountID === "string" ? credential.metadata.accountID : undefined),
			};
		}
		return (await loadAccounts())?.accounts.some((account) => account.enabled !== false && account.refreshToken)
			? { kind: "pool" } : { kind: "native" };
	};
	let routing: Routing = { kind: "native" };
	const enabled = () => routing.kind === "codex" || routing.kind === "pool";
	const controller = new AbortController();
	// Aborting the subscription stops NEW credential events, but an event can
	// already be inside `reload()` when cleanup runs — teardown must not let
	// that handler finish a provider.reload() after disposal began. The guard
	// below blocks the provider call once aborted, and `inFlightReload` lets
	// cleanup await the handler it interrupted rather than racing it.
	let inFlightReload = Promise.resolve();
	const reload = async () => {
		if (controller.signal.aborted) return;
		const current = inFlightReload.catch(() => {}).then(async () => {
			if (controller.signal.aborted) return;
			const next = await readRouting();
			if (controller.signal.aborted) return;
			routing = next;
			await context.provider.reload();
		});
		inFlightReload = current;
		await current;
	};
	// Every SDK registration (transforms, hooks, the status RPC) is released on
	// unload with the event subscription and the runtime teardown.
	const registrations: { dispose: () => Promise<void> }[] = [];
	const track = (registration: { dispose: () => Promise<void> } | undefined): void => {
		if (registration) registrations.push(registration);
	};
	const cleanup = () => run(async () => {
		controller.abort();
		await inFlightReload?.catch(() => {});
		await Promise.all(registrations.map((registration) => registration.dispose().catch(() => {})));
		await runtime.event?.({ event: { type: "server.instance.disposed", properties: { directory: context.location.directory } } });
	});
	try {
		routing = await readRouting();
		logInfo("V2 Codex adapter initialized", { enabled: enabled(), directory: context.location.directory });
		track(await context.rpc.register(CodexStatusRpc, { status: (input) => run(() => readV2Status(input)) }));
		// V2 runs authorization in the service, where the V1 readline menu cannot run.
		// Reuse the append-only loopback flow for the primary add-account method.
		track(await context.integration.transform((editor) => {
			for (const [index, method] of auth.methods.entries()) {
				if (method.type !== "oauth") continue;
				const primary = index === 0;
				const flowMethod = primary
					? auth.methods.find((candidate) => candidate.label === AUTH_LABELS.OAUTH_MANUAL_BROWSER)
					: method;
				if (flowMethod?.type !== "oauth") continue;
				const methodID = Integration.MethodID.make(`codex-multi-${index}`);
				editor.method.update({
					integrationID: "openai",
					method: { id: methodID, type: "oauth", label: primary ? "Codex OAuth (Add account — ChatGPT Plus/Pro)" : method.label },
					authorize: () => run(async () => {
						const flow = await flowMethod.authorize();
						if (primary && flow.url) openBrowserUrl(flow.url);
						const instructions = flow.url
							? `${flow.instructions}\nAdds to this project's Codex account pool. Use a private browser window or switch accounts to add a different login. Repeat opencode auth login for another account; view the pool with /codex-accounts.`
							: flow.instructions;
						const credential = (code?: string): Promise<Credential.OAuth> => run(async () => {
							const result = flow.method === "code" ? await flow.callback(code ?? "") : await flow.callback();
							if (result.type !== "success" || !("access" in result)) throw new Error("Codex sign-in failed; retry authentication");
							await reload();
							return { type: "oauth" as const, methodID, access: result.access, refresh: result.refresh, expires: result.expires };
						});
						return flow.method === "code"
							? { url: flow.url, instructions, mode: "code" as const, callback: credential }
							: { url: flow.url, instructions, mode: "auto" as const, callback: credential() };
					}),
					refresh: (credential) => run(async () => {
						const pool = await loadAccounts();
						const exactMatches = pool?.accounts.filter((account) => account.refreshToken === credential.refresh) ?? [];
						const accountId = extractAccountId(credential.access);
						const accountUserId = extractAccountUserId(credential.access);
						const matches = pool?.accounts.filter((account) =>
							(accountId || accountUserId) &&
							(!accountId || account.accountId === accountId) &&
							(!accountUserId || account.accountUserId === accountUserId),
						) ?? [];
						// One OAuth grant can back several seats. The access-token seat wins
						// over a shared refresh token; never guess if both are ambiguous.
						const account = matches.length === 1 ? matches[0] : exactMatches.length === 1 ? exactMatches[0] : undefined;
						if (!account && exactMatches.length > 1) throw new Error("Codex refresh account is ambiguous; reconnect the account");
						const result = await coordinatePersistedRefresh({
							refreshToken: credential.refresh,
							...(account ? { organizationId: account.organizationId, accountId: account.accountId, accountUserId: account.accountUserId } : {}),
						});
						if (result.type !== "success") throw new Error("Codex token refresh failed");
						return { ...credential, access: result.access, refresh: result.refresh, expires: result.expires };
					}),
				});
			}
		}));

		const resolveAuth = async (): Promise<Auth> => {
			// An explicitly selected API key or unrelated OAuth connection takes
			// precedence over the pool, even between a switch and its reload event.
			const connection = await context.integration.connection.active("openai");
			const credential = connection ? await context.integration.connection.resolve(connection) : undefined;
			if (connection && !isCodexOAuth(credential, codexMethods)) {
				throw new Error("OpenAI connection changed; reload before using the Codex chat adapter");
			}
			const pool = await loadAccounts();
			const accounts = pool?.accounts ?? [];
			// Disabled accounts never serve requests — prefer the active seat
			// when enabled, else the first enabled account; the host's own
			// `openai` connection is the documented outside-pool fallback.
			const active = pool ? accounts[pool.activeIndex] : undefined;
			const account =
				active && active.enabled !== false
					? active
					: accounts.find((candidate) => candidate.enabled !== false);
			if (account?.refreshToken) {
				return { type: "oauth", access: account.accessToken ?? "", refresh: account.refreshToken, expires: account.expiresAt ?? 0 };
			}
			if (isCodexOAuth(credential, codexMethods)) return credential;
			if (accounts.length > 0 && accounts.every((entry) => entry.enabled === false)) {
				throw new Error("All pooled Codex accounts are disabled — re-enable one with the codex-enable tool or connect a new login with /connect");
			}
			throw new Error("Connect a Codex multi-account OAuth method with /connect first");
		};

		// Headers each SDK instance was built with, so the language hook can derive
		// the prompt cache key from provider-configured session affinity headers.
		const sdkHeaders = new WeakMap<object, Record<string, string>>();
		// The provider record's model inventory feeds the V1 loader's per-model
		// config map; captured on each transform so the latest snapshot wins.
		let providerModels: ReadonlyMap<string, Model.Info> | undefined;
		let connectionImageModels = new Set<string>();
		track(await context.provider.transform((editor) => {
			// The record exists even while disabled; the sdk hook needs it either
			// way, so capture unconditionally and gate only the mutations.
			const record = editor.get("openai");
			providerModels = record?.models;
			const source = record?.sourceConnection;
			connectionImageModels = new Set(source?.type === "credential" && source.id === routing.connectionID
				? [...providerModels?.values() ?? []].filter((model) => modelType(model) === "image" && model.enabled).map((model) => model.modelID)
				: []);
			if (!enabled()) return;
			// Provider defaults must remain native: current AND newly discovered
			// image/decision/audio/future types must not inherit a chat-only SDK.
			if (routing.kind === "pool") editor.update("openai", (provider) => { provider.activation = "enabled"; });
			for (const model of providerModels?.values() ?? []) {
				if (!isCodexChat(model)) continue;
				editor.models.update("openai", model.id, (draft) => { draft.package = providerPackage; });
			}
		}));
		track(await context.aisdk.hook("sdk", (event) => run(async () => {
			if (!enabled() || !isCodexChat(event.model)) return;
			const options = await loader(resolveAuth, {
				id: "openai",
				name: "OpenAI",
				source: "custom",
				env: [],
				models: toV1ProviderModels(providerModels, event.model),
				// V1's provider.options was the provider-level config object; the
				// hook event's `options` is the same role on this side — the
				// options the host resolved for this provider's SDK construction.
				options: event.options,
			});
			const fetcher = options.fetch;
			if (typeof fetcher !== "function") throw new Error("Codex request transport could not be initialized");
			// Forward every OpenAIProviderSettings field the host resolved in
			// `options` (headers, organization, project, name), layered under the
			// model's own headers — model-specific headers win.
			const optionString = (key: string): string | undefined => {
				const value = event.options[key];
				return typeof value === "string" && value.length > 0 ? value : undefined;
			};
			const headers: Record<string, string> = {};
			const optionHeaders: unknown = event.options["headers"];
			if (typeof optionHeaders === "object" && optionHeaders !== null && !Array.isArray(optionHeaders)) {
				for (const [key, value] of Object.entries(optionHeaders)) {
					if (typeof value === "string") headers[key] = value;
				}
			}
			Object.assign(headers, event.model.headers);
			const organization = optionString("organization");
			const project = optionString("project");
			const name = optionString("name");
			const sdk = createOpenAI({
				apiKey: typeof options.apiKey === "string" ? options.apiKey : "codex-oauth",
				baseURL: typeof options.baseURL === "string" ? options.baseURL : undefined,
				...(organization ? { organization } : {}),
				...(project ? { project } : {}),
				...(name ? { name } : {}),
				...(Object.keys(headers).length > 0 ? { headers } : {}),
				fetch: createV2Fetch((input, init) => run(() => fetcher(input, init)), context.app.version),
			});
			sdkHeaders.set(sdk, headers);
			event.sdk = sdk;
		}), { providerID: "openai" }));
		track(await context.model.transform((editor) => {
			for (const model of editor.list("openai")) {
				if (modelType(model) === "image") {
					// Custom image protocols remain owned by their provider/plugin.
					if (model.package && model.package !== "@opencode/ai/providers/openai" && model.package !== nativeImagePackage) continue;
					editor.update("openai", String(model.id), (draft) => {
						if (supportsNativeImages(context.app.version)) draft.package = nativeImagePackage;
						// API keys and other OAuth methods retain their own endpoint,
						// headers, enablement and host credential/refresh contract.
						if (routing.kind === "native") return;
						// Native media uses the HOST connection, not the rotating chat
						// pool. Without a host Codex grant, fail closed; never use an
						// env/API-key fallback to pay for a subscription request.
						if (routing.kind !== "codex" || !supportsNativeImages(context.app.version)) {
							draft.enabled = false;
							return;
						}
						draft.package = nativeImagePackage;
						draft.settings = { ...draft.settings, baseURL: `${CODEX_BASE_URL}/codex` };
						// GPT Image 2 is the built-in Codex image entitlement in 2.2.7.
						// Additional models need an authoritative account-scoped inventory.
						if (String(model.modelID) !== "gpt-image-2" && !connectionImageModels.has(String(model.modelID))) draft.enabled = false;
						const subscriptionHeaders = (given: Record<string, string> | undefined) => {
							const headers = new Headers(given);
							headers.set("originator", "opencode");
							headers.set("user-agent", `opencode/${context.app.version}`);
							if (routing.accountID) headers.set("chatgpt-account-id", routing.accountID);
							return Object.fromEntries(headers.entries());
						};
						draft.headers = subscriptionHeaders(draft.headers);
						// Variant settings are merged AFTER model transforms. Pin them
						// too so a legacy API endpoint cannot silently change billing.
						for (const variant of draft.variants) {
							variant.settings = { ...variant.settings, baseURL: `${CODEX_BASE_URL}/codex` };
							variant.headers = subscriptionHeaders(variant.headers);
						}
					});
					continue;
				}
				if (!enabled() || !isCodexChat(model)) continue;
				editor.update("openai", String(model.id), (draft) => {
					draft.package = providerPackage;
					draft.settings = { ...draft.settings, transport: "http" };
				});
			}
		}));
		track(await context.aisdk.hook("language", (event) => {
			if (!enabled() || !isCodexChat(event.model)) return;
			const sdk = event.sdk as ReturnType<typeof createOpenAI>;
			event.language = createV2Language(sdk.responses(event.model.modelID), sdkHeaders.get(sdk));
		}, { providerID: "openai" }));

		track(await context.tool.transform((editor) => {
			for (const [name, definition] of Object.entries(runtime.tool ?? {})) {
				const schema = z.object(definition.args);
				editor.add({
					name,
					description: definition.description,
					input: z.toJSONSchema(schema),
					execute: (input, call) => run(async () => {
						const result = await definition.execute(schema.parse(input ?? {}), {
							sessionID: call.sessionID, messageID: call.messageID, agent: call.agent,
							directory: context.location.directory, worktree: context.location.project.directory,
							abort: call.signal,
					metadata: (update) => { void call.progress(update).catch(() => {}); },
							ask: () => { throw new Error("Legacy tool permission requests are not supported by the V2 adapter"); },
						});
						// V1 forwarded the legacy tool result verbatim; V2's Result
						// splits content and metadata into separate fields.
						if (typeof result === "string") return { content: result };
						return { content: result.output, metadata: result.metadata };
					}),
				});
			}
		}));
		void (async () => {
			try {
				for await (const event of context.event.subscribe({ signal: controller.signal })) {
					if (event.location && event.location.directory !== context.location.directory) continue;
					if (event.type === "credential.updated" || event.type === "credential.switched" || event.type === "integration.updated") await reload();
				}
			} catch (error) {
				if (!controller.signal.aborted) logWarn("V2 event subscription ended", { error: String(error) });
			}
		})();
		return cleanup;
	} catch (error) {
		await cleanup();
		throw error;
	}
}

# lib/tools/

Per-tool modules for the 25 `codex-*` tools registered by the plugin.
`index.ts` builds a `ToolContext` in `OpenAIOAuthPlugin` (root `index.ts`) and
passes it to `createToolRegistry(ctx)`, which maps each `codex-<name>` tool id to
its factory.

## Layout

```text
index.ts            # ToolContext type + createToolRegistry(ctx); also re-exports the codex-diag/codex-diff/codex-keychain factories
args.ts             # shared format/includeSensitive constants (values + descriptions)
output.ts           # shared tool-output contract: error envelope, sanitizers, withToolErrorEnvelope wrapper
doctor-repair.ts    # shared doctor repair pass (refresh + stale-state clear); used by codex-doctor and CLI --fix
refresh-account.ts  # shared single-use refresh-token persistence; used by account-management tools
codex-<name>.ts     # one file per tool: list, switch, warm, status, limits, reset, metrics, help, setup,
                    # doctor, next, label, tag, pool, note, dashboard, health, enable, remove, refresh,
                    # export, import, diag, diff — plus codex-keychain.ts
```

## Factory pattern

Each tool file exports `createCodex<Name>Tool(ctx: ToolContext): ToolDefinition`
built with `tool({ description, args, execute })` from
`@opencode-ai/plugin/tool`. `ToolContext` (declared in `index.ts`) carries three
groups:

- **Mutable plugin-closure refs** (`cachedAccountManagerRef`,
  `accountManagerPromiseRef`) — `MutableRef<T>` wrappers (`{ current }`) over
  `let` bindings in the plugin closure, so writes propagate outward.
- **Read-only handles** (`runtimeMetrics`, `beginnerSafeModeRef`).
- **Closure helpers** (`resolveUiRuntime`, `formatCommandAccountLabel`,
  `promptAccountIndexSelection`, `buildRoutingVisibilitySnapshot`, …).

No module-level mutable singletons — all shared state arrives through `ctx`.

## args.ts: constants only across the module boundary

`args.ts` owns `TOOL_OUTPUT_FORMAT_VALUES` (`"text" | "json"`),
`TOOL_OUTPUT_FORMAT_DESCRIPTION`, and `TOOL_INCLUDE_SENSITIVE_DESCRIPTION`.
Only plain constants may cross the boundary: a shared schema *factory*'s
inferred Zod return type is not nameable from this package without leaking the
plugin's bundled `zod` copy (TS2742), so each tool inlines its own
`tool.schema` calls. `format` fields use
`tool.schema.enum(TOOL_OUTPUT_FORMAT_VALUES).optional()` — never `.string()` —
so the emitted JSON Schema constrains the value. `codex-pool` scopes its
`includeSensitive` wording to account IDs and passes its own string.

## output.ts: the shared tool-output contract

Every tool factory builds its `tool({...})` definition, then returns it wrapped
in `withToolErrorEnvelope("codex-<name>", definition)` — `codex-keychain.ts` is
the one exception (its contract is owned by the storage-layer lease work).

The tool API has no `isError` flag, so failures have exactly two honest shapes:

- `format:"json"` calls (or `alwaysJson` tools — `codex-diag`, `codex-diff`)
  resolve to the stable envelope `{ ok:false, tool, error, message, retryable,
  nextAction, path }`: `error` is the `CodexError.code` (else
  `CODEX_TOOL_ERROR`), `message` is masked + newline-collapsed + truncated,
  `nextAction` carries `StorageError.hint`, `path` is home-redacted.
- Text calls reject with an enriched error — the wrapper preserves synchronous
  throws for pre-await arg validation, so `expect(fn).toThrow` keeps working.

Other shared helpers in `output.ts`:

- `sanitizeToolErrorMessage` — maskString + newline collapse + 160-char cap;
  use on any upstream error text before it reaches tool output.
- `stripControlCharacters` — drops C0/C1/DEL control chars (keeps \t \n); run
  it on user text (`label`/`tags`/`note`) before storing or echoing.
- `redactHomePaths` — `<HOME>` for the real homedir AND generic
  `/home/<name>`, `/Users/<name>`, `X:\Users\<name>` prefixes.
- `redactPluginOrigin` — the above applied to `PluginOrigin.root`.
- `rethrowIfRetryable` — call it inside a `persist()` catch before mapping the
  failure to an outcome: lease compromise (`StorageTransactionContentionError`,
  `ConfigLockContentionError`) surfaces through `persist()`, and folding it
  into a "failed to persist" string would hide the retryable signal.
- `toToolCallError("Import failed", err)` — the honest-failure throw for
  text-only tools that previously returned `"X failed: ..."` strings.

JSON output conventions:

- User-facing account indexes are **1-based** (`index`, `activeIndex`, pool
  `accounts[].index` inputs). A technical 0-based field is allowed only under
  an explicit name like `zeroBasedIndex` (see `codex-warm.results[]`).
- Emit stable keys: populate every schema field with `null`/`[]` rather than
  omitting it (`codex-reset`'s `emptyConsumeJsonPayload` is the template), and
  keep filtered counts separate from pool totals (`totalAccounts` = full pool,
  `shownAccounts` = filtered rows).

## Agent-facing descriptions

A tool description is read by the model, not just for discovery: it is the only
place that tells the caller how to *present* the result. When a tool's text
output is already the complete report, the description must say so explicitly and
name every column it renders, otherwise the caller re-summarizes it and silently
drops the fields the user asked for (the `codex-limits` case: 5-hour limits and
banked reset credits vanished from a summary that kept only the weekly column).

Convention: a tool whose output is user-facing state spells out

- the shape to render (one row per account, closing pool/aggregate total),
- every column it emits, by name, and
- the follow-up tool that acts on the numbers (e.g. `codex-limits` → `codex-reset`
  for banked credits).

Include dynamic fields under their rendered names. Preserve errors and
unavailable-data messages; only require fields and aggregate totals actually
emitted by the tool. Missing readings must not be invented or reported as zero.

Prefer guidance on the description over emitting both text and a second
machine-shaped variant; `format:"json"` already covers machine consumers.

## Adding a tool

1. Create `lib/tools/codex-<name>.ts` exporting `createCodex<Name>Tool(ctx)`,
   and return the definition wrapped in `withToolErrorEnvelope` (see
   output.ts above).
2. Import it in `lib/tools/index.ts` and add the
   `"codex-<name>": createCodex<Name>Tool(ctx)` entry in `createToolRegistry` —
   the registry is checked against the file list by `test/doc-parity.test.ts`.
3. If the tool needs a new closure helper, add a `ToolContext` field and wire it
   in the `ctx` builder in root `index.ts` (search `const ctx: ToolContext = {`).
4. Add coverage as `test/tools-codex-<name>.test.ts` (see test/AGENTS.md).

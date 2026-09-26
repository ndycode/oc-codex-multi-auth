# Architecture

Runtime architecture for the `oc-codex-multi-auth` OpenCode plugin, installer, ChatGPT Plus/Pro OAuth flow, Codex/GPT-5 request bridge (including GPT-6 Astra/Sol/Luna and GPT-5.6 responses-lite), multi-account rotation, `codex-*` tool registry, TUI quota status plugin, and local storage model.

> Reflects the codebase as of the current `main` branch. This file is the maintainer architecture source of truth; `docs/architecture.md` is the shorter public-facing overview.

---

## Design Goals

1. Make OpenCode ChatGPT OAuth setup short and repeatable (`npx -y oc-codex-multi-auth@latest`).
2. Keep OpenCode as the host runtime while the plugin owns only the OAuth-backed Codex routing layer.
3. Preserve Codex backend invariants: `stream: true`, `store: false`, and `reasoning.encrypted_content`.
4. Make multi-account state visible through account switching, health checks, diagnostics, quota status, and recovery commands.
5. Keep account storage local by default, with explicit export/import and optional OS keychain migration.
6. Keep the broad OpenCode tool surface modular, where every registered `codex-*` tool is its own file under `lib/tools/`.
7. Keep public docs search-friendly without overstating support, affiliation, or production/commercial use.

---

## System Diagram

```text
Install / refresh / standalone CLI
  |
  | npx -y oc-codex-multi-auth@latest
  |   install: default plugin-only | --modern | --full | --legacy
  |           [--dry-run] [--no-cache-clear]
  |   update: managed package cache only
  |           [--dry-run]
  | standalone: doctor | status | list | limits | dashboard | health | diag | warm
  v
scripts/install-oc-codex-multi-auth.js
  |- delegates to scripts/install-oc-codex-multi-auth-core.js
  |- install writes changed ~/.config/opencode/opencode.json and tui.json
  |- update never reads or writes OpenCode config
  |- merges config/opencode-modern.json and/or config/opencode-legacy.json
  |- normalizes old package/plugin entries
  |- clears OpenCode plugin cache (unless --no-cache-clear)

OpenCode runtime
  |
  | loads plugin package
  v
index.ts
  |- auth loader: default-browser callback, open-URL-manually callback, device code, manual URL paste
  |- account manager + V3 storage + optional keychain
  |- custom provider fetch pipeline
   |- runtime metrics, retry budgets, circuit breaker, recoverable-error toasts
  |- ToolContext construction
  v
lib/tools/index.ts
  |- registers 24 OpenCode tools
  |- each tool delegates to lib/tools/codex-*.ts

Request path
  |
  | OpenCode OpenAI SDK request
  v
lib/request/fetch-helpers.ts + lib/request/request-transformer.ts
  |- rewrite URL to Codex/ChatGPT backend
  |- native mode: preserve host payload shape
  |- legacy mode: apply compatibility rewrites
  |- legacy mode: force store:false, stream:true, and reasoning.encrypted_content
  |- GPT-6 Astra/Sol/Luna / Daybreak / GPT-5.6: responses-lite reshape + opencode client identity
  |- other models: codex_cli_rs client identity (default)
  |- resolve modelAccountPools preferred accounts
  |- select/refresh account (hybrid health scoring)
  |- attach OAuth headers
  |- rate-limit and quota header extraction
  v
ChatGPT-backed Codex endpoint
  |
  v
lib/request/response-handler.ts
  |- SSE parsing
  |- streaming pass-through
  |- stream stall guards
  |- empty-response detection (the retry loop lives in index.ts)

OpenCode TUI runtime
  |
  v
tui.ts
  |- reads account/quota snapshots
  |- refreshes compact usage state when possible
  |- renders prompt quota status and details
```

---

## Core Subsystems

| Subsystem | Key files | Responsibility |
| --- | --- | --- |
| Installer CLI | `scripts/install-oc-codex-multi-auth.js`, `scripts/install-oc-codex-multi-auth-core.js` | npm bin; config merge; cache cleanup; modern/full/legacy catalog selection; standalone doctor/status/list/limits/dashboard/health/diag/warm; TUI plugin enablement |
| OpenCode plugin entry | `index.ts` | auth loader, runtime wiring, custom fetch pipeline, account manager lifecycle, `ToolContext`, OpenCode plugin export |
| TUI plugin entry | `tui.ts`, `lib/tui-status.ts`, `lib/tui-quota-cache.ts`, `lib/codex-usage.ts` | prompt quota status, account-aware quota snapshots, usage refresh, details rendering |
| Quota percentage wording | `lib/quota-display.ts` | `quotaDisplay` free/used rendering shared by the TUI, `codex-limits`, the standalone CLI, and notifications; a leaf module so the status line and the usage surfaces can both depend on it |
| Pool-wide status line | `lib/quota-overview.ts`, `lib/tui-quota-overview.ts` | `quotaStatus.mode` `overview` / `resets`; the first is a pure formatter (weighted total, ordering, layouts, degradation ladder, reset-credit line), the second gathers and caches every account's usage and merges the request path's live reading of the serving account |
| Status slot layout | `tui.ts` (`measureStatusSlot`, `resolveStatusRows`), `lib/tui-status.ts` (`wrapStatusCandidate`, `fitStatusLines`) | measures the columns and rows the prompt actually left this slot, and lays a candidate ladder out across them |
| Plan allotments | `lib/plan-allotment.ts` | `plan_type` to weight/multiplier/price; another leaf, so the render path weights the pool total without pulling in JWT decoding |
| Auth flow | `lib/auth/auth.ts`, `lib/auth/loopback-flow.ts`, `lib/auth/server.ts`, `lib/auth/browser.ts`, `lib/auth/device-code.ts`, `lib/auth/login-runner.ts`, `lib/auth/scopes.ts` | PKCE OAuth, callback server, default-browser and open-URL-manually listener flows, device code, manual URL paste, workspace/account selection, scope validation |
| Account manager | `lib/accounts.ts`, `lib/accounts/` | account state facade, persistence, rotation, recovery, rate-limit tracking, workspace identity preservation, warm |
| Storage | `lib/storage.ts`, `lib/storage/` | V3 JSON storage, atomic writes, migrations, per-project paths, backups, import/export, keychain opt-in, flagged accounts |
| Request bridge | `lib/request/fetch-helpers.ts`, `lib/request/request-transformer.ts`, `lib/request/response-handler.ts`, `lib/request/retry-budget.ts`, `lib/request/rate-limit-backoff.ts`, `lib/request/helpers/` | URL/body/header shaping, Codex invariants, responses-lite, client identity, SSE conversion, retry budgets, backoff, error mapping |
| Model/prompt mapping | `lib/prompts/codex.ts`, `lib/prompts/opencode-codex.ts`, `lib/prompts/codex-opencode-bridge.ts`, `lib/request/helpers/model-map.ts` | model-family detection, Codex instructions cache, OpenCode prompt adaptation, fallback aliases |
| Tool registry | `lib/tools/index.ts`, `lib/tools/codex-*.ts` | 24 OpenCode tools for setup, account switching, status, health, quota resets, diagnostics, backup, keychain, and recovery |
| Runtime support | `lib/runtime.ts`, `lib/circuit-breaker.ts`, `lib/proactive-refresh.ts`, `lib/parallel-probe.ts`, `lib/recovery/`, `lib/rotation.ts`, `lib/shutdown.ts` | pure runtime helpers, failure isolation, refresh scheduling, health probing, hybrid selection scoring, session recovery, cleanup |
| UI helpers | `lib/ui/` | terminal formatting, auth menu, select/confirm prompts, theme/color handling, beginner checklist |
| Config templates | `config/opencode-modern.json`, `config/opencode-legacy.json`, `config/minimal-opencode.json`, `config/README.md` | copy-paste OpenCode provider templates and model catalog guidance |
| Tests | `test/` | Vitest suites for auth, request transforms, storage, rotation, tools, TUI quota, installer, docs parity, and release regressions |

---

## Documentation Layout

The current docs tree mirrors the codebase boundaries above. User docs cover setup and operations, and maintainer docs cover internal architecture and validation.

```text
docs/
├── index.md                  # docs landing page
├── README.md                 # docs portal navigation
├── DOCUMENTATION.md          # repository documentation map
├── architecture.md           # public architecture overview
├── getting-started.md        # install, auth, and first-run guide
├── tools-and-cli.md          # codex-* tool catalog and standalone CLI
├── configuration.md          # public config reference
├── troubleshooting.md        # operational failure modes and fixes
├── faq.md                    # short common answers
├── privacy.md                # local data and upstream request notes
├── OPENCODE_PR_PROPOSAL.md   # upstream OpenCode proposal notes
├── _config.yml               # docs site config
└── development/              # maintainer architecture and validation docs
    ├── ARCHITECTURE.md
    ├── GITHUB_DISCOVERABILITY.md
    ├── CONFIG_FIELDS.md
    ├── CONFIG_FLOW.md
    ├── TESTING.md
    └── TUI_PARITY_CHECKLIST.md
```

---

## Request Pipeline

High-level provider fetch flow:

1. Parse OpenCode request URL and body.
2. Resolve plugin config from defaults, `~/.opencode/openai-codex-auth-config.json`, and environment overrides (boolean env truthy only for `"1"`).
3. Choose request transform mode:
   - `native` keeps the host payload shape. It normalizes the model name, sets the backend instruction identity line, and upserts one `## Backend Model Identity` developer message naming the outgoing model, refreshed again when fallback changes the model.
   - `legacy` fetches Codex/OpenCode prompts and applies compatibility rewrites.
4. Enforce ChatGPT-backed Codex invariants:
   - `stream: true`
   - `store: false`
   - `include: ["reasoning.encrypted_content"]` or equivalent inclusion

   Legacy transformation mode (`transformRequestBody`) sets all three unconditionally. Native mode leaves them to the shipped config templates (`store: false`, `reasoning.encrypted_content`) and the host payload (`stream`).
5. Normalize model aliases and fallback candidates (including GPT-6 Astra/Sol/Luna, the Daybreak cyber tiers, and the GPT-5.6 Sol/Terra/Luna tiers).
6. For responses-lite models (GPT-6 Astra/Sol/Luna, Daybreak, GPT-5.6), apply the responses-lite reshape (`lib/request/helpers/responses-lite.ts`): tools move into `input` as `additional_tools`, instructions become a developer message, top-level `tools`/`instructions` are cleared for lite shape, image `detail` is stripped, and `x-openai-internal-codex-responses-lite: true` is set.
7. Resolve client identity with `lib/request/helpers/client-identity.ts`. Responses-lite models default to `originator: opencode`, other models to `codex_cli_rs`. Override with `CODEX_AUTH_CLIENT_IDENTITY`.
8. Resolve accounts and `preferred`/`strict` policy from `modelAccountPools` and `modelAccountPoolModes`; only preferred pools fall back to the general pool when unavailable.
9. Resolve account/workspace selection with the configured `rotationStrategy` (default `hybrid` health scoring), cooldown, token bucket, and explicit `CODEX_AUTH_ACCOUNT_ID` constraints.
10. Refresh tokens through the queued refresh path when needed.
11. Attach OAuth/Codex headers and forward the request.
12. Parse the response. `lib/request/response-handler.ts` owns SSE parsing, stream stall guards, and empty-response detection. `lib/request/fetch-helpers.ts` owns rate-limit and quota header extraction, error mapping, and fallback.
13. Update runtime metrics, account health, circuit breaker state, TUI quota cache, and persisted storage. Retries draw from the per-request budget tracker in `lib/request/retry-budget.ts`.
14. On recoverable failures, classify the error and show a recovery toast in the current plugin runtime. The message/part rewriting and auto-resume engine in `lib/recovery/hook.ts` is not invoked by host event streams or request handlers.

---

## Stateless Codex Contract

The ChatGPT-backed Codex path rejects server-side storage for this plugin's request shape, so the runtime keeps requests stateless with `store: false`.

Context is preserved through:

- full message history supplied by OpenCode
- tool call and tool output history in that message history
- `reasoning.encrypted_content` returned by the backend and sent back on later turns

Legacy mode exists for compatibility with older OpenCode/AI SDK payload behavior. It removes unsupported `item_reference` items and message IDs that cannot be looked up when `store: false` is active. Native mode is the default and preserves the host payload shape as much as possible.

The two modes source the invariants differently. Legacy transformation sets `store: false`, `stream: true`, and `reasoning.encrypted_content` inclusion unconditionally inside `transformRequestBody`. Native mode does not rewrite the body for them. It relies on the installer templates, which ship `store: false` and `reasoning.encrypted_content` on every model entry, and on the host payload, which already carries `stream`.

Native mode still marks the backend model. It sets the instruction identity line and upserts one `## Backend Model Identity` developer message naming the outgoing model, so a selector label never hides the real model ID from the backend.

Responses-lite is a separate body shape layered on top of the same stateless contract. Tool definitions live in the input prefix rather than the top-level `tools` field.

---

## Tool Registry Architecture

The plugin exposes 24 OpenCode tools through `lib/tools/index.ts`. `index.ts` builds one `ToolContext` from plugin-closure state and helper functions, then passes it to `createToolRegistry(ctx)`.

Why this shape exists:

- per-tool modules keep `index.ts` from absorbing every command implementation
- mutable refs let tools invalidate or replace account-manager state without global singletons
- shared helpers keep formatting, routing visibility, and beginner diagnostics consistent
- schema helpers stay close to each tool to avoid leaking bundled `zod` type identities across module boundaries

Tool groups:

| Group | Tools |
| --- | --- |
| Setup and help | `codex-setup`, `codex-help`, `codex-next` |
| Daily account use | `codex-list`, `codex-switch`, `codex-warm`, `codex-status`, `codex-limits`, `codex-reset`, `codex-dashboard` |
| Account metadata and routing | `codex-label`, `codex-tag`, `codex-note`, `codex-pool`, `codex-remove`, `codex-refresh` |
| Diagnostics | `codex-health`, `codex-metrics`, `codex-doctor`, `codex-diag`, `codex-diff` |
| Backup/secrets | `codex-export`, `codex-import`, `codex-keychain` |

Standalone CLI mirrors a subset without loading the agent: `doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm`.

---

## Storage Model

Canonical OpenCode plugin state lives under `~/.opencode`, while OpenCode config lives under `~/.config/opencode`.

| File | Purpose |
| --- | --- |
| `~/.config/opencode/opencode.json` | OpenCode provider/plugin config managed by installer |
| `~/.config/opencode/tui.json` | OpenCode TUI plugin config managed by installer |
| `~/.opencode/auth/openai.json` | OpenCode auth token file (convention reference in docs; no plugin code reads this path) |
| `~/.local/share/opencode/auth.json` | OpenCode host auth store, read and backfilled from the account pool by `backfillHostOpenAIAuthFromPool` |
| `~/.opencode/openai-codex-auth-config.json` | plugin runtime config |
| `~/.opencode/oc-codex-multi-auth-accounts.json` | global V3 account pool |
| `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` | project-scoped V3 account pool |
| `~/.opencode/projects/<project-key>/oc-codex-multi-auth-flagged-accounts.json` | flagged/deactivated account metadata, project-scoped when `perProjectAccounts` is on (default) |
| `~/.opencode/oc-codex-multi-auth-flagged-accounts.json` | flagged/deactivated account metadata, global when `perProjectAccounts` is off |
| `~/.opencode/backups/` | account backup/export target |
| `~/.opencode/logs/codex-plugin/` | request/debug logs when enabled |

Storage invariants:

1. V1 account files migrate into V3 on load/save paths. V2 is rejected with the typed `UNKNOWN_V2_FORMAT` recovery error instead of a silent discard. Versions above 3 are rejected with `UNSUPPORTED_SCHEMA_VERSION`.
2. Per-project storage is enabled by default and keyed by detected project identity.
3. JSON files are written atomically where supported.
4. Optional keychain storage is opt-in via `CODEX_KEYCHAIN=1`.
5. Import supports dry-run preview and creates pre-import backups when existing accounts are present.

---

## Shutdown and Keychain Details

`lib/shutdown.ts` registers one cleanup pass per process on SIGINT, SIGTERM, and beforeExit. As a host plugin the process is not the package's to terminate, so the handlers drain cleanup and return, leaving exit ownership with OpenCode. The standalone CLI entrypoints call `setShutdownOwnsProcess(true)` and exit 130 on SIGINT and 143 on SIGTERM (`128 + signal number`).

Keychain entries live under the OS keychain service name `oc-codex-multi-auth`. The global pool uses the account key `accounts:global`, and a project pool uses `accounts:<project-storage-key>`. Migrating a JSON pool into the keychain renames the original file to `<file>.migrated-to-keychain.<timestamp>` and keeps it at mode 0600 as the rollback artifact. That file is the user's recovery path if keychain lookups fail or `CODEX_KEYCHAIN` is later unset.

---

## Session Recovery Storage

When `sessionRecovery` is true (default), the request path classifies errors with `detectErrorType` and `isRecoverableError` and shows a recovery toast. The full repair engine in `lib/recovery/hook.ts` (`handleSessionRecovery`, message/part rewriting through `lib/recovery/storage.ts`, and optional auto-resume) is not wired into host event streams or request handlers, so it does not run in the current plugin runtime. The storage paths below describe what that engine reads and writes when wired.

| Path | Purpose |
|------|---------|
| `$XDG_DATA_HOME/opencode/storage` (or `%APPDATA%/opencode/storage` on Windows; else `~/.local/share/opencode/storage`) | Root |
| `…/message/{sessionID}/…` | Session messages |
| `…/part/{messageID}/*.json` | Message parts (thinking inject/strip, synthetic tool results) |

Recovered classes: `tool_result_missing`, `thinking_block_order`, `thinking_disabled_violation`. Optional `autoResume` re-prompts after thinking recovery.

## TUI Quota Status Flow

`tui.ts` is loaded by OpenCode's TUI plugin system after the installer writes `~/.config/opencode/tui.json`.

1. Resolve the active account fingerprint from stored accounts.
2. Read OpenCode KV quota state and the shared quota cache.
3. Refresh usage data when enough time has passed and the active account is eligible.
4. Render compact prompt status only inside active sessions.
5. Expose quota details without leaking account tokens.

The request path also writes quota snapshots from response headers, so the TUI can reflect the account/workspace used by the latest request.

The shared cache file resolves in this order. `tui.ts` passes the OpenCode state path (`api.state.path.state`) to `getTuiQuotaCachePath`. That function falls back to `$OPENCODE_STATE_DIR`, then to `~/.local/state/opencode/oc-codex-multi-auth-tui-quota.json`. There is no `~/.opencode/` fallback.

`quotaStatus.mode` names the screen, or the list of screens to alternate between every `rotateMs`. One node stays mounted for the whole session and reads from whichever pipelines the current screens need, so a config edit never asks the renderer to replace a live node:

- `active` is the pipeline above: one serving account, a fingerprint, and a one-second identity poll.
- `overview` and `resets` share the pool pipeline, since `resets` needs exactly the windows and banked credits that pipeline already gathers.

The pool pipeline:

1. Read the pool snapshot from `oc-codex-multi-auth-tui-quota-overview.json` in that same directory.
2. Re-query `/wham/usage` for every deduplicated enabled account when that snapshot has aged past the refresh interval, and write it back.
3. Merge the single-account snapshot above when it is newer, so the account currently serving requests shows header-fresh numbers rather than poll-aged ones.
4. Render through `formatQuotaOverviewCandidates` (or `formatQuotaResetsCandidates`), taking the first rung that fits.

The two caches stay separate files on purpose: the request path rewrites the single-account one after every response, and folding them together would make each request rewrite a document describing accounts that request never touched.

The space the line has is **measured**, not computed. `measureStatusSlot` walks up from the mounted node to the prompt's bottom row and takes that row's width, less a constant for the model label, because an open sidebar takes a share nothing in the plugin can derive from the terminal width. Every hop is duck-typed and guarded, and an unfamiliar tree degrades to the old width heuristic rather than budgeting from numbers that no longer mean what they did.

The label's own width and height are deliberately **not** measured, and both were tried and reverted during QA. The row sizes both boxes by their content with `alignItems: stretch`, so the label box reports this line's own height once this line grows, and is shrunk to whatever this line did not take once the row is full. Either reading makes the budget a function of its own output: the height version latched `rows: "auto"` at two rows permanently, and the width version ratchets the column budget down on every render. The row's width is the only number on that row this line cannot influence.

`rows` is therefore a plain ceiling (1-4, default 1), not a measurement. It costs nothing until the content needs the room, since a candidate that fits on one row still returns one row. A second row is one `text` node with a newline in it, so the renderer measures it and the node sizes itself; `alignSelf: "flex-start"` keeps it on the top row, since the host centres this slot against a label that wraps.

For total-only and all-event forecasts, `lib/tui-status-slot.ts` prevents the exclusive host wrapper from flex-shrinking the already-budgeted text into a middle ellipsis. It captures the original Yoga shrink value and restores it on cleanup or a switch back to legacy options. Shared wrappers and hosts without the readable Yoga contract are left untouched.

A screen that renders nothing is skipped in the rotation rather than shown blank. `resets` surfaces at `resetsMinUsedPercent` total weighted usage (default 100), only for known applicable credits. Capacity recovery simulation lives in `lib/quota-recovery.ts` and shares governing-window/weighted-total arithmetic from `lib/quota-capacity.ts`; `recovery: "all"` reports chronological incremental returns without inventing recurring windows.

---

## Model Catalog and Fallback Notes

The default installer preserves `provider.openai`. `--modern` writes the modern OpenCode template (`config/opencode-modern.json`):

- 10 base model families in the picker:
  - `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`
  - `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
  - `gpt-5.5`, `gpt-5.5-fast`
  - `gpt-5.4-nano`, `gpt-5.1`
- 53 effective variants through OpenCode's variant selector
- `store: false`
- `reasoning.encrypted_content`
- large context/output metadata for supported model families

`--full` adds 53 explicit selector IDs for scripts. `--legacy` writes the explicit-only template (53 entries) for older OpenCode versions.

`gpt-5.4-mini`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, and `gpt-5.1-codex-mini` were removed from both templates: `gpt-5.4-mini` retired from Codex with ChatGPT sign-in on 2026-08-31 (replacement `gpt-6-luna`), and the other four were shut down from the OpenAI API on 2026-07-23 (replacement `gpt-5.6-sol`, or `gpt-5.6-terra` for `gpt-5.1-codex-mini`). Routing is unchanged: a user who still types one of these ids by hand is still routed and rescued by the default fallback chains. The installer's `STALE_MANAGED_MODEL_KEYS` set now prunes these five base ids and their legacy variant keys from an existing `opencode.json` on reinstall, the same way it already did for `gpt-5.2` / `gpt-5.3-codex` / `gpt-5.4`.

Unsupported-model behavior is strict by default. Default auto-fallbacks still cover common entitlement gates for `gpt-6-astra` → `gpt-6-sol`/`gpt-6-luna` → the GPT-5.6 tiers → `gpt-5.5`, and for `gpt-5.5` / `gpt-5-codex` through `gpt-6-sol` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-6-luna` / `gpt-5.6-luna`. The same terminal `gpt-5.6-luna` ends each higher tier's own chain, and it repeats on every tier row on purpose, because the resolver reads the chain of whichever model the request is currently on. `gpt-5.2` was removed as every chain's terminal after openai/codex #44250 (2026-09-09) removed it from the catalog, and the terminal is now `gpt-5.6-luna` rather than `gpt-5.5`, since OpenAI's Codex model docs say GPT-5.5 retires from Codex with ChatGPT sign-in on 2026-10-14 while 5.6 Luna has no retirement date. GPT-5.4 and GPT-5.4 Mini were retired from Codex on 2026-08-31 and are no longer fallback targets. `normalizeModel()`'s default for a missing or unrecognized model id, and the legacy `gpt-5` alias, are now both `gpt-6-sol` (was `gpt-5.4` and `gpt-5.5` respectively). A single request hops across at most `MAX_QUOTA_FALLBACK_SWITCHES` (6, was 3) quota-exhausted models. Full generic fallback can be enabled through config or environment variables.

---

## Rotation and Reliability

- `rotationStrategy` defaults to `hybrid`. `lib/accounts/rotation.ts` keeps the current account for the family while it is selectable, then `selectHybridAccount` in `lib/rotation.ts` scores candidates as `health*2 + tokens*5 + hoursSinceUsed*2.0` and takes the best score. When every candidate is blocked, selection falls back to the least-recently-used account, and the request loop discards that fallback if it is still ineligible. Alternatives: `sticky`, `round-robin`.
- `lib/rotation.ts` owns hybrid health scoring; `lib/accounts/rotation.ts` wires it into account manager state.
- Rotation health uses `HealthScoreTracker` in `lib/rotation.ts`: +1 per success, -10 on rate limit, -20 on other failure, +2 per hour of passive recovery, clamped to 0-100.
- The standalone CLI defines health differently. `health` and `status` count an account healthy when `enabled && hasRefreshToken`. That check reads credentials, not rotation scores.
- Circuit breaker isolates repeated failures. It opens after 3 failures inside a 60s window, resets after 30s, and allows 1 half-open probe attempt. The key is `${accountId}:${workspaceIdentityHash}:${modelFamily}`, where the workspace hash is a truncated SHA-256 of the account's workspace identity key, or `index-<n>` when no workspace identity exists. It is not keyed per URL path. One degraded endpoint cannot poison other families on the same account.
- Retry budgets: `lib/request/retry-budget.ts` tracks six per-request classes (`authRefresh`, `network`, `server`, `rateLimitShort`, `rateLimitGlobal`, `emptyResponse`). Profiles set the limits: `conservative` 2/2/2/2/1/1, `balanced` 4/4/4/4/3/2, `aggressive` 8/8/8/8/10/4, in class order. Config selects the profile with per-class overrides, and `beginnerSafeMode` forces `conservative`. An exhausted budget fails the request instead of retrying without bound.
- Empty-response retries use `emptyResponseMaxRetries` / `emptyResponseRetryDelayMs` and consume the `emptyResponse` budget class.
- Optional `parallelProbing` can probe account health concurrently (default off; note that `lib/parallel-probe.ts` races requests first-success-wins rather than running read-only health checks, and is currently uncalled by runtime entrypoints).

### Error Classification and Rotation Matrix

| Status / Condition | Consumed Budget | Action Taken | Health Impact | Storage Side-Effect |
| :--- | :--- | :--- | :--- | :--- |
| **429 (delay <= 5000ms)** | `rateLimitShort` | Jittered sleep `addJitter(max(100, delayMs), 0.2)` and retry on same account | None | None (no cooldown window written) |
| **429 (delay > 5000ms)** | None (immediate rotate); `rateLimitGlobal` when all accounts blocked | Rotate to next candidate account; when all accounts are blocked, wait and retry | -10 | Records `rateLimitResetTimes` per model family |
| **401 Invalidated** | None (`authRefresh` applies during token refresh) | Increment `authFailures`; if >= 3, remove account; else 30s group cooldown | None | Persists updated failure count or account removal |
| **5xx / Server Error** | `server` | Trip circuit breaker, rotate to next account | -20 | None (unless server payload carries rate-limit reset) |
| **Network Error** | `network` | Trip circuit breaker, rotate to next account | -20 | None |
| **Workspace Deactivated** | None | Flag account and remove from active pool | -20 | Writes active pool and flagged storage files |
| **Stream Interrupted** | `server` | Rotate to next account if within budget | -20 | None |
| **Token Bucket Depleted** | None | Rotate immediately (`rate-limit-local`) | None | None (local throttle only, no upstream penalty) |

---

## Invariants

1. OAuth callback port remains `1455`.
2. Dist output is generated; source of truth is `index.ts`, `tui.ts`, `lib/`, `scripts/`, `config/`, and `docs/`.
3. The canonical package and plugin entry is `oc-codex-multi-auth` (exports `"."` and `"./tui"`).
4. The installer should normalize stale `oc-chatgpt-multi-auth` entries rather than preserve duplicates.
5. ChatGPT-backed Codex requests use `store: false`.
6. `reasoning.encrypted_content` must stay available for multi-turn continuity.
7. Account emails and tokens must not be exposed in diagnostic payloads or response headers.
8. Keychain failures must not silently delete JSON credentials.
9. Account pool limits stay at `ACCOUNT_LIMITS` (max 20, 30s auth cooldown, disable after 3 consecutive auth failures without deleting credentials).
10. Codex CLI hydrate from `~/.codex` stays on unless `CODEX_AUTH_SYNC_CODEX_CLI=0`.
11. Startup prewarm runs only for legacy request transform when not disabled via `CODEX_AUTH_PREWARM=0`.
12. Installer help/post-install strings must match the live catalog (10 modern bases / 53 variants; 53 legacy explicit).
13. Tool additions require a per-file factory, registry wiring, and focused test/docs updates.
14. Boolean environment overrides are truthy only for the literal string `"1"`.
15. Docs, package metadata, GitHub About text, and plugin metadata should lead with OpenCode, ChatGPT OAuth, Codex/GPT-5 routing, multi-account rotation, account switching, health checks, diagnostics, and recovery tools.

---

## Verification

Recommended local validation for architecture/docs/metadata changes:

```bash
npm test -- test/doc-parity.test.ts
npm run typecheck
npm run lint
npm run build
git diff --check
```

Use `npm test` when source behavior changes or when documentation edits touch tested runtime contracts.

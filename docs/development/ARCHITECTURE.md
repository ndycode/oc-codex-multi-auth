# Architecture

Maintainer-facing module map and invariants for `oc-codex-multi-auth`. `docs/architecture.md` is the shorter public overview; this file is the source of truth for how the code fits together.

---

## Entry Points

| Entry | Contract | What it does |
| --- | --- | --- |
| `index.ts` | V1 `server` hook + default-export `setup` | OAuth loader, account manager, custom fetch pipeline, tool registry, metrics, recovery toasts. `PluginInput.directory` (fallback `worktree`) binds per-project storage. V2 `setup` dynamically imports `lib/opencode-v2.ts` and calls `setupV2(context, createPluginRuntime)`. |
| `tui.ts` | V1 `tui` hook + default-export `setup` | Registers the `session_prompt_right` slot and `codex.quota.details` command; `dispose`/`onDispose` lifecycle stops the slot polling a dead api. V2 `setup` delegates to `setupV2Tui`. |
| `scripts/install-oc-codex-multi-auth.js` | npm bin | Delegates to `scripts/install-oc-codex-multi-auth-core.js`: config merge, model catalog, TUI enablement, cache cleanup, standalone CLI (`doctor` `status` `list` `limits` `dashboard` `health` `diag` `warm`). |

`createPluginRuntime` in `index.ts` is the shared V1 runtime factory and is deliberately **not** exported — a V1 host invokes every exported plugin-shaped value, so an exported factory would boot a second runtime. V2 receives it through `setup`.

---

## Module Map

There is no lib-wide barrel; modules import focused paths directly.

| Area | Files | Responsibility |
| --- | --- | --- |
| Auth | `lib/auth/` | PKCE OAuth (`auth.ts`), loopback listener flows (`loopback-flow.ts`, `server.ts`, `browser.ts`), device code (`device-code.ts`), manual paste + workspace selection (`login-runner.ts`), scope checks (`scopes.ts`), JWT/plan claims (`token-utils.ts`, `plan-tier.ts`) |
| Accounts | `lib/accounts.ts`, `lib/accounts/` | Manager facade; state, persistence, rotation wiring, rate limits, warm requests, stale-state repair, pool identities (`seat:` for Business seats) |
| Rotation | `lib/rotation.ts` | `selectHybridAccount` scoring, `HealthScoreTracker`, token buckets |
| Storage | `lib/storage.ts`, `lib/storage/` | V3 JSON, atomic writes (fsync), migrations, paths, keychain, backup/import/export, flagged accounts, credential snapshots, transaction/worktree/refresh locks |
| Config | `lib/config.ts`, `lib/schemas.ts` | Plugin config + env overrides; stat-signature gate (`mtimeMs`/`ctimeMs`/`size`/`ino`) re-reads on change and re-parses only when content differs; `resolveAccountIdOverride` for `CODEX_AUTH_ACCOUNT_ID` |
| Request | `lib/request/` | `fetch-helpers.ts` (URL rewrite, headers, error mapping, fallback, refresh), `request-transformer.ts` (legacy body rewrites), `response-handler.ts` (incremental SSE fold, stall guards, empty-response detection), `retry-budget.ts`, `rate-limit-backoff.ts`, `helpers/` (model-map, responses-lite, client-identity, user-agent, effort-suffix, input-utils, tool-utils) |
| Prompts | `lib/prompts/` | `codex.ts` (families + instructions cache, renders `model_messages.instructions_template` from the Codex catalog), `opencode-codex.ts`, `codex-opencode-bridge.ts`, `codex-instructions.ts` (vendored last-resort bundle when fetch and caches fail) |
| Tools | `lib/tools/` | `index.ts` (`ToolContext` + `createToolRegistry`), `args.ts` (shared `format`/`includeSensitive` constants), one `codex-*.ts` per tool, `doctor-repair.ts` + `refresh-account.ts` shared helpers |
| TUI | `tui.ts`, `lib/tui-*.ts`, `lib/codex-usage.ts`, `lib/quota-*.ts` | Prompt status line, shared quota cache, pool overview, slot measuring/flex guard, header parsing, capacity/recovery forecast |
| V2 adapter | `lib/opencode-v2*.ts` | `setup` implementations for OpenCode 2.0.16+ (see below) |
| Recovery | `lib/recovery.ts`, `lib/recovery/` | `detectErrorType`/`isRecoverableError` + toast content used by the request path; `hook.ts` repair engine (see Recovery below) |
| Reliability | `lib/circuit-breaker.ts`, `lib/refresh-queue.ts`, `lib/proactive-refresh.ts`, `lib/parallel-probe.ts`, `lib/shutdown.ts`, `lib/health.ts` | Failure isolation, serialized refresh, scheduled refresh, first-success-wins probes (not currently called by entrypoints), exit cleanup, health status |
| Support | `lib/runtime.ts`, `lib/logger.ts`, `lib/errors.ts`, `lib/error-sentinels.ts`, `lib/constants.ts`, `lib/oauth-constants.ts`, `lib/ui/`, `lib/cli.ts`, `lib/account-display.ts`, `lib/table-formatter.ts`, `lib/utils.ts`, `lib/plugin-origin.ts`, `lib/auto-update-checker.ts`, `lib/desktop-notifications.ts`, `lib/quota-notifications.ts` | Metrics/types, logging, error types, shared constants, terminal UI, email masking, origin/update checks, notifications |

---

## Request Pipeline

1. Resolve plugin config: defaults + `~/.opencode/openai-codex-auth-config.json` + env overrides (boolean envs are truthy only for `"1"`).
2. Rewrite the URL to `chatgpt.com/backend-api/codex/responses` unless `OPENAI_BASE_URL` is set **and** `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` trusts it — fail-closed: HTTPS for remote hosts, literal loopback IPs only over HTTP, no credentials/query/fragment, no redirects.
3. Shape the body: `native` mode (default) preserves the host payload and upserts a `## Backend Model Identity` developer message; `legacy` mode applies compatibility rewrites in `lib/request/request-transformer.ts`.
4. Enforce the stateless contract — `store: false`, `stream: true`, `reasoning.encrypted_content` include. Legacy mode sets all three unconditionally; native mode carries `store: false` + `reasoning.encrypted_content` from the shipped config templates and `stream` from the host payload.
5. Normalize the model; for `gpt-6-*`, Daybreak, and `gpt-5.6-*` apply the responses-lite reshape per attempt (`lib/request/helpers/responses-lite.ts`): tools move into `input` as `additional_tools`, instructions become a developer message, `parallel_tool_calls` off, `reasoning.context: all_turns`, image `detail` stripped, `x-openai-internal-codex-responses-lite: true` header.
6. Resolve client identity: `opencode` for responses-lite models, `codex_cli_rs` otherwise (`CODEX_AUTH_CLIENT_IDENTITY` overrides).
7. Select the account: `modelAccountPools`/`modelAccountPoolModes` (`preferred` falls back to the general pool, `strict` does not), then `rotationStrategy` with cooldowns, quota windows, token bucket, and `CODEX_AUTH_ACCOUNT_ID` pinning.
8. Refresh the token through the queued refresh path when needed; attach OAuth + Codex headers.
9. Send; fold SSE events into a response as lines arrive, extract rate-limit/quota headers (`x-codex-primary-*`/`x-codex-secondary-*` via `lib/quota-windows.ts`), map errors.
10. On failure: consume the matching retry-budget class, update health + circuit breaker, rotate, or fall back along the model chain (max `MAX_QUOTA_FALLBACK_SWITCHES` = 6 hops). On recoverable session errors, classify and show a recovery toast.
11. Persist: runtime metrics, account health stamps, TUI quota cache, storage.

---

## Auth Flow

`lib/auth/` implements four login methods — default browser, open URL manually, device code, manual URL paste — exposed to OpenCode as the four OAuth labels only:

| Method | Flow |
| --- | --- |
| Default browser | Opens the authorize URL in the system browser; loopback listener on `1455` completes the exchange |
| Open URL manually | Same loopback listener, but the URL is printed for the user to open anywhere — the open-URL-manually callback completes automatically |
| Device code | Headless/SSH: verification URL + one-time code poll |
| Manual URL paste | User pastes the full callback URL; its `state` parameter binds the paste to the login attempt, so a bare code or mismatched state is rejected before token exchange |

The callback server binds both `127.0.0.1:1455` and `[::1]:1455`; the path is `/auth/callback`. Tokens land in the V3 account pool (global or per-project). Workspace identity is preserved per account; `lib/auth/scopes.ts` validates connector scopes and triggers re-auth checks. Token responses are schema-validated, and `expires_in` is bounded before it becomes a stored `expires` timestamp — a negative or absurdly large lifetime cannot pin a token to the epoch or push its expiry into overflow territory.

---

## Storage

Canonical state lives under `~/.opencode`; OpenCode config under `~/.config/opencode`.

| File | Purpose |
| --- | --- |
| `~/.opencode/openai-codex-auth-config.json` | Plugin runtime config |
| `~/.opencode/oc-codex-multi-auth-accounts.json` | Global V3 pool |
| `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` | Per-project V3 pool (default on) |
| `oc-codex-multi-auth-flagged-accounts.json` | Deactivated/flagged metadata, written beside the active pool file |
| `backups/codex-credential-snapshot-*.json` | Pre-write snapshot of the previous pool; retention prunes only this prefix |
| `oc-codex-multi-auth-quota-notifications.json` | Cross-process quota-notification state, beside the active pool file |
| `~/.opencode/logs/codex-plugin/` | Request/debug logs when enabled |
| `~/.local/share/opencode/auth.json` | OpenCode host auth store, backfilled from the pool by `backfillHostOpenAIAuthFromPool` |

Invariants:

- V1 pools migrate to V3 on load; V2-format files throw `UNKNOWN_V2_FORMAT`; versions above 3 throw `UNSUPPORTED_SCHEMA_VERSION`.
- Mutations run under a process mutex plus a `proper-lockfile` lease on `<storage>.transaction.lock`. OAuth refresh uses a **second** lease on `<storage>.refresh.lock` because refresh tokens are single-use — `lib/storage/coordinated-refresh.ts` serializes the exchange across processes and `propagateRotationToSiblingStore` keeps the sibling store's rotation state consistent. `<storage>.lock` remains advisory collision diagnostics; `lib/storage/worktree-lock.ts` detects other live processes without blocking.
- A refresh that succeeded upstream but could not be committed to the pool (crash, lost lease) is journaled in a `<accounts-file>.refresh.pending.<hash>` file (one per consumed token; the legacy unsuffixed `.refresh.pending` name is still replayed) beside the accounts file and applied on the next load, so a rotated refresh token is never lost to an interrupted write.
- Keychain is opt-in (`CODEX_KEYCHAIN=1`), service `oc-codex-multi-auth`, keys `accounts:global` / `accounts:<project-storage-key>`. Migrating JSON→keychain renames the source to `<file>.migrated-to-keychain.<timestamp>` as the rollback artifact; `deleteFlaggedFromKeychain` handles flagged entries. Keychain failures never silently delete JSON credentials.
- Import supports dry-run preview and takes a pre-import backup when accounts exist.

---

## Tool Registry

`index.ts` builds one `ToolContext` from plugin-closure state (mutable refs for the account-manager cache plus read-only helper functions) and passes it to `createToolRegistry(ctx)` in `lib/tools/index.ts`, which registers 25 OpenCode tools — `codex-list`, `codex-switch`, `codex-warm`, and the rest. By convention every registered `codex-*` tool is its own file under `lib/tools/` and exports a `createCodex<Name>Tool(ctx)` factory.

Shared argument metadata lives in `lib/tools/args.ts` (`TOOL_OUTPUT_FORMAT_VALUES`, descriptions): the `format` field is `tool.schema.enum(...)` per tool — schema calls stay inline because a shared schema factory's inferred zod type cannot cross the module boundary (TS2742). `lib/tools/doctor-repair.ts` (refresh + stale-state clear) and `lib/tools/refresh-account.ts` (single-use refresh persistence) are shared helpers, not registered tools.

The standalone CLI mirrors a subset: `doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm`.

---

## OpenCode V2

OpenCode 2.0.16+ calls `setup` on the default exports instead of the V1 hooks. `index.ts` delegates to `setupV2(context, createPluginRuntime)` in `lib/opencode-v2.ts`; `tui.ts` delegates to `setupV2Tui` in `lib/opencode-v2-tui.ts`. The adapter reuses the shared V1 runtime rather than duplicating it.

| Module | Role |
| --- | --- |
| `lib/opencode-v2.ts` | Integration auth methods (`codex-multi-N` on `openai`, index 0 drives the loopback flow), provider/model transforms, `aisdk` hooks, `tool.transform` bridge, `CodexStatusRpc` registration, credential-event subscription |
| `lib/opencode-v2-provider.ts` | Two-line re-export of `createOpenAI` from `@ai-sdk/openai`; its separate module identity (`provider.package = aisdk:<module>`) keeps V2 from swapping in its native driver before the multi-account fetch hook is installed |
| `lib/opencode-v2-rpc.ts` | `CodexStatusRpc` (`status` method) shared by adapter and V2 TUI |
| `lib/opencode-v2-status.ts` | Server-side quota/account formatting so remote TUIs never need credentials |
| `lib/opencode-v2-tui.ts` | Three `ui.slot`s (app poller, `prompt.footer.status`, `sidebar.content`), `codex.quota.details` + `codex.accounts` palette commands, `/codex-accounts` |

Key mechanics:

- V2's `setup` receives a `Plugin.Context` — no V1 `client`, no host `auth.json`. `createPluginRuntime` is passed in so rotation, the auth loader, the tool registry, and the disposal `event` hook are shared. Each registered location gets its own `createStorageScope()` (`lib/storage/state.ts`), so several V2 locations in one process keep separate account-storage state.
- V1 owns the HTTP exchange through a custom `fetch`; V2 instantiates an AI-SDK client itself, so the adapter installs `aisdk.hook("sdk")` (`createV2Fetch` re-adds `store: false`, the `reasoning.encrypted_content` include, and the `opencode/<version>` user agent) and `aisdk.hook("language")` (`createV2Language` strips `previousResponseId`/`conversation` so server-side references can't reach the stateless backend).
- Tool calls execute through `tool.transform` with zod-validated args; legacy `ask` permission requests throw. The adapter is inert until a pooled account or `openai` OAuth connection exists, then calls `context.provider.reload()`; `credential.updated`/`credential.switched` re-check.
- `codexTuiV2` / `CODEX_TUI_V2` (default on) gates V2-aware TUI formatting in the V1 runtime.
- Install: `npx -y oc-codex-multi-auth@latest --v2` writes a `plugins` entry; refuses existing `opencode.jsonc` or V1 `plugin` entries.

---

## TUI Quota Status

`tui.ts` registers one `session_prompt_right` slot plus the `codex.quota.details` command; `dispose`/`onDispose` flips a flag so nothing renders or polls into a dead api. The status line reads the shared cache (`lib/tui-quota-cache.ts`) and refreshes `/wham/usage` when stale; the request path writes the same cache from response quota headers, so the line reflects the account that served the last request.

`quotaStatus.mode` selects the screen — `active` (single serving account), `overview` or `resets` (pool-wide; `lib/quota-overview.ts` formats, `lib/tui-quota-overview.ts` gathers/caches in `oc-codex-multi-auth-tui-quota-overview.json` and merges the live single-account read), or a list rotated every `rotateMs`. A screen that renders nothing is skipped; `resets` appears only at `resetsMinUsedPercent` (default 100) weighted usage for known applicable credits, forecast by `lib/quota-recovery.ts` + `lib/quota-capacity.ts`.

The slot's width is measured, not computed: `measureStatusSlot` walks up to the prompt's bottom row and takes its width (a sidebar eats a share nothing else exposes). `rows` is a plain ceiling (1–4, default 1). `lib/tui-status-slot.ts` restores the host wrapper's Yoga flex-shrink so a budgeted line isn't ellipsized. `lib/quota-display.ts` owns free/used wording; `lib/plan-allotment.ts` weights the pool total.

---

## Rotation and Reliability

- `rotationStrategy`: `hybrid` (default — keep current while selectable, else best `health*2 + tokens*5 + hoursSinceUsed*2.0`, else least-recently-used), `sticky`, `round-robin`. `lib/rotation.ts` scores; `lib/accounts/rotation.ts` wires it into manager state.
- Health (`HealthScoreTracker`): +1 success, −10 rate limit, −20 other failure, +2/hour passive recovery, clamped 0–100. The standalone CLI counts an account healthy when `enabled && hasRefreshToken` — credentials, not scores.
- Circuit breaker: opens after 3 failures in 60s, resets after 30s, allows 1 half-open probe. Key: `${accountId}:${workspaceIdentityHash}:${modelFamily}` — one degraded family can't poison others on the same account.
- Retry budgets (`lib/request/retry-budget.ts`): six classes — `authRefresh`, `network`, `server`, `rateLimitShort`, `rateLimitGlobal`, `emptyResponse`. Profiles: `conservative` 2/2/2/2/1/1, `balanced` 4/4/4/4/3/2, `aggressive` 8/8/8/8/10/4; `beginnerSafeMode` forces `conservative`. Exhaustion fails the request.
- All-accounts-limited waits: `retryAllAccountsMaxWaitMs: 0` means "as long as the backend asks", but interactive requests are capped by `INTERACTIVE_ALL_LIMITED_CEILING_MS` (10 min) unless `CODEX_RETRY_ALL_UNBOUNDED=1`. The "remaining" countdown sleeps on elapsed time, not `Date.now()` deadlines — a wall-clock jump neither stretches nor cancels the wait.
- `lib/parallel-probe.ts` races probe requests across candidates first-success-wins with a `timeoutMs` bound; no runtime entrypoint currently calls it.

### Error → Action Matrix

| Condition | Budget | Action | Health |
| --- | --- | --- | --- |
| 429, delay ≤ 5s | `rateLimitShort` | Jittered sleep, retry same account | None |
| 429, delay > 5s | `rateLimitGlobal` when all blocked | Rotate; wait+retry when all blocked; stamp `rateLimitResetTimes` per family | −10 |
| 401 invalidated | `authRefresh` during refresh | `authFailures`++ → 30s group cooldown; disable (credentials kept) at 3 | None |
| 5xx | `server` | Trip breaker, rotate | −20 |
| Network error | `network` | Trip breaker, rotate | −20 |
| Workspace deactivated | None | Flag + disable in pool; write flagged storage | −20 |
| Stream interrupted | `server` | Rotate within budget | −20 |
| Token bucket depleted | None | Rotate immediately (local throttle) | None |

---

## Recovery

With `sessionRecovery` on (default), the request path gates on the hook object and classifies errors via `detectErrorType`/`isRecoverableError`, then shows a toast. The repair engine in `lib/recovery/hook.ts` — `handleSessionRecovery`, message/part rewriting through `lib/recovery/storage.ts`, optional `autoResume` re-prompt — is created but never invoked by request handlers or host event streams. Its recovered classes are `tool_result_missing`, `thinking_block_order`, `thinking_disabled_violation`, reading/writing the host session storage under the OpenCode storage root.

---

## Shutdown

`lib/shutdown.ts` registers one cleanup pass on SIGINT/SIGTERM/beforeExit. As a host plugin it drains cleanup and returns (exit ownership stays with OpenCode); standalone CLI entries call `setShutdownOwnsProcess(true)` and exit 130/143 (`128 + signal`).

---

## Model Catalog

`--modern` writes `config/opencode-modern.json`: 12 base model families — `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-fast`, `gpt-5.4-nano`, `gpt-5.1` — with 65 effective variants via OpenCode's variant picker, every entry carrying `store: false` + `reasoning.encrypted_content`. `--full` adds 65 explicit selector IDs; `--legacy` writes 65 explicit entries; the default install preserves `provider.openai`.

Retired bases (`gpt-5.4-mini`; the `*-codex` ids) are absent from the templates but still routed if typed — default fallback chains rescue them, and the installer's `STALE_MANAGED_MODEL_KEYS` prunes them from existing configs. `normalizeModel()` defaults to `gpt-6-sol`.

---

## Documentation Layout

```text
docs/
├── index.md                  # docs landing page
├── README.md                 # docs portal navigation
├── DOCUMENTATION.md          # repository documentation map
├── architecture.md           # public architecture overview
├── getting-started.md        # install, auth, first run
├── tools-and-cli.md          # codex-* tool catalog + standalone CLI
├── configuration.md          # public config reference
├── plan-allotments.md        # ChatGPT plan -> allotment multiplier map
├── troubleshooting.md        # operational failure modes
├── faq.md                    # short common answers
├── privacy.md                # local data + upstream request notes
├── OPENCODE_PR_PROPOSAL.md   # upstream OpenCode proposal notes
├── _config.yml               # docs site config
└── development/
    ├── ARCHITECTURE.md       # this file
    ├── CONFIG_FIELDS.md      # config field semantics
    ├── CONFIG_FLOW.md        # config resolution internals
    ├── TESTING.md            # testing strategy and commands
    ├── TUI_PARITY_CHECKLIST.md  # auth dashboard parity checks
    └── GITHUB_DISCOVERABILITY.md # repo description, topics, search wording
```

---

## Invariants

1. OAuth callback port `1455`, path `/auth/callback`, bound on `127.0.0.1` and `::1`.
2. `dist/` is generated; sources are `index.ts`, `tui.ts`, `lib/`, `scripts/`, `config/`, `docs/`.
3. Canonical name `oc-codex-multi-auth`; exports `"."` and `"./tui"`. Stale `oc-chatgpt-multi-auth` entries are normalized, never duplicated.
4. `store: false` and `reasoning.encrypted_content` stay on every shipped template entry and on the wire (V1 via custom fetch, V2 via `createV2Fetch`).
5. Account emails/tokens never appear in diagnostics, tool output, or logs; `maskEmail` routes through `lib/account-display.ts`.
6. Keychain failures never silently delete JSON credentials.
7. `ACCOUNT_LIMITS`: max 20 accounts, 30s auth-failure cooldown, disable after 3 consecutive auth failures (credentials retained).
8. Codex CLI hydrate from `~/.codex` unless `CODEX_AUTH_SYNC_CODEX_CLI=0`; startup prewarm only for legacy transform mode unless `CODEX_AUTH_PREWARM=0`.
9. Boolean env overrides are truthy only for the literal string `"1"`.
10. New `codex-*` tools need a per-file factory, registry wiring in `lib/tools/index.ts`, tests, and docs.
11. Installer/help/doc catalog counts match the shipped templates (12 bases / 65 variants; 65 legacy entries) — `test/doc-parity.test.ts` derives them from the templates, so drift fails the suite.

---

## Verification

```bash
npm test -- test/doc-parity.test.ts   # docs/config/tool-registry parity
npm run typecheck && npm run lint
npm test && npm run build
git diff --check
```

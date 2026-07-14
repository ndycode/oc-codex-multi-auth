# Architecture

Runtime architecture for the `oc-codex-multi-auth` OpenCode plugin, installer, ChatGPT Plus/Pro OAuth flow, Codex/GPT-5 request bridge, multi-account rotation, `codex-*` tool registry, TUI quota status plugin, and local storage model.

> Reflects the codebase as of the current `main` branch. Historical audit section markers are retained in the docs tree for traceability, but this file is the current maintainer architecture source.

---

## Design Goals

1. Make OpenCode ChatGPT OAuth setup short and repeatable (`npx -y oc-codex-multi-auth@latest`).
2. Keep OpenCode as the host runtime while the plugin owns only the OAuth-backed Codex routing layer.
3. Preserve Codex backend invariants: `stream: true`, `store: false`, and `reasoning.encrypted_content`.
4. Make multi-account state visible through account switching, health checks, diagnostics, quota status, and recovery commands.
5. Keep account storage local by default, with explicit export/import and optional OS keychain migration.
6. Keep the broad OpenCode tool surface modular: every registered `codex-*` tool is its own file under `lib/tools/`.
7. Keep public docs search-friendly without overstating support, affiliation, or production/commercial use.

---

## System Diagram

```text
Install / refresh
  |
  | npx -y oc-codex-multi-auth@latest [--modern|--full|--legacy]
  v
scripts/install-oc-codex-multi-auth.js
  |- delegates to scripts/install-oc-codex-multi-auth-core.js
  |- writes ~/.config/opencode/opencode.json
  |- writes ~/.config/opencode/tui.json
  |- merges config/opencode-modern.json or config/opencode-legacy.json
  |- normalizes old package/plugin entries
  |- clears OpenCode plugin cache

OpenCode runtime
  |
  | loads plugin package
  v
index.ts
  |- auth loader: browser callback, device code, manual URL paste
  |- account manager + V3 storage + optional keychain
  |- custom provider fetch pipeline
  |- runtime metrics, retry budgets, circuit breaker, recovery hooks
  |- ToolContext construction
  v
lib/tools/index.ts
  |- registers 23 OpenCode tools
  |- each tool delegates to lib/tools/codex-*.ts

Request path
  |
  | OpenCode OpenAI SDK request
  v
lib/request/fetch-helpers.ts + lib/request/request-transformer.ts
  |- rewrite URL to Codex/ChatGPT backend
  |- native mode: preserve host payload shape
  |- legacy mode: apply compatibility rewrites
  |- force store:false and include reasoning.encrypted_content
  |- select/refresh account, attach OAuth headers
  v
ChatGPT-backed Codex endpoint
  |
  v
lib/request/response-handler.ts
  |- SSE parsing
  |- error mapping
  |- quota/rate-limit/header extraction

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
| Installer CLI | `scripts/install-oc-codex-multi-auth.js`, `scripts/install-oc-codex-multi-auth-core.js` | npm bin, config merge, cache cleanup, modern/full/legacy catalog selection, TUI plugin enablement |
| OpenCode plugin entry | `index.ts` | auth loader, runtime wiring, custom fetch pipeline, account manager lifecycle, `ToolContext`, OpenCode plugin export |
| TUI plugin entry | `tui.ts`, `lib/tui-status.ts`, `lib/tui-quota-cache.ts`, `lib/codex-usage.ts` | prompt quota status, account-aware quota snapshots, usage refresh, details rendering |
| Auth flow | `lib/auth/auth.ts`, `lib/auth/server.ts`, `lib/auth/browser.ts`, `lib/auth/device-code.ts`, `lib/auth/login-runner.ts`, `lib/auth/scopes.ts` | PKCE OAuth, callback server, device/manual login, workspace/account selection, scope validation |
| Account manager | `lib/accounts.ts`, `lib/accounts/` | account state facade, persistence, rotation, recovery, rate-limit tracking, workspace identity preservation |
| Storage | `lib/storage.ts`, `lib/storage/` | V3 JSON storage, atomic writes, migrations, per-project paths, backups, import/export, keychain opt-in, flagged accounts |
| Request bridge | `lib/request/fetch-helpers.ts`, `lib/request/request-transformer.ts`, `lib/request/response-handler.ts`, `lib/request/retry-budget.ts`, `lib/request/rate-limit-backoff.ts` | URL/body/header shaping, Codex invariants, SSE conversion, retry budgets, backoff, error mapping |
| Model/prompt mapping | `lib/prompts/codex.ts`, `lib/prompts/opencode-codex.ts`, `lib/prompts/codex-opencode-bridge.ts`, `lib/request/helpers/model-map.ts` | model-family detection, Codex instructions cache, OpenCode prompt adaptation, fallback aliases |
| Tool registry | `lib/tools/index.ts`, `lib/tools/codex-*.ts` | 23 OpenCode tools for setup, account switching, status, health, quota resets, diagnostics, backup, keychain, and recovery |
| Runtime support | `lib/runtime.ts`, `lib/circuit-breaker.ts`, `lib/proactive-refresh.ts`, `lib/parallel-probe.ts`, `lib/recovery/`, `lib/shutdown.ts` | pure runtime helpers, failure isolation, refresh scheduling, health probing, session recovery, cleanup |
| UI helpers | `lib/ui/` | terminal formatting, auth menu, select/confirm prompts, theme/color handling, beginner checklist |
| Config templates | `config/opencode-modern.json`, `config/opencode-legacy.json`, `config/minimal-opencode.json`, `config/README.md` | copy-paste OpenCode provider templates and model catalog guidance |
| Tests | `test/` | Vitest suites for auth, request transforms, storage, rotation, tools, TUI quota, installer, docs parity, and release regressions |

---

## Documentation Layout

The current docs tree mirrors the codebase boundaries above: user docs cover setup and operations, maintainer docs cover internal architecture and validation, and the regenerated audit corpus records point-in-time architecture findings.

```text
docs/
├── index.md                  # docs landing page
├── README.md                 # docs portal navigation
├── DOCUMENTATION.md          # repository documentation map
├── architecture.md           # public architecture overview
├── getting-started.md        # install, auth, and first-run guide
├── configuration.md          # public config reference
├── troubleshooting.md        # operational failure modes and fixes
├── faq.md                    # short common answers
├── privacy.md                # local data and upstream request notes
├── OPENCODE_PR_PROPOSAL.md   # upstream OpenCode proposal notes
├── _config.yml               # docs site config
├── development/              # maintainer architecture and validation docs
│   ├── ARCHITECTURE.md
│   ├── GITHUB_DISCOVERABILITY.md
│   ├── CONFIG_FIELDS.md
│   ├── CONFIG_FLOW.md
│   ├── TESTING.md
│   └── TUI_PARITY_CHECKLIST.md
└── audits/                   # current-structure audit corpus
    ├── INDEX.md
    ├── 01-executive-summary.md ... 16-verdict.md
    ├── _findings/            # T01 through T16 detailed findings
    └── _meta/                # audit rubric, ledger, environment, verification
```

---

## Request Pipeline

High-level provider fetch flow:

1. Parse OpenCode request URL and body.
2. Resolve plugin config from defaults, `~/.opencode/openai-codex-auth-config.json`, and environment overrides.
3. Choose request transform mode:
   - `native` keeps OpenCode payloads unchanged except required Codex invariants.
   - `legacy` fetches Codex/OpenCode prompts and applies compatibility rewrites.
4. Enforce ChatGPT-backed Codex invariants:
   - `stream: true`
   - `store: false`
   - `include: ["reasoning.encrypted_content"]` or equivalent inclusion
5. Normalize model aliases and fallback candidates.
6. Resolve account/workspace selection with health, cooldown, token bucket, and explicit `CODEX_AUTH_ACCOUNT_ID` constraints.
7. Refresh tokens through the queued refresh path when needed.
8. Attach OAuth/Codex headers and forward the request.
9. Parse SSE responses, quota headers, retryable errors, and unsupported-model details.
10. Update runtime metrics, account health, TUI quota cache, and persisted storage.

---

## Stateless Codex Contract

The ChatGPT-backed Codex path rejects server-side storage for this plugin's request shape, so the runtime keeps requests stateless with `store: false`.

Context is preserved through:

- full message history supplied by OpenCode
- tool call and tool output history in that message history
- `reasoning.encrypted_content` returned by the backend and sent back on later turns

Legacy mode exists for compatibility with older OpenCode/AI SDK payload behavior. It removes unsupported `item_reference` items and message IDs that cannot be looked up when `store: false` is active. Native mode is the default and preserves the host payload shape as much as possible.

---

## Tool Registry Architecture

The plugin exposes 23 OpenCode tools through `lib/tools/index.ts`. `index.ts` builds one `ToolContext` from plugin-closure state and helper functions, then passes it to `createToolRegistry(ctx)`.

Why this shape exists:

- per-tool modules keep `index.ts` from absorbing every command implementation
- mutable refs let tools invalidate or replace account-manager state without global singletons
- shared helpers keep formatting, routing visibility, and beginner diagnostics consistent
- schema helpers stay close to each tool to avoid leaking bundled `zod` type identities across module boundaries

Tool groups:

| Group | Tools |
| --- | --- |
| Setup and help | `codex-setup`, `codex-help`, `codex-next` |
| Daily account use | `codex-list`, `codex-switch`, `codex-status`, `codex-limits`, `codex-reset`, `codex-dashboard` |
| Account metadata | `codex-label`, `codex-tag`, `codex-note`, `codex-remove`, `codex-refresh` |
| Diagnostics | `codex-health`, `codex-metrics`, `codex-doctor`, `codex-diag`, `codex-diff` |
| Backup/secrets | `codex-export`, `codex-import`, `codex-keychain` |

---

## Storage Model

Canonical OpenCode plugin state lives under `~/.opencode`, while OpenCode config lives under `~/.config/opencode`.

| File | Purpose |
| --- | --- |
| `~/.config/opencode/opencode.json` | OpenCode provider/plugin config managed by installer |
| `~/.config/opencode/tui.json` | OpenCode TUI plugin config managed by installer |
| `~/.opencode/auth/openai.json` | OpenCode auth token file |
| `~/.opencode/openai-codex-auth-config.json` | plugin runtime config |
| `~/.opencode/oc-codex-multi-auth-accounts.json` | global V3 account pool |
| `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` | project-scoped V3 account pool |
| `~/.opencode/oc-codex-multi-auth-flagged-accounts.json` | flagged/deactivated account metadata |
| `~/.opencode/backups/` | account backup/export target |
| `~/.opencode/logs/codex-plugin/` | request/debug logs when enabled |

Storage invariants:

1. V1/V2 account files migrate into V3 on load/save paths.
2. Per-project storage is enabled by default and keyed by detected project identity.
3. JSON files are written atomically where supported.
4. Optional keychain storage is opt-in via `CODEX_KEYCHAIN=1`.
5. Import supports dry-run preview and creates pre-import backups when existing accounts are present.

---

## TUI Quota Status Flow

`tui.ts` is loaded by OpenCode's TUI plugin system after the installer writes `~/.config/opencode/tui.json`.

1. Resolve the active account fingerprint from stored accounts.
2. Read OpenCode KV quota state and the shared quota cache.
3. Refresh usage data when enough time has passed and the active account is eligible.
4. Render compact prompt status only inside active sessions.
5. Expose quota details without leaking account tokens.

The request path also writes quota snapshots from response headers, so the TUI can reflect the account/workspace used by the latest request.

---

## Model Catalog and Fallback Notes

The default installer writes the modern OpenCode template:

- 9 base model families in the picker
- 36 effective variants through OpenCode's variant selector
- `store: false`
- `reasoning.encrypted_content`
- large context/output metadata for supported model families

`--full` adds explicit selector IDs for scripts, and `--legacy` writes the explicit-only template for older OpenCode versions.

Unsupported-model behavior is strict by default. Fallback can be enabled through config or environment variables, with GPT-5.5 rollout fallback handled separately where documented.

---

## Invariants

1. OAuth callback port remains `1455`.
2. Dist output is generated; source of truth is `index.ts`, `tui.ts`, `lib/`, `scripts/`, `config/`, and `docs/`.
3. The canonical package and plugin entry is `oc-codex-multi-auth`.
4. The installer should normalize stale `oc-chatgpt-multi-auth` entries rather than preserve duplicates.
5. ChatGPT-backed Codex requests use `store: false`.
6. `reasoning.encrypted_content` must stay available for multi-turn continuity.
7. Account emails and tokens must not be exposed in diagnostic payloads or response headers.
8. Keychain failures must not silently delete JSON credentials.
9. Tool additions require a per-file factory, registry wiring, and focused test/docs updates.
10. Docs, package metadata, GitHub About text, and plugin metadata should lead with OpenCode, ChatGPT OAuth, Codex/GPT-5 routing, multi-account rotation, account switching, health checks, diagnostics, and recovery tools.

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

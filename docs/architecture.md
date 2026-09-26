# oc-codex-multi-auth Architecture

Public overview of how `oc-codex-multi-auth` installs config, handles ChatGPT Plus/Pro OAuth, routes Codex/GPT-5 requests, rotates local account pools, exposes diagnostics, and publishes TUI quota status.

---

## The Short Version

`oc-codex-multi-auth` is an OpenCode plugin for ChatGPT OAuth-backed Codex and GPT-5 workflows.

- The `oc-codex-multi-auth` npm bin is an installer and a small standalone CLI, not a replacement for OpenCode.
- OpenCode loads `dist/index.js` as the provider plugin entry.
- The plugin registers **24** `codex-*` tools via **24 per-file factories** under `lib/tools/` (`codex-list`, `codex-switch`, `codex-warm`, and 21 others).
- OpenCode loads `dist/tui.js` as the TUI plugin for active-session quota status.
- Request handling stays stateless for the ChatGPT-backed Codex API with `store: false`, `stream: true`, and `reasoning.encrypted_content`. Legacy transformation mode enforces all three unconditionally. Native mode carries them through the shipped config templates and the host payload.
- GPT-6 Astra/Sol/Luna, the Daybreak cyber tiers and the GPT-5.6 tiers use the responses-lite request path; older models keep the classic shape.
- Account, config, backup, log, and TUI quota state lives under `~/.opencode` and `~/.config/opencode`.
- Per-project account pools are enabled by default under `~/.opencode/projects/<project-key>/...`.

---

## Main Components

### 1. Installer and standalone CLI

`package.json` publishes one bin:

- `oc-codex-multi-auth` → `scripts/install-oc-codex-multi-auth.js`

With no subcommand (or with `install`), the installer updates OpenCode config, backs up previous files, normalizes stale plugin entries (including the legacy package name `oc-chatgpt-multi-auth`), enables the TUI status plugin, writes model templates, and clears OpenCode's cached package copy so the next OpenCode start uses the latest plugin.

Install modes:

| Flag | Config written |
| --- | --- |
| (default) / `--plugin-only` | Register plugin entries; preserve `provider.openai` |
| `--modern` | Compact modern: 10 base model families + variant picker (53 variants total) |
| `--full` | Compact modern bases **plus** explicit legacy selector IDs |
| `--legacy` | Explicit-only catalog (53 model entries) |

Standalone read/ops commands (no OpenCode agent loop required): `doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm`. See [tools-and-cli.md](tools-and-cli.md).

### 2. OpenCode plugin entry

`index.ts` is the runtime entry OpenCode loads. It owns:

- OAuth login modes: default-browser callback, open-URL-manually callback, device code, and manual URL paste
- account manager lifecycle and local account storage (V3)
- request URL/body/header transformation (native or legacy, plus responses-lite for GPT-6 Astra/Sol/Luna, Daybreak and GPT-5.6)
- health-aware account selection, `rotationStrategy`, and `modelAccountPools`
- retry budgets, circuit breaking (per account, workspace identity, and model family), rate-limit backoff, and failover
- recoverable error detection with a recovery toast in the current plugin runtime, plus beginner-safe next-action guidance
- `ToolContext` construction for the `codex-*` registry

### 3. Request pipeline

OpenCode calls the plugin through the provider fetch path.

```text
OpenCode prompt
  |
  v
OpenCode provider system
  |
  | custom fetch()
  v
oc-codex-multi-auth index.ts
  |- rewrite OpenAI SDK URL to chatgpt.com/backend-api/codex/responses by default
  |- preserve OPENAI_BASE_URL when CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1 explicitly trusts a compatible gateway
  |- shape body for native or legacy transform mode
  |- for lite models (GPT-6 Astra/Sol/Luna, Daybreak, GPT-5.6): apply responses-lite reshape (per attempt)
  |- force stream:true, store:false, reasoning.encrypted_content
  |- select/refresh a healthy account (pools + rotationStrategy)
  |- attach OAuth headers + client identity (originator / User-Agent)
  |- handle SSE, errors, retries, fallback, and metrics
  v
ChatGPT-backed Codex endpoint or configured OpenAI-compatible gateway
```

The gateway override is fail-closed. Remote gateways require HTTPS, literal loopback IPs are the only accepted HTTP targets, embedded credentials/query strings/fragments are rejected, and redirects are not followed. Any address in `127.0.0.0/8` and the IPv6 loopback `::1` count as loopback, so several local services can each hold their own address. Hostnames such as `localhost` are not trusted for cleartext OAuth transport because name resolution can be redirected. A rejected value fails the auth loader with a `[oc-codex-multi-auth]`-prefixed reason and an error toast rather than silently falling back to the default endpoint, and a gateway that answers with a 3xx yields a `502` naming the redirect origin instead of being retried as a malformed response. The gateway receives the same short-lived ChatGPT OAuth access token and account header as the default Codex endpoint, so setting `OPENAI_BASE_URL` alone does not activate the override.

**Native mode** (default) keeps the host payload shape. It normalizes the model name, sets the backend instruction identity line, and upserts one `## Backend Model Identity` developer message naming the outgoing model, refreshed again when fallback changes the model. `store: false` and the `reasoning.encrypted_content` include are not added by the native transform. They ride the provider options in `opencode.json`, which the shipped config templates write. **Legacy mode** applies compatibility rewrites for older OpenCode/AI SDK behavior through `lib/request/request-transformer.ts`. It sets `store: false` and the include itself, filters unsupported `item_reference` payloads, and strips IDs that cannot be used with `store: false`.

**Responses-lite:** for `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, the Daybreak-gated cyber tiers (`gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.6-cyber`), `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, the plugin reshapes the request the way Codex does: tool definitions move into `input` as a leading `additional_tools` developer item, Codex instructions follow as a developer message, top-level `instructions` is emptied, `tools` is omitted, `parallel_tool_calls` is forced off, `reasoning.context` is set to `all_turns`, image `detail` fields are stripped, and `x-openai-internal-codex-responses-lite: true` is sent. Lite reshape is applied per request attempt against the model actually being sent, so a sol → gpt-5.5 fallback re-serializes into the classic shape and keeps its tools.

**Client identity:** by default every responses-lite model uses the host/opencode identity (`originator: opencode` with an `opencode/...` User-Agent). Other families default to the Codex CLI identity. Override with `CODEX_AUTH_CLIENT_IDENTITY`.

**Auto-fallback (preview entitlement gates):**

- GPT-6 Astra: `gpt-6-astra` → `gpt-6-sol` → `gpt-5.6-sol` → `gpt-5.6-terra` → `gpt-5.5` → `gpt-6-luna` → `gpt-5.6-luna` (disable with `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1`)
- GPT-6 Sol and GPT-6 Luna share the same `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK` opt-out and fall back down the same tail of that order
- Cyber tiers (`gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.6-cyber`): no chain. They fail loudly rather than silently answering from a general model.
- GPT-5.6: `gpt-5.6-sol` → `gpt-5.6-terra` → `gpt-5.5` → `gpt-6-luna` → `gpt-5.6-luna` (disable with `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`)
- GPT-5.5 / canonical Codex also have default auto-fallback: GPT-5.5 through `gpt-6-sol` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-6-luna` / `gpt-5.6-luna`, canonical Codex through `gpt-5.6-terra` / `gpt-5.6-luna`; broader fallback chains require `unsupportedCodexPolicy: "fallback"`. `gpt-5.2` was removed as the terminal of every chain after openai/codex #44250 (2026-09-09) removed `gpt-5.2` from the catalog; the terminal is now `gpt-5.6-luna` (not `gpt-5.5`), since OpenAI's Codex model docs say GPT-5.5 retires from Codex with ChatGPT sign-in on 2026-10-14 while 5.6 Luna has no retirement date. GPT-5.4 and GPT-5.4 Mini were retired from Codex on 2026-08-31; the catalog marks both `visibility: "hide"` and names their replacements (`gpt-5.4` -> `gpt-6-sol`, `gpt-5.4-mini` -> `gpt-6-luna`), and `gpt-5.4-nano` has no catalog entry. The default chains therefore end at live models rather than leading with retired ones.

### 4. Account rotation and model pools

`rotationStrategy` (`hybrid` | `sticky` | `round-robin`, default `hybrid`) selects how the plugin load-balances across healthy accounts:

| Strategy | Behavior |
| --- | --- |
| `hybrid` (default) | Stay on the current account while it is selectable; otherwise score candidates with `health*2 + tokens*5 + hoursSinceUsed*2.0` and take the best, falling back to the least-recently-used account when all are blocked |
| `sticky` | Drain one account until rate-limited/cooling, then move to the lowest-indexed available account |
| `round-robin` | Advance through accounts in order |

`modelAccountPools` maps effective model IDs to stable account or Business-seat identities. `modelAccountPoolModes` selects `preferred` (the default, with general-pool fallback) or `strict` (never leave the configured pool). Strict exhaustion returns immediately without entering the global account wait loop. All modes still apply quota, cooldown, and token-health rules. Manage pools with `codex-pool` or edit `~/.opencode/openai-codex-auth-config.json`.

### 5. Tool registry

`lib/tools/index.ts` builds the OpenCode tool map from **24 per-file factories** under `lib/tools/`.

Common groups:

- setup: `codex-setup`, `codex-help`, `codex-next`
- daily account use: `codex-list`, `codex-switch`, `codex-warm`, `codex-status`, `codex-limits`, `codex-reset`
- account metadata and routing: `codex-label`, `codex-tag`, `codex-note`, `codex-pool`, `codex-remove`, `codex-refresh`
- diagnostics and resilience: `codex-health`, `codex-metrics`, `codex-doctor`, `codex-diag`, `codex-diff`
- backup and secrets: `codex-export`, `codex-import`, `codex-keychain`
- interactive surface: `codex-dashboard`

Full catalog: [tools-and-cli.md](tools-and-cli.md).

### 6. TUI quota status plugin

`tui.ts` exposes an OpenCode TUI plugin that reads the active account, shared quota cache (`lib/tui-quota-cache.ts`), and direct usage endpoints when available. It shows compact prompt status during sessions and provides a quota details command without polluting the home prompt.

### 7. Storage and sync

The storage layer uses V3 account files with migrations from older formats, atomic writes, keychain opt-in, import/export previews, flagged-account recovery, and per-project path resolution. V1 pools migrate to V3 on load. V2 files are rejected with the typed `UNKNOWN_V2_FORMAT` recovery error, and versions above 3 with `UNSUPPORTED_SCHEMA_VERSION`. Mutations flow through one transaction primitive that combines the process-local mutex with a distinct `proper-lockfile` lease on `<storage>.transaction.lock`. The existing `<storage>.lock` JSON sidecar remains advisory collision diagnostics.

The optional keychain backend uses the OS keychain service name `oc-codex-multi-auth`. The global pool is stored under the account key `accounts:global`, and a project pool under `accounts:<project-storage-key>`. Migrating a JSON pool into the keychain renames the original file to `<file>.migrated-to-keychain.<timestamp>` and keeps it as the rollback artifact.

OAuth refresh uses a **second, independent** lease on `<storage>.refresh.lock`. That split is deliberate. The refresh lease serializes the provider exchange across processes, because refresh tokens are single-use and two concurrent exchanges of the same token would leave one process with `refresh_token_reused`. The storage lease is only ever held for a local read or write. A refresh therefore opens two short storage transactions (an authoritative reload that either adopts a rotation another process already committed or reports the current token, then a durable commit) with the multi-second network round trip sitting *between* them rather than inside either. Unrelated writers (`codex-note`, `codex-tag`, account toggles, rotation stamps, TUI quota writes) never queue behind a network call. The two leases use distinct lock targets, because `proper-lockfile` keys its in-process registry by target path and would otherwise corrupt that registry when one lease nests inside the other.

This guarantee is intentionally local-filesystem/same-host. A process that exits after the provider accepts a refresh token but before the replacement token is committed still requires reauthentication, and cross-host or unreliable network filesystems require an external coordinator.

| State | Default path |
| --- | --- |
| OpenCode config | `~/.config/opencode/opencode.json` |
| OpenCode TUI config | `~/.config/opencode/tui.json` |
| OpenCode auth tokens | `~/.opencode/auth/openai.json` (convention reference in docs; no plugin code reads this path) |
| OpenCode host auth store | `~/.local/share/opencode/auth.json`, read and backfilled from the account pool by `backfillHostOpenAIAuthFromPool` |
| Plugin config | `~/.opencode/openai-codex-auth-config.json` |
| Global account pool | `~/.opencode/oc-codex-multi-auth-accounts.json` |
| Project account pool | `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` |
| Flagged accounts | `~/.opencode/projects/<project-key>/oc-codex-multi-auth-flagged-accounts.json` when `perProjectAccounts` is on (default), else `~/.opencode/oc-codex-multi-auth-flagged-accounts.json` |
| TUI quota cache | OpenCode state path (`api.state.path.state`), then `$OPENCODE_STATE_DIR`, then `~/.local/state/opencode/oc-codex-multi-auth-tui-quota.json` |
| Logs | `~/.opencode/logs/codex-plugin/` |

---

## Design Constraints

- OpenCode remains the host runtime and provider loader.
- Package exports: `"."` (provider plugin) and `"./tui"` (TUI quota plugin).
- The canonical package/plugin name is `oc-codex-multi-auth` (legacy npm name `oc-chatgpt-multi-auth` is migration-only).
- Node engines: `>=18`.
- OAuth callback port remains `1455`; callback path is `/auth/callback`.
- ChatGPT-backed Codex requests require `store: false`, `stream: true`, and `reasoning.encrypted_content`. Legacy transformation mode (`transformRequestBody`) enforces all three unconditionally. Native mode carries `store: false` and `reasoning.encrypted_content` through the shipped config templates and `stream` through the host payload.
- Multi-turn continuity depends on `reasoning.encrypted_content` and the host-supplied conversation history.
- Account pool limits: max **20** accounts; auth-failure cooldown **30s**; disable (retain credentials) after **3** consecutive auth failures.
- Account bootstrap can hydrate from Codex CLI storage under `~/.codex` unless `CODEX_AUTH_SYNC_CODEX_CLI=0`.
- Auth methods exposed to OpenCode are the four OAuth labels only (default browser, open URL manually, device code, manual URL paste). There is no registered API-key login method.
- Credentials and account metadata stay local unless the user exports or migrates them.
- Diagnostic commands redact sensitive account/token details by default.
- The optional keychain backend must fall back without deleting JSON credentials silently.
- When `sessionRecovery` is enabled, the request path detects recoverable errors and shows a recovery toast in the current plugin runtime. The full message/part rewriting and auto-resume engine in `lib/recovery/hook.ts` exists but is not hooked into host event streams or request handlers.
- The shutdown handler registers cleanup on SIGINT, SIGTERM, and beforeExit. Running inside the OpenCode host it drains cleanup without terminating the process. The standalone CLI opts in and exits 130 on SIGINT and 143 on SIGTERM.

---

## Related

- [getting-started.md](getting-started.md)
- [tools-and-cli.md](tools-and-cli.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [privacy.md](privacy.md)
- [development/ARCHITECTURE.md](development/ARCHITECTURE.md)
- [development/GITHUB_DISCOVERABILITY.md](development/GITHUB_DISCOVERABILITY.md)

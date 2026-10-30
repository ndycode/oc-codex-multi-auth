# oc-codex-multi-auth Architecture

Public overview of how the plugin installs config, handles ChatGPT Plus/Pro OAuth, routes Codex/GPT-5 requests, rotates local account pools, exposes diagnostics, and publishes TUI quota status.

---

## The Short Version

- `oc-codex-multi-auth` is an OpenCode plugin. Its npm bin is an installer plus a small standalone CLI, not a replacement for OpenCode.
- OpenCode loads `dist/index.js` as the provider plugin (built from `index.ts`) and `dist/tui.js` as the TUI quota-status plugin (built from `tui.ts`). On OpenCode 2.0.16+, the same default exports also carry a V2 `setup` hook (`lib/opencode-v2*.ts`) that reuses the shared V1 runtime.
- The plugin registers **25** `codex-*` tools via **25 per-file factories** under `lib/tools/` (`codex-list`, `codex-switch`, `codex-warm`, and 22 others).
- Requests to the ChatGPT-backed Codex API stay stateless: `store: false`, `stream: true`, and `reasoning.encrypted_content`.
- GPT-6 Astra/Sol/Luna, the Daybreak tiers, and GPT-5.6 use the responses-lite request shape; other models keep the classic shape.
- Account, config, backup, log, and quota state stays local under `~/.opencode` and `~/.config/opencode`. Per-project account pools are on by default.

---

## Data Flow

```text
opencode auth login                npx -y oc-codex-multi-auth@latest
  | OAuth (port 1455 callback)       | writes opencode.json / tui.json,
  v                                  | model catalog, cache cleanup
~/.opencode account pool (V3)  <-----+
  |
  | OpenCode prompt -> provider fetch
  v
index.ts
  |- resolve config (file + env overrides)
  |- pick account: modelAccountPools -> rotationStrategy (hybrid default)
  |- refresh token if needed (queued, cross-process lease)
  |- shape body: native or legacy mode; responses-lite for GPT-6/5.6/Daybreak
  |- attach OAuth headers + client identity
  |- retry budgets, circuit breaker, rate-limit backoff, fallback chains
  v
chatgpt.com/backend-api/codex/responses  (or an explicitly trusted gateway)
  |
  |- SSE folded into a response; quota headers update the TUI cache
  v
tui.ts renders prompt quota status; codex-* tools expose the same state
```

---

## Components

### Installer and standalone CLI

`oc-codex-multi-auth` → `scripts/install-oc-codex-multi-auth.js` (delegates to `scripts/install-oc-codex-multi-auth-core.js`).

| Flag | Config written |
| --- | --- |
| (default) / `--plugin-only` | Register plugin entries; preserve `provider.openai` |
| `--v2` | V2 `plugins` entry only (refuses `opencode.jsonc` or V1 `plugin` entries) |
| `--modern` | Compact modern template: 12 base model families + variant picker (65 variants) |
| `--full` | Modern bases **plus** 65 explicit selector IDs |
| `--legacy` | Explicit-only template (65 entries) |

Standalone commands (no agent loop): `doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm`. See [tools-and-cli.md](tools-and-cli.md).

### Provider plugin (`index.ts`)

Owns the auth loader, account manager lifecycle, the custom fetch pipeline, runtime metrics, and `ToolContext` construction for the tool registry. `PluginInput.directory` (falling back to `worktree`) binds per-project storage to the project OpenCode was launched in.

Auth methods exposed to OpenCode are the **four OAuth labels only**: default browser, open URL manually, device code, and manual URL paste. There is no API-key login. All four land in the same account pool; the manual URL paste requires the full callback URL because its `state` parameter binds the pasted value to the login attempt.

### Request pipeline

- URL rewrite to `chatgpt.com/backend-api/codex/responses` by default. `OPENAI_BASE_URL` is honored only when `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` explicitly trusts a gateway, and the check is fail-closed: HTTPS required for remote hosts, literal loopback IPs (`127.0.0.0/8`, `::1`) are the only HTTP targets, credentials/query/fragments and redirects are rejected. A rejected value fails loudly with a `[oc-codex-multi-auth]`-prefixed error.
- **Native mode** (default) preserves the host payload shape, normalizes the model name, and upserts one `## Backend Model Identity` developer message naming the outgoing model. `store: false` and `reasoning.encrypted_content` ride in via the shipped config templates. **Legacy mode** (`lib/request/request-transformer.ts`) applies compatibility rewrites and sets all three invariants unconditionally.
- **Responses-lite** reshapes the body for `gpt-6.1-sol`/`gpt-6.1-terra`/`gpt-6-astra`/`gpt-6-sol`/`gpt-6-luna`, the Daybreak tiers, and `gpt-5.6-*`: tool definitions move into `input` as `additional_tools`, instructions become a developer message, top-level `tools` is omitted, and `x-openai-internal-codex-responses-lite: true` is sent. The reshape applies per attempt against the model actually sent, so a fallback to a classic model re-serializes correctly.
- **Client identity** defaults to `opencode` for responses-lite models and `codex_cli_rs` otherwise; override with `CODEX_AUTH_CLIENT_IDENTITY`.
- **Auto-fallback** covers preview entitlement gates: GPT-6 Astra/6.1 Sol/Sol/Luna chains down through the GPT-5.6 tiers to `gpt-5.6-luna` (opt out with `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1`), GPT-5.6 chains to `gpt-5.5`/`gpt-6-luna`/`gpt-5.6-luna` (`CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`), and the Daybreak cyber tiers have no chain — they fail loudly. `unsupportedCodexPolicy: "fallback"` enables broader chains; a single request hops at most `MAX_QUOTA_FALLBACK_SWITCHES` (7) models.
- `lib/request/response-handler.ts` folds SSE events into one response as lines arrive, guards stream stalls, and detects empty responses for the retry loop.

### Account rotation and pools

`rotationStrategy` (default `hybrid`):

| Strategy | Behavior |
| --- | --- |
| `hybrid` | Keep the current account while selectable; else pick the best `health*2 + tokens*5 + hoursSinceUsed*2.0` score, falling back to least-recently-used when all are blocked |
| `sticky` | Drain one account until limited, then move to the lowest-indexed available account |
| `round-robin` | Advance through accounts in order |

`modelAccountPools` maps model IDs to stable account or Business-seat identities; `modelAccountPoolModes` selects `preferred` (default, falls back to the general pool) or `strict` (never leaves the pool). Manage with `codex-pool` or `~/.opencode/openai-codex-auth-config.json`.

### Tool registry

`lib/tools/index.ts` builds the tool map from **25 per-file factories** under `lib/tools/`; every registered `codex-*` tool is its own file. Groups: setup (`codex-setup`, `codex-help`, `codex-next`), daily account use (`codex-list`, `codex-switch`, `codex-warm`, `codex-status`, `codex-limits`, `codex-reset`), metadata and routing (`codex-label`, `codex-tag`, `codex-note`, `codex-pool`, `codex-enable`, `codex-remove`, `codex-refresh`), diagnostics (`codex-health`, `codex-metrics`, `codex-doctor`, `codex-diag`, `codex-diff`), backup/secrets (`codex-export`, `codex-import`, `codex-keychain`), and the interactive `codex-dashboard`. Full catalog: [tools-and-cli.md](tools-and-cli.md).

### TUI quota plugin (`tui.ts`)

Reads the active account, the shared quota cache (`lib/tui-quota-cache.ts`), and usage endpoints to render a compact prompt status line during sessions, plus a `codex.quota.details` command. `quotaStatus.mode` selects `active`, `overview`, or `resets` screens (or a list to rotate). The request path writes quota snapshots from response headers so the line reflects the account that actually served the last request.

### OpenCode V2 adapter

On OpenCode 2.0.16+, the default exports' `setup` hooks delegate to `lib/opencode-v2.ts` / `lib/opencode-v2-tui.ts`, which reuse the same V1 runtime factory — one account pool, one request pipeline, two loader contracts.

- `lib/opencode-v2.ts` re-registers the OAuth methods on the `openai` integration, re-points the provider and models at a distinct `aisdk:` package identity (`lib/opencode-v2-provider.ts`), installs `sdk`/`language` hooks that re-apply `store: false` and `reasoning.encrypted_content` and strip server-side conversation references, bridges the `codex-*` tools through `tool.transform`, and registers `CodexStatusRpc` (`lib/opencode-v2-rpc.ts` + `lib/opencode-v2-status.ts`) so remote TUIs need no credentials.
- `lib/opencode-v2-tui.ts` owns the terminal surface: app poller, `prompt.footer.status`, `sidebar.content`, the `codex.quota.details` / `codex.accounts` palette commands, and `/codex-accounts`.
- Each registered location runs in its own `createStorageScope()`, and the adapter stays inert until a pooled account or `openai` OAuth connection exists.
- Install with `npx -y oc-codex-multi-auth@latest --v2`.

### Storage

V3 JSON account files with atomic writes, V1→V3 migration on load, per-project path resolution, import/export with dry-run preview, flagged-account recovery, and credential snapshots under `backups/codex-credential-snapshot-*.json`. V2-format files are rejected with `UNKNOWN_V2_FORMAT`; versions above 3 with `UNSUPPORTED_SCHEMA_VERSION`. Mutations run under a process mutex plus a `proper-lockfile` lease on `<storage>.transaction.lock`; OAuth refresh uses a second lease on `<storage>.refresh.lock` because refresh tokens are single-use. These guarantees are local-filesystem/same-host only.

The optional keychain backend (`CODEX_KEYCHAIN=1`) stores pools under service `oc-codex-multi-auth` with keys `accounts:global` / `accounts:<project-storage-key>`; migrating renames the JSON file to `<file>.migrated-to-keychain.<timestamp>` as the rollback artifact. On Windows, Credential Manager's blob-size cap means an oversized pool is size-checked before write and stays on the JSON path.

| State | Default path |
| --- | --- |
| OpenCode config | `~/.config/opencode/opencode.json` |
| OpenCode TUI config | `~/.config/opencode/tui.json` |
| OpenCode host auth store | `~/.local/share/opencode/auth.json` (backfilled from the pool) |
| Plugin config | `~/.opencode/openai-codex-auth-config.json` |
| Global account pool | `~/.opencode/oc-codex-multi-auth-accounts.json` |
| Project account pool | `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` |
| Flagged accounts | `oc-codex-multi-auth-flagged-accounts.json` beside the active pool file |
| TUI quota cache | OpenCode state path, else `$OPENCODE_STATE_DIR`, else `~/.local/state/opencode/` |
| Logs | `~/.opencode/logs/codex-plugin/` |

---

## Design Constraints

- Canonical package/plugin name: `oc-codex-multi-auth` (`oc-chatgpt-multi-auth` is migration-only). Exports `"."` (provider) and `"./tui"` (quota status); both default exports satisfy the V1 contract (OpenCode 1.18.29+) and the V2 `setup` contract (2.0.16+).
- Node `>=22.19.0`, ESM only.
- OAuth callback is `http://localhost:1455/auth/callback` on both `127.0.0.1` and `::1`.
- ChatGPT-backed Codex requests require `store: false`, `stream: true`, `reasoning.encrypted_content`. Multi-turn continuity depends on `reasoning.encrypted_content` plus the host-supplied history.
- Account pool limits: max 20 accounts, 30s auth-failure cooldown, disable (credentials retained) after 3 consecutive auth failures.
- Codex CLI hydration from `~/.codex` is on unless `CODEX_AUTH_SYNC_CODEX_CLI=0`.
- Credentials stay local unless the user exports or migrates them; diagnostics redact tokens and emails by default; keychain fallback never silently deletes JSON credentials.
- When `sessionRecovery` is enabled the request path classifies recoverable errors and shows a recovery toast. The message/part rewriting and auto-resume engine in `lib/recovery/hook.ts` exists but is not invoked by request handlers or host event streams.
- Shutdown handlers drain cleanup on SIGINT/SIGTERM/beforeExit; as a host plugin the process is not the package's to terminate (the standalone CLI opts in and exits 130/143).

---

## Related

- [getting-started.md](getting-started.md)
- [tools-and-cli.md](tools-and-cli.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [privacy.md](privacy.md)
- [development/ARCHITECTURE.md](development/ARCHITECTURE.md)

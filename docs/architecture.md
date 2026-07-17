# oc-codex-multi-auth Architecture

Public overview of how `oc-codex-multi-auth` v6.9.1 installs config, handles ChatGPT Plus/Pro OAuth, routes Codex/GPT-5 requests, rotates local account pools, exposes diagnostics, and publishes TUI quota status.

---

## The Short Version

`oc-codex-multi-auth` is an OpenCode plugin for ChatGPT OAuth-backed Codex and GPT-5 workflows.

- The `oc-codex-multi-auth` npm bin is an installer and a small standalone CLI, not a replacement for OpenCode.
- OpenCode loads `dist/index.js` as the provider plugin entry.
- The plugin registers **24** `codex-*` tools via **24 per-file factories** under `lib/tools/` (`codex-list`, `codex-switch`, `codex-warm`, and 21 others).
- OpenCode loads `dist/tui.js` as the TUI plugin for active-session quota status.
- Request handling stays stateless for the ChatGPT-backed Codex API by enforcing `store: false` and preserving `reasoning.encrypted_content`.
- GPT-5.6 tiers use the responses-lite request path; pre-5.6 models keep the classic shape.
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
| (default) / `--modern` | Compact modern: 12 base model families + variant picker (53 variants total) |
| `--full` | Compact modern bases **plus** explicit legacy selector IDs |
| `--legacy` | Explicit-only catalog (53 model entries) |

Standalone read/ops commands (no OpenCode agent loop required): `doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm`. See [tools-and-cli.md](tools-and-cli.md).

### 2. OpenCode plugin entry

`index.ts` is the runtime entry OpenCode loads. It owns:

- OAuth login modes: browser callback, device code, and manual URL paste
- account manager lifecycle and local account storage (V3)
- request URL/body/header transformation (native or legacy, plus responses-lite for GPT-5.6)
- health-aware account selection, `rotationStrategy`, and `modelAccountPools`
- retry budgets, circuit breaking, rate-limit backoff, and failover
- session recovery hooks and beginner-safe next-action guidance
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
  |- rewrite OpenAI SDK URL to chatgpt.com/backend-api/codex/responses
  |- shape body for native or legacy transform mode
  |- for GPT-5.6: apply responses-lite reshape (per attempt)
  |- force stream:true, store:false, reasoning.encrypted_content
  |- select/refresh a healthy account (pools + rotationStrategy)
  |- attach OAuth headers + client identity (originator / User-Agent)
  |- handle SSE, errors, retries, fallback, and metrics
  v
ChatGPT-backed Codex endpoint
```

**Native mode** keeps the host payload shape whenever possible. **Legacy mode** applies compatibility rewrites for older OpenCode/AI SDK behavior, including filtering unsupported `item_reference` payloads and stripping IDs that cannot be used with `store: false`.

**Responses-lite (GPT-5.6 only):** for `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, the plugin reshapes the request the way Codex does: tool definitions move into `input` as a leading `additional_tools` developer item, Codex instructions follow as a developer message, top-level `instructions` is emptied, `tools` is omitted, `parallel_tool_calls` is forced off, image `detail` fields are stripped, and `x-openai-internal-codex-responses-lite: true` is sent. Lite reshape is applied per request attempt against the model actually being sent, so a sol → gpt-5.5 fallback re-serializes into the classic shape and keeps its tools.

**Client identity:** by default GPT-5.6 uses the host/opencode identity (`originator: opencode` with an `opencode/...` User-Agent). Other families default to the Codex CLI identity. Override with `CODEX_AUTH_CLIENT_IDENTITY`.

**Auto-fallback (preview entitlement gates):**

- GPT-5.6: `gpt-5.6-sol` → `gpt-5.6-terra` → `gpt-5.6-luna` → `gpt-5.5` (disable with `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`)
- GPT-5.5 / canonical Codex also have default auto-fallback through the GPT-5.4 family; broader fallback chains require `unsupportedCodexPolicy: "fallback"`.

### 4. Account rotation and model pools

`rotationStrategy` (`hybrid` | `sticky` | `round-robin`, default `hybrid`) selects how the plugin load-balances across healthy accounts:

| Strategy | Behavior |
| --- | --- |
| `hybrid` (default) | Stay on the current account while healthy; otherwise score-select the next |
| `sticky` | Drain one account until rate-limited/cooling, then move to the lowest-indexed available account |
| `round-robin` | Advance through accounts in order |

`modelAccountPools` maps effective model IDs to preferred stable account IDs. While a preferred pool has a healthy selectable account, selection stays inside that pool (still applying quota, cooldown, and token-health rules). If the preferred pool is empty or exhausted, routing falls back to the general pool. Manage pools with `codex-pool` or edit `~/.opencode/openai-codex-auth-config.json`.

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

The storage layer uses V3 account files with migrations from older formats, atomic writes, keychain opt-in, import/export previews, flagged-account recovery, and per-project path resolution.

| State | Default path |
| --- | --- |
| OpenCode config | `~/.config/opencode/opencode.json` |
| OpenCode TUI config | `~/.config/opencode/tui.json` |
| OpenCode auth tokens | `~/.opencode/auth/openai.json` |
| Plugin config | `~/.opencode/openai-codex-auth-config.json` |
| Global account pool | `~/.opencode/oc-codex-multi-auth-accounts.json` |
| Project account pool | `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` |
| Flagged accounts | `~/.opencode/oc-codex-multi-auth-flagged-accounts.json` |
| TUI quota cache | OpenCode state path plus `~/.opencode/oc-codex-multi-auth-tui-quota.json` fallback |
| Logs | `~/.opencode/logs/codex-plugin/` |

---

## Design Constraints

- OpenCode remains the host runtime and provider loader.
- Package exports: `"."` (provider plugin) and `"./tui"` (TUI quota plugin).
- The canonical package/plugin name is `oc-codex-multi-auth` (legacy npm name `oc-chatgpt-multi-auth` is migration-only).
- Node engines: `>=18`.
- OAuth callback port remains `1455`; callback path is `/auth/callback`.
- ChatGPT-backed Codex requests require `store: false`.
- Multi-turn continuity depends on `reasoning.encrypted_content` and the host-supplied conversation history.
- Account pool limits: max **20** accounts; auth-failure cooldown **30s**; auto-removal after **3** consecutive auth failures.
- Account bootstrap can hydrate from Codex CLI storage under `~/.codex` unless `CODEX_AUTH_SYNC_CODEX_CLI=0`.
- Auth methods exposed to OpenCode are the three OAuth labels only (browser, device code, manual URL). There is no registered API-key login method.
- Credentials and account metadata stay local unless the user exports or migrates them.
- Diagnostic commands redact sensitive account/token details by default.
- The optional keychain backend must fall back without deleting JSON credentials silently.
- Session recovery rewrites OpenCode message/part files under the host storage root (`$XDG_DATA_HOME/opencode/storage` or platform equivalent) when `sessionRecovery` is enabled.

---

## Related

- [getting-started.md](getting-started.md)
- [tools-and-cli.md](tools-and-cli.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [privacy.md](privacy.md)
- [development/ARCHITECTURE.md](development/ARCHITECTURE.md)
- [development/GITHUB_DISCOVERABILITY.md](development/GITHUB_DISCOVERABILITY.md)

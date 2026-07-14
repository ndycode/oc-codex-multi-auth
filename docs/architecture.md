# oc-codex-multi-auth Architecture

Public overview of how the `oc-codex-multi-auth` OpenCode plugin installs config, handles ChatGPT Plus/Pro OAuth, routes Codex/GPT-5 requests, rotates local account pools, exposes diagnostics, and publishes TUI quota status.

---

## The Short Version

`oc-codex-multi-auth` is an OpenCode plugin for ChatGPT OAuth-backed Codex and GPT-5 workflows.

- The `oc-codex-multi-auth` npm bin is an installer, not a replacement for OpenCode.
- OpenCode loads `dist/index.js` as the provider plugin entry.
- The plugin registers 21 `codex-*` tools for setup, account switching, health checks, diagnostics, backup, keychain, and recovery.
- OpenCode loads `dist/tui.js` as the TUI plugin for active-session quota status.
- Request handling stays stateless for the ChatGPT-backed Codex API by enforcing `store: false` and preserving `reasoning.encrypted_content`.
- Account, config, backup, log, and TUI quota state lives under `~/.opencode` and `~/.config/opencode`.
- Per-project account pools are enabled by default under `~/.opencode/projects/<project-key>/...`.

---

## Main Components

### 1. Installer surface

`package.json` publishes one command:

- `oc-codex-multi-auth` -> `scripts/install-oc-codex-multi-auth.js`

The installer updates OpenCode config, backs up previous files, normalizes stale plugin entries from older package names, enables the TUI status plugin, writes compact or full model templates, and clears OpenCode's cached package copy so the next OpenCode start uses the latest plugin.

### 2. OpenCode plugin entry

`index.ts` is the runtime entry OpenCode loads. It owns:

- OAuth login modes: browser callback, device code, and manual URL paste
- account manager lifecycle and local account storage
- request URL/body/header transformation
- health-aware account selection and workspace-aware routing
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
  |- rewrite OpenAI SDK URL to Codex/ChatGPT backend
  |- shape body for native or legacy transform mode
  |- force stream:true, store:false, reasoning.encrypted_content
  |- select/refresh a healthy account
  |- attach OAuth headers
  |- handle SSE, errors, retries, fallback, and metrics
  v
ChatGPT-backed Codex endpoint
```

Native mode keeps the host payload shape whenever possible. Legacy mode applies compatibility rewrites for older OpenCode/AI SDK behavior, including filtering unsupported `item_reference` payloads and stripping IDs that cannot be used with `store: false`.

### 4. Tool registry

`lib/tools/index.ts` builds the OpenCode tool map from 21 per-file factories under `lib/tools/`.

Common groups:

- setup: `codex-setup`, `codex-help`, `codex-next`
- daily account use: `codex-list`, `codex-switch`, `codex-status`, `codex-limits`, `codex-reset`
- account metadata: `codex-label`, `codex-tag`, `codex-note`, `codex-remove`, `codex-refresh`
- diagnostics and resilience: `codex-health`, `codex-metrics`, `codex-doctor`, `codex-diag`, `codex-diff`
- backup and secrets: `codex-export`, `codex-import`, `codex-keychain`
- interactive surface: `codex-dashboard`

### 5. TUI quota status plugin

`tui.ts` exposes an OpenCode TUI plugin that reads the active account, shared quota cache, and direct usage endpoints when available. It shows compact prompt status during sessions and provides a quota details command without polluting the home prompt.

### 6. Storage and sync

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
| Logs | `~/.opencode/logs/codex-plugin/` |

---

## Design Constraints

- OpenCode remains the host runtime and provider loader.
- The canonical package/plugin name is `oc-codex-multi-auth`.
- OAuth callback port remains `1455`.
- ChatGPT-backed Codex requests require `store: false`.
- Multi-turn continuity depends on `reasoning.encrypted_content` and the host-supplied conversation history.
- Credentials and account metadata stay local unless the user exports or migrates them.
- Diagnostic commands redact sensitive account/token details.
- The optional keychain backend must fall back without deleting JSON credentials silently.

---

## Related

- [getting-started.md](getting-started.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [privacy.md](privacy.md)
- [development/ARCHITECTURE.md](development/ARCHITECTURE.md)
- [development/GITHUB_DISCOVERABILITY.md](development/GITHUB_DISCOVERABILITY.md)

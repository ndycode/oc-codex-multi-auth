# Privacy & Data Handling

This page explains how `oc-codex-multi-auth` handles local data, upstream requests, and debugging artifacts.

**Last updated:** 2026-07-18

## Overview

This plugin prioritizes local control and transparency. It does not ship product telemetry or analytics to third parties. Network traffic is limited to the OpenAI/ChatGPT auth and API endpoints you are actively using, optional Codex instruction/catalog fetches from GitHub, and an optional daily npm version check when auto-update is enabled.

> [!CAUTION]
> This plugin is for personal development use with your own ChatGPT Plus/Pro subscription. You are responsible for your prompts, exports, and OpenAI policy compliance.

---

## What We Collect

**No first-party telemetry.** This plugin does not send usage analytics, crash reports, or account inventories to the package maintainers.

- No analytics product
- No usage tracking service
- No remote logging of prompts to maintainers

Local logs, caches, and config files on **your** machine are separate; see [Data Storage](#data-storage).

---

## Data Storage

All plugin state is stored **locally on your machine** unless you export it or opt into OS keychain storage.

### Account storage (V3)

| Item | Default path |
|------|----------------|
| Global account pool | `~/.opencode/oc-codex-multi-auth-accounts.json` |
| Per-project account pool | `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` |
| Flagged accounts | `~/.opencode/oc-codex-multi-auth-flagged-accounts.json` |

Contents typically include OAuth access/refresh material, account IDs, labels/tags/notes, rate-limit reset metadata, and rotation state. Per-project pools are enabled by default (`perProjectAccounts: true`).

### Codex CLI hydrate (optional source)

On startup the plugin may also read Codex CLI account material under `~/.codex` (for example `accounts.json`) to help bootstrap the local pool. Disable with `CODEX_AUTH_SYNC_CODEX_CLI=0`. This is local filesystem access only; nothing is uploaded to the package maintainers.

### Legacy account filenames (migration only)

Older installs may still have migration sources under `~/.opencode/` or a project tree:

| Legacy file | Role |
|-------------|------|
| `openai-codex-accounts.json` | Pre-rename account pool seed |
| `openai-codex-flagged-accounts.json` | Pre-rename flagged metadata |
| `openai-codex-blocked-accounts.json` | Older blocked-account list (migrated into flagged handling) |
| `<project>/.opencode/openai-codex-accounts.json` | In-repo legacy pool (read for migration; current pools live under `~/.opencode/projects/…`) |

Current canonical names use the `oc-codex-multi-auth-*.json` prefix. Do not hand-edit legacy files unless you are recovering an old backup.

### Plugin configuration

| Item | Default path |
|------|----------------|
| Plugin config | `~/.opencode/openai-codex-auth-config.json` |

Includes runtime options such as retry profile, rotation strategy, model account pools, TUI preferences, and beginner-safe mode.

### OpenCode host files

| Item | Default path |
|------|----------------|
| OpenCode config | `~/.config/opencode/opencode.json` |
| OpenCode TUI config | `~/.config/opencode/tui.json` |
| OpenCode auth tokens | `~/.opencode/auth/openai.json` |

### Optional OS keychain

When `CODEX_KEYCHAIN=1` is set, account pools can be stored in the OS credential store (macOS Keychain, Windows Credential Manager, Linux libsecret) under service name `oc-codex-multi-auth`. JSON files may be renamed with a `.migrated-to-keychain.<timestamp>` suffix for rollback. Keychain failures fall back to JSON without silently deleting credentials.

### TUI quota cache

| Item | Default path |
|------|----------------|
| TUI quota cache | `$OPENCODE_STATE_DIR` when set, otherwise OpenCode's state directory (typically `~/.local/state/opencode/`), file `oc-codex-multi-auth-tui-quota.json`, with a `~/.opencode/` fallback in some builds |

Caches recent quota/usage snapshots for prompt status display.

### Session recovery storage (host OpenCode)

When `sessionRecovery` is enabled (default), recoverable session repairs read/write OpenCode's on-disk message/part store:

| Item | Default path |
|------|----------------|
| OpenCode storage root | `$XDG_DATA_HOME/opencode/storage` (macOS/Linux default `~/.local/share/opencode/storage`; Windows `%APPDATA%/opencode/storage`) |
| Messages | `…/message/{sessionID}/…` |
| Parts | `…/part/{messageID}/*.json` |

Only known structural recovery cases are patched (missing tool results, thinking-block order, thinking-disabled violations). Tokens are not written here.

### Catalog and instruction caches

| Item | Default path |
|------|----------------|
| Cache directory | `~/.opencode/cache/` |

May include Codex system instructions, catalog-derived instruction files, ETag/meta files, and the auto-update check cache (`update-check-cache.json`).

### Debug logs

| Item | Default path |
|------|----------------|
| Request logs | `~/.opencode/logs/codex-plugin/` |

Written only when request logging is enabled (`ENABLE_PLUGIN_REQUEST_LOGGING=1`). Metadata logs omit raw bodies by default; set `CODEX_PLUGIN_LOG_BODIES=1` only when you need raw request/response payloads (sensitive: may include prompts and model output).

### Backups and exports

Export/import and installer backups may create files under `~/.opencode/backups/` or project-scoped backup directories. Treat exports as credential-bearing data.

---

## Data Transmission

### Direct to OpenAI / ChatGPT

API and auth traffic go **directly from your machine** to OpenAI/ChatGPT endpoints over HTTPS. There is no maintainer proxy.

| Service | Endpoint family |
|---------|-----------------|
| OAuth authorize / token | `https://auth.openai.com/...` (e.g. `/oauth/authorize`, `/oauth/token`) |
| Codex API | `https://chatgpt.com/backend-api/codex/responses` |
| Usage / quota helpers | related `chatgpt.com/backend-api` paths used for usage windows |

### What gets sent on a normal model request

When you use the plugin, a request can include:

- Your prompts and conversation history (as supplied by OpenCode)
- OAuth access token (for authentication)
- ChatGPT account/workspace identifiers used for routing
- Model selection, reasoning effort, verbosity, and related options
- **Client identity headers**: `originator` and a product `User-Agent` (Codex CLI style or host/opencode style, depending on model and config). These **are** sent; they are not suppressed by default.
- For GPT-5.6: responses-lite markers such as `x-openai-internal-codex-responses-lite`

This is analogous to what official Codex-style clients send when talking to the same backend. Exact fields vary by model family and transform mode.

### What does not get sent to maintainers

- No automatic upload of account lists, tokens, or logs to the plugin authors
- No remote analytics endpoint for this package

### Optional npm auto-update check

When `autoUpdate` is enabled (default `true`; disable with `autoUpdate: false` or `CODEX_AUTH_AUTO_UPDATE=0`), the plugin may query the public npm registry (`registry.npmjs.org/oc-codex-multi-auth/latest`) about once per day to detect a newer version, cache the result under `~/.opencode/cache/`, and clear the OpenCode-managed plugin cache so a restart can pick up the update. That request does not send your ChatGPT tokens or prompts.

---

## Third-Party Services

### GitHub API

The plugin may fetch Codex instructions / model catalog material from GitHub (for example release metadata under `openai/codex`) with local caching and ETag reuse. Requests are ordinary HTTPS GETs without your ChatGPT credentials.

### OpenAI Services

All auth and inference go through OpenAI/ChatGPT as listed above. See [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/) for how OpenAI handles data.

---

## Your Data Rights

You have complete control over local data:

### Delete OAuth Tokens

```bash
opencode auth logout
# Or manually:
rm ~/.opencode/auth/openai.json
```

### Delete Account Pools and Flagged State

```bash
rm ~/.opencode/oc-codex-multi-auth-accounts.json
rm ~/.opencode/oc-codex-multi-auth-flagged-accounts.json
rm -rf ~/.opencode/projects/
```

Also remove any project-scoped account files and keychain entries if you migrated with `CODEX_KEYCHAIN=1` (see `codex-keychain`).

### Delete Plugin Config, Caches, Logs, Quota Cache

```bash
rm ~/.opencode/openai-codex-auth-config.json
rm -rf ~/.opencode/cache/
rm -rf ~/.opencode/logs/codex-plugin/
rm -f ~/.opencode/oc-codex-multi-auth-tui-quota.json
```

### Revoke OAuth Access

1. Visit [ChatGPT Settings → Authorized Apps](https://chatgpt.com/settings/apps)
2. Find the app entry used for login (OpenCode / Codex-related)
3. Click Revoke

This invalidates access tokens for that authorization.

---

## Security Measures

### Token Protection

- Tokens stay local except when sent to OpenAI/ChatGPT for authentication and API calls
- Auth and account files should remain user-readable only where the OS allows
- Diagnostic tools redact tokens and sensitive identifiers by default
- Expired tokens are refreshed automatically; refresh is queued to avoid races

### PKCE Flow

The plugin uses **PKCE** for the browser OAuth flow (same class of flow used by official Codex CLI login).

### HTTPS Encryption

OAuth, token refresh, and API requests use HTTPS.

### Email Masking in Account Displays

Account emails can appear in screenshots or shared TUI sessions. To reduce exposure:

- Set a non-identifying label with `codex-label` (labels are preferred over emails)
- Enable `maskEmail` in `~/.opencode/openai-codex-auth-config.json` (or `CODEX_TUI_MASK_EMAIL=1`) so remaining emails render as forms like `us***@example.com`
- Raw emails appear in `--includeSensitive` / `includeSensitive` JSON output only when you opt in

---

## Compliance

### OpenAI Policies

When using this plugin, you are subject to:

- [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/)
- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/)

Your responsibility: ensure usage complies with OpenAI's policies and your subscription terms.

### Local Data Control

This plugin:

- Does not operate a maintainer-side personal data processing service
- Stores operational state locally under your control
- Provides deletion steps for local files and OAuth revocation

Data sent to OpenAI remains subject to OpenAI's practices.

---

## Transparency

### Open Source

Source: [https://github.com/ndycode/oc-codex-multi-auth](https://github.com/ndycode/oc-codex-multi-auth)

You can review request shaping, storage, and logging behavior in the repository.

### No Hidden Telemetry Product

There is no separate analytics backend for this package. Documented network calls are OAuth/API, optional GitHub catalog fetches, and optional npm version checks.

---

## Questions?

- **Plugin-specific:** [GitHub Issues](https://github.com/ndycode/oc-codex-multi-auth/issues)
- **OpenAI data handling:** [OpenAI Support](https://help.openai.com/)
- **Security concerns:** [SECURITY.md](../SECURITY.md)

---

**Back to:** [Documentation Home](index.md) | [Getting Started](getting-started.md) | [Tools and CLI](tools-and-cli.md)

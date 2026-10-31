# Privacy & Data Handling

How `oc-codex-multi-auth` handles local data, upstream requests, and debugging artifacts — verified against the current source.

> [!CAUTION]
> This plugin is for personal development use with your own ChatGPT Plus/Pro subscription. You are responsible for your prompts, exports, and OpenAI policy compliance.

## What we collect

**No first-party telemetry.** No analytics product, no usage tracking, no crash reports, and no endpoint that uploads account data to the package maintainers. The only network calls are the ones enumerated below, all of which you initiate or configure.

## Network endpoints

All traffic is HTTPS, direct from your machine — there is no maintainer proxy.

| Endpoint | Used for | Credentials? |
| --- | --- | --- |
| `https://auth.openai.com/oauth/authorize` | Browser OAuth (PKCE) — opened in your browser | — |
| `https://auth.openai.com/oauth/token` | Code exchange + token refresh (`lib/auth/auth.ts`) | OAuth code / refresh token |
| `https://auth.openai.com/api/accounts/deviceauth/usercode` | Device-code login: request a user code | OAuth `client_id` (public) |
| `https://auth.openai.com/api/accounts/deviceauth/token` | Device-code login: poll for authorization | `device_auth_id` + `user_code` |
| `https://auth.openai.com/codex/device` | Device-code verification page — opened in your browser | — |
| `https://auth.openai.com/deviceauth/callback` | Device-flow OAuth redirect URI | — |
| `https://chatgpt.com/backend-api/codex/responses` | Model requests (`CODEX_BASE_URL` in `lib/constants.ts`) | Bearer token + `chatgpt-account-id` |
| `https://chatgpt.com/backend-api/wham/usage` | Quota windows for `codex-limits`, `limits`, TUI status, and the background poller | Bearer token + `chatgpt-account-id` |
| `https://chatgpt.com/backend-api/wham/accounts/check` | Business workspace names for `limits` output | Bearer token + `chatgpt-account-id` |
| `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` | `codex-reset` credit listing | Bearer token + `chatgpt-account-id` |
| `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume` | `codex-reset` redemption (explicit confirm) | Bearer token + `chatgpt-account-id` |
| `https://api.github.com/repos/openai/codex/releases/latest` (+ `https://github.com/openai/codex/releases/latest` HTML fallback) | Resolve the latest Codex CLI release tag | — |
| `https://raw.githubusercontent.com/openai/codex/<tag>/codex-rs/models-manager/models.json` | Model catalog / instructions for GPT-5.6+ models | — |
| `https://raw.githubusercontent.com/openai/codex/<tag>/codex-rs/core/<prompt>.md` | Per-family Codex prompt files (ETag cached) | — |
| `https://raw.githubusercontent.com/{sst,anomalyco}/opencode/{main,dev}/packages/opencode/src/session/prompt/codex.{txt,md}` | OpenCode bridge prompt (`OPENCODE_CODEX_PROMPT_URL` overrides the source list) | — |
| `https://registry.npmjs.org/oc-codex-multi-auth/latest` | Optional daily update check | — |

The `wham` endpoints are the same undocumented endpoints official Codex clients use; they are reached only from quota-facing surfaces, never on the model request path.

Two deliberate overrides can change where traffic goes:

- `OPENAI_BASE_URL` + `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` retargets the model-request base URL away from `chatgpt.com/backend-api` (off by default).
- `CODEX_AUTH_SYNC_CODEX_CLI=0` disables the local read of `~/.codex/accounts.json` used to hydrate the pool from Codex CLI (local filesystem only, never uploaded).

### What a model request sends

- Prompts and conversation history as supplied by OpenCode; `store: false` and `include: ["reasoning.encrypted_content"]` on every request.
- `Authorization: Bearer <access-token>`, `chatgpt-account-id`, `OpenAI-Beta: responses=experimental`, `accept: text/event-stream`.
- `originator` + `user-agent`: `codex_cli_rs/<version> (<os> <release>; <arch>)` for standard models, or `opencode/<version> (<platform> <release>; <arch>)` for responses-lite models (GPT-5.6, GPT-6, Daybreak). `CODEX_AUTH_CLIENT_IDENTITY=codex|opencode` forces one identity; `CODEX_AUTH_DISABLE_CODEX_USER_AGENT=1` suppresses the UA rewrite.
- `x-openai-internal-codex-responses-lite: true` on responses-lite models.
- `session-id` / `thread-id` (current Codex names) and `conversation_id` / `session_id` (legacy names) when a prompt-cache key is active.
- `x-codex-routing-hint: model=<id>[;tier=<tier>]` naming the model and service tier, and `x-codex-turn-state` replaying the backend's own sticky-routing token within a turn.
- `version: <codex client version>` only under the Codex CLI identity.
- `openai-organization` only when `CODEX_AUTH_SEND_ORGANIZATION_HEADER=1` (off by default).
- Any inbound `x-api-key` header is deleted, not forwarded.

### Background quota poller

`autoProtectCredits` (default **on**) and `quotaNotifications.enabled` (default off) drive an unattended poll of `/wham/usage` every `intervalMs` (default **30 min**, min 30 s). Each poll reads only quota windows for pooled accounts — no prompt content — so an exhausted account can be blocked before the next request instead of after a 429. Set `quotaNotifications.autoProtectCredits: false` (or `CODEX_AUTH_AUTO_PROTECT_CREDITS=0`) and leave notifications off to stop unattended polls; `codex-limits` and the TUI still fetch on demand.

### npm auto-update check

With `autoUpdate` on (default; off via `autoUpdate: false` or `CODEX_AUTH_AUTO_UPDATE=0`), the plugin GETs `registry.npmjs.org/oc-codex-multi-auth/latest` at most once per 24 h (cache: `~/.opencode/cache/update-check-cache.json`) and, when a newer version exists, clears the OpenCode-managed plugin cache so a restart picks it up. No tokens or prompts are sent.

## Local data storage

Everything below lives on your machine. Mode bits (`0o600`/`0o700`) are applied
**on POSIX only**; on Windows the files inherit the user profile's ACLs instead.

| Item | Path | Mode (POSIX) |
| --- | --- | --- |
| Global account pool | `~/.opencode/oc-codex-multi-auth-accounts.json` | file `0o600`, dir `0o700` |
| Per-project pool (default on) | `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` | `0o600` / `0o700` |
| Flagged (quarantined) accounts | `oc-codex-multi-auth-flagged-accounts.json` beside the active accounts file | `0o600` / `0o700` |
| Credential snapshots (pre-write backups) | `backups/codex-credential-snapshot-*.json` beside the active accounts file | `0o600` / `0o700` |
| Rotation journal | `<accounts-file>.refresh.pending.<hash>` (one per consumed token) beside the active accounts file — a refresh committed upstream but not yet saved to the pool | `0o600` / `0o700` |
| Storage locks | `<storage>.transaction.lock`, `<storage>.refresh.lock` beside the active accounts file | — |
| Plugin config | `~/.opencode/openai-codex-auth-config.json` | — |
| Quota notification state | `oc-codex-multi-auth-quota-notifications.json` beside the active accounts file | `0o600` / `0o700` |
| Plugin origin history | `~/.opencode/oc-codex-multi-auth-origin.json` | — |
| Prompt/catalog caches | `~/.opencode/cache/` (`catalog-*-instructions.md`, `*-meta.json`, `opencode-codex.txt`, `update-check-cache.json`) | — |
| TUI quota caches | `oc-codex-multi-auth-tui-quota.json`, `oc-codex-multi-auth-tui-quota-overview.json`, `oc-codex-multi-auth-workspace-names.json` under `$OPENCODE_STATE_DIR` or `~/.local/state/opencode` | `0o600` |
| Request logs (opt-in) | `~/.opencode/logs/codex-plugin/request-<n>-<stage>.json` | file `0o600`, dir `0o700` |
| OpenCode host files | `~/.config/opencode/opencode.json`, `~/.config/opencode/tui.json`, `$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share/opencode/auth.json`) | host-managed |
| OS keychain (opt-in) | `CODEX_KEYCHAIN=1` → OS credential store, service `oc-codex-multi-auth`; JSON renamed `*.migrated-to-keychain.<ts>` | OS-managed |

Account pools hold OAuth access/refresh tokens, account IDs, labels/tags/notes, rate-limit reset times, and rotation state. Legacy `openai-codex-*.json` files are read once for migration only.

**Windows keychain size limit.** Windows Credential Manager caps a stored credential blob far below the size of a multi-account pool. With `CODEX_KEYCHAIN=1` on `win32`, writes are size-checked up front: an oversized blob stays on the JSON path (never deleted) instead of failing mid-write.

### Request logging is opt-in

Nothing is written to `~/.opencode/logs/codex-plugin/` unless `ENABLE_PLUGIN_REQUEST_LOGGING=1`. Even then, request/response **bodies are omitted** unless you also set `CODEX_PLUGIN_LOG_BODIES=1` (raw prompts and model output — enable only while debugging). `DEBUG_CODEX_PLUGIN=1` and `CODEX_PLUGIN_LOG_LEVEL` control verbosity; `CODEX_CONSOLE_LOG=1` mirrors to the console.

### Redaction

`lib/logger.ts` scrubs everything that reaches a log sink, in both directions:

- `SENSITIVE_KEYS` — any object field named like a credential (`access_token`, `refresh_token`, `id_token`, `authorization`, `api_key`, `secret`, `password`, `cookie`, `account_id`, `email`, …) is masked before serialization.
- Token-shaped strings — JWTs, `sk-*` keys, `Bearer …`, hex digests, and `*_token=…` values embedded in free-form text are masked by regex.
- Emails mask to `us***@***.tld`; tokens mask to `prefix…suffix`.
- `codex-diag` and `codex-diff` output is redacted by construction (no tokens, emails, account IDs, or home paths).

`--include-sensitive` / `includeSensitive: true` and `maskEmail: false` are the only opt-ins that unmask account identity in output.

## Deleting your data

```bash
opencode auth logout                                            # host token
rm -f ~/.opencode/oc-codex-multi-auth-accounts.json \
      ~/.opencode/oc-codex-multi-auth-flagged-accounts.json \
      ~/.opencode/openai-codex-auth-config.json \
      ~/.opencode/oc-codex-multi-auth-origin.json
rm -rf ~/.opencode/projects/ ~/.opencode/cache/ ~/.opencode/logs/codex-plugin/
rm -f  ~/.local/state/opencode/oc-codex-multi-auth-*.json
```

Also remove keychain entries if you used `CODEX_KEYCHAIN=1` (`codex-keychain rollback` first, then delete the entry via the OS). To revoke the OAuth grant itself: [ChatGPT Settings → Apps](https://chatgpt.com/settings/apps).

## Scope

- Not affiliated with OpenAI; upstream data handling is governed by [OpenAI's policies](https://openai.com/policies/privacy-policy/).
- Source is public: [github.com/ndycode/oc-codex-multi-auth](https://github.com/ndycode/oc-codex-multi-auth).
- Security reports: [SECURITY.md](../SECURITY.md). Questions: [GitHub Issues](https://github.com/ndycode/oc-codex-multi-auth/issues).

## Related

- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [upgrade.md](upgrade.md)

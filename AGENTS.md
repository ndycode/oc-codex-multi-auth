# PROJECT KNOWLEDGE BASE

Generated: 2026-05-03
Branch: main
Package version: 6.1.8

## OVERVIEW

`oc-codex-multi-auth` is an OpenCode plugin for ChatGPT Plus/Pro OAuth, Codex/GPT-5 request routing, multi-account rotation, account switching, health checks, quota status, diagnostics, and recovery tools. The npm bin is an installer that manages OpenCode provider/TUI config; OpenCode loads `index.ts` as the provider plugin and `tui.ts` as the prompt quota status plugin. Runtime account state stays local under `~/.opencode` with per-project pools enabled by default.

## STRUCTURE

```text
./
├── index.ts              # OpenCode provider plugin entry: auth loader, fetch pipeline, tool registry context
├── tui.ts                # OpenCode TUI plugin: prompt quota status and quota details
├── lib/                  # core runtime logic (see lib/AGENTS.md)
├── test/                 # vitest suites (see test/AGENTS.md)
├── scripts/              # installer, build, audit, and validation helpers
├── config/               # opencode.json examples (modern/full/legacy/minimal)
├── docs/                 # public docs, architecture, audits, maintainer guides
├── skills/               # repo-local setup skill
├── assets/               # static assets
├── .codex-plugin/        # plugin metadata for Codex skill/plugin tooling
└── dist/                 # build output (generated, do not edit)
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Installer behavior | `scripts/install-oc-codex-multi-auth.js`, `scripts/install-oc-codex-multi-auth-core.js` | npm bin, config merge, cache cleanup, TUI config enablement |
| Plugin orchestration | `index.ts` | OAuth loader, request pipeline, metrics, recovery, `ToolContext` assembly |
| TUI quota status | `tui.ts`, `lib/tui-status.ts`, `lib/tui-quota-cache.ts`, `lib/codex-usage.ts` | prompt quota status, quota details, shared quota cache |
| Tool registry | `lib/tools/index.ts` + `lib/tools/codex-*.ts` | 24 registered `codex-*` tools |
| OAuth flow + PKCE | `lib/auth/auth.ts`, `lib/auth/server.ts`, `lib/auth/device-code.ts`, `lib/auth/login-runner.ts` | browser/device/manual login, token refresh, workspace selection |
| OAuth scopes | `lib/auth/scopes.ts` | connector scope validation and re-auth checks |
| Multi-account rotation | `lib/accounts.ts`, `lib/accounts/`, `lib/rotation.ts` | health scoring, cooldowns, token bucket, recovery |
| Account storage | `lib/storage.ts`, `lib/storage/` | V3 facade, per-project/global paths, keychain, backup/import/export |
| Request transformation | `lib/request/request-transformer.ts` | model normalization, prompt injection, stateless compatibility |
| Headers + rate limits | `lib/request/fetch-helpers.ts` | Codex headers, error mapping, fallback, token refresh |
| Retry budgets | `lib/request/retry-budget.ts`, `lib/request/rate-limit-backoff.ts` | bounded retry classes, exponential backoff |
| SSE to JSON | `lib/request/response-handler.ts` | stream parsing and empty-response detection |
| Prompt templates | `lib/prompts/codex.ts`, `lib/prompts/opencode-codex.ts`, `lib/prompts/codex-opencode-bridge.ts` | model-family detection, Codex prompt cache, bridge prompts |
| Config parsing | `lib/config.ts`, `lib/schemas.ts` | plugin config and environment overrides |
| Session recovery | `lib/recovery/`, `lib/recovery.ts` | recoverable error handling and auto-resume |
| Health monitoring | `lib/health.ts`, `lib/parallel-probe.ts` | account health status and concurrent probes |
| Circuit breaker | `lib/circuit-breaker.ts` | failure isolation |
| Public architecture | `docs/architecture.md` | user-facing architecture overview |
| Maintainer architecture | `docs/development/ARCHITECTURE.md` | current subsystem map and invariants |
| Discoverability guide | `docs/development/GITHUB_DISCOVERABILITY.md` | repo description/topics/search wording |
| Tests | `test/` | Vitest, property tests, docs parity, installer, tool modules, TUI quota |

## CONVENTIONS

- Source: root `index.ts`, `tui.ts`, `lib/`, and `scripts/`; `dist/` is generated output.
- ESLint flat config: `no-explicit-any` enforced, unused args prefixed `_`.
- ESM only (`"type": "module"`), Node >= 18.
- Canonical package/plugin name is `oc-codex-multi-auth`.
- The npm bin is an installer, not a long-running runtime command.
- OpenCode loads the provider plugin and TUI plugin from built package exports.
- Default installer mode writes compact modern OpenCode config; `--full` adds explicit selector IDs; `--legacy` writes legacy explicit-only config.
- Runtime requests preserve Codex stateless requirements: `store: false` and `reasoning.encrypted_content`.
- Per-project account storage is enabled by default.
- Optional OS keychain backend is opt-in with `CODEX_KEYCHAIN=1`.

## ANTI-PATTERNS (THIS PROJECT)

- Do not edit `dist/` or `tmp*` directories.
- Do not use `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Do not open public security issues; see `SECURITY.md`.
- Do not hardcode ports other than OAuth callback port `1455`; use existing constants/helpers.
- Do not remove `store: false` or `reasoning.encrypted_content` from shipped config templates.
- Do not treat `oc-chatgpt-multi-auth` as current except in migration/cleanup logic.
- Do not expose account emails, access tokens, refresh tokens, or raw prompt/response bodies in normal diagnostics.
- Do not silently delete JSON credentials when keychain operations fail.

## COMMANDS

```bash
npm run build            # clean dist + tsc + copy oauth-success.html
npm run typecheck        # type checking only
npm test                 # vitest once
npm run test:coverage    # vitest coverage
npm run audit:ci         # prod audit + dev allowlist
npm run test:watch       # vitest watch mode
npm run lint             # eslint
```

## NOTES

- OAuth callback: `http://127.0.0.1:1455/auth/callback`.
- ChatGPT backend requires `store: false`, include `reasoning.encrypted_content`.
- OpenCode config: `~/.config/opencode/opencode.json`.
- OpenCode TUI config: `~/.config/opencode/tui.json`.
- OpenCode auth tokens: `~/.opencode/auth/openai.json`.
- Plugin config: `~/.opencode/openai-codex-auth-config.json`.
- Per-project accounts: `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json`.
- Global accounts: `~/.opencode/oc-codex-multi-auth-accounts.json`.
- Flagged accounts: `~/.opencode/oc-codex-multi-auth-flagged-accounts.json`.
- Request logs: `~/.opencode/logs/codex-plugin/` when logging is enabled.
- Prompt templates sync from Codex CLI GitHub releases with ETag caching.
- 5xx server errors trigger account rotation and health penalty like network errors.
- API deprecation/sunset headers (RFC 8594) are logged as warnings.
- StorageError preserves original stack traces via `cause` parameter.
- `saveToDiskDebounced` errors are logged but do not crash the plugin.

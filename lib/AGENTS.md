# LIB KNOWLEDGE BASE

Generated: 2026-05-03

## OVERVIEW

Core plugin logic for authentication, request routing, account management, storage, model/prompt mapping, diagnostics, UI helpers, and TUI quota status support.

## STRUCTURE

```text
lib/
├── accounts.ts             # account manager facade, storage orchestration, health scoring helpers
├── accounts/               # state, persistence, rotation, recovery, rate limits
├── auth/                   # OAuth PKCE, callback server, browser/device/manual login, scopes
├── auto-update-checker.ts  # npm version check and OpenCode cache refresh notification
├── circuit-breaker.ts      # failure isolation
├── cli.ts                  # auth/login CLI prompt helpers
├── codex-usage.ts          # usage/quota endpoint helpers for TUI status
├── config.ts               # plugin config parsing and env overrides
├── constants.ts            # URLs, provider ids, limits, labels
├── context-overflow.ts     # context length error handling
├── error-sentinels.ts      # structured special-case errors
├── errors.ts               # custom error types
├── health.ts               # account health status
├── index.ts                # barrel exports
├── logger.ts               # debug/request logging
├── oauth-constants.ts      # OAuth port/path constants
├── oauth-success.ts        # OAuth success HTML source copied during build
├── parallel-probe.ts       # parallel health checks
├── proactive-refresh.ts    # token refresh before expiry
├── prompts/                # Codex/OpenCode prompts and ETag caches
├── recovery.ts             # recovery barrel / compatibility entry
├── recovery/               # session recovery hook, storage, constants, types
├── refresh-queue.ts        # queued token refresh (race prevention)
├── request/                # URL/body/header transforms, SSE, retry budget, backoff
├── rotation.ts             # shared rotation utilities
├── runtime.ts              # pure runtime helpers and metrics/explainability types
├── schemas.ts              # Zod schemas
├── shutdown.ts             # graceful shutdown
├── storage.ts              # V3 JSON storage facade
├── storage/                # atomic writes, paths, migrations, keychain, backup/import/export
├── table-formatter.ts      # CLI table formatting
├── tools/                  # 24 codex-* tool factories + registry
├── tui-quota-cache.ts      # shared quota snapshot cache
├── tui-status.ts           # prompt quota status formatting
├── types.ts                # TypeScript interfaces
├── types/                  # dependency type shims
├── ui/                     # terminal UI formatting, menus, theme, select/confirm
└── utils.ts                # shared utilities
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Token exchange/refresh | `auth/auth.ts` | PKCE flow, JWT decode, skew window |
| Device/manual login | `auth/device-code.ts`, `auth/login-runner.ts` | headless login, workspace/account persistence |
| OAuth scopes | `auth/scopes.ts` | connector scope checks |
| Browser launch | `auth/browser.ts` | platform-specific open |
| Callback server | `auth/server.ts` | HTTP on port 1455 |
| URL/body transform | `request/request-transformer.ts` | model map, prompt injection, stateless compatibility |
| Headers + errors | `request/fetch-helpers.ts` | Codex headers, rate limit handling, fallback, refresh |
| Retry budgets | `request/retry-budget.ts` | bounded retry classes |
| Rate limit backoff | `request/rate-limit-backoff.ts` | exponential + jitter |
| SSE parsing | `request/response-handler.ts` | `response.done` extraction and empty responses |
| Model family detection | `prompts/codex.ts` | GPT-5.x and Codex variants |
| Bridge prompts | `prompts/codex-opencode-bridge.ts` | legacy OpenCode-to-Codex tool remapping instructions |
| Account selection | `accounts/rotation.ts`, `rotation.ts` | hybrid health + token bucket |
| Account rate limits | `accounts/rate-limits.ts` | per-account tracking |
| Account persistence | `accounts/persistence.ts`, `accounts/state.ts` | account manager state and save/load coordination |
| Storage format | `storage.ts`, `storage/load-save.ts` | V3 with migration from V1/V2 |
| Storage paths | `storage/paths.ts` | project root detection |
| Storage keychain | `storage/keychain.ts` | optional native keychain backend |
| Storage migrations | `storage/migrations.ts` | V1/V2 → V3 upgrade |
| Backups/import/export | `storage/backup.ts`, `storage/export-import.ts` | timestamped backups and dry-run import preview |
| Tool registry | `tools/index.ts` | `ToolContext`, `createToolRegistry` |
| TUI quota status | `tui-status.ts`, `tui-quota-cache.ts`, `codex-usage.ts` | prompt quota display and usage cache |
| Error types | `errors.ts`, `error-sentinels.ts` | StorageError and structured sentinel errors |
| Health monitoring | `health.ts` | account health status |
| Parallel probes | `parallel-probe.ts` | concurrent health checks |
| Runtime helpers | `runtime.ts` | routing visibility, metrics, pure helper types |
| Graceful shutdown | `shutdown.ts` | cleanup on exit |
| Table formatting | `table-formatter.ts` | CLI output tables |
| Shared utilities | `utils.ts` | common helpers |

## CONVENTIONS

- Public exports via `lib/index.ts` barrel; internal code imports focused modules directly.
- Model families are defined in `prompts/codex.ts` through `MODEL_FAMILIES` and helper functions.
- Account health uses a 0-100 score, decrements on failure, and recovers on success/passive recovery paths.
- Token bucket tracking is per account and helps avoid known rate-limit windows.
- StorageError preserves original stack traces via `cause`.
- Request defaults preserve `store: false` and `reasoning.encrypted_content` for ChatGPT-backed Codex compatibility.
- Tool modules receive shared state through `ToolContext`, not through module-level mutable singletons.

## ANTI-PATTERNS

- Never import from `dist/`; use source paths.
- Never suppress type errors.
- Never hardcode OAuth ports; use `oauth-constants.ts` / auth constants.
- Never remove `store: false` or `reasoning.encrypted_content` handling from the request path or templates.
- Never expose raw tokens in logs, tool output, diagnostics, or response headers.
- Never make keychain migration destructive without backup/rollback behavior.

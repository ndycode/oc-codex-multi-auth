# Configuration fields

Complete map of every user-facing configuration surface. Tables follow one
format everywhere: `field | env | type | default | bounds | meaning`.
`(file only)` means no environment override exists.

Source of truth:

- `lib/schemas.ts` — `PluginConfigSchema` declares every runtime-config key,
  its type, and its bounds.
- `lib/config.ts` — `DEFAULT_CONFIG` supplies defaults; `get*(config)` getters
  apply the env overrides.
- `config/opencode-modern.json`, `config/opencode-legacy.json`,
  `config/minimal-opencode.json` — the catalog templates the installer writes.

## Config surfaces

| Surface | Location | Fields |
| --- | --- | --- |
| OpenCode provider/plugin config | `~/.config/opencode/opencode.json` (or `<project>/.opencode.json`, merged) | `plugin`, `model`, `provider.openai.options`, `provider.openai.models`, `variables` |
| Plugin runtime config | `~/.opencode/openai-codex-auth-config.json` | the runtime table below |
| Environment | process env | overrides for most runtime fields, plus a few env-only knobs |

Resolution order per field: **environment variable > config file > built-in
default**. The runtime file is stat-gated and hot-reloaded — see
[CONFIG_FLOW.md](CONFIG_FLOW.md).

## OpenCode config fields

These are interpreted by OpenCode (and consumed by the plugin via
`provider.openai`), not by the plugin schema.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `plugin` | string[] | `[]` | `"oc-codex-multi-auth"` registers the OAuth provider and hooks |
| `model` | string | host-chosen | default model id, e.g. `openai/gpt-6-sol`; installer writes it only when the templates define matching entries (`--full`/`--modern`/`--legacy`) |
| `provider.openai.options.reasoningEffort` | `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` \| `ultra` | `medium` | default reasoning depth; see the effort table in [configuration.md](../configuration.md#reasoning-effort) |
| `provider.openai.options.reasoningSummary` | `auto` \| `concise` \| `detailed` \| `none` (`off` means `none`; `on` normalizes to `auto`) | `auto` | reasoning summary depth; `none` omits the field |
| `provider.openai.options.textVerbosity` | `low` \| `medium` \| `high` | Codex catalog default (`low`; `high` on Daybreak Red), else `medium` | response verbosity |
| `provider.openai.options.serviceTier` | `fast` (alias `priority`) \| `flex` \| `default` | Codex catalog default (Fast on `gpt-6-sol`/`gpt-6-luna`) | Codex service tier; see [Service tier (Fast)](../configuration.md#service-tier-fast) |
| `provider.openai.options.include` | string[] | `["reasoning.encrypted_content"]` | extra response fields; encrypted reasoning is required with `store: false` and enforced on the wire |
| `provider.openai.options.store` | `false` | `false` | `true` is not supported by the stateless ChatGPT Codex API |
| `provider.openai.models.<id>` | object | none | model registry entry (`name`, `family`, `variant`, `context`, `output`, `reasoning`, `tool_call`, `options`, …) |
| `provider.openai.models.<id>.variants.<id>` | object | none | per-variant options override (`options.reasoningEffort` etc.) |
| `variables` | object | none | `{ name: value }` pairs usable in other config keys |

Per-model `options` override global `options`; OpenCode merges them.

## Plugin runtime fields

File: `~/.opencode/openai-codex-auth-config.json`

Every key below is optional; unspecified keys fall back to `DEFAULT_CONFIG`.
The loader validates per-key: an out-of-range value drops just that key (with a
logged warning) and keeps the rest of the file.

### Request transform & session

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `requestTransformMode` | `CODEX_AUTH_REQUEST_TRANSFORM_MODE` | `native` \| `legacy` | `native` | — | `native` normalizes model names, injects model instructions, and upserts `## Backend Model Identity`; `legacy` does the full Codex CLI-compatible rewrite |
| `codexMode` | `CODEX_MODE` | boolean | `true` | — | bridge-prompt behavior; only applies when `requestTransformMode` is `legacy` |
| `fastSession` | `CODEX_AUTH_FAST_SESSION` | boolean | `false` | — | low-latency mode; wire effect is inside the `legacy` transform only |
| `fastSessionStrategy` | `CODEX_AUTH_FAST_SESSION_STRATEGY` | `hybrid` \| `always` | `hybrid` | — | `hybrid` applies fast tuning only to non-complex recent input; `always` applies unconditionally |
| `fastSessionMaxInputItems` | `CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS` | integer | `30` | file: int 8–200; env: int ≥8, no ceiling | input-item trim target and `hybrid` complexity threshold |
| `pidOffsetEnabled` | `CODEX_AUTH_PID_OFFSET_ENABLED` | boolean | `false` | — | small PID-based offset in hybrid selection scores so parallel processes spread across accounts |
| `beginnerSafeMode` | `CODEX_AUTH_BEGINNER_SAFE_MODE` | boolean | `false` | — | forces `retryProfile` → `conservative`, `retryBudgetOverrides` → `{}`, `retryAllAccountsRateLimited` → `false`, `retryAllAccountsMaxRetries` → ≤1 |

### Account selection & storage

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `rotationStrategy` | `CODEX_AUTH_ROTATION_STRATEGY` | `hybrid` \| `sticky` \| `round-robin` | `hybrid` | — | account selection policy; see configuration.md |
| `spendCredits` | `CODEX_AUTH_SPEND_CREDITS` | boolean | `false` | — | once no entitled account has plan quota, serve from an account with a Codex credit balance; see configuration.md |
| `modelAccountPools` | (file only) | record: model → account-id array | `{}` | keys/values non-empty strings | pin an effective model to stable account/workspace identities; keys normalize case-insensitively after model normalization |
| `modelAccountPoolModes` | (file only) | record: model → `preferred` \| `strict` | `{}` (all `preferred`) | — | `preferred` falls back to the general pool when the mapping has no selectable account; `strict` never leaves its list (`strict_pool_unavailable`) |
| `perProjectAccounts` | `CODEX_AUTH_PER_PROJECT_ACCOUNTS` | boolean | `true` | — | `true`: per-project pools under `~/.opencode/projects/<project-key>/`; `false`: the global pool. Toggling switches scope live but never migrates or prunes the other scope's files |
| `credentialSnapshots` | `CODEX_AUTH_CREDENTIAL_SNAPSHOTS` | boolean | `true` | — | snapshot the previous account store into `backups/` before a significant write; JSON backend only |
| `credentialSnapshotsMaxCount` | `CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT` | integer | `10` | int ≥0 (`0` = keep all) | snapshots kept; env is strict — invalid env values are rejected, not clamped |
| `autoUpdate` | `CODEX_AUTH_AUTO_UPDATE` | boolean | `true` | — | daily npm check; clear the OpenCode plugin cache on exit when a newer version exists |
| `parallelProbing` | `CODEX_AUTH_PARALLEL_PROBING` | boolean | `false` | — | probe flag; `lib/parallel-probe.ts` exists but the fetch loop probes sequentially — no runtime consumer today |
| `parallelProbingMaxConcurrency` | `CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY` | integer | `2` | file: int 1–5; env: int clamped 1–5 | max concurrent probes when enabled |

### Retries, waits & timeouts

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `retryProfile` | `CODEX_AUTH_RETRY_PROFILE` | `conservative` \| `balanced` \| `aggressive` | `balanced` | — | per-class retry budgets (`lib/request/retry-budget.ts`) |
| `retryBudgetOverrides` | (file only) | object | `{}` | each class int ≥0 | per-class override: `authRefresh`, `network`, `server`, `rateLimitShort`, `rateLimitGlobal`, `emptyResponse` |
| `retryAllAccountsRateLimited` | `CODEX_AUTH_RETRY_ALL_RATE_LIMITED` | boolean | `true` | — | wait and retry when every account is rate-limited |
| `retryAllAccountsMaxWaitMs` | `CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS` | number (ms) | `0` | ≥0; **no 24h ceiling** (`0` is a documented unbounded semantic) | cap on all-accounts-limited waits; `0` asks to wait as long as the backend requires — an interactive request caps that at a 10-minute ceiling unless `CODEX_RETRY_ALL_UNBOUNDED=1` |
| `retryAllAccountsMaxRetries` | `CODEX_AUTH_RETRY_ALL_MAX_RETRIES` | integer | `Infinity` | int ≥0 | max attempts in the all-limited loop |
| `emptyResponseMaxRetries` | `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES` | integer | `2` | int ≥0 | retries after an empty SSE/response body |
| `emptyResponseRetryDelayMs` | `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS` | number (ms) | `1000` | 0–86400000 | delay between empty-response retries |
| `fetchTimeoutMs` | `CODEX_AUTH_FETCH_TIMEOUT_MS` | number (ms) | `60000` | 1000–86400000 | upstream fetch timeout |
| `streamStallTimeoutMs` | `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS` | number (ms) | `45000` | 1000–86400000 | abort after this long without an SSE chunk |
| `maxStreamDurationMs` | `CODEX_AUTH_MAX_STREAM_DURATION_MS` | number (ms) | `300000` | 1000–86400000 | total post-headers deadline for SSE conversion; a drip inside the stall gap cannot extend it |
| `tokenRefreshSkewMs` | `CODEX_AUTH_TOKEN_REFRESH_SKEW_MS` | number (ms) | `60000` | 0–86400000 | refresh OAuth tokens this many ms before expiry |

### Recovery & unsupported models

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `sessionRecovery` | `CODEX_AUTH_SESSION_RECOVERY` | boolean | `true` | — | classify recoverable API errors and show recovery toasts |
| `autoResume` | `CODEX_AUTH_AUTO_RESUME` | boolean | `true` | — | auto-resume the session after thinking-block recovery |
| `unsupportedCodexPolicy` | `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY` | `strict` \| `fallback` | `strict` | — | `strict` returns entitlement errors; `fallback` retries down the fallback chain |
| `fallbackOnUnsupportedCodexModel` | `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL` | boolean | `false` | — | legacy spelling of the policy (`true` → `fallback`) |
| `fallbackToGpt52OnUnsupportedGpt53` | `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` | boolean | `true` | — | keeps the `gpt-5.3-codex → gpt-5.2-codex` edge in fallback mode; `false` skips only that edge |
| `unsupportedCodexFallbackChain` | (file only) | record: model → model array | `{}` | values non-empty strings | per-model fallback-chain override; keys and targets normalize to canonical ids |

`unsupportedCodexPolicy` precedence: `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY` >
config `unsupportedCodexPolicy` > `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL` >
config `fallbackOnUnsupportedCodexModel` > `strict`.

### TUI, quota display & notifications

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `codexTuiV2` | `CODEX_TUI_V2` | boolean | `true` | — | codex-style terminal UI; `false` keeps legacy output |
| `codexTuiColorProfile` | `CODEX_TUI_COLOR_PROFILE` | `truecolor` \| `ansi256` \| `ansi16` | `truecolor` | — | terminal color profile |
| `codexTuiGlyphMode` | `CODEX_TUI_GLYPHS` | `ascii` \| `unicode` \| `auto` | `ascii` | — | glyph set |
| `maskEmail` | `CODEX_TUI_MASK_EMAIL` | boolean | `false` | — | mask account emails (`us***@example.com`) across TUI status, command output, and menus |
| `maskEmailInQuotaDetails` | `CODEX_TUI_MASK_EMAIL_DETAILS` | boolean | `false` | — | also mask the active account email in the quota details dialog (needs `maskEmail`) |
| `quotaDisplay` | `CODEX_AUTH_QUOTA_DISPLAY` | `free` \| `used` | `free` | — | word quota percentages as headroom or consumption; presentation only |
| `quotaStatus` | (file only) | object | see below | — | prompt quota status line shape |
| `quotaNotifications` | — | object | see below | — | macOS quota alerts + credit-protection poll |
| `limitsSort` | (file only) | object | `{by: "account", direction: "asc"}` | `by`: `account`/`usage`/`reset`; `direction`: `asc`/`desc` | default account order for the standalone `limits` CLI |
| `toastDurationMs` | `CODEX_AUTH_TOAST_DURATION_MS` | number (ms) | `5000` | 1000–86400000 | toast visibility duration |
| `accountToasts` | `CODEX_AUTH_ACCOUNT_TOASTS` | boolean | `true` | — | gates only the `Using <account> (N/N)` selection toast |
| `rateLimitToastDebounceMs` | `CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS` | number (ms) | `60000` | 0–86400000 | debounce rate-limit toast notifications |

### `quotaStatus` object (all keys file-only)

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `mode` | (file only) | `active` \| `overview` \| `resets` \| `credits` or array | `active` | unknown names dropped | screens to show; a list rotates every `rotateMs` |
| `rotateMs` | (file only) | number (ms) | `5000` | 1000–86400000 | per-screen dwell |
| `layout` | (file only) | `accounts` \| `aggregate` \| `count` \| `total` | `accounts` | — | segment layout |
| `accountNames` | (file only) | `number` \| `label` \| `none` | `number` | — | `#1`, the `codex-label`/email local part, or nothing |
| `order` | (file only) | `number` \| `most-used` \| `least-used` \| `renewing-earliest` \| `renewing-latest` | `number` | — | account segment order |
| `multipliers` | (file only) | boolean | `false` | — | `5x`/`20x` plan allotment badges |
| `allotment` | (file only) | boolean | `false` | — | `24% of 26x` — weighted pool total in 1x seats |
| `resetTimes` | (file only) | `never` \| `low` \| `always` (`true`→`low`, `false`→`never`) | `low` | — | `3d` countdowns |
| `resetCredits` | (file only) | boolean | `false` | — | `1r` banked-reset credit badges |
| `recovery` | (file only) | boolean or `"all"` | `false` | — | next capacity gain (`true`) or all gains (`"all"`) |
| `resetsMinUsedPercent` | (file only) | number | `100` | 0–100 | minimum pool weighted usage before the `resets` and `credits` screens show |
| `accounts` | (file only) | boolean | — | — | legacy spelling; `false` = `layout: "count"` |
| `rows` | (file only) | integer | `1` | 1–4 | row ceiling, not a height |
| `showFor` | (file only) | `always` \| `codex-models` | `always` | — | `codex-models` hides the line unless the session runs a routed model |

### `quotaNotifications` object

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `enabled` | `CODEX_AUTH_QUOTA_NOTIFICATIONS` | boolean | `false` | macOS only (`osascript`) | aggregate 5-hour and weekly pool quota alerts |
| `autoProtectCredits` | `CODEX_AUTH_AUTO_PROTECT_CREDITS` | boolean | `true` | — | poll usage each `intervalMs` and exclude fully spent subscription quotas from rotation |
| `autoRedeemResets` | `CODEX_AUTH_AUTO_REDEEM_RESETS` | boolean | `false` | — | spend one banked rate-limit reset credit when the weekly quota is at or below the threshold and the server reports it applicable now |
| `autoRedeemResetsBelowPercent` | `CODEX_AUTH_AUTO_REDEEM_RESETS_BELOW_PERCENT` | number | `10` | 0–100 | weekly quota left (percent) at or below which `autoRedeemResets` spends a credit |
| `intervalMs` | `CODEX_AUTH_QUOTA_NOTIFICATIONS_INTERVAL_MS` | number (ms) | `1800000` | 30000–86400000 | quota poll interval |
| `notifyEveryCheck` | (file only) | boolean | `false` | — | deliver after every poll, not only on threshold crossings |
| `thresholds` | (file only) | number[] | `[25, 10, 0]` | each 0–100 | remaining-percent thresholds per window; deduped, sorted most-generous first; `[]` disables |

## Env-only knobs (no config field)

Same `"1"`-only truthy rule unless noted. Grouped for reference; see
[configuration.md](../configuration.md#environment-variables-without-a-config-field)
for the user-facing table.

| variable | meaning |
| --- | --- |
| `CODEX_AUTH_ACCOUNT_ID` | pin requests to one workspace/account id (trimmed, ≤256 chars; longer/blank values are ignored) |
| `OPENAI_BASE_URL` + `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` | OpenAI-compatible gateway; absolute URL, no credentials/query/fragment, `https` unless literal loopback IP |
| `CODEX_AUTH_CLIENT_IDENTITY` | `codex` \| `opencode` \| `host` (alias of `opencode`); default per model (`opencode` for responses-lite ids, `codex` otherwise) |
| `CODEX_AUTH_CLIENT_VERSION` | `codex_cli_rs` User-Agent version token (built-in `0.144.0`) |
| `CODEX_AUTH_HOST_VERSION` | `opencode` User-Agent version (default: host UA version, else a baked-in fallback) |
| `CODEX_AUTH_DISABLE_CODEX_USER_AGENT=1` | keep the host runtime `User-Agent` |
| `CODEX_AUTH_SEND_ORGANIZATION_HEADER=1` | restore legacy `openai-organization` request pinning (off by default) |
| `CODEX_AUTH_PREWARM=0` | disable legacy-transform startup prewarm (on by default, skipped under test) |
| `CODEX_AUTH_SYNC_CODEX_CLI=0` | disable `~/.codex` Codex CLI account hydration (on by default) |
| `CODEX_KEYCHAIN=1` | opt in to OS keychain account storage; on `win32` oversized blobs are size-checked and stay on the JSON path |
| `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL` | legacy boolean env → `unsupportedCodexPolicy` |
| `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK`, `_GPT56_`, `_GPT55_`, `_CODEX_` | `=1` disables the corresponding default-selector auto-fallback (which otherwise runs even under `strict`) |
| `CODEX_RETRY_ALL_UNBOUNDED=1` | remove the 10-minute interactive ceiling on `retryAllAccountsMaxWaitMs: 0` |
| `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` | env form of `fallbackToGpt52OnUnsupportedGpt53` |
| `CODEX_THREAD_ID` | correlation / prompt-cache seed on outbound requests |
| `CODEX_COLLABORATION_MODE` | `plan` \| `default`; `OPENCODE_COLLABORATION_MODE` is an alias (`CODEX_` wins) |
| `OPENCODE_CODEX_PROMPT_URL` | bridge prompt catalog URL override (legacy transform) |
| `OPENCODE_SKIP_EMAIL_HYDRATE=1` | skip account email hydrate during bootstrap |
| `FORCE_INTERACTIVE_MODE=1` | force interactive menus when the host looks non-interactive |
| `OPENCODE_TUI`, `OPENCODE_DESKTOP` | `=1` marks the session non-interactive (set by the host) |
| `OPENCODE_STATE_DIR` | override the state dir used for TUI quota caches |
| `ENABLE_PLUGIN_REQUEST_LOGGING=1` | request metadata logging (no raw bodies) |
| `CODEX_PLUGIN_LOG_BODIES=1` | raw request/response bodies in log files (sensitive) |
| `DEBUG_CODEX_PLUGIN=1` | debug logging |
| `CODEX_PLUGIN_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` (default `info`, invalid → `info`) |
| `CODEX_CONSOLE_LOG=1` | mirror logs to console |

## Value semantics

- **Boolean env**: `z.string().optional()` parsed so that only literal `"1"`
  resolves `true`; every other present string resolves `false` and overrides
  the file. Opt-out-style vars (`..._DISABLE_...`, `CODEX_AUTH_PREWARM`,
  `CODEX_AUTH_SYNC_CODEX_CLI`) follow the same rule — `=0` is the value that
  disables them.
- **Numeric env**: trimmed, must be a finite number; `NaN`/`Infinity`/empty
  fall back to the file/default. Duration getters clamp the result to the
  field's bounds — `MAX_CONFIG_DURATION_MS = 86400000` (24h) is the shared
  ceiling except on `retryAllAccountsMaxWaitMs`, which intentionally has none.
- **Integer env**: `resolveIntegerSetting` additionally rejects fractions
  (`2.5` falls back, never truncates) and values below the getter's minimum;
  some getters also clamp to a maximum (noted per field).
- **Enum env**: trimmed + lower-cased; must match a listed value.
- **File values**: each key is validated independently by
  `PluginConfigSchema`; a failed key is dropped with a warning and the rest of
  the file still applies. `{}` is the supported reset-to-defaults file.

## Model account pools

`modelAccountPools` is a map from effective model id → stable account or
Business-seat identities; `modelAccountPoolModes` sets each mapping to
`preferred` (default) or `strict`. Both are file-only. Keys are normalized
case-insensitively after model normalization, so `gpt-5.1-codex` and
`gpt-5-codex` land on the same pool. The config file is global while account
storage is per-project by default, so a pool can reference accounts that are
unavailable in the current project — the loader reports them as unresolved
but does not prune them. Mutations go through the `codex-pool` tool.

## Non-schema environment variables (context)

Test/harness-only vars such as `OC_CODEX_TEST_HOME`, `VITEST`, `VITEST_WORKER_ID`,
`NODE_ENV`, and the `CODEX_*_ERROR`/`CODEX_RATE_LIMIT` fault-injection flags
are intentionally not user configuration.

## Verification

- `docs/configuration.md` — user-facing guide built from the same tables
- [CONFIG_FLOW.md](CONFIG_FLOW.md) — load/reload pipeline
- `test/config.test.ts`, `test/config-env-bounds.test.ts`,
  `test/config-hot-reload.test.ts`, `test/config-stat-gate.test.ts`,
  `test/model-pool-config.test.ts`, `test/quota-status-config.test.ts` —
  behavior coverage (`find test -name '*.test.ts'` for the full list)
- `npx vitest run test/doc-parity.test.ts` — doc/source drift checks

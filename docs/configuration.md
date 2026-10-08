# Configuration Reference

Everything you can set for `oc-codex-multi-auth`, where to set it, the default,
and the accepted range. The defaults work for most people; treat this page as a
reference, not a checklist.

## Where settings live

| Place | What it controls |
| --- | --- |
| `~/.config/opencode/opencode.json` | OpenCode provider/plugin config: the `plugin` entry, `provider.openai.options` (reasoning effort, summary, verbosity, `store`, `include`), and the model catalog the installer writes |
| `~/.opencode/openai-codex-auth-config.json` | Plugin runtime config: retries, rotation, pools, TUI/quota display, storage scope. This page's main table |
| Environment variables | Per-process overrides of most fields, plus a few env-only knobs |

**Precedence: environment variable > config file > built-in default**, resolved
per field, per request.

### Env-var semantics

- **Boolean envs: only `"1"` is truthy.** Any other value — including `"0"`,
  `"true"`, `"yes"`, and the empty string — resolves to **false** and overrides
  the file. A small number of opt-out vars are worded the other way
  (`..._DISABLE_...`, `CODEX_AUTH_PREWARM`, `CODEX_AUTH_SYNC_CODEX_CLI`); those
  say so below, and for them `"0"` is the value that changes behavior.
- **Integer envs must be integers.** A fractional value like
  `CODEX_AUTH_*=2.5` is rejected outright and falls back to the file/default —
  it is never truncated. Values within an accepted range are clamped to it.
- **Duration envs (milliseconds) are clamped** to the field's bounds, with a
  hard ceiling of `86400000` (24h) on every duration field —
  except `retryAllAccountsMaxWaitMs`, where `0` is a documented "unbounded"
  semantic.
- **Enum envs** are trimmed, lower-cased, and must match a listed value;
  anything else falls back to the file/default.
- **Out-of-range file values** are different: a value the schema rejects fails
  only that key (the loader logs a warning and drops the key, falling back to
  its default) — the rest of the file still applies.

---

## Base configuration (`opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-codex-multi-auth"],
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "medium",
        "reasoningSummary": "auto",
        "textVerbosity": "medium",
        "include": ["reasoning.encrypted_content"],
        "store": false
      }
    }
  }
}
```

`"store": false` and `reasoning.encrypted_content` in `include` are required by
the stateless ChatGPT Codex backend and the plugin enforces them on the wire
either way. Per-model options override global options — see
[Config patterns](#config-patterns).

### Reasoning effort

| model | supported values |
| --- | --- |
| `gpt-6.1-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-astra` | low, medium, high, xhigh, max, ultra |
| `gpt-6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-6-luna` | low, medium, high, xhigh, max |
| `gpt-5.6-sol`, `gpt-5.6-terra` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | low, medium, high, xhigh, max |
| `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.6-cyber` | low, medium, high, xhigh, max, ultra (Daybreak-gated; add manually) |
| `gpt-5.5`, `gpt-5.5-fast` | none, low, medium, high, xhigh |
| `gpt-5.4`, `gpt-5.4-mini` | none, low, medium, high, xhigh (retired from Codex 2026-08-31; still routed if typed) |
| `gpt-5.4-nano` | none, low, medium, high, xhigh |
| `gpt-5.4-pro` | medium, high, xhigh (manual add; `none`/`low`/`minimal` coerce to `medium`) |
| `gpt-5.2` | none, low, medium, high, xhigh |
| `gpt-5-codex` | low, medium, high (default: high; `none`/`minimal` coerce to `low`, `xhigh` to `high`; API shutdown 2026-07-23, still routed) |
| `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2-codex` | low, medium, high, xhigh (default: `xhigh`; Spark is entitlement-gated, manual add) |
| `gpt-5.1-codex-max` | low, medium, high, xhigh (default: `high`; API shutdown 2026-07-23, still routed) |
| `gpt-5.1-codex` | low, medium, high (legacy alias of `gpt-5-codex`; API shutdown 2026-07-23, still routed) |
| `gpt-5.1-codex-mini` | medium, high (default: `medium`; API shutdown 2026-07-23, still routed) |
| `gpt-5.1` | none, low, medium, high |

Clamps the plugin applies before the wire: `ultra` is a client-side tier sent as
`max`; `max` steps down to `xhigh` on families without it; `xhigh` steps down to
`high` on families without it; `none` floors to `low` on families that reject
it; `minimal` floors to `low` on Codex and on the GPT-5.6 / GPT-6 tiers.

| value | meaning |
| --- | --- |
| `none` | no reasoning phase (base general-purpose families only) |
| `minimal` | minimal reasoning; accepted but floored to `low` almost everywhere |
| `low` | light reasoning, fastest |
| `medium` | balanced (default for most families) |
| `high` | deep reasoning (default for `gpt-5-codex` and xhigh-capable general families) |
| `xhigh` | max depth for complex tasks (default for `gpt-5.3-codex`/`gpt-5.2-codex`) |
| `max` | GPT-5.6 / GPT-6 / Daybreak ceiling tier |
| `ultra` | Codex client-side orchestration tier; sent on the wire as `max` — this plugin does not spawn subagents |

### Reasoning summary / text verbosity / include / store

| option | values | default |
| --- | --- | --- |
| `reasoningSummary` | `auto`, `concise`, `detailed` | `auto` (legacy `off`/`on` normalize to `auto`) |
| `textVerbosity` | `low`, `medium`, `high` | `medium` |
| `include` | extra response fields | `reasoning.encrypted_content` is required for multi-turn with `store: false` and is always enforced |
| `store` | `false` | `false` — stateless mode, required; `true` is not supported by the Codex API |

### Model normalization

The plugin normalizes the selected id before the upstream call. Highlights:

- bare `gpt-6` maps to `gpt-6-astra`; `gpt-6-astra-pro*` collapses onto `gpt-6-astra` (not a Codex-routable id)
- bare `gpt-6.1` maps to `gpt-6.1-sol` (the only shipping 6.1 tier; GPT-6.1 Astra was cancelled 2026-09-28 before it ever got a model id)
- `gpt-daybreak-blue*` / `gpt-daybreak-red*` map to the catalog `-latest` ids; `gpt-5.6-cyber*` maps to itself, never to Sol
- bare `gpt-5.6` maps to `gpt-5.6-sol`; `gpt-5.6-terra*`/`gpt-5.6-luna*` map to their own tiers
- `gpt-5.5*`, `gpt-5.5-fast*`, and `gpt-5.5-pro*` normalize to `gpt-5.5` (GPT-5.5 Pro is ChatGPT-only)
- legacy `gpt-5` maps to `gpt-6-sol`; any other unrecognized `gpt-5*` name also resolves to `gpt-6-sol` — the plugin-wide default for a missing/unknown id
- legacy `gpt-5-mini` maps to `gpt-6-luna`; `gpt-5-nano` maps to `gpt-5.4-nano`
- `gpt-5.1-codex` normalizes to `gpt-5-codex`; `gpt-5.1-codex-max` and `gpt-5.1-codex-mini` are their own families
- `MODEL_MAP` in `lib/request/helpers/model-map.ts` is the authoritative mapping

### Catalog notes

- The shipped templates carry 11 base model families and 59 variants
  (`--modern`) or 59 explicit selector entries (`--legacy` / added by `--full`).
  The default install writes no catalog at all — it registers the plugin and
  preserves `provider.openai`.
- `gpt-5.4-mini`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, and
  `gpt-5.1-codex-mini` are no longer shipped (retired or shut down upstream)
  but still route if typed, and the default fallback chains rescue them.
- `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.6-cyber`, and
  `gpt-5.3-codex-spark` are deliberately unshipped: entitlement-gated ids would
  fail at startup for most users. Add them by hand if your workspace is
  entitled. The three cyber tiers have no fallback chain, on purpose — a
  security-specialty request must not be silently answered by a general model.
- GPT-5.6 tiers, GPT-6 Astra/Sol/Luna, and the Daybreak tiers are sent over
  the **responses-lite** path with default client identity `opencode`; other
  models default to `codex_cli_rs`. `CODEX_AUTH_CLIENT_IDENTITY` overrides.
- Because 5.6 and GPT-6 rolled out gradually, an unentitled account
  auto-degrades down the default chains even under the `strict` policy — see
  [auto-fallback](#unsupported-model-policy-and-fallback-chains).
- Shipped context windows: `context=1050000`, `output=128000` for the GPT-6,
  GPT-5.6, and 5.5 families; `gpt-5.4-nano` 400000/128000; `gpt-5.1`
  272000/128000.

---

## Plugin runtime config

File: `~/.opencode/openai-codex-auth-config.json`

The file is re-read cheaply on every request: the loader compares the file's
stat signature (mtime, ctime, size, inode) and only re-reads when it changes,
re-validating only when the content did. An incomplete write, invalid JSON, or
a temporarily missing file keeps the last usable config; write `{}` to reset
everything to defaults. Most fields apply to the next request — see
[What hot-reloads](#what-hot-reloads).

### Field reference

Format: `field | env override | type | default | bounds | meaning`.
`(file only)` means no environment override exists for that field.

#### Request transform & session

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `requestTransformMode` | `CODEX_AUTH_REQUEST_TRANSFORM_MODE` | `native` \| `legacy` | `native` | — | `native` normalizes model names, injects model instructions, and upserts `## Backend Model Identity`; `legacy` does the full Codex CLI-compatible rewrite |
| `codexMode` | `CODEX_MODE` | boolean | `true` | — | bridge-prompt behavior; only applies when `requestTransformMode` is `legacy` |
| `fastSession` | `CODEX_AUTH_FAST_SESSION` | boolean | `false` | — | low-latency mode. Wire effect is inside the `legacy` transform only: clamps `reasoningEffort` to `none` (floored to `low` where unsupported), `reasoningSummary` to `auto`, `textVerbosity` to `low`, trims input, compacts instructions, and drops tools on trivial turns |
| `fastSessionStrategy` | `CODEX_AUTH_FAST_SESSION_STRATEGY` | `hybrid` \| `always` | `hybrid` | — | `hybrid` applies fast tuning only when the recent input is not complex (no tool calls or structured prompts in the lookback window); `always` applies it unconditionally |
| `fastSessionMaxInputItems` | `CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS` | integer | `30` | file: int 8–200; env: int ≥8, no ceiling | input-item trim target and `hybrid` complexity threshold |
| `pidOffsetEnabled` | `CODEX_AUTH_PID_OFFSET_ENABLED` | boolean | `false` | — | small PID-based offset in hybrid selection scores so parallel processes spread across accounts |
| `beginnerSafeMode` | `CODEX_AUTH_BEGINNER_SAFE_MODE` | boolean | `false` | — | conservative behavior: forces `retryProfile` → `conservative`, `retryBudgetOverrides` → `{}`, `retryAllAccountsRateLimited` → `false`, `retryAllAccountsMaxRetries` → ≤1 |

#### Account selection & storage

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `rotationStrategy` | `CODEX_AUTH_ROTATION_STRATEGY` | `hybrid` \| `sticky` \| `round-robin` \| `custom` | `hybrid` | — | `hybrid`: stay while healthy, else score-select (health + tokens + freshness); `sticky`: drain the current account first, then the lowest-indexed available — staggers weekly-quota cooldowns; `round-robin`: advance in order every selection; `custom`: trusted JavaScript policy |
| `customRotation.module` | — | absolute `.mjs` path | unset | — | trusted policy module; see [custom rotation](custom-rotation.md) for permissions, observations and offline validation |
| `spendCredits` | `CODEX_AUTH_SPEND_CREDITS` | boolean | `false` | — | once no account entitled to the requested model has plan quota left, serve from an account that still holds Codex credits instead of waiting for a reset; see [Spending Codex credits](#spending-codex-credits) |
| `modelAccountPools` | (file only) | object: model → account-id array | `{}` | keys/values non-empty strings | pin an effective model to stable account or Business-seat identities; matched case-insensitively after model normalization |
| `modelAccountPoolModes` | (file only) | object: model → `preferred` \| `strict` | `{}` (all `preferred`) | — | `preferred` falls back to the general pool when the mapping has no selectable account; `strict` never leaves its list and fails with `strict_pool_unavailable` |
| `perProjectAccounts` | `CODEX_AUTH_PER_PROJECT_ACCOUNTS` | boolean | `true` | — | `true`: each project gets its own pool under `~/.opencode/projects/<project-key>/`; `false`: the global `~/.opencode/` pool. Toggling switches scope live (in-flight requests drain first) but does **not** migrate or delete the other scope's accounts, flagged, or backup files — copy or remove them yourself |
| `credentialSnapshots` | `CODEX_AUTH_CREDENTIAL_SNAPSHOTS` | boolean | `true` | — | copy the previous account store into `backups/` before a significant write; JSON backend only, not `CODEX_KEYCHAIN` |
| `credentialSnapshotsMaxCount` | `CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT` | integer | `10` | int ≥0 (`0` = keep all) | snapshots kept; env is strict — a non-integer or negative env value is rejected, not clamped |
| `autoUpdate` | `CODEX_AUTH_AUTO_UPDATE` | boolean | `true` | — | daily npm check; clear the OpenCode plugin cache on exit when a newer version exists |
| `parallelProbing` | `CODEX_AUTH_PARALLEL_PROBING` | boolean | `false` | — | concurrent account health probes. Probe code exists (`lib/parallel-probe.ts`) but the fetch loop probes sequentially, so this flag has no runtime consumer today |
| `parallelProbingMaxConcurrency` | `CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY` | integer | `2` | file: int 1–5; env: int clamped 1–5 | max concurrent probes when enabled |

**How "project" is decided.** With `perProjectAccounts` on, the plugin walks
up from the working directory looking for a marker — `.git`, `package.json`,
`Cargo.toml`, `go.mod`, `pyproject.toml`, or `.opencode` — and stops the search
at your home directory, so a stray `~/.opencode` does not turn `$HOME` itself
into a project. Outside a project the global pool is used. For the standalone
CLI, run it from inside a real project to reach that project's pool, or pass
`--config-path` to name the accounts file directly.

#### Retries, waits & timeouts

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `retryProfile` | `CODEX_AUTH_RETRY_PROFILE` | `conservative` \| `balanced` \| `aggressive` | `balanced` | — | per-class retry budgets, see [Retry budgets](#retry-budgets-by-profile) |
| `retryBudgetOverrides` | (file only) | object | `{}` | each class int ≥0 | override one class of the profile: `authRefresh`, `network`, `server`, `rateLimitShort`, `rateLimitGlobal`, `emptyResponse` |
| `retryAllAccountsRateLimited` | `CODEX_AUTH_RETRY_ALL_RATE_LIMITED` | boolean | `true` | — | wait and retry when every account is rate-limited |
| `retryAllAccountsMaxWaitMs` | `CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS` | number (ms) | `0` | ≥0; **no 24h ceiling** | cap on the all-accounts-limited wait. A positive bound applies unchanged; `0` asks to wait as long as the backend requires, which an interactive request caps at a 10-minute ceiling unless `CODEX_RETRY_ALL_UNBOUNDED=1` |
| `retryAllAccountsMaxRetries` | `CODEX_AUTH_RETRY_ALL_MAX_RETRIES` | integer | `Infinity` | int ≥0 | max attempts in the all-limited loop (omit the key for unlimited) |
| `emptyResponseMaxRetries` | `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES` | integer | `2` | int ≥0 | retries after an empty SSE/response body |
| `emptyResponseRetryDelayMs` | `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS` | number (ms) | `1000` | 0–86400000 | delay between empty-response retries |
| `fetchTimeoutMs` | `CODEX_AUTH_FETCH_TIMEOUT_MS` | number (ms) | `60000` | 1000–86400000 | upstream fetch timeout |
| `streamStallTimeoutMs` | `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS` | number (ms) | `45000` | 1000–86400000 | abort after this long without an SSE chunk |
| `maxStreamDurationMs` | `CODEX_AUTH_MAX_STREAM_DURATION_MS` | number (ms) | `300000` | 1000–86400000 | total post-headers deadline for SSE conversion; a drip inside the stall gap cannot extend it |
| `tokenRefreshSkewMs` | `CODEX_AUTH_TOKEN_REFRESH_SKEW_MS` | number (ms) | `60000` | 0–86400000 | refresh OAuth tokens this many ms before expiry |

#### Recovery & unsupported models

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `sessionRecovery` | `CODEX_AUTH_SESSION_RECOVERY` | boolean | `true` | — | classify recoverable API errors and show recovery toasts |
| `autoResume` | `CODEX_AUTH_AUTO_RESUME` | boolean | `true` | — | auto-resume the session after thinking-block recovery |
| `unsupportedCodexPolicy` | `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY` | `strict` \| `fallback` | `strict` | — | `strict` returns entitlement errors; `fallback` retries down the chain below after account/workspace attempts are exhausted |
| `fallbackOnUnsupportedCodexModel` | `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL` | boolean | `false` | — | legacy spelling of the policy (`true` → `fallback`); prefer `unsupportedCodexPolicy` |
| `fallbackToGpt52OnUnsupportedGpt53` | `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` | boolean | `true` | — | keeps the legacy `gpt-5.3-codex → gpt-5.2-codex` edge inside fallback mode; `false` skips only that edge |
| `unsupportedCodexFallbackChain` | (file only) | object: model → model array | `{}` | values non-empty strings | per-model fallback-chain override; keys and targets normalize to canonical model ids |

`unsupportedCodexPolicy` precedence: `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY` >
config `unsupportedCodexPolicy` > `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL` >
config `fallbackOnUnsupportedCodexModel` > `strict`.

#### TUI, quota display & notifications

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `codexTuiV2` | `CODEX_TUI_V2` | boolean | `true` | — | codex-style terminal UI output; `false` keeps legacy output |
| `codexTuiColorProfile` | `CODEX_TUI_COLOR_PROFILE` | `truecolor` \| `ansi256` \| `ansi16` | `truecolor` | — | terminal color profile for codex UI |
| `codexTuiGlyphMode` | `CODEX_TUI_GLYPHS` | `ascii` \| `unicode` \| `auto` | `ascii` | — | glyph set for codex UI |
| `maskEmail` | `CODEX_TUI_MASK_EMAIL` | boolean | `false` | — | mask account emails (`us***@example.com`) across the TUI status, command output, and menus. Labels set by `codex-label` always show; `--includeSensitive` JSON output stays raw |
| `maskEmailInQuotaDetails` | `CODEX_TUI_MASK_EMAIL_DETAILS` | boolean | `false` | — | also mask the active account email in the quota details dialog (needs `maskEmail`) |
| `quotaDisplay` | `CODEX_AUTH_QUOTA_DISPLAY` | `free` \| `used` | `free` | — | word every quota percentage as headroom (`88% left`) or consumption (`12% used`); presentation only — thresholds, exhaustion, and JSON fields stay keyed on remaining. See [Quota percentage display](#quota-percentage-display) |
| `quotaStatus` | (file only) | object | see below | — | shape of the prompt quota status line — see [Pool-wide quota status](#pool-wide-quota-status) |
| `quotaNotifications` | — | object | see below | — | macOS quota alerts + the credit-protection poll — see [Quota notifications](#quota-notifications) |
| `limitsSort` | (file only) | object | `{by: "account", direction: "asc"}` | `by`: `account`/`usage`/`reset`; `direction`: `asc`/`desc` | default account order for the standalone `limits` CLI; `--sort`/`--asc`/`--desc` override. See [What `limits` reports](tools-and-cli.md#what-limits-reports) |
| `toastDurationMs` | `CODEX_AUTH_TOAST_DURATION_MS` | number (ms) | `5000` | 1000–86400000 | how long toast notifications stay visible |
| `accountToasts` | `CODEX_AUTH_ACCOUNT_TOASTS` | boolean | `true` | — | gates only the `Using <account> (N/N)` selection toast; warning/error toasts are unaffected |
| `rateLimitToastDebounceMs` | `CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS` | number (ms) | `60000` | 0–86400000 | debounce rate-limit toast notifications |

#### `quotaStatus` object (file only — a display preference with no env overrides)

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `quotaStatus.mode` | (file only) | `active` \| `overview` \| `resets` \| `credits`, or array | `active` | unknown names dropped | which screens to show; a list alternates every `rotateMs` |
| `quotaStatus.rotateMs` | (file only) | number (ms) | `5000` | 1000–86400000 | per-screen dwell when `mode` is a list |
| `quotaStatus.layout` | (file only) | `accounts` \| `aggregate` \| `count` \| `total` | `accounts` | — | per-account segments, grouped percentages, a count, or only the pool total |
| `quotaStatus.accountNames` | (file only) | `number` \| `label` \| `none` | `number` | — | `#1`, the `codex-label`/email local part, or nothing |
| `quotaStatus.order` | (file only) | `number` \| `most-used` \| `least-used` \| `renewing-earliest` \| `renewing-latest` | `number` | — | account segment order |
| `quotaStatus.multipliers` | (file only) | boolean | `false` | — | `5x`/`20x` plan allotment badges |
| `quotaStatus.allotment` | (file only) | boolean | `false` | — | `24% of 26x`: the weighted pool total in 1x seats |
| `quotaStatus.resetTimes` | (file only) | `never` \| `low` \| `always` (boolean accepted: `true`→`low`, `false`→`never`) | `low` | — | `3d` countdowns: none, only accounts at ≤25% headroom, or all |
| `quotaStatus.resetCredits` | (file only) | boolean | `false` | — | `1r` for banked rate-limit resets redeemable now |
| `quotaStatus.recovery` | (file only) | boolean or `"all"` | `false` | — | `true`: next capacity gain, signed to the display direction; `"all"`: every known incremental gain, always positive |
| `quotaStatus.resetsMinUsedPercent` | (file only) | number | `100` | 0–100 | minimum pool weighted usage before the `resets` and `credits` screens show |
| `quotaStatus.accounts` | (file only) | boolean | — | — | legacy spelling; `false` behaves as `layout: "count"` |
| `quotaStatus.rows` | (file only) | integer | `1` | 1–4 | row ceiling for the line — a ceiling, not a height |
| `quotaStatus.showFor` | (file only) | `always` \| `codex-models` | `always` | — | `codex-models` hides the line unless the session runs a model this plugin routes |

#### `quotaNotifications` object

| field | env | type | default | bounds | meaning |
| --- | --- | --- | --- | --- | --- |
| `quotaNotifications.enabled` | `CODEX_AUTH_QUOTA_NOTIFICATIONS` | boolean | `false` | macOS only | aggregate 5-hour and weekly pool quota alerts via Notification Center |
| `quotaNotifications.autoProtectCredits` | `CODEX_AUTH_AUTO_PROTECT_CREDITS` | boolean | `true` | — | poll usage each `intervalMs` and exclude fully spent subscription quotas from rotation before they spend paid Credits |
| `quotaNotifications.autoRedeemResets` | `CODEX_AUTH_AUTO_REDEEM_RESETS` | boolean | `false` | — | let the poll spend one banked rate-limit reset credit when an account's weekly quota is at or below `autoRedeemResetsBelowPercent` and the server reports the credit applicable now |
| `quotaNotifications.autoRedeemResetsBelowPercent` | `CODEX_AUTH_AUTO_REDEEM_RESETS_BELOW_PERCENT` | number | `10` | 0–100 | weekly quota left (percent) at or below which `autoRedeemResets` spends a credit |
| `quotaNotifications.intervalMs` | `CODEX_AUTH_QUOTA_NOTIFICATIONS_INTERVAL_MS` | number (ms) | `1800000` | 30000–86400000 | quota poll interval |
| `quotaNotifications.notifyEveryCheck` | (file only) | boolean | `false` | — | deliver the aggregate message after every poll, not only on threshold crossings |
| `quotaNotifications.thresholds` | (file only) | number[] | `[25, 10, 0]` | each 0–100 | remaining-percent alert thresholds per window; deduped and sorted most-generous first; `[]` disables threshold alerts |

### What hot-reloads

`loadPluginConfig` runs on the request path, so everything read inside a
request applies to the next request: transform/session fields, retry and
timeout fields, rotation and model pools, unsupported-model policy, and
`perProjectAccounts` (switching scope waits for in-flight requests to drain,
then moves the active pool — the other scope's files are left in place).

The prompt status line polls `quotaStatus`, `quotaDisplay`, `maskEmail`, and
`maskEmailInQuotaDetails`, and the UI runtime (`codexTuiV2`, color profile,
glyphs) re-resolves per command render — display edits take effect within a
couple of seconds, no restart.

Still startup-bound:

- `quotaNotifications`: the monitor's poll stays alive while
  `autoProtectCredits` is on, and in that case `enabled`/`intervalMs`/
  `thresholds`/`notifyEveryCheck` apply at the next tick. If every poll driver
  was off (auto-protect disabled and notifications off or undeliverable), the
  loop stopped — turning it back on needs a restart.
- `sessionRecovery`/`autoResume` (recovery hook) and `autoUpdate` (update
  check) are read when the auth loader initializes; changing them takes a
  restart of the OpenCode session.
- Reloading applies to settings, not plugin code: after upgrading the plugin,
  restart each OpenCode process once to load the new build.

### Retry budgets by profile

`retryProfile` picks the per-class retry budgets; `retryBudgetOverrides`
replaces any single class. Values from `lib/request/retry-budget.ts`.

| profile | authRefresh | network | server | rateLimitShort | rateLimitGlobal | emptyResponse |
| --- | --- | --- | --- | --- | --- | --- |
| `conservative` | 2 | 2 | 2 | 2 | 1 | 1 |
| `balanced` (default) | 4 | 4 | 4 | 4 | 3 | 2 |
| `aggressive` | 8 | 8 | 8 | 8 | 10 | 4 |

A retry that blocks at least 5000 ms costs a full budget unit; shorter waits
accumulate on a per-class carry until they add up to one
(`RETRY_WAIT_BUDGET_UNIT_MS`).

The two rate-limit classes split on a 5000 ms threshold
(`RATE_LIMIT_SHORT_RETRY_THRESHOLD_MS` in `lib/request/rate-limit-backoff.ts`).
A 429's wait is computed from `retry-after` (default 1000 ms, doubling per
consecutive 429, capped at 60 s). A wait of at most 5000 ms on a non-exhausted
quota window consumes `rateLimitShort` and retries the same account; anything
longer, an exhausted window, or a spent `rateLimitShort` budget rotates to the
next account, and when every account is limited the wait-and-retry loop
consumes `rateLimitGlobal`.

### Quota percentage display

`quotaDisplay` (`free` | `used`) rewords every human-readable quota percentage:
the TUI status line and quota details dialog, `codex-limits`, the standalone
`limits` CLI, the interactive account check, and macOS quota notifications.
`free` reports headroom (`5h limit: 88% left`), matching how Codex reports a
quota; `used` reports consumption (`5h limit: 12% used`). Presentation only:
exhaustion, rotation blocks, notification thresholds, warning/danger colours,
and the `usedPercent`/`leftPercent` JSON fields are unchanged.

### Spending Codex credits

A ChatGPT account can hold Codex credits besides its plan's 5-hour and weekly
windows: bought, or granted by OpenAI. Once an account's plan window is used
up, the Codex backend keeps serving it and bills the turn to that balance.
By default the plugin never lets that happen: a spent account is taken out of
rotation until its window resets, so a subscription never costs more than the
subscription.

`spendCredits: true` (env `CODEX_AUTH_SPEND_CREDITS=1`) uses those credits
instead of waiting:

- Plan quota always comes first. Credits are spent only once no account that
  can serve the requested model has plan quota left. An account that is
  merely throttled or cooling down is waited for, not paid around. A seat the
  backend says cannot serve the model does not count, and neither does one
  outside a `strict` `modelAccountPools` entry for that model.
- Only an account whose balance is above zero is used, largest balance first
  (members of the model's account pool before others). The balance is read
  from `/wham/usage` before the first turn is billed to it, and kept current
  from the `x-codex-credits-*` headers on every reply.
- Each request decides again, so the first plan window that resets takes the
  traffic back.
- A credits turn the backend refuses keeps that account out until the reset
  the refusal names.
- A toast says which account is spending credits and how many are left:

  ```text
  Plan quota used up on every account. Spending Codex credits on account 3 (62,500 left).
  ```

When every account is out of plan quota, the error and the waiting countdown
name the accounts that still hold credits, and with the setting off they say
how to turn it on:

```text
All 3 account(s) are rate-limited. Try again in 2d 4h or add another account with `opencode auth login`. Codex credits are still available on account 3 (62,500 credits). Set `"spendCredits": true` in ~/.opencode/openai-codex-auth-config.json (or CODEX_AUTH_SPEND_CREDITS=1) to use them once plan quota runs out.
```

Those balances come from readings already taken (replies, the quota poll,
`codex-limits`); building a message never sends a request. `codex-limits`,
the standalone `limits` command and the `credits` prompt screen show every
account that has a balance.

An account set up for automatic credit top-up is charged real money for a
credits turn. Leave the setting off if that is not what you want.

### Quota notifications

The quota guard polls each distinct enabled account with bounded concurrency
every `intervalMs` (30 minutes by default), even with notifications off, when
`autoProtectCredits` is on. A fully spent 5-hour or weekly subscription window
excludes the account from every model-family rotation until the reported
reset; failed or rate-limited usage queries fail open and never block. A
manual `codex-limits` — or any account the standalone `limits` reads live —
persists an observed exhaustion block immediately.

`autoRedeemResets` (off by default) lets the same poll spend one banked
rate-limit reset credit — the ones `codex-reset` lists — on an account whose
weekly quota is at or below `autoRedeemResetsBelowPercent`, provided the server
reports the credit as applicable now. Only the weekly window triggers it: the
5-hour window refills within hours, the weekly one can lock an account out for
days. A credit clears both windows and cannot be undone. At most one spend is
attempted per account per week across all processes watching the account file
— a claim is stamped under the storage lock before the credit is consumed —
so two hosts holding the same low reading cannot each burn a credit, and a
credit that fails to redeem is not retried until the next restart.

When `enabled` is on, each threshold alerts once per window until the window
rises above it after a reset. Each line reports the account with the most
headroom in that window plus that same account's reset time; when another
account recovers earlier, that reset is appended as a separate `another
account resets ...` clause. `notifyEveryCheck: true` delivers the aggregate
after every poll; `thresholds: []` disables threshold alerts. Delivery state
lives in `oc-codex-multi-auth-quota-notifications.json` beside the active
accounts file, so concurrent OpenCode processes in one scope alert once.
Delivery uses macOS `osascript`; the feature is unavailable on Windows and
Linux. If macOS blocks the alert, allow notifications for the process shown in
**System Settings > Notifications**.

### Model account pools

`modelAccountPools` pins an effective (post-normalization) model to stable
account or Business-seat identities; `modelAccountPoolModes` sets each
mapping's policy (`preferred` default, or `strict`). Use the `codex-pool` tool
to manage pools with 1-based account numbers — it persists stable IDs:

```text
codex-pool action="set" model="gpt-5.6-sol" accounts=[7,8]
codex-pool action="set-mode" model="gpt-5.6-sol" poolMode="strict"
```

Also supports `status` (default), `add`, `remove`, `clear`, `dryRun=true`, and
JSON output. Mutations hot-reload on the next request. The config file is
global while account storage is per-project by default, so references
unavailable in the current project are reported but not pruned. Routing
diagnostics expose `general`, `preferred`, `general-fallback`, `strict`, or
`strict-unavailable`.

### Unsupported-model policy and fallback chains

`unsupportedCodexPolicy` is `strict` by default: entitlement errors are
returned as-is, **except** the always-on auto-fallbacks for default selector
ids (below). Set `"fallback"` to retry down the chain after account/workspace
attempts are exhausted; `unsupportedCodexFallbackChain` overrides the chain
per model.

Default chains (each row is the tail of the general order
`gpt-6-astra > gpt-6.1-sol > gpt-6-sol > gpt-5.6-sol > gpt-5.6-terra > gpt-5.5 >
gpt-6-luna > gpt-5.6-luna` after its own model):

- `gpt-6-astra → gpt-6.1-sol → gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna`
- `gpt-6.1-sol → gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna`
- `gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna`
- `gpt-5.6-sol → gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna`
- `gpt-5.6-terra → gpt-5.5 → gpt-6-luna → gpt-5.6-luna`
- `gpt-5.5 → gpt-6-sol → gpt-6.1-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-6-luna → gpt-5.6-luna`
- `gpt-6-luna → gpt-5.6-luna → gpt-6.1-sol → gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-5.5`
- `gpt-5.6-luna → gpt-6-luna → gpt-6.1-sol → gpt-6-sol → gpt-5.6-sol → gpt-5.6-terra → gpt-5.5`
- `gpt-5-codex → gpt-5.6-terra → gpt-5.6-luna`
- `gpt-5.4 → gpt-6-sol → gpt-5.6-terra → gpt-5.6-luna` (the successor its catalog entry names)
- `gpt-5.4-mini`, `gpt-5.4-nano → gpt-6-luna → gpt-5.6-luna`
- `gpt-5.4-pro → gpt-6-sol → gpt-5.6-terra → gpt-5.6-luna` (manual selection only)
- `gpt-5.3-codex → gpt-5-codex → gpt-5.2-codex` (the last edge needs `fallbackToGpt52OnUnsupportedGpt53`, default on)
- `gpt-5.3-codex-spark → gpt-5-codex → gpt-5.3-codex → gpt-5.2-codex`
- `gpt-5.2-codex → gpt-5-codex`, `gpt-5.1-codex → gpt-5-codex`
- `gpt-5.1-codex-max → gpt-5.6-sol → gpt-5.6-terra → gpt-5.6-luna`
- `gpt-5.1-codex-mini → gpt-5.6-terra → gpt-5.6-luna`

Auto-fallback for default selectors (runs even under `strict`, for entitlement
gates and for upstream rate/quota blocks on the requested model; opt out with
`=1`): `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK` covers the GPT-6-tier ids,
`CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK` the 5.6 tiers,
`CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK` `gpt-5.5`, and
`CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK` `gpt-5-codex`. The continuation
models `gpt-5.4`/`gpt-5.4-mini` only auto-fallback when the request already
rode in on an entry id; a directly selected non-entry id stays strict. For upstream blocks
the fallback only moves to a model with an eligible account under that pool's
policy — an unavailable strict pool stays a strict-pool error — and a shared
subscription block follows the account to every model, so changing models
cannot bypass it. A single request hops across at most 7 quota-exhausted
models (`MAX_QUOTA_FALLBACK_SWITCHES` in `lib/constants.ts`).

Custom chain example:

```json
{
  "unsupportedCodexPolicy": "fallback",
  "unsupportedCodexFallbackChain": {
    "gpt-5.5": ["gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-5.6-luna"],
    "gpt-5-codex": ["gpt-5.6-terra", "gpt-5.6-luna"]
  }
}
```

The TUI can keep showing the originally selected model while fallback applies
internally; check request logs (`request-*-after-transform.json`) for the
effective upstream model. Set `CODEX_PLUGIN_LOG_BODIES=1` to inspect raw
`.body.*` fields.

### Pool-wide quota status

By default the prompt status line describes the account that served the last
request. Set `quotaStatus.mode` to `overview` to describe the whole pool on
one line instead:

```json
{ "quotaStatus": { "mode": "overview" } }
```

```text
24%: #1 87%, #2 0% 3d, #3 88%
```

The leading figure is the pool total — a **weighted** mean keyed on each
account's plan allotment (see [plan allotments](plan-allotments.md)). Each
account appears by its 1-based `codex-list` number and the window with the
least headroom left; a `3d`-style reset time prints only for an account at or
below 25% headroom (`resetTimes` changes that). Percentages follow
[`quotaDisplay`](#quota-percentage-display). The whole object is read from the
config file only — it is a display preference that belongs to a person, so
there is no environment override for any field in it.

#### What the line says

| Field | Default | Effect |
| --- | --- | --- |
| `layout` | `accounts` | `accounts` gives one segment per account; `aggregate` collapses accounts sharing a percentage; `count` gives `24%: 3 accounts`; `total` shows only the pool percentage plus enabled extras |
| `accountNames` | `number` | `number` gives `#1`; `label` gives the `codex-label` label or the email's local part; `none` drops the name |
| `order` | `number` | `number`, `most-used`, `least-used`, `renewing-earliest`, `renewing-latest` |
| `multipliers` | `false` | `5x` / `20x` plan allotment badges |
| `allotment` | `false` | `24% of 26x` — what the pool the percentage is averaged over adds up to |
| `resetTimes` | `low` | `never`, `low` (accounts at or below 25% headroom), or `always` |
| `resetCredits` | `false` | `1r` for banked rate-limit resets redeemable now |
| `recovery` | `false` | `true` shows the next capacity gain with the display-direction sign; `"all"` shows all known gains with a positive capacity-return sign |
| `resetsMinUsedPercent` | `100` | minimum total weighted usage (0–100) for the `resets` screen, independent of `quotaDisplay` |

With everything on:

```text
24% of 26x: #1 5x 87%, #2 20x 0% 3d 1r, #3 1x 88%, +3% in 2d
```

`layout: "aggregate"` prints a shared percentage once, then only what differs:

```text
72%: 12% 3d, 50% 4d, 100% 3d 1r 4d 5d
```

`recovery: "all"` is a chronological forecast: each `+N%` is **incremental
percentage points of pool capacity returned at that timestamp**, summed when
gains share a displayed countdown (`+7% in 5d, +24% in 5d, +2% in 5d` becomes
`+33% in 5d`), chronological and always positive — even under
`quotaDisplay: "used"`.

#### Rotating between screens

`mode` accepts a list; the line alternates between the entries every
`rotateMs` (default 5000, minimum 1000):

```json
{ "quotaStatus": { "mode": ["overview", "resets", "credits"], "rotateMs": 5000 } }
```

A screen with nothing to say is skipped rather than shown blank — which is
what makes `resets` worth leaving in permanently. By default it renders only
once **every readable** account is spent; lower `resetsMinUsedPercent` to show
it earlier. The `resets` page lists only accounts with applicable banked
reset credits, latest reset first:

```text
Free resets: 6d 1r damian@nowaker.net, 4d 2r work@example.com
```

It honours `maskEmail`, shortens through a degradation ladder as space
shrinks, and never redeems a credit itself.

The `credits` page is the same idea for the other way out of a spent pool:
under the same threshold, it lists the accounts that still hold Codex
credits, largest balance first:

```text
Codex credits: 62,500 damian@nowaker.net, 1,200 work@example.com
```

It only shows what is there; `spendCredits` decides whether those credits are
used.

#### Rows and visibility

`rows` (1–4, default 1) is a **ceiling, not a height**: a rendering that fits
one row still takes one, so raising it costs nothing on a wide terminal and
buys the whole line back on a narrow one. Rows break only at the `, ` between
accounts. The line degrades gracefully as space shrinks: recovery and
allotment first, then badges and reset credits, then countdowns, then names,
then the per-account breakdown, and finally the pool total alone.

`showFor` is `always` by default — the line shows whenever accounts are
configured. `codex-models` shows it only while the session runs a model this
plugin routes; a session that has not run anything yet still shows the line.

#### Where the numbers come from

Pool quota is read from `/wham/usage` on a five-minute interval and cached at
`oc-codex-multi-auth-tui-quota-overview.json` in the OpenCode state directory
(`OPENCODE_STATE_DIR` overrides it), so several OpenCode windows share one
round of requests. The account currently serving requests is refreshed from
response headers after every response and folded into the cached pool.

### Beginner safe mode

`beginnerSafeMode` (`true` or `CODEX_AUTH_BEGINNER_SAFE_MODE=1`) is for
beginners who prefer quick failures and clear recovery over long retry loops.
It forces `retryProfile` to `conservative`, empties `retryBudgetOverrides`,
sets `retryAllAccountsRateLimited` to `false`, and caps
`retryAllAccountsMaxRetries` at `1`.

### Environment variables without a config field

These have no counterpart in `openai-codex-auth-config.json`; set them in the
process environment. Same `"1"`-only truthy rule for booleans unless noted.

| variable | meaning |
| --- | --- |
| `CODEX_AUTH_ACCOUNT_ID` | pin requests to one workspace/account id (trimmed, max 256 chars; blank or longer values are ignored) |
| `OPENAI_BASE_URL` | route ChatGPT OAuth inference through an OpenAI-compatible gateway; requires `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` |
| `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` | explicitly allow the gateway to receive the OAuth access token. The URL must be absolute, carry no credentials/query/fragment, and use `https://` unless the host is a literal loopback IP, where `http://` is accepted |
| `CODEX_AUTH_CLIENT_IDENTITY` | force one client identity for all models: `codex` (`originator: codex_cli_rs`), `opencode` or alias `host` (`originator: opencode`). Default: `opencode` for responses-lite models, `codex` otherwise |
| `CODEX_AUTH_CLIENT_VERSION` | Codex CLI version advertised in the `codex_cli_rs` User-Agent (built-in default `0.144.0`) |
| `CODEX_AUTH_HOST_VERSION` | opencode version advertised in the `opencode` User-Agent (default: the host's own UA version, else a baked-in fallback) |
| `CODEX_AUTH_DISABLE_CODEX_USER_AGENT=1` | keep the host runtime's `User-Agent` instead of the identity's |
| `CODEX_AUTH_SEND_ORGANIZATION_HEADER=1` | restore legacy `openai-organization` request pinning (off by default; upstream Codex never sends it) |
| `CODEX_AUTH_PREWARM=0` | disable the startup prewarm that runs when `requestTransformMode` is `legacy` (on by default; native mode does not prewarm) |
| `CODEX_AUTH_SYNC_CODEX_CLI=0` | disable hydrating accounts from Codex CLI `~/.codex` storage (on by default) |
| `CODEX_KEYCHAIN=1` | opt in to OS-native keychain account storage instead of the JSON accounts file; on Windows, Credential Manager's blob-size cap means an oversized pool is size-checked and stays on the JSON path |
| `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL` | legacy boolean env → `unsupportedCodexPolicy` (`1` → `fallback`, anything else → `strict`); evaluated only when neither the policy env nor the config key is set |
| `CODEX_RETRY_ALL_UNBOUNDED=1` | remove the 10-minute interactive ceiling on `retryAllAccountsMaxWaitMs: 0`, restoring truly unbounded all-accounts-limited waits (upstream quota blocks can stretch for days) |
| `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` | same as the `fallbackToGpt52OnUnsupportedGpt53` field (listed here because it predates the config key) |
| `CODEX_THREAD_ID` | optional correlation / prompt-cache seed attached to outbound Codex requests |
| `CODEX_COLLABORATION_MODE` | collaboration mode hint for request shaping: `plan` or `default`; `OPENCODE_COLLABORATION_MODE` is accepted as an alias (`CODEX_` wins) |
| `OPENCODE_CODEX_PROMPT_URL` | override the OpenCode→Codex bridge prompt catalog URL (legacy transform) |
| `OPENCODE_SKIP_EMAIL_HYDRATE=1` | skip account email hydrate during account-manager bootstrap |
| `FORCE_INTERACTIVE_MODE=1` | force interactive menu paths even when the host looks non-interactive |
| `OPENCODE_TUI` / `OPENCODE_DESKTOP` | `=1` marks the session non-interactive; normally set by the host, not by you |
| `OPENCODE_STATE_DIR` | override the OpenCode state dir used for the TUI quota cache files (default `~/.local/state/opencode`) |
| `ENABLE_PLUGIN_REQUEST_LOGGING=1` | log request metadata to `~/.opencode/logs/codex-plugin/` (no raw bodies) |
| `CODEX_PLUGIN_LOG_BODIES=1` | include raw request/response bodies in log files (sensitive) |
| `DEBUG_CODEX_PLUGIN=1` | enable debug logging |
| `CODEX_PLUGIN_LOG_LEVEL` | `debug`, `info`, `warn`, `error` (default `info`; unrecognized values fall back to `info`) |
| `CODEX_CONSOLE_LOG=1` | also mirror plugin logs to the console |

### Advanced / power-user environment variables

Host-level vars you may see referenced, for completeness:

| variable | meaning |
| --- | --- |
| `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT` | **host** OpenCode vars that inject config at process start; the plugin does not read them, but OpenCode merges them the same way it merges `opencode.json` |
| `OC_CODEX_TEST_HOME`, `VITEST`, `NODE_ENV` | test-harness knobs; setting them outside the test suite only breaks storage-path safety checks |

---

## Config patterns

### Global options

```json
{
  "plugin": ["oc-codex-multi-auth"],
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "high",
        "textVerbosity": "high",
        "store": false
      }
    }
  }
}
```

### Per-model options

Model options override global options:

```json
{
  "provider": {
    "openai": {
      "options": { "reasoningEffort": "medium", "store": false },
      "models": {
        "gpt-5.5-fast": {
          "name": "fast gpt-5.5",
          "options": { "reasoningEffort": "low" }
        },
        "gpt-5.6-sol": {
          "name": "GPT 5.6 Sol (OAuth)",
          "options": { "reasoningEffort": "high" }
        }
      }
    }
  }
}
```

### Project-specific

Global config lives at `~/.config/opencode/opencode.json`. A project override
(`<project>/.opencode.json`) can set a default model or per-project provider
options without changing the global install.

### Selecting models

```bash
# compact modern selectors (--modern install)
opencode run "task" --model=openai/gpt-5.5 --variant=medium
opencode run "task" --model=openai/gpt-5.6-sol --variant=high

# explicit selector ids (--full or --legacy)
npx -y oc-codex-multi-auth@latest --full
opencode run "task" --model=openai/gpt-5.5-medium
opencode run "task" --model=openai/gpt-5.6-sol-high
```

Use `opencode debug config` to confirm merged model entries.

---

## File locations

| Path | Purpose |
| --- | --- |
| `~/.config/opencode/opencode.json` | OpenCode provider/plugin config |
| `~/.config/opencode/tui.json` | OpenCode TUI plugin config |
| `~/.opencode/openai-codex-auth-config.json` | plugin runtime config (this page) |
| `$XDG_DATA_HOME/opencode/auth.json` (`~/.local/share/opencode/auth.json` by default) | OpenCode OAuth tokens |
| `~/.opencode/oc-codex-multi-auth-accounts.json` | global V3 account pool |
| `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` | per-project account pool |
| `~/.opencode/projects/<project-key>/oc-codex-multi-auth-flagged-accounts.json` | flagged/deactivated account metadata, always written beside the active accounts file (so `~/.opencode/oc-codex-multi-auth-flagged-accounts.json` when project storage is off) |
| `~/.opencode/backups/codex-credential-snapshot-*.json` | pre-write credential snapshots, in the `backups/` directory beside the accounts file they cover. Mode `0600` in a `0700` directory on POSIX; Windows uses the profile ACLs instead |
| `~/.local/state/opencode/oc-codex-multi-auth-tui-quota*.json` | TUI quota caches shared by the provider and TUI plugins (`OPENCODE_STATE_DIR` overrides the directory) |
| `~/.opencode/logs/codex-plugin/` | plugin request/debug logs |

## Related

- [tools-and-cli.md](tools-and-cli.md)
- [getting-started.md](getting-started.md)
- [troubleshooting.md](troubleshooting.md)
- [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md)
- [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md)

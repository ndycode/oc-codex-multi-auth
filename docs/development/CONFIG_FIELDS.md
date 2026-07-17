# Config Fields

This document summarizes the current config fields that matter for `oc-codex-multi-auth`.

## Top-Level Fields

### `plugin`

Use the plain package name in OpenCode config:

```json
{
  "plugin": ["oc-codex-multi-auth"]
}
```

The installer normalizes to this unpinned value on purpose.

### `model`

Sets the default selected model. Compact modern installs use base IDs plus OpenCode variants:

```json
{
  "model": "openai/gpt-5.5"
}
```

With `--full` or `--legacy`, explicit preset IDs also work:

```json
{
  "model": "openai/gpt-5.5-medium"
}
```

## `provider.openai.options`

These are the global defaults the plugin receives for every OpenAI request.

Common fields:

| Field | Purpose |
|------|---------|
| `reasoningEffort` | default reasoning depth |
| `reasoningSummary` | reasoning summary style |
| `textVerbosity` | output verbosity |
| `include` | extra response fields, typically `reasoning.encrypted_content` |
| `store` | must stay `false` for this plugin |

Example:

```json
{
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

## `provider.openai.models`

This field differs slightly between the modern and legacy shipped templates.

### Modern template fields

Modern templates define 12 base model families and expose 53 presets through `variants`.

Example:

```json
{
  "provider": {
    "openai": {
      "models": {
        "gpt-5.5": {
          "name": "GPT 5.5 (OAuth)",
          "limit": {
            "context": 1050000,
            "output": 128000
          },
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "variants": {
            "none": { "reasoningEffort": "none" },
            "medium": { "reasoningEffort": "medium" },
            "xhigh": { "reasoningEffort": "xhigh" }
          }
        },
        "gpt-5.6-sol": {
          "name": "GPT 5.6 Sol (OAuth)",
          "limit": {
            "context": 1050000,
            "output": 128000
          },
          "variants": {
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" },
            "xhigh": { "reasoningEffort": "xhigh" },
            "max": { "reasoningEffort": "max" },
            "ultra": { "reasoningEffort": "ultra" }
          }
        }
      }
    }
  }
}
```

Important fields:

| Field | Purpose |
|------|---------|
| model key (`gpt-5.5`, `gpt-5.6-sol`, …) | base model family exposed to OpenCode |
| `name` | human-readable picker label |
| `limit` | context/output metadata shown to OpenCode |
| `modalities` | allowed input/output types |
| `variants` | reasoning/verbosity presets selected with `--variant` |
| `options` | per-model defaults when needed |

If your OpenCode release exposes bare base entries, modern selection looks like:

```bash
opencode run "task" --model=openai/gpt-5.5 --variant=high
opencode run "task" --model=openai/gpt-5.6-sol --variant=medium
```

### Legacy template fields

Legacy templates expose each preset as its own model key (53 explicit entries).

Example:

```json
{
  "provider": {
    "openai": {
      "models": {
        "gpt-5.5-high": {
          "name": "GPT 5.5 High (OAuth)",
          "limit": {
            "context": 1050000,
            "output": 128000
          },
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "options": {
            "reasoningEffort": "high",
            "reasoningSummary": "detailed",
            "textVerbosity": "medium",
            "include": ["reasoning.encrypted_content"],
            "store": false
          }
        }
      }
    }
  }
}
```

Legacy selection example:

```bash
opencode run "task" --model=openai/gpt-5.5-high
```

## Model Normalization

The plugin normalizes selected model IDs before the upstream API call.

Examples:

| Selected model | Effective upstream family |
|------|---------|
| `openai/gpt-5.5` + variant `medium` | `gpt-5.5` |
| `openai/gpt-5.5-medium` | `gpt-5.5` |
| `openai/gpt-5.6-sol` + variant `high` | `gpt-5.6-sol` |
| `openai/gpt-5.6-sol-xhigh` | `gpt-5.6-sol` |
| `openai/gpt-5.6` | `gpt-5.6-sol` |
| `openai/gpt-5.6-terra-medium` | `gpt-5.6-terra` |
| `openai/gpt-5.6-luna-max` | `gpt-5.6-luna` |
| `openai/gpt-5.4-mini-xhigh` | `gpt-5.4-mini` |
| `openai/gpt-5.1-codex-high` | `gpt-5.1-codex` |
| `openai/gpt-5-mini` | `gpt-5.4-mini` |
| `openai/gpt-5-nano` | `gpt-5.4-nano` |

This normalization is why legacy aliases and snapshot-like IDs can still route to a stable family while preserving the user-facing config surface. GPT-5.6 tiers also trigger the responses-lite request shape after normalization.

## Plugin Runtime Config

Path: `~/.opencode/openai-codex-auth-config.json`

Defaults come from `lib/config.ts` / `lib/schemas.ts`. Environment overrides win over file values. Boolean env values are truthy only for `"1"`.

| Field | Default | Env override | Purpose |
|------|---------|--------------|---------|
| `codexMode` | `true` | `CODEX_MODE` | Legacy bridge prompt behavior when `requestTransformMode=legacy` |
| `requestTransformMode` | `native` | `CODEX_AUTH_REQUEST_TRANSFORM_MODE` | `native` preserves host payload; `legacy` rewrites for older SDKs |
| `codexTuiV2` | `true` | `CODEX_TUI_V2` | Codex-style terminal UI output |
| `codexTuiColorProfile` | `truecolor` | `CODEX_TUI_COLOR_PROFILE` | `truecolor` / `ansi256` / `ansi16` |
| `codexTuiGlyphMode` | `ascii` | `CODEX_TUI_GLYPHS` | `ascii` / `unicode` / `auto` |
| `maskEmail` | `false` | `CODEX_TUI_MASK_EMAIL` | Mask account emails on display surfaces |
| `maskEmailInQuotaDetails` | `false` | `CODEX_TUI_MASK_EMAIL_DETAILS` | Also mask email in quota details |
| `beginnerSafeMode` | `false` | `CODEX_AUTH_BEGINNER_SAFE_MODE` | Conservative retries and recovery |
| `fastSession` | `false` | `CODEX_AUTH_FAST_SESSION` | Force low-latency reasoning/verbosity |
| `fastSessionStrategy` | `hybrid` | `CODEX_AUTH_FAST_SESSION_STRATEGY` | `hybrid` or `always` |
| `fastSessionMaxInputItems` | `30` | `CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS` | Max input items kept in fast mode |
| `rotationStrategy` | `hybrid` | `CODEX_AUTH_ROTATION_STRATEGY` | `hybrid`, `sticky`, or `round-robin` account selection |
| `modelAccountPools` | `{}` | (file only) | Preferred stable account IDs per effective model |
| `retryProfile` | `balanced` | `CODEX_AUTH_RETRY_PROFILE` | `conservative` / `balanced` / `aggressive` |
| `retryBudgetOverrides` | `{}` | (file only) | Per-class budget overrides |
| `retryAllAccountsRateLimited` | `true` | `CODEX_AUTH_RETRY_ALL_RATE_LIMITED` | Wait/retry when every account is limited |
| `retryAllAccountsMaxWaitMs` | `0` | `CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS` | Max wait ms (`0` = unlimited) |
| `retryAllAccountsMaxRetries` | `Infinity` | `CODEX_AUTH_RETRY_ALL_MAX_RETRIES` | Max all-account retries |
| `unsupportedCodexPolicy` | `strict` | `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY` | `strict` or `fallback` |
| `fallbackOnUnsupportedCodexModel` | `false` | `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL` | Legacy fallback toggle |
| `fallbackToGpt52OnUnsupportedGpt53` | `true` | `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` | Legacy 5.3→5.2 edge |
| `unsupportedCodexFallbackChain` | `{}` | (file only) | Per-model fallback chain overrides |
| `tokenRefreshSkewMs` | `60000` | `CODEX_AUTH_TOKEN_REFRESH_SKEW_MS` | Refresh tokens this many ms before expiry |
| `rateLimitToastDebounceMs` | `60000` | `CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS` | Debounce rate-limit toasts |
| `toastDurationMs` | `5000` | `CODEX_AUTH_TOAST_DURATION_MS` | Toast visibility duration |
| `perProjectAccounts` | `true` | `CODEX_AUTH_PER_PROJECT_ACCOUNTS` | Project-scoped account pools |
| `sessionRecovery` | `true` | `CODEX_AUTH_SESSION_RECOVERY` | Auto-recover common API errors |
| `autoResume` | `true` | `CODEX_AUTH_AUTO_RESUME` | Auto-resume after thinking-block recovery |
| `autoUpdate` | `true` | `CODEX_AUTH_AUTO_UPDATE` | Daily npm update check + cache refresh |
| `parallelProbing` | `false` | `CODEX_AUTH_PARALLEL_PROBING` | Concurrent account health probes |
| `parallelProbingMaxConcurrency` | `2` | `CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY` | Max concurrent probes (1–5) |
| `emptyResponseMaxRetries` | `2` | `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES` | Retries after empty SSE bodies |
| `emptyResponseRetryDelayMs` | `1000` | `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS` | Delay between empty-response retries |
| `pidOffsetEnabled` | `false` | `CODEX_AUTH_PID_OFFSET_ENABLED` | Small PID-based hybrid score offset for multi-process spread |
| `fetchTimeoutMs` | `60000` | `CODEX_AUTH_FETCH_TIMEOUT_MS` | Upstream fetch timeout |
| `streamStallTimeoutMs` | `45000` | `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS` | SSE stall abort timeout |

### `modelAccountPools`

The plugin runtime config can map effective model IDs to preferred stable account IDs:

```json
{
  "modelAccountPools": {
    "gpt-5.6-sol": ["org-example-account-id"],
    "gpt-5.5": ["org-another-account-id"]
  }
}
```

The request pipeline resolves the pool after model normalization. All rotation
strategies restrict selection to healthy accounts in the preferred pool while
one is available. If the configured IDs are unknown or every preferred account
is disabled, cooling down, rate-limited, or locally depleted, selection falls
back to the general account pool. Empty lists and unmapped models use the
general pool directly.

`codex-pool` is the supported mutation surface. It accepts 1-based account
numbers for `set`, `add`, and `remove`, but resolves and atomically persists
only stable account IDs. `clear` removes a model mapping, and every mutation
supports a dry-run preview. Writes preserve unrelated raw config fields and
refuse to replace malformed JSON or an invalid existing pool.

The config file is global while account storage is per-project by default.
Consequently, status may report unresolved references for the current project;
the tool does not automatically prune them because they may be valid elsewhere.

## Verification Notes

Use these commands when validating config fields.

### Compact modern (default install)

```bash
opencode debug config
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "ping" --model=openai/gpt-5.5 --variant=medium
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "ping" --model=openai/gpt-5.6-sol --variant=medium
```

### Full / legacy explicit selectors

```bash
npx -y oc-codex-multi-auth@latest --full
opencode debug config
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "ping" --model=openai/gpt-5.5-medium
```

Important behavior:

- `opencode debug config` shows merged config-defined models and variants.
- Default compact installs expose base OAuth entries such as `gpt-5.5`, `gpt-5.5-fast`, and `gpt-5.6-sol`.
- Bare `openai/gpt-5.5` works with `--variant=medium` on compact modern installs.
- Explicit IDs such as `openai/gpt-5.5-medium` require `--full` or `--legacy` unless you added them manually.
- Do not use `gpt-5.5-medium` for verification unless the full/legacy catalog is installed.

## Advanced / non-schema environment variables

Not part of `PluginConfigSchema`, but used by runtime modules:

| Env | Effect |
|-----|--------|
| `CODEX_THREAD_ID` | Optional correlation / prompt-cache seed on outbound requests |
| `OPENCODE_CODEX_PROMPT_URL` | Override OpenCode→Codex bridge prompt catalog URL (legacy transform) |
| `OPENCODE_SKIP_EMAIL_HYDRATE=1` | Skip email hydrate during account bootstrap |
| `FORCE_INTERACTIVE_MODE=1` | Force interactive menu paths for tests/special shells |
| `CODEX_AUTH_SYNC_CODEX_CLI=0` | Disable `~/.codex` account hydrate (on unless `"0"`) |
| `CODEX_CONSOLE_LOG=1` | Mirror plugin logs to console |
| `CODEX_COLLABORATION_MODE` / `OPENCODE_COLLABORATION_MODE` | Collaboration mode hint for request shaping |
| `OPENCODE_STATE_DIR` | Override state directory for TUI quota cache |

## Account Metadata Fields

Account storage also includes user-facing metadata fields used by the `codex-*` tools:

| Field | Purpose |
|------|---------|
| `accountLabel` | display label |
| `accountTags` | grouping/filter tags |
| `accountNote` | short reminder text |

These fields are updated by `codex-label`, `codex-tag`, and `codex-note`.

## See Also

- [CONFIG_FLOW.md](./CONFIG_FLOW.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [../../docs/configuration.md](../../configuration.md)

# Configuration Reference

Complete reference for configuring `oc-codex-multi-auth`. Most of this is optional; the defaults work for most people.

---

## Base Configuration

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

---

## Model Options

### Reasoning Effort

controls how much thinking the model does.

| model | supported values |
|-------|------------------|
| `gpt-5.5` | none, low, medium, high, xhigh |
| `gpt-5.5-fast` | none, low, medium, high, xhigh |
| `gpt-5.4` | none, low, medium, high, xhigh |
| `gpt-5.4-mini` | none, low, medium, high, xhigh |
| `gpt-5.4-pro` | low, medium, high, xhigh (optional/manual model) |
| `gpt-5-codex` | low, medium, high (default: high) |
| `gpt-5.3-codex` | low, medium, high, xhigh (legacy alias to `gpt-5-codex`) |
| `gpt-5.3-codex-spark` | low, medium, high, xhigh (entitlement-gated legacy alias; add manually) |
| `gpt-5.2-codex` | low, medium, high, xhigh (legacy alias to `gpt-5-codex`) |
| `gpt-5.1-codex-max` | low, medium, high, xhigh |
| `gpt-5.1-codex` | low, medium, high |
| `gpt-5.1-codex-mini` | medium, high |
| `gpt-5.1` | none, low, medium, high |

The shipped config templates include 9 base model families and 36 shipped presets overall (36 modern variants or 36 legacy explicit entries). The default installer uses the compact modern template so the TUI model picker shows base OAuth model families and the separate variant picker selects the reasoning preset. Use `--full` to install explicit selector IDs too. `gpt-5.5-pro` is ChatGPT-only (not routed by this plugin), while `gpt-5.3-codex-spark` remains a manual add-on for entitled workspaces only.
For context sizing, shipped templates use:
- `gpt-5.5` and `gpt-5.5-fast`: `context=1050000`, `output=128000`
- `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, and `gpt-5.1-codex-mini`: `context=400000`, `output=128000`
- `gpt-5.1`: `context=272000`, `output=128000`

model normalization aliases:
- `gpt-5.5*`, `gpt-5.5-fast*`, and user-typed `gpt-5.5-pro*` normalize to the public Codex model id `gpt-5.5`
- legacy `gpt-5` maps to `gpt-5.5`; legacy `gpt-5-mini` / `gpt-5-nano` map to `gpt-5.4-mini` / `gpt-5.4-nano`
- snapshot ids `gpt-5.4-2026-03-05*`, `gpt-5.4-mini-2026-03-05*`, and `gpt-5.4-pro-2026-03-05*` map to stable `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.4-pro`
- `opencode debug config` is the reliable way to confirm merged custom/template model entries; default installs expose compact entries like `gpt-5.5` and `gpt-5.5-fast`, while `--full` also exposes explicit entries like `gpt-5.5-medium`, `gpt-5.5-fast-medium`, and `gpt-5.5-high`

if your OpenCode runtime supports global compaction tuning, you can set:
- `model_context_window = 1000000`
- `model_auto_compact_token_limit = 900000`

selector note:
- the default installer is optimized for the TUI model picker: choose a base `(OAuth)` model, then choose a variant
- install with `--full` when you need direct selector IDs such as `openai/gpt-5.5-medium` or `openai/gpt-5.5-fast-medium`

what they mean:
- `none` - no reasoning phase (base general-purpose families only; pro families such as `gpt-5.4-pro` ultimately coerce it to `medium`)
- `low` - light reasoning, fastest
- `medium` - balanced (default)
- `high` - deep reasoning
- `xhigh` - max depth for complex tasks (default for legacy `gpt-5.3-codex` / `gpt-5.2-codex` aliases and `gpt-5.1-codex-max`; available for `gpt-5.5`, `gpt-5.5-fast`, `gpt-5.4`, and optional `gpt-5.4-pro`)

### Reasoning Summary

| value | what it does |
|-------|--------------|
| `auto` | adapts automatically (default) |
| `concise` | short summaries |
| `detailed` | verbose summaries |

legacy `off`/`on` values are accepted from old configs but normalized to `auto` at request time.

### Text Verbosity

| value | what it does |
|-------|--------------|
| `low` | concise responses |
| `medium` | balanced (default) |
| `high` | verbose responses |

### Include

array of extra response fields.

| value | why you need it |
|-------|-----------------|
| `reasoning.encrypted_content` | required for multi-turn with `store: false` |

### Store

| value | what it does |
|-------|--------------|
| `false` | stateless mode (required for this plugin) |
| `true` | not supported by codex api |

---

## Plugin Config

advanced settings go in `~/.opencode/openai-codex-auth-config.json`:

```json
{
  "requestTransformMode": "native",
  "codexMode": true,
  "codexTuiV2": true,
  "codexTuiColorProfile": "truecolor",
  "codexTuiGlyphMode": "ascii",
  "maskEmail": false,
  "maskEmailInQuotaDetails": false,
  "beginnerSafeMode": false,
  "fastSession": false,
  "fastSessionStrategy": "hybrid",
  "fastSessionMaxInputItems": 30,
  "retryProfile": "balanced",
  "retryBudgetOverrides": {
    "network": 2,
    "server": 2
  },
  "perProjectAccounts": true,
  "autoUpdate": true,
  "toastDurationMs": 5000,
  "retryAllAccountsRateLimited": true,
  "retryAllAccountsMaxWaitMs": 0,
  "retryAllAccountsMaxRetries": 3,
  "unsupportedCodexPolicy": "strict",
  "fallbackOnUnsupportedCodexModel": false,
  "fallbackToGpt52OnUnsupportedGpt53": true,
  "unsupportedCodexFallbackChain": {
    "gpt-5.4-pro": ["gpt-5.4"],
    "gpt-5-codex": ["gpt-5.2-codex"]
  }
}
```

The sample above intentionally sets `"retryAllAccountsMaxRetries": 3` as a bounded override; the default remains `Infinity` when the key is omitted.

### Options

| option | default | what it does |
|--------|---------|--------------|
| `requestTransformMode` | `native` | request shaping mode: `native` keeps OpenCode payloads unchanged; `legacy` enables Codex compatibility rewrites |
| `codexMode` | `true` | legacy-only bridge prompt behavior (applies when `requestTransformMode=legacy`) |
| `codexTuiV2` | `true` | enables codex-style terminal ui output (set `false` to keep legacy output) |
| `codexTuiColorProfile` | `truecolor` | terminal color profile for codex ui (`truecolor`, `ansi256`, `ansi16`) |
| `codexTuiGlyphMode` | `ascii` | glyph set for codex ui (`ascii`, `unicode`, `auto`) |
| `maskEmail` | `false` | masks the active account email in the TUI prompt quota status only |
| `maskEmailInQuotaDetails` | `false` | also masks the active account email in the quota details dialog when `maskEmail` is enabled |
| `beginnerSafeMode` | `false` | enables conservative beginner-safe runtime behavior for retries and recovery |
| `fastSession` | `false` | forces low-latency settings per request (`reasoningEffort=none/low`, `reasoningSummary=auto`, `textVerbosity=low`) |
| `fastSessionStrategy` | `hybrid` | `hybrid` speeds simple turns and keeps full-depth for complex prompts; `always` forces fast mode every turn |
| `fastSessionMaxInputItems` | `30` | max input items kept when fast mode is applied |
| `retryProfile` | `balanced` | retry budget profile for request classes (`conservative`, `balanced`, `aggressive`) |
| `retryBudgetOverrides` | `{}` | optional per-class budget overrides (`authRefresh`, `network`, `server`, `rateLimitShort`, `rateLimitGlobal`, `emptyResponse`) |
| `perProjectAccounts` | `true` | each project gets its own account storage |
| `autoUpdate` | `true` | check npm daily and clear the OpenCode-managed plugin cache on exit when a newer version is available; restart OpenCode to install it |
| `toastDurationMs` | `5000` | how long toast notifications stay visible (ms) |
| `retryAllAccountsRateLimited` | `true` | wait and retry when all accounts hit rate limits |
| `retryAllAccountsMaxWaitMs` | `0` | max wait time in ms (0 = unlimited) |
| `retryAllAccountsMaxRetries` | `Infinity` | max retry attempts (omit this key for unlimited retries) |
| `unsupportedCodexPolicy` | `strict` | unsupported-model behavior: `strict` (return entitlement error) or `fallback` (retry with configured fallback chain) |
| `fallbackOnUnsupportedCodexModel` | `false` | legacy fallback toggle mapped to `unsupportedCodexPolicy` (prefer using `unsupportedCodexPolicy`) |
| `fallbackToGpt52OnUnsupportedGpt53` | `true` | legacy compatibility toggle for the `gpt-5.3-codex -> gpt-5.2-codex` edge when generic fallback is enabled |
| `unsupportedCodexFallbackChain` | `{}` | optional per-model fallback-chain override (map of `model -> [fallback1, fallback2, ...]`; default includes `gpt-5.5` and `gpt-5-codex` through the GPT-5.4 family). `gpt-5.5` and canonical Codex auto-fallbacks are on by default for common entitlement gates; set `CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1` or `CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK=1` to opt out. GPT-5.5 Pro is not mapped: it is ChatGPT-only per OpenAI's 2026-04-23 launch. |
| `sessionRecovery` | `true` | auto-recover from common api errors |
| `autoResume` | `true` | auto-resume after thinking block recovery |
| `tokenRefreshSkewMs` | `60000` | refresh tokens this many ms before expiry |
| `rateLimitToastDebounceMs` | `60000` | debounce rate limit toasts |
| `fetchTimeoutMs` | `60000` | upstream fetch timeout in ms |
| `streamStallTimeoutMs` | `45000` | max time to wait for next SSE chunk before aborting |

### Beginner Safe Mode Behavior

when `beginnerSafeMode` is enabled (`true` or `CODEX_AUTH_BEGINNER_SAFE_MODE=1`), the plugin applies a safer retry profile automatically:
- forces `retryProfile` to `conservative`
- forces `retryAllAccountsRateLimited` to `false`
- caps `retryAllAccountsMaxRetries` to at most `1`

this mode is intended for beginners who prefer quick failures + clearer recovery actions over long retry loops.

### Unsupported-Model Behavior and Fallback Chain

by default the plugin is strict (`unsupportedCodexPolicy: "strict"`) except for common default-selector entitlement gates. it returns other entitlement errors directly for unsupported models.

set `unsupportedCodexPolicy: "fallback"` to enable model fallback after account/workspace attempts are exhausted.

defaults when fallback policy is enabled and `unsupportedCodexFallbackChain` is empty:
- `gpt-5.5 -> gpt-5.4 -> gpt-5.4-mini -> gpt-5.4-nano`
- `gpt-5-codex -> gpt-5.4 -> gpt-5.4-mini -> gpt-5.4-nano`
- `gpt-5.4-pro -> gpt-5.4` (if `gpt-5.4-pro` is selected manually)
- `gpt-5.3-codex -> gpt-5-codex -> gpt-5.2-codex`
- `gpt-5.3-codex-spark -> gpt-5-codex -> gpt-5.3-codex -> gpt-5.2-codex` (applies if you manually select Spark model IDs)
- `gpt-5.2-codex -> gpt-5-codex`
- `gpt-5.1-codex -> gpt-5-codex`

note: the TUI can continue showing your originally selected model while fallback is applied internally. use request logs to verify the effective upstream model (`request-*-after-transform.json`). set `CODEX_PLUGIN_LOG_BODIES=1` when you need to inspect raw `.body.*` fields.

custom chain example:
```json
{
  "unsupportedCodexPolicy": "fallback",
  "fallbackOnUnsupportedCodexModel": true,
  "unsupportedCodexFallbackChain": {
    "gpt-5.5": ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
    "gpt-5.4": ["gpt-5.4-mini", "gpt-5.4-nano"],
    "gpt-5.4-pro": ["gpt-5.4"],
    "gpt-5-codex": ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
    "gpt-5.3-codex": ["gpt-5-codex", "gpt-5.2-codex"],
    "gpt-5.3-codex-spark": ["gpt-5-codex", "gpt-5.3-codex", "gpt-5.2-codex"]
  }
}
```

legacy toggle compatibility:
- `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=1` maps to fallback mode
- `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=0` maps to strict mode

### Environment Variables

override any config with env vars:

| variable | what it does |
|----------|--------------|
| `DEBUG_CODEX_PLUGIN=1` | enable debug logging |
| `ENABLE_PLUGIN_REQUEST_LOGGING=1` | log request metadata (no raw prompt/response bodies) |
| `CODEX_PLUGIN_LOG_BODIES=1` | include raw request/response bodies in log files (sensitive) |
| `CODEX_PLUGIN_LOG_LEVEL=debug` | set log level (debug/info/warn/error) |
| `CODEX_AUTH_REQUEST_TRANSFORM_MODE=legacy` | re-enable legacy Codex request rewriting |
| `CODEX_MODE=0` | disable bridge prompt |
| `CODEX_TUI_V2=0` | disable codex-style ui (use legacy output) |
| `CODEX_TUI_COLOR_PROFILE=ansi16` | force color profile for codex ui |
| `CODEX_TUI_GLYPHS=unicode` | override glyph mode (`ascii`, `unicode`, `auto`) |
| `CODEX_TUI_MASK_EMAIL=1` | mask the active account email in the TUI prompt quota status only |
| `CODEX_TUI_MASK_EMAIL_DETAILS=1` | also mask the active account email in quota details when prompt masking is enabled |
| `CODEX_AUTH_PREWARM=0` | disable startup prewarm (prompt/instruction cache warmup) |
| `CODEX_AUTH_FAST_SESSION=1` | enable fast-session defaults |
| `CODEX_AUTH_FAST_SESSION_STRATEGY=always` | force fast mode on every prompt |
| `CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS=24` | tune max retained input items in fast mode |
| `CODEX_AUTH_BEGINNER_SAFE_MODE=1` | enable beginner-safe retry behavior |
| `CODEX_AUTH_RETRY_PROFILE=aggressive` | override retry profile (`conservative`, `balanced`, `aggressive`) |
| `CODEX_AUTH_PER_PROJECT_ACCOUNTS=0` | disable per-project accounts |
| `CODEX_AUTH_AUTO_UPDATE=0` | disable automatic OpenCode plugin cache refresh when npm has a newer plugin version |
| `CODEX_AUTH_TOAST_DURATION_MS=8000` | set toast duration |
| `CODEX_AUTH_RETRY_ALL_RATE_LIMITED=0` | disable wait-and-retry |
| `CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS=30000` | set max wait time |
| `CODEX_AUTH_RETRY_ALL_MAX_RETRIES=1` | set max retries |
| `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback` | enable generic unsupported-model fallback policy |
| `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=1` | legacy fallback toggle (prefer policy variable above) |
| `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52=0` | disable only the legacy `gpt-5.3-codex -> gpt-5.2-codex` edge |
| `CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1` | disable automatic `gpt-5.5 -> gpt-5.4` fallback during rollout |
| `CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK=1` | disable automatic canonical Codex/GPT-5.4-family fallback |
| `CODEX_AUTH_ACCOUNT_ID=acc_xxx` | force specific workspace id |
| `CODEX_AUTH_FETCH_TIMEOUT_MS=120000` | override fetch timeout |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=60000` | override SSE stall timeout |

---

## Config Patterns

### Global Options

same settings for all models:

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

### Per-Model Options

different settings for different models:

```json
{
  "provider": {
    "openai": {
      "options": {
        "reasoningEffort": "medium",
        "store": false
      },
      "models": {
        "gpt-5.5-fast": {
          "name": "fast gpt-5.5",
          "options": { "reasoningEffort": "low" }
        },
        "gpt-5.5-smart": {
          "name": "smart gpt-5.5",
          "options": { "reasoningEffort": "high" }
        }
      }
    }
  }
}
```

model options override global options.

### Project-Specific

global (`~/.config/opencode/opencode.json`):
```json
{
  "plugin": ["oc-codex-multi-auth"],
  "provider": {
    "openai": {
      "options": { "reasoningEffort": "medium" }
    }
  }
}
```

project (`my-project/.opencode.json`):
```json
{
  "provider": {
    "openai": {
      "options": { "reasoningEffort": "high" }
    }
  }
}
```

result: project uses `high`, other projects use `medium`.

---

## File Locations

| file | what it's for |
|------|---------------|
| `~/.config/opencode/opencode.json` | global opencode config |
| `<project>/.opencode.json` | project-specific config |
| `~/.opencode/openai-codex-auth-config.json` | plugin config |
| `~/.opencode/auth/openai.json` | oauth tokens |
| `~/.opencode/oc-codex-multi-auth-accounts.json` | global account storage |
| `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` | per-project account storage |
| `~/.opencode/backups/codex-backup-YYYYMMDD-HHMMSSmmm-<hex>.json` | timestamped export backup (global storage mode) |
| `~/.opencode/projects/<project-key>/backups/codex-backup-YYYYMMDD-HHMMSSmmm-<hex>.json` | timestamped export backup (per-project storage mode) |
| `.../backups/codex-pre-import-backup-YYYYMMDD-HHMMSSmmm-<hex>.json` | automatic snapshot created before non-dry-run imports when existing accounts are present |
| `~/.opencode/logs/codex-plugin/` | debug logs |

---

## Debugging

### Check Config Is Valid

```bash
opencode
# shows errors if config is invalid
```

### Verify Model Resolution

```bash
DEBUG_CODEX_PLUGIN=1 opencode run "test" --model=openai/gpt-5.5 --variant=medium
```

look for:
```text
[openai-codex-plugin] Model config lookup: "gpt-5.5" -> normalized to "gpt-5.5" for API {
  hasModelSpecificConfig: true,
  resolvedConfig: { ... }
}
```

### Test Per-Model Options

```bash
# default compact selectors
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "test" --model=openai/gpt-5.5 --variant=medium
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "test" --model=openai/gpt-5.5 --variant=high

# direct selector IDs, only after installing with --full
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "test" --model=openai/gpt-5.5-medium

# compare reasoning.effort in logs
cat ~/.opencode/logs/codex-plugin/request-*-after-transform.json | jq '.reasoning.effort'
```

---

## Troubleshooting

### Model Not Found

**error**: `Model 'openai/my-model' not found`

**fix**: make sure config key matches exactly:
```json
{ "models": { "my-model": { ... } } }
```
```bash
opencode run "test" --model=openai/my-model
```

### Per-Model Options Not Applied

```bash
DEBUG_CODEX_PLUGIN=1 opencode run "test" --model=openai/your-model
```

look for `hasModelSpecificConfig: true`. if it's false, config lookup failed - check for typos.

### Per-Project Accounts Not Working

make sure you're in a project directory (has `.git`, `package.json`, etc). the plugin auto-detects the project root and uses a namespaced file under `~/.opencode/projects/`. if no project root is found, it falls back to global storage.

check which storage is being used:
```bash
DEBUG_CODEX_PLUGIN=1 opencode
# look for storage path in logs
```

---

**next**: [troubleshooting](troubleshooting.md) | [back to docs](index.md)

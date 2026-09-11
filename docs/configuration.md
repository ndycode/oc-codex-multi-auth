# Configuration Reference

Complete reference for configuring `oc-codex-multi-auth`. Most of this is optional; the defaults work for most people.

Boolean environment overrides are truthy only for the literal string `"1"`.

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
| `gpt-6-astra` | low, medium, high, xhigh, max, ultra |
| `gpt-daybreak-blue-latest` | low, medium, high, xhigh, max, ultra (Daybreak-gated; add manually) |
| `gpt-daybreak-red-latest` | low, medium, high, xhigh, max, ultra (Daybreak-gated; add manually) |
| `gpt-5.6-cyber` | low, medium, high, xhigh, max, ultra (Daybreak-gated; add manually) |
| `gpt-5.6-sol` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | low, medium, high, xhigh, max |
| `gpt-5.5` | none, low, medium, high, xhigh |
| `gpt-5.5-fast` | none, low, medium, high, xhigh |
| `gpt-5.4` | none, low, medium, high, xhigh (retired from Codex 2026-08-31; auto-upgrades to `gpt-5.6-terra`) |
| `gpt-5.4-mini` | none, low, medium, high, xhigh (retired from Codex 2026-08-31; auto-upgrades to `gpt-5.6-luna`) |
| `gpt-5.4-pro` | low, medium, high, xhigh (optional/manual model) |
| `gpt-5-codex` | low, medium, high (default: high) |
| `gpt-5.3-codex` | low, medium, high, xhigh (legacy alias to `gpt-5-codex`) |
| `gpt-5.3-codex-spark` | low, medium, high, xhigh (entitlement-gated legacy alias; add manually) |
| `gpt-5.2-codex` | low, medium, high, xhigh (legacy alias to `gpt-5-codex`) |
| `gpt-5.1-codex-max` | low, medium, high, xhigh |
| `gpt-5.1-codex` | low, medium, high |
| `gpt-5.1-codex-mini` | medium, high |
| `gpt-5.1` | none, low, medium, high |

The shipped config templates include 13 base model families and 59 shipped presets overall (59 modern variants or 59 legacy explicit entries). Default install preserves `provider.openai`; use `--modern` to install the compact base families and variant picker, or `--full` to install explicit selector IDs too. `gpt-5.5-pro` is ChatGPT-only (not routed by this plugin). `gpt-6-astra-pro` is almost certainly not a model id at all (see below). `gpt-5.3-codex-spark` and the three Daybreak-gated cyber tiers remain manual add-ons for entitled workspaces only.

Base families:

```text
gpt-6-astra
gpt-5.6-sol
gpt-5.6-terra
gpt-5.6-luna
gpt-5.5
gpt-5.5-fast
gpt-5.4-mini
gpt-5.4-nano
gpt-5.1-codex-max
gpt-5.1-codex
gpt-5.1-codex-mini
gpt-5.1
gpt-5-codex
```

GPT-6 Astra notes:
- Astra is OpenAI's frontier model, launched 2026-09-03. Efforts are low through `ultra`, matching OpenAI's Codex model list. Its API reference page says only "`reasoning.effort` supports `low`, `medium`, `high`, `xhigh`, and `max`", which is not a contradiction: `ultra` is a Codex client-side tier that is rewritten to `max` before the request leaves the client, so an API reference has no reason to list it. `gpt-5.6-sol` shows the same split.
- Astra is opt-in, like the 5.6 tiers: neither the `gpt-5` alias nor the plugin default resolves to it. It rolled out to a limited set of organizations first and to Plus/Pro/Business/Enterprise over the following days, so an account outside the rollout auto-degrades `gpt-6-astra → gpt-5.6-sol → gpt-5.6-terra → gpt-5.6-luna → gpt-5.5`. Disable with `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1`.
- Bare `gpt-6` is a **plugin-side** alias for `gpt-6-astra`. OpenAI publishes no bare `gpt-6` id.
- "GPT-6 Astra Pro" appears in launch-day press but is very likely not a model id at all: `/api/docs/models/gpt-6-astra-pro` returns 404 while the real `gpt-5.5-pro` and `gpt-5.4-pro` pages both return 200, and it is absent from both the `ChatModel` and `ResponsesOnlyModel` enums of the OpenAPI spec added by the SDK PR that introduced Astra (openai/openai-python#3791) — an enum that does list `gpt-5.5-pro`. The plugin maps `gpt-6-astra-pro*` onto `gpt-6-astra` anyway, so a user who typed it after reading the press gets a working request instead of an unknown slug on the wire.
- Astra is sent over the **responses-lite** path. Astra's catalog entry landed in openai/codex commit `ed391d4d` (2026-09-03) and reads `use_responses_lite: true`, `tool_mode: "code_mode_only"`, `multi_agent_version: "v2"`, so the shape is read rather than inferred. The `CODEX_AUTH_ASTRA_RESPONSES_LITE` switch that 6.17.0 carried while this was unverifiable has been removed.
- Astra's instructions come from the `gpt_5_2_prompt.md` fallback. Its catalog entry exists but ships an empty `base_instructions` where every sibling carries 11k to 21k characters, and the loader treats empty as absent. Astra stays registered as a catalog slug, so it switches over on its own if OpenAI fills the field in.
- The catalog marks Astra `visibility: "hide"` with `priority: 1` and `minimal_client_version: 0.153.0`, which is the staged rollout rather than a program gate. Unlike the Daybreak tiers it still ships in the config templates, because it has an auto-fallback chain: an unentitled account costs one round trip and lands on a working model, where a Daybreak request would hard-fail.

Cyber tier notes (Daybreak-gated):
- `gpt-daybreak-blue-latest` (defensive security) and `gpt-daybreak-red-latest` (cyber-permissive, for authorized security research) are catalog-verified cyber-specialty models — `model_specialty: "cyber"`, `use_responses_lite: true`, `tool_mode: "code_mode_only"`, efforts low through ultra. `gpt-5.6-cyber` is OpenAI's published alias fronting them; it belongs to the 5.6 generation, not GPT-6.
- All three require Daybreak program approval, and Blue/Red are `visibility: "hide"` in the catalog. They are therefore **not** in the shipped config templates, for the same reason `gpt-5.3-codex-spark` is not: shipping an entitlement-gated id to every user causes avoidable startup failures. The plugin routes them fully, so an entitled user adds the id by hand and it works.
- None of the three has a fallback chain, deliberately. Degrading a cyber-specialty request onto a general model would answer a security-research prompt with a model that was never asked for, so an unentitled account gets a hard failure instead of a silent substitution.
- `gpt-daybreak-blue` and `gpt-daybreak-red` are accepted as short forms of the `-latest` ids.
- `gpt-5.6-cyber` is matched ahead of the bare `gpt-5.6` alias, which would otherwise claim it and route a security request to Sol.

GPT-5.6 notes:
- 5.6 models are served over the **responses-lite** path. Their catalog entry sets `use_responses_lite: true` and `tool_mode: "code_mode_only"`, so the plugin reshapes the request the way Codex does: tool definitions move into `input` as a leading `additional_tools` developer item, the Codex instructions follow as a developer message, top-level `instructions` is emptied, `tools` is omitted, `parallel_tool_calls` is forced off, image `detail` fields are stripped, and an `x-openai-internal-codex-responses-lite: true` header is sent. Pre-5.6 models keep the classic shape.
- No 5.6 tier accepts `none` or `minimal`; both are raised to `low`.
- `max` and `ultra` are new in 5.6. Requesting them on an older family steps down to `xhigh` (then `high` where xhigh is unsupported).
- `ultra` is a client-side tier. Codex rewrites it to `max` before the request leaves the client, and the subagent orchestration that distinguishes ultra lives in the Codex client rather than the request body. This plugin is a proxy, so `-ultra` is accepted as an alias and sent on the wire as `max` — it does **not** spawn subagents.
- 5.6 is opt-in: the legacy `gpt-5` alias and the plugin default still resolve to `gpt-5.5` / `gpt-5.4`. Because 5.6 shipped as a limited preview, an account without access falls back down the 5.6 tiers and then to `gpt-5.5` automatically — this works under the default `strict` policy, like the `gpt-5.5`/`gpt-5-codex` auto-fallbacks, and can be disabled with `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`. The lite shape is applied per request attempt, so a request that falls back from `gpt-5.6-sol` to `gpt-5.5` is re-serialized into the classic shape and keeps its tools.
- Client identity defaults to `originator: opencode` for every responses-lite model (the 5.6 tiers, GPT-6 Astra and both Daybreak tiers) and `codex_cli_rs` for other models. Override with `CODEX_AUTH_CLIENT_IDENTITY=codex|opencode`.
- Instructions for the 5.6 tiers come from the Codex model catalog — see "System instructions" below.

### System instructions

Modern Codex carries a full `base_instructions` string **per model** in its catalog (`base_instructions` in `codex-rs/models-manager/models.json`) and sends that, rather than the legacy `*_prompt.md` files. The plugin sources instructions from the catalog for every model the catalog covers:

| Model | Instruction source |
|-------|--------------------|
| `gpt-6-astra` | `gpt_5_2_prompt.md` for now — registered as a catalog slug, so it switches to catalog text the moment openai/codex publishes an entry |
| `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest` | catalog |
| `gpt-5.6-cyber` | `gpt_5_2_prompt.md` (the catalog has no entry under this slug, only the Daybreak ids it fronts) |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | catalog (each tier has distinct text) |
| `gpt-5.5` | catalog |
| `gpt-5.4`, `gpt-5.4-mini` | catalog |
| `gpt-5.2` | catalog |
| `gpt-5-codex`, `gpt-5.1*`, `gpt-5.2-codex`, `gpt-5.4-nano`, `gpt-5.4-pro` | `*_prompt.md` file (absent from the catalog) |

Catalog-sourced instructions cache per model id (`catalog-<slug>-instructions.md`); file-sourced instructions keep the historical per-family cache. This matters because `gpt-5.5` and `gpt-5.4` share the `gpt-5.4` family but have different catalog text — a family-keyed cache would let one serve the other's prompt. `models.json` is fetched once per release tag and shared across models. If the pinned Codex release has no catalog entry for a model, the plugin falls back to that family's prompt file.

For context sizing, shipped templates use:
- `gpt-6-astra`: `context=1050000`, `output=128000`
- `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`: `context=1050000`, `output=128000`
- `gpt-5.5` and `gpt-5.5-fast`: `context=1050000`, `output=128000`
- `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, and `gpt-5.1-codex-mini`: `context=400000`, `output=128000`
- `gpt-5.1`: `context=272000`, `output=128000`

model normalization aliases:
- bare `gpt-6` maps to `gpt-6-astra`; `gpt-6-astra-pro*` collapses onto `gpt-6-astra` (not a Codex-routable id)
- `gpt-daybreak-blue*` and `gpt-daybreak-red*` map to the catalog ids `gpt-daybreak-blue-latest` / `gpt-daybreak-red-latest`; `gpt-5.6-cyber*` maps to itself, never to Sol
- bare `gpt-5.6` maps to the flagship tier `gpt-5.6-sol`; `gpt-5.6-terra*` and `gpt-5.6-luna*` map to their own ids
- `gpt-5.5*`, `gpt-5.5-fast*`, and user-typed `gpt-5.5-pro*` normalize to the public Codex model id `gpt-5.5`
- legacy `gpt-5` maps to `gpt-5.5`; legacy `gpt-5-mini` / `gpt-5-nano` map to `gpt-5.4-mini` / `gpt-5.4-nano`
- snapshot ids `gpt-5.4-2026-03-05*`, `gpt-5.4-mini-2026-03-05*`, and `gpt-5.4-pro-2026-03-05*` map to stable `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.4-pro`
- `opencode debug config` is the reliable way to confirm merged custom/template model entries; `--modern` exposes compact entries like `gpt-5.5` and `gpt-5.5-fast`, while `--full` also exposes explicit entries like `gpt-5.5-medium`, `gpt-5.5-fast-medium`, and `gpt-5.5-high`

if your OpenCode runtime supports global compaction tuning, you can set:
- `model_context_window = 1000000`
- `model_auto_compact_token_limit = 900000`

selector note:
- `--modern` is optimized for the TUI model picker: choose a base `(OAuth)` model, then choose a variant
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
  "rotationStrategy": "hybrid",
  "modelAccountPools": {
    "gpt-5.6-sol": ["org-example-account-id"]
  },
  "modelAccountPoolModes": {
    "gpt-5.6-sol": "strict"
  },
  "retryProfile": "balanced",
  "retryBudgetOverrides": {
    "network": 2,
    "server": 2
  },
  "perProjectAccounts": true,
  "autoUpdate": true,
  "toastDurationMs": 5000,
  "accountToasts": true,
  "retryAllAccountsRateLimited": true,
  "retryAllAccountsMaxWaitMs": 0,
  "retryAllAccountsMaxRetries": 3,
  "unsupportedCodexPolicy": "strict",
  "fallbackOnUnsupportedCodexModel": false,
  "fallbackToGpt52OnUnsupportedGpt53": true,
  "unsupportedCodexFallbackChain": {
    "gpt-5.4-pro": ["gpt-5.4"],
    "gpt-5-codex": ["gpt-5.2-codex"]
  },
  "parallelProbing": false,
  "parallelProbingMaxConcurrency": 2,
  "emptyResponseMaxRetries": 2,
  "emptyResponseRetryDelayMs": 1000,
  "pidOffsetEnabled": false,
  "sessionRecovery": true,
  "autoResume": true,
  "tokenRefreshSkewMs": 60000,
  "rateLimitToastDebounceMs": 60000,
  "fetchTimeoutMs": 60000,
  "streamStallTimeoutMs": 45000,
  "quotaNotifications": {
    "enabled": false,
    "autoProtectCredits": true,
    "intervalMs": 1800000,
    "notifyEveryCheck": false,
    "thresholds": [25, 10, 0]
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
| `maskEmail` | `false` | masks account emails across account-display surfaces: the TUI prompt quota status, command output (`codex-list`, `codex-status`, `codex-limits`, `codex-health`, `codex-dashboard`, `codex-refresh`, `codex-switch`, `codex-label`, `codex-tag`, `codex-note`, `codex-remove`), the interactive account menu, and the standalone login menu. Account labels (set via `codex-label`) are preferred and always shown; emails are reduced to a masked form such as `us***@example.com`. Raw emails are still emitted in `--includeSensitive` JSON output, which is opt-in. |
| `maskEmailInQuotaDetails` | `false` | also masks the active account email in the quota details dialog when `maskEmail` is enabled |
| `beginnerSafeMode` | `false` | enables conservative beginner-safe runtime behavior for retries and recovery |
| `fastSession` | `false` | forces low-latency settings per request (`reasoningEffort=none/low`, `reasoningSummary=auto`, `textVerbosity=low`) |
| `fastSessionStrategy` | `hybrid` | `hybrid` speeds simple turns and keeps full-depth for complex prompts; `always` forces fast mode every turn |
| `fastSessionMaxInputItems` | `30` | max input items kept when fast mode is applied |
| `rotationStrategy` | `hybrid` | account selection strategy: `hybrid` (stick while healthy, else score-select), `sticky` (drain one account first), or `round-robin` |
| `modelAccountPools` | `{}` | optional map of effective model IDs to preferred stable account or Business-seat identities; selection uses the configured pool while it has a healthy account, then falls back to the general account pool |
| `modelAccountPoolModes` | `{}` | optional per-model `preferred` or `strict` policy; omitted models default to `preferred` |
| `retryProfile` | `balanced` | retry budget profile for request classes (`conservative`, `balanced`, `aggressive`) |
| `retryBudgetOverrides` | `{}` | optional per-class budget overrides (`authRefresh`, `network`, `server`, `rateLimitShort`, `rateLimitGlobal`, `emptyResponse`) |
| `perProjectAccounts` | `true` | each project gets its own account storage |
| `autoUpdate` | `true` | check npm daily and clear the OpenCode-managed plugin cache on exit when a newer version is available; restart OpenCode to install it |
| `toastDurationMs` | `5000` | how long toast notifications stay visible (ms) |
| `accountToasts` | `true` | show the transient `Using <account> (N/N)` account-selection toast; set `false` to hide only this informational toast (rate-limit/auth/recovery warnings and errors still show) |
| `retryAllAccountsRateLimited` | `true` | wait and retry when all accounts hit rate limits |
| `retryAllAccountsMaxWaitMs` | `0` | max wait time in ms (0 = unlimited) |
| `retryAllAccountsMaxRetries` | `Infinity` | max retry attempts (omit this key for unlimited retries) |
| `unsupportedCodexPolicy` | `strict` | unsupported-model behavior: `strict` (return entitlement error) or `fallback` (retry with configured fallback chain) |
| `fallbackOnUnsupportedCodexModel` | `false` | legacy fallback toggle mapped to `unsupportedCodexPolicy` (prefer using `unsupportedCodexPolicy`) |
| `fallbackToGpt52OnUnsupportedGpt53` | `true` | legacy compatibility toggle for the `gpt-5.3-codex -> gpt-5.2-codex` edge when generic fallback is enabled |
| `unsupportedCodexFallbackChain` | `{}` | optional per-model fallback-chain override (map of `model -> [fallback1, fallback2, ...]`; default includes `gpt-6-astra` and the 5.6 tiers down to `gpt-5.5`, and `gpt-5.5`/`gpt-5-codex` down to `gpt-5.2`). The 5.6 tier, `gpt-5.5`, and canonical Codex auto-fallbacks are on by default, both for common entitlement gates and when every account is rate-limited or out of quota for the requested model; set `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1`, `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`, `CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1`, or `CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK=1` to opt out. A model chosen directly rather than through a default selector is never swapped, and the chain is only followed to a model some account can serve immediately. GPT-5.5 Pro and GPT-6 Astra Pro are not mapped: neither is a Codex-routable id. The Daybreak cyber tiers are deliberately chainless, so an unentitled account fails loudly rather than being answered by a general model. |
| `sessionRecovery` | `true` | auto-recover from common api errors |
| `autoResume` | `true` | auto-resume after thinking block recovery |
| `tokenRefreshSkewMs` | `60000` | refresh tokens this many ms before expiry |
| `rateLimitToastDebounceMs` | `60000` | debounce rate limit toasts |
| `parallelProbing` | `false` | enable concurrent account health probes |
| `parallelProbingMaxConcurrency` | `2` | max concurrent probes when parallel probing is enabled (1–5) |
| `emptyResponseMaxRetries` | `2` | retries after an empty SSE/response body |
| `emptyResponseRetryDelayMs` | `1000` | delay in ms between empty-response retries |
| `pidOffsetEnabled` | `false` | add a small PID-based offset to hybrid selection scores (helps multi-process load spread) |
| `fetchTimeoutMs` | `60000` | upstream fetch timeout in ms |
| `streamStallTimeoutMs` | `45000` | max time to wait for next SSE chunk before aborting |
| `quotaNotifications` | disabled | optional macOS Notification Center alerts for aggregate 5-hour and weekly pool quotas. `autoProtectCredits` defaults to `true` and polls the same endpoint to exclude fully spent subscription quotas from rotation; `intervalMs` defaults to 30 minutes with a 30-second minimum, `notifyEveryCheck` defaults to `false`, and `thresholds` defaults to `[25, 10, 0]` |

The quota guard queries each distinct enabled account with bounded concurrency
every `intervalMs` (30 minutes by default), even when notifications are off.
When the backend reports a fully spent 5-hour or weekly subscription window,
the account is excluded from every model-family rotation until that window's
reported reset. Failed or rate-limited usage queries fail open and wait for the
next interval; they never block an account. Set `autoProtectCredits` to `false`
to disable this periodic guard. A manual `codex-limits` or standalone `limits`
check always persists an observed exhaustion block immediately. Quota
notifications use the same poller. The 5-hour and
weekly windows are tracked independently, and each
threshold alerts once until that window rises above it after a reset. Each line
reports the account with the most headroom in that window plus that same
account's reset time, so the percentage and the reset it is printed with always
come from one account. When another account recovers earlier, that reset is
appended as a separate `another account resets ...` clause instead of replacing
the first one. A window the plan has switched off reports `used_percent: 0` and
is skipped rather than scored as a full quota. Account identities are omitted
from alerts and are never persisted in notification state.
Set `notifyEveryCheck` to `true` to deliver the aggregate message after every
successful poll interval even when no threshold was crossed. Set
`thresholds` to `[]` to disable threshold alerts entirely; omitting the key
keeps the `[25, 10, 0]` default. `"thresholds": []` together with
`"notifyEveryCheck": false` can never produce an alert, so the monitor stops
polling instead of querying the usage endpoint for every account forever.
Delivery state is stored beside the accounts
file the alerts are computed from (`oc-codex-multi-auth-quota-notifications.json`),
so concurrent OpenCode processes in the same account scope produce only one
routine alert per interval. With the default `perProjectAccounts`, that scope
is one project.
Delivery uses macOS's built-in `osascript` support and does not require an
additional notification package. The feature is unavailable on Windows and
Linux. Quit and restart OpenCode after changing the setting. If macOS blocks
the alert, allow notifications for the process shown in **System Settings >
Notifications**.

Use `codex-pool action="set" model="gpt-5.6-sol" accounts=[7,8]` to manage a
pool with 1-based account numbers while persisting stable IDs. The tool also
supports `status` (default), `add`, `remove`, `clear`, `set-mode`, `dryRun=true`, and JSON
output. Restart OpenCode after an applied mutation. Because this config is
global while account storage is per-project by default, references unavailable
in the current project are reported but not automatically pruned.

Model keys are matched case-insensitively after request model normalization.
Empty lists and unmapped models use the general account pool. A `preferred`
pool with no selectable account falls back to the general pool. A `strict`
pool never leaves its configured accounts and immediately returns
`strict_pool_unavailable` instead of entering the global wait loop. Switch an
existing pool with `codex-pool action="set-mode" model="gpt-5.6-sol"
poolMode="strict"`. Routing diagnostics expose `general`, `preferred`,
`general-fallback`, `strict`, or `strict-unavailable`.

### Beginner Safe Mode Behavior

when `beginnerSafeMode` is enabled (`true` or `CODEX_AUTH_BEGINNER_SAFE_MODE=1`), the plugin applies a safer retry profile automatically:
- forces `retryProfile` to `conservative`
- forces `retryAllAccountsRateLimited` to `false`
- caps `retryAllAccountsMaxRetries` to at most `1`

this mode is intended for beginners who prefer quick failures + clearer recovery actions over long retry loops.

### Unsupported-Model Behavior and Fallback Chain

by default the plugin is strict (`unsupportedCodexPolicy: "strict"`) except for common default-selector entitlement gates. it returns other entitlement errors directly for unsupported models.

set `unsupportedCodexPolicy: "fallback"` to enable model fallback after account/workspace attempts are exhausted.

defaults when fallback policy is enabled and `unsupportedCodexFallbackChain` is empty (plus the always-on public-selector auto-fallbacks for common entitlement gates):
- `gpt-6-astra -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.6-luna -> gpt-5.5` (then the `gpt-5.5` chain)
- `gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.6-luna -> gpt-5.5` (then the `gpt-5.5` chain)
- `gpt-5.6-terra -> gpt-5.6-luna -> gpt-5.5`
- `gpt-5.6-luna -> gpt-5.5`
- `gpt-5.5 -> gpt-5.6-terra -> gpt-5.6-luna -> gpt-5.2`
- `gpt-5-codex -> gpt-5.6-terra -> gpt-5.5 -> gpt-5.2`
- `gpt-5.4 -> gpt-5.6-terra -> gpt-5.5 -> gpt-5.2` (the successor its catalog entry names)
- `gpt-5.4-mini -> gpt-5.6-luna -> gpt-5.5 -> gpt-5.2`
- `gpt-5.4-nano -> gpt-5.6-luna -> gpt-5.5 -> gpt-5.2`
- `gpt-5.4-pro -> gpt-5.6-terra -> gpt-5.5 -> gpt-5.2` (if `gpt-5.4-pro` is selected manually; not a shipped base)

> GPT-5.4 and GPT-5.4 Mini were retired from Codex on 2026-08-31; the catalog marks both `visibility: "hide"` and names their replacements (`gpt-5.4` -> `gpt-5.6-terra`, `gpt-5.4-mini` -> `gpt-5.6-luna`), and `gpt-5.4-nano` has no catalog entry. The default chains therefore end at live models rather than leading with retired ones.
- `gpt-5.3-codex -> gpt-5-codex -> gpt-5.2-codex`
- `gpt-5.3-codex-spark -> gpt-5-codex -> gpt-5.3-codex -> gpt-5.2-codex` (applies if you manually select Spark model IDs)
- `gpt-5.2-codex -> gpt-5-codex`
- `gpt-5.1-codex -> gpt-5-codex`

Note: `gpt-5.4` and `gpt-5.4-pro` appear in fallback/runtime normalization but are not shipped as compact modern base picker entries (bases use `gpt-5.4-mini` / `gpt-5.4-nano`).

`gpt-5.4-mini` is still shipped as a base even though Codex retired it on 2026-08-31, because removing it would break saved configs that name it. Selecting it costs one extra round trip: the request 400s and the default chain immediately upgrades it to `gpt-5.6-luna`, the successor its catalog entry names. Prefer `gpt-5.6-luna` directly.

note: the TUI can continue showing your originally selected model while fallback is applied internally. use request logs to verify the effective upstream model (`request-*-after-transform.json`). set `CODEX_PLUGIN_LOG_BODIES=1` when you need to inspect raw `.body.*` fields.

custom chain example:
```json
{
  "unsupportedCodexPolicy": "fallback",
  "fallbackOnUnsupportedCodexModel": true,
  "unsupportedCodexFallbackChain": {
    "gpt-5.5": ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.2"],
    "gpt-5.4": ["gpt-5.6-terra", "gpt-5.2"],
    "gpt-5.4-pro": ["gpt-5.6-terra", "gpt-5.2"],
    "gpt-5-codex": ["gpt-5.6-terra", "gpt-5.5", "gpt-5.2"],
    "gpt-5.3-codex": ["gpt-5-codex", "gpt-5.2-codex"],
    "gpt-5.3-codex-spark": ["gpt-5-codex", "gpt-5.3-codex", "gpt-5.2-codex"]
  }
}
```

legacy toggle compatibility:
- `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=1` maps to fallback mode
- `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=0` maps to strict mode

### Environment Variables

override any config with env vars (boolean values are truthy only for `"1"`):

| variable | what it does |
|----------|--------------|
| `OPENAI_BASE_URL=https://gateway.example/v1` | OpenAI-compatible OAuth inference gateway; requires `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` |
| `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` | explicitly allow the trusted gateway to receive the ChatGPT OAuth access token; remote gateways require HTTPS, while HTTP is accepted only on literal loopback IPs |
| `DEBUG_CODEX_PLUGIN=1` | enable debug logging |
| `ENABLE_PLUGIN_REQUEST_LOGGING=1` | log request metadata (no raw prompt/response bodies) |
| `CODEX_PLUGIN_LOG_BODIES=1` | include raw request/response bodies in log files (sensitive) |
| `CODEX_PLUGIN_LOG_LEVEL=debug` | set log level (debug/info/warn/error) |
| `CODEX_AUTH_REQUEST_TRANSFORM_MODE=legacy` | re-enable legacy Codex request rewriting |
| `CODEX_MODE=0` | disable bridge prompt |
| `CODEX_TUI_V2=0` | disable codex-style ui (use legacy output) |
| `CODEX_TUI_COLOR_PROFILE=ansi16` | force color profile for codex ui |
| `CODEX_TUI_GLYPHS=unicode` | override glyph mode (`ascii`, `unicode`, `auto`) |
| `CODEX_TUI_MASK_EMAIL=1` | mask account emails across account-display surfaces (TUI prompt quota status, command output, interactive account menu, and standalone login menu) |
| `CODEX_TUI_MASK_EMAIL_DETAILS=1` | also mask the active account email in quota details when prompt masking is enabled |
| `CODEX_AUTH_PREWARM=0` | disable startup prewarm when legacy transform is enabled (native mode does not prewarm) |
| `CODEX_AUTH_TOKEN_REFRESH_SKEW_MS=60000` | refresh OAuth tokens this many ms before expiry |
| `CODEX_AUTH_RATE_LIMIT_TOAST_DEBOUNCE_MS=60000` | debounce rate-limit toast notifications |
| `CODEX_AUTH_QUOTA_NOTIFICATIONS=1` | enable macOS aggregate quota notifications |
| `CODEX_AUTH_AUTO_PROTECT_CREDITS=0` | disable periodic quota checks that protect paid Credits (enabled by default) |
| `CODEX_AUTH_QUOTA_NOTIFICATIONS_INTERVAL_MS=1800000` | override the quota check interval (minimum 30000 ms) |
| `CODEX_AUTH_SESSION_RECOVERY=0` | disable automatic session recovery hooks |
| `CODEX_AUTH_AUTO_RESUME=0` | disable auto-resume after thinking-block recovery |
| `CODEX_AUTH_FAST_SESSION=1` | enable fast-session defaults |
| `CODEX_AUTH_FAST_SESSION_STRATEGY=always` | force fast mode on every prompt |
| `CODEX_AUTH_FAST_SESSION_MAX_INPUT_ITEMS=24` | tune max retained input items in fast mode |
| `CODEX_AUTH_ROTATION_STRATEGY=sticky` | override account selection (`hybrid`, `sticky`, `round-robin`) |
| `CODEX_AUTH_BEGINNER_SAFE_MODE=1` | enable beginner-safe retry behavior |
| `CODEX_AUTH_RETRY_PROFILE=aggressive` | override retry profile (`conservative`, `balanced`, `aggressive`) |
| `CODEX_AUTH_PER_PROJECT_ACCOUNTS=0` | disable per-project accounts |
| `CODEX_AUTH_PARALLEL_PROBING=1` | enable concurrent account health probes |
| `CODEX_AUTH_PARALLEL_PROBING_MAX_CONCURRENCY=3` | max concurrent probes (1–5) |
| `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES=3` | override empty-response retry count |
| `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS=1500` | override empty-response retry delay |
| `CODEX_AUTH_PID_OFFSET_ENABLED=1` | enable PID-based hybrid score offset |
| `CODEX_AUTH_AUTO_UPDATE=0` | disable automatic OpenCode plugin cache refresh when npm has a newer plugin version |
| `CODEX_AUTH_TOAST_DURATION_MS=8000` | set toast duration |
| `CODEX_AUTH_ACCOUNT_TOASTS=0` | hide the `Using <account> (N/N)` account-selection toast (warnings and errors still show) |
| `CODEX_AUTH_RETRY_ALL_RATE_LIMITED=0` | disable wait-and-retry |
| `CODEX_AUTH_RETRY_ALL_MAX_WAIT_MS=30000` | set max wait time |
| `CODEX_AUTH_RETRY_ALL_MAX_RETRIES=1` | set max retries |
| `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback` | enable generic unsupported-model fallback policy |
| `CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=1` | legacy fallback toggle (prefer policy variable above) |
| `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52=0` | disable only the legacy `gpt-5.3-codex -> gpt-5.2-codex` edge |
| `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1` | disable automatic `gpt-6-astra -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.6-luna -> gpt-5.5` rollout fallback |
| `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1` | disable automatic `gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.6-luna -> gpt-5.5` preview fallback |
| `CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1` | disable automatic `gpt-5.5 -> gpt-5.4` fallback during rollout |
| `CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK=1` | disable automatic canonical Codex/GPT-5.4-family fallback |
| `CODEX_AUTH_ACCOUNT_ID=acc_xxx` | force specific workspace id |
| `CODEX_AUTH_CLIENT_IDENTITY=codex` | force one client identity for all models: `codex` (`originator: codex_cli_rs`) or `opencode` (alias `host`; `originator: opencode`). Default: `opencode` for every responses-lite model (5.6 tiers, GPT-6 Astra, Daybreak), `codex` for everything else |
| `CODEX_AUTH_DISABLE_CODEX_USER_AGENT=1` | keep the host runtime's `User-Agent` instead of the identity's `User-Agent` |
| `CODEX_AUTH_CLIENT_VERSION=0.150.0` | override the Codex CLI version advertised in the `codex_cli_rs` `User-Agent` |
| `CODEX_AUTH_HOST_VERSION=1.18.0` | override the opencode version advertised in the `opencode` `User-Agent` (default: the host runtime's own UA version when it injects one, else a baked-in fallback) |
| `CODEX_AUTH_SEND_ORGANIZATION_HEADER=1` | restore legacy `openai-organization` request pinning (off by default; upstream Codex never sends it) |
| `CODEX_AUTH_FETCH_TIMEOUT_MS=120000` | override fetch timeout |
| `CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=60000` | override SSE stall timeout |
| `CODEX_KEYCHAIN=1` | opt in to OS-native keychain account storage |
| `CODEX_AUTH_SYNC_CODEX_CLI=0` | disable hydrating accounts from Codex CLI `~/.codex` storage (on by default) |
| `CODEX_CONSOLE_LOG=1` | also mirror plugin logs to the console |
| `CODEX_COLLABORATION_MODE=plan` | collaboration mode hint for request shaping (`OPENCODE_COLLABORATION_MODE` is accepted as an alias) |
| `OPENCODE_STATE_DIR=/path` | override OpenCode state dir used for the TUI quota cache file |

### Advanced / power-user environment variables

These are real runtime knobs used by the plugin. Most people never need them.

| variable | what it does |
|----------|--------------|
| `CODEX_THREAD_ID=<id>` | optional correlation / prompt-cache seed attached to outbound Codex requests |
| `OPENCODE_CODEX_PROMPT_URL=<url>` | override the OpenCode→Codex bridge prompt catalog URL used in legacy transform |
| `OPENCODE_SKIP_EMAIL_HYDRATE=1` | skip account email hydrate during account-manager bootstrap |
| `FORCE_INTERACTIVE_MODE=1` | force interactive menu paths even when the host looks non-interactive (tests / special shells) |
| `OPENCODE_TUI=1` / `OPENCODE_DESKTOP=1` | host-injected markers used for non-interactive detection (normally set by OpenCode, not by you) |

Boolean overrides remain truthy only for the literal string `"1"`.

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
        "gpt-5.6-sol": {
          "name": "GPT 5.6 Sol (OAuth)",
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
      "options": {
        "store": false,
        "include": ["reasoning.encrypted_content"]
      }
    }
  }
}
```

project override (`<project>/.opencode.json`) can set a default model or per-project provider options without changing the global install.

### Compact modern selectors (`--modern` install)

```bash
opencode run "task" --model=openai/gpt-5.5 --variant=medium
opencode run "task" --model=openai/gpt-5.5-fast --variant=medium
opencode run "task" --model=openai/gpt-5.6-sol --variant=high
opencode run "task" --model=openai/gpt-5-codex --variant=high
```

### Explicit selectors (`--full` or `--legacy`)

```bash
npx -y oc-codex-multi-auth@latest --full
opencode run "task" --model=openai/gpt-5.5-medium
opencode run "task" --model=openai/gpt-5.6-sol-high
```

---

## File Locations

| Path | Purpose |
|------|---------|
| `~/.config/opencode/opencode.json` | OpenCode provider/plugin config |
| `~/.config/opencode/tui.json` | OpenCode TUI plugin config |
| `~/.opencode/openai-codex-auth-config.json` | plugin runtime config (this page) |
| `~/.opencode/auth/openai.json` | OpenCode OAuth tokens |
| `~/.opencode/oc-codex-multi-auth-accounts.json` | global V3 account pool |
| `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` | per-project account pool |
| `~/.opencode/oc-codex-multi-auth-flagged-accounts.json` | flagged/deactivated account metadata |
| `~/.opencode/logs/codex-plugin/` | request/debug logs when enabled |
| `~/.opencode/cache/` | instruction/catalog and auto-update caches |
| `$OPENCODE_STATE_DIR` or OpenCode state dir + `oc-codex-multi-auth-tui-quota.json` | TUI quota cache |
| `$XDG_DATA_HOME/opencode/storage/…` (Windows: `%APPDATA%/opencode/storage`) | OpenCode session message/part store (session recovery) |
| `openai-codex-accounts.json` / `openai-codex-flagged-accounts.json` / `openai-codex-blocked-accounts.json` | legacy migration sources only |

---

## See Also

- [getting-started.md](getting-started.md)
- [tools-and-cli.md](tools-and-cli.md)
- [architecture.md](architecture.md)
- [development/CONFIG_FIELDS.md](development/CONFIG_FIELDS.md)
- [development/CONFIG_FLOW.md](development/CONFIG_FLOW.md)
- [../config/README.md](../config/README.md)

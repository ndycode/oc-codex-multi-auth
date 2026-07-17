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

Sets the default selected model:

```json
{
  "model": "openai/gpt-5.5-medium"
}
```

Tested live on OpenCode `1.14.22`, explicit GPT-5.5 preset IDs such as `openai/gpt-5.5-medium` work directly at runtime.

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

Modern templates define base model families and expose presets through `variants`.

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
        }
      }
    }
  }
}
```

Important fields:

| Field | Purpose |
|------|---------|
| model key (`gpt-5.5`) | base model family exposed to OpenCode |
| `name` | human-readable picker label |
| `limit` | context/output metadata shown to OpenCode |
| `modalities` | allowed input/output types |
| `variants` | reasoning/verbosity presets selected with `--variant` |
| `options` | per-model defaults when needed |

If your OpenCode release exposes bare base entries, modern selection looks like:

```bash
opencode run "task" --model=openai/gpt-5.5 --variant=high
```

### Legacy template fields

Legacy templates expose each preset as its own model key.

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
| `openai/gpt-5.5-medium` | `gpt-5.5` |
| `openai/gpt-5.4-mini-xhigh` | `gpt-5.4-mini` |
| `openai/gpt-5.1-codex-high` | `gpt-5.1-codex` |
| `openai/gpt-5-mini` | `gpt-5.4-mini` |
| `openai/gpt-5-nano` | `gpt-5.4-nano` |

This normalization is why legacy aliases and snapshot-like IDs can still route to a stable family while preserving the user-facing config surface.

## `modelAccountPools`

The plugin runtime config at `~/.opencode/openai-codex-auth-config.json` can
map effective model IDs to preferred stable account IDs:

```json
{
  "modelAccountPools": {
    "gpt-5.6-sol": ["org-example-account-id"]
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

Use these commands when validating config fields:

```bash
opencode debug config
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "ping" --model=openai/gpt-5.5-medium
```

Important behavior:

- `opencode debug config` shows merged config-defined models and variants.
- On tested OpenCode `1.14.22`, `opencode models openai` exposes explicit GPT-5.5 entries such as `gpt-5.5-medium` / `gpt-5.5-high`.
- Bare `openai/gpt-5.5` can still be rejected by provider lookup, so use explicit GPT-5.5 preset IDs for reliable CLI verification.

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

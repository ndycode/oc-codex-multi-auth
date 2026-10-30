# Config flow

How `~/.opencode/openai-codex-auth-config.json` becomes effective settings.

```text
┌─────────────┐   ┌───────────────────────────────┐   ┌────────────────┐
│ process env │ + │ openai-codex-auth-config.json │ + │ DEFAULT_CONFIG │
└──────┬──────┘   └──────────────┬────────────────┘   └───────┬────────┘
       │ env wins on a set key   │ file wins when env unset   │ fallback
       ▼                         ▼                            ▼
                    loadPluginConfig()  (lib/config.ts)
       ┌─────────────────────────────────────────────────────────────┐
       │ 1. statSync(path) → signature (mtime, ctime, size, inode)   │
       │    unchanged        → return cached config                  │
       │ 2. readFile         → same text → keep cached config        │
       │ 3. JSON.parse       → PluginConfigSchema per-key validation │
       │    bad key dropped with warning, rest of file still applies │
       │ 4. unreadable/malformed/missing mid-write → keep last good  │
       └─────────────────────────────┬───────────────────────────────┘
                                     ▼
                     resolved per call site via get*(config)
                     getters read process.env each invocation
```

## Sequence

1. A caller (request path in `index.ts`, TUI poll in `tui.ts`/
   `lib/opencode-v2-status.ts`, quota monitor, CLI) calls `loadPluginConfig()`.
2. The loader stats the file. If mtime, ctime, size **and** inode match the
   cached signature, the cached object is returned without reading.
3. If the signature changed but the file text is identical, the cached config
   is still returned — mtime-only touches do not re-validate.
4. New text is parsed and validated key-by-key against `PluginConfigSchema`
   (`lib/schemas.ts`): an out-of-range or wrong-typed key is dropped with a
   logged warning; the rest of the file applies. An unreadable, malformed, or
   temporarily missing file keeps the **last usable config** — it does not
   reset to defaults. Write `{}` to reset.
5. Each `get*(config)` getter then resolves one field as
   **env var > config file > `DEFAULT_CONFIG`**, so an env var wins whenever
   it is set, per field, on every call.

Precedence: **environment > config file > defaults**.

## Hot-reload vs restart

Hot-reloaded on the next request (the request path reloads config each call):

- transform/session: `requestTransformMode`, `codexMode`, `fastSession*`,
  `pidOffsetEnabled`, `beginnerSafeMode`
- retries/timeouts: `retryProfile`, `retryBudgetOverrides`,
  `retryAllAccounts*`, `emptyResponse*`, `fetchTimeoutMs`,
  `streamStallTimeoutMs`, `maxStreamDurationMs`, `tokenRefreshSkewMs`
- routing: `rotationStrategy`, `modelAccountPools`, `modelAccountPoolModes`,
  `unsupportedCodexPolicy`, `fallbackOnUnsupportedCodexModel`,
  `fallbackToGpt52OnUnsupportedGpt53`, `unsupportedCodexFallbackChain`,
  `perProjectAccounts` (scope switch waits for in-flight requests, then moves
  the active pool; the other scope's files are left in place — not migrated)

Hot-reloaded within a couple of seconds by the TUI/status polls:

- `quotaStatus`, `quotaDisplay`, `maskEmail`, `maskEmailInQuotaDetails`,
  `codexTuiV2`, `codexTuiColorProfile`, `codexTuiGlyphMode`

Startup-bound (read once when the auth loader initializes — restart the
OpenCode session after changing):

- `sessionRecovery`, `autoResume` (recovery hook), `autoUpdate` (update check)
- `quotaNotifications` when its poll loop was fully stopped: it stays alive
  while `autoProtectCredits` is on, so `enabled`/`intervalMs`/`thresholds`
  apply at the next tick in that case only

Also note: hot reload covers **settings**, not code — upgrading the plugin
package takes effect after each OpenCode process restarts once.

## Other config surfaces (same doc, different owners)

| Surface | File | Owner |
| --- | --- | --- |
| Provider/plugin/model catalog | `~/.config/opencode/opencode.json` | OpenCode host + installer |
| TUI plugin entry | `~/.config/opencode/tui.json` | installer writes it |
| OAuth tokens | `$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share/opencode/auth.json`) | auth flow |
| Account pool (global) | `~/.opencode/oc-codex-multi-auth-accounts.json` | storage layer |
| Account pool (per project) | `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` | storage layer |
| Flagged accounts, quota-notification state, credential snapshots | `*-flagged-accounts.json`, `*-quota-notifications.json`, `backups/codex-credential-snapshot-*.json` beside the **active** accounts file | storage layer |
| TUI quota caches | `oc-codex-multi-auth-tui-quota*.json` in `~/.local/state/opencode` (`OPENCODE_STATE_DIR` overrides) | TUI/provider share |

`OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` are host env vars that inject
OpenCode config at process start; OpenCode merges them like `opencode.json`.

## Installer modes

The npm bin (`npx -y oc-codex-multi-auth@latest`) is an installer, not a
daemon:

| flag | writes |
| --- | --- |
| (none) | registers the plugin entries only; preserves `provider.openai`; no model catalog |
| `--modern` | compact catalog: 12 base model families + 65 variants |
| `--full` | modern catalog **plus** 65 explicit selector entries (`gpt-5.5-medium`, …) |
| `--legacy` | legacy explicit-only catalog (the 65 selector entries) |
| `--dry-run`, `--no-cache-clear` | preview / skip package-cache cleanup |

Templates live in `config/`: `minimal-opencode.json` (plugin-only skeleton),
`opencode-modern.json` (compact bases + variants), `opencode-legacy.json`
(explicit selector entries). Pick one in [config/README.md](../../config/README.md).

## Related

- [CONFIG_FIELDS.md](CONFIG_FIELDS.md) — field reference built from `lib/schemas.ts` + `lib/config.ts`
- [configuration.md](../configuration.md) — user-facing guide
- `test/config-stat-gate.test.ts`, `test/config-hot-reload.test.ts` — behavior coverage

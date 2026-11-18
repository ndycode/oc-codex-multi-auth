# Upgrade Guide

How to move an older install — including one still referencing a retired package name — to the canonical `oc-codex-multi-auth` plugin on the current `6.x` release line, and what changed along the way.

---

## What's Current

| Item | Value |
| --- | --- |
| Package | `oc-codex-multi-auth` (npm) |
| Plugin entry | `plugin` list in `~/.config/opencode/opencode.json` for OpenCode 1.18.29+; `plugins` for OpenCode 2.0.16+ |
| Standalone CLI | `oc-codex-multi-auth <command>` — `doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm`, `update` |
| Runtime state | `~/.opencode` — global pool `oc-codex-multi-auth-accounts.json`, per-project pools under `projects/<project-key>/` |

---

## Upgrade

```bash
npx -y oc-codex-multi-auth@latest
```

Re-running the installer is idempotent: it rewrites stale plugin entries that point at retired package names, clears both old and new package names from OpenCode's package cache, and leaves runtime state under `~/.opencode` untouched. `oc-codex-multi-auth update` refreshes the package cache without reading or writing config.

Then verify the install:

```bash
oc-codex-multi-auth doctor
oc-codex-multi-auth status
```

No storage migration step is needed — account pools upgrade in place on first load.

---

## Changes To Know About

### Package renames

The package has been renamed twice: `opencode-openai-codex-auth-multi` → `oc-chatgpt-multi-auth` → `oc-codex-multi-auth` (current since 6.0.0). Retired names may still appear in `~/.config/opencode/opencode.json` or `tui.json`; the installer rewrites the plugin entries it manages and clears both old package names from OpenCode's package cache.

### Storage file renames

Also since 6.0.0, the account pool moved from `openai-codex-accounts.json` to `oc-codex-multi-auth-accounts.json`, and the flagged store from `openai-codex-flagged-accounts.json` to `oc-codex-multi-auth-flagged-accounts.json` — under `~/.opencode/` and each `projects/<project-key>/` alike. First load migrates the old files automatically; the old names are read for migration only, and pool content upgrades to the current format on the same first load.

### OpenCode V1 to V2

OpenCode 2.0.16+ loads the plugin through a V2 adapter (the `setup` hook) instead of the V1 `server` hook. `npx oc-codex-multi-auth --v2` writes a `plugins` entry only — no model catalog — and refuses to migrate an existing V1 `plugin` entry or an `opencode.jsonc` file (edit the JSONC `plugins` list by hand instead). The account pool, OAuth login, tools, and quota cache are shared between the two adapters; V1 remains supported for OpenCode 1.18.29+. In V2 the host normalizes tool names to `codex_list`, `codex_switch`, and so on.

### Per-project pools

`perProjectAccounts` (default `false`, env `CODEX_AUTH_PER_PROJECT_ACCOUNTS`) optionally gives each project its own pool under `~/.opencode/projects/<project-key>/`. By default, projects share the global pool. Toggling switches scope live but does not migrate or delete the other scope's files — copy or remove them yourself. `$HOME` itself is never a project root.

---

## Uninstall / Disable

There is no `uninstall` command — removal is manual. Step-by-step: [getting-started.md § Uninstall / disable](getting-started.md#uninstall--disable). Runtime state stays under `~/.opencode` unless deleted; see [privacy.md § Deleting your data](privacy.md#deleting-your-data).

## Related

- [getting-started.md](getting-started.md)
- [configuration.md](configuration.md)
- [troubleshooting.md](troubleshooting.md)
- [../CHANGELOG.md](../CHANGELOG.md)

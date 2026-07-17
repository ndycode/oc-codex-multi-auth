# Tools and CLI

Reference for the **24** OpenCode `codex-*` tools and the standalone `oc-codex-multi-auth` bin commands (package v6.9.1).

Tools run inside OpenCode (agent/tool surface). Several diagnostics also run as a **direct CLI** with no agent loop and no model token cost.

---

## OpenCode tools (24)

Registered from **24 per-file factories** under `lib/tools/` via `createToolRegistry` in `lib/tools/index.ts`.

### Setup and guidance

| Tool | Purpose |
|------|---------|
| `codex-setup` | Beginner checklist / optional wizard for first-run readiness |
| `codex-help` | Topic-oriented help for plugin commands and workflows |
| `codex-next` | Suggested next action when stuck |

### Daily account use

| Tool | Purpose |
|------|---------|
| `codex-list` | List saved accounts, active index, tags/labels |
| `codex-switch` | Switch the active account (interactive picker when index omitted) |
| `codex-warm` | Open every enabled account's usage window (one minimal request each) |
| `codex-status` | Active account, model family, routing / pool mode |
| `codex-limits` | Visible rate-limit / quota state |
| `codex-reset` | Inspect or redeem banked rate-limit reset credit |
| `codex-dashboard` | Interactive multi-account management surface |

### Account metadata and routing

| Tool | Purpose |
|------|---------|
| `codex-label` | Set a stable display label for an account |
| `codex-tag` | Set or clear account tags for grouping/filtering |
| `codex-note` | Attach a private note to an account |
| `codex-pool` | Manage `modelAccountPools` (preferred accounts per model) |
| `codex-remove` | Remove a saved account (confirm required) |
| `codex-refresh` | Refresh tokens / re-auth guidance for an account |

### Diagnostics and resilience

| Tool | Purpose |
|------|---------|
| `codex-health` | Health summary across accounts |
| `codex-metrics` | Runtime counters and request metrics |
| `codex-doctor` | Beginner-friendly diagnostics with fix hints |
| `codex-diag` | Redacted diagnostic snapshot export |
| `codex-diff` | Diff account/config snapshots |

### Backup and secrets

| Tool | Purpose |
|------|---------|
| `codex-export` | Back up account storage |
| `codex-import` | Restore accounts (supports dry-run) |
| `codex-keychain` | Report credential backend; migrate/rollback OS keychain |

### Common tool examples

```text
codex-list
codex-switch index=2
codex-warm
codex-status
codex-limits
codex-reset
codex-pool
codex-pool action="set" model="gpt-5.6-sol" accounts=[7,8]
codex-pool action="add" model="gpt-5.6-sol" accounts=[9]
codex-pool action="remove" model="gpt-5.6-sol" accounts=[7]
codex-pool action="clear" model="gpt-5.6-sol"
codex-label index=2 label="plus-1"
codex-tag index=2 tags="work,team-a"
codex-note index=2 note="weekend only"
codex-doctor
codex-health
codex-export
codex-import dryRun=true
codex-keychain
```

Many tools accept structured output (`format="json"`) and opt-in sensitive fields (`includeSensitive=true`). Prefer labels over emails; enable `maskEmail` in plugin config for shared screens.

### Tool arguments matrix

Account indices are **1-based**. Destructive tools require an explicit confirm flag.

| Tool | Args |
|------|------|
| `codex-setup` | `wizard?` (bool) — menu-driven setup when terminal supports it |
| `codex-help` | `topic?` — `setup`, `switch`, `pools`, `health`, `backup`, `dashboard` |
| `codex-next` | `format?` — `text` \| `json` |
| `codex-list` | `tag?`, `format?`, `includeSensitive?` |
| `codex-switch` | `index?` — omit for interactive picker when supported |
| `codex-warm` | _(none)_ |
| `codex-status` | `format?`, `includeSensitive?` |
| `codex-limits` | `format?`, `includeSensitive?` |
| `codex-reset` | `action?` (`status` \| `consume`), `creditId?`, `confirm?` (required true to redeem), `dryRun?`, `account?` (1-based), `format?`, `includeSensitive?` |
| `codex-dashboard` | `format?`, `includeSensitive?` |
| `codex-label` | `index?`, `label` (empty string clears) |
| `codex-tag` | `index?`, `tags` (CSV; empty clears) |
| `codex-note` | `index?`, `note` (empty clears) |
| `codex-pool` | `action?` (`status` \| `set` \| `add` \| `remove` \| `clear`), `model?`, `accounts?` (1-based number array), `dryRun?`, `format?`, `includeSensitive?` |
| `codex-remove` | `index?`, `confirm` (must be `true` to delete) |
| `codex-refresh` | _(none)_ |
| `codex-health` | `format?`, `includeSensitive?` |
| `codex-metrics` | `format?` |
| `codex-doctor` | `deep?`, `fix?` (safe automated fixes), `format?` |
| `codex-diag` | _(none)_ — redacted snapshot only |
| `codex-diff` | `left`, `right` (paths), `section?` (`accounts` \| `config` \| `both`) |
| `codex-export` | `path?`, `force?`, `timestamped?` (default true when path omitted) |
| `codex-import` | `path`, `dryRun?` |
| `codex-keychain` | `command?` (`status` \| `migrate` \| `rollback`), `confirm?` (required for rollback when a live JSON file exists) |

### Operational notes

- **`codex-warm` / CLI `warm`:** one lightweight request per enabled account to open usage windows. CLI exits non-zero if any account fails; disabled accounts are skipped.
- **`codex-reset`:** banked WHAM/rate-limit reset credits. `action="consume"` is irreversible and requires `confirm=true` (use `dryRun=true` to preview).
- **`codex-pool`:** accepts 1-based numbers but persists **stable account IDs** in `~/.opencode/openai-codex-auth-config.json`. Restart OpenCode after mutations.
- **Standalone default storage:** CLI commands read the **global** accounts file unless `--config-path` points at a project pool. In-session tools use the active per-project path when `perProjectAccounts` is true.

---

## Standalone CLI

Bin: `oc-codex-multi-auth` (also via `npx -y oc-codex-multi-auth@latest …`).

### Commands

| Command | Role |
|---------|------|
| `install` (default) | Install/update OpenCode config and TUI plugin entry |
| `doctor` | Local account/config diagnostics |
| `status` | Account/config status |
| `list` | List configured accounts |
| `limits` | Stored rate-limit state |
| `dashboard` | Prints guidance (does not start a full dashboard server) |
| `health` | Local token/account health summary |
| `diag` | Alias for `doctor --deep` |
| `warm` | Open every enabled account's usage window (same idea as `codex-warm`) |

```bash
oc-codex-multi-auth                 # install (default)
oc-codex-multi-auth install
oc-codex-multi-auth doctor
oc-codex-multi-auth status
oc-codex-multi-auth list
oc-codex-multi-auth limits
oc-codex-multi-auth dashboard
oc-codex-multi-auth health
oc-codex-multi-auth diag
oc-codex-multi-auth warm
```

`warm` exits non-zero if any account failed. Disabled accounts are skipped.

### Installer flags

| Flag | Effect |
|------|--------|
| `--modern` | Force compact modern config (12 bases + variants) |
| `--full` | Compact bases plus explicit selector entries |
| `--legacy` | Explicit-only catalog (53 entries) |
| `--dry-run` | Show actions without writing |
| `--no-cache-clear` | Skip clearing OpenCode plugin cache |

Choose only one of `--modern`, `--full`, or `--legacy`.

### Standalone options

| Flag | Effect |
|------|--------|
| `--json` | Machine-readable JSON output |
| `--include-sensitive` | Include sensitive identity fields in JSON where applicable |
| `--deep` | Deeper diagnostics (used with `doctor`; implied by `diag`) |
| `--fix` | Request fix application where supported (may be a no-op for some safe CLI paths) |
| `--tag <tag>` | Filter accounts by tag when listing |
| `--config-path <path>` | Point at a specific accounts storage path |
| `--help` / `-h` | Print usage |

Examples:

```bash
oc-codex-multi-auth status --json
oc-codex-multi-auth list --tag work
oc-codex-multi-auth warm --json
oc-codex-multi-auth doctor --deep
npx -y oc-codex-multi-auth@latest warm
```

---

## Related runtime concepts

- **Rotation:** `rotationStrategy` = `hybrid` (default) | `sticky` | `round-robin` in `~/.opencode/openai-codex-auth-config.json` or `CODEX_AUTH_ROTATION_STRATEGY`.
- **Model pools:** `modelAccountPools` + `codex-pool` prefer specific accounts per effective model ID, then fall back to the general pool.
- **Per-project accounts:** default `true` under `~/.opencode/projects/<project-key>/`.
- **Stateless Codex contract:** `store: false` and `reasoning.encrypted_content`.
- **GPT-5.6:** responses-lite path; client identity defaults to host/opencode for 5.6.

See also:

- [architecture.md](architecture.md)
- [getting-started.md](getting-started.md)
- [configuration.md](configuration.md)
- [faq.md](faq.md)

# Tools and CLI

Reference for the **25** OpenCode `codex-*` tools and the standalone `oc-codex-multi-auth` bin.

Tools run inside OpenCode (agent/tool surface). The standalone bin is an installer plus a thin CLI that runs the same diagnostics without an agent loop.

---

## OpenCode tools (25)

Registered from per-file factories under `lib/tools/` via `createToolRegistry` in `lib/tools/index.ts`. Account numbers you **pass in** (`index`, `account`, `accounts[]`) are **1-based**; `switch`, `label`, `tag`, `note`, `enable`, and `remove` open an interactive picker when `index` is omitted and the terminal supports menus. Numbers a command **prints back** differ by surface: `Account N` labels, picker entries, and tool `format="json"` `index`/`activeIndex` fields are all 1-based (tool JSON also carries the storage position separately as `zeroBasedIndex`), while the standalone CLI's `[N]` labels and `--json` `index` fields are the account's raw **0-based** storage position (see [Account numbering](#account-numbering)).

| Tool | Purpose |
| --- | --- |
| `codex-setup` | Beginner checklist for first-run readiness; optional menu-driven wizard |
| `codex-help` | Beginner command guide with quickstart and troubleshooting topics |
| `codex-next` | The single most recommended next action for beginners |
| `codex-list` | List accounts, active index, labels/tags |
| `codex-switch` | Switch the active account |
| `codex-warm` | Send one lightweight request per enabled account to open/stagger usage windows |
| `codex-status` | Detailed account and rate-limit status |
| `codex-limits` | Live 5-hour and weekly usage per account, plus the plan-weighted pool total |
| `codex-reset` | List or redeem banked rate-limit reset credits |
| `codex-metrics` | Runtime request metrics for this plugin process |
| `codex-dashboard` | Live dashboard: account eligibility, retry budgets, refresh-queue health |
| `codex-doctor` | Beginner-friendly diagnostics with clear fixes |
| `codex-health` | Verify every account by validating its refresh token (network calls); `includeDisabled` validates disabled accounts too |
| `codex-enable` | Re-enable a disabled account; clears the plugin's auto-disable note and auth-failure cooldown |
| `codex-label` | Set or clear a display label |
| `codex-tag` | Set or clear comma-separated tags |
| `codex-note` | Set or clear a private account note |
| `codex-pool` | Manage per-model account pools and `preferred`/`strict` routing |
| `codex-remove` | Remove an account (requires `confirm=true`) |
| `codex-refresh` | Manually refresh OAuth tokens for all accounts |
| `codex-export` | Export accounts to a JSON backup (timestamped default) |
| `codex-import` | Import accounts from JSON, with dry-run preview |
| `codex-diag` | Redacted diagnostic snapshot for bug reports (no tokens, IDs, emails, or home paths) |
| `codex-diff` | Redacted structural diff of two JSON snapshots |
| `codex-keychain` | Inspect/manage the opt-in OS-keychain backend (`status`/`migrate`/`rollback`) |

### Tool arguments

`format` is a real enum — only `text` (default) and `json` validate (`lib/tools/args.ts`, `TOOL_OUTPUT_FORMAT_VALUES`). `includeSensitive` opts raw labels/emails/account IDs into JSON output; `codex-pool` exposes stable account IDs instead. Mutation safeguards vary by operation: `codex-import` applies changes unless `dryRun: true`, and `codex-pool` remove/clear take effect immediately — read the per-tool args before automating against a live pool.

| Tool | Args |
| --- | --- |
| `codex-setup` | `wizard?` (bool) |
| `codex-help` | `topic?` (`setup`, `switch`, `pools`, `health`, `backup`, `dashboard`) |
| `codex-next` | `format?` |
| `codex-list` | `tag?`, `format?`, `includeSensitive?` |
| `codex-switch` | `index?` |
| `codex-warm` | `format?` |
| `codex-status` | `format?`, `includeSensitive?` |
| `codex-limits` | `format?`, `includeSensitive?` |
| `codex-reset` | `action?` (`status`\|`consume`), `creditId?`, `confirm?` (required `true` to redeem), `dryRun?`, `account?` (1-based, default active), `format?`, `includeSensitive?` |
| `codex-metrics` | `format?` |
| `codex-dashboard` | `format?`, `includeSensitive?` |
| `codex-doctor` | `deep?`, `fix?` (verified refresh + clear stale markers), `format?` |
| `codex-health` | `format?`, `includeSensitive?`, `includeDisabled?` |
| `codex-enable` | `index?` (picker when omitted; a sole disabled account is selected automatically) |
| `codex-label` | `index?`, `label` (empty clears) |
| `codex-tag` | `index?`, `tags` (CSV; empty clears) |
| `codex-note` | `index?`, `note` (empty clears) |
| `codex-pool` | `action?` (`status`\|`set`\|`add`\|`remove`\|`clear`\|`set-mode`), `model?`, `accounts?` (1-based array), `poolMode?` (`preferred`\|`strict`), `dryRun?`, `format?`, `includeSensitive?` |
| `codex-remove` | `index?`, `confirm?` (must be `true`; otherwise a no-op that prints guidance) |
| `codex-refresh` | `includeDisabled?` |
| `codex-export` | `path?`, `force?`, `timestamped?` (default true when `path` omitted) |
| `codex-import` | `path`, `dryRun?` |
| `codex-diag` | _(none)_ |
| `codex-diff` | `left`, `right` (paths), `section?` (`accounts`\|`config`\|`both`) |
| `codex-keychain` | `command?` (`status`\|`migrate`\|`rollback`), `confirm?` |

```text
codex-list
codex-switch index=2
codex-pool action="set" model="gpt-5.6-sol" accounts=[7,8]
codex-pool action="set-mode" model="gpt-5.6-sol" poolMode="strict"
codex-label index=2 label="plus-1"
codex-tag index=2 tags="work,team-a"
codex-doctor fix=true
codex-import path="~/backup.json" dryRun=true
codex-keychain command="status"
```

### Account numbering

Two conventions coexist, and they are different on purpose:

- **Inputs are 1-based.** `index`, `account`, and `accounts[]` arguments and
  interactive pickers number accounts from 1 — the same numbers `codex-list`
  prints and `Account N` fallbacks use.
- **Tool JSON output stays 1-based.** `format="json"` emits `index`/
  `activeIndex` numbered like the pickers; the raw storage position is
  emitted separately as `zeroBasedIndex`.
- **Standalone CLI output is 0-based.** `--json` `index` fields and the
  `[N]` labels are the account's raw position in the storage array, so the
  first account prints as `[0]`. When scripting, feed tool arguments the
  1-based number — or read `zeroBasedIndex` if you need the storage offset.

### Operational notes

- **`codex-pool`** accepts 1-based numbers but persists **stable account IDs** in `~/.opencode/openai-codex-auth-config.json`. The fetch path re-reads plugin config each request, so mutations apply on the next request.
- **`codex-reset`**: `action="consume"` is irreversible and needs `confirm=true`; `dryRun=true` previews.
- **`codex-doctor fix=true`**: refreshes enabled accounts and clears stale cooldown/rate-limit/quota markers **only after a successful refresh** — shared logic with CLI `doctor --fix` (`lib/tools/doctor-repair.ts`).
- **`codex-keychain rollback`**: restores the newest `.migrated-to-keychain.<ts>` backup next to the accounts file, deletes the keychain entry, and restores the flagged-accounts store's own `.migrated-to-keychain.<ts>` backup the same way so quarantined credentials are not left keychain-only. When a live JSON file exists, `confirm=true` is required and the current file is archived as `.pre-rollback.<ts>` first.
- **Tool `codex-health` vs CLI `health`.** The tool makes real network calls (refresh-token validation). The CLI scans local storage only.
- **`maskEmail`** in plugin config renders emails as `us***@example.com` in shared screens; labels are preferred over emails.

---

## Standalone CLI

Bin: `oc-codex-multi-auth` (or `npx -y oc-codex-multi-auth@latest …`).

| Command | Role |
| --- | --- |
| `install` (default) | Register OpenCode + TUI plugin entries; optionally a model catalog |
| `update` | Refresh the managed package cache; never touches config |
| `doctor` | Local account/config diagnostics |
| `status` | Account/config status |
| `list` | List configured accounts |
| `limits` | 5-hour and weekly usage per account + plan-weighted pool total |
| `dashboard` | Prints guidance (does not start a server; use `codex-dashboard` in OpenCode) |
| `health` | Local token/account health summary (no network) |
| `diag` | Alias for `doctor --deep` |
| `warm` | Open every enabled account's usage window (one request each) |

### Which storage the CLI reads

`resolveStandaloneStorage` picks, in order:

1. `--config-path <path>` — used verbatim (`scope: explicit`);
2. the **per-project** pool for the current directory's project root when `perProjectAccounts` is on (the default) — `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json` (`scope: project`);
3. the global `~/.opencode/oc-codex-multi-auth-accounts.json` (`scope: global`).

Project-root detection walks up looking for markers (`.git`, `package.json`,
`go.mod`, `Cargo.toml`, `pyproject.toml`, `.opencode`) and stops at your home
directory — a stray `.opencode` inside `$HOME` does not turn `~` into a project,
so the CLI resolves the global pool from `$HOME` or a markerless directory. Run
it from inside a real project to see that project's pool.

A `--config-path` naming a `.migrated-to-keychain.<ts>` file is refused for the write-capable commands — restore it through `codex-keychain rollback` instead.

### Keychain routing per command

- `status`, `list`, `health`, `dashboard`, and `doctor` (without `--fix`) parse the resolved JSON file directly — no keychain.
- `warm`, `limits`, and `doctor --fix` run through the plugin's compiled storage runtime, so they honor `CODEX_KEYCHAIN=1`. An explicit `--config-path` forces keychain off for that run.

### Standalone options

| Flag | Applies to | Effect |
| --- | --- | --- |
| `--json` | `doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm` | Machine-readable JSON output (**not** `install`/`update` — they reject it as an unknown option) |
| `--include-sensitive` | account listing output | Raw identity fields instead of masked |
| `--tag <tag>` / `--tag=<tag>` | account listing (incl. `limits`) | Filter accounts by tag |
| `--config-path <path>` / `--config-path=<path>` | all standalone commands | Explicit accounts file (see storage resolution) |
| `--refresh` | `limits` | Read every account live instead of the plugin's last readings |
| `--sort account\|usage\|reset` | `limits` | Order by number / least used / earliest renewal; aliases `number`, `used`, `renewal` (`--sort=` also accepted) |
| `--asc` / `--desc` | `limits` | Sort direction (default `--asc`) |
| `--deep` | `doctor` (implied by `diag`) | Technical snapshot details |
| `--fix` | `doctor` | Verify-refresh enabled accounts, then clear stale cooldown/rate-limit/quota markers |
| `--help`, `-h` | all | Print usage |

`warm` exits non-zero if any enabled account fails; disabled accounts are skipped. `limits` exits 1 when storage cannot be read or a required live read fails. `doctor --fix` exits non-zero if any repair fails or the storage file cannot be read.

### Installer flags (`install`, default command)

| Flag | Effect |
| --- | --- |
| (default) / `--plugin-only` | Register plugin/TUI entries without changing `provider.openai` |
| `--v2` | Register for OpenCode V2 (`plugins` entry only; plugin-only, includes automatic quota UI) |
| `--modern` | Compact modern catalog: 12 base OAuth models + variant presets |
| `--full` | Compact bases plus 65 explicit selector entries |
| `--legacy` | Explicit-only catalog: 65 preset model entries |
| `--dry-run` | Show changed paths without values or writes |
| `--no-cache-clear` | Skip clearing the OpenCode plugin cache |
| `--version` | Print the installed package version |
| `--help`, `-h` | Print usage |

`--plugin-only`, `--modern`, `--full`, and `--legacy` are mutually exclusive. `--v2` is plugin-only: it cannot combine with a catalog mode, refuses an existing `opencode.jsonc`, and refuses V1 `plugin` entries rather than migrating them. `update [--dry-run]` clears the managed cache without reading or writing `opencode.json`/`tui.json`.

### What `limits` reports

```text
Storage:  /home/me/.opencode/oc-codex-multi-auth-accounts.json
Accounts: 11
Sort:     reset (asc)
Readings: the plugin's last readings, taken 2026-09-27 13:17:22 (14m ago); --refresh reads every account live

- [0] work@example.com id:c487c4
  Weekly limit:     100% used
  Renews:           2026-09-30 15:14:08 (in 3d 22h)
  Plan:             Pro (20x)
  Credits:          62,500
  Resets:           1 applicable now

Pool:     93% used of 81x across 11 accounts
```

- **Snapshot-backed, not live.** The plugin polls `/wham/usage` for the pool status line and keeps the last readings in `oc-codex-multi-auth-tui-quota-overview.json` under the OpenCode state dir (`$OPENCODE_STATE_DIR`, else `$XDG_STATE_HOME/opencode` or `~/.local/state/opencode`). `limits` reports those readings; accounts with no snapshot entry (or a rotated token fingerprint) are read live. An account the plugin can no longer read is not read live either: when the poller keeps an account's last good reading because its credentials are dead (a refused refresh, an invalidated token, a deactivated workspace) it records since when and why, and the request path marks an account whose credentials were refused (`auth-failure` cooldown, counted while it runs or while the stored access token stays expired). `limits` shows such an account's last known figures under an `Error:` line carrying that reason (for example a refresh token that needs a new `opencode auth login`), leaves it out of the pool total, and exits 1. A transient failure (timeout, network error, 429, 5xx) does not mark an account; its older `Read:` time says the figures are old. `limits` never refreshes a token for an account with a snapshot entry; an account read live because it has none can have its token refreshed. `--refresh` reads the whole pool live, and a full live read becomes the plugin's new snapshot. Nothing is written for `--tag` subsets, `--config-path` stores, or when the snapshot no longer describes the pool.
- **Workspace names.** Business seats show their ChatGPT workspace name (owner-titled) via one `/wham/accounts/check` per login, cached in `oc-codex-multi-auth-workspace-names.json` beside the quota snapshot; lookup gives up after ~5s and a failure only drops the line.
- **Credits.** An account that holds a Codex credit balance gets a `Credits` line, the same way banked resets get `Resets`; an account with none gets no line. `spendCredits` decides whether those credits are spent once plan quota is gone (see [configuration](configuration.md#spending-codex-credits)).
- **Sorting.** `--sort usage|reset` judges each account by its governing window — the one with least headroom, and on ties the later reset. Accounts with no readable value sort last. Persist a default via `"limitsSort": { "by": "reset", "direction": "asc" }` in `~/.opencode/openai-codex-auth-config.json`.
- **Pool total.** `81x` is the sum of per-plan seat weights (see [plan allotments](plan-allotments.md)); the percentage is the weighted mean over exactly that sum, not a plain average. Plans with no published ratio weigh one baseline seat and print no `Nx` badge. Accounts with unreadable usage are excluded from both figures; `pool` is `null` in `--json` when nothing was readable. Both `used` and `left` percentages are emitted so `quotaDisplay` wording never changes the data.
- **Terminal color.** Green <60% used, yellow ≥60%, orange ≥80%, red ≥99%; `NO_COLOR` disables, `FORCE_COLOR` enables without a TTY.
- **`--json`** adds per-account `source` (`cache`|`live`) and `readAt`, the report `readings`, `workspaceName`, and the `pool` object. The `codex-limits` tool renders the same `Pool:` line and carries the same `pool` object under `format="json"`.

### `warm` cleanup semantics

A successful warm clears only unchanged cooldown state, the responding model's own rate-limit marker, and that family's blanket marker — never other models' or families' markers. A successful response alone does not clear a subscription-quota block (it can be paid with Credits), so warm re-checks live usage first; a failed usage check keeps the quota block but still clears the unchanged markers. Cleanup failures are reported separately and newer concurrent block writes are preserved.

---

## Related runtime concepts

- **Rotation**: `rotationStrategy` = `hybrid` (default) | `sticky` | `round-robin`, in `~/.opencode/openai-codex-auth-config.json` or `CODEX_AUTH_ROTATION_STRATEGY`.
- **Model pools**: `modelAccountPools` + `codex-pool`; `preferred` falls back to the general pool, `strict` never leaves its pool.
- **Per-project accounts**: default on under `~/.opencode/projects/<project-key>/`.
- **Stateless Codex contract**: `store: false` + `reasoning.encrypted_content` on every request.
- **Responses-lite models** (GPT-5.6, GPT-6, Daybreak): client identity defaults to `opencode`; other models use `codex_cli_rs`.

## Related

- [architecture.md](architecture.md)
- [getting-started.md](getting-started.md)
- [configuration.md](configuration.md)
- [faq.md](faq.md)

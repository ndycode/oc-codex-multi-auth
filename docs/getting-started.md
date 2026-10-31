# Getting Started

Sign in to OpenCode with your ChatGPT Plus/Pro subscription and start routing
Codex/GPT-5/GPT-6 models through `oc-codex-multi-auth`.

## Prerequisites

- [OpenCode](https://opencode.ai) installed
- A ChatGPT Plus or Pro subscription
- Node.js `>=22.19` for the installer

> Personal use with your own subscription only. For production workloads use
> the OpenAI Platform API.

## 1. Install

```bash
npx -y oc-codex-multi-auth@latest --modern
```

`--modern` registers the plugin and writes the compact model catalog: 12 base
model families with 65 variants selectable through `--variant`. Alternatives:

| Flag | Use it when |
| --- | --- |
| (none) | OpenCode already supplies the model entries you need; registers the plugin only |
| `--full` | You also want explicit selector IDs such as `openai/gpt-5.5-medium` |
| `--legacy` | Older OpenCode that needs explicit-only entries |
| `--v2` | OpenCode 2.0.16+ — see [README V2 section](../README.md#opencode-v2) |
| `--dry-run` | Preview the changes first |

Config files may be `opencode.json` or `opencode.jsonc` — comments and
trailing commas are fine, and the installer merges into the `.jsonc` file when
that is your effective config. It refuses to overwrite a config it cannot
parse — a JSONC file with an unterminated block comment is refused rather
than truncated. Rerun with `update` to refresh the cached package without
touching config at all.

## 2. Sign in

```bash
opencode auth login
```

Choose `OpenAI`, then one of the **four** plugin OAuth methods:

- `Codex OAuth (ChatGPT Plus/Pro)` — opens your browser; sign-in completes
  through a localhost callback
- `Codex OAuth (Open URL Manually)` — prints the authorization URL; open it in
  any browser and the localhost callback still completes the login
- `Codex OAuth (Device Code)` — for SSH/headless sessions without a browser
- `Codex OAuth (Manual URL Paste)` — paste the full callback URL, including
  its `state` parameter, after logging in elsewhere

The browser methods use the same callback port as Codex CLI: the local server
binds `http://127.0.0.1:1455/auth/callback` (and `[::1]:1455`), and the
authorize redirect is `http://localhost:1455/auth/callback`. Authorization and
token exchange go to `auth.openai.com`.

Run `opencode auth login` again per account to build a multi-account pool.
Pools are per-project by default, so log in from the directory where you use
OpenCode.

### Remote or headless login

- If port 1455 is reachable — including through
  `ssh -L 1455:localhost:1455 user@remote` — use
  `Codex OAuth (Open URL Manually)` and open the printed URL anywhere.
- If localhost is not reachable (containers, restricted networks), use
  `Codex OAuth (Device Code)`.
- If device code is unavailable, fall back to `Codex OAuth (Manual URL Paste)`
  and paste the complete callback URL.

## 3. Verify

```bash
oc-codex-multi-auth status    # accounts + which storage file is in use
oc-codex-multi-auth doctor    # config and credential diagnostics
opencode run "Summarize this repo" --model=openai/gpt-5.5 --variant=medium
```

`--variant` presets exist only after a catalog install (`--modern`, `--full`,
or `--legacy`); after a plugin-only install, use the model entries OpenCode
itself provides.

## Uninstall / disable

There is no `uninstall` command — removal is manual:

1. Delete the `oc-codex-multi-auth` plugin entry the installer added to
   `~/.config/opencode/opencode.json` (the `plugin` list, or `plugins` for V2)
   and to `~/.config/opencode/tui.json`.
2. Optionally remove the model entries the catalog modes wrote to
   `provider.openai.models` in the same file.
3. Runtime state stays under `~/.opencode` (account pools, config, caches,
   logs). Leave it for a later reinstall, or delete it following
   [privacy.md](privacy.md#deleting-your-data).

Restart OpenCode afterward; the plugin's entry point is only loaded at startup.

## What the plugin sends

Requests go to the ChatGPT-backed Codex endpoint and stay stateless: every
body carries `store: false` and includes `reasoning.encrypted_content` for
multi-turn continuity. GPT-6 and GPT-5.6 models additionally use the
responses-lite request shape. The shipped templates in
[config/](../config/opencode-modern.json) already encode all of this.

## Related

- [tools-and-cli.md](tools-and-cli.md) — the 25 `codex-*` tools and standalone commands
- [configuration.md](configuration.md) — plugin config keys and env overrides
- [upgrade.md](upgrade.md) — package renames and storage migration
- [troubleshooting.md](troubleshooting.md) — when something breaks
- [faq.md](faq.md) — short answers

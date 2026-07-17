# Getting Started

This guide covers the full installation and first-run flow for `oc-codex-multi-auth` v6.9.1.

## Before You Begin

> [!CAUTION]
> This plugin is for personal development use with your own ChatGPT Plus/Pro subscription.
>
> - It is not intended for commercial resale, shared multi-user access, or production services.
> - It uses official OAuth authentication, but it is an independent open-source project and is not affiliated with OpenAI.
> - For production applications, use the [OpenAI Platform API](https://platform.openai.com/).

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| OpenCode | Install from [opencode.ai](https://opencode.ai) |
| ChatGPT Plus or Pro | Required for OAuth access and model entitlements |
| Node.js `>=18` | Needed for local OpenCode runtime and plugin installation |

## Fastest Install Path

```bash
npx -y oc-codex-multi-auth@latest
opencode auth login
opencode run "Explain this repository" --model=openai/gpt-5.5 --variant=medium
```

The installer updates `~/.config/opencode/opencode.json`, backs up the previous config, normalizes the plugin entry to `oc-codex-multi-auth`, enables the TUI status plugin, and clears the cached plugin copy so OpenCode reinstalls the latest package.

By default, the installer writes the **compact modern** config so the model picker shows **12 base OAuth model families** (including `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-fast`, and the Codex families). The separate model variant picker selects reasoning presets. Altogether the modern catalog covers **53 variants**. Rerunning the default installer also removes explicit preset entries and stale base models left by earlier plugin catalogs.

If you want direct explicit selector IDs such as `openai/gpt-5.5-medium` (modern bases **plus** explicit entries):

```bash
npx -y oc-codex-multi-auth@latest --full
```

If you explicitly want the older explicit-only layout (53 individual model keys):

```bash
npx -y oc-codex-multi-auth@latest --legacy
```

## Install from Source

Use this only when you want to develop or test the plugin locally.

```bash
git clone https://github.com/ndycode/oc-codex-multi-auth.git
cd oc-codex-multi-auth
npm ci
npm run build
```

Point OpenCode at the built plugin:

```json
{
  "plugin": ["file:///absolute/path/to/oc-codex-multi-auth/dist"]
}
```

Use the built `dist/` directory, not the repository root.

## Authentication

Run:

```bash
opencode auth login
```

Then choose:

1. `OpenAI`
2. One of the **three** plugin OAuth methods:
   - `Codex OAuth (ChatGPT Plus/Pro)` — browser callback (default)
   - `Codex OAuth (Device Code)` — headless / SSH
   - `Codex OAuth (Manual URL Paste)` — paste the redirect URL

There is **no** registered “Manual API Key” login path for this plugin. The provider still presents a dummy SDK key (`chatgpt-oauth`) internally; real auth is always OAuth.

The browser-based OAuth flow uses the same local callback port as Codex CLI. The authorize redirect is `http://localhost:1455/auth/callback`, while the local callback server binds `http://127.0.0.1:1455/auth/callback` and `[::1]:1455` for dual-stack localhost redirects. Authorization and token exchange go to `auth.openai.com`.

If you authenticated before the connector scopes were added, re-run `opencode auth login`. Current account records persist the granted OAuth scope and accounts missing `api.connectors.read` / `api.connectors.invoke` are marked for re-auth instead of being silently reused.

### Remote or Headless Login

If you are on SSH, WSL, or another environment where the browser callback flow is inconvenient:

1. rerun `opencode auth login`
2. choose `Codex OAuth (Device Code)`
3. open the verification link, enter the one-time code, and wait for login to finish
4. if device code is unavailable on your auth server, fall back to `Codex OAuth (Manual URL Paste)`

## Add the Plugin to OpenCode

If you are not using the installer, edit `~/.config/opencode/opencode.json` manually:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-codex-multi-auth"]
}
```

## Choose a Config Template

The repository ships two supported templates:

| OpenCode version | Template |
|------------------|----------|
| `v1.0.210+` | [`config/opencode-modern.json`](../config/opencode-modern.json) |
| `v1.0.209` and earlier | [`config/opencode-legacy.json`](../config/opencode-legacy.json) |

The templates include the supported GPT-5/Codex families, required `store: false` handling, and `reasoning.encrypted_content` for multi-turn sessions.

Current templates expose **12 base model families** and **53 presets** overall (53 modern variants or 53 legacy explicit entries):

| Base family | Notes |
|-------------|-------|
| `gpt-5.6-sol` | responses-lite; flagship 5.6 tier |
| `gpt-5.6-terra` | responses-lite |
| `gpt-5.6-luna` | responses-lite |
| `gpt-5.5` | default public GPT-5.5 selector |
| `gpt-5.5-fast` | faster GPT-5.5 variant |
| `gpt-5.4-mini` | |
| `gpt-5.4-nano` | |
| `gpt-5.1-codex-max` | |
| `gpt-5.1-codex` | |
| `gpt-5.1-codex-mini` | |
| `gpt-5.1` | |
| `gpt-5-codex` | canonical Codex |

On OpenCode `v1.0.210+`, the modern template shows the 12 base entries because additional presets are selected through `--variant` instead of separate model keys.

`gpt-5.5-pro` is not shipped in the Codex templates because it is ChatGPT-only, not Codex-routable. Add entitlement-gated Spark variants manually only when your workspace supports them.

## Verify the Setup

Run one of these commands:

```bash
# Recommended current GPT-5.5 path
opencode run "Create a short TODO list for this repo" --model=openai/gpt-5.5 --variant=medium
opencode run "Create a short TODO list for this repo" --model=openai/gpt-5.5-fast --variant=medium
opencode run "Inspect the retry logic and summarize it" --model=openai/gpt-5-codex --variant=high

# Optional GPT-5.6 (requires account entitlement; auto-falls back sol→terra→luna→gpt-5.5)
opencode run "Create a short TODO list for this repo" --model=openai/gpt-5.6-sol --variant=medium

# Direct selector IDs, only after installing with --full
opencode run "Create a short TODO list for this repo" --model=openai/gpt-5.5-medium
```

If you want to verify request routing, run a request with logging enabled:

```bash
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "test" --model=openai/gpt-5.5 --variant=medium
```

The first request should create logs under `~/.opencode/logs/codex-plugin/`.

Use `opencode debug config` when you want to verify that template-defined or custom models were merged into your effective config. The default install exposes compact OAuth model entries such as `gpt-5.5` and `gpt-5.6-sol`; `--full` additionally exposes explicit entries such as `gpt-5.5-medium` / `gpt-5.5-fast-medium` / `gpt-5.5-high`.

## Multi-Account Setup

The plugin can manage multiple ChatGPT accounts and choose the healthiest account or workspace for each request. Per-project account pools default to **on** under `~/.opencode/projects/<project-key>/`.

After your first successful login, you can add more accounts by running `opencode auth login` again or by using the guided commands below.

Optional: pin models to preferred accounts with `modelAccountPools` / `codex-pool` (see [configuration.md](configuration.md) and [tools-and-cli.md](tools-and-cli.md)).

## Guided Onboarding Commands

These commands are useful after installation (from inside OpenCode as tools, or for several of them via the standalone bin):

```text
codex-setup
codex-help topic="setup"
codex-doctor
codex-next
codex-list
codex-warm
codex-pool
codex-reset
```

Standalone equivalents (no agent/model loop):

```bash
oc-codex-multi-auth doctor
oc-codex-multi-auth status
oc-codex-multi-auth list
oc-codex-multi-auth warm
```

Notes:

- `codex-switch`, `codex-label`, and `codex-remove` can show interactive account pickers when `index` is omitted in a supported terminal.
- `codex-warm` opens every enabled account's usage window so rolling quota windows start at session start.
- The plugin can show a startup preflight summary with the current account health state and suggested next step.

## Beginner Safe Mode

If you want conservative retry behavior while learning the workflow, enable beginner safe mode:

```json
{
  "beginnerSafeMode": true
}
```

Or via environment variable:

```bash
CODEX_AUTH_BEGINNER_SAFE_MODE=1 opencode
```

This mode forces a more conservative retry profile and reduces the chance of long retry loops while you are debugging setup issues.

## Update the Plugin

From npm:

```bash
npx -y oc-codex-multi-auth@latest
```

From a local clone:

```bash
git pull
npm ci
npm run build
```

When `autoUpdate` is enabled (default), the plugin also checks npm daily and can clear the OpenCode plugin cache so a restart picks up a newer release.

## Next Reading

- [Tools and CLI](tools-and-cli.md)
- [Configuration Reference](configuration.md)
- [Troubleshooting](troubleshooting.md)
- [FAQ](faq.md)
- [Privacy & Data Handling](privacy.md)
- [Architecture Overview](architecture.md)

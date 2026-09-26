# FAQ

## What is this project?

`oc-codex-multi-auth` is an OpenCode plugin that lets you sign in with ChatGPT Plus/Pro through OAuth and use the GPT-5, GPT-6, and Codex model presets from OpenCode, including multi-account rotation, health checks, and recovery tools.

## Who is it for?

It is aimed at individual developers who use OpenCode and want ChatGPT-backed GPT-5 or Codex workflows for personal development. It is not intended for commercial resale, shared multi-user access, or production services.

## When should I use this instead of the OpenAI Platform API?

Use this plugin when you want a personal OpenCode workflow with your ChatGPT subscription. Use the OpenAI Platform API when you are building production software, shared services, or anything that needs explicit API billing and service terms.

## Do I need ChatGPT Plus or Pro?

Yes. The plugin depends on ChatGPT OAuth access and the model/workspace entitlements attached to your ChatGPT account.

## Which OpenCode versions are supported?

- OpenCode `v1.0.210+`: use the modern template with model variants
- OpenCode `v1.0.209` and earlier: use the legacy template with explicit model entries

See [config/README.md](../config/README.md) for the template split.

## What models are included by default?

The shipped templates include **10 base families** and **53 presets** total:

| Base | Family |
|------|--------|
| `gpt-6-astra` | GPT-6 Astra (responses-lite) |
| `gpt-6-sol` | GPT-6 Sol (responses-lite) |
| `gpt-6-luna` | GPT-6 Luna (responses-lite) |
| `gpt-5.6-sol` | GPT-5.6 (responses-lite) |
| `gpt-5.6-terra` | GPT-5.6 (responses-lite) |
| `gpt-5.6-luna` | GPT-5.6 (responses-lite) |
| `gpt-5.5` | GPT-5.5 (retires from Codex with ChatGPT sign-in on 2026-10-14; replacement `gpt-6-sol`/`gpt-6-luna`) |
| `gpt-5.5-fast` | GPT-5.5 Fast |
| `gpt-5.4-nano` | GPT-5.4 Nano |
| `gpt-5.1` | GPT-5.1 |

`gpt-5.4-mini`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, and `gpt-5.1-codex-mini` are no longer shipped: `gpt-5.4-mini` retired from Codex with ChatGPT sign-in on 2026-08-31 (replacement `gpt-6-luna`), and the other four were shut down from the OpenAI API on 2026-07-23 (replacement `gpt-5.6-sol`, or `gpt-5.6-terra` for `gpt-5.1-codex-mini`). They are still routed if you type one by hand.

GPT-5.6 is entitlement-gated for some accounts. Without access, the plugin auto-falls back `sol → terra → gpt-5.5 → gpt-6-luna → luna` (disable with `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`). Optional or entitlement-gated model IDs can be added manually when your workspace supports them. `gpt-5.5-pro` is ChatGPT-only and is not routed through this Codex plugin. GPT-6 Astra rolled out gradually from 2026-09-03 and auto-falls back `gpt-6-astra → gpt-6-sol → sol → terra → gpt-5.5 → gpt-6-luna → luna` (disable with `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1`); `gpt-6-astra-pro` is not a Codex-routable id and collapses onto `gpt-6-astra`. `gpt-6-sol` and `gpt-6-luna` were added to the catalog on 2026-09-22 and share the same auto-fallback opt-out. The chain terminal is `gpt-5.6-luna`, not `gpt-5.5`, since GPT-5.5 retires from Codex with ChatGPT sign-in on 2026-10-14. The legacy `gpt-5` alias now maps to `gpt-6-sol` (was `gpt-5.5`). The Daybreak-gated cyber tiers (`gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.6-cyber`) are routed but deliberately absent from the shipped templates, and have no fallback chain on purpose.

Default install preserves `provider.openai` and only registers plugin entries. Use `--modern` for compact bases + variants, `--full` for modern + explicit IDs, or `--legacy` for explicit-only.

## Can I use multiple accounts?

Yes. The plugin supports multiple ChatGPT accounts, health-aware rotation (`rotationStrategy`: `hybrid` default, `sticky`, or `round-robin`), per-project storage (default on), preferred model→account pools (`modelAccountPools` / `codex-pool`), and guided account management commands such as `codex-list`, `codex-switch`, and `codex-warm`. Hard limits: at most **20** saved OAuth accounts and a **30s** cooldown after auth failures. After **3** consecutive auth failures, the affected account is disabled rather than deleted; its credentials remain saved for recovery.

## How do I warm accounts without spending an agent turn?

Run the standalone CLI:

```bash
oc-codex-multi-auth warm
# or
npx -y oc-codex-multi-auth@latest warm
```

That opens every enabled account's usage window with no OpenCode agent loop. Inside a session you can still call `codex-warm`.

## Where does it store data?

Tokens, account state, plugin config, quota cache, and logs are stored locally on your machine. See [Privacy & Data Handling](privacy.md) for the exact paths. Account pools use V3 JSON by default; opt into the OS keychain with `CODEX_KEYCHAIN=1`. Session recovery may also touch OpenCode's message/part store under the host data directory. Older `openai-codex-*.json` filenames are migration sources only.

## Is there an API-key login?

No. The plugin registers four OAuth methods (default browser, open URL manually, device code, and manual URL paste). A dummy SDK key string is used internally for the OpenAI client, and ChatGPT OAuth tokens do the real auth.

## What should I do if authentication fails?

Start with [Troubleshooting](troubleshooting.md), rerun `opencode auth login`, and check whether another process is already using port `1455`.

## I used the old package name. What changed?

The supported package/plugin name is `oc-codex-multi-auth`. The legacy name `oc-chatgpt-multi-auth` is migration-only: the installer rewrites stale plugin entries and storage migrations may still recognize old files. Replace any remaining config references with `oc-codex-multi-auth`.

## Which Node version do I need?

Node.js `>=18`.

## Where is the full tool and CLI list?

See [Tools and CLI](tools-and-cli.md) for all 24 `codex-*` tools and the standalone bin commands.

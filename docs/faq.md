# FAQ

## What is this project?

`oc-codex-multi-auth` is an OpenCode plugin that lets you sign in with ChatGPT Plus/Pro through OAuth and use GPT-5/Codex model presets from OpenCode, including multi-account rotation, health checks, and recovery tools.

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

The shipped templates include **12 base families** and **53 presets** total:

| Base | Family |
|------|--------|
| `gpt-5.6-sol` | GPT-5.6 (responses-lite) |
| `gpt-5.6-terra` | GPT-5.6 (responses-lite) |
| `gpt-5.6-luna` | GPT-5.6 (responses-lite) |
| `gpt-5.5` | GPT-5.5 |
| `gpt-5.5-fast` | GPT-5.5 Fast |
| `gpt-5.4-mini` | GPT-5.4 Mini |
| `gpt-5.4-nano` | GPT-5.4 Nano |
| `gpt-5.1-codex-max` | GPT-5.1 Codex Max |
| `gpt-5.1-codex` | GPT-5.1 Codex |
| `gpt-5.1-codex-mini` | GPT-5.1 Codex Mini |
| `gpt-5.1` | GPT-5.1 |
| `gpt-5-codex` | GPT-5 Codex |

GPT-5.6 is entitlement-gated for some accounts. Without access, the plugin auto-falls back `sol → terra → luna → gpt-5.5` (disable with `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`). Optional or entitlement-gated model IDs can be added manually when your workspace supports them. `gpt-5.5-pro` is ChatGPT-only and is not routed through this Codex plugin.

Default install is compact modern (bases + variants). Use `--full` for modern + explicit IDs, or `--legacy` for explicit-only.

## Can I use multiple accounts?

Yes. The plugin supports multiple ChatGPT accounts, health-aware rotation (`rotationStrategy`: `hybrid` default, `sticky`, or `round-robin`), per-project storage (default on), preferred model→account pools (`modelAccountPools` / `codex-pool`), and guided account management commands such as `codex-list`, `codex-switch`, and `codex-warm`. Hard limits: at most **20** saved OAuth accounts, a **30s** cooldown after auth failures, and automatic removal after **3** consecutive auth failures on the same account.

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

No. The plugin registers three OAuth methods only (browser, device code, manual URL paste). A dummy SDK key string is used internally for the OpenAI client; ChatGPT OAuth tokens do the real auth.

## What should I do if authentication fails?

Start with [Troubleshooting](troubleshooting.md), rerun `opencode auth login`, and check whether another process is already using port `1455`.

## I used the old package name. What changed?

The supported package/plugin name is `oc-codex-multi-auth`. The legacy name `oc-chatgpt-multi-auth` is migration-only: the installer rewrites stale plugin entries and storage migrations may still recognize old files. Replace any remaining config references with `oc-codex-multi-auth`.

## Which Node version do I need?

Node.js `>=18`.

## Where is the full tool and CLI list?

See [Tools and CLI](tools-and-cli.md) for all 24 `codex-*` tools and the standalone bin commands.

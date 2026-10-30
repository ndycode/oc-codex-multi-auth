# FAQ

## What is this project?

An OpenCode plugin that signs you in with ChatGPT Plus/Pro over OAuth and
routes Codex/GPT-5/GPT-6 models, with multi-account rotation, quota status,
and recovery tools. Personal development use only — for production work use
the OpenAI Platform API.

## What do I need?

- [OpenCode](https://opencode.ai)
- A ChatGPT Plus or Pro subscription (Free is not supported)
- Node.js `>=22.19` to run the installer

## Which install mode should I use?

```bash
npx -y oc-codex-multi-auth@latest --modern
```

`--modern` fits most setups: it registers the plugin and writes the compact
catalog of 12 base models with 65 `--variant` presets. Use no flag to keep
your existing `provider.openai` untouched, `--full` to also get explicit
selector IDs, `--legacy` for older OpenCode, or `--v2` for OpenCode 2.0.16+.
See [Getting Started](getting-started.md).

## How do I log in?

`opencode auth login`, choose `OpenAI`, then pick one of the four OAuth
methods: browser (default), open URL manually, device code, or manual URL
paste. Run it once per account. The browser flows need port `1455` free for
the localhost callback; headless environments can use device code instead.
Details: [Getting Started](getting-started.md).

## Can I use several ChatGPT accounts?

Yes — that is the point of the plugin. Health-aware rotation (`hybrid` by
default) picks an account per request. Pools are per-project by default under
`~/.opencode/projects/<project-key>/`; set `CODEX_AUTH_PER_PROJECT_ACCOUNTS=0`
for one global pool at `~/.opencode/oc-codex-multi-auth-accounts.json`.
Manage them with `codex-list`, `codex-switch`, `codex-warm`, and `codex-pool`.

## Where is my data stored?

Locally, under `~/.opencode` — account JSON, plugin config, quota caches, and
optional request logs. Outbound traffic goes to OpenAI (OAuth and inference),
plus GitHub for prompt-template sync and the npm registry for the daily update
check (both documented in [Privacy](privacy.md)). To store accounts in the OS
keychain instead, set `CODEX_KEYCHAIN=1`. Exact paths and deletion steps are
on the same page.

## What do the quota percentages mean?

They are headroom left, matching how Codex reports quota — `5h 88%` means 88%
of the 5-hour window remains. Set `quotaDisplay: "used"` in
`~/.opencode/openai-codex-auth-config.json` to show consumption instead. The
prompt line can describe the whole pool (`quotaStatus.mode: "overview"`) or
banked reset credits (`"resets"`), or the Codex credits left once plan quota
is gone (`"credits"`); see
[Configuration](configuration.md).

## Is there an API-key login?

No. The plugin registers four OAuth methods only; the dummy SDK key in config
is a placeholder and ChatGPT OAuth tokens do the real auth.

## A model I used before is gone — now what?

Retired IDs still route: `gpt-5.4-mini`, `gpt-5-codex`, `gpt-5.1-codex`,
`gpt-5.1-codex-max`, and `gpt-5.1-codex-mini` resolve through the default
fallback chains (toward `gpt-6-sol`, `gpt-6-luna`, or the GPT-5.6 tiers).
`gpt-5.5` retires from Codex on 2026-10-14. The Daybreak-gated tiers are
routed but never shipped — add `gpt-daybreak-blue-latest`,
`gpt-daybreak-red-latest`, or `gpt-5.6-cyber` by hand if your workspace has
access. Chains and opt-outs: [Configuration](configuration.md).

## It broke — where do I start?

Run `codex-doctor fix=true` inside OpenCode, or
`oc-codex-multi-auth doctor --fix` from a shell, then sign in again with
`opencode auth login` if it still fails. The full symptom list is in
[Troubleshooting](troubleshooting.md).

## I used the old package name — do I need to change anything?

The supported name is `oc-codex-multi-auth`. Older `oc-chatgpt-multi-auth`
entries are migration-only: the installer rewrites stale plugin entries, and
storage migrations still read old files. Replace remaining config references
with `oc-codex-multi-auth`. The full rename and storage-migration story is in
[upgrade.md](upgrade.md).

## Where is the full command list?

[Tools and CLI](tools-and-cli.md) covers all 25 `codex-*` tools and the eight
standalone commands (`doctor`, `status`, `list`, `limits`, `dashboard`,
`health`, `diag`, `warm`).

## How does the vocabulary map to `codex-multi-auth`?

The sibling project [codex-multi-auth](https://github.com/ndycode/codex-multi-auth)
manages accounts for the official Codex CLI rather than OpenCode. Where the
same idea has a different name there:

| Here | codex-multi-auth |
| --- | --- |
| `codex-warm` / `warm` — open every enabled account's usage window | `check --prime`, `account auto-prime` — start windows on unused subscriptions |
| Banked reset credits (`codex-reset`) | Earned reset credits (`resets`) |
| Flagged (quarantined) account | Flagged (sidelined) account |
| Usage window / quota window | Quota window |
| `codex-diag` — redacted diagnostic snapshot | `debug bundle` |
| `codex-health` / `health` — local health summary | `check` — live health probe |

## How do I uninstall or disable it?

There is no `uninstall` command — remove the plugin entries from
`opencode.json`/`tui.json` by hand and delete state under `~/.opencode` if you
want it gone. Step-by-step: [Uninstall / disable](getting-started.md#uninstall--disable).

## Related

- [index.md](index.md)
- [getting-started.md](getting-started.md)
- [tools-and-cli.md](tools-and-cli.md)
- [troubleshooting.md](troubleshooting.md)
- [upgrade.md](upgrade.md)

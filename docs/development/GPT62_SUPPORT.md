# GPT-6.2 support

Verified on 2026-11-17 using OpenAI's release announcement, model documentation,
and the authenticated Codex model catalog (`/backend-api/codex/models`, client
version `0.169.0`). Only public model metadata was retained.

| Setting | `gpt-6.2-astra` | `gpt-6.2-sol` |
| --- | --- | --- |
| Codex default context | 272,000 | 500,000 |
| API maximum context | 1,050,000 | 1,050,000 |
| Maximum output | 128,000 | 128,000 |
| Default reasoning | low | low |
| Reasoning presets | low, medium, high, xhigh, max, ultra | low, medium, high, xhigh, max, ultra |
| Ultra wire effort | xhigh | xhigh |
| Responses-lite | true | true |
| Minimum client version | 0.166.0 | 0.166.0 |
| Catalog service tiers | priority | priority |
| Default service tier | unset | unset |
| Default verbosity | low | low |

Both accept text/image inputs and produce text. The plugin uses the Codex default
context limits in its templates. Ultra resolves the wire effort only; automatic
multi-agent orchestration remains a Codex client feature. The launch announcement
also advertises Ultrafast, but the live Codex catalog advertises only `priority`,
so this change does not invent an Ultrafast wire value.

Each model has a separate family, prompt cache, and account-rotation state.
The public GitHub catalog (main and rust-v0.169.0) did not yet contain the 6.2
entries at verification time. Instruction lookup tries the release catalog and
uses the existing prompt-file fallback until upstream includes those entries.

The new unsupported-model fallback rows start with the respective predecessor:
6.2 Astra → 6 Astra; 6.2 Sol → 6.1 Sol. They honor the existing GPT-6 auto-fallback
opt-out (`CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1`). Existing selectors retain
their existing fallback chains.

The live catalog also includes hidden `gpt-reserve` and `codex-auto-review`
entries. These are not newly released public general-purpose models and are not
added to the picker. Image/audio/video models use separate native OpenCode
protocols rather than this plugin's Codex chat transformation.

Sources:

- https://openai.com/index/introducing-gpt-6-2-astra-sol
- https://developers.openai.com/api/docs/models/gpt-6.2-astra
- https://developers.openai.com/api/docs/models/gpt-6.2-sol
- https://developers.openai.com/codex/models

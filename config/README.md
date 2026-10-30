# Config templates

Example `opencode.json` files shipped with `oc-codex-multi-auth`, and which
installer mode produces the same shape. Pick one file — the installer writes
these for you, you only copy by hand for a manual/debug setup.

## The files

| File | Installer equivalent | Contents |
| --- | --- | --- |
| [`minimal-opencode.json`](./minimal-opencode.json) | `npx -y oc-codex-multi-auth@latest` (plugin-only) | debug skeleton: registers the plugin and pins `model`, no model catalog — OpenCode supplies whatever models it knows |
| [`opencode-modern.json`](./opencode-modern.json) | `--modern` | compact catalog: 12 base model families with 65 variants via OpenCode's `--variant` picker (OpenCode v1.0.210+) |
| [`opencode-legacy.json`](./opencode-legacy.json) | `--legacy` | the same presets as 65 explicit selector entries (`gpt-5.5-medium`, …) for OpenCode v1.0.209 and below |
| (no file — merged output) | `--full` | modern bases **plus** all 65 explicit selector entries, for scripts that need typed ids |
| (no file — V1 skipped) | `--v2` | registers the plugin in the OpenCode V2 `plugins` entry only; no V1 catalog |

Other installer flags: `--plugin-only` (explicit form of the default),
`--dry-run` (preview without writing), `--no-cache-clear` (skip the OpenCode
plugin-cache cleanup), `update` (refresh the package cache without touching
config).

## Which file to pick

- **Just installed / not sure** → run the installer bare; equivalent to
  `minimal-opencode.json`. Add a catalog later with `--modern`.
- **OpenCode v1.0.210 or newer** → `opencode-modern.json` or `--modern`.
- **OpenCode v1.0.209 or older** → `opencode-legacy.json` or `--legacy`.
- **Need explicit selector ids for scripts/CI** → `--full` (there is no
  standalone file because it is the modern + legacy merge).
- Check your version with `opencode --version`, and confirm the merge with
  `opencode debug config`.

Every template keeps the two wire requirements the ChatGPT Codex backend
needs: `"store": false` and `reasoning.encrypted_content` in `include`.

## Runtime config is elsewhere

These files configure `~/.config/opencode/opencode.json`. The plugin's own
runtime settings (retries, rotation, model pools, quota display, per-project
account storage) live in `~/.opencode/openai-codex-auth-config.json` — see
[`docs/configuration.md`](../docs/configuration.md) for the full field table
and [`docs/development/CONFIG_FLOW.md`](../docs/development/CONFIG_FLOW.md)
for how settings resolve.

# PROJECT KNOWLEDGE BASE

`oc-codex-multi-auth` is an OpenCode plugin: ChatGPT Plus/Pro OAuth, multi-account
rotation with health scoring and cooldowns, quota-aware Codex/GPT routing
(GPT-5.6/GPT-6/Daybreak responses-lite included), diagnostics and recovery tools.
The npm bin is an installer for OpenCode config plus a thin standalone CLI
(`doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm`,
`update`) — not a daemon.

- OpenCode V1 loads `index.ts` (provider plugin) and `tui.ts` (prompt quota status) from the built `dist/` exports.
- OpenCode V2 loads the same package through the `setup` hook on each default export instead — see OPENCODE V2 below.
- Runtime state stays local under `~/.opencode`; per-project account pools are on by default. Project-root detection walks up for markers (`.git`, `package.json`, `.opencode`, …) and stops at the home directory — `$HOME` itself is never a project; outside a project the global pool is used.

## STRUCTURE

```text
./
├── index.ts        # V1 plugin: auth loader, fetch pipeline, rotation, ToolContext; default export { id, server, setup }
├── tui.ts          # V1 TUI plugin: prompt quota status + details; default export also carries V2 `setup`
├── lib/            # core runtime — module map and subsystem tables in lib/AGENTS.md
├── lib/tools/      # 25 `codex-*` tool factories + registry — see lib/tools/AGENTS.md
├── test/           # vitest suites — see test/AGENTS.md
├── scripts/        # npm bin (installer + standalone CLI), build and audit helpers
├── config/         # shipped opencode.json templates (minimal/modern/legacy)
├── docs/           # user docs; docs/development/ holds maintainer guides
├── skills/         # repo-local setup skill
├── assets/         # static assets
├── .codex-plugin/  # plugin metadata (version must match package.json)
└── dist/           # build output — generated, never edit
```

## WHERE TO LOOK

| Task | Location |
| --- | --- |
| V1 plugin orchestration | `index.ts` — OAuth loader, request pipeline, metrics, recovery, `ToolContext` assembly |
| TUI quota status | `tui.ts`, `lib/tui-status.ts`, `lib/tui-quota-cache.ts`, `lib/codex-usage.ts` |
| OpenCode V2 adapter | `lib/opencode-v2.ts` + `lib/opencode-v2-provider.ts`, `lib/opencode-v2-rpc.ts`, `lib/opencode-v2-status.ts`, `lib/opencode-v2-tui.ts` |
| `codex-*` tools | `lib/tools/index.ts` registry + one factory file per tool |
| OAuth (PKCE, callback server, device/manual login) | `lib/auth/` |
| Account selection, health, cooldowns | `lib/accounts.ts`, `lib/accounts/`, `lib/rotation.ts`, `lib/health.ts`, `lib/parallel-probe.ts` |
| Account storage (V3 JSON, keychain, locks, refresh coordination) | `lib/storage.ts`, `lib/storage/` |
| Request transform, SSE, retries | `lib/request/` and `lib/request/helpers/` |
| Model families + prompt templates | `lib/prompts/` |
| Plugin config + env overrides | `lib/config.ts`, `lib/schemas.ts` |
| Session recovery | `lib/recovery.ts`, `lib/recovery/` |
| Installer + standalone CLI | `scripts/install-oc-codex-multi-auth.js`, `scripts/install-oc-codex-multi-auth-core.js` |
| Maintainer architecture | `docs/development/ARCHITECTURE.md`; user-facing: `docs/architecture.md` |

## OPENCODE V2

V2 loads the same package via `setup`, not the V1 `server` hook. `index.ts`'s
default export is `{ id, server, setup }`; `setup` dynamically imports
`lib/opencode-v2.ts` and passes `createPluginRuntime` (the V1 factory), so
rotation, the auth loader, the tool registry, and the disposal hook are shared —
only the host contract differs. Per-location `createStorageScope`
(`lib/storage/state.ts`) keeps each V2 location's account-storage state separate.

- The adapter reroutes the `openai` provider/models through a distinct `aisdk:` package identity (`lib/opencode-v2-provider.ts`), then installs `aisdk` hooks that re-add the stateless contract (`store: false`, `reasoning.encrypted_content`, `opencode/<version>` UA) and strip server-side references (`previousResponseId`, `conversation`) that the Codex backend rejects.
- Quota/accounts status reaches TUIs over `CodexStatusRpc.status` — a remote TUI never touches credential files.
- The adapter stays inert until a pooled account or `openai` OAuth connection exists. Install mode `--v2` writes a `plugins` entry only; it refuses to migrate V1 `plugin` entries.

## CONVENTIONS

- ESM only (`"type": "module"`), Node `>=22.19.0`. Internal imports use `.js` specifiers so `dist/` resolves under Node ESM.
- ESLint flat config: `no-explicit-any` is an error; unused args take a `_` prefix; floating/misused promises are errors. Test files are relaxed (see `eslint.config.js`).
- No lib-wide barrel: import the focused module directly. `lib/accounts.ts`, `lib/storage.ts`, and `lib/recovery.ts` are domain facades that keep their subdirectory's pre-split import surface stable.
- Stateless Codex contract on every request: `store: false` plus the `reasoning.encrypted_content` include.
- Responses-lite models (GPT-6.1 Sol/Terra, GPT-6 Astra/Sol/Luna, Daybreak, GPT-5.6 Sol/Terra/Luna) get lite body shaping and default client identity `opencode`; other models default to `codex_cli_rs`.
- Boolean env overrides are truthy only for the literal `"1"` — never `"true"`/`"yes"`.
- Credential writes are atomic: 0600 temp file (POSIX mode bits only — Windows uses profile ACLs), fsync, rename, parent-dir fsync. A refresh committed upstream but not yet saved to the pool is journaled in a `<accounts-file>.refresh.pending.<hash>` file (one per consumed token; legacy unsuffixed `.refresh.pending` still replayed) beside the accounts file and applied on the next load.
- OS keychain backend is opt-in (`CODEX_KEYCHAIN=1`) and holds the same V3 JSON blob; any keychain failure falls back to the JSON path — never delete the JSON copy on a keychain error. On `win32`, Credential Manager's blob-size cap means oversized pools are size-checked and stay on the JSON path.

## ANTI-PATTERNS

- Do not edit `dist/` or `tmp*` directories.
- No `as any`, `@ts-ignore`, or `@ts-expect-error`.
- No public security issues — see `SECURITY.md`.
- No hardcoded ports. The only permitted one is the registered OAuth callback port `1455`, via `lib/oauth-constants.ts`.
- Do not remove `store: false` or `reasoning.encrypted_content` from the request path or shipped config templates.
- Do not expose account emails, access/refresh tokens, or raw prompt/response bodies in diagnostics, tool output, or logs.
- Do not run the installer to repair a developer machine's config — it writes that machine's real `opencode.json`/`tui.json`. `update` refreshes the package cache without touching config.
- Do not identify a plugin entry by the spelling of its last path segment — resolve what it points at. A path outside package-manager output (`node_modules`, the versioned OpenCode package cache) belongs to whoever wrote it and is never rewritten or removed.
- `oc-chatgpt-multi-auth` is the retired name — reference it only in migration/cleanup logic.

## COMMANDS

```bash
npm run build            # clean dist + tsc + emit oauth-success.html
npm run typecheck        # tsc --noEmit
npm run lint             # eslint .ts + scripts/*.js
npm test                 # vitest run
npm run test:coverage    # vitest run --coverage (per-file floors)
npm run audit:ci         # prod audit + dev allowlist
npx vitest run test/<name>.test.ts   # one suite
```

The installer writes the real `~/.config/opencode/opencode.json` and `tui.json` of
whoever runs it:

```bash
npx -y oc-codex-multi-auth@latest          # register plugin entries only
npx -y oc-codex-multi-auth@latest --full   # also install the explicit model catalog
npx -y oc-codex-multi-auth@latest update   # refresh package cache; never reads/writes config
```

Other modes: `--modern` (compact config), `--legacy` (explicit-only), `--v2`,
`--plugin-only`, `--dry-run`, `--no-cache-clear`. An existing plugin entry is
kept as-is, including one pointing at a working checkout.

## NOTES

- OAuth redirect `http://localhost:1455/auth/callback`; the callback server binds both `127.0.0.1` and `[::1]` on port 1455 (IPv6 bind failure is tolerated when IPv4 works).
- State files: plugin config `~/.opencode/openai-codex-auth-config.json`; per-project accounts `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json`; global accounts `~/.opencode/oc-codex-multi-auth-accounts.json`; flagged accounts, credential snapshots (`backups/codex-credential-snapshot-*`), pending-rotation journals (`<accounts-file>.refresh.pending.<hash>`), and quota-notification state sit beside the active accounts file; request logs `~/.opencode/logs/codex-plugin/` when enabled.
- Model catalog: 12 modern bases / 65 variants; legacy template ships 65 explicit entries. Routed but unshipped (add by hand): `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.6-cyber`. Retired but still resolved/falling back: `gpt-5.4-mini`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`.
- Prompt templates sync from Codex CLI GitHub releases with ETag caching; catalog instructions come from `model_messages.instructions_template` when `base_instructions` is empty; `BUNDLED_CODEX_INSTRUCTIONS` (`lib/prompts/codex-instructions.ts`) is the offline last resort.
- 5xx server errors rotate accounts with the same health penalty as network errors; RFC 8594 deprecation headers are logged as warnings.

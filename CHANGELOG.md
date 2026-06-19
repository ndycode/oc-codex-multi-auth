# Changelog

All notable changes to this project will be documented in this file. Dates are ISO format (YYYY-MM-DD).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `codex-doctor --fix` now clears stale account-health state on accounts whose token refresh succeeds during the repair: an `auth-failure`/`network-error` cooldown and any `rateLimitResetTimes` markers are removed once the refresh proves the credential is alive. Previously `--fix` refreshed the token and tried to switch to the healthiest account, but left the stale cooldown/rate-limit state in place, so no account was eligible and the dead routing persisted — the only recovery was hand-editing `oc-codex-multi-auth-accounts.json`. The stale TUI quota cache is also cleared so diagnostics no longer reference an account index/count that no longer matches the pool. (fixes #171)
- `codex-doctor` now surfaces a finding when a disabled `accountIdSource: "token"` entry shadows an enabled, org-backed account that shares its email (a leftover a fresh re-login can mint instead of updating the org account). It is flagged with a `codex-remove` hint rather than auto-removed, because the only link between the two records is email and email-only merges must not collapse distinct multi-org accounts (#64). (#171)
- `codex-doctor --fix` no longer fails silently when a stored credential is genuinely dead: a failed token refresh now reports `N account(s) need re-login` and points the user at `opencode auth login`, instead of leaving an all-dark pool unrepaired with no surfaced cause. (#171)
- `codex-health` now surfaces the same recovery diagnostics as `codex-doctor` (read-only): it flags accounts blocked only by a stale cooldown/rate-limit (pointing at `codex-doctor --fix`) and disabled token-source duplicates (pointing at `codex-remove`), and includes `staleRecoverableSlots` / `disabledDuplicateSlots` in JSON output. This addresses the part of the issue that named `codex-health` explicitly. (#171)

### Security
- Bumped `hono` to 4.12.26, resolving a high-severity Windows `serve-static` path traversal via encoded backslash (`%5C`) and four moderate advisories (GHSA-88fw-hqm2-52qc, GHSA-j6c9-x7qj-28xf, GHSA-rv63-4mwf-qqc2, GHSA-wgpf-jwqj-8h8p, GHSA-wwfh-h76j-fc44). This also clears the transitive `@openauthjs/openauth` advisory inherited via hono.
- Overrode `vite` to ^7.3.5, resolving a high-severity `server.fs.deny` bypass on Windows alternate paths and a moderate advisory (GHSA-fx2h-pf6j-xcff, GHSA-v6wh-96g9-6wx3) in the dev/test toolchain.
- Overrode `@babel/core` to ^7.29.6 (transitive via `@opentui/solid`), resolving a low-severity arbitrary file read via `sourceMappingURL` (GHSA-4x5r-pxfx-6jf8) without a major version bump.
- Added a `brace-expansion@>=5.0.0 <5.0.6` override to ^5.0.6, resolving a moderate ReDoS-class advisory in the 5.x line. `npm audit` now reports 0 vulnerabilities.

## [6.3.3] - 2026-06-17

### Fixed
- A stored OAuth account whose access token is invalidated server-side returns HTTP 401 (`Your authentication token has been invalidated. Please try signing in again.`), but the request pipeline had no 401 handler, so persisted family routing kept pinning every request to the dead account slot. A request-path 401 is now treated as an account-health failure: the consumed token is refunded, the auth-failure counter is incremented, the refresh-token group is cooled down (or removed past `MAX_AUTH_FAILURES_BEFORE_REMOVAL`), and the request rotates to the next healthy account. The counter is cleared on a successful request so a recovered account does not accumulate stale failures. (#172, fixes #171)
- `codex-health`/`codex-doctor` now flag `token-invalid` on an invalidated-token error (including a generic `401 Unauthorized` body), so `codex-doctor --fix` repairs the active routing without manual `activeIndex` JSON edits. (#172)

## [6.3.2] - 2026-06-10

### Fixed
- `gpt-5.3-codex-spark`, `gpt-5.3-codex`, and `gpt-5.2-codex` are no longer collapsed to `gpt-5-codex` before sending requests. Accounts where only the versioned model is available (not the base `gpt-5-codex`) no longer receive `model_not_supported_with_chatgpt_account` errors. (#170, fixes #169)
- Added `gpt-5.4-fast` and `gpt-5.4-mini-fast` as explicit model map entries so OpenCode fast-variant selectors resolve correctly.
- Reasoning effort `-none` suffix is intentionally absent for the three Codex families above; `getReasoningConfig()` coerces any `none` request to `low` for these models as before.

## [6.1.8] - 2026-04-29

### Fixed
- Local `npm link` installs now run the CLI wrapper correctly by resolving symlinked bin paths before direct-execution detection.
- Current audit validation follow-ups are resolved, including refreshed docs parity coverage.
- Request filtering now defaults missing or null `function_call.arguments` values to `{}` before forwarding.

## [6.1.7] - 2026-04-25

### Added
- OpenCode TUI prompt status plugin that shows the active Codex quota during sessions, including real response-header quota updates, account-aware display, color thresholds, and a quota details command.
- Daily npm update detection now clears the OpenCode-managed plugin cache on exit when a newer package version is available, so restarting OpenCode installs the latest plugin automatically.

### Changed
- The installer now manages OpenCode `tui.json` alongside the main plugin config so the TUI status module is available from the published package.
- TUI startup keeps the home prompt clean and only shows quota status inside active sessions.
- Added an `autoUpdate` config option and `CODEX_AUTH_AUTO_UPDATE=0` environment override for users who prefer manual update prompts.

### Fixed
- Quota status cache writes no longer block the request response path and coalesce rapid duplicate writes.
- Account switching clears stale TUI quota state so the next session reflects the selected account.
- Multi-account quota status now follows the actual account used by the latest request, including non-`codex` model families, so real response-header quota snapshots are not filtered out as stale.

## [6.1.6] - 2026-04-24

### Added
- OpenCode TUI prompt status plugin that shows the active Codex quota during sessions, including real response-header quota updates, account-aware display, color thresholds, and a quota details command.

### Changed
- The installer now manages OpenCode `tui.json` alongside the main plugin config so the TUI status module is available from the published package.
- TUI startup keeps the home prompt clean and only shows quota status inside active sessions.

### Fixed
- Quota status cache writes no longer block the request response path and coalesce rapid duplicate writes.
- Account switching clears stale TUI quota state so the next session reflects the selected account.
- Multi-account quota status now follows the actual account used by the latest request, including non-`codex` model families, so real response-header quota snapshots are not filtered out as stale.

## [6.1.5] - 2026-04-24

### Changed
- Default installer mode now writes the compact OAuth model catalog so OpenCode's model picker shows base models only; reasoning depth is selected through the variant picker.
- Added `--full` installer mode for users who still want explicit selector IDs such as `gpt-5.5-medium` and `gpt-5.5-fast-medium` installed into the model picker.
- Compact/default installs now prune explicit preset IDs and stale base model IDs from earlier catalogs so rerunning the installer actually cleans up the model picker.

## [6.1.4] - 2026-04-24

### Fixed
- Ship the `gpt-5.5-fast` modern config entry and explicit `gpt-5.5-fast-{none,low,medium,high,xhigh}` legacy selectors so OpenCode resolves `openai/gpt-5.5-fast-medium` before plugin routing.
- Clear OpenCode's newer package cache layout at `~/.cache/opencode/packages/{oc-codex-multi-auth,oc-chatgpt-multi-auth}@latest` during installer cache refresh.
- Normalize stale managed file-path and `file:///.../node_modules/...` plugin entries back to the official `oc-codex-multi-auth` package name when the installer runs.

## [6.1.3] - 2026-04-24

### Added
- Explicit `gpt-5.5-fast` / `gpt-5.5-fast-{none,low,medium,high,xhigh}` entries in the model map, normalizing to `gpt-5.5`. Without the explicit map entry, picking OpenCode's built-in `GPT-5.5 Fast` catalog item fell through the regex fallback with no per-model config lookup, which contributed to the `All N account(s) failed (server errors or auth issues)` symptom.
- Scoped auto-fallback for GPT-5.5: when the backend returns `model_not_supported_with_chatgpt_account` for `gpt-5.5`, the plugin now routes the retry to `gpt-5.4` automatically, even without `unsupportedCodexPolicy: "fallback"` or `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback`. Opt out with `CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1`. Legacy family fallback behavior is unchanged.

### Removed
- **GPT-5.5 Pro** model map entries (`gpt-5.5-pro`, `gpt-5.5-pro-{medium,high,xhigh}`, `gpt-5.5-pro-20260423*`), config template entries in `config/opencode-modern.json` and `config/opencode-legacy.json`, the `GPT_55_PRO_MODEL_ID` constant, the `gpt-5.5-pro -> gpt-5.5` fallback chain edge, and the related request-transformer / prompt-family branches. Per OpenAI's 2026-04-23 launch, GPT-5.5 Pro ships to ChatGPT only, not Codex; routing `gpt-5.5-pro*` through the Codex OAuth pipeline was producing `model_not_supported_with_chatgpt_account` on every pooled account. Any user-typed `gpt-5.5-pro*` still canonicalizes to `gpt-5.5` so the scoped auto-fallback chain can rescue it.

### Fixed
- The terminal aggregator message in `index.ts` no longer misreports across-the-pool entitlement 400s as `server errors or auth issues`. When `lastErrorCategory === "unsupported-model"` at exhaustion, the response now names the model and points to the fallback env var.
- Pre-existing `lib/request/fetch-helpers.ts` typecheck regression from the 6.1.2 release: `shouldRefreshToken(auth: Auth, ...)` referenced an `Auth` type that had been removed from the SDK import. Re-imported `Auth` from `@opencode-ai/sdk`.

## [6.1.2] - 2026-04-24

### Added
- GPT-5.5 2026-04-23 release presets in the shipped OpenCode config templates.

### Changed
- Activate GPT-5.5 2026-04-23 across runtime model routing and align the runtime model mapping with the new release family.

### Fixed
- Handle GPT-5.5 gating by falling back cleanly when the requested release is unavailable upstream.

## [6.1.1] - 2026-04-22

### Fixed
- Retry structured `service_unavailable_error` / `server_is_overloaded` payloads as server faults even on non-5xx responses, while preserving overload `retry_after` backoff when the account pool is exhausted.
- Retry live upstream `server_error` payloads that arrive on non-5xx responses instead of falling straight through as unrecoverable failures.
- Stabilize merged retry regression coverage so the overload and live `server_error` fetch-loop cases do not leak module state between tests.

## [6.1.0] - 2026-04-17

### Added
- `codex-keychain` opt-in OS-keychain credential backend via `CODEX_KEYCHAIN=1` (macOS Keychain / Windows Credential Manager / Linux libsecret) (#132, #133, #134)
- `codex-diag` redacted diagnostics snapshot tool for bug reports (#126)
- `codex-diff` redacted config/account comparator (#129)
- `NO_COLOR` and `FORCE_COLOR` environment-variable support in UI rendering (#126)
- Multi-worktree collision detection with non-blocking warning (#130)
- Circuit-breaker half-open gate wired into request pipeline (#123)
- 20-scenario chaos fault-injection test suite (#128)
- Contract tests pinning OpenAI OAuth, Codex chat, and Codex SSE response shapes (#131)
- Dependabot, OpenSSF Scorecard, commit-msg hook, and release-please automation (#125, #127)
- CI matrix: Node 18/20/22 on Ubuntu + Node 20 on Windows (#111)
- Typed error hierarchy (BaseError + domain classes) in `lib/errors.ts` (#120)

### Changed
- Refactor: `index.ts` reduced from 5975 to 3425 lines; all 18 tools extracted to `lib/tools/*` (#115, #121)
- Refactor: `lib/storage.ts` split from 1419 to 79 lines across 12 submodules under `lib/storage/` (#116)
- Refactor: `AccountManager` split into 4 domain services (state, persistence, rotation, recovery) (#122)
- Refactor: `lib/recovery.ts` consolidated to barrel pattern (#117)
- Refactor: renamed `lib/runtime-contracts.ts` into `lib/oauth-constants.ts` + `lib/error-sentinels.ts` (#118)
- Refactor: Zod-validate remaining process boundaries (#119)
- Removed dead modules `lib/auth-rate-limit.ts` and `lib/audit.ts` (854 lines total) (#109)

### Fixed
- **CRITICAL**: Serialize `incrementAuthFailures` via per-refresh-token promise chain to prevent lost auth-failure counts across shared refresh tokens (#108)
- Destructive defaults: `importAccounts` defaults to timestamped backup; `exportAccounts` defaults to `force: false`; `codex-remove` tool requires explicit `confirm: true` (#108)
- Shutdown SIGINT/SIGTERM now awaits debounced `flushPendingSave`, preventing lost rotations (#110)
- `schemaVersion > 3` now throws `StorageError(UNSUPPORTED_SCHEMA_VERSION)` instead of silently nulling data (#110)
- V2 storage files are detected and either migrated or rejected explicitly (no more silent drop) (#113)
- Credential merge: `||` â†’ `??` prevents empty-string tokens resurrecting stale older values (#112)
- `REDIRECT_URI` uses `127.0.0.1` literal for RFC 8252 compliance (#112)
- Codex-CLI cross-process JSON now Zod-validated before merging (#112)
- Logger `TOKEN_PATTERNS` extended to cover OpenAI opaque refresh/access/id tokens (#112, #126)
- Installer `scripts/install-oc-codex-multi-auth-core.js` deep-merges `provider.openai` instead of clobbering user customizations; added `--dry-run` (#114)
- F1 keychain post-merge: partial-migration staleness + `clearAccounts` ordering + rollback silent-clobber + lexicographic-sort bug (#133, #134)

### Documentation
- Full-repository audit delivered in `docs/audits/` (#107)
- README: added CI, Node, Scorecard, npm, license badges; new `Credential Storage` section (#124, #132)
- CONTRIBUTING: local development, contract-fixture update, real-keychain testing sections (#124, #131, #132)
- SECURITY: backend threat-model update (#132)
- ARCHITECTURE.md refreshed to reflect v6 module layout (#124)
- CHANGELOG: restructured to Keep-a-Changelog v1.1.0 (#124)

### Internal
- Per-file coverage floor (70%) for `lib/**` and `index.ts` in `vitest.config.ts` (#125)
- Test count: 2088 â†’ 2234 (+146 regression + chaos + contract tests)

## [6.0.0] - 2026-04-06

### Added

- **beginner operations toolkit**: added `codex-help`, `codex-setup` (with `wizard` mode + fallback), `codex-doctor` (`fix` mode), and `codex-next` for guided onboarding and recovery.
- **account metadata commands**: added `codex-tag` and `codex-note`, plus `codex-list` tag filtering.
- **interactive account pickers**: `codex-switch`, `codex-label`, and `codex-remove` now support optional index with interactive selection in compatible terminals.
- **backup/import safety controls**: `codex-export` now supports auto timestamped backup paths; `codex-import` adds `dryRun` preview and automatic pre-import backup on apply.
- **beginner safe mode config**: new `beginnerSafeMode` config key and `CODEX_AUTH_BEGINNER_SAFE_MODE` env override for conservative retry behavior.
- **startup preflight summary**: one-time startup health summary with recommended next action.
- **breaking rebrand migration**: current runtime storage now uses package-aligned files (`oc-codex-multi-auth-accounts.json`, `oc-codex-multi-auth-flagged-accounts.json`) with automatic migration from legacy package-era and pre-package storage names on first load.

### Changed

- **account storage schema**: V3 account metadata now includes optional `accountTags` and `accountNote`.
- **docs refresh for operational flows**: README + docs portal/development guides updated to reflect beginner commands, safe mode, interactive picker behavior, and backup/import safeguards.
- **repository presentation refresh**: rewrote the README as a landing page, added a public FAQ and code of conduct, refreshed package metadata, and removed stale CI/test claims from public docs surfaces.
- **test matrix expansion**: coverage now includes beginner UI helpers, safe-fix diagnostics edge cases, tag/note command behavior, and timestamped backup/import preview utilities.
- **package line renamed**: the supported package, repo, plugin entry, installer surface, and docs now use `oc-codex-multi-auth` instead of `oc-chatgpt-multi-auth`.
- **codex-first auth wording**: OAuth options, installer guidance, and onboarding docs now describe the Codex-first flow directly instead of the older MULTI-branded labels.

### Fixed

- **non-interactive command guidance**: optional-index commands provide explicit usage guidance when interactive menus are unavailable.
- **doctor safe-fix edge path**: `codex-doctor fix` now reports a clear non-crashing message when no eligible account is available for auto-switch.
- **first-time import flow**: `codex-import` no longer fails with `No accounts to export` when storage is empty; pre-import backup is skipped cleanly in zero-account setups.
- **installer cache hygiene**: the installer now removes both the old and new package names from OpenCode cache metadata so cutover installs do not stay pinned to stale artifacts.

## [5.4.8] - 2026-03-24

### Added

- **json codex-ops automation surfaces**: read-only Codex ops now support `format="json"` and expose routing visibility across status, metrics, dashboard, and doctor flows.
- **device-code login flow**: added a first-party ChatGPT device-code auth path for SSH, WSL, and other headless environments.

### Changed

- **login finalization parity**: regular OAuth, manual fallback, and device-code flows now share the same account-selection and persistence helpers.
- **runtime contract parity hardening**: centralized timeout, deactivated-workspace, and OAuth callback constants with dedicated runtime/doc parity coverage.
- **dependency audit cleanup**: refreshed the shipped dependency tree with updated `hono` and pinned audit overrides for deterministic audit resolution.

### Fixed

- **storage import contract drift**: preview and apply import flows now share one analysis path, keeping deduplication and count reporting aligned while preserving redacted backup failure reporting.
- **deactivated workspace rotation**: grouped refresh-token variants are removed together, traversal restarts onto healthy accounts, and the zero-removal fallback cools down the affected account safely.

## [5.4.3] - 2026-03-06

### Added

- **gpt-5.4 snapshot alias normalization**: added support for `gpt-5.4-2026-03-05*` and `gpt-5.4-pro-2026-03-05*` model IDs (including effort suffix variants).

### Changed

- **legacy GPT-5 alias target updated**: `gpt-5`, `gpt-5-mini`, and `gpt-5-nano` now normalize to `gpt-5.4` as the default general family.
- **gpt-5.4-pro family isolation**: prompt-family detection now keeps `gpt-5.4-pro` separate from `gpt-5.4` for independent prompt/cache handling while preserving fallback policy behavior (`gpt-5.4-pro -> gpt-5.4`).
- **OpenCode 5.4 template limits updated**: shipped OpenCode config templates now set `gpt-5.4*` context to `1,000,000` (output remains `128,000`) and docs now include optional `model_context_window` / `model_auto_compact_token_limit` tuning guidance.

### Fixed

- **5.4.3 regression/test coverage alignment**: expanded and corrected normalization, family-routing, and prompt-mapping tests for snapshot aliases, pro-family separation, and legacy alias behavior.

## [5.4.2] - 2026-03-05

### Added

- **gpt-5.4 + gpt-5.4-pro runtime support**: added model-map normalization and request-transform coverage for `gpt-5.4` (general) and optional `gpt-5.4-pro`.
- **gpt-5.4-pro fallback edge**: default unsupported-model fallback chain now includes `gpt-5.4-pro -> gpt-5.4` when fallback policy is enabled.

### Changed

- **template defaults updated to gpt-5.4**: modern + legacy config templates now use `gpt-5.4` variants as the default general-purpose family.
- **docs refresh for 5.4 rollout**: README, getting-started, configuration, troubleshooting, docs index, and config docs now reflect `gpt-5.4` defaults and optional `gpt-5.4-pro` usage.
- **test matrix expanded for 5.4**: unit, integration, and property tests now explicitly cover `gpt-5.4` and `gpt-5.4-pro` normalization/reasoning/fallback paths.

### Fixed

- **quota probe model order**: quota snapshot probing now includes `gpt-5.4` first before legacy Codex probe models.

## [5.4.0] - 2026-02-28

### Changed

- **organization/account identity matching hardening**: org-scoped matching and collision pruning now enforce accountId-aware compatibility to preserve distinct same-org workspace identities.
- **id-token organization binding source strictness**: id-token candidate org binding now prioritizes `idToken['https://api.openai.com/auth'].organizations[0].id`.

### Fixed

- **organization-scoped account preservation**: account restoration now preserves organization/workspace identity across token refresh and flagged-account recovery paths.
- **no-org duplicate collapse alignment**: fallback no-org duplicates now collapse consistently across storage, authorize, and prune operations.
- **active-index remap stability**: index remapping during collision pruning/dedupe maintains stable active-index selection after account deduplication.

## [5.3.0] - 2026-02-22

### Added

- **workspace-aware account persistence**: oauth workspace candidates are preserved as distinct account entries to keep per-workspace routing stable across multi-account sessions.

### Fixed

- **organization identity reconciliation**: account restoration now preserves organization/workspace identity across token refresh and flagged-account recovery paths.
- **verify-flagged restore identity loss**: flagged-account restore no longer drops `organizationId` when an `accountId` already exists.

### Changed

- **documentation alignment with current runtime structure**: refreshed README and docs portal/architecture guides to reflect native-vs-legacy request transforms, workspace-aware identity behavior, and current preset/test counts.

## [5.2.3] - 2026-02-21

### Fixed

- **tool-call compatibility with current OpenCode runtime**: default request handling now preserves native OpenCode payload/tool definitions, avoiding bridge-side alias rewrites that could trigger invalid tool-call schemas.
- **bridge/tool-name drift failures**: Codex bridge instructions now anchor on the runtime-provided tool manifest and explicitly avoid translating/inventing tool names.

### Changed

- **request transform mode control**: added `requestTransformMode` (`native` default, `legacy` opt-in) plus `CODEX_AUTH_REQUEST_TRANSFORM_MODE=legacy` for compatibility fallback.
- **legacy codex-mode scope**: Codex compatibility rewrites and bridge prompt shaping are now legacy-mode behavior; native mode keeps host request shape unchanged.

## [5.2.1] - 2026-02-20

### Fixed

- **tool mapping conflicts in codex bridge/remap prompts**: removed contradictory guidance that treated `patch` as forbidden and aligned instructions so `apply_patch` intent maps to `patch` (preferred) or `edit` for targeted replacements.
- **OpenCode codex prompt source brittleness**: prompt fetch now retries across multiple upstream source URLs instead of relying on a single path that could return 404.

### Changed

- **prompt fetch configurability**: added `OPENCODE_CODEX_PROMPT_URL` override support and source-aware cache metadata so ETag conditional requests stay bound to the same source.
- **regression coverage + docs wording**: updated prompt assertions/tests for the new `patch`+`edit` policy and refreshed architecture documentation text to match.

## [5.2.0] - 2026-02-13

### Added

- **gpt-5.3-codex-spark normalization + routing**: added internal model mapping/family support for `gpt-5.3-codex-spark` and Spark reasoning variants.
- **generic unsupported-model fallback engine**: entitlement rejections now support configurable per-model fallback chains via `fallbackOnUnsupportedCodexModel` and `unsupportedCodexFallbackChain`.

### Changed

- **unsupported-model policy defaults**: introduced `unsupportedCodexPolicy` (`strict`/`fallback`) with strict mode as default; legacy `fallbackOnUnsupportedCodexModel` now maps to policy behavior.
- **entitlement handling flow**: on unsupported-model errors, plugin now tries remaining accounts/workspaces before model fallback, improving Spark entitlement discovery across multi-account setups.
- **fast-session reasoning summary**: fast mode now uses `reasoning.summary = "auto"` (invalid/legacy summary values sanitize to `auto`).
- **legacy fallback compatibility**: `fallbackToGpt52OnUnsupportedGpt53` / `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` now act as a legacy edge toggle inside the generic fallback flow.
- **documentation refresh**: README, configuration, getting-started, troubleshooting, and config template docs now describe strict/fallback controls, Spark entitlement gating, and optional manual Spark template additions.

## [5.1.1] - 2026-02-08

### Fixed

- **provider-prefixed model config resolution**: `openai/<model>` ids now correctly resolve to their base model config instead of falling back to global defaults.
- **codex variant option merging**: variant suffixes like `-xhigh` now apply `models.<base>.variants.<variant>` options during request transformation.

## [5.1.0] - 2026-02-08

### Changed

- **workspace candidate selection hardened**: OAuth workspace auto-selection now prefers org defaults, id-token-selected workspace IDs, and non-personal org candidates before falling back to token-derived personal IDs.

### Fixed

- **business workspace routing**: explicit org/manual workspace bindings are now preserved at request time and no longer overwritten by token `chatgpt_account_id` values.
- **gpt-5.3-codex on Business accounts**: fixed a dual-workspace path where requests could be routed to personal/free workspace IDs and fail with unsupported-model errors.

## [5.0.0] - 2026-02-08

### Changed (BREAKING)

- **auth login interaction redesigned**: `opencode auth login` now defaults to the Codex-style dashboard flow (actions/accounts/danger zone) instead of the legacy add/fresh-only prompt.
- **styled codex tool output default**: `codex-list`, `codex-status`, `codex-health`, `codex-switch`, `codex-remove`, `codex-refresh`, `codex-export`, and `codex-import` now default to the new Codex TUI formatting; scripts parsing legacy plain output should update or set `codexTuiV2: false`.

### Added

- **codex tui runtime controls**: new config + env options for UI behavior: `codexTuiV2`, `codexTuiColorProfile`, `codexTuiGlyphMode`, `CODEX_TUI_V2`, `CODEX_TUI_COLOR_PROFILE`, and `CODEX_TUI_GLYPHS`.
- **full account dashboard actions**: interactive login now supports add/check/deep-check/verify-flagged/start-fresh, plus account-level actions (enable/disable, refresh, delete).
- **dedicated flagged storage**: introduced `openai-codex-flagged-accounts.json` with automatic migration from legacy `openai-codex-blocked-accounts.json`.
- **ui architecture + coverage**: added shared terminal UI runtime/theme/format modules and parity documentation (`TUI_PARITY_CHECKLIST.md`) with focused tests.

### Fixed

- **disabled account safety**: disabled accounts are now excluded from active/current selection and rotation paths.
- **enabled-flag migration**: `enabled` account state now survives v1->v3 storage migration and persists reliably across save/load cycles.

## [4.14.2] - 2026-02-08

### Changed

- **gpt-5.3 fallback default**: fallback from `gpt-5.3-codex` to `gpt-5.2-codex` on ChatGPT entitlement rejection is now enabled by default for all users.
- **strict-mode opt-out**: strict behavior is now opt-out via `fallbackToGpt52OnUnsupportedGpt53: false` or `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52=0`.

### Fixed

- **unsupported-model handling**: normalized the upstream 400 (`"not supported when using Codex with a ChatGPT account"`) to a clear entitlement-style error instead of generic bad-request handling.

## [4.14.1] - 2026-02-07

### Added

- **fast session mode**: optional low-latency tuning (`fastSession`) with `hybrid`/`always` strategies and configurable history window (`fastSessionMaxInputItems`).

### Changed

- **prompt caching**: codex + opencode bridge prompts now use stale-while-revalidate + in-memory caching; startup prewarms instruction caches to reduce first-turn latency.
- **request parsing**: fetch pipeline now normalizes `Request` inputs and supports non-string bodies (Uint8Array/ArrayBuffer/Blob) without failing request transformations.

### Fixed

- **trivial-turn overhead**: in fast session mode, trivial one-liners can omit tool definitions and compact instructions to reduce roundtrip time.

## [4.14.0] - 2026-02-05

### Added

- **gpt-5.3-codex model support**: added end-to-end normalization and routing for `gpt-5.3-codex` with `low`, `medium`, `high`, and `xhigh` variants.
- **new codex family key**: account rotation/storage now tracks `gpt-5.3-codex` independently in `activeIndexByFamily`.

### Changed

- **reasoning defaults**: `gpt-5.3-codex` now defaults to `xhigh` effort (matching the current codex-family behavior), and `none`/`minimal` are normalized to supported codex levels.
- **prompt fetch/cache mapping**: prompt family detection now …92 tokens truncated…atency counters for the current plugin process.
- **401 diagnostics payload**: normalized 401 errors now include `diagnostics` (for example `requestId`, `cfRay`, `correlationId`, `threadId`) to speed up debugging.
- **stream watchdog controls**: new `fetchTimeoutMs` and `streamStallTimeoutMs` config options (and env overrides) for upstream timeout tuning.

### Changed

- **request correlation**: each upstream fetch now sets a correlation id, reuses `CODEX_THREAD_ID`/`prompt_cache_key` when available, and clears scope after each request.
- **plan-mode tool gating**: `request_user_input` is automatically stripped from tool definitions when collaboration mode is Default (kept in Plan mode).
- **safety prompt hardening**: bridge/remap prompts now explicitly block destructive git commands unless the user asks for them.
- **gpt-5.2-codex default effort**: default reasoning now prefers `xhigh` when no explicit effort/variant is provided.
- **gitignore hygiene**: local planning/release scratch artifacts are now ignored to keep working trees clean.

### Fixed

- **non-stream SSE hangs**: non-streaming SSE parsing now aborts stalled reads instead of waiting indefinitely.

## [4.12.5] - 2026-02-04

### Changed

- **per-project storage location**: project-scoped account files now live under `~/.opencode/projects/<project-key>/openai-codex-accounts.json` instead of writing into `<project>/.opencode/`.

### Added

- **legacy migration**: when the new project-scoped path is empty, the plugin now auto-migrates legacy `<project>/.opencode/openai-codex-accounts.json` data on first load.

## [4.12.4] - 2026-02-03

### Added

- **Empty response retry** - Automatically retries when the API returns empty/malformed responses. Configurable via `emptyResponseMaxRetries` (default: 2) and `emptyResponseRetryDelayMs` (default: 1000ms)
- **PID offset for parallel agents** - When multiple OpenCode instances run in parallel, each process now gets a deterministic offset for account selection, reducing contention. Enable with `pidOffsetEnabled: true`

### Changed

```json
{
  "emptyResponseMaxRetries": 2,
  "emptyResponseRetryDelayMs": 1000,
  "pidOffsetEnabled": false
}
```

- Environment variables:
- `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES`
- `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS`
- `CODEX_AUTH_PID_OFFSET_ENABLED`

- **Test coverage** - 1516 tests across 49 files (up from 1498)

### Fixed

- **PID offset formula** - Fixed bug where all accounts received the same offset (now uses `account.index * 0.131 + pidBonus` for unique distribution)
- **Empty response detection** - Hardened `isEmptyResponse()` to correctly identify empty choice objects (`[{}]`) and whitespace-only content as empty
- **Test mocks** - Fixed `index.test.ts` mocks for `createLogger` and new config getters (55 tests were failing)

### Notes
- npm publish status: not published on npm (tag/release only).

## [4.12.3] - 2026-02-03

### Changed

- **Test coverage** - Up to 89% coverage (1498 tests)
- **Code quality** - Various improvements from audit

### Fixed

- **Account persistence fix** - Accounts were being saved to the wrong location when `perProjectAccounts` was enabled (default). The issue was that `setStoragePath()` only ran in the loader, but authorize runs before that. So accounts got written to the global path, then the loader looked in the per-project path and found nothing. Both OAuth methods (browser and manual URL paste) now init storage path before saving. (#19)

## [4.12.2] - 2026-01-30

### Fixed

- **TUI crash on workspace prompt** - Removed redundant workspace selection prompt (auto-selects default now). Added `isNonInteractiveMode()` to detect TUI/Desktop environments. (#17)
- **Web UI validation error** - Added validate function to manual OAuth flow for proper error messages instead of `[object Object]`.

## [4.12.1] - 2026-01-30

### Changed

- **Audit logging** - Rotating file audit log with structured entries
- **Auth rate limiting** - Token bucket rate limiting (5 req/min/account) 
- **Proactive token refresh** - Refreshes tokens 5 minutes before expiry
- **Zod schemas** - Runtime validation as single source of truth

- ### Stats
- **Tests**: 580 Ã¢â€ â€™ 631 (+51)
- All passing on Windows with `--pool=forks`

### Fixed

- **Business plan workspace fix** - Fixed the "usage not included" errors some Business plan users were hitting. Turns out we were sending a stale stored accountId instead of pulling the fresh one from the token - problematic when you've got multiple workspaces. (#17, h/t @alanzchen for the detailed trace)
- **Persistence errors actually visible now** - Storage failures used to fail silently unless you had debug mode on. Now you get a proper error toast with actionable hints (antivirus exclusions on Windows, chmod suggestions on Unix). (#19)
- **Atomic writes for account storage** - Switched to temp file + rename to avoid corrupted state if a write gets interrupted mid-flight.
- **Fixed a reader lock leak** - The SSE response handler wasn't releasing its lock in the finally block. Small thing but could cause issues over time.
- **Debug logging for rotation** - Added some visibility into which account gets picked and why during rotation.

## [4.12.0] - 2026-01-30

### Changed (BREAKING)

- **tool rename**: all `openai-accounts-*` tools renamed to shorter `codex-*` prefix:
  - `openai-accounts` â†’ `codex-list`
  - `openai-accounts-switch` â†’ `codex-switch`
  - `openai-accounts-status` â†’ `codex-status`
  - `openai-accounts-health` â†’ `codex-health`
  - `openai-accounts-refresh` â†’ `codex-refresh`
  - `openai-accounts-remove` â†’ `codex-remove`

### Added

- **codex-export**: export all accounts to a portable JSON file for backup or migration
- **codex-import**: import accounts from a JSON file, merges with existing accounts (skips duplicates)

## [4.11.2] - 2026-01-30

### Fixed

- **windows account persistence**: fixed silent failure when saving accounts on Windows. errors are now logged at WARN level with storage path in message, and a toast notification appears if persistence fails.

## [4.11.1] - 2026-01-29

### Changed

- This plugin provides 6 built-in tools for managing your OpenAI accounts. Just ask the agent or type the tool name directly.

- | Tool | What It Does | Example Prompt |
- |------|--------------|----------------|
- | `openai-accounts` | List all accounts | "list my accounts" |
- | `openai-accounts-switch` | Switch active account | "switch to account 2" |
- | `openai-accounts-status` | Show rate limits & health | "show account status" |
- | `openai-accounts-health` | Validate tokens (read-only) | "check account health" |
- | `openai-accounts-refresh` | Refresh & save tokens | "refresh my tokens" |
- | `openai-accounts-remove` | Remove an account | "remove account 3" |

### Fixed

- **Zod validation error** - Fixed crash when calling `openai-accounts-status` with no accounts configured

## [4.11.0] - 2026-01-29

### Added

- **Subdirectory detection** - Per-project accounts now work from subdirectories. The plugin walks up the directory tree to find the project root (identified by `.git`, `package.json`, `pyproject.toml`, etc.)
- **Live countdown timer** - Rate limit waits now show a live countdown that updates every 5 seconds: `Waiting for rate limit reset (2m 35s remaining)`
- **Auto-remove on auth failure** - Accounts are automatically removed after 3 consecutive auth failures, with a notification explaining what happened. No more manual cleanup of dead accounts.
- **openai-accounts-refresh tool** - Manually refresh all OAuth tokens to verify they're still valid

## [4.10.0] - 2026-01-29

### Added
- **per-project accounts**: each project gets its own account storage now. no more conflicts when working across different repos with different chatgpt accounts. auto-detects project directories (looks for .git, package.json, etc). falls back to global storage if you're not in a project folder.
- **configurable toast duration**: rate limit notifications stick around longer now (5s default). set `toastDurationMs` in config if you want them longer/shorter.
- **account removal tool**: new `openai-accounts-remove` tool to delete accounts by index. finally.
- **token masking in logs**: all tokens, api keys, and bearer headers are now masked in debug logs. no more accidentally leaking creds.

### Changed
- **account limit bumped to 20**: was 10, now 20. add more accounts if you need them.
- **per-project accounts default on**: `perProjectAccounts` defaults to `true` now. disable with `perProjectAccounts: false` in config if you want the old global behavior.

### Fixed
- **token refresh race condition**: added `tokenRotationMap` to prevent concurrent refresh requests from stepping on each other.
- **rate limit retry jitter**: 20% jitter on retry delays to prevent thundering herd.
- **apply_patch infinite loop**: removed apply_patch references from codex bridge that caused loops in some edge cases.

### Notes
new options in `~/.opencode/openai-codex-auth-config.json`:
```json
{
  "perProjectAccounts": true,
  "toastDurationMs": 5000
}
```

env vars:
- `CODEX_AUTH_PER_PROJECT_ACCOUNTS=1` - enable per-project accounts
- `CODEX_AUTH_TOAST_DURATION_MS=8000` - set toast duration in ms

## [4.9.7] - 2026-01-29

### Fixed
- business/team workspace selection: detect multiple workspace account IDs from oauth tokens and prompt for the correct one.
- prevent refresh/hydration from overwriting selected workspace ids (org/manual choices remain stable).
- persist workspace labels and sources for clearer account listings.

### Added
- `CODEX_AUTH_ACCOUNT_ID` override to force a specific workspace id (non-interactive login).
- troubleshooting guidance for "usage not included in your plan".

## [4.9.6] - 2026-01-27

### Changed

- **tui auth gating**: non-tty/ui auth attempts now return a clear instruction to run `opencode auth login` in a terminal shell.
- **error-mapping simplification**: consolidated entitlement/rate-limit mapping in fetch helpers for a single handling path.

## [4.9.5] - 2026-01-28

### Changed

- When your ChatGPT subscription didn't include Codex access, the plugin kept rotating through all accounts and retrying forever because it thought it was a temporary rate limit.

- You get an immediate, clear error: "This model is not included in your ChatGPT subscription."

### Fixed

- **Account error handling** - Fixes infinite retry loop when account doesn't have access to Codex models. `usage_not_included` errors now return 403 Forbidden instead of being treated as rate limits. Clear error message explaining the subscription issue. Prevents pointless account rotation for non-recoverable errors. (#16, thanks @rainmeter33-jpg!)

## [4.9.4] - 2026-01-27

### Added

- **TUI auth flow disabled** - We now strictly enforce using `opencode auth login` in the terminal for authentication. The UI-based 'Connect' flow is disabled with a clear message to prevent issues with non-interactive environments.

### Changed

- **Strict tool schema validation** - Added filtering of required fields, flattening enums for compatibility with strict models like Claude/Gemini

### Fixed

- **Manual login fixed** - Parsing of OAuth URLs with fragments (`#code=`) is fixed
- **Account switching** - Manual selection is now strictly prioritized over rotation logic
- **apply_patch enabled** - The bridge prompt now allows the `apply_patch` tool

## [4.9.3] - 2026-01-27

### Changed

- **Strict schema validation** - Ported robust tool cleaning logic from `antigravity-auth`. Automatically normalizes tool definitions to prevent errors with strict models (like Claude or Gemini):
  - Filters out `required` fields that are not defined in `properties`
  - Flattens `anyOf` schemas with `const` values into standard `enum` arrays
  - Converts nullable array types into single types with a description note
  - Injects placeholder properties for empty object parameters
- **Enabled apply_patch** - Updated the Codex bridge prompt to allow the `apply_patch` tool

### Fixed

- **Manual login fixed** - The plugin now correctly parses OAuth redirect URLs that use fragments (e.g., `#code=...`). Previously, it only looked for query parameters, which caused manual copy-paste logins to fail with a redirection error.
- **Account switching logic** - Changed account selection logic to strictly respect your manual choice. Before this fix, the hybrid rotation algorithm would sometimes override your selection based on account health or token scores.
- **TUI integration** - Implemented the missing event handler for the TUI. When you click an account in the interface, it now triggers the `openai.account.select` event, saves the new active index to disk, and shows a confirmation toast.
- **Removed API key option** - Removed the 'API Key' authentication method from the list because this plugin is designed for OAuth only.

## [4.9.2] - 2026-01-27

### Fixed

- **Auth prompts moved to TUI** - Avoids readline input conflicts
- **Error payload normalization** - Improves rate-limit handling and rotation

### Notes
- npm publish status: not published on npm (tag/release only).

## [4.9.1] - 2026-01-26

### Changed

- When `opencode auth login` called the authorize function, `inputs` was `undefined`. The code had a conditional check that only entered the multi-account while loop if `inputs` existed with keys. This caused only single-account flow to run.

### Fixed

- **Multi-account flow always runs** - authorize() now always uses multi-account flow regardless of inputs parameter. (#12)

- Removed the conditional check so multi-account flow always runs, allowing users to add multiple ChatGPT accounts.

## [4.9.0] - 2026-01-26

**breaking: package renamed from `opencode-openai-codex-auth-multi` to `oc-chatgpt-multi-auth`**

### Changed
- **package renamed** to bypass opencode's plugin blocking. opencode skips any plugin with `opencode-openai-codex-auth` in the name. the new name `oc-chatgpt-multi-auth` works correctly.
- updated all documentation, configs, and references to use new package name.
- added `multiAccount` flag check in loader to coexist with opencode's built-in auth.

### Fixed
- removed debug console.log statements from loader.
- plugin now properly detects when it should handle auth vs deferring to built-in.

### Notes
update your `~/.config/opencode/opencode.json`:
```json
{
  "plugin": ["oc-chatgpt-multi-auth@latest"]
}
```

## Legacy 4.8.2 (Package-Only) - 2026-01-25

### Changed
- fix node esm plugin load by importing tool from `@opencode-ai/plugin/tool` and ensuring runtime dependency is installed.
- correct package metadata (repository links, update-check package name) and add troubleshooting guidance for plugin install/load.

### Notes
- npm package line: published under `opencode-openai-codex-auth-multi` (legacy package), not `oc-chatgpt-multi-auth`.

## [4.7.0] - 2026-01-25

**feature release**: full session recovery system ported from opencode-antigravity-auth.

### Added
- **session recovery system**: automatic recovery from common api errors that would previously crash sessions:
  - `tool_result_missing`: handles interrupted tool executions (esc during tool run)
  - `thinking_block_order`: fixes corrupted thinking blocks in message history
  - `thinking_disabled_violation`: strips thinking blocks when switching to non-thinking models
- **new recovery module** (`lib/recovery/`):
  - `types.ts` - type definitions for stored messages, parts, and recovery
  - `constants.ts` - storage paths (xdg-compliant) and type sets
  - `storage.ts` - filesystem operations for reading/writing opencode session data
  - `index.ts` - module re-exports
- **main recovery logic** (`lib/recovery.ts`):
  - `detectErrorType()` - identifies recoverable error patterns from api responses
  - `isRecoverableError()` - quick check for recovery eligibility
  - `createSessionRecoveryHook()` - creates hook for session-level error recovery
  - toast notifications during recovery attempts
- **new configuration options**:
  - `sessionRecovery` (default: `true`) - enable/disable session recovery
  - `autoResume` (default: `true`) - auto-resume session after thinking block recovery
  - environment variables: `CODEX_AUTH_SESSION_RECOVERY`, `CODEX_AUTH_AUTO_RESUME`
- **26 new unit tests** for recovery system

### Changed
- **account label format**: changed from `Account N (email)` to `N. email` for cleaner display
- **error response handling**: `handleErrorResponse()` now returns `errorBody` for recovery detection
- enhanced error logging with recoverable error detection in fetch flow

### Notes
- npm package line: published under `opencode-openai-codex-auth-multi` (legacy package), not `oc-chatgpt-multi-auth`.

## [4.6.0] - 2026-01-25

**feature release**: context overflow handling and missing tool result injection.

### Added
- **context overflow handler**: gracefully handles "prompt too long" / context length exceeded errors:
  - returns synthetic sse response with helpful instructions instead of raw 400 error
  - suggests `/compact`, `/clear`, or `/undo` commands to reduce context size
  - prevents opencode session from getting locked on context overflow
  - new module: `lib/context-overflow.ts`
- **missing tool result injection**: automatically handles cancelled tool calls (esc mid-execution):
  - detects orphaned `function_call` items (calls without matching outputs)
  - injects synthetic output: `"Operation cancelled by user"`
  - prevents "missing tool_result" api errors when user cancels mid-tool
  - new function: `injectMissingToolOutputs()` in `lib/request/helpers/input-utils.ts`
- **34 new unit tests** for context overflow and tool injection

### Notes
- npm package line: published under `opencode-openai-codex-auth-multi` (legacy package), not `oc-chatgpt-multi-auth`.

## [4.5.0] - 2026-01-24

### Added
- **strict tool validation**: automatically cleans tool schemas for compatibility with strict models (claude, gemini)
- **auto-update notifications**: get notified when a new version is available
- **22 model presets**: full variant system with reasoning levels (none/low/medium/high/xhigh)

### Changed
- health-aware account rotation with automatic failover
- hybrid selection prefers healthy accounts with available tokens

### Notes
- npm package line: published under `opencode-openai-codex-auth-multi` (legacy package), not `oc-chatgpt-multi-auth`.

## Legacy 4.4.0 (Package-Only) - 2026-01-23

### Added
- **health scoring**: tracks success/failure per account
- **token bucket**: prevents hitting rate limits
- **always retries** when all accounts are rate-limited (waits for reset)

### Notes
new retry options:
- `retryAllAccountsRateLimited` (default: `true`)
- `retryAllAccountsMaxWaitMs` (default: `0` = unlimited)
- `retryAllAccountsMaxRetries` (default: `Infinity`)

### Notes
- npm publish status: not published on npm (tag/release only).

## [4.3.1] - 2026-01-23

### Added

- **openai-accounts-status --json** - Scriptable status output with email/ID labels

### Changed

- **Account labels** - Now prefer email and show ID suffix when available; list/status outputs are columnized for readability
- **Email normalization** - Stored account emails are trimmed/lowercased when present

- @opencode-ai plugin/sdk 1.1.34
- hono 4.11.5
- vitest 4.0.18
- @types/node 25.0.10
- @typescript-eslint 8.53.1

- @andremxmx for reporting the multi-account ID issue (#4)

### Notes
- npm package line: published under `opencode-openai-codex-auth-multi` (legacy package), not `oc-chatgpt-multi-auth`.

# Changelog

All notable changes to this project are documented in this file. Dates use ISO format (`YYYY-MM-DD`).

The current stable release line is `6.x`. This file is the complete release history — there is no `docs/releases/` archive. Conventions: entry headings are `## [x.y.z] - YYYY-MM-DD`; section headings come from `Added`, `Changed`, `Fixed`, `Removed`, `Security`, `Internal`, `Notes`; issue and pull-request references link as `[#N](https://github.com/ndycode/oc-codex-multi-auth/issues/N)`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.30.0] - 2026-10-31

### Added
- GPT-6.1 Terra (`gpt-6.1-terra`) with `low`, `medium`, `high`, `xhigh`, `max`, and `ultra` efforts. It has its own model family and prompt cache (and no auto-fallback chain), uses responses-lite, and ships in both config templates with a `low` default. The catalog now covers 12 bases and 65 variants. ([#299](https://github.com/ndycode/oc-codex-multi-auth/pull/299), thanks @WarGloom)
- Codex Fast tier. A host `serviceTier`, the new per-model or global `serviceTier` option (`fast`/`priority`, `flex`, `default`), or a `-fast` model id now sends `service_tier: "priority"` to models whose Codex catalog entry offers it. Before this, `gpt-5.5-fast` was only an alias. `gpt-6-sol` and `gpt-6-luna` default to Fast as in stock Codex, and `serviceTier: "default"` opts out. The tier is re-resolved on model fallback. ([#300](https://github.com/ndycode/oc-codex-multi-auth/pull/300))
- Codex 0.166 request headers: `x-codex-routing-hint`, `session-id`/`thread-id` (sent alongside the legacy `session_id`/`conversation_id`), `version` under the Codex CLI identity, and `x-codex-turn-state` sticky routing. The turn-state token is replayed within a turn and on same-account retries. It is tracked per session and account, and dropped at the next user message. ([#300](https://github.com/ndycode/oc-codex-multi-auth/pull/300))

### Changed
- `ultra` now resolves the way Codex does: to the catalog's multi-agent effort, which is `xhigh` on `gpt-6-astra`, `gpt-6.1-sol`, and `gpt-6.1-terra`, and to `max` elsewhere. Native mode now applies the same effort clamps as legacy mode, so `ultra` never reaches the wire. ([#299](https://github.com/ndycode/oc-codex-multi-auth/pull/299), [#300](https://github.com/ndycode/oc-codex-multi-auth/pull/300))
- Request shape follows Codex 0.166. No request carries a top-level `instructions` field; base instructions are the first developer message in `input`. Responses-lite groups function and custom tools into the `functions` namespace and skips `additional_tools` when a turn has no tools. ([#300](https://github.com/ndycode/oc-codex-multi-auth/pull/300))
- `text.verbosity` falls back to the Codex catalog default (`low`; `high` on Daybreak Red) in both modes. An explicit `reasoningSummary: "none"`/`"off"` now omits the field instead of becoming `auto`. ([#300](https://github.com/ndycode/oc-codex-multi-auth/pull/300))
- Shipped templates advertise the Codex working context window: 272000, or 500000 for `gpt-6.1-terra`, instead of 1050000/872000. OpenCode now compacts when Codex would. ([#300](https://github.com/ndycode/oc-codex-multi-auth/pull/300))

### Fixed
- OpenCode V2 requests now carry `prompt_cache_key`, plus the matching `session_id`/`conversation_id`, derived from the session-affinity headers. The host's AI SDK bridge drops `promptCacheKey`, so tool-result continuations used to miss the prompt cache. Provider-configured affinity headers are honored too. ([#296](https://github.com/ndycode/oc-codex-multi-auth/issues/296), [#297](https://github.com/ndycode/oc-codex-multi-auth/pull/297))
- A plain-string `input` is no longer dropped when instructions or `additional_tools` are prepended. ([#300](https://github.com/ndycode/oc-codex-multi-auth/pull/300))

## [6.29.0] - 2026-10-11

### Added
- Custom rotation policies: `rotationStrategy: "custom"` runs a user-supplied `.mjs` `select` module in a bounded child process (four-way concurrency cap, 1 MiB input, 64 KiB output, one-second selection deadline) with environment and preload stripped. Policies validate offline through `scripts/rotation-validate.js` against scenario fixtures, feed account-scoped quota observations into host eligibility, and ship a `/rotation` package export for the policy contract. ([#292](https://github.com/ndycode/oc-codex-multi-auth/pull/292), thanks @PENEKhun)

### Fixed
- `codex-limits` text reports now preserve every emitted field: banked reset credits render whenever the server reports them — including `0 banked`, previously dropped — and the tool description pins complete-report semantics so agent summaries can no longer drop the 5-hour or resets columns the user asked for. ([#291](https://github.com/ndycode/oc-codex-multi-auth/pull/291), thanks @lubshad)
- Function tools sent to the Codex Responses backend now carry `strict: false` when the host left strictness unset — pinned in the shared `transformRequestForCodex` path ([#294](https://github.com/ndycode/oc-codex-multi-auth/pull/294), thanks @SteveLTN) and in the OpenCode V2 adapter's language-model hook ([#295](https://github.com/ndycode/oc-codex-multi-auth/pull/295)). An omitted flag was treated as strict mode, making optional parameters effectively required so models fabricated values like the subagent `sessionID` and fresh subagent creation failed with `Subagent session not found`. ([#293](https://github.com/ndycode/oc-codex-multi-auth/issues/293))
- `runRotationPolicy` disarms the selection deadline the moment a complete result arrives, so the deadline can no longer fire inside the Windows `taskkill` teardown window and report `timeout` over a finished policy. ([#292](https://github.com/ndycode/oc-codex-multi-auth/pull/292))

## [6.28.0] - 2026-10-06

### Added
- `codex-enable` (25th registered tool) re-enables a disabled account by index or picker, strips the auto-disable marker, clears its auth-failure cooldown, and reloads the cached manager — concurrent enables serialize through the shared load slot so installs land in commit order, and a rejected in-flight load no longer blocks the reload. `codex-health` and `codex-refresh` accept `includeDisabled` to validate credentials without re-enabling. ([#288](https://github.com/ndycode/oc-codex-multi-auth/issues/288), [#290](https://github.com/ndycode/oc-codex-multi-auth/pull/290))

### Fixed
- The OAuth `/connect` method now declares its `prompts`, so the host form collects login mode and account count instead of the plugin grabbing stdin under the host TUI (`EALREADY`). A form-driven "start fresh" also clears the flagged store with a cutoff that preserves records another runtime flags mid-login, verifies the keychain entry matches the survivors, and retires only proven-stale migration markers. ([#287](https://github.com/ndycode/oc-codex-multi-auth/issues/287), [#289](https://github.com/ndycode/oc-codex-multi-auth/pull/289))
- Accounts the plugin disables itself — repeated auth failures or workspace deactivation — now carry an `accountNote` marker that survives persistence and disk merges, so `codex-doctor`, `codex-status`, explainability reasons, and beginner guidance can tell auto-disabled from operator-disabled. A pool where every account is auto-disabled reports `all_accounts_disabled` instead of masquerading as a rate limit, V2 `resolveAuth` no longer selects disabled accounts, and `codex-doctor` notes when the host's own `openai` credential can still serve requests while the whole pool is disabled. ([#288](https://github.com/ndycode/oc-codex-multi-auth/issues/288), [#290](https://github.com/ndycode/oc-codex-multi-auth/pull/290))
- Cache invalidation now runs before flagged-store cleanup on both fresh paths, so a cleanup failure can no longer leave a stale manager able to debounced-save wiped or pre-fresh members back. ([#289](https://github.com/ndycode/oc-codex-multi-auth/pull/289))

## [6.27.0] - 2026-10-02

### Added
- `spendCredits` (or `CODEX_AUTH_SPEND_CREDITS=1`, default off) opts the rotation in to spending Codex credit balances once every account entitled to the model is out of plan quota. Credit candidates respect `modelAccountPools` strict/preferred pools and are ordered by largest balance; balances come from `/wham/usage` and are refreshed by `x-codex-credits-*` response headers. A refused credits turn is parked until the quota reset (default 10 minutes), a toast announces when a request is running on paid credits, and the TUI status rotation gains a `credits` screen listing funded accounts. ([#286](https://github.com/ndycode/oc-codex-multi-auth/pull/286), thanks @Nowaker)

### Fixed
- `limits` — CLI, `codex-limits`, and the TUI quota view — now names the cached accounts it can no longer read: a dead refresh token or an auth-failure cooldown keeps the last known figures under a clear error line, drops the account out of pool totals, and exits nonzero, while timeouts, 429s, and 5xx responses no longer mark credentials dead and a stale reading can't erase a newer failure. ([#285](https://github.com/ndycode/oc-codex-multi-auth/pull/285), thanks @Nowaker)
- A credits refusal is remembered only on an authoritative usage-limit signal — a transient 429, overload, or concurrency throttle no longer parks a funded account, and a refused turn can no longer be billed a second time by the same request's short retry. `limits --json` keeps `credits` in the raw `codex-limits` form (`"62500"`, `unlimited`, `available`) instead of the grouped display string. ([#286](https://github.com/ndycode/oc-codex-multi-auth/pull/286))
- Decoded usage-error messages drop terminal control characters, so a hostile or corrupted error body can no longer inject escape sequences into `limits` output. ([#285](https://github.com/ndycode/oc-codex-multi-auth/pull/285))

## [6.26.0] - 2026-09-30

### Added
- Support for `gpt-6.1-sol`, the new default model in the OpenAI Codex catalog (openai/codex PR #49318, 2026-09-29): normalization with a bare `gpt-6.1` alias, its own model family and instruction slug, responses-lite request shaping, low–ultra reasoning variants in the shipped `modern`/`legacy` catalogs (now 11 bases / 59 selectors), and default fallback-chain coverage between `gpt-6-astra` and `gpt-6-sol`. ([#284](https://github.com/ndycode/oc-codex-multi-auth/issues/284))
- `quotaNotifications.autoRedeemResets` (with `autoRedeemResetsBelowPercent`, default 10) lets the quota poll spend one banked rate-limit reset credit on an account whose weekly quota is nearly gone and the server reports the credit applicable now. ([#283](https://github.com/ndycode/oc-codex-multi-auth/issues/283), thanks @yuefdev)

### Changed
- Plan labels follow the upstream Codex Pro ladder (openai/codex #47971): `prolite` → "Pro", `pro` → "Pro (More)", `promax` → "Pro (Max)"; `promax` seats report ~$500/mo with no published allotment ratio. The default Codex client version now tracks the highest catalog `minimal_client_version` (0.155.0). ([#284](https://github.com/ndycode/oc-codex-multi-auth/issues/284))

### Fixed
- The quota monitor keeps polling when `autoRedeemResets` is the only enabled feature; a usage re-read failure after a successful redeem no longer leaves the account blocked, and the stale snapshot can't re-stamp the cleared block. A cross-process claim under the account-storage lock bounds auto-redeem to one spend attempt per account per week, so two hosts holding the same low-quota reading cannot each burn a credit. ([#283](https://github.com/ndycode/oc-codex-multi-auth/issues/283))
- A custom fallback chain keyed `gpt-6.1` now resolves to the same `gpt-6.1-sol` node the request path normalizes to. ([#284](https://github.com/ndycode/oc-codex-multi-auth/issues/284))

## [6.25.2] - 2026-09-28

### Fixed
- Credential writes no longer leak an open handle when an fsync wedges past the write deadline or `close()` stays pending after `sync()` resolves — the abandoned handle is closed under a bound or handed back so the caller retries the temp-file unlink when the fd releases, instead of leaving a token-bearing `.tmp` behind. ([#275](https://github.com/ndycode/oc-codex-multi-auth/issues/275))
- Clearing accounts or flagged accounts now verifies the keychain delete by re-reading the entry — a backend that reports `false` without an error is ambiguous with "entry absent" — and retires `.migrated-to-keychain.*` rollback backups that still hold plaintext refresh tokens, so cleared credentials cannot resurrect on the next opt-in load. ([#275](https://github.com/ndycode/oc-codex-multi-auth/issues/275), [#280](https://github.com/ndycode/oc-codex-multi-auth/issues/280))
- A rotated refresh token now propagates to the sibling store with a retry while the refresh lease is still held, and — when propagation still fails — a per-token journal (`*.refresh.pending.<hash>`) is replayed in dependency order on the next refresh so chained rotations can't strand a record on a consumed token. A record that moved between the main and flagged stores mid-exchange is salvaged instead of throwing the new credential away. ([#275](https://github.com/ndycode/oc-codex-multi-auth/issues/275), [#280](https://github.com/ndycode/oc-codex-multi-auth/issues/280))
- A keychain save refused for exceeding the backend's blob-size cap now lands the JSON fallback *before* the stale keychain entry is retired, so a failed fallback can no longer leave the pool unreachable. Migration markers that can't be removed are refreshed to the current pool rather than left serving pre-rotation credentials. ([#282](https://github.com/ndycode/oc-codex-multi-auth/issues/282), [#280](https://github.com/ndycode/oc-codex-multi-auth/issues/280))
- Prompt templates are only served from the disk cache offline when a recorded content hash (`contentSha`, falling back to a hash-bound ETag) verifies the body — planted or unverifiable cache entries now fall back to the bundled instructions instead of being trusted. ([#281](https://github.com/ndycode/oc-codex-multi-auth/issues/281))
- The installer resolves the standalone account pool through `os.homedir()` like the runtime, refuses a relative home path instead of pointing token-bearing storage at the working directory, warns before rewriting `opencode.json`/`tui.json` when they contain comments (dry-run notes no longer claim a backup exists), and `doctor` reports flagged-store runtime failures instead of silently reporting zero flagged accounts. ([#275](https://github.com/ndycode/oc-codex-multi-auth/issues/275), [#282](https://github.com/ndycode/oc-codex-multi-auth/issues/282))
- The request pipeline, plugin config bounds, V2 adapter surface detection, and OAuth host binding were hardened against boundary inputs and lost-update races. ([#276](https://github.com/ndycode/oc-codex-multi-auth/issues/276), [#281](https://github.com/ndycode/oc-codex-multi-auth/issues/281))
- Keychain rollback validates a backup's storage shape before promoting it and treats access errors other than `ENOENT` as "file may exist" — a live store is no longer overwritten when existence can't be proven. ([#277](https://github.com/ndycode/oc-codex-multi-auth/issues/277))
- `codex-reset` failure JSON now carries the same `ok`/`tool`/`nextAction` envelope fields as other failures, and duplicate credit ids are counted once. ([#282](https://github.com/ndycode/oc-codex-multi-auth/issues/282))
- The logger masks credential-suffix fields (`tokenSuffix`/`token_suffix`), bounds email masking so an overlong local part can't leave an unmasked prefix, and routes every console line to stderr so stdout stays machine-readable. ([#281](https://github.com/ndycode/oc-codex-multi-auth/issues/281), [#282](https://github.com/ndycode/oc-codex-multi-auth/issues/282))
- Rate-limit backoff clamps sub-millisecond server delays to at least 1 ms and survives backward clock jumps without freezing dedup state. ([#281](https://github.com/ndycode/oc-codex-multi-auth/issues/281))
- Export-path containment realpaths the allowed roots too, so exports inside a symlinked home or temp directory are no longer wrongly rejected. ([#275](https://github.com/ndycode/oc-codex-multi-auth/issues/275))

### Internal
- Documentation was rewritten for clarity against the post-fix architecture. ([#279](https://github.com/ndycode/oc-codex-multi-auth/issues/279))
- Test infrastructure gained mock parity, per-directory coverage floors, `FC_SEED` property testing, and promoted audit regressions. ([#278](https://github.com/ndycode/oc-codex-multi-auth/issues/278), [#282](https://github.com/ndycode/oc-codex-multi-auth/issues/282))

## [6.25.1] - 2026-09-28

### Added
- The standalone `limits` report now reads the plugin's last readings by default — no upstream calls unless `--refresh` is passed — sorts accounts by account, usage, or reset time with `--sort`, names the Business workspace each seat belongs to, and prints readable percentages, renewal times, and plan lines for large pools. ([#274](https://github.com/ndycode/oc-codex-multi-auth/issues/274), thanks @Nowaker)
- The V2 Codex accounts dialog explains whether the pool is project-scoped or shared globally, how `perProjectAccounts` and `CODEX_AUTH_PER_PROJECT_ACCOUNTS` change it, and that a restart is required to apply it. ([#272](https://github.com/ndycode/oc-codex-multi-auth/issues/272), thanks @lubshad)

### Changed
- An account that fails auth three times in a row is now disabled with its credentials retained instead of removed, so a later `opencode auth login` repairs the slot in place. The same applies to a deactivated workspace entry. ([#273](https://github.com/ndycode/oc-codex-multi-auth/issues/273), thanks @yuefdev)

### Fixed
- A background save from an older session no longer drops accounts another session added, restores ones it removed, or disables an account a re-login just repaired. Accounts the manager added in memory (like the host credential bootstrap) persist through the same save. ([#273](https://github.com/ndycode/oc-codex-multi-auth/issues/273), thanks @yuefdev)
- The V2 account sidebar no longer marks a serving account based on a stale headers snapshot or one shared from another project. ([#272](https://github.com/ndycode/oc-codex-multi-auth/issues/272), thanks @lubshad)
- `limits` no longer writes a quota snapshot that is incomplete, describes an alternate `--config-path` pool, or is older than one written concurrently; the optional workspace-name lookup is bounded and cached. ([#274](https://github.com/ndycode/oc-codex-multi-auth/issues/274), thanks @Nowaker)
- An unreadable or invalid global account store no longer looks like an empty pool to a project — it now reports the error instead of seeding past real credentials. ([#273](https://github.com/ndycode/oc-codex-multi-auth/issues/273))

## [6.24.0] - 2026-09-25

### Added
- OpenCode V2 (2.0.16+) is now supported, with the same account pool, Codex routing, account tools and quota status bar. See the README for setup. The installer's new `--v2` flag registers the plugin but will not touch an existing `opencode.jsonc` or V1 `plugin` entries. ([#269](https://github.com/ndycode/oc-codex-multi-auth/issues/269), thanks @lubshad)
- `limits` and `codex-limits` now show what each seat is worth next to the others (like `Plan: pro (20x)`) and one pool line weighted by seat size (like `Pool: 93% used of 81x across 11 accounts`). The same figures are in the JSON output. ([#268](https://github.com/ndycode/oc-codex-multi-auth/issues/268), thanks @Nowaker)
- The status line has a new `quotaStatus.layout: "total"` that shows just the pool percentage, and `recovery: "all"` that lists every upcoming capacity return in order, such as `+33% in 5d, +43% in 6d`. Returns that land in the same displayed countdown are added together. ([#270](https://github.com/ndycode/oc-codex-multi-auth/issues/270), thanks @Nowaker)
- `resetsMinUsedPercent` (0 to 100, default 100) sets how spent the pool must be before the resets screen appears. It lists only reset credits known to apply. ([#270](https://github.com/ndycode/oc-codex-multi-auth/issues/270), thanks @Nowaker)

### Changed
- **Action needed:** the V1 entrypoint now needs OpenCode 1.18.29 or newer, because the plugin now exports an object instead of a bare function. ([#269](https://github.com/ndycode/oc-codex-multi-auth/issues/269))
- `recovery: true` now counts only readable resets that are still in the future, the same as `"all"`. It used to count past or unreadable ones too and over-report. ([#270](https://github.com/ndycode/oc-codex-multi-auth/issues/270))
- After an upgrade that adds new status-line options, restart OpenCode once. Later settings changes still reload live. ([#270](https://github.com/ndycode/oc-codex-multi-auth/issues/270))

### Fixed
- `limits` JSON with no accounts configured now includes `pool: null` instead of leaving the field out. ([#268](https://github.com/ndycode/oc-codex-multi-auth/issues/268))
- A catalog that parses to a non-object (like `null`) now returns `null` instead of throwing. ([#265](https://github.com/ndycode/oc-codex-multi-auth/issues/265))

### Internal
- Two tests that failed on Windows since 6.22.0 now pass; both were fixture bugs. ([#265](https://github.com/ndycode/oc-codex-multi-auth/issues/265))

## [6.23.0] - 2026-09-23

### Added
- GPT-6 Sol (`gpt-6-sol`) and GPT-6 Luna (`gpt-6-luna`) are now supported and ship in the config templates. Turn off their auto-fallback with `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1`. ([#264](https://github.com/ndycode/oc-codex-multi-auth/issues/264))

### Changed
- **Action needed:** retired models are gone from the templates: `gpt-5.4-mini`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`. Reinstall to clean them out of your config. ([#264](https://github.com/ndycode/oc-codex-multi-auth/issues/264))
- Getting ready for GPT-5.5's retirement on 2026-10-14: `gpt-5` now points to `gpt-6-sol`, and warm pings and fallbacks no longer rely on `gpt-5.5`, which stays selectable until then. ([#264](https://github.com/ndycode/oc-codex-multi-auth/issues/264))
- Fallback chains now follow one order, so a blocked request can reach every live general model. ([#264](https://github.com/ndycode/oc-codex-multi-auth/issues/264))

### Fixed
- Newer models were getting the old GPT-5.2 system prompt. They now get their own. ([#264](https://github.com/ndycode/oc-codex-multi-auth/issues/264))
- Quota fallback gave up after 3 model switches. It now tries up to 6, and only switches onto a model some account can serve right now. ([#264](https://github.com/ndycode/oc-codex-multi-auth/issues/264))
- `gpt-5` with `none` effort no longer errors on GPT-6 Sol; the effort floors to `low` instead. ([#264](https://github.com/ndycode/oc-codex-multi-auth/issues/264))

## [6.22.0] - 2026-09-22

### Added
- The credential store is now snapshotted before every significant write, landing in `backups/codex-credential-snapshot-*.json` (mode `0600` on POSIX only). Best-effort: a failed snapshot only warns and the write still goes through. Configurable retention via `credentialSnapshotsMaxCount` (default 10), disable with `credentialSnapshots: false`. ([#262](https://github.com/ndycode/oc-codex-multi-auth/issues/262), thanks @Nowaker)
- The plugin now tracks which build of itself OpenCode loaded (installed package vs. working checkout). Update checks are skipped for checkout builds, and `codex-status`/`codex-doctor` report the running build. ([#260](https://github.com/ndycode/oc-codex-multi-auth/issues/260), thanks @Nowaker)
- The status line can now show the whole account pool at once with `quotaStatus.mode: "overview"`, plus a new `"resets"` mode for banked reset credits and `quotaDisplay: "used"` for percent-consumed. ([#261](https://github.com/ndycode/oc-codex-multi-auth/issues/261), thanks @Nowaker)

### Fixed
- The test suite could write to a developer's real `~/.opencode` account store; it now runs in an isolated temp HOME with a storage guard against real-home writes. ([#258](https://github.com/ndycode/oc-codex-multi-auth/issues/258), thanks @Nowaker)
- A short configured wait (like a 5-second `retryAfter`) no longer aborts a request hours early; the retry budget now charges in proportion to the actual wait. ([#258](https://github.com/ndycode/oc-codex-multi-auth/issues/258), thanks @Nowaker)
- A failed account-file reload no longer empties a working pool; an empty read against a non-empty incumbent is now retried instead of replacing it. ([#258](https://github.com/ndycode/oc-codex-multi-auth/issues/258), thanks @Nowaker)
- The installer no longer replaces a registered local checkout (`file:///path/to/oc-codex-multi-auth`) with the published package name on reinstall; a registered path that no longer exists is kept but flagged with a warning. ([#259](https://github.com/ndycode/oc-codex-multi-auth/issues/259), thanks @Nowaker)
- Cache eviction could escape the OpenCode cache via a symlinked cache root; it now refuses to evict when the cache root resolves through a symlink. ([#259](https://github.com/ndycode/oc-codex-multi-auth/issues/259))
- ChatGPT Business seats sharing one workspace account id now render distinguishably instead of looking like duplicates. ([#263](https://github.com/ndycode/oc-codex-multi-auth/issues/263), thanks @Nowaker)
- The pool quota line no longer misreports as "fully spent" when one account's fetch fails; that account now keeps its last known reading marked stale. ([#261](https://github.com/ndycode/oc-codex-multi-auth/issues/261))

### Internal
- Widened the origin-history lock retry budget so concurrent OpenCode startups don't lose their sighting record. ([#260](https://github.com/ndycode/oc-codex-multi-auth/issues/260))
- `CODEX_AUTH_CREDENTIAL_SNAPSHOTS_MAX_COUNT` now validates as an integer with a minimum instead of silently clamping bad values. ([#262](https://github.com/ndycode/oc-codex-multi-auth/issues/262))

## [6.21.0] - 2026-09-15

### Added
- The plugin now reloads live account state when another process (or window) changes the accounts file, no restart needed. ([#257](https://github.com/ndycode/oc-codex-multi-auth/issues/257), thanks @WarGloom)
- A successful `codex-warm` request now clears an account's stale cooldown, rate-limit, and family blocks, with quota blocks only cleared after usage confirms the quota actually recovered. ([#257](https://github.com/ndycode/oc-codex-multi-auth/issues/257), thanks @WarGloom)
- Reference docs (architecture guides, troubleshooting runbook, tool reference) now match the runtime code, backed by docs-parity tests. ([#256](https://github.com/ndycode/oc-codex-multi-auth/issues/256))

### Fixed
- A lost half-open circuit-breaker probe no longer bricks the breaker permanently; a stalled probe is now abandoned after a full reset window.
- A non-429 response mentioning `rate_limit_exceeded` no longer inherits an uncapped multi-year rate-limit delay; reset headers are only honored on genuine 429s.
- An SSE event split across multiple `data:` lines is now parsed correctly per spec instead of failing as a truncated stream.
- The 10MB SSE cap is now counted in bytes instead of UTF-16 code units, so multibyte streams can no longer overshoot it up to 4x.
- A hostile reset-credits response (`null` body or non-array `credits`) no longer crashes the `codex-reset` tool.
- A corrupt or huge persisted timestamp (like `1e308`) no longer strands an account forever; stamps beyond the 30-day horizon are dropped, and a genuine block re-stamps on the next 429.
- The V1-to-V3 migration no longer drops a legacy rate-limit stamp, which used to un-block a migrated account early.
- A negative `x-codex-active-limit` header no longer shows a negative count, and email masking no longer breaks astral characters (like emoji) into garbled output.

### Internal
- `getTopCandidates` no longer proposes disabled accounts during parallel probing.
- Added 81 invariant tests covering recovery, request-pipeline, storage, and TUI code against hostile inputs and corruption.

## [6.20.0] - 2026-09-14

### Added
- Requests now fall back to a cheaper model when every account is quota-blocked upstream, instead of waiting or failing with 429, but local cooldowns never trigger it and strict pools still refuse it. Configurable via `unsupportedCodexFallbackChain`, opt out per family with `CODEX_AUTH_DISABLE_*_AUTO_FALLBACK=1`. ([#255](https://github.com/ndycode/oc-codex-multi-auth/issues/255), thanks @WarGloom)
- Spent subscription quota (5-hour or weekly) is now tracked separately from rate limits, with its own reset countdown in rotation, the status line, `codex-list`, `codex-status`, and `codex-limits`. ([#255](https://github.com/ndycode/oc-codex-multi-auth/issues/255), thanks @WarGloom)
- `oc-codex-multi-auth doctor --fix` now repairs accounts outside OpenCode: refreshes tokens, clears stale blocks, and persists rotated credentials, including keychain-backed pools. Use `--config-path` to target one JSON pool (this bypasses keychain routing). ([#255](https://github.com/ndycode/oc-codex-multi-auth/issues/255), thanks @WarGloom)

### Fixed
- Corrupt or wrongly-shaped storage files no longer report success from the standalone CLI; all commands now validate and exit nonzero with the real error. ([#255](https://github.com/ndycode/oc-codex-multi-auth/issues/255))
- Non-finite numbers (e.g. from `1e400`) in a hand-edited accounts file no longer poison rotation; they're sanitized on load and save.
- An all-blocked pool now waits out the longest active block instead of the shortest, fixing a wake-to-still-blocked cycle.
- A doctor-cleared quota stamp now stays cleared across processes instead of getting rewritten by another running instance, unless a fresh 429 or usage poll re-stamps it.
- `codex-health` no longer calls a real week-long quota block "stale state"; it now reports quota exhaustion under its own finding, which comes back after `--fix` clears it.
- Spent subscription quota is now recorded once per account instead of once per model family, and the status line no longer badges every account as rate-limited. ([#255](https://github.com/ndycode/oc-codex-multi-auth/issues/255), thanks @WarGloom)

### Internal
- The selector's last-resort retry (sending a blocked account) is now overridden on the request path so the model fallback above can run. ([#255](https://github.com/ndycode/oc-codex-multi-auth/issues/255))
- Doctor repair logic moved to a shared `lib/tools/doctor-repair.ts` used by both the plugin tool and standalone CLI. ([#255](https://github.com/ndycode/oc-codex-multi-auth/issues/255))

## [6.19.0] - 2026-09-08

### Added
- The compact status line now shows which day a quota resets, e.g. `Tue 02:25` or `Sep 15 02:25`, instead of just a bare time. ([#251](https://github.com/ndycode/oc-codex-multi-auth/issues/251), thanks @dhaern)
- Masked accounts in the status line are now distinguishable, e.g. `[us***@example.com]` instead of a flat `[*****]` for every account. A value it can't safely mask still shows `[*****]`, and a name or second address beside the email is dropped. ([#252](https://github.com/ndycode/oc-codex-multi-auth/issues/252), thanks @dhaern)
- `codex-limits` now reports banked rate-limit resets an account can redeem, e.g. `Resets: 2 banked (1 applicable now)`. ([#254](https://github.com/ndycode/oc-codex-multi-auth/issues/254), thanks @Nowaker)

### Fixed
- Accounts no longer carry the name of an unrelated organization like `DreamHost API (role:owner)`. Old labels are dropped automatically, no re-auth needed. ([#253](https://github.com/ndycode/oc-codex-multi-auth/issues/253), thanks @Nowaker)
- The standalone CLI (`status`, `list`, `health`, `doctor`, `dashboard`) now shows a masked email and id suffix instead of generic `Account 1`, `Account 2` labels. ([#253](https://github.com/ndycode/oc-codex-multi-auth/issues/253))
- Short identities (under 13 characters) are no longer printed in full by diagnostics; they're masked outright now. ([#253](https://github.com/ndycode/oc-codex-multi-auth/issues/253))
- The status line could render wider than the terminal on narrow terminals; it's now clamped to fit.

### Internal
- Reset-credit counts are now validated consistently across both surfaces that report them. ([#254](https://github.com/ndycode/oc-codex-multi-auth/issues/254))
- `codex-limits --json` moves the rendered summary to `resetCreditsSummary`, keeping raw counts in `resetCredits`. ([#254](https://github.com/ndycode/oc-codex-multi-auth/issues/254))

## [6.18.0] - 2026-09-04

### Added
- Paid Credits are now protected when your subscription quota is spent: accounts are polled every 30 minutes and rotation skips an exhausted one before it can burn Credits, but usage-endpoint errors fail open, so run `codex-limits` for immediate protection. On by default, opt out with `autoProtectCredits: false` or `CODEX_AUTH_AUTO_PROTECT_CREDITS=0`. ([#245](https://github.com/ndycode/oc-codex-multi-auth/issues/245), thanks @PENEKhun)

### Fixed
- A model id like `constructor` or `__proto__` no longer crashes the request path. ([#250](https://github.com/ndycode/oc-codex-multi-auth/issues/250))
- Astra's request shape (`gpt-6-astra`) is now read from the Codex catalog instead of guessed. **Breaking:** `CODEX_AUTH_ASTRA_RESPONSES_LITE` is removed, it's no longer needed. ([#248](https://github.com/ndycode/oc-codex-multi-auth/issues/248))

### Security
- Five dependency advisories cleared, four of them high: `toml`, `browserslist`, `fflate`. Lockfile refresh only, no code changes needed. ([#249](https://github.com/ndycode/oc-codex-multi-auth/issues/249))

### Internal
- Doc count checks now derive counts from the config files instead of hardcoded strings. ([#246](https://github.com/ndycode/oc-codex-multi-auth/issues/246), [#248](https://github.com/ndycode/oc-codex-multi-auth/issues/248))
- Fixed the quota monitor hanging fake-timer test runs. ([#245](https://github.com/ndycode/oc-codex-multi-auth/issues/245))

## [6.17.0] - 2026-09-04

### Added
- GPT-6 Astra (`gpt-6-astra`) is now supported, with efforts `low` through `ultra`, and ships in the config templates. It's opt-in, neither `gpt-5` nor the plugin default resolves to it. Accounts outside the rollout auto-fall back through `gpt-6-astra → gpt-5.6-sol → gpt-5.6-terra → gpt-5.6-luna → gpt-5.5 → gpt-5.2`, or disable with `CODEX_AUTH_DISABLE_GPT6_AUTO_FALLBACK=1`. ([#246](https://github.com/ndycode/oc-codex-multi-auth/issues/246))
- Routing added for the Daybreak-gated cyber models: `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, and `gpt-5.6-cyber`. They need Daybreak program approval and aren't in the config templates, so add the id by hand if you have access. None of them fall back to a general model, by design. ([#246](https://github.com/ndycode/oc-codex-multi-auth/issues/246))
- Astra defaults to the responses-lite request shape, override with `CODEX_AUTH_ASTRA_RESPONSES_LITE=0` (classic) or `=1` (force lite). That default is inferred, since the Codex catalog has no `gpt-6-astra` entry yet. ([#246](https://github.com/ndycode/oc-codex-multi-auth/issues/246))

### Fixed
- Default fallback chains no longer degrade onto retired models `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.4-nano` (withdrawn 2026-08-31). Chains now route through `gpt-5.6-terra`, `gpt-5.6-luna`, then `gpt-5.2` instead, and selecting `gpt-5.4-mini` costs one round trip before it upgrades to `gpt-5.6-luna`. ([#246](https://github.com/ndycode/oc-codex-multi-auth/issues/246))
- A capitalized reasoning effort like `"ULTRA"` or `"NONE"` used to bypass clamping and reach the backend as-is. Efforts are now case-folded before clamping, affecting every model family. ([#247](https://github.com/ndycode/oc-codex-multi-auth/issues/247))
- An unrecognized reasoning effort used to be sent as-is, causing a backend `400`. It now falls back to that model family's default effort and logs a warning. ([#247](https://github.com/ndycode/oc-codex-multi-auth/issues/247))

### Internal
- Fixed a docs count check that hardcoded model counts instead of deriving them from the config files, so it stayed green even as the templates grew. ([#246](https://github.com/ndycode/oc-codex-multi-auth/issues/246))

## [6.16.0] - 2026-09-03

### Added
- New OAuth method `Codex OAuth (Open URL Manually)`: binds the callback listener first and prints the login URL instead of opening a browser, handy for SSH with `-L 1455:localhost:1455`. The default browser login also no longer gives up if a browser can't launch, it now prints the URL and keeps waiting. ([#244](https://github.com/ndycode/oc-codex-multi-auth/issues/244))
- The ChatGPT plan tier (`Free`, `Plus`, `Pro`, `Business`, `Business Premium`) is now shown per account in `codex-list` and `codex-status`, and re-read on every token refresh so upgrades show up without re-authenticating. `codex-limits` and the TUI now report the same plan name. ([#243](https://github.com/ndycode/oc-codex-multi-auth/issues/243))

### Fixed
- Disposing an `AccountManager` (e.g. on account switch) could delete accounts added by its successor. A disposed manager now merges only rate-limit blocks, cooldowns, and last-used stamps instead of overwriting account membership. ([#242](https://github.com/ndycode/oc-codex-multi-auth/issues/242))
- Quota alerts could pair the wrong reset time with the wrong account's percentage. The percentage and reset shown now always come from the same account. ([#241](https://github.com/ndycode/oc-codex-multi-auth/issues/241))
- A generated account label leaked the full email past `maskEmail`. The email and account id are now stored as separate fields so masking applies correctly. A stale label from an API-platform org is now cleared on login; labels set with `codex-label` are kept. ([#243](https://github.com/ndycode/oc-codex-multi-auth/issues/243))
- Quarantining an account dropped its plan tier, it now shows the correct plan again after being restored. ([#243](https://github.com/ndycode/oc-codex-multi-auth/issues/243))
- `noBrowser=true` (or `no-browser=true`) was ignored and still tried to launch a browser. It now correctly uses the manual paste flow. ([#244](https://github.com/ndycode/oc-codex-multi-auth/issues/244))
- A bare authorization code pasted into the manual URL flow was accepted with no state check, removing CSRF protection. The full callback URL, including `state`, is required again for every input. ([#244](https://github.com/ndycode/oc-codex-multi-auth/issues/244))
- A hostile `plan_type` value from `/wham/usage` (reachable since `OPENAI_BASE_URL` lets a user put an arbitrary gateway in front of it) could inject control characters into terminal output. Control characters are now stripped and the rendered plan is capped at 32 characters.

### Internal
- Fixed a race between two test suites that both bind OAuth callback port 1455 in parallel. ([#244](https://github.com/ndycode/oc-codex-multi-auth/issues/244))

## [6.15.0] - 2026-08-31

### Added
- Desktop quota notifications for macOS. Turn on with `quotaNotifications.enabled: true` (or `CODEX_AUTH_QUOTA_NOTIFICATIONS=1`); the plugin polls accounts and alerts via Notification Center when the 5-hour or weekly quota crosses 25%, 10%, or 0%. `notifyEveryCheck: true` alerts after every poll, `thresholds: []` turns alerts off, `intervalMs` defaults to 30 minutes with a 30-second floor. Off by default, macOS only. ([#239](https://github.com/ndycode/oc-codex-multi-auth/issues/239))

### Fixed
- An unattended quota refresh could kill an account: a stale in-memory token cache overwrote a just-rotated refresh token on disk, leaving the account dead until a fresh login. ([#239](https://github.com/ndycode/oc-codex-multi-auth/issues/239), [#240](https://github.com/ndycode/oc-codex-multi-auth/issues/240))
- A malformed usage response (e.g. a null body) used to throw instead of rendering as `unavailable`. This is reachable because the gateway in front of `/wham/usage` is configurable through `OPENAI_BASE_URL`.
- A quota window the plan had switched off was scored as 100% remaining, which could mask other accounts' low quota and suppress alerts. ([#239](https://github.com/ndycode/oc-codex-multi-auth/issues/239))
- Quota alerts could pair one account's percentage with a different account's reset time. ([#239](https://github.com/ndycode/oc-codex-multi-auth/issues/239))
- Concurrent processes could drop a quota check under load; delivery timing no longer eats into the check's retry budget. ([#239](https://github.com/ndycode/oc-codex-multi-auth/issues/239))
- The quota monitor now stops on shutdown signals (`SIGINT`/`SIGTERM`) instead of only on a plugin-specific dispose event. ([#239](https://github.com/ndycode/oc-codex-multi-auth/issues/239), [#240](https://github.com/ndycode/oc-codex-multi-auth/issues/240))
- `quotaNotifications.thresholds: []` was ignored and replaced by the default `[25, 10, 0]`; an explicit empty list is now respected. ([#239](https://github.com/ndycode/oc-codex-multi-auth/issues/239))
- Quota threshold state could leak between projects when switching mid-check. ([#239](https://github.com/ndycode/oc-codex-multi-auth/issues/239), [#240](https://github.com/ndycode/oc-codex-multi-auth/issues/240))

### Changed
- Quota reset times stay on the 24-hour clock, no 12-hour formatting. ([#239](https://github.com/ndycode/oc-codex-multi-auth/issues/239))

### Internal
- Added test coverage for the quota monitor's default fetch path. ([#240](https://github.com/ndycode/oc-codex-multi-auth/issues/240))
- Documented `quotaNotifications` in `docs/development/CONFIG_FIELDS.md` and the related modules in `AGENTS.md`. ([#239](https://github.com/ndycode/oc-codex-multi-auth/issues/239))

## [6.14.4] - 2026-08-30

### Fixed
- The manual OAuth paste flow (`Codex OAuth (Manual URL Paste)`) could mangle or drop the authorization code: spaces, backslashes, and `..` segments in the code were corrupted by `new URL()` normalization, and some valid inputs (like a bare `code:state` colon, or a `state=` value, or a `#value` fragment) lost the code entirely. Parsing no longer relies on `new URL()` for these cases. A callback pasted without its scheme (e.g. `127.0.0.1:1455/auth/callback?code=...`) is now parsed correctly too. ([#238](https://github.com/ndycode/oc-codex-multi-auth/issues/238))
- An unexpected `URL` parsing error could crash the login prompt instead of falling back to treating the input as a raw code. ([#238](https://github.com/ndycode/oc-codex-multi-auth/issues/238))
- A bare authorization code and a callback missing its state now get different, clearer error messages; the state is still required. ([#238](https://github.com/ndycode/oc-codex-multi-auth/issues/238))

### Internal
- Simplified the parser's result type from four variants to two and removed the now-unused `ParsedAuthInput` interface. ([#238](https://github.com/ndycode/oc-codex-multi-auth/issues/238))
- The test suite now uses the real parser instead of a hand-written stand-in that had drifted out of sync with it. ([#238](https://github.com/ndycode/oc-codex-multi-auth/issues/238))

## [6.14.3] - 2026-08-27

### Fixed
- An unbounded quota-reset header (from the backend, an intermediary, or a configured `OPENAI_BASE_URL` gateway) could take an account out of rotation permanently, in one measured case for 127 years. Implausible reset times are now rejected instead of accepted, since a garbled header says nothing about the real recovery time.
- A backwards clock jump (e.g. an NTP correction) could tank an account's health score and leave it ranked last in selection indefinitely. Elapsed time is now clamped at zero.
- Non-finite wait times (`NaN`, `Infinity`) used to show up verbatim in toasts and logs; they now read as zero. Wait-time formatting also now splits out hours and days instead of only showing a five-figure minute count.
- Stale quota headers on an entitlement error used to block healthy accounts. Quota headers are now only trusted from a response the backend actually served, or one it refused with a confirmed `429`. ([#237](https://github.com/ndycode/oc-codex-multi-auth/issues/237))

### Internal
- Whether a response's quota headers are authoritative is now decided once, in the error classifier, and reported as `quotaHeadersAuthoritative` to all consumers. ([#237](https://github.com/ndycode/oc-codex-multi-auth/issues/237))
- The short 429 retry no longer replays a request on an account whose quota window it just blocked. ([#237](https://github.com/ndycode/oc-codex-multi-auth/issues/237))
- Documented the differing contracts of the `getCurrentOrNextForFamilySticky` and `getCurrentOrNextForFamilyHybrid` rotation selectors.

## [6.14.2] - 2026-08-25

### Fixed
- Pool-exhaustion diagnostics could contradict themselves and undercount Business seats, because the account identity they were keyed on could rotate mid-request via refresh tokens. Counting now uses stable identity instead. ([#236](https://github.com/ndycode/oc-codex-multi-auth/issues/236))

### Changed
- Terminal routing diagnostics no longer degrade silently when account state can't be read; the account lookup is now unconditional instead of falling back to an empty list. ([#236](https://github.com/ndycode/oc-codex-multi-auth/issues/236))

## [6.14.1] - 2026-08-25

### Fixed
- A rate-limited strict model pool answered `503` with no retry hint instead of `429` with `Try again in <time>`, because the pool lookup matched accounts by raw account id instead of the seat identity routing actually uses. ([#235](https://github.com/ndycode/oc-codex-multi-auth/issues/235))
- Pool-exhaustion diagnostics could describe the wrong accounts or a previous request. The strict-pool message now reports configured entries and resolved accounts separately, and the general exhaustion message no longer inherits a stale "model not supported" verdict from an earlier request. ([#234](https://github.com/ndycode/oc-codex-multi-auth/issues/234))

## [6.14.0] - 2026-08-21

### Added
- `OPENAI_BASE_URL` is now honored for ChatGPT OAuth requests, but only when `CODEX_AUTH_ALLOW_OPENAI_BASE_URL=1` is set. Remote gateways require HTTPS, only literal loopback addresses (never `localhost`) can use plain HTTP, URLs with credentials, a query string or a fragment are rejected, redirects are not followed, and a rejected value fails loudly instead of silently falling back. ([#232](https://github.com/ndycode/oc-codex-multi-auth/issues/232))

### Fixed
- Two OpenCode processes sharing one account file could burn each other's refresh tokens, killing the account until you logged in again. Refreshes are now serialized across processes on the same host and local filesystem; a shared network filesystem still needs outside coordination, and a process killed after the provider accepts a token but before the replacement is saved still needs a re-login. ([#233](https://github.com/ndycode/oc-codex-multi-auth/issues/233))
- Storage writes like `codex-note`, `codex-tag`, and account enable/disable no longer wait behind a refresh network call; the storage lock budget was also widened from about half a second to about five. ([#233](https://github.com/ndycode/oc-codex-multi-auth/issues/233))
- A consumed refresh token could get written back over a newer one in four places (health merge, startup email hydration, refresh-target resolution, flagged-account cleanup), each costing a re-login. All four are fixed. ([#233](https://github.com/ndycode/oc-codex-multi-auth/issues/233))
- `flagged-accounts.json` no longer stores a live OAuth access token. ([#233](https://github.com/ndycode/oc-codex-multi-auth/issues/233))
- A refresh lease that went stale mid-exchange no longer lets the exchange proceed. It now fails and retries with a fresh lease instead. ([#233](https://github.com/ndycode/oc-codex-multi-auth/issues/233))

### Internal
- Fixed a lock-nesting bug where two leases on one target could delete each other's registry entry and leak a lockfile. ([#233](https://github.com/ndycode/oc-codex-multi-auth/issues/233))
- Removed the now-unused `persistRefreshResult`; its guard is handled by the new refresh coordinator. ([#233](https://github.com/ndycode/oc-codex-multi-auth/issues/233))

## [6.13.0] - 2026-08-18

### Added
- Business workspace seats are now separate identities. Each seat gets its own `accountUserId`, used for identity, dedup, model-pool routing, quota, and diagnostics. Older records are backfilled automatically where their token still decodes. ([#230](https://github.com/ndycode/oc-codex-multi-auth/issues/230), [#231](https://github.com/ndycode/oc-codex-multi-auth/issues/231))
- `codex-doctor` and `codex-health` now flag colliding Business seat credentials via a `business-member-credential-conflict` finding and a `businessMemberConflictSlots` field in `codex-health --json`. ([#231](https://github.com/ndycode/oc-codex-multi-auth/issues/231))

### Fixed
- **Action needed:** logging in as a second member of a Business workspace overwrote the first member's account instead of adding a new one, billing one seat for the whole workspace and losing the other member's refresh token. Each seat now gets its own slot. Duplicate records from this bug are not auto-merged; remove the affected account slots and log in again for each member. Reported by @proamo, fixed by @lubshad. ([#230](https://github.com/ndycode/oc-codex-multi-auth/issues/230), [#231](https://github.com/ndycode/oc-codex-multi-auth/issues/231))
- `codex-pool` entries scoped to one Business seat silently routed to every member of the workspace. Pool entries now use seat-scoped keys; existing workspace-wide entries are not rewritten on upgrade and keep matching every seat until the next `codex-pool add`/`remove` migrates them (skipped while project-scoped account storage is active). ([#231](https://github.com/ndycode/oc-codex-multi-auth/issues/231))
- A per-account circuit breaker could be inherited by the wrong account after `removeAccount` reshuffled slots. It's now keyed by stable workspace identity instead of position. ([#231](https://github.com/ndycode/oc-codex-multi-auth/issues/231))
- Three security advisories (two `hono` ReDoS advisories, one transitive) were pulled in through an unused `@openauthjs/openauth` dependency used for a single PKCE helper. That helper was reimplemented locally and the dependency removed; `npm run audit:ci` now reports 0. ([#229](https://github.com/ndycode/oc-codex-multi-auth/issues/229))

### Internal
- Follow-up correctness fixes to the seat-identity work: identity key ranking, legacy record dedup, schema field declarations, and pool-key fallback matching. ([#231](https://github.com/ndycode/oc-codex-multi-auth/issues/231))
- The usage-quota dedupe key keeps the per-workspace binding added in [#227](https://github.com/ndycode/oc-codex-multi-auth/issues/227).

## [6.12.1] - 2026-08-12

### Fixed
- A pool change that had already saved to disk could be reported as a fatal lock error, most often on Windows where an antivirus scanner or the search indexer holds the lock directory open. Release failures are now just a warning, since the config was already saved; a leftover lock directory is reclaimed as stale within ten seconds. Reported by @AceRothstein71. ([#224](https://github.com/ndycode/oc-codex-multi-auth/issues/224), [#225](https://github.com/ndycode/oc-codex-multi-auth/issues/225))
- A lock going stale mid-change could crash the whole plugin process instead of failing just that one call. ([#224](https://github.com/ndycode/oc-codex-multi-auth/issues/224), [#225](https://github.com/ndycode/oc-codex-multi-auth/issues/225))
- Windows lock contention (`EPERM`/`EBUSY`) wasn't recognized as contention, so the retry guidance for it never kicked in there. ([#224](https://github.com/ndycode/oc-codex-multi-auth/issues/224), [#228](https://github.com/ndycode/oc-codex-multi-auth/issues/228))
- Parallel `codex-pool` calls each waited out the full retry budget one after another. Now, once one call finds the lock held externally, the rest give up quickly instead of repeating the same wait. ([#224](https://github.com/ndycode/oc-codex-multi-auth/issues/224), [#228](https://github.com/ndycode/oc-codex-multi-auth/issues/228))
- The "config is locked" error response was missing fields (`pool`, `dryRun`, `restartRequired`, `previousConfiguredCount`, `previousPoolMode`) that callers expected, and used three different names for the same error. The wire format is now consistently `CODEX_CONFIG_LOCK_CONTENTION`. ([#228](https://github.com/ndycode/oc-codex-multi-auth/issues/228))
- Lock contention was classified as a non-retryable config error. It's now marked `retryable: true`. ([#228](https://github.com/ndycode/oc-codex-multi-auth/issues/228))
- The multi-worktree collision warning never actually throttled, since it keyed on a peer process id that changed every restart. It's now keyed on storage path and host. ([#228](https://github.com/ndycode/oc-codex-multi-auth/issues/228))
- **Action needed:** one ChatGPT login with two workspace subscriptions (for example Team and Plus) collapsed onto a single quota pool, so `codex-limits` and `codex-switch` treated both as one account. Each workspace now gets its own account entry on login; run `opencode auth login` again for each workspace to get separate quotas. Reported by @JackTheCoconut. ([#226](https://github.com/ndycode/oc-codex-multi-auth/issues/226), [#227](https://github.com/ndycode/oc-codex-multi-auth/issues/227))

### Internal
- Regression tests for every fix above are now pinned against the pre-fix build, so each one is proven to fail without its fix. ([#228](https://github.com/ndycode/oc-codex-multi-auth/issues/228))
- Duplicate account rows from the old one-entry-per-organization behavior are left in place rather than auto-merged, to avoid discarding a single-use refresh token. See `docs/troubleshooting.md` for the clean-pool steps. ([#227](https://github.com/ndycode/oc-codex-multi-auth/issues/227))

## [6.12.0] - 2026-08-08

### Added
- Model account pools can now route strictly, so a pool only matches its own assigned accounts instead of falling back to others. ([#222](https://github.com/ndycode/oc-codex-multi-auth/issues/222))

### Internal
- Fixed release tagging to keep unprefixed version tags.

## [6.11.4] - 2026-08-04

### Fixed
- An account with no weekly quota left kept getting retried on every prompt, failing and rotating away each time instead of being remembered as spent. The plugin now reads the quota headers the backend already sends on every response, not just when a request fails. Windows the plan has switched off no longer block an account that still has quota. Reported by @Grelo4ka. ([#218](https://github.com/ndycode/oc-codex-multi-auth/issues/218), [#219](https://github.com/ndycode/oc-codex-multi-auth/issues/219))
- A short rate limit could overwrite a week-long quota block with a much shorter one from a separate in-flight request. Quota blocks are now monotonic: whichever one runs longer wins. ([#219](https://github.com/ndycode/oc-codex-multi-auth/issues/219))
- An ordinary throttle only understood one of three reset-time formats and fell back to a 60-second default, retrying before the real reset. It now reads all three formats. ([#219](https://github.com/ndycode/oc-codex-multi-auth/issues/219))
- A second opencode process sharing the same account file could erase a weekly quota block on save. Saves now merge blocks across processes and keep the longer one instead of last-writer-wins; `codex-doctor --fix` still clears blocks. ([#219](https://github.com/ndycode/oc-codex-multi-auth/issues/219))

### Internal
- Regression tests for all four fixes above are pinned against the pre-fix build, so each one is proven to fail without its fix.
- A known limitation of the cross-process quota merge is tracked rather than fixed: a record with no stable account id can't be matched across processes, so its on-disk block is dropped. The same miss can also let a save overwrite a newly rotated single-use refresh token, a pre-existing issue tracked separately. ([#221](https://github.com/ndycode/oc-codex-multi-auth/issues/221))
- `ci.yml` now supports `workflow_dispatch`, so the full CI gate can be run on demand from the Actions tab. ([#220](https://github.com/ndycode/oc-codex-multi-auth/issues/220))

## [6.11.3] - 2026-08-02

### Fixed
- A successful `opencode auth login` could add an account that was already disabled, annotated with a re-auth note listing all four required OAuth scopes as missing, which is what happens when scope metadata is absent rather than actually denied. Enforcement now only fires when the granted scope is genuinely known; an explicit partial grant still disables the account. Accounts wrongly disabled by 6.11.2 are automatically re-enabled and their note cleared on next load; accounts you disabled by hand stay disabled. Reported by @Grelo4ka. ([#213](https://github.com/ndycode/oc-codex-multi-auth/issues/213), [#214](https://github.com/ndycode/oc-codex-multi-auth/issues/214))
- A record could show two contradictory re-auth notes at once, with the stale one listed first. Notes are now replaced instead of appended. ([#215](https://github.com/ndycode/oc-codex-multi-auth/issues/215))
- One transient storage read failure disabled the plugin until OpenCode was restarted, because a rejected account-load promise stayed cached forever. It's now cleared on failure, so the next request gets a fresh attempt. ([#216](https://github.com/ndycode/oc-codex-multi-auth/issues/216))

### Internal
- Regression tests for the scope-handling paths are now pinned against the pre-fix build. ([#214](https://github.com/ndycode/oc-codex-multi-auth/issues/214))
- Fixed an ESLint config gap that failed lint on vitest's generated coverage report after `npm run test:coverage`. ([#216](https://github.com/ndycode/oc-codex-multi-auth/issues/216))

## [6.11.2] - 2026-07-31

### Fixed
- `warm` no longer fails every account with `HTTP 400`. The request body was missing a `content-type` header, so the backend rejected it before ever reading the model. Reported by @Grelo4ka. ([#210](https://github.com/ndycode/oc-codex-multi-auth/issues/210))
- A warm `400` that wasn't an entitlement error was misreported as a model problem. It's now reported as itself. ([#210](https://github.com/ndycode/oc-codex-multi-auth/issues/210))

### Internal
- Warm request tests now check the actual outgoing header on a real `Request`, not just the header-builder object, which previously let this bug through undetected.

## [6.11.1] - 2026-07-30

### Fixed
- `warm` no longer fails every account with `HTTP 400`, from two separate causes. It was pinned to `gpt-5.4`, which isn't in the shipped catalog; the entry point is now `gpt-5.5`. An entitlement `400` also now falls back through the chain (`gpt-5.5` → `gpt-5.4` → `gpt-5.4-mini` → `gpt-5.4-nano`) instead of dead-ending, and warm failures report the real upstream error message. Reported by @Grelo4ka. ([#210](https://github.com/ndycode/oc-codex-multi-auth/issues/210))
- `limits` now shows actual account usage instead of repeating the account list. It reads `/wham/usage` through the same runtime as the in-conversation `codex-limits` tool, and reports per-account failures inline with a non-zero exit. This makes `limits` a network call that can refresh a token; `--tag` now also gates which accounts get contacted. Reported by @Grelo4ka. ([#209](https://github.com/ndycode/oc-codex-multi-auth/issues/209))

### Security
- Per-account `limits` errors are now redacted before output; the OAuth refresh path could otherwise surface raw bearer/JWT/refresh-token material.

### Internal
- CI now runs `npm run build` before `npm test`, since the standalone CLI tests load the compiled runtime from `dist/`.

## [6.11.0] - 2026-07-28

### Added
- A cache-only `update` command and provider-preserving `install --plugin-only` mode. Updating no longer needs the provider/model installer, and update notifications now recommend the config-safe command. Thanks @lubshad. ([#207](https://github.com/ndycode/oc-codex-multi-auth/issues/207))

### Changed
- Default install now only manages the OpenCode/TUI plugin entries and preserves `provider.openai`; model catalogs need an explicit `--modern`, `--full`, or `--legacy`. If you install without a flag, `--variant` reasoning presets and `gpt-5.5-fast` won't be written, use `--modern` if you want them. Thanks @lubshad. ([#207](https://github.com/ndycode/oc-codex-multi-auth/issues/207))

### Fixed
- Terminal quota checks no longer send a synthetic model request. They now read `/wham/usage` directly for usage windows, plan type, credits, and limits, and handle free-plan accounts without picking a model. Thanks @lubshad. ([#208](https://github.com/ndycode/oc-codex-multi-auth/issues/208))
- Fixed install docs for the new plugin-only default across the quickstart, `config/README.md`, `CONFIG_FIELDS.md`, `troubleshooting.md`, and the `ARCHITECTURE.md` CLI diagram.

### Security
- Cleared every outstanding dependency advisory, `npm run audit:ci` now reports 0 vulnerabilities: `hono` to 4.12.32 (context disclosure, XSS bypass, header dedup bug, also clears the advisory inherited by `@openauthjs/openauth`), `seroval`/`seroval-plugins` to 1.5.6 (critical `fromJSON()` type confusion, CVSS 9.8, reached through `solid-js`), plus `brace-expansion` and `postcss` pinned to patched releases.

## [6.10.1] - 2026-07-23

### Fixed
- Account verification no longer bricks accounts by consuming single-use refresh tokens without saving the rotation. `codex-health`, `codex-doctor --fix`, and `codex-refresh` now persist the rotated credential before reporting, so verified accounts don't come back as `refresh_token_reused`. Contributed by @lubshad. ([#205](https://github.com/ndycode/oc-codex-multi-auth/issues/205))
- Fixed a shutdown-handler leak and a possible lost update in the cached account-manager reload used by `codex-health`/`codex-refresh` and the `account.select` handler; it also removed a duplicate `refresh-verification-failed` finding in `codex-doctor`. Contributed by @lubshad. ([#205](https://github.com/ndycode/oc-codex-multi-auth/issues/205))
- Fixed the OAuth callback success page rendering as an unstyled white page under the strict callback CSP. It's now a compact static page with a nonce-bound stylesheet and no external fonts or scripts; the CSP is tightened and `Cache-Control`/`Referrer-Policy` headers were added. Contributed by @lubshad. ([#206](https://github.com/ndycode/oc-codex-multi-auth/issues/206))

## [6.10.0] - 2026-07-20

### Added
- New `accountToasts` config field (default `true`, env override `CODEX_AUTH_ACCOUNT_TOASTS=0`) turns off just the `Using <account> (N/N)` toast shown when the plugin selects or rotates accounts. `CODEX_AUTH_TOAST_DURATION_MS` still has a 1000 ms floor. Warning and error toasts still show, and the setting survives upgrades. Reported by @aic0d3r. ([#203](https://github.com/ndycode/oc-codex-multi-auth/issues/203))

## [6.9.1] - 2026-07-18

### Fixed
- `gpt-5.6-sol` was still rejected through the plugin after the 6.8.2 fix. The GPT-5.6 tiers now present the host (opencode) identity by default instead of the Codex CLI identity, since some accounts fail sol entitlement checks under the Codex CLI identity. `CODEX_AUTH_CLIENT_IDENTITY=codex|opencode` (alias `host`) forces one identity for all models. ([#196](https://github.com/ndycode/oc-codex-multi-auth/issues/196), [#201](https://github.com/ndycode/oc-codex-multi-auth/issues/201))
- The advertised opencode version now self-syncs with the real host build instead of a baked-in constant; `CODEX_AUTH_HOST_VERSION` overrides it. ([#201](https://github.com/ndycode/oc-codex-multi-auth/issues/201))
- `CODEX_AUTH_CLIENT_VERSION` and `CODEX_AUTH_HOST_VERSION` values are now sanitized, so a badly quoted env value can no longer corrupt the `User-Agent`. ([#201](https://github.com/ndycode/oc-codex-multi-auth/issues/201))

## [6.9.0] - 2026-07-17

### Added
- New `modelAccountPools` config field pins a model to a preferred set of accounts (e.g. keep `gpt-5.6-sol` on just the accounts inside the Sol preview) instead of burning rotation attempts on accounts that will reject it. Falls back to the general pool if every preferred account is unavailable. Contributed by @lubshad. ([#200](https://github.com/ndycode/oc-codex-multi-auth/issues/200))
- New `codex-pool` tool manages those mappings (`status`, `set`, `add`, `remove`, `clear`, plus `dryRun=true` previews) using ordinary 1-based account numbers. Requires an OpenCode restart to take effect, and references that don't resolve in the current project are reported but never automatically pruned. Contributed by @lubshad. ([#200](https://github.com/ndycode/oc-codex-multi-auth/issues/200))
- `codex-status`, `codex-dashboard`, and `codex-metrics` now report `accountPoolMode` (`general`/`preferred`/`general-fallback`) and `configuredAccountPoolSize`. Contributed by @lubshad. ([#200](https://github.com/ndycode/oc-codex-multi-auth/issues/200))

## [6.8.2] - 2026-07-16

### Fixed
- `gpt-5.6-sol` was rejected through the plugin while working fine in the Codex CLI/TUI for the same account. Requests now carry a Codex CLI `User-Agent` (`codex_cli_rs/<version> (<os>; <arch>)`), opt out with `CODEX_AUTH_DISABLE_CODEX_USER_AGENT=1` and override the version with `CODEX_AUTH_CLIENT_VERSION`. The plugin also no longer pins the `openai-organization` header by default, since it isn't sent by upstream Codex and could shift entitlement checks to the wrong workspace; restore it with `CODEX_AUTH_SEND_ORGANIZATION_HEADER=1`. Follow-up to the 6.8.1 fix, still needs verification by an affected preview account. ([#196](https://github.com/ndycode/oc-codex-multi-auth/issues/196))

## [6.8.1] - 2026-07-15

### Fixed
- `gpt-5.6-sol` (and the other 5.6 tiers) no longer hard-fail with "model not supported" for accounts outside the GPT-5.6 preview. They're now on the same auto-fallback path as `gpt-5.5`/`gpt-5-codex`, degrading `sol` -> `terra` -> `luna` -> `gpt-5.5` as documented. Opt out with `CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1`. Bare `gpt-5.6` now resolves to `gpt-5.6-sol` in custom fallback chains too. ([#196](https://github.com/ndycode/oc-codex-multi-auth/issues/196))
- Fixed a multi-process refresh-token clobber where one process could overwrite a refresh token another process had already rotated, eventually removing a still-valid workspace. Accounts now carry a `tokenRotatedAt` stamp and saves run as a read-modify-write transaction; files from older builds have no stamp and keep the previous behavior.
- Fixed the refresh queue re-consuming an already-rotated single-use token for callers arriving right after rotation settled, which caused a spurious 401.
- Fixed `codex-switch`, `codex-remove`, `codex-label`, and `codex-refresh` silently overwriting concurrent rotation state (rate-limit/cooldown/active-index); they now mutate and persist inside a single transaction.
- Fixed a `codex-keychain` migrate/rollback race that could let a rotation save landing mid-migration get overwritten.
- Fixed reasoning effort leaking onto fallback models, e.g. `gpt-5.6-sol-max` degrading to `gpt-5.5` used to send `max`, an effort only 5.6 accepts, turning the graceful degrade into a hard 400. Effort is now re-clamped per fallback hop.
- Fixed truncated SSE streams (no terminal event) being reported as successes; they now return a 502 `incomplete_stream` error instead of unparseable raw text.
- Fixed uncapped `retry-after` headers that could bench a healthy account for hours from a bogus value like `retry-after: 86400`; they're now capped like the body fields. Quota reset-at headers stay uncapped.
- Fixed the TUI status line trusting stale quota snapshots for up to 5 minutes with no age check; snapshots older than one refresh interval now trigger a live re-fetch.
- Fixed `codex-reset`'s idempotency key being regenerated on every retry, making the documented double-spend protection inert. It's now derived deterministically from the credit id; a failed consume now reports `redeemed: null` instead of `false`.
- Fixed proactive token refresh skipping accounts that have a refresh token but no access token or expiry.

## [6.8.0] - 2026-07-14

### Added
- New `codex-reset` tool: view banked Codex rate-limit reset credits and redeem one to clear current usage windows, the same thing the Codex desktop app, IDE extensions, and Codex CLI `/usage` screen let you do, now available to this plugin's users too (Linux users especially). Redeeming is irreversible: `action="consume"` only issues the request when `confirm=true`, otherwise it just previews. The listing path is verified live; the redeem path is tested against a mock but not yet a live redemption. ([#193](https://github.com/ndycode/oc-codex-multi-auth/issues/193), [#195](https://github.com/ndycode/oc-codex-multi-auth/issues/195))

### Fixed
- A disabled rate-limit window (`window-minutes: 0`) is no longer shown as a phantom `quota 100%` segment next to the real weekly window. A window is now hidden only on an explicit zero length; a missing length still shows as generic `quota`. Reported by @aic0d3r. ([#194](https://github.com/ndycode/oc-codex-multi-auth/issues/194), [#195](https://github.com/ndycode/oc-codex-multi-auth/issues/195))

## [6.7.1] - 2026-07-10

### Fixed
- **Action needed:** GPT-5.6 requests fail with `HTTP 400` on 6.7.0, upgrade now if you use `gpt-5.6-sol`, `gpt-5.6-terra`, or `gpt-5.6-luna`. The backend requires `reasoning.context = "all_turns"` on responses-lite requests, and 6.7.0 never set it, so every 5.6 turn hard-failed instead of falling back to `gpt-5.5`. Reported and fixed by @UnknOownU. ([#191](https://github.com/ndycode/oc-codex-multi-auth/issues/191), [#192](https://github.com/ndycode/oc-codex-multi-auth/issues/192))

## [6.7.0] - 2026-07-10

### Added
- GPT-5.6 support: `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, plus bare `gpt-5.6` as an alias for Sol. Effort follows the Codex catalog: Sol/Terra go up to `max`/`ultra` (`ultra` is sent as `max`), Luna stops at `max`, `none`/`minimal` floor to `low`, and `max`/`ultra` on pre-5.6 models step down to `xhigh`, then `high`. ([#189](https://github.com/ndycode/oc-codex-multi-auth/issues/189))
- GPT-5.6 is opt-in: the `gpt-5` alias still resolves to `gpt-5.5`/`gpt-5.4`. Without access, requests fall back `gpt-5.6-sol` -> `gpt-5.6-terra` -> `gpt-5.6-luna` -> `gpt-5.5` instead of failing. ([#189](https://github.com/ndycode/oc-codex-multi-auth/issues/189))

### Fixed
- GPT-5.6 models now use Codex's responses-lite request shape, so they get their tools instead of losing them in a field they don't read. ([#189](https://github.com/ndycode/oc-codex-multi-auth/issues/189))
- **Breaking:** system instructions now come from the Codex model catalog instead of the old `gpt_5_2_prompt.md` file, changing the system prompt for existing `gpt-5.2`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.5` users. Models the catalog doesn't cover keep their old prompt file. ([#190](https://github.com/ndycode/oc-codex-multi-auth/issues/190))
- Catalog instructions now cache per model id instead of per family, so `gpt-5.5` and `gpt-5.4` no longer serve each other's prompt. ([#190](https://github.com/ndycode/oc-codex-multi-auth/issues/190))
- `models.json` is now fetched once and shared, instead of once per catalog model. ([#190](https://github.com/ndycode/oc-codex-multi-auth/issues/190))
- `minimal` reasoning effort now floors to `low` for GPT-5.6, matching the existing `none` rule. ([#189](https://github.com/ndycode/oc-codex-multi-auth/issues/189))
- Consolidated four duplicate effort-suffix regexes into one, fixing parsing of ids like `gpt-5.1-codex-max`. ([#189](https://github.com/ndycode/oc-codex-multi-auth/issues/189))

## [6.6.0] - 2026-07-09

### Added
- `setShutdownOwnsProcess(boolean)` is now exported from `lib/shutdown.ts` so a standalone entrypoint can own process termination. ([#187](https://github.com/ndycode/oc-codex-multi-auth/issues/187))

### Fixed
- The plugin no longer calls `process.exit()` on `SIGINT`/`SIGTERM` inside the opencode host, so Ctrl+C properly lets opencode print the session id. The debounced-save flush is still awaited on shutdown, so the no-lost-rotations guarantee from [#110](https://github.com/ndycode/oc-codex-multi-auth/issues/110) holds. ([#187](https://github.com/ndycode/oc-codex-multi-auth/issues/187))
- `runCleanup()` no longer drops work when a shutdown drain overlaps with another cleanup call. ([#187](https://github.com/ndycode/oc-codex-multi-auth/issues/187))

## [6.5.0] - 2026-06-30

### Added
- New `oc-codex-multi-auth warm` CLI command warms up every enabled account's quota window directly, with no token cost, skipping disabled accounts. Supports `--json` and exits non-zero if any account fails. ([#182](https://github.com/ndycode/oc-codex-multi-auth/issues/182))

## [6.4.1] - 2026-06-30

### Fixed
- Local token-bucket depletion no longer leaks into persisted, cross-process state in `rateLimitResetTimes`, so one process's local limiter can't wrongly mark an account rate-limited for other processes. ([#183](https://github.com/ndycode/oc-codex-multi-auth/issues/183))
- `codex-warm` no longer reports a quota-exhausted account as "warmed", a `quota`/`usage_limit` `429` is now a distinct failure. ([#182](https://github.com/ndycode/oc-codex-multi-auth/issues/182))

## [6.4.0] - 2026-06-30

### Added
- `rotationStrategy` config (env `CODEX_AUTH_ROTATION_STRATEGY`) picks the account load-balancing algorithm: `hybrid` (default), `sticky` (drain one account first, then move to the next), or `round-robin`. ([#183](https://github.com/ndycode/oc-codex-multi-auth/issues/183))
- New `codex-warm` tool primes every enabled account's quota window with one minimal billable request at session start. Disabled accounts are skipped. ([#182](https://github.com/ndycode/oc-codex-multi-auth/issues/182))

### Fixed
- Local token-bucket depletion now gets a short auto-expiring rate-limit window, so account selection actually rotates off it instead of returning a spurious 503. ([#183](https://github.com/ndycode/oc-codex-multi-auth/issues/183))
- `codex-doctor --fix` now clears stale rate-limit/cooldown state on accounts whose token refresh succeeds, so a dark account pool can recover without hand-editing JSON. (fixes [#171](https://github.com/ndycode/oc-codex-multi-auth/issues/171))
- `codex-doctor --fix` reports `N account(s) need re-login` instead of silently failing when a credential is genuinely dead. ([#171](https://github.com/ndycode/oc-codex-multi-auth/issues/171))
- `codex-doctor` now flags a disabled duplicate account (from a re-login) that shadows an enabled account sharing the same email. It gets a `codex-remove` hint rather than being auto-removed, since email-only merges must not collapse distinct multi-org accounts ([#64](https://github.com/ndycode/oc-codex-multi-auth/issues/64)). ([#171](https://github.com/ndycode/oc-codex-multi-auth/issues/171))
- `codex-health` now surfaces the same recovery diagnostics as `codex-doctor` (stale cooldowns, disabled duplicates), read-only. ([#171](https://github.com/ndycode/oc-codex-multi-auth/issues/171))
- Storage dedup by email is now case-insensitive and no longer disables the canonical account when merging a disabled duplicate; genuinely user-disabled accounts still fail closed. ([#171](https://github.com/ndycode/oc-codex-multi-auth/issues/171))
- `codex-doctor`/`codex-health` now flag a disabled account that holds a fresh login credential, so you know to re-enable it if intended. ([#171](https://github.com/ndycode/oc-codex-multi-auth/issues/171))
- Cancelling during a retry/backoff wait now surfaces a proper `AbortError` with the real reason instead of a generic error. ([#176](https://github.com/ndycode/oc-codex-multi-auth/issues/176))

### Security
- Bumped `hono` to 4.12.26, fixing a high-severity Windows `serve-static` path traversal (GHSA-88fw-hqm2-52qc) and four moderate advisories (GHSA-j6c9-x7qj-28xf, GHSA-rv63-4mwf-qqc2, GHSA-wgpf-jwqj-8h8p, GHSA-wwfh-h76j-fc44).
- Overrode `vite` to ^7.3.5, fixing a high-severity `server.fs.deny` bypass on Windows and a moderate advisory (GHSA-fx2h-pf6j-xcff, GHSA-v6wh-96g9-6wx3).
- Overrode `@babel/core` to ^7.29.6, fixing a low-severity arbitrary file read via `sourceMappingURL` (GHSA-4x5r-pxfx-6jf8).
- Added a `brace-expansion` override to ^5.0.6, fixing a moderate ReDoS advisory. `npm audit` now reports 0 vulnerabilities.

### Internal
- Fixed a flaky email-masking property test; no production code change. ([#163](https://github.com/ndycode/oc-codex-multi-auth/issues/163))

## [6.3.3] - 2026-06-17

### Fixed
- A stored account whose token is invalidated server-side (HTTP 401) is now treated as an account-health failure: the token refunds, the refresh-token group cools down (or is removed past `MAX_AUTH_FAILURES_BEFORE_REMOVAL`), and the request rotates to the next healthy account. ([#172](https://github.com/ndycode/oc-codex-multi-auth/issues/172), fixes [#171](https://github.com/ndycode/oc-codex-multi-auth/issues/171))
- `codex-health`/`codex-doctor` now flag `token-invalid` on an invalidated-token error, so `codex-doctor --fix` can repair routing without manual `activeIndex` edits. ([#172](https://github.com/ndycode/oc-codex-multi-auth/issues/172))

## [6.3.2] - 2026-06-10

### Fixed
- `gpt-5.3-codex-spark`, `gpt-5.3-codex`, and `gpt-5.2-codex` are no longer collapsed to `gpt-5-codex` before sending requests, so accounts without the base model stop getting `model_not_supported_with_chatgpt_account`. ([#170](https://github.com/ndycode/oc-codex-multi-auth/issues/170), fixes [#169](https://github.com/ndycode/oc-codex-multi-auth/issues/169))
- Added `gpt-5.4-fast` and `gpt-5.4-mini-fast` as explicit model map entries so OpenCode fast-variant selectors resolve correctly.
- Reasoning effort `none` is still coerced to `low` for these three Codex families, since the backend rejects it for them.

## [6.1.8] - 2026-04-29

### Fixed
- Local `npm link` installs now run the CLI wrapper correctly by resolving symlinked bin paths before direct-execution detection.
- Request filtering now defaults missing or null `function_call.arguments` to `{}` before forwarding.

### Internal
- Resolved audit validation follow-ups, including refreshed docs parity coverage.

## [6.1.7] - 2026-04-25

### Added
- OpenCode TUI prompt status plugin showing the active Codex quota during sessions, with real response-header quota updates, account-aware display, color thresholds, and a quota details command.
- Daily npm update detection now clears the OpenCode-managed plugin cache on exit when a newer version is available, so restarting OpenCode installs the latest plugin automatically.

### Changed
- The installer now manages OpenCode `tui.json` alongside the main plugin config, so the TUI status module ships with the package.
- TUI startup keeps the home prompt clean and only shows quota status inside active sessions.
- Added an `autoUpdate` config option and `CODEX_AUTH_AUTO_UPDATE=0` env override for manual update prompts.

### Fixed
- Quota status cache writes no longer block the request response path and coalesce rapid duplicate writes.
- Account switching now clears stale TUI quota state so the next session reflects the selected account.
- Multi-account quota status now follows the account used by the latest request, including non-`codex` model families.

## [6.1.6] - 2026-04-24

### Added
- OpenCode TUI prompt status plugin showing the active Codex quota during sessions, with real response-header quota updates, account-aware display, color thresholds, and a quota details command.

### Changed
- The installer now manages OpenCode `tui.json` alongside the main plugin config, so the TUI status module ships with the package.
- TUI startup keeps the home prompt clean and only shows quota status inside active sessions.

### Fixed
- Quota status cache writes no longer block the request response path and coalesce rapid duplicate writes.
- Account switching now clears stale TUI quota state so the next session reflects the selected account.
- Multi-account quota status now follows the account used by the latest request, including non-`codex` model families.

## [6.1.5] - 2026-04-24

### Changed
- Default installer mode now writes the compact OAuth model catalog, so OpenCode's model picker shows base models only; reasoning depth is chosen via the variant picker.
- Added `--full` installer mode for users who want explicit selector ids like `gpt-5.5-medium` and `gpt-5.5-fast-medium` in the model picker.
- Compact/default installs now prune stale preset and base model ids from earlier catalogs, so rerunning the installer actually cleans up the picker.

## [6.1.4] - 2026-04-24

### Fixed
- Ships the `gpt-5.5-fast` modern config entry and explicit `gpt-5.5-fast-{none,low,medium,high,xhigh}` legacy selectors, so OpenCode resolves `openai/gpt-5.5-fast-medium` before plugin routing.
- Installer cache refresh now clears OpenCode's newer package cache at `~/.cache/opencode/packages/{oc-codex-multi-auth,oc-chatgpt-multi-auth}@latest`.
- The installer now normalizes stale managed file-path and `file:///.../node_modules/...` plugin entries back to the official `oc-codex-multi-auth` package name.

## [6.1.3] - 2026-04-24

### Added
- Explicit `gpt-5.5-fast` and `gpt-5.5-fast-{none,low,medium,high,xhigh}` model map entries, normalizing to `gpt-5.5`, fixing `All N account(s) failed` errors when picking OpenCode's built-in `GPT-5.5 Fast` catalog item.
- GPT-5.5 now auto-falls back to `gpt-5.4` on `model_not_supported_with_chatgpt_account`, even without `unsupportedCodexPolicy: "fallback"` or `CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback`. Opt out with `CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1`.

### Removed
- Removed GPT-5.5 Pro routing and config entries (`gpt-5.5-pro`, `gpt-5.5-pro-{medium,high,xhigh}`, `gpt-5.5-pro-20260423*`), since GPT-5.5 Pro ships to ChatGPT only, not Codex. Any `gpt-5.5-pro*` id still canonicalizes to `gpt-5.5`.

### Fixed
- The terminal aggregator no longer misreports pool-wide entitlement 400s as "server errors or auth issues"; it now names the model and points to the fallback env var.
- Fixed a typecheck regression from 6.1.2 where `shouldRefreshToken` referenced a removed `Auth` type.

## [6.1.2] - 2026-04-24

### Added
- GPT-5.5 2026-04-23 release presets in the shipped OpenCode config templates.

### Changed
- GPT-5.5 2026-04-23 is now active across runtime model routing, with the runtime model mapping aligned to the new release family.

### Fixed
- GPT-5.5 gating now falls back cleanly when the requested release is unavailable upstream.

## [6.1.1] - 2026-04-22

### Fixed
- `service_unavailable_error` and `server_is_overloaded` errors are now retried as server faults even on non-5xx responses, and overload `retry_after` backoff is still honored when the account pool is exhausted.
- Live upstream `server_error` responses on non-5xx are now retried instead of failing immediately.

## [6.1.0] - 2026-04-17

### Added
- `codex-keychain` opt-in OS-keychain credential backend via `CODEX_KEYCHAIN=1` (macOS Keychain / Windows Credential Manager / Linux libsecret). ([#132](https://github.com/ndycode/oc-codex-multi-auth/issues/132), [#133](https://github.com/ndycode/oc-codex-multi-auth/issues/133), [#134](https://github.com/ndycode/oc-codex-multi-auth/issues/134))
- `codex-diag` redacted diagnostics snapshot tool for bug reports. ([#126](https://github.com/ndycode/oc-codex-multi-auth/issues/126))
- `codex-diff` redacted config/account comparator. ([#129](https://github.com/ndycode/oc-codex-multi-auth/issues/129))
- `NO_COLOR` and `FORCE_COLOR` environment variable support in UI rendering. ([#126](https://github.com/ndycode/oc-codex-multi-auth/issues/126))
- Multi-worktree collision detection with a non-blocking warning. ([#130](https://github.com/ndycode/oc-codex-multi-auth/issues/130))

### Changed
- Wired the circuit-breaker's half-open gate into the request pipeline for more reliable retries. ([#123](https://github.com/ndycode/oc-codex-multi-auth/issues/123))

### Fixed
- Fixed a critical bug where concurrent `incrementAuthFailures` calls on a shared refresh token could lose auth-failure counts; now serialized per refresh token. ([#108](https://github.com/ndycode/oc-codex-multi-auth/issues/108))
- **Action needed:** destructive defaults changed: `importAccounts` now defaults to a timestamped backup, `exportAccounts` defaults to `force: false`, and `codex-remove` now requires explicit `confirm: true`. ([#108](https://github.com/ndycode/oc-codex-multi-auth/issues/108))
- Shutdown on `SIGINT`/`SIGTERM` now awaits the debounced save flush, preventing lost rotations. ([#110](https://github.com/ndycode/oc-codex-multi-auth/issues/110))
- `schemaVersion > 3` now throws `StorageError(UNSUPPORTED_SCHEMA_VERSION)` instead of silently nulling data. ([#110](https://github.com/ndycode/oc-codex-multi-auth/issues/110))
- V2 storage files are now detected and either migrated or explicitly rejected instead of silently dropped. ([#113](https://github.com/ndycode/oc-codex-multi-auth/issues/113))
- Credential merge now uses `??` instead of `||`, so empty-string tokens can no longer resurrect stale values. ([#112](https://github.com/ndycode/oc-codex-multi-auth/issues/112))
- `REDIRECT_URI` now uses the `127.0.0.1` literal for RFC 8252 compliance. ([#112](https://github.com/ndycode/oc-codex-multi-auth/issues/112))
- Codex-CLI cross-process JSON is now Zod-validated before merging. ([#112](https://github.com/ndycode/oc-codex-multi-auth/issues/112))
- Logger `TOKEN_PATTERNS` now cover OpenAI opaque refresh/access/id tokens too. ([#112](https://github.com/ndycode/oc-codex-multi-auth/issues/112), [#126](https://github.com/ndycode/oc-codex-multi-auth/issues/126))
- The installer now deep-merges `provider.openai` instead of clobbering your customizations, and supports `--dry-run`. ([#114](https://github.com/ndycode/oc-codex-multi-auth/issues/114))
- Fixed keychain post-merge bugs: partial-migration staleness, `clearAccounts` ordering, rollback silent-clobber, and a lexicographic-sort bug. ([#133](https://github.com/ndycode/oc-codex-multi-auth/issues/133), [#134](https://github.com/ndycode/oc-codex-multi-auth/issues/134))

### Internal
- Big internal refactor: `index.ts` cut from 5975 to 3425 lines with all 18 tools extracted to `lib/tools/*`, `lib/storage.ts` split into 12 submodules, `AccountManager` split into 4 services, a typed error hierarchy, and Zod validation at remaining process boundaries. ([#109](https://github.com/ndycode/oc-codex-multi-auth/issues/109), [#115](https://github.com/ndycode/oc-codex-multi-auth/issues/115), [#116](https://github.com/ndycode/oc-codex-multi-auth/issues/116), [#117](https://github.com/ndycode/oc-codex-multi-auth/issues/117), [#118](https://github.com/ndycode/oc-codex-multi-auth/issues/118), [#119](https://github.com/ndycode/oc-codex-multi-auth/issues/119), [#120](https://github.com/ndycode/oc-codex-multi-auth/issues/120), [#121](https://github.com/ndycode/oc-codex-multi-auth/issues/121), [#122](https://github.com/ndycode/oc-codex-multi-auth/issues/122))
- Added a CI matrix (Node 18/20/22 + Windows), Dependabot, Scorecard, a chaos fault-injection suite, contract tests, and refreshed docs (README, CONTRIBUTING, SECURITY, ARCHITECTURE, audit report). Test count went from 2088 to 2234. ([#107](https://github.com/ndycode/oc-codex-multi-auth/issues/107), [#111](https://github.com/ndycode/oc-codex-multi-auth/issues/111), [#124](https://github.com/ndycode/oc-codex-multi-auth/issues/124), [#125](https://github.com/ndycode/oc-codex-multi-auth/issues/125), [#127](https://github.com/ndycode/oc-codex-multi-auth/issues/127), [#128](https://github.com/ndycode/oc-codex-multi-auth/issues/128), [#131](https://github.com/ndycode/oc-codex-multi-auth/issues/131))

## [6.0.0] - 2026-04-06

### Added
- Beginner commands: `codex-help`, `codex-setup` (with a wizard), `codex-doctor fix`, and `codex-next` for guided setup and recovery.
- `codex-tag` and `codex-note` for tagging and annotating accounts, plus tag filtering in `codex-list`.
- `codex-switch`, `codex-label`, and `codex-remove` now support interactive picking in compatible terminals when you don't give an index.
- `codex-export` can auto-timestamp backups; `codex-import` adds a `dryRun` preview and backs up automatically before applying.
- New `beginnerSafeMode` config key (and `CODEX_AUTH_BEGINNER_SAFE_MODE` env var) for more conservative retry behavior.
- A one-time startup health summary now tells you what to do next.

### Changed
- **Breaking:** the package is now `oc-codex-multi-auth` (was `oc-chatgpt-multi-auth`). Update your OpenCode plugin entry to the new name.
- Runtime storage files are renamed to `oc-codex-multi-auth-accounts.json` and `oc-codex-multi-auth-flagged-accounts.json`, migrating automatically from the old names.
- Account storage gets optional `accountTags` and `accountNote` fields.
- Docs, README, and onboarding text refreshed for the new beginner commands and Codex-first naming.

### Fixed
- Commands that need an index now explain what to do when no interactive menu is available.
- `codex-doctor fix` no longer crashes when there's no account to switch to, it just reports it.
- `codex-import` no longer fails with "No accounts to export" on an empty setup.
- The installer now clears both old and new package names from OpenCode's cache so upgrades don't stick on stale files.

## [5.4.8] - 2026-03-24

### Added
- Read-only Codex ops commands (status, metrics, dashboard, doctor) now support `format="json"` for automation.
- Added a device-code login flow for ChatGPT auth on SSH, WSL, and other headless environments.

### Changed
- OAuth, manual, and device-code login now share the same account-selection and persistence logic.
- Hardened timeout, deactivated-workspace, and OAuth callback handling for consistency.
- Updated dependencies (`hono`) and pinned audit overrides for a clean dependency audit.

### Fixed
- Import preview and apply now share one analysis path, so deduplication and counts stay consistent.
- Deactivated workspaces: refresh-token variants are removed together, rotation restarts on a healthy account, and a zero-removal case cools the account down instead.

## [5.4.3] - 2026-03-06

### Added
- Dated snapshot IDs `gpt-5.4-2026-03-05*` and `gpt-5.4-pro-2026-03-05*` (including effort suffixes) now normalize correctly.

### Changed
- `gpt-5`, `gpt-5-mini`, and `gpt-5-nano` now normalize to `gpt-5.4` as the default general family.
- `gpt-5.4-pro` is now handled as its own prompt family separate from `gpt-5.4`, with fallback still going `gpt-5.4-pro` -> `gpt-5.4`.
- Config templates now set `gpt-5.4*` context to `1,000,000` (output stays `128,000`); docs cover optional `model_context_window` / `model_auto_compact_token_limit` tuning.

## [5.4.2] - 2026-03-05

### Added
- `gpt-5.4` and optional `gpt-5.4-pro` are now supported, with normalization and request-transform coverage.
- Fallback mode now includes `gpt-5.4-pro` -> `gpt-5.4` when a model is unsupported.

### Changed
- Config templates now default to `gpt-5.4` as the general-purpose family.
- Docs (README, getting started, configuration, troubleshooting) updated for the `gpt-5.4` rollout and optional `gpt-5.4-pro`.

### Fixed
- Quota snapshot probing now checks `gpt-5.4` first, before falling back to legacy Codex probe models.

## [5.4.0] - 2026-02-28

### Changed
- Org-scoped account matching and dedupe now check account ID too, so distinct workspaces in the same org no longer get merged together.
- Organization binding from the ID token now prefers `idToken['https://api.openai.com/auth'].organizations[0].id`.

### Fixed
- Account restoration now preserves organization/workspace identity across token refresh and flagged-account recovery.
- No-org duplicate accounts now collapse consistently across storage, authorize, and prune.
- The active account selection stays stable after dedupe/pruning instead of jumping to the wrong index.

## [5.3.0] - 2026-02-22

### Added
- OAuth workspace candidates are now kept as distinct accounts, so multi-workspace routing stays stable across sessions.

### Fixed
- Account restoration now preserves organization/workspace identity across token refresh and flagged-account recovery.
- Restoring a flagged account no longer drops `organizationId` when an `accountId` is already set.

## [5.2.3] - 2026-02-21

### Changed
- Request handling now defaults to `native` mode, keeping OpenCode's own tool/payload shapes instead of Codex-style rewrites. Set `requestTransformMode: "legacy"` (or `CODEX_AUTH_REQUEST_TRANSFORM_MODE=legacy`) for the old behavior.

### Fixed
- Native mode avoids bridge-side alias rewrites that could produce invalid tool-call schemas.
- Codex bridge instructions now stick to the runtime's actual tool manifest instead of inventing or translating tool names.

## [5.2.1] - 2026-02-20

### Changed
- Added `OPENCODE_CODEX_PROMPT_URL` to override the prompt source, with cache metadata that keeps ETag checks bound to the same source.

### Fixed
- Removed contradictory bridge/remap guidance that forbade `patch`; `apply_patch` intent now maps to `patch` (preferred) or `edit` for targeted changes.
- Prompt fetching now retries across multiple upstream URLs instead of failing on a single 404.

## [5.2.0] - 2026-02-13

### Added
- Support for `gpt-5.3-codex-spark` and its reasoning variants. Spark is entitlement-gated, and adding it to your config template is an optional manual step.
- Configurable fallback chains for unsupported models via `fallbackOnUnsupportedCodexModel` and `unsupportedCodexFallbackChain`.

### Changed
- New `unsupportedCodexPolicy` config (`strict` default, or `fallback`) controls what happens on an unsupported-model error; the old `fallbackOnUnsupportedCodexModel` now maps onto this.
- On an unsupported-model error, the plugin now tries your other accounts/workspaces before falling back to a different model, improving Spark entitlement discovery.
- Fast session mode now sends `reasoning.summary: "auto"`; invalid or legacy summary values are normalized to `auto`.
- `fallbackToGpt52OnUnsupportedGpt53` / `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52` still work as a legacy toggle inside the new fallback system.

## [5.1.1] - 2026-02-08

### Fixed
- `openai/<model>` ids now resolve to their base model config instead of falling back to global defaults.
- Variant suffixes like `-xhigh` now correctly apply `models.<base>.variants.<variant>` options.

## [5.1.0] - 2026-02-08

### Changed
- OAuth workspace auto-selection now prefers your org's default workspace, then the ID-token-selected workspace, then other non-personal org workspaces, before falling back to your personal ID.

### Fixed
- Explicit org/manual workspace bindings are no longer overwritten by the token's `chatgpt_account_id` at request time.
- Fixed `gpt-5.3-codex` failing with an unsupported-model error on Business accounts when requests were misrouted to a personal/free workspace.

## [5.0.0] - 2026-02-08

### Changed
- **Breaking:** `opencode auth login` now defaults to the Codex-style dashboard flow (actions/accounts/danger zone) instead of the old add/fresh-only prompt.
- **Action needed:** `codex-list`, `codex-status`, `codex-health`, `codex-switch`, `codex-remove`, `codex-refresh`, `codex-export`, and `codex-import` now default to the new Codex TUI formatting. If you parse their output in scripts, update your parsing or set `codexTuiV2: false`.

### Added
- New TUI config/env options: `codexTuiV2`, `codexTuiColorProfile`, `codexTuiGlyphMode`, `CODEX_TUI_V2`, `CODEX_TUI_COLOR_PROFILE`, `CODEX_TUI_GLYPHS`.
- Interactive login now supports add/check/deep-check/verify-flagged/start-fresh, plus per-account enable/disable, refresh, and delete.
- Flagged accounts now live in `openai-codex-flagged-accounts.json`, migrating automatically from the old `openai-codex-blocked-accounts.json`.

### Fixed
- Disabled accounts are now excluded from active/current selection and rotation.
- The `enabled` flag now survives the v1 -> v3 storage migration and persists correctly across save/load.

## [4.14.2] - 2026-02-08

### Changed
- Fallback from `gpt-5.3-codex` to `gpt-5.2-codex` on a ChatGPT entitlement rejection is now on by default. Turn it off with `fallbackToGpt52OnUnsupportedGpt53: false` or `CODEX_AUTH_FALLBACK_GPT53_TO_GPT52=0`.

### Fixed
- The upstream "not supported when using Codex with a ChatGPT account" error now shows as a clear entitlement error instead of a generic bad request.

## [4.14.1] - 2026-02-07

### Added
- New `fastSession` mode for lower latency, with `hybrid`/`always` strategies and a configurable history window via `fastSessionMaxInputItems`.

### Changed
- Prompts are now cached with stale-while-revalidate and prewarmed at startup, cutting first-turn latency.
- The fetch pipeline now handles non-string request bodies (`Uint8Array`, `ArrayBuffer`, `Blob`) instead of failing.

### Fixed
- Trivial one-line turns in fast session mode now skip tool definitions and use compact instructions for a faster round trip.

## [4.14.0] - 2026-02-05

### Added
- `gpt-5.3-codex` is now supported, with `low`, `medium`, `high`, and `xhigh` variants, and its own slot in account rotation.

### Changed
- `gpt-5.3-codex` now defaults to `xhigh` reasoning effort; `none`/`minimal` are normalized to a supported level.
- Prompt caching now recognizes `gpt-5.3-codex` (cache file `gpt-5.3-codex-instructions.md`).
- Config templates and model docs now list `gpt-5.3-codex` instead of `gpt-5.2-codex`.

## [4.13.0] - 2026-02-04

### Added
- New `codex-metrics` tool shows live request, error, and latency counters for the running plugin.
- 401 errors now include `diagnostics` (`requestId`, `cfRay`, `correlationId`, `threadId`) to speed up debugging.
- New `fetchTimeoutMs` and `streamStallTimeoutMs` options (with env overrides) to tune upstream timeouts.

### Changed
- Each upstream request now gets a correlation id and reuses `CODEX_THREAD_ID` / `prompt_cache_key` when available.
- `request_user_input` is removed from the tool list in Default mode and kept in Plan mode.
- Bridge prompts now block destructive git commands unless you ask for them.
- `gpt-5.2-codex` now defaults to `xhigh` effort when no effort or variant is set.

### Fixed
- Non-streaming SSE responses no longer hang on a stalled read.

## [4.12.5] - 2026-02-04

### Changed
- Project-scoped account files now live under `~/.opencode/projects/<project-key>/openai-codex-accounts.json` instead of inside `<project>/.opencode/`.

### Added
- Legacy `<project>/.opencode/openai-codex-accounts.json` data now migrates automatically to the new location on first load, but only when the new project-scoped path is empty.

## [4.12.4] - 2026-02-03

### Added
- Automatic retry on empty or malformed API responses. Config: `emptyResponseMaxRetries` (default 2) / `CODEX_AUTH_EMPTY_RESPONSE_MAX_RETRIES`, `emptyResponseRetryDelayMs` (default 1000ms) / `CODEX_AUTH_EMPTY_RESPONSE_RETRY_DELAY_MS`.
- Parallel OpenCode instances now get a deterministic PID-based offset for account selection to reduce contention. Enable with `pidOffsetEnabled: true` / `CODEX_AUTH_PID_OFFSET_ENABLED`.

### Fixed
- Fixed the PID offset formula so accounts no longer all get the same offset (now uses `account.index * 0.131 + pidBonus`).
- Empty-response detection now correctly catches empty choice objects (`[{}]`) and whitespace-only content.

### Internal
- Not published to npm for this version (tag/release only).

## [4.12.3] - 2026-02-03

### Fixed
- Accounts were saved to the wrong location when `perProjectAccounts` was on, because `setStoragePath()` ran too late. Both OAuth methods (browser and manual URL paste) now set the storage path before saving. ([#19](https://github.com/ndycode/oc-codex-multi-auth/issues/19))

### Internal
- Test coverage up to 89% (1498 tests), plus general code quality cleanup from an audit.

## [4.12.2] - 2026-01-30

### Fixed
- Fixed a TUI crash on the workspace prompt. It now auto-selects the default workspace instead of showing a redundant prompt (detected via a new `isNonInteractiveMode()` check). ([#17](https://github.com/ndycode/oc-codex-multi-auth/issues/17))
- Manual OAuth flow now shows a proper error message instead of `[object Object]`.

## [4.12.1] - 2026-01-30

### Changed
- Added a rotating file audit log with structured entries.
- Auth rate limiting: token bucket, 5 requests/min per account.
- Tokens now refresh proactively 5 minutes before they expire.
- Zod schemas are now the single source of truth for runtime validation.

### Fixed
- Business plan workspace fix: fixed "usage not included" errors some Business plan users hit, caused by sending a stale stored account ID instead of the fresh one from the token. ([#17](https://github.com/ndycode/oc-codex-multi-auth/issues/17), thanks @alanzchen)
- Storage failures used to fail silently unless debug mode was on. You now get an error toast with actionable hints (antivirus exclusions on Windows, chmod suggestions on Unix). ([#19](https://github.com/ndycode/oc-codex-multi-auth/issues/19))
- Account storage now writes to a temp file then renames, so an interrupted write can't corrupt state.
- Fixed a reader lock leak in the SSE response handler that wasn't releasing in its finally block.
- Added debug logging showing which account gets picked and why during rotation.

### Internal
- Test suite grew from 580 to 631 tests, all passing on Windows with `--pool=forks`.

## [4.12.0] - 2026-01-30

### Changed
- **Breaking:** all `openai-accounts-*` tools renamed to a shorter `codex-*` prefix: `openai-accounts` -> `codex-list`, `openai-accounts-switch` -> `codex-switch`, `openai-accounts-status` -> `codex-status`, `openai-accounts-health` -> `codex-health`, `openai-accounts-refresh` -> `codex-refresh`, `openai-accounts-remove` -> `codex-remove`.

### Added
- `codex-export`: export all accounts to a JSON file for backup or migration.
- `codex-import`: import accounts from a JSON file, merging with existing accounts and skipping duplicates.

## [4.11.2] - 2026-01-30

### Fixed
- Windows account persistence: fixed a silent failure when saving accounts on Windows. Errors now log at WARN level with the storage path, and a toast notification appears if persistence fails.

## [4.11.1] - 2026-01-29

### Changed
- README now documents all 6 account management tools with example prompts.

### Fixed
- `openai-accounts-status` no longer crashes when you have no accounts configured (was a Zod validation error).

## [4.11.0] - 2026-01-29

### Added
- Per-project accounts now work from subdirectories too. The plugin walks up the directory tree to find the project root (`.git`, `package.json`, `pyproject.toml`, etc).
- Rate limit waits now show a live countdown that updates every 5 seconds: `Waiting for rate limit reset (2m 35s remaining)`.
- Accounts are automatically removed after 3 consecutive auth failures, with a notification explaining why. No more manual cleanup of dead accounts.
- New `openai-accounts-refresh` tool to manually refresh all OAuth tokens and verify they're still valid.

## [4.10.0] - 2026-01-29

### Added
- Per-project accounts: each project now gets its own account storage, so no more conflicts working across repos with different ChatGPT accounts. Auto-detects project directories (`.git`, `package.json`, etc), falls back to global storage otherwise. Enable/disable with `perProjectAccounts` in config or `CODEX_AUTH_PER_PROJECT_ACCOUNTS=1`.
- Rate limit toast notifications now stick around longer (5s default). Set `toastDurationMs` in config, or `CODEX_AUTH_TOAST_DURATION_MS` to change it.
- New `openai-accounts-remove` tool to delete accounts by index.
- All tokens, API keys, and bearer headers are now masked in debug logs.

### Changed
- Account limit bumped from 10 to 20.
- `perProjectAccounts` now defaults to `true`. Set `perProjectAccounts: false` in config for the old global behavior.

### Fixed
- Added `tokenRotationMap` to prevent concurrent token refresh requests from stepping on each other.
- Added 20% jitter to rate limit retry delays to prevent thundering herd.
- Removed `apply_patch` references from the Codex bridge that caused loops in some edge cases.

## [4.9.7] - 2026-01-29

### Added
- New `CODEX_AUTH_ACCOUNT_ID` env var to force a specific workspace ID (non-interactive login).
- Added troubleshooting guidance for "usage not included in your plan".

### Fixed
- Business/team workspace selection: now detects multiple workspace account IDs from OAuth tokens and prompts for the right one.
- Refresh/hydration no longer overwrites your selected workspace ID (org and manual choices stay stable).
- Workspace labels and sources are now persisted for clearer account listings.

## [4.9.6] - 2026-01-27

### Changed
- TUI auth gating: non-tty/UI auth attempts now return a clear instruction to run `opencode auth login` in a terminal shell.
- Simplified error mapping: entitlement and rate-limit handling are now consolidated into a single path in the fetch helpers.

### Internal
- This release's commit history also folds in earlier fixes tracked under [#11](https://github.com/ndycode/oc-codex-multi-auth/issues/11) and [#13](https://github.com/ndycode/oc-codex-multi-auth/issues/13).

## [4.9.5] - 2026-01-28

### Fixed
- Account error handling: fixed an infinite retry loop when an account doesn't have access to Codex models. `usage_not_included` errors now return a 403 Forbidden with a clear message ("This model is not included in your ChatGPT subscription") instead of being treated as a rate limit and rotated through forever. ([#16](https://github.com/ndycode/oc-codex-multi-auth/issues/16), thanks @rainmeter33-jpg)

## [4.9.4] - 2026-01-27

### Added
- TUI auth flow disabled: authentication now strictly requires `opencode auth login` in the terminal. The UI-based "Connect" flow is disabled with a clear message, to avoid issues in non-interactive environments.

### Changed
- Strict tool schema validation: filters out unsupported required fields and flattens enums, for compatibility with strict models like Claude and Gemini.

### Fixed
- Manual login: parsing of OAuth URLs with fragments (`#code=`) is fixed.
- Account switching: manual selection is now strictly prioritized over rotation logic.
- `apply_patch` is now allowed by the bridge prompt.

## [4.9.3] - 2026-01-27

### Changed
- Strict schema validation: ported tool-cleaning logic from `antigravity-auth` to normalize tool definitions for strict models (Claude, Gemini): filters out `required` fields not in `properties`, flattens `anyOf`/`const` schemas into `enum` arrays, converts nullable array types to single types with a note, and adds placeholder properties for empty object parameters.
- `apply_patch` is now allowed by the Codex bridge prompt.

### Fixed
- Manual login: OAuth redirect URLs using fragments (`#code=...`) now parse correctly. Previously only query params were checked, so copy-paste logins failed.
- Account switching: selection logic now strictly respects your manual choice instead of letting the hybrid rotation algorithm override it. ([#13](https://github.com/ndycode/oc-codex-multi-auth/issues/13))
- TUI: clicking an account now fires the `openai.account.select` event, saves the new active index to disk, and shows a confirmation toast.
- Removed the "API Key" auth method from the list, since this plugin is OAuth-only.

## [4.9.2] - 2026-01-27

### Fixed
- Moved auth prompts into the TUI, avoiding readline input conflicts.
- Normalized error payloads to improve rate-limit handling and rotation.

### Internal
- Not published on npm this release (tag/release only).

## [4.9.1] - 2026-01-26

### Fixed
- Multi-account flow now always runs. Previously `authorize()` only entered the multi-account loop when `inputs` had keys, so calling it from `opencode auth login` (where `inputs` is `undefined`) fell back to single-account flow. The conditional check is gone, so adding multiple ChatGPT accounts works regardless of how `inputs` is passed. ([#12](https://github.com/ndycode/oc-codex-multi-auth/issues/12))

## [4.9.0] - 2026-01-26

### Changed
- **Breaking:** package renamed from `opencode-openai-codex-auth-multi` to `oc-chatgpt-multi-auth`, to bypass opencode's plugin blocking (opencode skips any plugin with `opencode-openai-codex-auth` in the name). ([#11](https://github.com/ndycode/oc-codex-multi-auth/issues/11))
- **Action needed:** update your `~/.config/opencode/opencode.json`:
  ```json
  {
    "plugin": ["oc-chatgpt-multi-auth@latest"]
  }
  ```
- Added a `multiAccount` flag check in the loader so this plugin coexists with opencode's built-in auth.

### Fixed
- Removed debug `console.log` statements from the loader.
- Plugin now properly detects when it should handle auth vs deferring to built-in.

## Legacy 4.8.2 (Package-Only) - 2026-01-25

### Changed
- Fixed Node ESM plugin load by importing tool from `@opencode-ai/plugin/tool` and ensuring the runtime dependency is installed.
- Corrected package metadata (repository links, update-check package name) and added troubleshooting guidance for plugin install/load.

### Notes
- Published under the legacy `opencode-openai-codex-auth-multi` package name, not `oc-chatgpt-multi-auth`.

## [4.7.0] - 2026-01-25

### Added
- Session recovery system, ported from opencode-antigravity-auth: automatically recovers from common API errors that used to crash sessions, including interrupted tool executions (esc mid-run), corrupted thinking blocks in message history, and thinking blocks left over when switching to a non-thinking model. Shows toast notifications during recovery attempts.
- New config options: `sessionRecovery` (default `true`) and `autoResume` (default `true`), plus env vars `CODEX_AUTH_SESSION_RECOVERY` and `CODEX_AUTH_AUTO_RESUME`.
- 26 new unit tests for the recovery system.

### Changed
- Account labels now show as `N. email` instead of `Account N (email)`.

### Internal
- Published under the legacy `opencode-openai-codex-auth-multi` package name, not `oc-chatgpt-multi-auth`.

## [4.6.0] - 2026-01-25

### Added
- Context overflow handler: "prompt too long" / context length exceeded errors now return a helpful synthetic response instead of a raw 400, suggesting `/compact`, `/clear`, or `/undo` to reduce context size, so a session doesn't get locked.
- Missing tool result injection: cancelled tool calls (esc mid-execution) now get a synthetic `"Operation cancelled by user"` output injected, preventing "missing tool_result" API errors.
- 34 new unit tests for context overflow and tool injection.

### Internal
- Published under the legacy `opencode-openai-codex-auth-multi` package name, not `oc-chatgpt-multi-auth`.

## [4.5.0] - 2026-01-24

### Added
- Strict tool validation: automatically cleans tool schemas for compatibility with strict models (Claude, Gemini).
- Auto-update notifications: get notified when a new version is available.
- 22 model presets, full variant system with reasoning levels (none/low/medium/high/xhigh).

### Changed
- Health-aware account rotation with automatic failover.
- Hybrid selection now prefers healthy accounts with available tokens.

### Internal
- Published under the legacy `opencode-openai-codex-auth-multi` package name, not `oc-chatgpt-multi-auth`.

## Legacy 4.4.0 (Package-Only) - 2026-01-23

### Added
- Health scoring: tracks success/failure per account.
- Token bucket to prevent hitting rate limits.
- Always retries when all accounts are rate-limited (waits for reset).

### Notes
- New retry options: `retryAllAccountsRateLimited` (default `true`), `retryAllAccountsMaxWaitMs` (default `0` = unlimited), `retryAllAccountsMaxRetries` (default `Infinity`).
- Not published on npm (tag/release only).

## [4.3.1] - 2026-01-23

### Added
- New `openai-accounts-status --json` for scriptable status output with email/ID labels.

### Changed
- Account labels now prefer email and show an ID suffix when available; list/status output is columnized for readability.
- Stored account emails are now trimmed and lowercased when present.

### Internal
- Dependency bumps: `@opencode-ai` plugin/sdk `1.1.34`, `hono` `4.11.5`, `vitest` `4.0.18`, `@types/node` `25.0.10`, `@typescript-eslint` `8.53.1`.
- Thanks @andremxmx for reporting the multi-account ID issue. ([#4](https://github.com/ndycode/oc-codex-multi-auth/issues/4))
- Published under the legacy `opencode-openai-codex-auth-multi` package name, not `oc-chatgpt-multi-auth`.

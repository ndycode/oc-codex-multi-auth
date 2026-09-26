# Troubleshooting

Common setup, authentication, model, and request-debugging issues for `oc-codex-multi-auth` (current package line, including the 24-tool surface and GPT-5.6 catalog).

For install modes, the full tool list (with args), and standalone CLI commands (`doctor`, `status`, `list`, `limits`, `dashboard`, `health`, `diag`, `warm`), see [Tools and CLI](tools-and-cli.md) and [Getting Started](getting-started.md). For advanced env vars (`CODEX_THREAD_ID`, `OPENCODE_CODEX_PROMPT_URL`, etc.) see [Configuration](configuration.md#advanced--power-user-environment-variables).

---

> **Quick Reset**: Most issues can be resolved by clearing the `openai` entry in OpenCode's host auth store (`~/.local/share/opencode/auth.json`, the same path on every platform including Windows; older host layouts used `~/.opencode/auth/openai.json`) and running `opencode auth login` again. Clearing the host auth entry only resets the host OAuth fallback. To fully clear pooled accounts, also remove `~/.opencode/oc-codex-multi-auth-accounts.json`, any project-specific account files under `~/.opencode/projects/<project-key>/`, and flagged account files (`*-flagged-accounts.json`). When `CODEX_KEYCHAIN=1` is active, stored accounts live in the OS keychain under service `oc-codex-multi-auth` rather than JSON, requiring `codex-keychain rollback` or OS keychain tools to clear. See [Privacy](privacy.md) for full cleanup procedures.

If you prefer guided recovery before manual debugging, run:

```text
codex-setup
codex-doctor
codex-doctor fix=true
codex-next
```

Or without an agent loop (no model tokens):

```bash
oc-codex-multi-auth doctor
oc-codex-multi-auth status --json
oc-codex-multi-auth warm
```

For machine-readable automation or CI checks, these read-only tools also accept `format="json"`:

```text
codex-status format="json"
codex-limits format="json"
codex-health format="json"
codex-next format="json"
codex-list format="json"
codex-dashboard format="json"
codex-metrics format="json"
codex-doctor deep=true format="json"
```

---

## Known Limitations

<details>
<summary><b>✅ RESOLVED: OpenCode plugin blocking (v4.9.0+)</b></summary>

**Status.** Fixed in v4.9.0 by renaming the package.

**What was happening:**

OpenCode's plugin loader explicitly skips plugins with `opencode-openai-codex-auth` in the name:

```typescript
if (plugin.includes("opencode-openai-codex-auth") || plugin.includes("opencode-copilot-auth")) continue
```

**Resolution:**

This package previously shipped under older names. `oc-codex-multi-auth` is the supported package line.

**If you were using the old package:**

Update your `~/.config/opencode/opencode.json`:
```json
{
  "plugin": ["oc-codex-multi-auth"]
}
```

**Tracking:** [Issue #11](https://github.com/ndycode/oc-codex-multi-auth/issues/11)

</details>

---

## Installation & Loading Issues

<details open>
<summary><b>Plugin not downloading / no logs</b></summary>

**Symptoms:**
- Plugin folder missing under `~/.cache/opencode/node_modules/`
- No files in `~/.opencode/logs/codex-plugin/` even with logging enabled

**Checks:**
1. **Verify config path and plugin list**:
   - Global: `~/.config/opencode/opencode.json`
   - Project: `./.opencode.json`
   - Entry should include: `"plugin": ["oc-codex-multi-auth"]`
2. **Confirm plugin cache location** (npm plugins are cached, not stored in `~/.opencode/plugins/`):
   ```bash
   ls ~/.cache/opencode/node_modules/oc-codex-multi-auth
   ```
3. **Remember: request logs only appear after the first OpenAI request**:
   ```bash
   ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "test" --model=openai/gpt-5.5 --variant=medium
   ```
4. **Check registry access**:
   ```bash
   npm view oc-codex-multi-auth version
   ```
5. **If the plugin is present but still won't load**, rerun `npx -y oc-codex-multi-auth@latest` so the installer refreshes the config and clears OpenCode's cached plugin copy.

</details>

---

## Performance & Latency

<details open>
<summary><b>Slow first response / startup latency</b></summary>

**What's normal:**
- The first request may fetch **Codex instructions** and/or the **OpenCode codex prompt** from GitHub (catalog + prompt caches under `~/.opencode/cache/`).
- Default `requestTransformMode` is **`native`**. Startup prewarm of prompt caches only runs when legacy transform is enabled (`CODEX_AUTH_REQUEST_TRANSFORM_MODE=legacy` or config `requestTransformMode: "legacy"`) and is not disabled with `CODEX_AUTH_PREWARM=0`.

**Tuning knobs:**
1. Disable prewarm when using legacy transform (if you prefer zero background fetches at startup):
   ```bash
   CODEX_AUTH_PREWARM=0 opencode
   ```
2. Enable fast-session mode (recommended: `hybrid`) to speed up trivial/interactive turns without changing defaults for complex prompts:
   ```json
   // ~/.opencode/openai-codex-auth-config.json
   {
     "fastSession": true,
     "fastSessionStrategy": "hybrid",
     "fastSessionMaxInputItems": 24
   }
   ```
   Or via env:
   ```bash
   CODEX_AUTH_FAST_SESSION=1 opencode
   ```

**Note:** `fastSessionStrategy: "always"` forces fast tuning even on complex prompts and can reduce depth. Use `hybrid` unless you explicitly want maximum speed.

</details>

---

## Concurrent Sessions & Storage

<details>
<summary><b><code>codex-pool</code> reports that plugin configuration is locked</b></summary>

**Symptoms:**
- A pool mutation reports `config_locked` with `retryable: true` in JSON output.
- Text output says the plugin configuration is locked by another process and no change was made.

**Cause.** Another OpenCode process is updating `~/.opencode/openai-codex-auth-config.json`. Pool dry-runs do not acquire this lock. Every non-dry mutation, including a possible no-op, waits for the bounded retry window and is revalidated under the lock so its result cannot rely on a stale preview.

**Solution.** No partial change was applied. Retry the same `codex-pool` action shortly. If contention persists, finish or stop other processes that are actively changing plugin configuration, then retry.

</details>

<details>
<summary><b><code>Multi-worktree collision detected on account storage</code> warning</b></summary>

This advisory warning means another live process or host is using the same account-storage file. It includes the foreign and local PID, host, and working directory so you can identify the sessions. The JSON worktree lock remains advisory, while account mutations and OAuth refreshes use a separate enforced transaction lease. On one host with a local filesystem, parallel sessions serialize refresh exchange and commit instead of reusing or clobbering a single-use token. Repeated warnings are throttled to once per minute for each storage path and foreign lock generation.

If account rotation or rate-limit state appears stale, ensure each worktree resolves to the intended project storage, then restart OpenCode and inspect the account list. Do not delete a lock belonging to a live process. Cross-host and network-filesystem coordination are not provided by the local transaction lease.

</details>

---

## Authentication Issues

<details open>
<summary><b>401 Unauthorized Error</b></summary>

**Symptoms:**
```
Error: 401 Unauthorized
Failed to access Codex API
```

**Causes:**
1. Token expired
2. Not authenticated yet
3. Invalid credentials
4. Stored OAuth grant is missing the connector scopes required by the current Codex auth flow

**Solutions:**

1. **Re-authenticate:**
   ```bash
   opencode auth login
   ```

   Re-auth is required for accounts whose recorded OAuth scope is explicitly missing one of `openid`, `profile`, `email`, or `offline_access`; those records are marked inactive until they are refreshed through login. Accounts with no recorded scope stay active, and any account marked inactive by this check is restored automatically once a complete scope is known.

2. **Check auth file exists:**
   ```bash
   cat ~/.opencode/auth/openai.json
   # Should show OAuth credentials
   ```

3. **Check token expiration:**
   ```bash
   cat ~/.opencode/auth/openai.json | jq '.expires'
   date +%s000  # Compare to current timestamp
   ```

4. **Collect diagnostics from the error payload:**
   - Newer versions include `diagnostics` on 401 responses (for example `requestId` and `cfRay`).
   - Share those IDs when filing an issue so upstream auth failures are easier to trace.

</details>

<details>
<summary><b>Browser Doesn't Open for OAuth</b></summary>

**Symptoms:**
- `opencode auth login` succeeds but no browser window
- OAuth callback times out

**Solutions:**

1. **Alternate login:**
   - Re-run `opencode auth login`
   - **If localhost port 1455 is reachable** (including via `ssh -L 1455:localhost:1455 user@remote`):
     choose **`Codex OAuth (Open URL Manually)`**, which prints the URL after the listener is ready. Open it in any browser and login completes automatically through localhost
   - **If localhost is not reachable** (containers, restricted networks):
     choose **`Codex OAuth (Device Code)`** and follow the verification link and one-time code.
     If device code is unavailable, fall back to **`Codex OAuth (Manual URL Paste)`** and paste the full callback URL, including its `state` parameter

2. **Check port 1455 availability:**
   ```bash
   # macOS/Linux
   lsof -i :1455
   
   # Windows
   netstat -ano | findstr :1455
   ```

3. **Stop Codex CLI if running.** Both use port 1455

</details>

<details>
<summary><b>Authorization Session Expired</b></summary>

**Symptoms:**
- Browser shows: `Your authorization session was not initialized or has expired`

**Solutions:**
- Re-run `opencode auth login` to generate a fresh URL
- Open the URL directly in browser (don't use a stale link)
- For SSH/WSL/remote: if localhost port 1455 is reachable (including via SSH port forwarding), choose **Open URL Manually**; if localhost is not reachable, choose **Device Code**; use **Manual URL Paste** only as a last resort

The callback window is five minutes long and starts when the login listener starts, not when you open the URL. A login left waiting past five minutes releases port 1455, so start a fresh login and open the new URL promptly.

</details>

<details>
<summary><b>Device Code Login Fails or Times Out</b></summary>

**Mechanics:**
- The one-time code expires in about 15 minutes, and the plugin stops polling after 15 minutes with a timeout message.
- The plugin polls the device authorization endpoint every 5 seconds, or the interval the server returns with the session.
- A 403 or 404 while polling means authorization is not finished yet, so the plugin keeps polling until the deadline. Complete the sign-in in the browser and the next poll succeeds.

**If the device login never starts:**
- A 404 from the start request means the auth server does not have device code login enabled. Retry with browser login or `Codex OAuth (Manual URL Paste)`.

</details>

<details>
<summary><b>403 Forbidden Error</b></summary>

**Cause.** ChatGPT subscription issue

**Check:**
1. Active ChatGPT Plus or Pro subscription
2. Subscription not expired
3. Billing is current

**Solution.** Visit [ChatGPT](https://chatgpt.com) and verify subscription status

</details>

<details>
<summary><b>"Usage not included in your plan"</b></summary>

**Symptoms:**
- Requests fail with: `Usage not included in your plan`
- Often reported on Business/Team workspaces

**Cause.** The plugin is using the wrong workspace/account id (personal vs business).

**Solutions:**
1. Upgrade to the current release of `oc-codex-multi-auth` (workspace routing logic was hardened for Business + Personal dual accounts in the 5.x line and renamed in 6.0.0).
2. Re-run `opencode auth login` and choose the intended workspace in the browser session. There is no CLI or web prompt for workspace selection, and each login binds the account to the token's `chatgpt_account_id` claim.
3. If running non-interactively, set `CODEX_AUTH_ACCOUNT_ID` to the workspace account id and re-login.
4. Verify the workspace has Codex access in the ChatGPT UI.

</details>

<details>
<summary><b>Two members of one Business workspace consume the same quota</b></summary>

**Symptoms:**

- Two different emails belong to the same ChatGPT Business workspace.
- Both entries have the same `chatgpt-account-id` and switching entries keeps
  consuming the quota of whichever member logged in last.
- `codex-health` reports a Business member credential conflict.

**Cause.** A Business workspace id identifies the subscription, not an
individual seat. Older builds could match the host OAuth fallback by that
shared id and replace every matching entry with the last member's token.

**Solution.** Upgrade to a build with member-aware account identity, then remove
the affected entries and run `opencode auth login` once for each member. Make
sure the browser is signed in as the intended member for each login. The plugin
stores the token's `chatgpt_account_user_id`, so each entry keeps its own bearer
token and `/wham/usage` reads the corresponding seat quota. Already-overwritten
credentials cannot be reconstructed and require re-login.

</details>

<details>
<summary><b>Two workspace subscriptions report the same plan and quota</b></summary>

**Symptoms:**

- One ChatGPT login (one email / Apple ID) holding **two workspace
  subscriptions**, for example Team and Plus.
- `codex-limits` reports the same plan and the same percentage for every entry.
- `codex-switch` to the other account keeps draining the same pool.
- Logging in again under the other workspace appears to overwrite every entry.

**Cause.** The OAuth flow requests `id_token_add_organizations=true`, so the
id_token lists every organization the login belongs to. Releases before this
fix persisted one account entry per organization, but all of those entries
shared the login's single OAuth token. The Codex backend meters quota by the
`chatgpt-account-id` header and ignores organization ids, so an entry whose id
was an organization id silently fell back to the token's default subscription.
N entries, one pool.

Each workspace subscription is a distinct ChatGPT account with its own
`chatgpt_account_id` claim, so separate tokens are what produce separate quotas.

**Solutions:**

1. Upgrade to a release containing this fix. One `opencode auth login` now
   persists exactly one account, bound to the token's `chatgpt_account_id`
   claim. The workspace is chosen in the browser session during login, and
   there is no workspace prompt in the CLI or the web flow.
2. Log in once per workspace. Run `opencode auth login` and choose the first
   workspace in the browser session, then run it again and choose the second.
   Each login appends a
   separate account carrying its own token, so `codex-limits` reports the two
   subscriptions independently.
3. **Existing entries are not rewritten.** Accounts persisted by an older
   release keep their stored organization id. Requests for them are now
   redirected to the token's ChatGPT account id so they reach a real pool
   instead of being silently mis-billed, but duplicate rows left over from the
   old one-entry-per-organization behaviour remain until you remove them. For a
   clean pool, re-run `opencode auth login`, choose the fresh (not `add`) login
mode, then add the second workspace.

</details>

<details>
<summary><b>"All N account(s) failed (server errors or auth issues)"</b></summary>

**Symptoms:**
- Request loop ends with `All 14 account(s) failed ...` (count varies)
- Frequent retries, then hard failure

**Common causes:**
1. Most accounts in the pool have expired/invalid refresh tokens
2. Account pool contains duplicate stale accounts
3. Temporary upstream/server failures across all available accounts

**Solutions:**
1. Re-auth at least one known-good account first:
   ```bash
   opencode auth login
   ```
2. Check account storage health (global and project-scoped):
   - `~/.opencode/oc-codex-multi-auth-accounts.json`
   - `~/.opencode/projects/<project-key>/oc-codex-multi-auth-accounts.json`
   - `~/.opencode/oc-codex-multi-auth-flagged-accounts.json`
3. Remove obviously stale/duplicate entries and keep only verified accounts.
4. Re-run with logging and inspect per-account failures:
   ```bash
   DEBUG_CODEX_PLUGIN=1 ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "ping" --model=openai/gpt-6-sol
   ```
5. If you only need personal Plus/Pro usage, ensure login selected the intended personal workspace/account id.
6. Run guided diagnostics and safe auto-remediation:
   ```text
   codex-doctor
   codex-doctor fix=true
   ```
7. If you are onboarding or returning after a long gap, run:
   ```text
   codex-setup
   codex-setup wizard=true
   codex-next
```

</details>

<details>
<summary><b>Token Refresh Failures</b></summary>

When a stored access token expires, the plugin refreshes it with the stored refresh token. A failed refresh reports one of four reasons.

- `http_error`: the auth server returned an HTTP error, and the status code is carried along. A 4xx usually means the refresh token was revoked or expired, so re-run `opencode auth login`. A 5xx is transient, so retry later.
- `invalid_response`: the server answered but the body failed schema validation. Transient, so retry, and check upstream status if it repeats.
- `missing_refresh`: the account has no refresh token to exchange. Re-run `opencode auth login`.
- `network_error`: the request never completed (DNS, TLS, or connection failure). Check connectivity and any proxy.

A successful refresh keeps the prior refresh token when the response omits one, so a refresh never drops the stored credential on its own. `network_error`, `invalid_response`, and 5xx `http_error` are treated as transient and do not count toward permanent account removal. A 4xx `http_error` or `missing_refresh` counts as genuine auth invalidation and drives the account toward flagged storage.

</details>

---

## Model Issues

<details open>
<summary><b>Model Not Found</b></summary>

**Error.** `Model 'openai/gpt-6-sol-low' not found`

**Cause 1: Config key mismatch**

Check your config:
```json
{
  "models": {
    "gpt-6-sol-low": { ... }  // ← This is the key
  }
}
```

CLI must match exactly:
```bash
opencode run "test" --model=openai/gpt-6-sol-low  # Must match config key
```

**Cause 2: Missing provider prefix**

| Wrong | Correct |
|-------|---------|
| `--model=gpt-6-sol-low` | `--model=openai/gpt-6-sol-low` |

**Note.** `opencode models openai` currently shows only OpenCode's built-in provider catalog. If you add template-defined or custom models, use `opencode debug config` to confirm they were merged into the effective config.

**Selector note.** A compact modern (`--modern`) install exposes base OAuth families with the `--variant` presets. The default install writes no catalog, so if a selector below is missing, reinstall with `--modern`. Prefer:

```bash
opencode run "test" --model=openai/gpt-5.5 --variant=medium
```

Use explicit IDs such as `openai/gpt-5.5-medium` only after installing with `--full` or `--legacy`. If a host build rejects the bare base entry even when `opencode debug config` shows it, reinstall with `--full` rather than assuming medium IDs exist on a compact install.

</details>

<details>
<summary><b>Per-Model Options Not Applied</b></summary>

**Symptom.** All models behave the same despite different `reasoningEffort`

**Debug:**
```bash
DEBUG_CODEX_PLUGIN=1 opencode run "test" --model=openai/your-model
```

**Look for:**
```
hasModelSpecificConfig: true  ← Should be true
resolvedConfig: { reasoningEffort: 'low', ... }  ← Should show your options
```

**Common causes:**
1. Model name in CLI doesn't match config key
2. Typo in config file
3. Wrong config file location

</details>

<details>
<summary><b>"Model is not supported when using Codex with a ChatGPT account"</b></summary>

**Symptoms:**
- Request fails with an entitlement-style 400/403 mentioning model support for ChatGPT Codex OAuth
- Common after switching workspaces or selecting a model your workspace is not currently entitled to

**Cause.** The selected model is currently not entitled for the active ChatGPT account/workspace.

**Solutions:**
1. Re-auth/login to refresh workspace selection:
   ```bash
   opencode auth login
   ```
2. Add another entitled account/workspace. The plugin tries remaining accounts/workspaces before model fallback.
3. **Model works in the Codex CLI/TUI or plain opencode but not through this plugin** (typically the newest preview tier, e.g. `gpt-5.6-sol`): the backend evaluates model entitlement per client identity (`originator` + `User-Agent`). The plugin defaults GPT-5.6 tiers to the host identity (`originator: opencode`, the one plain opencode passes sol with) and everything else to the Codex CLI identity (`codex_cli_rs/<version>`; the backend gates those tiers on the catalog's `minimal_client_version`, read from the UA). By default it does not pin `openai-organization` (upstream clients don't send it; workspace routing is carried by `chatgpt-account-id`). Escape hatches:
   ```bash
   CODEX_AUTH_CLIENT_IDENTITY=codex opencode        # force the Codex CLI identity for all models
   CODEX_AUTH_CLIENT_IDENTITY=opencode opencode     # force the host identity for all models
   CODEX_AUTH_DISABLE_CODEX_USER_AGENT=1 opencode   # keep the host runtime's User-Agent
   CODEX_AUTH_CLIENT_VERSION=0.150.0 opencode       # advertise a different Codex CLI version
   CODEX_AUTH_HOST_VERSION=1.18.0 opencode          # advertise a different opencode version
   CODEX_AUTH_SEND_ORGANIZATION_HEADER=1 opencode   # restore legacy openai-organization pinning
   ```
   If the model still fails only through the plugin, run `codex-health` and compare the failing pooled account ids against the account the Codex CLI uses (`~/.codex/auth.json`).
4. Default public selectors that are commonly entitlement-gated can auto-fallback: `gpt-6-astra` degrades through `gpt-6-sol` into the GPT-5.6 tiers, the GPT-5.6 preview tiers (`gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna`) degrade down the tier chain through `gpt-5.5` to the Luna tiers, and `gpt-5.5` degrades through `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-luna`, and `gpt-5.6-luna`, while canonical `gpt-5-codex` degrades through `gpt-5.6-terra` to `gpt-5.6-luna`. GPT-5.4 and GPT-5.4 Mini were retired from Codex on 2026-08-31; the catalog marks both `visibility: "hide"` and names their replacements (`gpt-5.4` -> `gpt-6-sol`, `gpt-5.4-mini` -> `gpt-6-luna`), and `gpt-5.4-nano` has no catalog entry. The default chains therefore end at live models rather than leading with retired ones. `gpt-5.2` was removed as the terminal of every chain after openai/codex #44250 (2026-09-09) removed it from the catalog; the terminal is now `gpt-5.6-luna` (not `gpt-5.5`), since GPT-5.5 retires from Codex with ChatGPT sign-in on 2026-10-14. The Daybreak-gated cyber tiers (`gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.6-cyber`) have no chain by design: an unentitled account gets a hard failure rather than a silent substitution by a general model.
5. Enable fallback policy if you also want automatic downgrades for manual/legacy selectors (live targets `gpt-6-sol`, `gpt-5.6-terra`, `gpt-5.5`, `gpt-6-luna`, and `gpt-5.6-luna` succeed retired GPT-5.4 IDs):
   ```bash
   CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback opencode
   ```
6. Default fallback chain (auto-fallback for `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, the 5.6 tiers and `gpt-5.5`/`gpt-5-codex`; full chain when policy is `fallback` and not overridden). The general rows follow one order, most capable first (`gpt-6-astra > gpt-6-sol > gpt-5.6-sol > gpt-5.6-terra > gpt-5.5 > gpt-6-luna > gpt-5.6-luna`), and each row is that order's tail after its own model:
   - `gpt-6-astra -> gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5 -> gpt-6-luna -> gpt-5.6-luna`
   - `gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5 -> gpt-6-luna -> gpt-5.6-luna`
   - `gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5 -> gpt-6-luna -> gpt-5.6-luna`
   - `gpt-5.6-terra -> gpt-5.5 -> gpt-6-luna -> gpt-5.6-luna`
   - `gpt-5.5 -> gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-6-luna -> gpt-5.6-luna`
   - `gpt-6-luna -> gpt-5.6-luna -> gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5`
   - `gpt-5.6-luna -> gpt-6-luna -> gpt-6-sol -> gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.5`
   - `gpt-5-codex -> gpt-5.6-terra -> gpt-5.6-luna`
   - `gpt-5.4 -> gpt-6-sol -> gpt-5.6-terra -> gpt-5.6-luna` (the successor its catalog entry names)
   - `gpt-5.4-mini -> gpt-6-luna -> gpt-5.6-luna`
   - `gpt-5.4-nano -> gpt-6-luna -> gpt-5.6-luna`
   - `gpt-5.4-pro -> gpt-6-sol -> gpt-5.6-terra -> gpt-5.6-luna` (if `gpt-5.4-pro` is selected manually)
   - `gpt-5.3-codex -> gpt-5-codex -> gpt-5.2-codex`
   - `gpt-5.3-codex-spark -> gpt-5-codex -> gpt-5.3-codex -> gpt-5.2-codex` (if Spark IDs are selected manually)
   - `gpt-5.2-codex -> gpt-5-codex`
   - `gpt-5.1-codex -> gpt-5-codex`

   A single request hops across at most 6 quota-exhausted models (`MAX_QUOTA_FALLBACK_SWITCHES`, was 3), enough to reach the tail of the longest default chain (`gpt-6-astra`'s, 6 targets).
7. Configure a custom fallback chain in `~/.opencode/openai-codex-auth-config.json`:
   ```json
   {
   "unsupportedCodexPolicy": "fallback",
   "fallbackOnUnsupportedCodexModel": true,
   "unsupportedCodexFallbackChain": {
      "gpt-5.5": ["gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-5.6-luna"],
      "gpt-5.6-sol": ["gpt-5.6-terra", "gpt-5.5", "gpt-6-luna", "gpt-5.6-luna"],
      "gpt-5-codex": ["gpt-5.6-terra", "gpt-5.6-luna"],
      "gpt-5.3-codex": ["gpt-5-codex", "gpt-5.2-codex"],
      "gpt-5.3-codex-spark": ["gpt-5-codex", "gpt-5.3-codex", "gpt-5.2-codex"]
     }
   }
   ```
8. Use strict mode for explicit entitlement failures outside the default public selector auto-fallbacks:
   ```bash
   CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=strict opencode
   ```
9. Disable default-selector auto-fallbacks when you need strict entitlement failures for those selectors:
   ```bash
   CODEX_AUTH_DISABLE_GPT56_AUTO_FALLBACK=1 opencode
   CODEX_AUTH_DISABLE_GPT55_AUTO_FALLBACK=1 opencode
   CODEX_AUTH_DISABLE_CODEX_AUTO_FALLBACK=1 opencode
   ```
   Each variable only disables its own automatic default-selector fallback path (`GPT56` covers all three 5.6 tiers); explicit `unsupportedCodexPolicy: "fallback"` chains still apply.
10. Legacy compatibility toggle (only controls `gpt-5.3-codex -> gpt-5.2-codex`):
   ```bash
   CODEX_AUTH_FALLBACK_GPT53_TO_GPT52=0 opencode
   ```
11. Legacy generic fallback toggle compatibility:
   ```bash
   CODEX_AUTH_FALLBACK_UNSUPPORTED_MODEL=1 opencode
   ```
12. Verify effective upstream model when debugging Spark/fallback behavior:
   ```bash
   ENABLE_PLUGIN_REQUEST_LOGGING=1 CODEX_PLUGIN_LOG_BODIES=1 opencode run "ping" --model=openai/gpt-5.3-codex-spark
   ```
   Then inspect `~/.opencode/logs/codex-plugin/request-*-after-transform.json` (`.body.model`). The TUI can keep showing the selected label while fallback is applied internally.

</details>

---

## Multi-Turn Issues

<details open>
<summary><b>Item Not Found Errors</b></summary>

**Error:**
```
AI_APICallError: Item with id 'msg_abc123' not found.
Items are not persisted when `store` is set to false.
```

**Cause.** Old plugin version (fixed in v2.1.2+)

**Solution:**
```bash
npx -y oc-codex-multi-auth@latest
opencode
```

**Verify fix:**
```bash
DEBUG_CODEX_PLUGIN=1 opencode
> write test.txt
> read test.txt
> what did you write?
```

Should see: `Successfully removed all X message IDs`

</details>

<details>
<summary><b>Context Not Preserved</b></summary>

**Symptom.** Model doesn't remember previous turns

**Check logs:**
```bash
ENABLE_PLUGIN_REQUEST_LOGGING=1 CODEX_PLUGIN_LOG_BODIES=1 opencode
> first message
> second message
```

**Verify:**
```bash
cat ~/.opencode/logs/codex-plugin/request-*-after-transform.json | jq '.body.input | length'
# Should show increasing count (3, 5, 7, 9, ...)
```

**What to check:**
1. Full message history present (not just current turn)
2. No `item_reference` items (filtered out)
3. All IDs stripped

</details>

---

## Request Errors

<details open>
<summary><b>400 Bad Request</b></summary>

**Debug:**
```bash
ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "test"
cat ~/.opencode/logs/codex-plugin/request-*-error-response.json
```

**Common causes:**
1. Invalid options for model (e.g., `minimal` for gpt-6-sol)
2. Malformed request body
3. Unsupported parameter

</details>

<details>
<summary><b>Rate Limit Exceeded</b></summary>

**Error:**
```
Rate limit reached for gpt-6-sol
```

**Solutions:**

1. **Wait for reset:**
   ```bash
   cat ~/.opencode/logs/codex-plugin/request-*-response.json | jq '.headers["x-codex-primary-reset-after-seconds"]'
   ```

2. **Add more accounts:**
   ```bash
   opencode auth login  # Add another account
   ```

3. **Switch model family:**
   ```bash
   opencode run "task" --model=openai/gpt-5.1
   ```

</details>

<details>
<summary><b>Context Window Exceeded</b></summary>

**Error:**
```
Your input exceeds the context window
```

**Solutions:**
1. Exit and restart OpenCode (clears history)
2. Use compact mode (if OpenCode supports it)
3. Switch to model with larger context

</details>

<details>
<summary><b>Account command says "Missing account number"</b></summary>

**Symptoms:**
- `codex-switch`, `codex-label`, or `codex-remove` returns a missing index message
- You expected an interactive picker

**Cause.** Interactive pickers require an interactive TTY session. In non-interactive sessions, you must pass `index`.

**Solutions:**
1. Pass explicit index arguments:
   ```text
   codex-switch index=2
   codex-label index=2 label="Work"
   codex-remove index=2 confirm=true
   ```
2. Run from an interactive terminal when you want picker menus.
3. Use `codex-list` first to inspect valid index range.

</details>

<details>
<summary><b>Account storage is unreadable or accounts disappear between sessions</b></summary>

Multiple sessions can share the same account file. A background save now preserves accounts added by another session, and authentication failures disable accounts without deleting their credentials. Check `codex-list` for disabled accounts before logging in again.

If the existing JSON file is corrupt, account loads and transactional writes fail instead of silently creating a smaller pool. Quit all OpenCode sessions, keep a copy of the corrupt file for diagnosis, then move it aside. Start OpenCode and preview the newest valid `backups/codex-credential-snapshot-*.json` with `codex-import path="..." dryRun=true` before importing. Snapshots contain refresh tokens; do not share them. A token already rotated after the snapshot may need a fresh login.

</details>

<details>
<summary><b>Import concerns: accidental overwrite or bad backup file</b></summary>

**Recommended safe flow:**
1. Preview first:
   ```text
   codex-import path="~/backup/accounts.json" dryRun=true
   ```
2. Apply only after preview:
   ```text
   codex-import path="~/backup/accounts.json"
   ```
3. Before apply, the plugin creates a timestamped pre-import backup when existing accounts are present.
4. Use `codex-export` with no path to create timestamped backups in the storage-adjacent `backups/` directory.

</details>

---

## OAuth Callback Issues

<details>
<summary><b>Safari OAuth Callback Fails (macOS)</b></summary>

**Symptoms:**
- "fail to authorize" after successful login
- Safari shows "Safari can't open the page"

**Cause.** Safari's "HTTPS-Only Mode" blocks `http://localhost` callback.

**Solutions:**

1. **Use Chrome or Firefox** (easiest)

2. **Disable HTTPS-Only Mode temporarily:**
   - Safari > Settings (⌘,) > Privacy
   - Uncheck "Enable HTTPS-Only Mode"
   - Run `opencode auth login`
   - Re-enable after authentication

</details>

<details>
<summary><b>Port Conflict (Address Already in Use)</b></summary>

Login fails fast when the callback port cannot be bound. The error message is:

```
OAuth callback server failed to start on localhost loopback port 1455. Retry with "Codex OAuth (Device Code)" or "Codex OAuth (Manual URL Paste)".
```

No browser is opened and no URL is printed in that case. Free port 1455, then retry `opencode auth login`. Device Code and Manual URL Paste avoid the loopback listener entirely.

**macOS / Linux:**
```bash
lsof -i :1455
kill -9 <PID>
opencode auth login
```

**Windows (PowerShell):**
```powershell
netstat -ano | findstr :1455
taskkill /PID <PID> /F
opencode auth login
```

</details>

<details>
<summary><b>Docker / WSL2 / Remote Development</b></summary>

OAuth callback requires browser to reach `localhost` on the machine running OpenCode. The plugin listens on both `127.0.0.1:1455` and `[::1]:1455` so Windows/macOS/Linux dual-stack localhost resolution can complete the redirect.

**WSL2:**
- Use VS Code's port forwarding, or
- Configure Windows → WSL port forwarding

**SSH / Remote:**
```bash
ssh -L 1455:localhost:1455 user@remote
```

**Docker / Containers:**
- OAuth with localhost redirect doesn't work in containers
- Use Device Code first, then SSH port forwarding or manual URL flow if needed

</details>

---

## Rotation, Recovery, and Notifications

<details open>
<summary><b>Circuit-open account rotations</b></summary>

The plugin keeps a circuit breaker per account and model family in the runtime request pipeline (`lib/circuit-breaker.ts` keyed via `index.ts:2713-2724`). Three failures inside a 60-second window open the circuit for a 30-second cooldown. While it is open, requests short-circuit to the next account instead of retrying the degraded one, and the log line reads `[circuit-breaker] Circuit open ... Rotating account.` After the cooldown the circuit admits a single probe request. A successful probe closes the circuit, and a failed probe reopens it. No action is required. If one account rotates constantly, run `codex-health` to verify its refresh token and `codex-diag` for the breaker aggregates. (Note that standalone `lib/health.ts` defines an isolated breaker instance for diagnostic summaries, whereas active request routing wires its breaker directly in `index.ts`).

</details>

<details>
<summary><b>Recovery toasts in the OpenCode TUI</b></summary>

Recoverable request errors (a missing tool result, an out-of-order thinking block, or a thinking-mode violation) surface a warning toast in the OpenCode TUI. Warning and error toasts are always shown. The informational "Using &lt;account&gt; (N/N)" account-selection toast is the only one a setting controls, via `accountToasts` in plugin config or `CODEX_AUTH_ACCOUNT_TOASTS=0`. Toast duration follows `toastDurationMs` in plugin config or `CODEX_AUTH_TOAST_DURATION_MS` (default 5000 ms, minimum 1000 ms). While `lib/recovery/hook.ts` contains an underlying session repair and auto-resume engine, runtime requests in `index.ts` currently surface the warning toast without executing host session mutation hooks.

</details>

<details>
<summary><b>macOS quota notifications</b></summary>

On macOS the plugin can post Notification Center alerts when account usage crosses a configured percentage threshold. Control it with the `quotaNotifications` plugin config block: `enabled` turns delivery on, `thresholds` lists percentages (0-100), `intervalMs` sets the poll interval (minimum 30000), and `autoProtectCredits` (default on) also records a durable quota block when usage is exhausted. Delivery runs through `osascript`, so Linux and Windows stay silent. Cross-process state lives in `oc-codex-multi-auth-quota-notifications.json` beside the active accounts file.

</details>

---

## Debug Techniques

<details open>
<summary><b>Enable Full Logging</b></summary>

```bash
DEBUG_CODEX_PLUGIN=1 ENABLE_PLUGIN_REQUEST_LOGGING=1 CODEX_PLUGIN_LOG_BODIES=1 opencode run "test"
```

**What you get:**
- Console: Debug messages showing config resolution
- Files: Request/response metadata logs
- Files: Raw payloads included because `CODEX_PLUGIN_LOG_BODIES=1` is set (sensitive)

**Log locations:**
- `~/.opencode/logs/codex-plugin/request-*-before-transform.json`
- `~/.opencode/logs/codex-plugin/request-*-after-transform.json`
- `~/.opencode/logs/codex-plugin/request-*-response.json`

</details>

<details>
<summary><b>Inspect Actual API Requests</b></summary>

```bash
ENABLE_PLUGIN_REQUEST_LOGGING=1 CODEX_PLUGIN_LOG_BODIES=1 opencode run "test" --model=openai/gpt-5.5 --variant=medium

cat ~/.opencode/logs/codex-plugin/request-*-after-transform.json | jq '{
  model: .body.model,
  reasoning: .body.reasoning,
  text: .body.text,
  store: .body.store,
  include: .body.include
}'
```

**Verify:**
- `model`: Normalized correctly?
- `reasoning.effort`: Matches your config?
- `store`: Should be `false`
- `include`: Should have `reasoning.encrypted_content`

</details>

---

## Getting Help

### Before Opening an Issue

1. **Enable logging:**
   ```bash
   DEBUG_CODEX_PLUGIN=1 ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "your command"
   ```

2. **Collect info:**
   - OpenCode version: `opencode --version`
   - Plugin version: Check `package.json` or npm
   - Error logs from `~/.opencode/logs/codex-plugin/`
   - Config file (redact sensitive info)

3. **Check existing issues:**
   [GitHub Issues](https://github.com/ndycode/oc-codex-multi-auth/issues)

### Reporting Bugs

Include:
- Error message
- Steps to reproduce
- Config file (redacted)
- Log files
- OpenCode version
- Plugin version

### Account or Subscription Issues

| Issue | Solution |
|-------|----------|
| Auth problems | Verify subscription at [ChatGPT Settings](https://chatgpt.com/settings) |
| Free tier | Not supported, requires Plus or Pro |
| Usage limits | Check subscription limits |
| Account flagged | Contact OpenAI support |

**To revoke and re-authorize:**
1. Revoke: [ChatGPT Settings → Authorized Apps](https://chatgpt.com/settings/apps)
2. Remove tokens: `opencode auth logout`
3. Re-authenticate: `opencode auth login`

---

**Next.** [Configuration Guide](configuration.md) | [Architecture](development/ARCHITECTURE.md) | [Back to Home](index.md)

# Troubleshooting

Common setup, authentication, model, and request-debugging issues for `oc-codex-multi-auth`.

---

> **Quick Reset**: Most issues can be resolved by deleting `~/.opencode/auth/openai.json` and running `opencode auth login` again.

If you prefer guided recovery before manual debugging, run:

```text
codex-setup
codex-doctor
codex-doctor --fix
codex-next
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

**Status:** Fixed in v4.9.0 by renaming the package.

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
   ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "test" --model=openai/gpt-5.5-medium
   ```
4. **Check registry access**:
   ```bash
   npm view oc-codex-multi-auth version
   ```
5. **If the plugin is present but still won’t load**, rerun `npx -y oc-codex-multi-auth@latest` so the installer refreshes the config and clears OpenCode's cached plugin copy.

</details>

---

## Performance & Latency

<details open>
<summary><b>Slow first response / startup latency</b></summary>

**What’s normal:**
- The first request may fetch **Codex instructions** and/or the **OpenCode codex prompt** from GitHub.
- Current releases use **stale-while-revalidate caching** and a **startup prewarm** to reduce first-turn latency.

**Tuning knobs:**
1. Disable prewarm (if you prefer zero background fetches at startup):
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

   Re-auth is required for accounts created before `api.connectors.read` and `api.connectors.invoke` were requested; stale account records are marked inactive until they are refreshed through login.

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

1. **Manual URL paste:**
   - Re-run `opencode auth login`
   - Select **"Codex OAuth (Device Code)"** first if you are on SSH, WSL, or a headless machine
   - If device code is unavailable, fall back to **"Codex OAuth (Manual URL Paste)"**
   - Paste the full redirect URL after login when using the manual flow

2. **Check port 1455 availability:**
   ```bash
   # macOS/Linux
   lsof -i :1455
   
   # Windows
   netstat -ano | findstr :1455
   ```

3. **Stop Codex CLI if running** — both use port 1455

</details>

<details>
<summary><b>Authorization Session Expired</b></summary>

**Symptoms:**
- Browser shows: `Your authorization session was not initialized or has expired`

**Solutions:**
- Re-run `opencode auth login` to generate a fresh URL
- Open the URL directly in browser (don't use a stale link)
- For SSH/WSL/remote, use **"Device Code"** first, then **"Manual URL Paste"** if needed

</details>

<details>
<summary><b>403 Forbidden Error</b></summary>

**Cause:** ChatGPT subscription issue

**Check:**
1. Active ChatGPT Plus or Pro subscription
2. Subscription not expired
3. Billing is current

**Solution:** Visit [ChatGPT](https://chatgpt.com) and verify subscription status

</details>

<details>
<summary><b>"Usage not included in your plan"</b></summary>

**Symptoms:**
- Requests fail with: `Usage not included in your plan`
- Often reported on Business/Team workspaces

**Cause:** The plugin is using the wrong workspace/account id (personal vs business).

**Solutions:**
1. Upgrade to the current release of `oc-codex-multi-auth` (workspace routing logic was hardened for Business + Personal dual accounts in the 5.x line and renamed in 6.0.0).
2. Re-run `opencode auth login` and select the correct workspace when prompted.
3. If running non-interactively, set `CODEX_AUTH_ACCOUNT_ID` to the workspace account id and re-login.
4. Verify the workspace has Codex access in the ChatGPT UI.

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
   DEBUG_CODEX_PLUGIN=1 ENABLE_PLUGIN_REQUEST_LOGGING=1 opencode run "ping" --model=openai/gpt-5-codex
   ```
5. If you only need personal Plus/Pro usage, ensure login selected the intended personal workspace/account id.
6. Run guided diagnostics and safe auto-remediation:
   ```text
   codex-doctor
   codex-doctor --fix
   ```
7. If you are onboarding or returning after a long gap, run:
   ```text
   codex-setup
   codex-setup --wizard
   codex-next
```

</details>

---

## Model Issues

<details open>
<summary><b>Model Not Found</b></summary>

**Error:** `Model 'openai/gpt-5-codex-low' not found`

**Cause 1: Config key mismatch**

Check your config:
```json
{
  "models": {
    "gpt-5-codex-low": { ... }  // ← This is the key
  }
}
```

CLI must match exactly:
```bash
opencode run "test" --model=openai/gpt-5-codex-low  # Must match config key
```

**Cause 2: Missing provider prefix**

| Wrong | Correct |
|-------|---------|
| `--model=gpt-5-codex-low` | `--model=openai/gpt-5-codex-low` |

**Note:** `opencode models openai` currently shows only OpenCode's built-in provider catalog. If you add template-defined or custom models, use `opencode debug config` to confirm they were merged into the effective config.

**GPT-5.5 note:** on tested OpenCode `1.14.22`, bare `openai/gpt-5.5` can still fail with `ProviderModelNotFoundError` even when the base template entry exists. Use explicit shipped IDs like `openai/gpt-5.5-medium` or `openai/gpt-5.5-high` for current live CLI tests.

</details>

<details>
<summary><b>Per-Model Options Not Applied</b></summary>

**Symptom:** All models behave the same despite different `reasoningEffort`

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

**Cause:** The selected model is currently not entitled for the active ChatGPT account/workspace.

**Solutions:**
1. Re-auth/login to refresh workspace selection:
   ```bash
   opencode auth login
   ```
2. Add another entitled account/workspace. The plugin tries remaining accounts/workspaces before model fallback.
3. **Model works in the Codex CLI/TUI but not through this plugin** (typically the newest preview tier, e.g. `gpt-5.6-sol`): the plugin now sends the same client identity Codex does — a `codex_cli_rs/<version>` `User-Agent` (the backend gates preview tiers on the catalog's `minimal_client_version`, read from the UA) — and no longer pins `openai-organization` (upstream Codex never sends it; workspace routing is carried by `chatgpt-account-id`, and org pinning could shift entitlement evaluation to a workspace outside the preview). Escape hatches if your setup relied on the old behavior:
   ```bash
   CODEX_AUTH_DISABLE_CODEX_USER_AGENT=1 opencode   # keep the host runtime's User-Agent
   CODEX_AUTH_CLIENT_VERSION=0.150.0 opencode       # advertise a different Codex CLI version
   CODEX_AUTH_SEND_ORGANIZATION_HEADER=1 opencode   # restore legacy openai-organization pinning
   ```
   If the model still fails only through the plugin, run `codex-health` and compare the failing pooled account ids against the account the Codex CLI uses (`~/.codex/auth.json`).
4. Default public selectors that are commonly entitlement-gated can auto-fallback: the GPT-5.6 preview tiers (`gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna`) degrade down the tier chain to `gpt-5.5`, and `gpt-5.5`/canonical `gpt-5-codex` degrade through `gpt-5.4`, `gpt-5.4-mini`, then `gpt-5.4-nano`.
5. Enable fallback policy if you also want automatic downgrades for manual/legacy selectors:
   ```bash
   CODEX_AUTH_UNSUPPORTED_MODEL_POLICY=fallback opencode
   ```
6. Default fallback chain (auto-fallback for the 5.6 tiers and `gpt-5.5`/`gpt-5-codex`; full chain when policy is `fallback` and not overridden):
   - `gpt-5.6-sol -> gpt-5.6-terra -> gpt-5.6-luna -> gpt-5.5` (then the `gpt-5.5` chain below)
   - `gpt-5.5 -> gpt-5.4 -> gpt-5.4-mini -> gpt-5.4-nano`
   - `gpt-5-codex -> gpt-5.4 -> gpt-5.4-mini -> gpt-5.4-nano`
   - `gpt-5.4-pro -> gpt-5.4` (if `gpt-5.4-pro` is selected manually)
   - `gpt-5.3-codex -> gpt-5-codex -> gpt-5.2-codex`
   - `gpt-5.3-codex-spark -> gpt-5-codex -> gpt-5.3-codex -> gpt-5.2-codex` (if Spark IDs are selected manually)
   - `gpt-5.2-codex -> gpt-5-codex`
   - `gpt-5.1-codex -> gpt-5-codex`
7. Configure a custom fallback chain in `~/.opencode/openai-codex-auth-config.json`:
   ```json
   {
   "unsupportedCodexPolicy": "fallback",
   "fallbackOnUnsupportedCodexModel": true,
   "unsupportedCodexFallbackChain": {
      "gpt-5.5": ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
      "gpt-5.4": ["gpt-5.4-mini", "gpt-5.4-nano"],
      "gpt-5.4-pro": ["gpt-5.4"],
      "gpt-5-codex": ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
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

**Cause:** Old plugin version (fixed in v2.1.2+)

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

**Symptom:** Model doesn't remember previous turns

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
1. Invalid options for model (e.g., `minimal` for gpt-5-codex)
2. Malformed request body
3. Unsupported parameter

</details>

<details>
<summary><b>Rate Limit Exceeded</b></summary>

**Error:**
```
Rate limit reached for gpt-5-codex
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

**Cause:** Interactive pickers require an interactive TTY session. In non-interactive sessions, you must pass `index`.

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

**Cause:** Safari's "HTTPS-Only Mode" blocks `http://localhost` callback.

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
ENABLE_PLUGIN_REQUEST_LOGGING=1 CODEX_PLUGIN_LOG_BODIES=1 opencode run "test" --model=openai/gpt-5.5-medium

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
| Free tier | Not supported — requires Plus or Pro |
| Usage limits | Check subscription limits |
| Account flagged | Contact OpenAI support |

**To revoke and re-authorize:**
1. Revoke: [ChatGPT Settings → Authorized Apps](https://chatgpt.com/settings/apps)
2. Remove tokens: `opencode auth logout`
3. Re-authenticate: `opencode auth login`

---

**Next**: [Configuration Guide](configuration.md) | [Architecture](development/ARCHITECTURE.md) | [Back to Home](index.md)

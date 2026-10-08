# Custom JavaScript account rotation

Custom policies are opt-in **trusted code, not sandboxed code**. They run as your
OS user and can read files (including credentials), launch processes, and use the
network with your user's permissions. Review the module and its dependencies;
do not use a policy supplied by an untrusted project. The host does not pass
credentials to the policy. Removing them from the input is not a filesystem or
network security boundary.

Put your policy at `~/.opencode/rotation/my-policy.mjs` (recommended). Set its
**absolute, expanded** path in `~/.opencode/openai-codex-auth-config.json`:

```json
{
  "rotationStrategy": "custom",
  "customRotation": { "module": "/Users/you/.opencode/rotation/my-policy.mjs" }
}
```

Restart OpenCode. There is no project autodiscovery and no expansion of `~`.
`CODEX_AUTH_ROTATION_STRATEGY=custom` also selects this strategy. A missing or
failed policy uses only currently eligible host fallback accounts.

## Contract, version 1

Export a named `select` function from an `.mjs` file. It may return a Promise.
JSDoc types are available from `oc-codex-multi-auth/rotation`:

```js
/** @type {import('oc-codex-multi-auth/rotation').RotationSelect} */
export function select({ version, now, model, currentAccountId, accounts }) {
  return accounts.find((account) => account.id === currentAccountId)?.id
    ?? accounts[0]?.id ?? null;
}
```

`now` is epoch milliseconds; `model` is the effective model or null. Return one
of `accounts[].id`, or null to delegate to the eligible host fallback. IDs are
opaque, stable within the storage scope and seat identity, and distinct across
Business seats and projects. Do not interpret them as ChatGPT workspace IDs.
The current ID can be absent from the eligible array. Credentials, account emails,
labels, raw workspace IDs, prompt/response bodies and reset-credit IDs are absent.

Host filtering precedes policy execution: strict/preferred model pools, enabled
state, cooldowns, server rate limits, local token buckets and request exclusions
all apply. Preferred pools fall back to general eligible accounts only when no
pooled accounts are selectable. Strict pools never escape their pool. Eligibility
is recomputed after the asynchronous policy returns. Null, errors, unknown IDs or
newly blocked selections use the first currently eligible account in storage
order; they **never** use hybrid's whole-pool-blocked fallback. An empty eligible
array skips the script entirely.

Each invocation imports the policy in a fresh Node child. Import and selection
share a 1-second deadline (including synchronous loops). Up to four policy
children run concurrently; excess calls use eligible fallback. Input is bounded
to 1 MiB; combined stdout, stderr and result protocol to 64 KiB. The child receives
no inherited Node loader/preload arguments, `NODE_OPTIONS`, HOME or tokens. On
completion, cancellation or timeout the host attempts to kill the POSIX process
group or Windows process tree (`taskkill /T /F`). Teardown settles within an
additional 250 ms even if descendants retain pipes or the Windows helper fails;
failed tree termination can leave descendants alive. Deliberately escaping the
group/tree or exiting the worker directly is outside this trusted-code contract.
Policies should be pure, fast, and avoid output and side
effects. There is no in-process policy cache or persistent script state.

## Observations

Each account contains `lastUsed`, `plan`, `primary`, `secondary`, `credits`, and
`resetCredits`. Each window has `usedPercent`, `resetAtMs`, and `windowMinutes`.
Each observation field carries `value`, `status`, `observedAt`, `expiresAt`,
`source` and `scope`. Status is `unknown`, `fresh`, `stale`, or `not-applicable`.
Unknown values are null, never invented zeros. A plan-disabled window is
not-applicable. Sources are `usage`, `headers`, `reset-list` or null; scope is
`seat`, `workspace` or `unknown` (unknown means the endpoint's finer scope is not
proven, not that seats are merged). Timestamps are epoch milliseconds.

Only custom mode starts initial background observation polling. Usage and credits
refresh every 5 minutes; reset-credit listings every 30 minutes. Authoritative
passive response headers update only the reported quota fields. An older usage
request cannot overwrite a newer header observation. Freshness expires at those
intervals; stale values remain visible but should not be treated as fresh quota.
Observation polling is informational: existing authoritative routing guards still
decide eligibility, and observation failures do not invent quota or block seats.

Credits have `{ balance: string | null, unlimited: boolean }`; balances are not
converted to numbers. Reset credits expose only an available count. **Custom
rotation never redeems a reset credit.** An explicit `codex-reset` redemption
invalidates observations and schedules refresh. Polling deduplicates seat
identities, limits concurrency to two accounts, backs off failed requests, aborts
usage/reset HTTP work at shutdown and discards results after disposal or storage
scope changes. Coordinated credential refresh is allowed to finish its durable
commit; a persisted rotation invalidates the cached account manager immediately.

See [the example policy](../assets/rotation/my-policy.mjs) for fresh-quota selection.

## Offline validation

```bash
oc-codex-multi-auth rotation validate /absolute/my-policy.mjs --json
oc-codex-multi-auth rotation validate --fixtures /absolute/cases.json --json
```

Omit the module to read `customRotation.module` from plugin configuration. This
command dispatches before any account-storage read. It runs synthetic empty,
single-seat, unknown, fresh/stale and not-applicable/unlimited cases, plus optional
user scenarios. It does not load user accounts or call usage/reset endpoints;
the trusted policy itself retains normal OS permissions.

Fixture format (omitted observation fields default to unknown):

```json
{
  "scenarios": [{
    "name": "prefer-current",
    "input": {
      "version": 1,
      "now": 1800000000000,
      "model": "gpt-5.6-sol",
      "currentAccountId": "seat-b",
      "accounts": [{ "id": "seat-a" }, { "id": "seat-b" }]
    },
    "expectedAccountId": "seat-b"
  }]
}
```

An optional `expectedAccountId` asserts a specific result (null is meaningful).
Without it, any eligible ID or null passes. Fixtures are at most 1 MiB, 100
scenarios and 1,000 accounts per scenario; duplicate IDs and unknown fields fail
parsing. Exit codes: **0** all pass, **1** policy/protocol/deadline/expectation
failure, **2** usage/configuration/fixture failure. JSON output reports each case
without including script stdout/stderr or thrown error messages.

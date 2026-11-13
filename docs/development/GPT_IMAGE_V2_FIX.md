# GPT Image / OpenCode V2 fix

## Scope and reproduction

Originally reproduced against release **6.30.0** (`341f0624acb8437cb455d38ce4c2e42926e1301c`), branch
`fix/v2-native-images`. Sources are in `lib/opencode-v2.ts`; `dist/` is generated
only by the build. The installed plugin cache, user configuration, credentials
and the existing local workaround have not been changed by this patch.

Contract checked against the OpenCode V2 server-plugin documentation and the
installed SDKs, including the native OpenAI image protocol from 2.2.7:

- <https://opencode.ai/docs/build/plugins/server>
- <https://opencode.ai/docs/providers>

Before the change, the regression in `test/opencode-v2-images.test.ts` failed:
the image model's package was `aisdk:.../opencode-v2-provider.ts`. Both the
provider-level source transform and the model transform assigned the chat-only
adapter indiscriminately. No real image request was used for reproduction.

### Earlier manual observation (not an end-to-end test of this patch)

Before this source patch, the reporter successfully edited an image with GPT
Image 2 on OpenCode 2.2.7 using a separate local routing workaround: native
`@opencode/ai/providers/openai/images` with
`https://chatgpt.com/backend-api/codex`. This demonstrates that the subscription
route can work for that connection/model combination. It does not establish
availability for other accounts, newer image models, or this complete source
patch. No photographs or real credentials are included in the reproduction.

Using the generic `@opencode/ai/providers/openai` entrypoint instead returns
"has no image API". A Codex OAuth scope error on `https://api.openai.com/v1`
does not establish that the ChatGPT/Codex subscription route is unavailable.

## Changes

- Provider defaults stay native. Only supported Codex chat models receive the
  existing AI SDK adapter; both AI SDK hooks check model type/family. The V1
  loader inventory excludes non-chat models.
- Images use `@opencode/ai/providers/openai/images` on supported V2 hosts, not
  the generic OpenAI chat entrypoint. Recognized Codex OAuth selects
  `https://chatgpt.com/backend-api/codex` for the model and its variants.
- Explicit API-key and other OAuth connections take precedence over the Codex
  pool and retain their native endpoint/auth contract. No error path changes
  the billing route or asks for an API key.
- Native image auth/refresh remains owned by the host's selected connection.
  The matching account header and user headers are retained. Chat pool
  selection, coordinated refresh, SDK factory and body shaping remain shared
  with the existing V1 runtime; image requests never enter that pipeline.
- Connection/credential/integration events serialize routing reloads. Transforms
  rebuild from fresh source state, including catalog refreshes, without storing
  tokens in transforms or diagnostics.
- Model IDs are unchanged. GPT Image 2 is known-supported; additional image
  models need an enabled, authoritative inventory scoped to the selected
  connection. Custom native protocols and future model types are preserved.
- A dev-only alias pins the real 2.2.7 image protocol for network-free contract
  tests. The lockfile also repairs pre-existing `seroval` override resolution
  that initially prevented `npm ci`; other dependency versions are unchanged.

## Verification

No quota-consuming generation/edit requests were made for this task. All new
HTTP tests use a fake executor and fixture credentials. Test homes are isolated
by the repository's Vitest configuration. Unless stated otherwise, the results
below are for the original 6.30.0-based working tree, not the complete upstream
main tree.

- `npm ci --ignore-scripts --no-audit --no-fund`: passed (Node 22.19.0).
- `npm run typecheck`: passed against the locked `@opencode/plugin` 2.0.18.
- TypeScript check with SDK paths mapped to an isolated
  `@opencode/plugin` 2.2.7 installation: passed.
- `npm run build`: passed; `npm run lint`: passed.
- Current focused V2, native-image, rotation, account, refresh-coordination,
  runtime, invalidation and documentation suites: **10 files, 609 tests passed**.
- Full suite with `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 TZ=UTC`, two workers:
  **5300 passed, 3 failed, 1 pre-existing skipped test**. The full suite is not
  green. Remaining failures are the timezone-sensitive `Date.parse("-1")`
  characterization and rolled-back-clock transaction-lease test in
  `time-skew.test.ts`, and the exact health-score clamp assertion in
  `rotation.test.ts` (a very small nonzero score versus zero).
- Baseline comparison on untouched 6.30.0 source, same locale/timezone:
  rotation/time-skew suites yielded **167 passed, 1 failed**. The date-parse
  failure reproduced; the two other full-run failures did not reproduce in
  that focused baseline run. Rotation passed in the focused patched run too.
  These remaining failures have not been fixed or hidden by this patch and
  are not asserted to be conclusively diagnosed regressions/non-regressions.
- Patch application to upstream main
  `0018a7a93a7ffae65f20a71dad8212fa721d9c7c` was checked locally. The affected
  `opencode-v2.ts` and `opencode-v2-provider.ts` sources are unchanged there
  relative to the reproduction base. On that patched
  upstream snapshot, **5 V2/documentation suites, 101 tests passed**, as did
  typecheck and build. The full upstream suite was not run. Documentation avoids
  pinning a historical release as though it were the current version.

## Remaining boundaries

- Native images use the selected OpenCode connection, not the chat pool's
  automatic request rotation. Pool-only setups and older V2 hosts disable Codex
  images rather than falling back to a paid API/environment credential.
- An unresolved selected connection also disables native images rather than
  treating it as API-key mode or using an environment credential.
- New GPT Image entitlements are not inferred from the model name or generic
  catalog. Real availability still depends on the selected connection.
- No live host/model call or production installation was performed. Deployment
  should replace the published plugin with this build and remove the separate
  local image workaround in a coordinated, user-approved configuration change.

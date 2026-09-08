# Sentry Error Reporting Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add optional, privacy-conservative, fail-open Sentry error reporting without changing application outcomes, accounting, retries, or deployment safety.

**Architecture:** A small policy module chooses raw versus official Sentry Worker/DO execution, safely reports finite categories, and rebuilds outbound events from a nested allowlist. Explicit first-owner reporters cover swallowed route, registry, settlement, outbox, Queue, and backup faults; official SDK instrumentation covers enabled escaping faults. React gets one coordinated root boundary; build scripts distinguish browser maps from Wrangler Worker maps.

**Tech Stack:** TypeScript, Vitest/`@cloudflare/vitest-pool-workers`, Cloudflare Workers/Durable Objects/D1/Queue/R2, React 19, Vite, `@sentry/cloudflare`, `@sentry/react`, `@sentry/vite-plugin`, and one local DOM test environment.

---

## Guardrails

* Follow TDD for every behavior change: write the focused failure, observe it fail, implement the minimum, rerun it.
* Do not run e2e, access credentials, deploy, commit, push, merge, add a crash endpoint, or change business behavior.
* Reporting is not awaited on a command/alarm/Queue/backup critical path and never receives original application data.
* Do not instrument broad application paths until Task 1 proves the installed SDK can meet the no-init Durable Object requirement in Miniflare. Stop for parent review if it cannot.
* Parent controls commits and review; do not commit while executing this plan.
* Register `tests/worker/sentry-lifecycle.test.ts`, `tests/worker/sentry-privacy.test.ts`, and `tests/worker/sentry-scheduled.test.ts` explicitly in `workerTests`; keep `node` exclusions derived from that same list. Focused Workers commands and `npm test` must execute each exactly once, while `npm test` also includes the separate `web` project exactly once.

### Task 1: Prove official SDK lifecycle and Durable Object compatibility first

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vitest.config.ts`
- Modify: `tests/fixtures/wrangler.vitest.jsonc`
- Create: `src/observability/sentry-server.ts`
- Create: `tests/worker/sentry-lifecycle.test.ts`
- Modify: `src/index.ts`
- Modify: `src/durable/pool-do.ts`

**Step 1: Inspect public APIs without credentials.**

Run `npm pack @sentry/cloudflare@<resolved-version>` into `/tmp`; inspect `withSentry`, `instrumentDurableObjectWithSentry`, transport/options, and DO construction declarations. Record the resolved version and selected supported construction route in the test comment. This is a blocking compatibility check, not app instrumentation.

**Step 2: Bootstrap dependencies and test registration.**

Add exact lockfile-pinned runtime `@sentry/cloudflare`/`@sentry/react`, dev `@sentry/vite-plugin`, and one DOM test dependency. Explicitly register all three Workers files — `sentry-lifecycle.test.ts`, `sentry-privacy.test.ts`, and `sentry-scheduled.test.ts` — in `workerTests`; preserve node exclusions derived from `workerTests`. Add only fake nonsecret DSN bindings. Do not add a DSN, source-map token, custom production transport, or runtime config value.

**Step 3: Write the failing raw/enabled lifecycle tests.**

Create a raw Worker and `PoolDOBase` counter through the same boundary factory production will use. Test blank/absent/malformed DSN; actual SDK enabled capture via in-memory transport; and a business command that commits once.

```ts
it("bypasses SDK construction and executes disabled Worker/DO work once", async () => {
  const calls = { handler: 0, sdkFactory: 0, transport: 0 };
  const boundary = createServerSentryBoundary({ sdkFactory: countedSdk(calls) });

  await boundary.wrapWorker(rawWorker(calls)).fetch!(request, { SENTRY_DSN: " " }, ctx);
  await boundary.constructDurableObject(PoolDOBase, state, { SENTRY_DSN: undefined }).alarm();

  expect(calls).toEqual({ handler: 1, sdkFactory: 0, transport: 0 });
});
```

Run:

```sh
./node_modules/.bin/vitest run --project=workers tests/worker/sentry-lifecycle.test.ts
```

Expected: FAIL because the conditional raw/enabled boundary does not exist.

**Step 4: Implement the smallest official-SDK boundary.**

In `sentry-server.ts`, add conservative DSN validation, finite options, raw/enabled one-way Worker dispatch, and a test-only official options/transport seam. In `index.ts`, invoke exactly one raw or enabled handler method. No fallback may run a business handler after enabled execution starts.

Rename the business implementation to `PoolDOBase` only if required. Implement the SDK route demonstrated by Step 1: disabled construction must instantiate the base before any SDK call; enabled construction uses `instrumentDurableObjectWithSentry`; exported Wrangler class name/method surface stays unchanged. Do not assume `enabled: false` is a bypass.

**Step 5: Prove observability failure isolation.**

Add failing-then-passing cases for SDK init failure, synchronous safe-capture failure, rejected transport, and never-settling transport. Assert original fetch response, single business invocation, DO command replay/transaction state, alarm deadline, Queue decision, and backup continuation are unchanged. Do not use timeout races: prove the business promise resolves without awaiting the stalled transport.

Run the focused test again. Expected: PASS.

### Task 2: Implement strict sanitization, deterministic fingerprints, and one-run web test coverage

**Files:**
- Create: `src/observability/sentry-sanitize.ts`
- Modify: `src/observability/sentry-server.ts`
- Create: `src/web/sentry.ts`
- Create: `tests/worker/sentry-privacy.test.ts`
- Create: `tests/web/sentry-browser.test.tsx`
- Modify: `vitest.config.ts`
- Modify: `package.json`
- Modify: `tests/ci-workflow.test.ts`

**Step 1: Write failing real-envelope tests.**

Use real installed SDK APIs and an in-memory transport. Seed Worker, DO, and browser events with unique prohibited strings in cookie/header/query/body, provider URL/API key, email/member/financial data, exception/cause, nested exceptions, stack `filename`/`abs_path`/function/context, reset-token document URL, and unsafe debug metadata.

Assert a UUID-format debug ID, safe generated bundle path, and numeric frame location survive. Add fingerprint assertions: same finite runtime/category/optional stage has the same fingerprint; unrelated categories have different fingerprints; no fingerprint contains a command/pool/member/event/fixture identifier.

```ts
expect(envelope).not.toContain("provider-key-fixture");
expect(envelope).not.toContain("reset-token-fixture");
expect(event.fingerprint).toEqual(["sentry", "worker", "outbox-producer-delivery-failure"]);
expect(other.fingerprint).not.toEqual(event.fingerprint);
```

Run the focused file. Expected: FAIL because default SDK event content/fingerprinting remains unsafe.

**Step 2: Implement a reconstructing allowlist.**

Make `sanitizeSentryEvent` return `null` or a new event containing only fixed top-level metadata; constant exception values; recognized generated Worker/client module paths with numeric locations; safe debug-ID image data; and fingerprint `["sentry", runtime, category, ...optionalFiniteStage]`. Recursively rebuild nested exceptions. Drop all URLs, function names, `abs_path`, source context, mechanism, user/request/context/extra/breadcrumb/spans/modules, and unrecognized fields.

Set all explicit v10 `dataCollection` opt-outs plus `beforeBreadcrumb: () => null` in server/browser options. Do not enable tracing, replay, profiling, logs, or monitors.

**Step 3: Register web tests exactly once in the mandatory gate.**

Define `webTests` in `vitest.config.ts`; exclude it from node includes and create a `web` project using the DOM environment. Add `--project=web` to the required `npm test` script; CI already invokes `npm test`, so update `tests/ci-workflow.test.ts` to assert that required merge command. Keep web files out of node and Workers projects so they run once, not zero or twice.

Run:

```sh
./node_modules/.bin/vitest run --project=workers tests/worker/sentry-privacy.test.ts
./node_modules/.bin/vitest run --project=web tests/web/sentry-browser.test.tsx
npm test -- --maxWorkers=5
```

Expected: focused suites and required test command pass without network access.

### Task 3: Add registry provenance, Hono onError, and Worker route ownership

**Files:**
- Modify: `src/services/pool-command-client.ts`
- Modify: `src/services/pool-registry.ts`
- Modify: `src/worker/do-router.ts`
- Modify: `src/worker/routes.ts`
- Modify: `src/worker/app.ts`
- Modify: `src/observability/sentry-server.ts`
- Modify: `tests/worker/create-pool-saga.integration.test.ts`
- Modify: `tests/worker/api.test.ts`

**Step 1: Write failing creation-saga provenance tests.**

Extend `tests/worker/create-pool-saga.integration.test.ts` with real D1 registry plus `DurablePoolCommandClient` and a fake authority stub. Cover:

* non-OK `{ code: "POOL_ALREADY_INITIALIZED" }`: exact existing failed record, `lastError`, and replay; zero report;
* successful 200 `{}`: same existing `POOL_INITIALIZATION_FAILED` message/persistence; one protocol/decode report;
* invalid JSON: same existing message/persistence; one decode report;
* transport rejection: same existing message/persistence; one transport report; and
* finalization D1 persistence failure: finalization report before existing escape/mapping.

Run:

```sh
./node_modules/.bin/vitest run --project=workers tests/worker/create-pool-saga.integration.test.ts
```

Expected: FAIL because internal provenance markers/report ownership do not exist.

**Step 2: Preserve public provenance while distinguishing protocol failure.**

In `pool-command-client.ts`, create nonserialized markers. Only `!response.ok` creates `AuthoritativePoolInitializationError`. A parsed successful response without `commandVersion` creates a separate protocol marker; JSON parsing creates decode marker; fetch creates transport marker. Every marker retains the current externally visible message (`body.code ?? "POOL_INITIALIZATION_FAILED"` where body exists). Do not alter client response shape, registry `last_error`, persisted `response_json`, or HTTP response.

In `PoolRegistry.finish()`, snapshot its phase; after existing failed-record/replay persistence, report marked transport/decode/protocol/finalization categories. Suppress only non-OK authoritative marker. If failed-record persistence itself fails, safely report finalization before rethrowing the same error path.

**Step 3: Snapshot Hono default behavior before capture.**

In `tests/worker/api.test.ts`, make a direct auth handler or another route outside `mutation()`/`memberRead()` throw. Record its existing status/body before implementing an error hook, then assert the future one safe event. Add handled auth/domain/business responses and assert zero events. The failure must be missing capture, not an assumed Hono response shape.

**Step 4: Implement behavior-preserving `app.onError`.**

In `src/worker/app.ts`, add one `app.onError` for otherwise-unhandled Hono route/auth/D1 faults. Safely report finite `hono-unhandled-route-failure` and return the snapshotted Hono default status/body exactly. Do not use it for an already returned route response and do not replace router/mutation/member-read owners.

**Step 5: Add and implement first-owner route/router reporting.**

Write actual API cases for pre-DO wager D1 revalidation, registry lookup, DO dispatch, malformed DO JSON, unowned route action, known market/domain rejection, and authoritative `PoolCommandError`. Snapshot status/body and D1/DO state first. Then make router report/mark registry/revalidation/dispatch/decode before current flattening; let `mutation()`/`memberRead()` report only unmarked unexpected errors. Preserve all mappings and prevent duplicate authoritative DO reporting.

Run focused saga/API tests. Expected: PASS with one event per unexpected owner, zero for expected/authoritative routes, and unchanged bodies.

### Task 4: Cover production scheduled polling, PoolDO, settlement, outbox, Queue, and backups

**Files:**
- Modify: `src/index.ts`
- Modify: `src/worker/cron.ts` only if the waitUntil proof requires catch/report/rethrow
- Modify: `src/durable/pool-do.ts`
- Modify: `src/durable/alarm.ts`
- Modify: `src/durable/outbox.ts`
- Modify: `src/worker/queue.ts`
- Modify: `src/worker/backup-cron.ts`
- Create: `tests/worker/sentry-scheduled.test.ts`
- Create: `tests/durable/sentry-settlement.test.ts`
- Modify: `tests/durable/t11-settlement-regrade.test.ts`
- Modify: `tests/durable/privacy-outbox.test.ts`
- Modify: `tests/worker/queue-health.test.ts`
- Modify: `tests/worker/exports.test.ts`

**Step 1: Write the production scheduled polling composition failure.**

In `sentry-scheduled.test.ts`, seed last-good offers/feed health using the existing ingestion fixture pattern. Invoke the production scheduled composition (not a standalone cron helper) with `ODDS_API_KEY` set to a secret-bearing fixture and an injected provider whose poll rejects with that same forbidden string. Use real enabled SDK composition and recording transport.

Assert one sanitized provider/scheduled capture; last-good D1 offers/feed health are unchanged except existing failure transition; and the `waitUntil` background promise retains the original rejection. First run against installed SDK wrapper. Add safe catch/report/rethrow around `runOddsCron` only if this proof shows SDK does not observe the `waitUntil` rejection; it must preserve the same rejection and never reexecute/suppress the poll.

**Step 2: Write PoolDO rollback/post-commit tests.**

Use a direct test-only PoolDO seam/subclass, never a public endpoint, to force unknown command failure before transaction completion and `setAlarm` failure after commit. Submit sensitive wager fixture and snapshot generic 400 response, account/wager/ledger/outbox/processed-command/replay state before asserting one safe category. Pair known insufficient-shares, stale/line-change, and idempotency rejections with zero events.

**Step 3: Implement PoolDO classification after outcome is known.**

Keep transaction/response behavior unchanged. Track only whether command transaction completed before `setAlarm`; safely report `pool-command-unexpected` or `pool-post-commit-alarm-schedule-failure` without original command/error data.

**Step 4: Write settlement stage regressions first.**

In `sentry-settlement.test.ts`, separately fail source read, stored snapshot parse, `settleWagers` invariant, reconciliation/lifecycle write, and retry-write. Snapshot settlement/account/ledger/reconciliation rows and next alarm deadline. Assert source first/exhausted cadence; internal once-per-invocation/category cadence independent of provider `error_attempts`; original failed-stage category; and exactly one enabled escaping retry-write capture.

**Step 5: Implement failed-stage snapshot ordering.**

Set stage immediately before each fallible operation. In every existing catch, make `const failedStage = stage` the first statement; only then set retry-write stage and execute unchanged retry persistence. After successful persistence classify/report `failedStage`, never the mutated retry stage. If retry persistence fails, do not call caught-path reporter; let enabled DO wrapper capture the escaping failure once. Preserve all SQL, attempts, delays, recovery reset, and deadline selection.

**Step 6: Add background TDD cases and implementation.**

Reuse outbox privacy tests for persisted retry/backoff/max attempts under reporting failure. Reuse Queue composition tests for exact ack or 30-second retry. Extend backup fixtures with 100 failures and mixed non-OK/throwing exports; assert continuation/cursor/count/encryption and at most one event per observed invocation category. Report only after existing persistence/continuation point.

Run:

```sh
./node_modules/.bin/vitest run --project=workers tests/worker/sentry-scheduled.test.ts tests/durable/sentry-settlement.test.ts tests/durable/t11-settlement-regrade.test.ts tests/durable/privacy-outbox.test.ts tests/worker/queue-health.test.ts tests/worker/exports.test.ts
```

Expected: PASS with no changed accounting/retry/Queue/backup assertions.

### Task 5: Wire React root and prove no duplicate browser capture

**Files:**
- Modify: `src/web/main.tsx`
- Modify: `src/web/sentry.ts`
- Modify: `tests/web/sentry-browser.test.tsx`

**Step 1: Write failing root behavior tests.**

Render a throwing child through actual root setup with fake valid public DSN and recording transport. Assert generic fallback, exactly one sanitized envelope, and one root render. Render absent/malformed DSN and setup/init failure; assert uninstrumented app renders once. Exercise caught `ApiError` retry/stale/terminal flows and assert zero events.

**Step 2: Implement minimal root wiring.**

Return either uninstrumented render configuration or one enabled Sentry configuration. Add React 19 callbacks and one error boundary with duplicate suppression. Never retry `createRoot`/`render` and never capture `api.ts` control flow.

Run the web test and `npm test -- --maxWorkers=5`; web tests must run exactly once through the required command.

### Task 6: Add version metadata and map-family checks to actual prepublish verification

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `wrangler.local.jsonc` and test fixture configs only if parity tests require it
- Modify: `src/index.ts`
- Modify: `vite.config.ts`
- Modify: `scripts/build-production.mjs`
- Modify: `scripts/deploy-production.mjs`
- Modify: `scripts/cloudflare-credentials.mjs`
- Create: `scripts/sentry-source-maps.mjs`
- Modify: `scripts/verify-production-artifact.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/production-build.test.ts`
- Modify: `tests/production-deploy.test.ts`
- Modify: `tests/production-deployment-config.test.ts`
- Create: `tests/sentry-source-maps.test.ts`

**Step 1: Write failing synthetic and real-path artifact tests.**

Build synthetic generated manifests with disjoint client/Worker map paths. Reject broad `dist/**/*.map`, symlink/outside map path, and missing client cleanup; require Worker maps remain. Stub absent auth, successful upload, and upload failure.

Add `verify-production-artifact` fixture tests against a real-shaped generated artifact: public client `.map` fails; required Worker `.map` absence fails while `upload_source_maps` is enabled; missing generated `version_metadata.binding === "CF_VERSION_METADATA"` fails. Extend production config/build tests to require the binding in source, isolated config, and generated config. Validate map assertions through the actual prepublish script, not only a standalone resolver.

**Step 2: Implement binding, release, resolver, and verifier integration.**

Add `"version_metadata": { "binding": "CF_VERSION_METADATA" }` to production Wrangler config, mirror only where parity requires it, type `CF_VERSION_METADATA` in `Env`, and set enabled Worker Sentry `release` from its version ID. Ensure isolated/generated config preserves the binding without DSN/auth values.

In a build-only helper, parse generated config/asset output and realpath-validate browser versus Worker maps. Configure official Vite source-map upload only with guarded auth. Delete only browser maps after upload or in no-auth withholding; retain Worker maps until Wrangler consumes existing `upload_source_maps`. Upload failure cleans client maps and aborts publication. Integrate the same map/version assertions into `scripts/verify-production-artifact.mjs`, which `deploy-production` already invokes before publish.

**Step 3: Isolate environments and verify.**

Allow public browser DSN only through guarded public-build input. Pass source-map auth only to upload subprocess; strip before Wrangler and artifact scan. Add CI secret/variable plumbing only after offline tests prove no output/artifact leak.

Run:

```sh
./node_modules/.bin/vitest run --project=node tests/sentry-source-maps.test.ts tests/production-build.test.ts tests/production-deploy.test.ts tests/production-deployment-config.test.ts
npm run typecheck
```

Expected: PASS. Then run only the documented non-publishing guarded build/dry-run with dummy public inputs; do not deploy.

### Task 7: Publish operator docs and finish focused verification

**Files:**
- Create: `docs/sentry-operator-guide.md`
- Modify: `docs/production-deployment.md`
- Modify: `docs/operations.md`
- Modify: established structural doc/config test if one is appropriate

**Step 1: Write failing documentation/config assertion where established tests support it.**

Assert Worker-secret rollback differs from browser rebuild/redeploy; existing tabs can retain compiled DSN until reload; immediate browser ingestion shutdown is Sentry-side. Assert existing Cloudflare Logs/traces/source-map diagnostics are separate from Sentry and retain their documented privacy/retention tradeoff.

**Step 2: Write concise operator guidance.**

Document optional DSN/source-map auth, environment/release, alert categories, safe no-crash verification, browser/Worker rollback, unsymbolicated residual, and native Cloudflare diagnostics residual. Never disclose values or add production crash instructions.

**Step 3: Run final targeted verification and inspect diff.**

```sh
./node_modules/.bin/vitest run --project=workers tests/worker/sentry-lifecycle.test.ts tests/worker/sentry-privacy.test.ts tests/worker/create-pool-saga.integration.test.ts tests/worker/api.test.ts tests/worker/sentry-scheduled.test.ts tests/durable/sentry-settlement.test.ts tests/durable/privacy-outbox.test.ts tests/worker/queue-health.test.ts tests/worker/exports.test.ts
./node_modules/.bin/vitest run --project=web tests/web/sentry-browser.test.tsx
./node_modules/.bin/vitest run --project=node tests/sentry-source-maps.test.ts tests/production-build.test.ts tests/production-deploy.test.ts tests/production-deployment-config.test.ts
npm test -- --maxWorkers=5
npm run typecheck
git diff --check
git status --short
git diff --cached --name-only
```

Expected: targeted suites, required test command, typecheck, and diff check pass; no staged files. Do not run e2e. Submit for parent review before any commit or deployment.

## Implementation order

1. SDK lifecycle/DO proof and dependency bootstrap.
2. Sanitizer, category-aware fingerprints, and web CI registration.
3. Registry provenance, Hono, and Worker routes.
4. Production schedule plus PoolDO/settlement/background boundaries.
5. Browser root.
6. Version metadata, maps, and actual artifact verifier.
7. Operator docs and final focused verification.

This sequence deliberately proves no-init, one-execution, provenance, privacy, Hono, and scheduled composition before broad instrumentation.

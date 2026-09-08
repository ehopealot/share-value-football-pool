# Sentry error reporting design

**Status:** revised technical specification. Implementation is intentionally deferred until this design and its companion plan are reviewed.

## Goal and invariants

Add optional, fail-open Sentry **error** reporting for unexpected Worker, PoolDO, alarm/settlement, Queue, backup, and React-root faults. Priorities are provider polling, swallowed settlement/invariant faults, unexpected wager-placement failures currently returned as 400, and background delivery faults.

Do not change business logic, HTTP status/body contracts, retries/backoff, idempotency, durable/alarm transactions, D1/DO authority, accounting/settlement math, Queue acknowledgement, backup continuation, or financial/member semantics. Add no public test-crash endpoint, tracing, replay, profiling, performance spans, cron monitors, custom transport, request/response capture, or log capture.

## Decisions

### Lifecycle and SDK boundary

Use official `@sentry/cloudflare`, `@sentry/react`, and `@sentry/vite-plugin`, pinned in the lockfile when installed. Earlier research observed versions `10.73.0`, `10.73.0`, and `5.4.0`; implementation must recheck the resolved public APIs/types.

A narrow observability policy module owns DSN validation, enabled gating, finite fault categories, and sanitization. It never implements an ingest transport.

* An absent, blank, or locally invalid DSN takes a raw Worker path and never invokes `Sentry.withSentry`, initialization, capture, or transport. A valid DSN takes exactly one enabled official-SDK path.
* The dispatcher never falls back or retries a raw business handler after the enabled path starts. A command may already have committed.
* SDK source verification found that `instrumentDurableObjectWithSentry` writes Durable Object trace-link storage even with tracing disabled. PoolDO therefore remains unwrapped; its explicit safe-fault boundaries are the error-only supported SDK arrangement. Disabled instances construct `PoolDOBase` without SDK initialization, and enabled Worker reporting uses error-only integrations with no trace propagation or storage linkage.
* Configuration/init failure, synchronous capture failure, rejected transport, and stalled transport are observability failures. They are isolated without await on command/alarm/Queue/backup critical paths and cannot reexecute, delay, acknowledge, reject, or modify business work.

### Source-owned reporting and authoritative provenance

`reportSafeFault(category, stage?)` only receives a finite source-code category/stage. It creates a constant SDK error with fixed tags and returns `void` even if reporting fails. Its fingerprint is exactly `["sentry", runtime, category]` plus `stage` only when that finite category defines one; it never contains an application identifier. The same finite runtime/category/optional stage has the same fingerprint; unrelated categories have different fingerprints. It never receives an original exception, request, command, response, provider result, Queue body, identifier, or retry payload.

The first layer that understands a fault owns reporting before it is flattened:

| Owner | Report | Do not report | Preservation |
|---|---|---|---|
| `PoolCommandRouter` | Registry lookup, pre-DO wager D1 revalidation, DO transport, and response decode faults. | Known quote/market/domain failures and authoritative DO rejections. | Existing flattened availability/domain response. |
| `mutation()` / `memberRead()` | An unmarked unexpected action error that neither router nor registry owns. | Validation, auth/CSRF, expected domain/availability, router-marked, or authoritative DO error. | Existing status/body. |
| `createWorkerApp()` Hono `onError` | An unhandled route/auth/D1 exception that is outside `mutation()`/`memberRead()`. | A response already returned by a route, including business/auth/domain failures. | Snapshot the existing Hono status/body first, then return it byte-for-byte while emitting one safe event. |
| `PoolRegistry.finish()` | Its transport, decode/protocol, and finalization faults. | Marker proving a non-OK authoritative DO rejection. | Existing failed record, `lastError`, persisted replay response, and message. |
| `PoolDO.fetch()` | Unknown command fault converted to 400 and post-commit `setAlarm()` failure. | Known command/domain rejection. | Transaction/replay and exact current 400 response. |
| Alarm/outbox/Queue/backup | Their deliberately swallowed faults described below. | Escaping fault already covered by enabled SDK wrapper. | Retry/persistence/continuation semantics. |

`DurablePoolCommandClient.initializePool()` must introduce nonserialized internal error types/markers while preserving the existing externally visible message and registry response exactly:

* A non-OK HTTP authority rejection (`!response.ok`) becomes `AuthoritativePoolInitializationError` carrying the current `body.code ?? "POOL_INITIALIZATION_FAILED"` message.
* A successful HTTP response missing `commandVersion` becomes a separate `PoolInitializationProtocolError`, with that same existing message, and is reportable as a protocol/decode regression. JSON parse failure and transport failure have separate internal markers that also preserve their existing messages.
* No marker is put in `last_error`, `response_json`, an HTTP response, or Sentry metadata. `PoolRegistry.finish()` suppresses only the non-OK authoritative marker. It reports its own marked transport/decode/protocol failure after the current failed-record persistence; it reports a finalization failure before rethrow if its own failed-record persistence cannot complete.

An actual D1-to-client-to-authority creation-saga test must prove non-OK authority rejection is quiet, while a malformed successful 200 response lacking `commandVersion` reports once. Both must preserve the exact failed/replay response and message.

### Settlement classification without semantic change

`runSettlementAlarm` retains its existing `try`/`catch`, transaction scope, retry writes, backoff, recovery reset, and next-deadline calculation. Add only a local finite `stage` and invocation-local `reportedInternalCategories` set; neither is persisted.

Stages are limited to `super-bowl-source-read`, `super-bowl-reconciliation-write`, `result-source-read`, `result-snapshot-parse`, `result-settle-wagers`, `result-lifecycle-write`, and a retry-write stage for each catch branch.

The catch algorithm is mandatory:

```ts
catch (error) {
  const failedStage = stage;             // first statement: preserves original fault
  stage = retryWriteStage;               // only after snapshotting failedStage
  await existingRetryPersistence(error); // unchanged transaction, attempts, delay, and SQL
  reportFrom(failedStage);               // never classify from retryWriteStage
}
```

If retry persistence itself throws, it escapes exactly as today. Do not call the caught-path reporter for it; enabled DO alarm instrumentation captures that escaping retry-write failure once. `failedStage` is used only after original-fault retry persistence succeeds.

* Source-read failures retain existing first-error/exhausted-recovery cadence based on the unchanged `error_attempts` calculation.
* Snapshot parse, `settleWagers` invariant/accounting, reconciliation/lifecycle storage faults report once per invocation/category, independent of provider `error_attempts`. They remain retryable exactly as before.
* No category includes provider/error text. This distinguishes source outage from `NEGATIVE_ACCOUNT`, `NEGATIVE_FLOAT`, invalid parlay ruleset, malformed snapshot, or storage failure without changing settlement/retry behavior.

### Background reporting and noise

* Odds polling: the Worker wrapper captures a rejected scheduled poll. If the installed SDK does not observe `waitUntil` rejection, a safe catch reports then rethrows.
* Outbox: report only after existing retry persistence and only on first/terminal producer attempt.
* Queue consumer: safely report before the existing `queued.retry({ delaySeconds: 30 })`, never including body/ID.
* Backup: record only invocation-local `backup-export-non-ok` and `backup-item-exception` flags while iterating. After continuation/cursor/count behavior, emit at most one event for each observed category. A non-OK export response counts. `runBackupCron` emits one run-failure event; it does not duplicate partial failure when an item category explains it.
* Best-effort email, expected 4xx/503, stale/no-offer, normal retries, and health status remain unreported.

## Privacy contract

Both runtimes explicitly opt out of all v10 permissive collection: no user info, cookies, request/response headers, query parameters, HTTP bodies, database data, stack-frame variables/context lines, GraphQL data, GenAI input/output, server name, breadcrumbs, traces, replay, profiling, logs, cron monitors, or propagation. Do not use deprecated `sendDefaultPii`.

`beforeSend` discards the input event and returns `null` or a newly constructed allowlisted event. It never modifies an untrusted event in place.

| Event location | Allowed data |
|---|---|
| Top level | SDK event ID/timestamp, platform, fixed level, validated release/environment, finite runtime/category/stage tags, and deterministic fingerprint `["sentry", runtime, category, ...optionalFiniteStage]`. |
| `exception.values` | Bounded array of constant type/value plus bounded sanitized stack frames; no message, cause, mechanism, or arbitrary data. |
| Frame | `in_app: true`, numeric line/column, and a normalized recognized generated Worker/client bundle path only. Drop function, `abs_path`, vars, source/context lines, module/package, all URLs, and unrecognized paths. |
| `debug_meta.images` | Source-map type, normalized recognized compiled `code_file`, UUID-format `debug_id` only. |
| SDK metadata | Fixed SDK name/version/integration IDs matching an explicit primitive/regex allowlist, only if required. |

Delete request, user, contexts, extra, breadcrumbs, transaction/spans/measurements, modules, server name, raw tags/fingerprint, mechanism, and every unlisted nested object. Reject frame/debug paths with credentials, query, fragment, absolute filesystem prefixes, `..`, inline-document/script names, or source URLs. If no safe frame/image remains, send a constant event without stack information.

No event may contain auth/cookies/tokens, provider-key URLs, request/response bodies, email/display/member data, pool/event/command IDs, market/selection/odds/price/risk/balance/share/dollar data, backup/export data, or arbitrary error text.

## Browser boundary

With valid `VITE_SENTRY_DSN`, initialize `@sentry/react` with the privacy policy, React 19 root callbacks, and one root `Sentry.ErrorBoundary` generic-refresh fallback. Coordinate root callbacks/boundary so a throwing child emits exactly one event. Do not manually capture `ApiError`; retry/stale/terminal UX is expected control flow.

With no valid browser DSN, render the existing app with no Sentry initialization/callback/boundary. Browser setup failure leaves a single original root render; it must not call `createRoot` or `render` twice.

## Source maps, operations, and rollback

`SENTRY_DSN` is optional Worker runtime secret; `VITE_SENTRY_DSN` is optional public build input. Environment is explicit only for production. Add `wrangler.jsonc` `version_metadata` binding `CF_VERSION_METADATA`, type it in `Env`, and set enabled Worker options `release` from its version ID. Browser symbolication uses Vite debug IDs. Keep existing `wrangler.jsonc` `upload_source_maps: true`.

Source-map auth (`SENTRY_AUTH_TOKEN`, nonsecret org/project) is build-only. It must be removed before Wrangler deploy and absent from artifacts/logs. It is optional: reporting works without it, unsymbolicated.

Derive two disjoint, realpath-validated map sets from the generated deployment config/asset manifest:

1. public browser-client maps under the actual deployed asset directory; and
2. Worker maps consumed by Wrangler/native `upload_source_maps`.

Never delete `dist/**/*.map`. Successful upload deletes only browser-client maps. With no auth, delete/withhold only browser maps before artifact publication while preserving Worker maps. Upload failure aborts deployment and cleans any browser maps in a failure-safe path without intentionally deleting Worker maps before the aborted deploy cleanup. Integrate map-family and version-metadata assertions into `scripts/verify-production-artifact.mjs`, the actual prepublish path, and test both synthetic fixtures and the generated production artifact. Artifact verification proves public browser maps absent, required Worker maps retained, and generated config retains the version-metadata binding.

Create a concise standalone `docs/sentry-operator-guide.md` and update `docs/production-deployment.md`. The guide separates Worker secret removal from browser rebuild/redeploy without `VITE_SENTRY_DSN`; already-open browser tabs can continue reporting until reload, and immediate browser-ingestion shutdown requires Sentry-side client-key/project control. The runbook must state that existing Cloudflare Logs/trace/source-map diagnostics are separate from Sentry and retain their documented privacy/retention tradeoff; Sentry privacy settings do not change that native residual.

## Required implementation proof

Use real installed SDK APIs with an in-memory test transport; no test contacts Sentry. Prove:

1. raw absent/blank/malformed DSN bypass and exactly-once Worker/DO/business execution;
2. init, synchronous capture, rejected transport, and stalled transport fail open without changing response, replay, alarm, Queue, or backup behavior;
3. serialized Worker/DO/browser envelopes remove prohibited strings in nested exception/frame/debug fields while retaining only valid numeric locations/debug IDs and stable category-aware fingerprints;
4. Hono `onError` preserves a snapshotted unhandled route response/body, emits one safe event, and leaves handled business errors quiet;
5. Worker route/router/registry ownership includes pre-DO D1 failure, transport/decode/protocol, non-OK authoritative rejection suppression, malformed-200 creation-saga provenance, and no duplicates;
6. production scheduled odds composition captures a secret-bearing provider failure, preserves last-good/feed health, and preserves the rejected background promise; add catch/rethrow only if installed SDK coverage is insufficient;
7. PoolDO rollback and post-commit alarm-schedule faults preserve current state/response;
8. source versus internal settlement stages, original `failedStage` classification, first/exhausted source cadence, once-per-invocation internal cadence, and one escaping retry-write capture;
9. outbox/Queue/backup preservation and backup invocation coalescing; and
10. source-map absent/success/failure states, browser-map deletion, Worker-map retention, token isolation, version metadata in generated config/actual artifact verification, browser boundary single event, and no-DSN build.

Run targeted node/Workers/DOM tests, typecheck, and non-publishing build/dry-run checks only. Do not run e2e, access credentials, deploy, or create a test-crash endpoint.

## Sources

* Sentry Cloudflare: `https://docs.sentry.io/platforms/javascript/guides/cloudflare/`
* Sentry options/filtering: `https://docs.sentry.io/platforms/javascript/guides/cloudflare/configuration/options/` and `/filtering/`
* React Error Boundary: `https://docs.sentry.io/platforms/javascript/guides/react/features/error-boundary/`
* Vite and Cloudflare source maps: `https://docs.sentry.io/platforms/javascript/guides/react/sourcemaps/uploading/vite/` and `https://docs.sentry.io/platforms/javascript/guides/cloudflare/sourcemaps/`

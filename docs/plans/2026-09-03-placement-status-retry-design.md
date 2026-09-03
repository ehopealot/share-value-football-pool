# Placement Status Retry Design

## Goal

When a wager placement response is lost or the pool is temporarily unavailable, automatically replay the already-frozen, idempotent placement instead of immediately showing an unknown-status error. The browser retries at +2 seconds and +10 seconds after the first ambiguous result. It preserves the current manual retry/error behavior only when both automatic checks remain ambiguous.

## Chosen approach

Add a wager-only transport wrapper in `src/web/api.ts`. It will reuse the exact placement body and endpoint for every attempt. The existing server placement route already probes `ProbePlacementReplay` before any mutable work, so a replay either returns the durable result of an already-placed wager or safely performs the original placement if it never reached authority. No new endpoint, durable schema, or generic request-timeout change is needed.

The wrapper will be used by straight-bet batch placement, teaser placement, and parlay placement. `api.placeCommand` remains unchanged so commissioner share-order execution does not gain behavior outside this request. A slug-scoped page-generation guard resets route-owned state and prevents delayed quote, recovery, or status-check continuations from updating a new pool or an unmounted page.

## Retry behavior

Only `commandOutcome(error) === "retryable"` triggers the policy. A successful retry completes the existing UI flow. A stale or terminal response stops immediately and reaches the current page-specific recovery/error path. If the retry remains retryable at both scheduled checks, the wrapper rethrows the last error; the existing "Placement result unknown" state and manual exact retry remain the final fallback. For straight batches, already-confirmed and terminal outcomes remain visible while only unresolved frozen placements stay in the retry review.

The schedule is measured from the first ambiguous response: retry after 2 seconds, then at 10 seconds total (an 8-second second wait in the normal instantaneous-test case). Existing 5-second request timeouts are unchanged.

## Verification

Unit tests will inject clock/sleep seams to prove the +2s/+10s schedule, exact retry count, early terminal stop, final unresolved error, mixed straight-batch outcome retention, and route-generation invalidation. Focused local Worker E2E coverage will confirm automatic replay sends the identical placement body and reaches placement results without exposing the unknown-status alert, and that pending straight quote/placement and teaser quote continuations cannot leak into another pool after SPA navigation.

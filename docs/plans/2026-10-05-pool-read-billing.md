# Pool row-read billing reduction implementation plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Reduce billed SQLite rows read for pending-outbox checks and standings without changing results or delivery policy.

**Architecture:** Add one partial outbox index on `next_attempt_at` for `delivered_at IS NULL AND attempts < 5`. Compute standings order basis and earliest holdings attainment using one season-wide read of each source table, with per-member BigInt accumulators. Keep weekly chart calculation and public response shapes unchanged.

**Tech Stack:** Cloudflare Durable Objects SQLite, TypeScript, Vitest Workers pool.

## Decisions and invariants

- Use a partial index rather than deleting delivered history or adding a cache. Match the retry predicate exactly; retain the five-attempt policy and earliest retry calculation.
- Explicitly order outbox draining by `created_at, rowid` so adding an index does not change equal-timestamp append ordering or the 25-row batch boundary.
- Use season-wide accumulation instead of per-member indexes or SQL numeric SUM: it eliminates repeated scans without introducing ledger/order index-write costs or losing integer precision.
- Preserve chronological ledger order (`created_at, rowid`), earliest attainment (including reaching, leaving, and regaining a holding), gain sorting, suspended members, zero balances, refund handling, and closed-season history.
- Index creation is idempotent through the existing constructor schema loop and applies to existing objects on restart. It adds storage/index maintenance writes; do not claim reads fall without measuring `SqlStorageCursor.rowsRead` after consuming cursors.

## Task 1: Pending outbox index

Files: `src/durable/schema.ts`, `src/durable/outbox.ts`, new `tests/durable/read-efficiency.test.ts`.
1. Seed real DO SQLite with delivered and exhausted history plus retryable rows. Exercise pending existence, next retry, and due-drain queries; measure rowsRead and assert the query planner uses the partial index. Test no pending rows and due-time boundary.
2. Verify tests fail before indexing.
3. Add `CREATE INDEX IF NOT EXISTS outbox_pending_retry_idx ON outbox(next_attempt_at) WHERE delivered_at IS NULL AND attempts < 5` immediately after outbox table creation. Make drain append-order tie-break explicit.
4. Test idempotent installation on a populated table, retry exhaustion/delivery transitions, and preservation of due selection and batch size.

## Task 2: Standings accumulation

Files: `src/durable/pool-do.ts`, `tests/durable/read-efficiency.test.ts`; existing `tests/durable/t11-member-reads.test.ts` remains behavior coverage.
1. Add a real SQLite rowsRead regression fixture with multiple members, interleaved ledger/order rows, another season, and values beyond Number precision. Compare old per-member calculation results and reads against the production standings method.
2. Verify the row-read reduction assertion fails before implementation.
3. Build account accumulators keyed by member. Read orders once for issued values; read chronological ledger once for running holdings/earliest attainment. Preserve existing sorting and output mapping.
4. Verify expected results, bounded rows read, and existing standings/history cases.

## Validation and delivery

Run focused Workers tests: `npx vitest run --project=workers tests/durable/read-efficiency.test.ts tests/durable/t11-member-reads.test.ts tests/durable/privacy-outbox.test.ts tests/durable/operations-inspection.test.ts`.
Run `npx tsc --noEmit --incremental false` and `git diff --check`. Request read-only review (no e2e), then create a PR against main. Full suite runs in CI; do not run local e2e.

## Validation results

- Baseline: existing focused suites passed (26 tests).
- Outbox regression failed before indexing at 6,133 SELECT rows read with 2,000 delivered/exhausted historical entries. With the index, the same test passes a bound below 200 rows across next-retry, due-batch, and pending-existence reads; empty pending reads remain below 10. Query plans confirm index use.
- Standings regression failed before batching at 13,610 history rows read. With batching, reads are less than one quarter of the former per-member queries on the same fixture. Exactly one ledger and one order query run. The fixture includes 13 accounts, two seasons, interleaved ledger history, suspension, empty balances, and order reversals beyond Number precision.
- Final focused validation: 28 tests passed across four Workers test files; TypeScript and diff whitespace checks passed. No local e2e tests run. CPU/storage overhead is an accepted trade-off for reducing billed reads.

## Residuals

Standings still scan each source table once per call; other-season history can contribute scan costs because this change adds no accounting indexes. Weekly charts still perform their existing independent reads. Pending backlog size still affects due-drain sorting. Index creation has a one-time scan/write cost and ongoing index maintenance writes. Production savings depend on traffic and must be remeasured after deployment.

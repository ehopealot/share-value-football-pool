# Two-Hour Final Correction Check Design

**Status:** Approved by the operator on 2026-09-03.

## Problem

A provider result is currently refreshed in D1 five minutes and 24 hours after it first becomes terminal. Each Pool Durable Object settles from D1 immediately, then checks its retained result at 15 minutes and 24 hours. A correction posted after the short check can therefore remain unseen until the next day even when it is available much earlier.

## Decision

Retain the existing immediate settlement and short/next-day checks, and add one two-hour checkpoint to both sides of the result pipeline:

- D1 ingestion refreshes each terminal provider event at 5 minutes, 2 hours, and 24 hours after `finalized_at`.
- PoolDO reconciliation settles the first terminal snapshot immediately, then checks it at 15 minutes, 2 hours, and 24 hours after `final_observed_at` before marking the lifecycle complete.

The differing short checkpoints are intentional: the D1 refresh occurs at five minutes and the PoolDO reads that evidence at 15 minutes. At two and 24 hours, normal cron/alarm timing may determine whether ingestion or settlement runs first; the next invocation remains idempotent and applies any newer correction version.

## Durable lifecycle

`event_reconciliation.phase` becomes:

`open -> final_15 -> final_2h -> final_24 -> complete`

Every final deadline remains anchored to the first terminal observation, not to the time a previous checkpoint happened. Provider failures keep the existing bounded retry behavior and do not skip a checkpoint.

## Existing-object migration

The phase column has a SQLite `CHECK`, so startup performs an idempotent table rebuild when the stored definition does not yet admit `final_2h`. Rows already in `final_24` have completed their 15-minute check under the old lifecycle; migration maps them to `final_2h` and changes `deadline_at` and `next_attempt_at` to `final_observed_at + 2 hours`. Other phases and row identities are preserved.

After startup migration, PoolDO compares the earliest persisted settlement deadline with the currently registered Durable Object alarm. It sets the alarm only when no alarm exists or the persisted deadline is earlier, so migration can bring an old 24-hour alarm forward without displacing an earlier outbox or retry alarm. Initialization uses `blockConcurrencyWhile` only around local schema/alarm setup and performs no external I/O.

## Authority and accounting

D1 remains the shared provider-result projection. PoolDO remains the sole automatic accounting authority. Existing correction-version idempotency, immutable snapshots, reversal/replacement settlement, commissioner-correction precedence, provider retry behavior, and season closure rules are unchanged.

## Validation

Targeted tests cover:

- D1 polling at 5 minutes, 2 hours, and 24 hours, with no duplicate polls between thresholds;
- PoolDO phase/deadline progression through 15 minutes, 2 hours, and 24 hours;
- migration of an existing `final_24` row to `final_2h` while preserving its identity and other state;
- startup re-arming of a migrated lifecycle earlier than its old alarm; and
- migration idempotency across a second cold start.

Typecheck and production build complete the local validation. E2E tests are intentionally excluded at the operator's request; CI runs the broader suite.

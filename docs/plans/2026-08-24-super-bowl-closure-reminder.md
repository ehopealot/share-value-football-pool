# Super Bowl season-closure reminder design and implementation plan

## Scope

Rename the existing commissioner acknowledgment action to **End season after Super Bowl**, explain that it identifies the displayed game and opts into automatic closure only after the game is final and every wager is resolved, and send one pre-kickoff email reminder per active, unacknowledged season. This does not change candidate discovery, settlement alarms/outbox behavior, normal commissioner duties, or add an email action endpoint.

## Design

- Keep `PoolDO` authoritative for the active season, immutable discovered candidate, acknowledgment, and current commissioner. Add one narrow internal reminder protocol authenticated by the existing `SETTLEMENT_SERVICE_TOKEN`; that credential is already the business-lifecycle mutation boundary for settlement and here may only reserve/revalidate/finalize this season-lifecycle reminder. The read-only OPS token remains rejected.
- Add one additive SQLite table, `season_closure_reminder`, keyed by season. It records the frozen provider idempotency key and email payload identity, first/last attempts, retry lease/deadline, explicit attempt outcome, and delivery/terminal timestamps. Fresh and existing DO databases use the same idempotent schema/migration path.
- A bounded production cron pages ready pool IDs with a durable D1 cursor. Every invocation visits at most 50 pools and stops starting another pool after a 20-second wall-clock budget, advancing the cursor to the last attempted ID and wrapping on a later invocation for fairness. Each DO fetch has a five-second timeout; Resend has its existing ten-second timeout. The current pool may finish beyond the soft run budget. It calls each DO directly; no D1 projection supplies send authority.
- The DO `prepare` operation catches up immediately when a candidate is discovered inside the seven-day window, but only while `kickoff - 7 days <= now < kickoff`. It suppresses missing candidates, inactive/closed seasons, acknowledged candidates, delivered/terminal records, and expired retries. It leases one attempt so overlapping crons cannot both send.
- The Worker resolves the prepared authoritative commissioner ID to the current D1 account email, then calls the DO `claim` operation immediately before sending. Claim revalidates active season, candidate/event/kickoff, acknowledgment, current commissioner, retry window, an unexpired and unused reservation token, and (on retry) the previously frozen recipient and payload. The send lease starts anew at claim. The Worker uses actual current time at each operation, not the scheduled event timestamp, and checks kickoff once more after the claim response before invoking the notifier. Commissioner or email changes terminate an ambiguous retry rather than send old recipient data.
- The existing Resend notifier sends text plus escaped HTML to the authenticated `/p/:slug/admin/season` page. The link is navigation only and performs no GET mutation. A stable per-pool/per-season provider idempotency key and byte-equivalent frozen message inputs are reused for retries.
- On provider acceptance the Worker marks delivery. On a thrown/failed provider call it records an explicit failed/ambiguous attempt and no success marker. A lease permits recovery if execution stops after provider acceptance but before the marker. Retries use the same payload/key, stop within 23 hours of first send, and also stop at kickoff, acknowledgment, closure, commissioner transfer, or recipient change.
- Reminder cron registration is independent from odds and backup branches. It is disabled unless Resend and settlement-lifecycle credentials are both configured. The local Worker does not compose the Resend notifier or run reminder cron, so local/tests cannot send real email.

## Invariants and residuals

1. At most one record and one successful delivery marker exist per season; overlapping attempts are serialized by the pool DO lease.
2. Send authority is revalidated by the DO immediately before each provider call. D1 is used only to map the authoritative current commissioner ID to an account email and to page ready pool IDs.
3. Retried provider calls preserve recipient, content, and idempotency key exactly and remain inside a conservative 23-hour provider-dedup window.
4. Candidate discovery remains alarm-driven and unchanged; cron scans all existing ready pools, including pools whose discovery alarm no longer remains.
5. External provider acceptance cannot be atomic with the later DO success marker. A crash can therefore cause a retry; Resend idempotency mitigates duplicates only during its documented 24-hour window, hence the 23-hour cap.
6. Provider acceptance is not inbox delivery. A successful marker means Resend accepted the request, not that the mailbox received it.
7. An acknowledgment, commissioner transfer, or account email change after final authority/recipient revalidation cannot atomically cancel the external email POST. Subsequent attempts stop on authority changes. Pool scanning and candidate discovery are periodic, so catch-up means the next eligible sweep, not a synchronous email in the discovery transaction.
8. Retry inputs are frozen. Changing the email template, sender, or configured origin during an in-flight retry window can make Resend reject the same idempotency key with changed content; do not alter that rendering during an active window. After the bounded retry window, uncertain deliveries stop rather than risk a duplicate.

## Implementation sequence (test-first)

1. Add rendering tests for the exact button label and acknowledgment/automatic-closure copy; update the page.
2. Add Resend notifier tests for safe text/HTML rendering, admin navigation URL, and stable idempotency header; extend `PoolNotifier` narrowly.
3. Add worker/DO tests for timing boundaries, catch-up, state suppression, schema upgrade, internal auth, overlapping leases, failures/retry cutoff, and commissioner transfer; implement the additive table and internal protocol.
4. Add cron tests for configuration disablement, bounded fair paging, authority calls, recipient lookup, and continuation despite per-pool failure; implement the cron and production scheduled composition independently from odds/backup.
5. Run only focused node/worker tests and `npm run typecheck`; do not run E2E, remote Wrangler, deployment, or live email commands.

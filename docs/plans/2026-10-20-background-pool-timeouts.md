# Background pool request timeout adjustment

## Approved change

Increase only the unsettled-wager inspection and season-closure-reminder Durable Object request timeouts from 5 to 15 seconds. Production evidence on October 20 showed both requests canceled at 4.999 seconds while an audit export from the same pool succeeded after 6.677 seconds. This gives slow pool access more headroom; it does not establish the underlying cause or verify wager accounting.

Alert classifications, 30-minute email suppression, reminder claims/idempotency/kickoff checks, 50-pool page limits, cursor advancement, and 20-second between-pool scan budgets remain unchanged. No automatic wager retry or accounting repair is added.

## Budget residuals

The existing 20-second budgets are admission checks between pools, not hard run deadlines. A final inspection can now spend up to 15 seconds waiting on fetch after being admitted just before that threshold (roughly 35 seconds overall, plus database, response parsing, and alert delivery). Reminder processing can make prepare, claim, complete, and, after a completion failure, fail requests. Four 15-second waits plus the existing 10-second email request can exceed the scan budget substantially (roughly 90 seconds including an admission near 20 seconds, before other overhead). Cursor fairness is preserved, but fewer pools may be visited per invocation under slow access.

These are illustrative fetch-wait totals, not strict bounds: database calls and response parsing have no separate overall deadline. Existing abort-signal behavior is retained. A hard end-to-end budget or changed reminder lease/retry policy would be separate scope. Existing kickoff rechecks continue to prevent initiating reminder email after kickoff. Timeout/ambiguous outcomes retain existing handling; increasing waits does not prove no commit occurred.

## Other production timeout audit (unchanged)

- `src/worker/ops-routes.ts`: manual inspection has a 3-second signal and matching Promise.race. It is shorter than the observed slow pool access; recommend considering 15 seconds for both together in a separately approved change. A slow inspection is still unknown, not unhealthy.
- `src/web/api.ts`: 5-second bounded requests cover wager quote/placement, admin commands, message-board calls, and matchup reads; odds reads also have a separate 5-second timeout. These can be tight during slow pool access, but increasing them changes perceived responsiveness and unknown-outcome/retry timing. Measure endpoint latency first; do not globally increase without reviewing recovery tests and UX. Several ordinary reads have no explicit client timeout.
- `src/index.ts`: placement odds refresh uses one shared 4-second deadline across odds/scores and leagues. It intentionally bounds best-effort provider work; do not increase based on pool latency. Longer refreshes also compete with the browser's 5-second request deadline.
- `src/services/espn-matchup.ts`: ESPN requests have a 4-second limit. No evidence implicates ESPN; retain pending provider-specific latency evidence.
- `src/auth/email-sender.ts`: Resend requests have a 10-second limit. No evidence implicates email latency; retain. Ambiguous provider acceptance still requires existing idempotency semantics.
- `src/worker/do-router.ts`: ordinary pool command forwarding has no explicit application timeout. Thus the earlier server-side quote 503 is not explained by the two changed 5-second background limits. Investigate underlying pool availability separately rather than promising this change fixes quote failures.

## Validation

Focused Workers tests assert the exact 15-second signals, successful reminder prepare/claim/complete flow, unchanged settlement alert classification, and between-pool budget/cursor behavior. No e2e tests or production mutation/deployment are part of this change.

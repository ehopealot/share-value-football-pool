# Operational maturity — approved scope

Status: historical broader scope, superseded for the current release by [Operational visibility — reduced scope](2026-09-10-operational-visibility-reduced-scope.md) after the user approved reducing scope on 2026-09-10. The requirements below are retained as deferred design, not current delivery commitments or implemented capabilities.

## Delivery philosophy

Build practical operational maturity, not perfect infrastructure. Preserve accounting/privacy invariants. Document surviving residuals with impact, detection/workaround, and reason for deferral. No new message bus/database/monitoring platform. Staff engineers implement in serial milestones under parent supervision; expert architecture review of final plan and periodic/final expert code reviews. No child runs e2e tests. Unit/integration/type checks locally; CI runs browser tests. Work only in feature worktree, PR against main; no merge/deploy/live canary/production repair or restore without explicit operator authorization.

## 1. Monitoring and alerts

Existing Worker/D1/PoolDO/Resend. Minimal /ops UI; allowlist immutable operator account IDs server-side, not commissioner status or email alone. Sensitive mutations need recent authentication, origin/CSRF protections, reason and durable audit. Fail closed if not configured. Inspection must not leak hidden wager selections in public responses/email. Details necessary for accounting exception investigations stay access-controlled.

Bounded two-minute scheduled sweep with persistent cursor. D1 stores observations/incidents; unknown/stale never means healthy. Provider expected cadence, scheduled job progress, per-pool pending deadlines/outbox failure, backup success per pool, settlement exceptions. Findings visible immediately; ALL time-based email windows are 30 minutes continuous failure or 30 minutes beyond expected deadline (no double grace). Deduplicated opening/recovery notifications only; no recurring reminders or severity-escalation emails in v1 (final supervisor disposition). Recovery only from successful healthy observation, unknown cannot clear a prior failure. No email flood per cron. Persistent retry intent and stable delivery identity; acknowledge realistic email delivery limits.

Independent external monitor must detect app and scheduler-heartbeat failure with 30-minute window: deliver safe endpoint and concrete setup runbook, not a claimed configured external service. Backups can remain current cadence; measure success without adding restore implementation. Alert on meaningful progress rather than configuration presence or HTTP 200 alone.

## 2. Detection-only watchdog and explicit repair

Dedicated authenticated read-only PoolDO inspection reads earliest pending reconciliation deadline, eligible outbox deadline, actual getAlarm, exhausted outbox rows/errors. It must NOT execute commands, drain outbox, settle wagers, change pool data or schedule alarms. Normal object bootstrap behavior must be distinguished from inspection side effects in tests/docs.

Flag missing alarm, alarm later than required deadline, overdue pending work, exhausted delivery, inspection unknown. No pending work + no alarm is healthy. Avoid transient observation races and back-to-back alarm delivery false positives. Polling/writing observations only in D1. No automatic recovery.

One explicit 'Repair scheduling' button: operator allowlist + recent auth + reason; re-read current work/alarm, schedule missing alarm or bring late alarm forward; never postpone a correct earlier alarm; no-op when already correct/idle. Stable operation ID, safe replay and durable audit. Changes operational scheduling only, not business accounting; subsequent normal alarm may settle normally. No direct settlement invocation, no reset/retry of exhausted outbox delivery in this increment. Exhausted delivery is detected and documented for separate manual resolution.

## 3. Settlement exceptions

Isolate deterministic per-wager accounting exceptions so one correction cannot indefinitely block unrelated settlement. Each wager reversal plus replacement remains atomic; reject negative balances. Retain provider evidence and unresolved retry intent independently of routine event lifecycle. Infrastructure/unexpected errors must not be swallowed as business exceptions. Preserve idempotency/version identity, early multi-leg loss/reopening, commissioner authority, result evidence, monotonic projections, and closure invariants.

Record exception keyed appropriately to wager/result evidence: first/last seen, error category, state; no duplicate record per poll. Exceptions prevent automatic season closure. Explicit inspect then resolve cause using authorized commissioner actions, then audited retry of retained current evidence. Never replay stale evidence over newer results, mark fixed without successful accounting/authorized supersession, or automatically reopen closed seasons. Missing/late results and late corrections have an operational policy, not invented results. Email after 30 minutes unresolved.

## 4. Restore drill — RUNBOOK ONLY

Separate runbook. No restore tooling or executed drill. Inventory actual D1/DO supported recovery mechanisms/retention and audit-export omissions; do not assume audit JSON is complete backup. Isolated resources/configuration; disable email/provider ingestion/settlement until validation. Pin matching app/schema; protect keys/credentials. No cross-store atomic recovery point; reconcile recovery skew and uncertain accepted commands. Verify membership, account/ledger/float/locks, accepted legs, settlements, replay identity, operational state and projections. Real drill execution requires operator approval and validated recovery source. Stop and report unsupported reconstruction rather than fabricate commands. Evidence template, pass/fail, achieved RPO/RTO, cleanup, unresolved gaps. Do not claim a performed or successful restore.

## 5. Release smoke and operator canary

Small deterministic fixture-backed critical-path suite blocks deployment: authentication/pool/ops authorization, quote/place/replay exactly one lock, settle/replay once, exception isolation, read-only watchdog and explicit idempotent scheduling repair. Reuse tests/harness, injected clocks/failures not sleeps/provider. Broad flaky suite separate. NO e2e tests run by subagents; add/adjust tests and CI wiring as needed, validate focused non-e2e checks locally.

Postdeploy checks are read-only app/D1/real DO/deployed version (avoid production business writes); background freshness allowed to arrive within agreed window. Record compatible rollback/version and additive migration policy; code rollback not DB rollback.

Production canary FIRST VERSION OPERATOR-TRIGGERED ONLY, not CI invoked. Dedicated configured test account/pool/season, no arbitrary pool selection or impersonation of real members. Dynamic eligible pregame offer with sufficient kickoff margin; minimum stake. Persist run/wager/quote/placement identities before submission. Use real public-equivalent placement/quote validation and exact replay; never duplicate wager to resolve unknown outcome. Verify one durable wager/lock. Lost response => pending/recover exact intent. Bounded re-quote only after proven terminal rejection, never after uncertain submission. Current betting window/no games => not_exercised, not pass/app failure. Insufficient funds/season closed => explicit maintenance. States passed/failed/pending/not_exercised. Test wagers retained and settle normally; no automatic fake results or unlimited replenishment. UI supports safe recovery/repeated clicks. No live execution during development. Document setup and ongoing share/season maintenance. Optional future CI invokes same runner, not part of v1.

## Source anchors and existing gaps (verify against code)

Base e449f9c. src/index.ts and wrangler.jsonc: two-minute cron, D1/DO/Queue/R2. src/durable/pool-do.ts commits then sets alarm, alarm multiplexes settlement/outbox. src/durable/alarm.ts batches settlement in transaction. src/durable/settlement.ts negative-account rollback and immutable version/reversal logic. src/durable/outbox.ts five-send cap. src/worker/health.ts coarse checks and HTTP200 error JSON. src/worker/backup-cron.ts encrypted audit exports and aggregate logs; src/services/audit-export.ts not full operational restore. src/auth/email-sender.ts Resend and optional idempotency headers. .github/workflows/ci.yml broad e2e nonblocking PR only; ci deploy gate and HTTP200-only app probe.

Current Cloudflare docs fetch from this host returned HTTP403 for D1 Time Travel and DO SQLite API. Verify via alternative official sources or explicitly record retrieval limitation and runtime/account preconditions; do not infer clone/restore support or arbitrary retention numbers.

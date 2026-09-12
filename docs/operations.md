# Operations and recovery

## Local operation

Run `npm run dev` for the Vite/Worker local environment. It applies local D1 migrations first and uses the canonical ignored `.dev.vars` and `.wrangler/state` beside Git's common checkout, so authentication and D1/Durable Object data remain stable across restarts and shared-state-compatible linked worktrees. Shared-state compatibility requires matching storage schemas and local Wrangler identities: worker name, D1 binding/database identity, and Durable Object class/migration identity. On its first linked-worktree run, the launcher safely preserves an existing `.dev.vars` under ignored canonical `.wrangler/dev-vars-backups/` and links the worktree to the canonical file. The Linux-only shared launcher requires util-linux `flock`; its kernel-held lock is outside the resettable state directory and remains with Vite itself, so stop the existing dev server before starting another one. Use only `npm run dev`: direct Vite/IDE dev servers are rejected because they would bypass the lock, and direct Wrangler commands explicitly pointed at the canonical state are unsupported for the same reason. Stop the server before resetting `.wrangler/state`; do not remove the parent `.wrangler` directory while it is running. Do not run an older or identity-incompatible checkout against newer shared state: use separate state or reset the canonical state deliberately before a downgrade. The local fixture controls are development-only and are absent from production. Do not inspect, print, or commit `.dev.vars`.

Useful local checks:

```sh
npm run typecheck
npm test
npm run test:structure
npm run test:e2e
npm run build:production
npm run verify:direction-contract
```

Use `npm run build:local` only for a local Wrangler dry-run build. It does not publish a Worker.

## Health and recovery

`/health/app` confirms Worker request handling. `/health/d1` checks a D1 query. `/health/scheduler` reports only the latest overwritten odds/backup job observations and returns 503 for missing, unreadable, more-than-four-minutes-stale, failed, unknown, or superseded evidence. A `not_due` outcome means the scheduled job made its current due decision; it does not claim provider work occurred. The endpoint does **not** prove that every pool settled or that every pool backup succeeded.

The authenticated `/ops` page is read-only. Exact immutable user IDs in `OPS_OPERATOR_USER_IDS` authorize it; email and commissioner role do not. It shows configuration and latest job evidence and can request one current inspection for a ready directory pool. That token-protected inspection has fixed queries and returns only alarm/retry timestamps and safe pending/exhausted counts. It does not execute commands, settle, drain/reset outbox, set alarms, or repair anything. Inspecting a never-used object can create empty constructor schema; such a response is explicitly uninitialized/unknown.

There is no general-purpose per-pool watchdog, continuous incident timer, or in-app repair in this release. Narrow best-effort failure emails and overdue-settlement checks are described below; other individual pool problems may remain unknown until an operator inspects them. Workaround: inspect the affected ready pool from `/ops`, then use existing documented business procedures; do not treat observation data as authority or improvise repair. Existing shared PoolDO alarm writers can replace an earlier alarm, the native and service settlement entries do not share an application single-flight, and exhausted outbox rows have no reset path; this visibility increment deliberately does not claim to fix those baseline risks. Escalate suspicious inspection evidence for separately reviewed action rather than invoking settlement or editing storage. These remaining omissions are intentional small-scale tradeoffs in the [reduced scope](plans/2026-09-10-operational-visibility-reduced-scope.md).

### Independent external monitor setup

After deployment, an operator may configure an uptime provider outside the Cloudflare account:

1. Check `https://officepool.football/health/app` and `/health/scheduler` every minute.
2. Require HTTP 200 and JSON `status: "ok"`; HTTP reachability alone is insufficient.
3. Notify only after 30 continuous minutes of failed assertions and enable one recovery notification.
4. Record provider, monitor IDs, owner, assertions, cadence, notification window, and last verified test in the private operator system.
5. Prove delivery with staging/fixture infrastructure or an approved maintenance window. Never stop or mutate production work merely to test monitoring.

Until that evidence exists, the application and repository do not claim an external monitor is configured or verified.

A started event is intentionally excluded from the current odds board. If local manual fixtures have expired, reseed them or use the local controls to finalize the intended fixture; do not modify production provider data to repair a local test state.

Durable Object alarms retry settlement. Repeated service delivery is safe because commands and result versions are idempotent. Use the authorized audit export to inspect immutable accounting evidence before any commissioner correction. Correct an order only with a reversing order and correct a graded wager only with the constrained void/regrade flow.

The [isolated recovery drill runbook](restore-drill-runbook.md) remains runbook-only and unexecuted. Its mandatory Phase 0 currently stops because complete isolated D1/PoolDO recovery sources and side-effect quarantine are unavailable. Encrypted R2 audit exports are evidence, not complete PoolDO backups or restore inputs.

## Provider limits

The odds adapter records poll observations and respects configured freshness windows. Provider errors, quota backoff, and no-offer states are visible to members as concise feed status. Do not expose provider API keys, raw provider credentials, or hidden wager selections in logs, screenshots, or support material.

### Deferred residual: cross-league event-ID conflicts (PR #112, P2)

Per-event identity isolation assumes a provider event ID remains in its stored league. If an existing NFL ID reappears with conflicting teams in a poll of **only NCAAF** (or vice versa), ingestion rejects the incoming event, but omission cleanup visits only the polled league. The original event's offers and availability can therefore remain visible and quoteable while the successful poll clears the global provider error. Existing freshness and placement checks still apply, but they do not guarantee immediate isolation of this cross-league case.

This low-likelihood provider-ID reuse scenario is explicitly deferred; same-league conflicts and same-team home/away swaps are handled. If an `odds_event_identity_conflict` warning coincides with an event remaining available, compare the provider ID's stored league with the incoming league and escalate for an approved repair. Do not infer that a healthy feed proves every conflicting event was removed, or silently rewrite stored teams/results. A future fix should collect conflicting persisted IDs independently of the polled league and generation-guard their offer/availability removal and omission marker, preserving result history.

## Best-effort failure emails and overdue settlements

Production sends operational alerts through the existing Resend service to **verified account emails belonging to the exact IDs in `OPS_OPERATOR_USER_IDS`**. Commissioner role and pool membership do not add recipients. `RESEND_API_KEY` and a valid, comma-separated allowlist of at most 50 unique operator IDs are required; absent/invalid configuration disables mail. The local Worker does not compose these alerts, and the local Durable Object identity strips the mail credential even when local secrets are present.

Alerts cover failed odds polls/live refreshes, unexpected technical wager quote/placement failures, and result lookup/settlement processing failures. Normal rejected wagers (changed or stale odds, closed betting, insufficient shares, etc.) do not generate placement alerts. A failed live refresh can generate an odds-update alert even when safe stored-offer fallback permits placement. Mail contains only the failure category, observation time, pool ID/slug (or global scope), optional overdue count, and the authenticated `/ops` link—not raw exceptions, API URLs/keys, member details, or wager selections. Consult Worker logs and authoritative pool records to investigate; an alert never authorizes repair or proves whether an ambiguous placement committed.

The production cron independently inspects ready pools for **open wagers at least 20 minutes after every required event was first observed terminal** (`sports_event.finalized_at`, including final/cancelled/no-contest). For teasers/parlays, the latest required event starts the clock. Final games with incomplete scores still qualify as overdue. Already-settled wagers do not. This is a read-only check through `/internal/ops/overdue-settlements`, authenticated by `OPS_SERVICE_TOKEN`; it neither settles wagers nor changes alarm schedules. It works even if a pool's alarm has stopped. A missing ops token disables this sweep. Inspection failures produce an explicitly unknown-health alert, not a false overdue claim.

The existing two-minute cron checks at most 50 pools per invocation, stops starting another pool after a soft 20-second budget, and persists a fair paging cursor. Each DO inspection has a five-second timeout. Thus 20 minutes is the eligibility threshold, **not an exact delivery deadline**: paging, in-flight work, and scheduling can add delay. No trustworthy final observation means there is no post-game deadline to infer from kickoff alone. Provider/D1 outages can prevent detection, and very large pool inspections may time out rather than produce a count.

Two small D1 tables (`operational_alert_throttle`, `settlement_alert_cursor`) are created lazily. An atomic pre-send reservation suppresses repeated alerts for **30 minutes per category and scope**, across concurrent invocations. Ongoing failures can alert again afterward; there are no recovery emails, delivery retries, or mail outbox. A failed send or interrupted execution can consume the cooldown without delivery. Recipient/throttle lookup also depends on D1, so a D1 outage can prevent email entirely. Provider acceptance is not proof of inbox delivery. Each recipient is sent separately and failures are isolated; email errors never replace business responses or stop settlement retries. Settlement can finish just after the final inspection and before email delivery, so recheck current state before acting.

## Production publishing

Publishing is an explicit operator action. A dry-run (`wrangler deploy --dry-run`) is not a deployment. Before a real publish, follow [the production deployment runbook](production-deployment.md), verify the production artifact, confirm migrations remotely, and use Cloudflare OAuth or an authorized secret path. Never substitute a copied browser key or a local environment file for production secret configuration.

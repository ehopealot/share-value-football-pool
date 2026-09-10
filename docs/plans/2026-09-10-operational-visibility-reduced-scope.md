# Operational visibility — reduced scope and implementation plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Ship a small read-only operational visibility increment and an honest recovery runbook, not a custom incident-management system.

**Architecture:** Preserve the existing independent scheduled odds/backup jobs and PoolDO business/alarm execution. Add narrowly bounded read-only operational views and minimal last-observed job evidence, using existing Worker/D1/PoolDO resources. An independently configured uptime provider owns app/scheduler failure notifications; this application does not orchestrate operational mail or repairs.

**Tech Stack:** Existing TypeScript Worker, D1, SQLite PoolDO, React, Vitest Workers harness.

## Authority and status

On 2026-09-10 the user asked whether the work remained practical and then approved reducing scope. This document supersedes the delivery requirements in the earlier approved scope and three-stage plan **for this release**. Those documents remain historical/deferred design, not an obligation to finish their state machines. Prior architecture approval applies to the old design, not to this reduced implementation.

The previous implementation is partial, independently reviewed with fixes required, and not accepted or deployed. Its files and tracked patch were saved outside the worktree at `/tmp/ops-before-scope-reduction-20260910T180901Z/` before trimming. This local archive is a recovery convenience, not permanent storage or a production backup.

## Keep

1. A minimal authenticated read-only `/ops` page. Exact immutable operator-ID allowlist, fail closed; commissioner role/email are not authority. Show safe configuration readiness and clearly timestamped current/historical/unknown information.
2. Basic app/D1 and scheduler/job freshness evidence. Prefer a few overwritten job-status rows over histories/cursors/incidents. Record actual known outcomes; a due calculation, binding presence, HTTP 200, or a superseded provider publication must not masquerade as successful provider work. Missing/stale/unreadable evidence is unknown or stale, never healthy. Define the endpoint's limited claim explicitly: scheduler/job execution evidence is not proof every pool settled or every backup succeeded.
3. On-demand token-protected PoolDO inspection through the operator API, restricted to ready directory pools, fixed queries, bounded response and timeout. No background pool sweep. Show current alarm/retry times and safe pending/exhausted counts, not hidden wager/member payloads or raw errors. Report observations rather than asserting a continuously healthy lifecycle. Corrupt/unsupported evidence is unknown. Distinguish normal constructor bootstrap from read-side effects.
4. Restore runbook ONLY, with Phase 0 stop on unavailable complete recovery sources/isolation/quarantine. No tooling or drill; R2 audit exports are not full PoolDO backups.
5. Concrete independent external-monitor instructions for app and scheduler JSON assertions, 30-minute failure window and recovery notification. Configuration and delivery verification remain operator actions and must not be claimed complete.

## Remove from this release, not merely hide behind flags

- Custom incident episodes, notification transitions/recipient chains, mail claims/retries/fairness, operational Resend templates/configuration and delivery UI.
- Scheduling repair routes/buttons/audits and all new operational mutations.
- Leased whole-cron orchestration, background pool watchdog cursor, observation histories/retention machinery, original-obligation lifecycle metadata added solely for continuous alerts.
- Changes to PoolDO command/alarm execution, shared alarm single-flight, alarm reconciliation and outbox business behavior. Existing bugs in these paths remain separately documented, not silently called fixed.
- Settlement-exception accounting/retry/lifecycle changes; canary runners and new blocking release-smoke infrastructure. These are deferred, not promised as automatic next stages.

Do not retain dead schema/modules/tests/imports/config or add generalized abstractions to make future deferred work easier. Existing authentication email and original operational/business paths must keep working.

## Practical safety bar and residuals

Read-only is a real boundary: no command execution, settlement, draining/resetting outbox, setAlarm, repair or business SQL writes during inspection. No new public private identifiers. No stale-positive health claim. Bounded inputs, queries and outbound inspection are required; elaborate lease/notification proofs are irrelevant once those features are removed.

Minimal job evidence must not overwrite a newer observation with an older completing run. Use a simple conditional monotonic upsert where needed; do not reintroduce a lease framework. Observation-write failure remains unknown/stale, not a reason to change existing job execution. Do not serialize/retry underlying business jobs to improve monitoring.

Accepted limitations: no automated per-pool alerts, no guaranteed continuous failure tracking, no in-app remediation, no settlement exception isolation, no complete PoolDO backup/importer, no proven restore, and no newly exercised production canary. An operator may discover a pool problem only during inspection. External monitoring covers only the explicitly documented app/job signals. These limits need impact/workaround in `docs/operations.md`.

If even minimal heartbeat instrumentation requires changes to business scheduling semantics, stop and propose a smaller signal rather than rebuild orchestration.

## Implementation tasks (serial, same feature worktree)

### 1. Trim abandoned implementation
- Inventory diff against `e449f9c`; remove only work owned by this operational effort, preserve approved documents and unrelated changes.
- Remove `src/worker/operations-incidents.ts`, repair/incident tests and dead incident/repair schema; simplify or replace `operations-cron.ts` rather than carry its lease framework.
- Restore baseline behavior in `src/durable/alarm.ts`, `outbox.ts`, `wager-commands.ts` and business portions of `pool-do.ts`; remove obligation-only schema changes. Keep only pure inspection code/helper if useful.
- Undo operational-email-only changes in `src/auth/email-sender.ts` and corresponding tests. Preserve original auth mail behavior.

### 2. Retain minimal signals and authenticated inspection
- Relevant seams: `src/db/migrations/0003_operations.sql`, `src/index.ts`, `src/index.local.ts`, `src/worker/{health,cron,backup-cron,ops-auth,ops-routes,app}.ts`, `src/durable/{pool-do,scheduling}.ts`.
- Keep any actual-ingestion-outcome change only if needed for truthful job evidence and covered by focused compatibility tests; no provider ingestion redesign.
- Use existing cron boundaries, tiny bounded status storage and on-demand inspection; no new permanent history or per-pool scheduling model.
- Local mode remains fixture/local-only, never real provider or Resend fallback.

### 3. Simplify UI and documentation
- `src/web/pages/OpsPage.tsx`, `src/web/api.ts`, `src/web/router.tsx`: read-only status and bounded ready-pool inspection only; no repair/retry buttons, incident feed or delivery controls.
- `.dev.vars.example`, `README.md`, `docs/operations.md`: document only shipped configuration/capabilities and residuals.
- Mark old scope/plan superseded at top; preserve their content as historical proposals. Keep restore runbook accurate about actual baseline versus deferred operational state.

### 4. Focused validation and one expert review gate
- Write/run failing focused tests before changes to retained behavior; validate auth deny/allow/malformed config, safe responses, read-only inspection including constructor distinction, idle/corrupt state, missing/stale/job-failure evidence, monotonic observations and local composition.
- Commands: `npm run typecheck`; focused Workers/node Vitest files for retained features and affected existing job/ingestion boundaries; `git diff --check`. Full unit suite may run locally or in CI; do not run browser/e2e.
- Remove tests for deleted features, not failing tests for retained invariants. No exhaustive fault matrix for eliminated distributed state machines.
- Parent verifies diff and scope reduction, then independent expert reviews remaining safety/correctness plus unnecessary complexity. No automatic expansion back to deferred features. PR against main; green CI required before merge/deploy.

## Execution boundaries

One writer; no e2e/browser, authenticated/live provider/account requests, remote Wrangler, deployment, live inspection/repair/canary/restore, staging/commit/push/PR/merge by the worker. Parent owns publication. Do not delete local recovery archive, unrelated files, or other sessions' test processes. No production action has been authorized.

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

There is no background per-pool watchdog, automated operational email, continuous incident timer, or in-app repair in this release. Impact: an individual pool problem may remain unknown until an operator inspects it. Workaround: inspect the affected ready pool from `/ops`, then use existing documented business procedures; do not treat observation data as authority or improvise repair. Existing shared PoolDO alarm writers can replace an earlier alarm, the native and service settlement entries do not share an application single-flight, and exhausted outbox rows have no reset path; this visibility increment deliberately does not claim to fix those baseline risks. Escalate suspicious inspection evidence for separately reviewed action rather than invoking settlement or editing storage. These omissions are intentional small-scale tradeoffs in the [reduced scope](plans/2026-09-10-operational-visibility-reduced-scope.md).

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

## Production publishing

Publishing is an explicit operator action. A dry-run (`wrangler deploy --dry-run`) is not a deployment. Before a real publish, follow [the production deployment runbook](production-deployment.md), verify the production artifact, confirm migrations remotely, and use Cloudflare OAuth or an authorized secret path. Never substitute a copied browser key or a local environment file for production secret configuration.

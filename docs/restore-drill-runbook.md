# Isolated recovery drill runbook

**Status: RUNBOOK ONLY — NOT EXECUTED.** This repository has no restore tooling, no complete PoolDO backup, and no approved production restore path. Nothing in this document claims that a drill or restore succeeded.

This runbook defines a fail-closed, operator-approved exercise. It must never be pointed at production resources. If the preflight cannot prove an isolated, supported recovery source and destination, record a failed/not-exercised drill and stop; do not improvise SQL, reconstruct missing authority, or invoke in-place production recovery.

## Purpose and success conditions

The drill measures the recoverability of the Worker, D1 directory/provider/operational data, and each authoritative PoolDO while preserving accounting and identity invariants. A pass requires all of the following:

- isolated resource IDs, credentials, hostname, D1 database, Durable Object namespace/class, Queue, and R2 bucket;
- a validated D1 recovery source and a validated recovery source for every PoolDO in scope;
- one declared recovery cut and explicit reconciliation of D1/DO skew and commands accepted near that cut;
- the matching application commit, compatibility date, configuration shape, and schema migrations;
- disabled outbound email, provider ingestion, scheduled work, Queue consumption, settlement, repair, and canary until validation finishes;
- successful structural, accounting, privacy, replay-identity, operational-state, and projection checks;
- measured achieved RPO/RTO, evidence, cleanup, and unresolved gaps.

Failure of any accounting, membership, command identity, result evidence, or privacy check fails the drill. “Looks plausible,” HTTP 200, or an audit JSON import is not a pass.

## Current recovery inventory and blockers

### D1 (`DB`)

D1 holds Better Auth users/accounts/sessions/verifications, `pool_registry`, disposable membership/season projections, odds/results/offers and ingestion state, Queue projection delivery, and the reduced-scope latest `ops_job_status` observations. Broader incident/notification/repair/canary records remain deferred historical design and are not current recovery inventory.

Cloudflare's official [D1 Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/) was verified while authoring this runbook. It states:

- Time Travel is available only for databases reported by `wrangler d1 info` as the production storage backend.
- It restores the named database destructively in place. In-flight queries/transactions are cancelled.
- Current Time Travel does not clone/fork a recovery point into a separate database.
- History is plan-dependent: up to 30 days on Workers Paid and 7 days on Workers Free. The account plan and source timestamp must be checked at drill time; do not assume either window.
- Restore returns a prior bookmark that can undo the restore, but that is not a substitute for isolation.

**Current blocker:** Time Travel alone cannot populate the required isolated D1 destination. Never test it against the production D1 database. A future drill may proceed only if Cloudflare adds a verified clone/fork operation or an operator supplies a separately validated D1 export that can be imported into the isolated destination using commands verified against the repository-pinned Wrangler version.

### PoolDO (`POOL_DO`)

Each pool's SQLite-backed `PoolDO` is the sole authority for membership, pool/season state, accounts, immutable orders/ledger, accepted wagers/legs, settlements/corrections, command replay identities, reconciliation, outbox, and alarms.

Cloudflare's official [SQLite-backed Durable Object PITR API documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api) was verified while authoring this runbook. It states:

- `getCurrentBookmark()` and `getBookmarkForTime()` identify one object's recovery points, approximately within the prior 30 days.
- `onNextSessionRestoreBookmark()` schedules that same object's entire SQLite and KV storage for recovery on its next session and returns an undo bookmark.
- Application code typically aborts the object to complete that recovery.
- PITR is unsupported in local development.

The repository exposes none of those methods. The documented API is per-object and in-place; the verified documentation does not establish a supported way to clone a production object's history into an isolated namespace/object.

**Current blocker:** there is no isolated PoolDO recovery source/path. Do not add an ad hoc PITR endpoint during a drill, call PITR on production, or claim that creating an object with the same name in another namespace carries history. It does not establish a recovery.

### R2 encrypted audit exports (`BACKUPS`)

`src/worker/backup-cron.ts` stores encrypted JSON returned by `infrastructureAuditExport()` in R2. This is useful evidence, but it is not a storage image and there is no importer. The current export omits at least:

- authoritative member rows and pool password hash/version and some pool settings;
- processed command fingerprints/responses and wager quote replay bindings;
- event and Super Bowl reconciliation, event snapshots, outbox attempts/errors/delivery, and actual alarm state;
- complete season lifecycle/bootstrap state and future schema rows not added to the exporter;
- D1 auth/directory/provider/projection/operational tables, Queue contents, and cross-store cut metadata.

**Current blocker:** audit JSON cannot reconstruct a PoolDO without fabricating omitted authority and replay state. It may corroborate restored data but must never be used as the restore source in the current repository.

### Worker versions, application quarantine, and migrations

Cloudflare Worker version rollback changes code, not connected D1/DO/R2/Queue data. Official [rollback documentation](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) also records binding and Durable Object migration restrictions. The production workflow applies D1 migrations before deploying code. PoolDO additive migration runs in its constructor.

A drill must pin an application version that understands the restored schema; code rollback is not database rollback. Before stage-2 accounting-pass, candidate, disposition, exception, or retry writers are enabled, the compatible Worker version must be recorded as the rollback floor. From writer enablement onward, pre-stage-2 rollback is prohibited even if no exception row is present, because an incomplete pass or another authoritative stage-2 row may already exist and old code does not honor it.

Configuration removal is not application quarantine in the inspected code. `PoolDO.alarm()` runs settlement whenever `DB` is bound; it does not consult `SETTLEMENT_SERVICE_TOKEN`, and restored D1 result rows are enough to drive accounting without an odds key. Native PoolDO alarms are independent of Worker Cron Triggers. Nominal reads also write: every PoolDO command path prunes expired `processed_command` rows, and message-board reads advance a watermark. Conversely, `src/index.ts` rejects ordinary application requests when Resend configuration is absent, so simply deleting `RESEND_API_KEY` cannot produce a usable read-validation app. These are additional current blockers: a future separately reviewed recovery artifact must provide code-level native-alarm, read-side-write, Queue, scheduler, provider, email, repair, canary, and other outbound quarantine while still exposing explicitly proven non-mutating validation reads. No such tooling is authorized by this runbook.

## Required approvals and roles

Before doing anything beyond document review, record:

- incident/drill owner and second reviewer;
- explicit parent/operator approval number and approved window;
- source recovery timestamp/bookmarks/export manifests;
- production account/resource IDs (reference only) and distinct isolated account/resource IDs;
- application commit/version, stage-2 authoritative-writer enablement state/time, and rollback floor;
- expected RPO/RTO and maximum accepted skew;
- credential owner and destruction date;
- notification/provider/scheduler/consumer disablement owner;
- go/no-go checkpoints and abort authority.

Use two-person review for any command that can mutate a Cloudflare resource. The executor reads the resolved account, config file, and resource name aloud/from captured output before approval. Never paste secret values into evidence, chat, command arguments, or source control.

## Phase 0 — preflight (mandatory stop in the current repository)

1. Verify official D1 and Durable Object recovery documentation again. Features, retention, plans, and Wrangler flags can change. Verify the installed `wrangler` version from `package-lock.json`/`npm exec wrangler -- --version` and its local help without authenticating to production.
2. Prove the source timestamp is within the account's actual retained history. Capture metadata/bookmark identifiers only; do not capture data or credentials.
3. Prove, from current official documentation and local CLI help, a supported method to restore/copy the selected D1 point into the isolated D1 destination without overwriting production.
4. Prove a supported method to restore/copy each selected production PoolDO point into the isolated DO namespace/object without mutating the source object.
5. Prove the source covers all required stores and includes enough command/result identity to reconcile accepted work around the cut. An `audit-*.json.aesgcm` object alone fails this check.
6. Verify the isolated Worker has no production custom route and cannot bind production D1, DO, Queue, or R2 by accidental config inheritance.
7. Prove in the exact future drill artifact that restored PoolDO native alarms cannot execute settlement or outbox work before validation, even when `DB` and restored alarm/result rows exist. Removing cron, odds credentials, or settlement service tokens is insufficient.
8. Enumerate every proposed validation read and prove by fixture storage snapshots that it cannot prune replay records, advance message-board watermarks, schedule/delete alarms, migrate destructively, enqueue output, or perform any other write. Do not label the current general PoolDO command/read path read-only.
9. Prove outbound/integration quarantine and application boot simultaneously: deny email/provider/Queue/repair/canary/service egress in code or bindings while explicitly non-mutating auth, membership, history, exception, ops, and health validation remains usable. Removing Resend configuration alone currently prevents those app requests and is not evidence.

**Current expected outcome:** steps 3, 4, and 7–9 cannot be satisfied by the verified capabilities above. Mark the drill `not_exercised — unsupported isolated recovery and quarantine path`, list every failed prerequisite, and stop. Do not continue to Phase 1. This is the safe and correct result until supported recovery/export-import and quarantine tooling is separately designed, implemented, reviewed, and approved.

If official documentation is unavailable or ambiguous at drill time, fail closed and stop. Cached snippets, memory, dashboard guesses, and this runbook are not sufficient authority for a destructive recovery command.

## Phase 1 — isolated environment preparation (future, only after Phase 0 passes)

Do not copy production `wrangler.jsonc` and edit it casually. Prepare a reviewed drill-only config/artifact with:

- a distinct Worker name and non-production hostname (or no public route);
- newly created isolated D1, SQLite Durable Object namespace/class migration, R2, and Queue resources;
- no production resource IDs or inherited bindings;
- a deny-by-default outbound email adapter; no `RESEND_API_KEY`;
- no `ODDS_API_KEY`, scheduled trigger, Queue consumer, settlement service token, projection producer, repair action, or canary trigger;
- fresh drill-only internal service-access keys, stored as isolated secrets and destroyed after cleanup; these keys must not grant settlement, projection, repair, canary, Queue, or outbound capability during validation;
- the original `POOL_COMMAND_AUTHENTICATOR_KEY` as a protected recovery dependency if password-bearing initialization/join/settings replay or D1 pool-creation replay identity is in scope. Those fingerprints HMAC the command ID and secret with this Worker key; a replacement key causes an idempotency conflict. Require separately approved, tightly isolated handling, never print it, and never rewrite restored fingerprints. If the original key is unavailable or use is not approved, mark those replay validations unsupported and do not claim a pass;
- a matching `BETTER_AUTH_SECRET` only if auth validation needs generated drill sessions; never copy production sessions/password credentials into an Internet-accessible drill app;
- the exact source application commit and compatibility date, plus only the schema migrations valid at the selected recovery cut.

Build and test the artifact locally with non-e2e checks before provisioning. A dry run validates packaging only; it does not validate remote recovery.

## Phase 2 — capture the recovery manifest

Before restoring, write an immutable manifest containing:

- drill/run ID, UTC start, approved recovery cut, source type, source bookmark/export checksum, destination resource IDs, and app version;
- one D1 cut identifier and one identifier per PoolDO; there is no cross-store atomic recovery point;
- earliest/latest recovered timestamps and calculated skew;
- pool registry IDs mapped to expected DO names/IDs without member/private data;
- commands, Queue deliveries, odds/result observations, and backups known to be in-flight around the cut;
- pre-restore destination-empty checks and configuration-disable checks.

If a pool has no validated source point, exclude it only if the approved scope explicitly allows a partial drill. Never create an empty “restored” PoolDO and count it as success.

## Phase 3 — restore into isolation

Use only exact commands/API calls copied from current official documentation and verified against pinned local CLI/types during the approved review. This runbook intentionally does not provide executable restore commands while the required isolated operations are unsupported.

For each operation:

1. Confirm target account and destination resource again.
2. Save command/tool version, start/end UTC, source identifier, destination identifier, exit status, and redacted output.
3. Abort on any prompt/output naming a production resource.
4. Keep all application traffic and background actions disabled.
5. Restore D1 and every PoolDO. Record order and completion times; order does not create atomicity.
6. Do not import audit JSON as tables, invent missing rows, renumber command versions, regenerate IDs, or replay user commands to fill gaps.

## Phase 4 — reconcile cross-store skew and uncertain commands

Choose and record one conservative effective recovery cut no later than the oldest successfully recovered authoritative store. Then reconcile; do not mutate merely to make counts agree.

For every pool:

- D1 `pool_registry` must map to exactly one restored PoolDO identity. D1 membership/season projections may lag and are disposable; PoolDO remains authoritative.
- Compare PoolDO command versions with projection versions and `projection_delivery`. A lagging projection is repairable only after core validation and by normal idempotent projection delivery; it is not authority.
- Identify every `processed_command`, share-order command ID, wager placement command ID/quote binding, correction command ID, outbox event ID, and Queue delivery near the skew window.
- A command present in PoolDO but absent from D1 projection/response evidence is accepted and must not be replayed as new. A D1 response/projection without corresponding PoolDO authority is suspect and must not authorize state.
- Preserve uncertain placement identity. Never submit a replacement wager to resolve an ambiguous recovered command.
- Compare event snapshots, season provider evidence, settlement result versions, reversal links, and reconciliation phase. Never replay an older result over a newer correction.
- Compare reduced-scope job observations with their recovered D1 evidence. If a future separately approved release adds operational repair/canary authority, its records and PoolDO effects would require explicit reconciliation; those features are not present in the current release.
- Queue/R2 do not share the D1/DO cut. Duplicate an idempotent projection only through the normal reviewed mechanism; do not fabricate Queue acknowledgements or mark exhausted outbox rows delivered.

Any unexplained accounting-authority mismatch fails the drill. Record unsupported reconstruction rather than patching it.

## Phase 5 — validation while all side effects remain disabled

### Structural and identity checks

- All expected pools initialize under the pinned code/schema without destructive migration.
- Pool ID/slug/DO mapping, pool commissioner, all members/roles/statuses, season states, and active-season pointer agree internally.
- Every accepted wager has its immutable quote/placement terms, owner, season, legs, snapshots, ruleset, offer proof, risk, and placement replay identity.
- `processed_command`, quote, share-order, correction, administration-audit, and outbox uniqueness constraints hold; exact replay returns the stored outcome and changed input conflicts.
- No hidden future wager selection is exposed by member/public/health/ops reads.

### Accounting checks

For each season/member, calculate with arbitrary-precision integers:

- `available_micros >= 0`, `locked_micros >= 0`, `float_micros >= 0`, and canonical integer text;
- account available/locked balances reconcile to all immutable ledger deltas from the season's opening state;
- season float/notional reconcile to corresponding immutable ledger/order deltas and the documented share-price calculation;
- open wager risk is represented exactly once in locked balance; won/lost/refunded wagers have no duplicate lock release;
- each non-reversed current settlement has a valid reversal chain, source result/version, outcome, odds/profit/return, ledger causation, and wager status;
- corrections reverse prior accounting and apply replacement accounting atomically; no partial reversal/replacement exists;
- open settlement exceptions retain evidence/retry intent and block automatic closure; a manual close never marks them recovered;
- season closure reason/time, unresolved wagers/exceptions, and active-season pointer satisfy the version's closure policy.

A single negative value, unexplained delta, duplicate effect, missing immutable term, or invalid reversal fails the drill.

### Lifecycle, operational, and projection checks

- Event/Super Bowl reconciliation deadlines, snapshots, retained provider evidence, and actual alarms are internally consistent. No missing alarm is repaired during validation.
- Exhausted outbox rows/errors remain present. They are not retried/reset as part of restore validation.
- D1 odds ingestion/events/results are evaluated at the recovered cut; current wall-clock staleness is expected and must not trigger provider calls.
- Backup manifests/checksums can corroborate but not override PoolDO authority.
- Latest job observations may be older/newer than PoolDO state. Unknown stays unknown. The current reduced scope has no operational notification sender.
- Rebuild projections only after authoritative checks pass, then prove resulting D1 projections are monotonic and match PoolDO versions. Keep Queue delivery isolated.

### Application read checks

Use only the explicitly quarantined, fixture-proven non-mutating integration reads admitted by Phase 0, not a browser smoke requirement. Verify authentication, membership authorization, pool/history/standings/wager/audit reads, commissioner-only exception inspection, ops allowlist, coarse public health, and deployed version without routing through current read commands that prune replay rows or advance watermarks. Keep native alarms, every mutation, and every outbound integration disabled. If the future artifact cannot reconcile application-read validation with side-effect suppression, stop and mark this section unsupported rather than weakening quarantine.

## Phase 6 — pass/fail, RPO/RTO, and cleanup

A drill passes only when every in-scope source restored through a supported isolated path and every required validation passed. Otherwise mark `failed` or `not_exercised`; never convert partial evidence into a pass.

Calculate:

- **Achieved RPO:** UTC drill incident/reference time minus the oldest effective cross-store recovery cut, including skew and excluded stores.
- **Achieved RTO:** UTC from declared drill start to completed validation, not merely restore-command completion.

Cleanup requires second-person approval:

1. Reconfirm resource IDs are isolated.
2. Export/redact only the evidence template below; do not retain secrets, session tokens, password hashes, hidden selections, raw member emails, or decrypted backups in general artifacts.
3. Destroy decrypted temporary data with the approved secure process.
4. Delete isolated routes, Worker, Queue, R2, DO namespace/script, D1, credentials, and local generated configs/state in the reviewed dependency order.
5. Verify production resources, schedules, versions, secrets, routes, and data were untouched.
6. Record leftovers that could not be deleted and an owner/deadline. Rotate any credential whose isolation is uncertain.

## Drill evidence template

```text
Drill ID:
Status: not_exercised | failed | passed
Approval/reference:
Owner / reviewer:
Started UTC / validation completed UTC:
Target RPO / achieved RPO:
Target RTO / achieved RTO:
Application commit / deployed drill version / schema versions:
Official docs checked UTC and URLs:
Pinned Wrangler version and relevant help captured:
Source D1 identifier/bookmark/checksum (non-secret):
Source PoolDO identifiers/bookmarks/checksums (non-secret):
Isolated destination resource IDs:
Background/email/provider/settlement/repair/canary disablement evidence:
Cross-store effective cut and measured skew:
Uncertain accepted commands and disposition:
Structural/identity validation: pass | fail + evidence
Accounting validation: pass | fail + evidence
Lifecycle/operational validation: pass | fail + evidence
Privacy/auth validation: pass | fail + evidence
Projection validation: pass | fail + evidence
Cleanup validation:
Production-untouched validation:
Unsupported reconstruction attempts: none (required)
Unresolved gaps, owner, deadline:
Final reviewer decision:
```

## Known current outcome and future prerequisite

At the inspected base, an approved isolated drill cannot pass: D1 Time Travel is destructive/in-place and has no verified clone/fork, Durable Object PITR is per-object/in-place with no repository endpoint or verified cross-namespace clone, R2 audit JSON is incomplete and has no importer, and the application has no proven quarantine that both suppresses native alarms/read-side writes/outbound work and permits validation. Password-bearing replay checks also depend on approved isolated access to the original command-authenticator key. The correct current action is to stop in Phase 0 and report these gaps.

A future proposal may add export/import, quarantine, or isolated-recovery tooling, but it is outside the approved operational-maturity increment and requires a separate accounting/security design and operator approval. Until then, do not claim a restorable backup or successful restore drill.

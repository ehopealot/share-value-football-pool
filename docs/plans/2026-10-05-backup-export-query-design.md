# Backup export query reduction

## Scope

Implement the approved first optimization only: infrastructure backups must not build the member-facing wager view that they immediately replace with raw wager rows.

## Design

Extract a private `sharedAuditExport` helper containing the existing non-wager export fields. Member exports compose those fields with `shapeAuditExportWagers`; infrastructure exports compose them with their existing raw wager, leg, snapshot, and message-board fields. Prefer this small extraction over a boolean mode on the public member-export function or duplicated field mappings.

Preserve payload fields and ordering, canonical integer strings, member kickoff privacy, missing/orphan snapshot checks, authorization, encryption, and backup cadence. No schema changes or other query optimizations.

## Validation

Use real DO SQLite with an exec-counting wrapper. Compare empty and populated exports to prevent query count growing per wager, check that member-shaping queries are absent, and compare shared output fields. Existing export tests cover member authorization/privacy, encrypted backup contents, and snapshot corruption failures. Run focused export tests and TypeScript locally; leave the full suite to CI. Do not run local e2e tests.

## Residuals

Backups still read all exported rows and materialize the payload in memory. Other member-view N+1 queries and backup scheduling are unchanged. Production CPU savings require post-deployment measurement; query-count reduction is not a latency guarantee.

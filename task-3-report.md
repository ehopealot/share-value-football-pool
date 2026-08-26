# Task 3B residual evidence

Implemented the adjudicated confirmation recovery taxonomy and strict local semantic smoke protocol.

New passing validation evidence:
- `npx vitest run tests/contracts/confirmation-protocol.test.ts tests/durable/wagers-settlement.test.ts tests/durable/orders-ledger.test.ts tests/durable/privacy-outbox.test.ts tests/worker/api.test.ts tests/worker/security.test.ts tests/web-wager-presentation.test.ts tests/web-entry.test.ts --maxWorkers=1` — 8 files, 49 tests passed (280.74s).
- `npm run test:local-smoke` — passed: semantic strict quote and authoritative explicit placement completed through settlement.
- `npm run typecheck` — passed.
- `npm run verify:owned-resource-cleanup` — passed: no tagged local process groups or persistence directories remain.
- `git diff --check` — passed.
- `git diff --cached --quiet` — passed.

## T3B residual adjudication repair

- Stale straight and teaser placement recovery now discards placement error replacement data, fetches the current odds board, re-resolves canonical semantic identities, retains only `wagerId`, and mints a fresh quote key before another quote can be requested.
- Added regression coverage for v1-to-v2 semantic recovery and expanded teaser request/response mismatch rejection; repaired share-order fixture quotes so every executed order uses its matching mode and amount.
- Focused validation (`tests/web-entry.test.ts`, `tests/contracts/confirmation-protocol.test.ts`, `tests/web-api.test.ts`, `tests/durable/privacy-outbox.test.ts`, `tests/worker/api.test.ts`) and typecheck pass.

## T3B final residual adjudication evidence

- `npx vitest run tests/web-entry.test.ts tests/contracts/confirmation-protocol.test.ts tests/web-api.test.ts --maxWorkers=1` — 3 files, 16 tests passed (2.81s).
- `npx vitest run tests/durable/privacy-outbox.test.ts --maxWorkers=1` — 1 file, 5 tests passed (73.53s).
- `npx vitest run tests/contracts/confirmation-protocol.test.ts tests/durable/wagers-settlement.test.ts tests/durable/orders-ledger.test.ts tests/durable/privacy-outbox.test.ts tests/worker/api.test.ts tests/worker/security.test.ts tests/web-wager-presentation.test.ts tests/web-entry.test.ts tests/web-api.test.ts --maxWorkers=1` — 9 files, 54 tests passed (380.04s).
- `npm run test:local-smoke` — passed.
- `npm run typecheck` — passed.
- `npm run verify:owned-resource-cleanup` — passed: no tagged local process groups or persistence directories remain.
- `git diff --check` — passed.
- `git diff --cached --quiet` — passed.

## T3B final residual fix 2

- Straight recovery now separates fetched semantic unavailability from retryable odds retrieval failure: an authoritative unavailable board replaces the board before clearing the editor; a failed fetch preserves the frozen confirmation for retry.
- Teaser recovery now clears its session slip only after a fetched board proves a requested leg unavailable. Failed odds retrieval preserves both the frozen confirmation and persisted slip.
- Added recovery taxonomy and immutable Confirmation/teaser-builder contract coverage.
- `npx vitest run tests/contracts/confirmation-protocol.test.ts tests/durable/wagers-settlement.test.ts tests/durable/orders-ledger.test.ts tests/durable/privacy-outbox.test.ts tests/worker/api.test.ts tests/worker/security.test.ts tests/web-wager-presentation.test.ts tests/web-entry.test.ts tests/web-api.test.ts --maxWorkers=1` — 9 files, 56 tests passed (304.93s).
- `npm run test:local-smoke`, `npm run typecheck`, `npm run verify:owned-resource-cleanup`, `git diff --check`, and `git diff --cached --quiet` — passed.
- Targeted existing T10 Playwright stale-straight scenario did not complete: it timed out before stale recovery while waiting for `Shares to issue`; no code/test change was made in response.

## T3B production lifecycle fix

- Repaired the stale production Playwright order locator to the current accessible `Amount` contract and updated stale odds selections to their current accessible button names.
- The actual straight LINE_CHANGED browser lifecycle now reaches v1 placement rejection, fetches v2, unmounts the frozen confirmation, shows the authoritative board/editor, requires a fresh quote/review, and successfully places it. `npm run test:e2e -- --workers=1 e2e/orders-and-wagers.spec.ts --grep "LINE_CHANGED replaces"` — 1 passed (25.4s); cleanup verifier passed immediately after.
- Added production-used straight/teaser lifecycle reducers, exercised by the page handlers, and tests for recovered/unavailable/terminal transitions. The reducer keeps the frozen confirmation on failed retrieval because the handler only invokes it after a successful odds response; teaser writes recovered legs or clears only confirmed unavailable legs.
- Completed independent response-binding mutations for straight offer ID; teaser quote key, season, risk, points, ruleset, and each leg offer ID. Confirmation isolation now passes conflicting editor-like runtime props for all three snapshot variants and verifies snapshots only render their frozen terms.
- Focused `npx vitest run tests/web-entry.test.ts tests/contracts/confirmation-protocol.test.ts tests/web-api.test.ts --maxWorkers=1` — 3 files, 18 tests passed (2.97s). `npm run typecheck`, `npm run test:local-smoke`, `git diff --check`, `git diff --cached --quiet`, and cleanup verifier passed.
- Full serial `e2e/orders-and-wagers.spec.ts` is currently not green: 4 passed / 7 failed. Remaining failures are pre-existing test/UI contract drift outside the T3B stale-straight blocker (missing reversal UI, teaser add-selection UI, order no-active-season UI, and changed error strings). Cleanup verifier passed after the browser run.

## T3B production lifecycle fix 2

- Restored the production odds-board `Add selection to teaser` action for eligible spread and total outcomes. It constructs a complete canonical teaser semantic leg from the displayed authoritative offer/outcome, rejects duplicate/opposing/max-leg additions, and writes the slug-scoped session slip.
- The two-leg browser journey now explicitly reloads the odds page between selection and teaser navigation, proving the persisted mixed spread/total slip remounts, reviews, and places. The teaser confirmation now renders each frozen leg's original/adjusted line, source price, and accepted teaser price.
- `npm run test:e2e -- --workers=1 e2e/orders-and-wagers.spec.ts --grep "two-leg teaser"` — passed (1 test, 33.8s).
- Exact focused nine-file command passed: 9 files, 57 tests, 345.98s. `npm run test:local-smoke`, `npm run typecheck`, `npm run verify:owned-resource-cleanup`, `git diff --check`, and `git diff --cached --quiet` passed.
- Full serial E2E was rerun after this change but remains red: 5 passed / 6 failed. The restored teaser journey passes; remaining failures are independently existing admin-order/reversal/no-active-season UI contract gaps and two stale expected error strings.

## T3B mounted-matrix follow-up — authoritative final evidence

**Current status: mounted-matrix acceptance is verified.** This status supersedes earlier serial-E2E status statements above.

- `npm run test:e2e -- --workers=1 e2e/orders-and-wagers.spec.ts` passed **11/11** enabled top-level tests serially in **3.0m**. The straight journey proves dropped-read retry with the same placement body/key, v2 recovery, then a real Worker `LINE_CHANGED` after `removeSelection:true`; its authoritative unavailable board unmounts Confirmation, focuses the unavailable alert, clears the straight editor/selection, and re-seeds/rebuilds a distinct final quote/placement. Its request ledger is five quote requests (three captured v1 replay-identical requests, v2, final re-seeded v1) and four placements (first two replay-identical; unavailable and final keys retired/distinct); the final placement mutation key is asserted distinct from the final re-seeded quote key.
- The teaser journey proves the first two placement bodies are exactly equal after the dropped exact-path odds response and that its slug session slip still contains both legs. It selects a non-default 6.5-point adjustment before review and proves real `MARKET_LOCKED` terminal rejection unmounts Confirmation while restoring risk 1, the same checked 6.5-point radio, both legs, and the persisted/remounted slip. It then proves a real `removeSelection:true` Worker `LINE_CHANGED` and authoritative unavailable board clear Confirmation, both legs/editor, and session slip across reload; re-seeding reconstructs current board legs and completes a final placement. Its request ledger is four distinct quote keys and five placements (first two replay-identical; terminal, unavailable, and final placement keys distinct; final placement key differs from the final quote key).
- The required focused command passed **9 files / 58 tests** in **273.71s**. `npm run test:local-response-barrier`, `npm run test:local-smoke`, `npm run typecheck`, `npm run verify:wrangler-parity`, `npm run verify:production-artifact`, `npm run verify:production-route-probe`, `npm run verify:owned-resource-cleanup`, `git diff --check`, and `git diff --cached --quiet` each exited 0.
- The mounted journeys use permitted local-only `/__local-test` controls for seeded state, canonical-offer changes, and response-barrier behavior; production exclusion remains proved because the artifact verifier reported separate normalized graphs (**15 production, 3 local files**) and the live generated production Worker returned 404 for GET, POST, and OPTIONS local-test routes.

No deployment, secret inspection, staging, commit, or push was performed. Residual risk is limited to normal local-browser/Wrangler timing variance; the required serial gate and cleanup checks passed after the production fix.

## T3C verified whole-T3 integration gate

**Verified 2026-08-24: passed; whole-T3 review remains pending.** The authoritative T3C audit is `.superpowers/sdd/2026-08-23-t10-structural-convergence/task-3c-report.md`.

- Every source/test/script/E2E construction or POST placement callsite was classified. There are no category-(c) legacy bypasses: successful durable privacy/outbox/settlement, Worker API, local smoke, and real-browser paths establish and use an authoritative quote; direct malformed/altered/stale/replay cases are intentional category-(b) rejection/no-mutation tests.
- Fresh serial evidence: `npm run test:e2e -- --workers=1 e2e/orders-and-wagers.spec.ts` exited 0 with exactly **11/11** enabled tests; the required focused Vitest command exited 0 with **9 files / 58 tests**; response barrier, local smoke, typecheck, Wrangler parity, production artifact, generated-production route probe, owned-resource cleanup, diff check, and staged-file check all exited 0.
- Replay-before-D1 remains tested at Worker HTTP and PoolDO layers; PoolDO quote binding/version/full-term checks remain before `placeWager` and the altered/malformed fixtures prove rejection without mutable wager/account/ledger/outbox effects.
- The production-route probe performed its required fresh `npm run build` before checking generated production `GET`, `POST`, and `OPTIONS /__local-test/*` 404 behavior. No application/test/configuration code was changed by T3C.

## Whole-T3 review fix round 1 — corrected current evidence

The earlier statement that altered/malformed fixtures proved all placement no-mutation effects was too broad: malformed coverage then covered quote projections, not malformed placements. Current executable evidence is in `.superpowers/sdd/2026-08-23-t10-structural-convergence/task-3c-report.md`.

After observed RED (Worker quote turnover expected 400, received 200), the Worker now rejects straight and teaser quote-time semantic/canonical turnover with `LINE_CHANGED` before PoolDO quote persistence; rejected keys replay as `QUOTE_NOT_FOUND`. Straight/teaser UI stale quote handling re-fetches the board, retains wagerId, rotates quoteKey, and requires explicit re-quote; failed fetch retains original authority for exact retry.

The durable matrix snapshots byte-equivalent `wager_quote`, `share_account`, `wager`, `wager_leg`, `ledger_entry`, `outbox`, and `processed_command` before/after altered (`LINE_CHANGED`), version-stale (`ORDER_QUOTE_STALE`), and malformed (`INVALID_COMMAND`) direct placements, including rejected-mutation-ID absence. Production-used transition and mounted-ledger assertions now cover retry retention, stale quote rotation with wager retention, terminal/edit retirement, Admin Orders stale rotation, and reversal retry key retention.

Verified after green: required serial E2E **11/11**, required focused Vitest **9 files / 62 tests**, response barrier, local smoke, typecheck, parity/artifact/route/cleanup verifiers, diff, and staged checks all exited 0. Whole-T3 review remains pending; this does not claim convergence.

## Whole-T3 review fix round 2 — corrected current evidence

This round makes the placement no-mutation matrix complete rather than relying on the earlier partial table list. The direct altered (`LINE_CHANGED`), version-stale (`ORDER_QUOTE_STALE`), and malformed (`INVALID_COMMAND`) placement snapshots now byte-compare ordered rows for `wager_quote`, `share_account`, `wager`, `wager_leg`, `wager_leg_snapshot`, `event_reconciliation`, `ledger_entry`, `outbox`, `processed_command`, and the authoritative `pool` row including `command_version`; stale is snapshotted after its intentional version advance. Each rejected mutation ID is absent from processed commands.

The mounted exactly-11-test Admin Orders stale journey now records real quote/execute POST identity ledgers for both shares and value: original quote key, distinct rejected mutation, unmounted review, distinct re-quote key, and distinct final mutation separate from both old mutation and new quote. No production code changed. Tests-first focused evidence passed immediately (2 files / 24 tests); serial E2E passed 11/11; required T3 focused suite passed 9 files / 62 tests; typecheck, cleanup, diff, and no-staged checks exited 0. Whole-T3 review remains pending.

## Whole-T3 final convergence

**T3A COMPLETE; T3B COMPLETE; T3C COMPLETE. Whole T3 is `CONVERGED` / `READY_FOR_T4`; T4 has not started.**

The fresh rereview returned `CONVERGED`: both round-2 findings are `ADDRESSED`, with no new findings or new Critical/Important regression. Artifact: `/tmp/share-value-pool-t3-whole-fix2-result.T3-whole-rereview-2.json`.

The fresh independent assessment returned `CONVERGED` and `t4MayStart: true`; it records independently rerun focused T3 Vitest (**9 files / 62 passed**), serial mounted Orders-and-Wagers E2E (**11/11** enabled), and typecheck, local response-barrier, local smoke, Wrangler parity, production artifact, generated-production GET/POST/OPTIONS local-test 404 probe, owned-resource cleanup, diff, and no-staged checks. Artifact: `/tmp/share-value-pool-t3-whole-fix2-result.T3-whole-reassess-2.json`.

Related recorded artifacts: T3C integration audit `/tmp/share-value-pool-t3c-whole-t3-result.T3C-integration-audit.json`; T3B assertion-quality convergence `/tmp/share-value-pool-t3b-assertion-quality-result.T3B-assertion-quality-review.json`. Residual risks remain ordinary local Wrangler/browser timing and untracked-checkout diff provenance as recorded by the independent assessment.

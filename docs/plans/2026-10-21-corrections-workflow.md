# Corrections Workflow Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Replace correction JSON entry with a wager-specific form and remove recent-auth requirements for void/regrade only.

**Architecture:** Keep the existing HTTP contracts and authoritative settlement engine. A selected wager opens an inline form, with one result per unique authorized event, read-only event/league, full team-name score labels, result status, and required audit reason. Generate correction versions inside the existing frozen-command factory so retries reuse both body and idempotency key. Void uses the same selection/reason/submit/cancel pattern without scores. No new endpoint or schema migration.

**Tech Stack:** React, TypeScript, Hono, Cloudflare Workers/Durable Objects, Vitest.

## Invariants and design

- Only commissioners can mutate corrections; authenticated sessions, origin checks, audit reasons, active-season and hidden-selection rules remain mandatory.
- Remove recent-auth checks only from the two corrections routes. Transfer, password rotation, and other protected operations are unchanged.
- No form or request may invent hidden events. Regrade is disabled for missing/hidden/unstarted legs, even when the commissioner owns a pre-kickoff ticket.
- Same-game legs produce one result. Scores are nonnegative safe integers; blank is not zero. Cancelled/no-contest results submit null scores.
- Older snapshots missing team names fall back to Home team/Away team. Known scores may prefill; unknown scores stay blank.
- Edits retire frozen commands; unchanged retries preserve automatically generated correction versions. Pending forms cannot be edited, cancelled, or replaced.
- Success closes the form, announces completion, and reloads current wagers/history. Failure retains inputs for retry.
- Preserve the compact square-edged existing visual system and mobile table scrolling. Focus the opened form; restore action focus on close.

## Task 1: Authorization regression tests and scoped change

Files: `tests/worker/t11-admin-api.test.ts`, `tests/worker/api.test.ts`, `src/worker/routes.ts`.

1. Update correction tests to expect successful stale-session void and regrade, and preserve anonymous/member/blank-reason/closed-season denials.
2. Run `npx vitest run --project=workers tests/worker/t11-admin-api.test.ts -t 'void and regrade'` and observe the expected 403 failure.
3. Delete only the recent-auth guard in each corrections route.
4. Rerun focused Worker tests, including transfer/password checks.

## Task 2: Workflow form and behavior tests

Files: `src/web/correction-results.ts`, `src/web/components/WagerCorrectionForm.tsx`, `src/web/pages/AdminCorrectionsPage.tsx`, `src/web/styles.css`, `tests/web-correction-form.test.ts`, `tests/web-corrections-display.test.ts`.

1. Add failing tests for unique prefills, missing/hidden/unstarted events, team labels, numeric validation, status null scores, auto versioning, unchanged retries, edits, cancel, void, and selected page state.
2. Run focused node tests and observe failures before implementation.
3. Implement small result-draft helpers, the form, and page selection wiring. Preserve immutable history.
4. Rerun focused tests and typecheck.

## Task 3: Existing browser coverage, verification, and delivery

Files: `e2e/same-game-export.spec.ts`, `e2e/privacy-and-settlement.spec.ts`.

1. Adapt existing browser tests to the new controls and generated version; age real sessions to cover both corrections without reauthentication. Do not run e2e locally.
2. Run `npm run typecheck`, focused node/Worker tests, `git diff --check`, and the UI mechanical detector. Review desktop/mobile form rendering if feasible without e2e execution.
3. Obtain a read-only review, fix substantive findings, commit, push feature branch, and open a PR against main. CI is the full-suite/e2e gate; do not merge or deploy without green CI.

## Residuals

No live score polling is added. Started-game eligibility uses the loaded authorized projection and browser time for UX; the server remains authoritative. A failed or lost response retains retry identity until an edit/cancel, matching existing admin command behavior.

# Operations Readability Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Make the read-only operations page understandable at a glance without overstating health.

**Architecture:** Frontend-only presentation helpers and scoped styles, retaining the current configuration/jobs/inspection layout and request-generation safeguards. Relative times are frozen at an explicitly labeled snapshot reference, with exact browser-local timestamps and timezone always visible. No polling, backend changes, repair actions, or new monitoring.

**Tech Stack:** React, TypeScript, existing CSS, Vitest node tests.

## Approved design
- Green plus text for a recent successful check, amber for stale evidence/passed scheduling times, red for failed jobs/exhausted deliveries, gray for unknown/disabled/neutral observations.
- A recent `not_due` check means no work was due, not completed work. Configuration readiness is not service health. Pool inspection success means a snapshot was collected, not that all work is healthy.
- Explain reconciliation as event/result checks, discovery as championship-event discovery, and outbox as queued deliveries. Pending work alone is not a failure.
- Keep job diagnostic categories available with readable descriptions. Null schedules mean none observed only in a readable initialized inspection; invalid evidence stays unknown.
- Snapshot labels explicitly state that relative times/statuses do not update automatically; users reload or inspect again for a new snapshot.

## Task 1: Presentation tests and helpers
Files: create `src/web/ops-presentation.ts`, `tests/web-ops-presentation.test.ts`.
1. Add tests for past/future/null/invalid timestamps, exact timezone-bearing local formatting, job outcome/freshness combinations, and passed versus future schedules.
2. Run `npx vitest run --project=node tests/web-ops-presentation.test.ts`; confirm missing implementation fails.
3. Implement minimal pure formatting/classification helpers, with fail-closed unknown statuses and no new dependencies.
4. Repeat focused tests; require pass.

## Task 2: Readable page and styling
Files: modify `src/web/pages/OpsPage.tsx`, `src/web/styles.css`, `tests/web-ops-page.test.ts`.
1. Extend the existing lightweight render tests to assert badges, plain-English explanations, exact and relative timestamps, explicit snapshot caveats, pending-neutral and unknown-inspection semantics.
2. Run `npx vitest run --project=node tests/web-ops-page.test.ts`; confirm new expectations fail.
3. Render shared time/badge components and scoped configuration/inspection styling with a keyboard-accessible horizontally scrollable jobs table. Preserve captured pool identity and generation checks.
4. Run both UI tests plus `tests/operations-reduced-scope.test.ts`; require pass.

## Task 3: Verify, review, and PR
1. Run `npm run typecheck`, focused node tests above, and `git diff --check`.
2. Obtain an independent read-only review; explicitly forbid e2e tests. Address supported findings and reverify.
3. Commit and open a PR against main. Let CI run the full suite; do not merge or deploy. No local e2e tests.

## Residuals
No continuous refresh or whole-pool health inference. Local timezone comes from the operator browser. Automated render tests do not replace a visual browser review; full regression testing remains with CI.

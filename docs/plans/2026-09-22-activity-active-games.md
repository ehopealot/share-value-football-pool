# Activity Active Games Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add an off-by-default Activity toggle labeled “Active games only”, with empty text “There are no bets right now”.

**Architecture:** Filter whole tickets in the selected week when any visible leg has reached kickoff and is black/ungraded, per the user's clarification. Keep all legs and hidden-leg placeholders on qualifying tickets, preserve weekly member P&L, and omit members with no matching tickets. Reuse current client data; no provider/API/schema changes, polling, or persistence.

**Tech Stack:** React, TypeScript, Vitest, existing table/control styles.

## Task 1: Active-game predicate
- Update `tests/web-activity-presentation.test.ts` first: started ungraded, exact kickoff, future owner legs, graded legs, mixed parlays, missing/invalid kickoff, and redacted tickets.
- Run `npm test -- tests/web-activity-presentation.test.ts`; confirm failure before adding `hasActiveActivityGame(wager, now)` to `src/web/activity-presentation.ts`.
- Implement using the same neutral grade classification as the black wager lines and `Date.parse(leg.eventStartsAt) <= now`. Re-run tests.

## Task 2: Activity control and filtering
- Add `tests/web-activity-active-games.test.ts` for default-off, toggle both ways, whole-ticket retention, member omission, selected-week scope, weekly P&L preservation, and empty states.
- Run the new test and confirm failures, then update `src/web/pages/ActivityPage.tsx`: unconditional boolean state, accessible native checkbox by the week selector, filter grouped member wagers with one captured time per render, and exact empty-state text. Keep controls available when filtering produces no rows.
- Match existing utilitarian form styling; add only scoped checkbox layout if needed.

## Task 3: Explicit zero member P&L (user follow-up)
- Change the Activity member summary to `+0.00 shares` for zero net P&L, including offsetting wins/losses. Keep individual row P&L behavior unchanged.
- First update `tests/web-activity-presentation.test.ts` and add rendered coverage in `tests/web-activity-active-games.test.ts`; confirm failure before modifying the formatter and ribbon. Preserve the full weekly net when filtering.

## Task 4: Validate and deliver
- Run targeted Activity and wager presentation regressions, `npm run typecheck`, and `git diff --check`.
- Review diff, commit, push, create a separate PR against main. Full suite/E2E left to CI; do not run E2E locally.

## Residuals
- “Active” intentionally matches the existing black/ungraded display, not an independent provider live-status signal. A finished game remains active until its grade is reflected in loaded Activity data. Activity keeps its existing load-on-visit behavior; no live refresh is introduced.

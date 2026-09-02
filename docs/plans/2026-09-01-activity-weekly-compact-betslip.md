# Activity Weekly Summary and Compact Bet Slip Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Present Activity as a compact, kickoff-week-filtered member ledger with weekly performance totals and make the Odds board bet slip compact on mobile.

**Architecture:** Add only a safe `weekStart` to each read-model wager, calculated server-side from the ticket's kickoff. The browser filters by this non-sensitive value, sums settled `profitMicros` by member (open tickets are zero), and renders a compact single table. Bet-slip work is presentational: preserve selection, risk, and validation behavior while applying targeted compact CSS and a text-style Remove button.

**Tech Stack:** Cloudflare Durable Objects/SQLite, TypeScript, React, Vitest, Playwright, CSS.

---

### Task 1: Add safe activity week metadata to the read contract

**Files:**
- Modify: `src/durable/views.ts`
- Modify: `src/contracts/http.ts`
- Test: `tests/durable/t11-member-reads.test.ts`
- Test: `tests/contracts/t11-read-contracts.test.ts`

**Step 1: Write failing tests**
- Require `weekStart` on member-visible wager records.
- Assert it is the Monday/week-start derived from a ticket leg's `eventStartsAt`, including when a non-owner ticket's legs remain redacted.

**Step 2: Run the targeted tests to verify RED**
Run: `npx vitest run --project=node --project=workers tests/contracts/t11-read-contracts.test.ts tests/durable/t11-member-reads.test.ts`
Expected: failing assertions/schema validation because `weekStart` does not exist.

**Step 3: Implement the minimal projection**
- Select the earliest `wager_leg.event_starts_at` with each wager.
- Convert it to a canonical UTC Monday-start ISO timestamp.
- Add `weekStart` to the redaction-safe root wager shape and require it in `memberWager`.

**Step 4: Run targeted tests to verify GREEN**
Run the command from Step 2.
Expected: passing.

### Task 2: Build pure weekly Activity presentation helpers

**Files:**
- Create: `src/web/activity-presentation.ts`
- Test: `tests/web-activity-presentation.test.ts`

**Step 1: Write failing tests**
- Group week-selected wagers by display member.
- Sum only `profitMicros`, treating an absent/open profit as `0`.
- Format spread, moneyline, and total picks into ordered segments that bold only the selected team/total.
- Produce one formatted line per teaser leg.

**Step 2: Run the targeted test to verify RED**
Run: `npx vitest run --project=node tests/web-activity-presentation.test.ts`
Expected: import/module failure.

**Step 3: Implement the smallest helpers**
- Use integer micros and the existing display formatter—never floating-point math.
- Keep redacted/no-leg wagers as an explicit hidden-selection representation.

**Step 4: Run the targeted test to verify GREEN**
Run the command from Step 2.
Expected: passing.

### Task 3: Replace Activity's repeated member tables with the compact weekly view

**Files:**
- Modify: `src/web/pages/ActivityPage.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/accessibility/table-reflow.test.ts`
- Test: `e2e/privacy-and-settlement.spec.ts`

**Step 1: Write failing UI/E2E expectations**
- Require an accessible Week selector that defaults to the most recent available week.
- Require one compact activity table with member-week summary, wager, result, and P/L columns.
- Require bolded selected side/total and multiline teaser legs.
- Keep a redacted ticket's selection hidden.

**Step 2: Run the relevant tests to verify RED**
Run: `npx vitest run --project=node tests/accessibility/table-reflow.test.ts && LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu npm run test:e2e -- e2e/privacy-and-settlement.spec.ts --grep 'activity stays immutable'`
Expected: failures because the selector and compact cells are absent.

**Step 3: Implement the minimal Activity UI**
- Build unique week choices from safe `weekStart`, select the latest by default, and filter the table.
- Render per-member grouping rows with formatted signed share performance.
- Render own/revealed selections with semantic `<strong>` tags; retain the redaction copy for hidden tickets.
- Use compact table styling that remains horizontally scrollable and readable on mobile.

**Step 4: Run the relevant tests to verify GREEN**
Run the command from Step 2.
Expected: passing.

### Task 4: Compact the Odds board bet slip

**Files:**
- Modify: `src/web/pages/OddsPage.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/accessibility/touch-target.test.ts`
- Test: `e2e/responsive-a11y.spec.ts`

**Step 1: Write failing tests**
- Require Remove to have a compact text-button class while preserving a 44px mobile target.
- Add responsive assertion that compact slip rows retain their risk field and remove control.

**Step 2: Run targeted tests to verify RED**
Run: `npx vitest run --project=node tests/accessibility/touch-target.test.ts && LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu npm run test:e2e -- e2e/responsive-a11y.spec.ts`
Expected: failure because the compact text-control behavior is absent.

**Step 3: Implement the minimal presentation changes**
- Add a semantic button class to Remove without altering the handler.
- Tighten desktop spacing; on narrow screens stack only the detail/risk layout while keeping the text-style button's touch box at least 44px.

**Step 4: Run targeted tests to verify GREEN**
Run the command from Step 2.
Expected: passing.

### Task 5: Verify and review

**Files:**
- Review changed source and test files

**Step 1: Run complete verification**
Run: `npm test -- --maxWorkers=7 && npm run typecheck && git diff --check`
Expected: all tests, typecheck, and whitespace validation pass.

**Step 2: Run code review**
- Request a read-only review of the diff, especially privacy/redaction, UTC week grouping, fixed-point totals, and mobile touch targets.

**Step 3: Commit after review**
```bash
git add src/durable/views.ts src/contracts/http.ts src/web/activity-presentation.ts src/web/pages/ActivityPage.tsx src/web/pages/OddsPage.tsx src/web/styles.css tests e2e docs/plans/2026-09-01-activity-weekly-compact-betslip.md
git commit -m "Compact weekly activity and bet slip"
```

# Wager Start Times and P&L Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Show and sort each bettor’s wagers chronologically by event start time, while replacing My Bets’ odds column with Activity-style P&L.

**Architecture:** Add small pure presentation helpers that derive a wager’s earliest leg start for ordering and provide a displayable kickoff only for straight bets. My Bets will sort both its open and settled sections with that helper; Activity will preserve its existing member group order and only sort the wagers inside each group.

**Tech Stack:** React 19, TypeScript, Vitest.

---

### Task 1: Specify chronological wager presentation with failing tests

**Files:**
- Modify: `tests/web-wager-presentation.test.ts`
- Modify: `tests/web-activity-presentation.test.ts`

**Step 1: Write the failing tests**

Add a wager fixture with multiple legs and assert that:
- a straight wager exposes its one kickoff for display;
- a parlay/teaser has no displayed start time;
- sorting uses the earliest leg, falls back deterministically for hidden or malformed tickets;
- `groupActivityMembersForWeek` retains member groups but sorts each group’s wagers earliest-first.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --project=node tests/web-wager-presentation.test.ts tests/web-activity-presentation.test.ts`

Expected: FAIL because the requested helpers and ordering do not exist.

### Task 2: Add reusable wager-time presentation helpers

**Files:**
- Modify: `src/web/wager-presentation.ts`
- Test: `tests/web-wager-presentation.test.ts`

**Step 1: Implement the minimal helpers**

Add helpers that find a wager’s earliest valid leg start, return a formatted local start only when its type is `straight`, and return a copied earliest-first list with stable confirmation/id fallback ordering.

**Step 2: Run tests to verify they pass**

Run: `npx vitest run --project=node tests/web-wager-presentation.test.ts`

Expected: PASS.

### Task 3: Apply the helpers to My Bets and Activity

**Files:**
- Modify: `src/web/pages/MyWagersPage.tsx`
- Modify: `src/web/activity-presentation.ts`
- Modify: `src/web/pages/ActivityPage.tsx`
- Test: `tests/web-activity-presentation.test.ts`
- Test: `tests/web-activity-page.test.ts`

**Step 1: Update My Bets**

Sort open and settled rows separately earliest-first. Add the Odds-board-style `Start` column, leave it blank for parlays, replace `Odds` with `P&L`, and use the existing Activity P&L formatting for zero/settled values.

**Step 2: Update Activity**

Sort only `wagers` inside every existing member/week group earliest-first. Keep member group order and row spans unchanged. Add a `Start` column with the same straight-only display rule.

**Step 3: Run tests to verify they pass**

Run: `npx vitest run --project=node tests/web-wager-presentation.test.ts tests/web-activity-presentation.test.ts tests/web-activity-page.test.ts`

Expected: PASS.

### Task 4: Verify the feature

**Files:**
- Verify: changed files above

**Step 1: Type-check and run focused tests**

Run:
```bash
npm run typecheck
npx vitest run --project=node tests/web-wager-presentation.test.ts tests/web-activity-presentation.test.ts tests/web-activity-page.test.ts
```

Expected: both commands pass.

**Step 2: Review the worktree**

Run:
```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only the planned files changed.

**Step 3: Commit**

```bash
git add docs/plans/2026-09-03-wager-start-times-and-pnl.md src/web/wager-presentation.ts src/web/activity-presentation.ts src/web/pages/MyWagersPage.tsx src/web/pages/ActivityPage.tsx tests/web-wager-presentation.test.ts tests/web-activity-presentation.test.ts tests/web-activity-page.test.ts
git commit -m "feat: order wagers by start time"
```

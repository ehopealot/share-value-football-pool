# Refunded Wager P&L Color Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Color a refunded wager's displayed `0.00` P&L blue in Activity and My Bets, while a wager that wins despite a pushed leg remains green.

**Architecture:** Reuse the existing overall-wager outcome-to-P&L-class mapper. Add a dedicated refund class only for terminal `refunded` outcomes; leg-grade presentation remains unchanged. Both pages already consume the mapper, so the behavior is shared without page-specific branches.

**Tech Stack:** TypeScript, React, CSS, Vitest.

---

### Task 1: Specify blue refunded P&L

**Files:**
- Modify: `tests/web-activity-presentation.test.ts`
- Modify: `tests/web-my-wagers-page.test.ts`

**Step 1: Write the failing test**

Assert that `activityWagerPerformanceClass` returns `activity-performance-refunded` for a refunded wager and that the stylesheet gives it the approved blue (`#1a73e8`). Preserve assertions that won/lost tickets are green/red.

**Step 2: Run test to verify it fails**

Run: `npx vitest run --project=node tests/web-activity-presentation.test.ts tests/web-my-wagers-page.test.ts`

Expected: FAIL because refunded P&L has no class or blue rule.

**Step 3: Write minimal implementation**

Extend `activityWagerPerformanceClass` to map the terminal `refunded` outcome to `activity-performance-refunded`, then add the matching blue CSS rule alongside the existing performance colors.

**Step 4: Run test to verify it passes**

Run: `npx vitest run --project=node tests/web-activity-presentation.test.ts tests/web-my-wagers-page.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/web/activity-presentation.ts src/web/styles.css tests/web-activity-presentation.test.ts tests/web-my-wagers-page.test.ts
git commit -m "fix: color refunded wager P&L blue"
```

### Task 2: Validate and publish the separate PR

**Files:**
- Modify: `docs/plans/2026-09-05-refunded-wager-pnl-color.md`

**Step 1: Run validation**

```bash
npm test -- --maxWorkers=5
npm run typecheck
git diff --check
```

Expected: all non-e2e CI tests and typecheck pass.

**Step 2: Review, commit, and open PR**

Request a read-only expert code review, address blockers if any, then push `fix/refunded-wager-pnl-color` and open a PR against `main`.

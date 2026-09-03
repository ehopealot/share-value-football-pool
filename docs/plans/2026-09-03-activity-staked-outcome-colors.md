# Activity Staked and Outcome Colors Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Show each Activity wager's whole-share stake and accepted odds, and color only the selected wager text by the wager result.

**Architecture:** Add small presentation helpers so Activity can format redacted or complete wager terms consistently. The page keeps its single Wager column; it supplies the wager outcome to semantic selected-leg rendering and adds a Staked column. CSS owns the green/red appearance so markup remains accessible and neutral text is unchanged.

**Tech Stack:** React, TypeScript, Vitest, CSS.

---

### Task 1: Cover Activity stake and outcome presentation

**Files:**
- Modify: `tests/web-activity-presentation.test.ts`
- Modify: `tests/web-activity-page.test.ts`

**Step 1: Write the failing tests**

```ts
expect(formatActivityStake({ riskMicros: "100000000", acceptedOdds: 150 })).toBe("100 +150");
expect(activityOutcomeClass("won")).toBe("activity-picked-won");
```

Assert that the Activity table contains the `Staked` header and its selected text receives the result class.

**Step 2: Run tests to verify failure**

Run: `npx vitest run --project=node tests/web-activity-presentation.test.ts tests/web-activity-page.test.ts`
Expected: FAIL because the helpers and Staked rendering do not exist.

**Step 3: Commit**

```bash
git add tests/web-activity-presentation.test.ts tests/web-activity-page.test.ts
git commit -m "test: specify Activity stake and outcome colors"
```

### Task 2: Render Activity stake and selected-pick outcomes

**Files:**
- Modify: `src/web/activity-presentation.ts`
- Modify: `src/web/pages/ActivityPage.tsx`
- Modify: `src/web/styles.css`

**Step 1: Write minimal implementation**

```ts
export const formatActivityStake = (wager) =>
  wager.riskMicros && wager.acceptedOdds ? `${BigInt(wager.riskMicros) / 1_000_000n} ${formatAmericanOdds(wager.acceptedOdds)}` : "";
```

Map won/lost outcomes to a selected-text CSS class. Add the `Staked` column and apply that class only to selected segments. Define outcome colors in CSS and leave open/refunded selections uncolored.

**Step 2: Run focused tests to verify passing**

Run: `npx vitest run --project=node tests/web-activity-presentation.test.ts tests/web-activity-page.test.ts`
Expected: PASS.

**Step 3: Commit**

```bash
git add src/web/activity-presentation.ts src/web/pages/ActivityPage.tsx src/web/styles.css
git commit -m "feat: show Activity stakes and outcomes"
```

### Task 3: Verify and update the existing PR

**Files:**
- Verify: `src/web/activity-presentation.ts`
- Verify: `src/web/pages/ActivityPage.tsx`
- Verify: `src/web/styles.css`

**Step 1: Run focused regression suite**

Run: `npx vitest run --project=node tests/web-wager-presentation.test.ts tests/web-odds-display.test.ts tests/web-activity-presentation.test.ts tests/web-activity-page.test.ts tests/web-my-wagers-page.test.ts`
Expected: PASS.

**Step 2: Run typecheck and whitespace check**

Run: `npm run typecheck && git diff --check`
Expected: both exit 0.

**Step 3: Commit and push**

```bash
git add docs/plans/2026-09-03-activity-staked-outcome-colors.md
git commit -m "docs: plan Activity stake display"
git push
```

# Activity Multi-Leg Progress Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Show started legs and their individual grades on public Activity multi-leg wagers while retaining a concise privacy placeholder for every unstarted leg.

**Architecture:** The Durable Object already returns only started legs to non-owners, so preserve that privacy boundary. Add a public `hiddenLegCount` to the activity wager projection, then render the revealed legs plus a neutral placeholder row when the count is non-zero. The Activity component owns presentation-only row and `rowSpan` handling.

**Tech Stack:** Cloudflare Durable Objects with SQLite, TypeScript, React, Vitest.

---

### Task 1: Return the count of still-hidden public legs

**Files:**
- Modify: `src/durable/views.ts:24-37`
- Test: `tests/durable/t11-member-reads.test.ts`

**Step 1: Write the failing test**

Create a non-owner Activity read for a multi-leg wager with two started legs and two future legs. Assert that the response contains only the two started `legs` and `hiddenLegCount: 2`; assert that a fully unstarted non-owner wager retains no `legs` and uses `hiddenLegCount` for its privacy placeholder.

**Step 2: Run test to verify it fails**

Run: `npx vitest run --project=workers tests/durable/t11-member-reads.test.ts`

Expected: FAIL because Activity response does not include `hiddenLegCount`.

**Step 3: Write minimal implementation**

Count all stored wager legs before applying the existing reveal policy. For a non-owner started-only Activity projection, add `hiddenLegCount: totalLegs - revealed.length` when that value is positive. Do not add it to owner-only reads or expose any unrevealed leg data.

**Step 4: Run test to verify it passes**

Run: `npx vitest run --project=workers tests/durable/t11-member-reads.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/durable/views.ts tests/durable/t11-member-reads.test.ts
git commit -m "feat: expose hidden activity leg count"
```

### Task 2: Render revealed legs, grades, and hidden-leg placeholder rows

**Files:**
- Modify: `src/contracts/http.ts` (if public Activity contract requires `hiddenLegCount`)
- Modify: `src/web/pages/ActivityPage.tsx:18-34`
- Test: `tests/web-activity-member-ribbons.test.ts`

**Step 1: Write the failing test**

Render a public four-leg Activity wager with two revealed legs (`grade: "win"` and `grade: "loss"`) and `hiddenLegCount: 2`. Assert that it renders two correctly classed revealed rows and a neutral row whose text is exactly `2 other selections hidden until game time.` Also render an entirely hidden multi and assert it retains `Selection hidden until game time.`

**Step 2: Run test to verify it fails**

Run: `npx vitest run --project=node tests/web-activity-member-ribbons.test.ts`

Expected: FAIL because Activity currently has no hidden-leg count or placeholder row.

**Step 3: Write minimal implementation**

Build Activity rows from visible legs, then append one neutral placeholder row when `hiddenLegCount > 0`. Include it in the stake and P&L `rowSpan`; do not give it a kickoff time. Preserve the existing fully-hidden single-row rendering and use the `activity-leg-neutral` class for the placeholder. Started leg rows continue to derive their grade class directly from `leg.grade`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run --project=node tests/web-activity-member-ribbons.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/contracts/http.ts src/web/pages/ActivityPage.tsx tests/web-activity-member-ribbons.test.ts
git commit -m "feat: show Activity multi-leg progress"
```

### Task 3: Validate the integrated public Activity contract

**Files:**
- Test: `tests/durable/t11-member-reads.test.ts`
- Test: `tests/web-activity-member-ribbons.test.ts`
- Test: `tests/web-activity-presentation.test.ts`

**Step 1: Run focused integration checks**

Run:

```bash
npx vitest run --project=workers tests/durable/t11-member-reads.test.ts
npx vitest run --project=node tests/web-activity-member-ribbons.test.ts tests/web-activity-presentation.test.ts
npm run typecheck
```

Expected: all focused tests and typecheck pass.

**Step 2: Review the diff**

Run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
```

Expected: no whitespace errors and only Activity projection/presentation/test changes.

**Step 3: Commit any final test-only adjustments**

```bash
git add tests
git commit -m "test: cover Activity multi-leg progress"
```

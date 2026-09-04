# Early Multi-Leg Loss Settlement Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Settle parlays and teasers immediately when any terminal leg loses while preserving idempotent accounting, provider-correction recovery, and season lifecycle safety.

**Architecture:** Extend the PoolDO settlement decision from an all-results gate to a type-aware decision: multi-leg losses are decisive with partial evidence, while every non-loss outcome remains all-final. Reuse immutable settlement reversals for subsequent result versions and reopen only prior automatic partial-loss settlements when a correction removes the decisive loss.

**Tech Stack:** TypeScript, Cloudflare SQLite Durable Objects, D1 result snapshots, Vitest Workers pool.

---

### Task 1: Document the changed rule

**Files:**
- Modify: `docs/plans/2026-09-02-parlays-six-leg-cap-design.md`
- Modify: `docs/plans/2026-09-02-parlays-six-leg-cap.md`
- Modify: `src/web/pages/RulesPage.tsx`
- Test: `tests/web-rules-page.test.ts`

**Step 1:** Change the parlay and teaser Rules assertions to require immediate settlement after any final losing leg.

**Step 2:** Run `npx vitest run --project=node tests/web-rules-page.test.ts` and verify it fails on the existing all-final copy.

**Step 3:** Update RulesPage and superseded design/plan text so loss is immediate while wins and refunds wait for all legs.

**Step 4:** Re-run the targeted Rules test and verify it passes.

### Task 2: Reproduce early-loss accounting

**Files:**
- Modify: `tests/durable/wagers-settlement.test.ts`

**Step 1:** Replace the existing parlay partial-loss assertion with expectations that the wager is lost, risk is unlocked and burned once, the losing leg is graded, and the pending leg stays ungraded.

**Step 2:** Add the equivalent teaser test and assertions that partial win/push/void evidence does not settle either wager type.

**Step 3:** Run `npx vitest run --project=workers tests/durable/wagers-settlement.test.ts` and verify the new assertions fail because `settleWagers` still requires every event result.

### Task 3: Implement the minimal early-loss decision

**Files:**
- Modify: `src/durable/settlement.ts`

**Step 1:** Let `gradeResults` pass partial grades to teaser/parlay grading, both of which already give loss precedence before rejecting pending legs. Keep straight wagers and non-loss multi-leg outcomes pending.

**Step 2:** In `settleWagers`, build canonical evidence from available snapshots, compare only observed leg versions, settle a partial multi-leg loss, and update only legs with observed results.

**Step 3:** Re-run the durable settlement test and verify the early parlay/teaser tests pass.

### Task 4: Preserve correction and closure safety

**Files:**
- Modify: `tests/durable/wagers-settlement.test.ts`
- Modify: `src/durable/settlement.ts`

**Step 1:** Add failing tests proving unchanged retries are no-ops, later terminal evidence reverses/reapplies without net balance changes, correction of the only losing leg reopens and re-locks the wager, a remaining loss keeps it lost, and partial evidence cannot reopen commissioner-authored settlement.

**Step 2:** Add a failing zero-float test proving an early-settled ticket with a pending leg does not close the season.

**Step 3:** Implement automatic-partial-loss detection from the active system settlement's stored evidence. When current partial evidence is no longer decisive, append its reversal and set the wager back to `open`; otherwise use the existing reversal/replacement path for changed decisive evidence.

**Step 4:** Treat multi-leg wagers with ungraded legs as unresolved in both float-exhaustion and Super Bowl closure checks.

**Step 5:** Run the durable settlement test until all lifecycle and accounting assertions pass.

### Task 5: Validate and review

**Files:**
- Verify: `src/durable/settlement.ts`
- Verify: `tests/durable/wagers-settlement.test.ts`
- Verify: `tests/web-rules-page.test.ts`

**Step 1:** Run `npx vitest run --project=workers tests/durable/wagers-settlement.test.ts`.

**Step 2:** Run `npx vitest run --project=node tests/web-rules-page.test.ts`.

**Step 3:** Run `npm run typecheck` and `npm run build`.

**Step 4:** Request code review focused on ledger reversibility, result-version idempotency, manual-correction authority, and season closure.

**Step 5:** Address material findings, re-run targeted validation, commit, push the branch, and open a pull request. Let CI run the complete suite; do not run E2E unless CI identifies a related failure.

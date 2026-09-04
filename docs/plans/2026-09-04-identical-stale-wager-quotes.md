# Identical Stale Wager Quotes Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Place straight wagers, teasers, and parlays after unrelated pool commands advance the command version, provided every confirmed wager term is identical.

**Architecture:** Keep quotes immutable and retain exact quote-version and term matching. Remove only the requirement that the pool's current command version still equal the stored quote version; current offer revalidation and all authoritative placement checks remain in force.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, Vitest

---

### Task 1: Specify identical-term quote rebasing

**Files:**
- Modify: `tests/durable/wagers-settlement.test.ts`

**Step 1: Write the failing test**

Add coverage that quotes each of `PlaceStraightWager`, `PlaceTeaserWager`, and `PlaceParlayWager`, advances the pool version with an unrelated valid command, then places the exact quoted terms successfully. Retain a separate assertion that a placement whose `quotedCommandVersion` does not match its stored quote is rejected.

**Step 2: Run the focused test to verify it fails**

Run: `npx vitest run --project=workers tests/durable/wagers-settlement.test.ts`

Expected: FAIL because exact placements are currently rejected with `ORDER_QUOTE_STALE` after the pool version advances.

### Task 2: Permit exact stored wager terms on the current state

**Files:**
- Modify: `src/durable/pool-do.ts`

**Step 1: Implement the minimal change**

Require `quotedCommandVersion` to match the stored quote version, but do not reject solely because `pool.command_version` advanced. Keep the complete canonical stored-term comparison before `placeWager`.

**Step 2: Run the focused test**

Run: `npx vitest run --project=workers tests/durable/wagers-settlement.test.ts`

Expected: PASS.

**Step 3: Run static and focused Worker validation**

Run: `npm run typecheck`

Run: `npx vitest run --project=workers tests/worker/api.test.ts tests/worker/deterministic-reader-snapshot.test.ts`

Expected: PASS. Do not run E2E locally; CI owns the full suite per project guidance.

### Task 3: Review and deliver

**Files:**
- Review all changed files

**Step 1: Inspect the diff and repository status**

Run: `git diff --check && git diff && git status --short`

**Step 2: Commit**

Run: `git add docs/plans/2026-09-04-identical-stale-wager-quotes-design.md docs/plans/2026-09-04-identical-stale-wager-quotes.md tests/durable/wagers-settlement.test.ts src/durable/pool-do.ts && git commit -m "fix: place identical stale wager quotes"`

**Step 3: Push and open a pull request**

Push `fix/stale-quote-identical-terms` and open a PR against `main`, then let CI run the complete test suite.

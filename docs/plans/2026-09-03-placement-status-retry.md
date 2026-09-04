# Placement Status Retry Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Automatically replay an ambiguous wager placement at +2 seconds and +10 seconds before showing the existing unknown-placement fallback.

**Architecture:** A pure, injectable retry helper in `src/web/api.ts` will preserve one frozen placement closure and run it only for retryable errors. `api.placeWager` will use that helper while `api.placeCommand` stays unchanged for non-wager mutations. The straight, teaser, and parlay UIs will call the wager-specific method, retaining all existing state transitions and terminal/stale handling.

**Tech Stack:** TypeScript, React, Vitest, Playwright, Cloudflare Worker local fixtures.

---

### Task 1: Specify the retry schedule with failing unit tests

**Files:**
- Modify: `tests/web-api.test.ts`
- Modify: `src/web/api.ts`

**Step 1: Write the failing test**

Add a focused test for an exported retry helper that:
- receives retryable errors for the initial placement and +2s replay;
- succeeds on the +10s replay;
- records three identical invocation opportunities and waits `[2_000, 8_000]` using injected clock/sleep functions.

Add a second test where a retry returns a terminal `ApiError`, asserting no second scheduled retry occurs and that exact error is returned.

**Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/web-api.test.ts`

Expected: FAIL because the retry helper does not exist.

**Step 3: Implement the minimal helper**

In `src/web/api.ts`, export a small helper that performs one placement attempt, schedules only retryable failures at 2 seconds and 10 seconds after the first ambiguous result, and rethrows terminal/stale or final ambiguous errors. Keep `REQUEST_TIMEOUT_MS` unchanged.

**Step 4: Run the focused test to verify it passes**

Run: `npm test -- tests/web-api.test.ts`

Expected: PASS.

### Task 2: Apply the policy only to wagers

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/pages/OddsPage.tsx`
- Modify: `src/web/pages/TeaserPage.tsx`
- Modify: `src/web/pages/ParlayPage.tsx`
- Create: `src/web/page-generation.ts`
- Modify: `tests/web-entry.test.ts`

**Step 1: Write the failing test**

Extend `tests/web-api.test.ts` so the wager-specific API transport sends the same frozen request body for every replay and uses the retry helper. Keep `api.placeCommand` behavior unaltered for share-order execution.

**Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/web-api.test.ts`

Expected: FAIL because no wager-specific transport exists.

**Step 3: Implement the minimal change**

Add `api.placeWager`, wrapping the existing bounded POST transport in the retry helper. Replace the three wager UI calls with `api.placeWager`; do not change `AdminOrdersPage`. Fence teaser and straight-placement continuations with a slug-scoped page generation, and retain already-confirmed/terminal straight-batch outcomes while only unresolved frozen entries remain retryable.

**Step 4: Run the focused test to verify it passes**

Run: `npm test -- tests/web-api.test.ts`

Expected: PASS.

### Task 3: Cover the real lost-response recovery path

**Files:**
- Modify: `e2e/orders-and-wagers.spec.ts`

**Step 1: Write the failing E2E expectation**

Update the existing one-shot dropped straight-placement response scenario to expect automatic navigation to placement results, exactly two identical placement requests, and no unknown-placement alert or manual second click. Add focused SPA route-transition coverage for pending straight quote/placement and teaser quote operations so old pool state cannot populate the destination pool.

**Step 2: Run the focused E2E test to verify it fails**

Run: `npm run test:e2e -- e2e/orders-and-wagers.spec.ts`

Expected: FAIL before the transport change because the UI exposes the unknown-placement fallback.

**Step 3: Verify the minimal implementation passes**

Run the same focused E2E command after Tasks 1–2. If local browser infrastructure is unavailable or user direction keeps full E2E in CI, record that it is deferred to PR CI and retain the focused unit coverage.

### Task 4: Validate the feature branch

**Files:**
- No production changes expected beyond Tasks 1–2.

**Step 1: Run targeted checks**

Run:
- `npm test -- tests/web-api.test.ts tests/web-entry.test.ts tests/web-parlay-page.test.ts`
- `npm run typecheck`
- `npm run build`

**Step 2: Run the full unit/worker suite**

Run: `npm test`

**Step 3: Review the diff**

Confirm only the retry helper, the three wager call sites, tests, E2E expectation, and plan/design documents changed. Do not stage or inspect excluded secret/environment files.

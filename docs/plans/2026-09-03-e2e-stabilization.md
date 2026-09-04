# E2E Stabilization Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Restore deterministic Playwright coverage by aligning tests with the shipped UI and fixture lifecycle, while fixing the real Placement-results return-to-board defect.

**Architecture:** Keep product contracts unchanged except for the OddsPage history-state transition: returning from either review or placement results must clear the transient batch state. E2E tests will assert current accessible labels and concise API error messages, synchronize on real requests or rendered readiness conditions, and advance the local fixture clock beyond its explicit 24-hour placement window before asserting settlement.

**Tech Stack:** React 19, React Router, TypeScript, Vitest, Playwright, local Cloudflare Worker/Durable Objects.

---

### Task 1: Cover and fix the placement-results history transition

**Files:**
- Modify: `tests/web-odds-display.test.ts`
- Modify: `src/web/pages/OddsPage.tsx`
- Modify: `e2e/orders-and-wagers.spec.ts`

**Step 1: Write the failing unit test**

Add a focused test for the exported popstate batch transition. It must preserve quoting/placing batches, but clear both `reviewing` and `results` batches so a browser back action returns to the board.

**Step 2: Run the focused unit test to verify it fails**

Run: `npx vitest run tests/web-odds-display.test.ts --project=node`

Expected: FAIL because the results-state transition is not exported/does not clear `results`.

**Step 3: Implement the minimal transition**

Extract a small `batchAfterPopState` helper in `OddsPage.tsx` and use it from the `popstate` listener. Preserve the existing history back behavior and all tray contents.

**Step 4: Run the focused unit test to verify it passes**

Run: `npx vitest run tests/web-odds-display.test.ts --project=node`

Expected: PASS.

**Step 5: Keep the affected E2E journeys as product-level proof**

Do not broaden production behavior. The existing LINE_CHANGED and stale/locked offer paths must assert the return button reveals the odds-board controls again.

**Step 6: Commit**

```bash
git add src/web/pages/OddsPage.tsx tests/web-odds-display.test.ts e2e/orders-and-wagers.spec.ts
git commit -m "fix: return placement results to odds board"
```

### Task 2: Align settlement and privacy assertions with current presentation contracts

**Files:**
- Modify: `e2e/current-settlement-presentation.spec.ts`
- Modify: `e2e/privacy-and-settlement.spec.ts`
- Modify: `e2e/same-game-export.spec.ts`

**Step 1: Update stale user-facing assertions**

Use the current accessible labels and messages:
- `My bets` navigation, `Open bets`, `Settled bets`, and their empty states.
- Table-based payout/outcome presentation rather than removed sentence prose.
- `Service unavailable.`, `Sign in again.`, and `Season is not closed.`
- `Make commissioner`, with no obsolete transfer-reason field.
- Seven-column standings rows; the current share price remains the page-level context, not a per-row cell.
- `T11 Super Away +4` as the exact accessible checkbox name.

**Step 2: Advance fixture settlement time past the real fixture start**

For current-settlement and same-game settlement journeys, use a timestamp at least 26 hours after the current time. Preserve the subsequent 15-minute and 24-hour reconciliation checks in the same-game flow.

**Step 3: Run the focused E2E tests**

Run:

```bash
LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu \
  npx playwright test e2e/current-settlement-presentation.spec.ts e2e/privacy-and-settlement.spec.ts e2e/same-game-export.spec.ts --reporter=line
```

Expected: all selected journeys pass without arbitrary timeout increases.

**Step 4: Commit**

```bash
git add e2e/current-settlement-presentation.spec.ts e2e/privacy-and-settlement.spec.ts e2e/same-game-export.spec.ts
git commit -m "test: align settlement journeys with current UI"
```

### Task 3: Remove request-order races from message-board and order E2E coverage

**Files:**
- Modify: `e2e/message-board.spec.ts`
- Modify: `e2e/orders-and-wagers.spec.ts`

**Step 1: Make the message-board pending assertion condition-based**

Wait for the actual reply request to begin before asserting disabled reply controls. Retain the dropped-response retry and durable-post behavior; do not increase timeouts.

**Step 2: Scope order instrumentation to the selected member**

Capture the selected member id before looping through order modes, then filter quote and execution request collections to that member. This excludes the deliberately injected commissioner order used to invalidate a quote while still proving a fresh re-quote and execution.

**Step 3: Run focused E2E tests**

Run:

```bash
LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu \
  npx playwright test e2e/message-board.spec.ts e2e/orders-and-wagers.spec.ts --reporter=line
```

Expected: all selected journeys pass with request expectations tied to the relevant actor.

**Step 4: Commit**

```bash
git add e2e/message-board.spec.ts e2e/orders-and-wagers.spec.ts
git commit -m "test: stabilize command journey synchronization"
```

### Task 4: Verify the stabilization branch and prepare the dedicated PR

**Files:**
- Verify only; no planned source changes.

**Step 1: Run static and unit gates**

```bash
npm test
npm run typecheck
npm run build
```

**Step 2: Run the complete E2E suite**

```bash
LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu npm run test:e2e
```

**Step 3: Review and inspect the final diff**

Run `git diff --check`, inspect the changed-file diff, and obtain an independent focused review. Address any concrete blocker, rerunning affected tests afterward.

**Step 4: Commit, push, and open the dedicated PR**

Use a focused title/body documenting the product fix, current-UI contract updates, fixture-time correction, and verification evidence. Do not merge the PR.

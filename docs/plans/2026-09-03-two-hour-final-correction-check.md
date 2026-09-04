# Two-Hour Final Correction Check Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add a two-hour provider-result refresh and PoolDO correction checkpoint while retaining immediate, short-window, and 24-hour reconciliation.

**Architecture:** Extend the D1 terminal-result threshold list and the PoolDO's explicit persisted phase machine. Rebuild legacy `event_reconciliation` tables idempotently, map old `final_24` rows to the new two-hour phase, and use startup concurrency blocking to move a stale registered alarm to the earliest persisted deadline.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, SQLite Durable Objects, `@cloudflare/vitest-pool-workers`, Vitest.

---

### Task 1: Add the D1 two-hour refresh

**Files:**
- Modify: `tests/odds/ingestion.test.ts`
- Modify: `src/odds/ingestion.ts`

**Step 1: Write the failing test**

Update the terminal-reconciliation test to assert provider calls exactly at 5 minutes, 2 hours, and 24 hours, and no calls immediately before or after each completed threshold.

**Step 2: Run test to verify it fails**

Run: `npx vitest run --project=workers tests/odds/ingestion.test.ts -t "terminal reconciliation"`

Expected: FAIL because no poll is due at two hours.

**Step 3: Write minimal implementation**

Change the fixed delays in `finalReconciliationDue` to:

```ts
[5 * MINUTE, 2 * HOUR, 24 * HOUR]
```

**Step 4: Run test to verify it passes**

Run the same targeted command and expect PASS.

### Task 2: Add the PoolDO two-hour phase

**Files:**
- Modify: `tests/durable/wagers-settlement.test.ts`
- Modify: `src/durable/alarm.ts`
- Modify: `src/durable/schema.ts`

**Step 1: Write the failing test**

Extend the correction lifecycle test to assert:

```text
first final -> final_15 -> final_2h -> final_24 -> complete
```

Assert each deadline is anchored to `final_observed_at` at 15 minutes, 2 hours, and 24 hours.

**Step 2: Run test to verify it fails**

Run: `npx vitest run --project=workers tests/durable/wagers-settlement.test.ts -t "durably reconciles two later corrections"`

Expected: FAIL because `final_15` currently advances directly to `final_24`.

**Step 3: Write minimal implementation**

Add `FINAL_2_HOURS`, transition `final_15` to `final_2h`, transition `final_2h` to `final_24`, and allow `final_2h` in the current table `CHECK`.

**Step 4: Run the targeted test**

Run the same command and expect PASS.

### Task 3: Migrate and re-arm existing Durable Objects

**Files:**
- Modify: `tests/durable/pool-authority.test.ts`
- Modify: `src/durable/schema.ts`
- Modify: `src/durable/alarm.ts`
- Modify: `src/durable/pool-do.ts`

**Step 1: Write the failing migration test**

Create an old-shape `event_reconciliation` table containing a populated `final_24` row and register its old 24-hour alarm. Evict the object, activate it again, and assert that startup:

- preserves the row and its `rowid`;
- changes phase to `final_2h`;
- sets `deadline_at` and `next_attempt_at` to `final_observed_at + 2 hours`;
- admits both new phases in the rebuilt `CHECK`;
- moves the registered alarm to the two-hour deadline; and
- produces identical state after a second eviction/activation.

**Step 2: Run test to verify it fails**

Run: `npx vitest run --project=workers tests/durable/pool-authority.test.ts -t "migrates legacy final reconciliation"`

Expected: FAIL because the startup migration and alarm repair do not exist.

**Step 3: Implement migration and startup repair**

Rebuild only definitions lacking `final_2h`, copy explicit columns and `rowid`, map old `final_24` rows, and calculate the new deadline with deterministic SQLite date arithmetic. Export one helper that reads the earliest reconciliation deadline and use it both after alarm processing and at PoolDO startup. Wrap the asynchronous `getAlarm`/conditional `setAlarm` initialization in `blockConcurrencyWhile`.

**Step 4: Run migration and lifecycle tests**

Run:

```bash
npx vitest run --project=workers tests/durable/pool-authority.test.ts tests/durable/wagers-settlement.test.ts
```

Expected: PASS.

### Task 4: Update operational documentation and verify

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/operations.md`
- Verify: all changed source and test files

**Step 1:** Document the D1 5-minute/2-hour/24-hour refreshes and PoolDO immediate/15-minute/2-hour/24-hour lifecycle.

**Step 2:** Run targeted Workers tests:

```bash
npx vitest run --project=workers tests/odds/ingestion.test.ts tests/durable/pool-authority.test.ts tests/durable/wagers-settlement.test.ts
```

**Step 3:** Run `npm run typecheck` and `npm run build`.

**Step 4:** Request a read-only expert review focused on phase migration, deterministic deadlines, alarm replacement ordering, idempotency, and unchanged settlement authority.

**Step 5:** Address Critical and Important findings, rerun affected checks, commit, push, and open a pull request. Let CI run the full suite. Do not run E2E tests.

# R17 Odds Ingestion Hardening Implementation Plan

> **REQUIRED SUB-SKILL:** Use the test-driven-development skill for each task.

**Goal:** Close the four R17 T11 blockers without changing product behavior or weakening the authoritative D1/PoolDO boundaries.

**Architecture:** Reject contradictory or malformed provider input before any canonicalization or D1 mutation. Preserve the existing generation-fenced ingestion transaction and immutable PoolDO wager snapshots. Correct the deterministic reader test to prove the existing old-or-new D1 snapshot semantics rather than alter production behavior.

**Tech Stack:** TypeScript, Zod, Cloudflare D1/Durable Objects, Vitest Workers pool.

---

### Task 1: Preserve immutable provider event side identity

**Files:**
- Modify: `tests/odds/ingestion.test.ts`
- Modify: `src/odds/the-odds-api-provider.ts`
- Modify: `src/odds/ingestion.ts`
- Inspect/assert only as needed: `src/durable/settlement.ts`

1. Add adapter-through-ingestion tests for forward/reverse same-ID odds+score home/away disagreement and a later score-only swapped-side event.
2. Snapshot `sports_event`, `market_offer`, feed availability, and a funded PoolDO's settlement/account/wager/ledger/outbox/audit tables before the rejected poll; assert preserved bytes and provider-error health afterward.
3. Run the focused test and observe the expected acceptance of swapped identities or missing regression behavior (RED).
4. Add a shared normalized ordered-team identity comparison to the adapter, and query/check persisted home/away identities before building ingestion statements.
5. Re-run the focused test until it passes, then run the affected existing ingestion cases.

### Task 2: Reject malformed provider score and price values

**Files:**
- Modify: `tests/odds/ingestion.test.ts`
- Modify: `src/contracts/provider.ts`
- Modify: `src/odds/the-odds-api-provider.ts`
- Modify: `src/odds/market-semantics.ts`

1. Add adapter-through-ingestion tests for every disallowed score representation and unsafe/zero American prices at the external and normalized boundaries.
2. Assert each failure retains last-good D1/PoolDO state and records bounded provider-error health.
3. Run the focused tests and observe validation failures are absent or insufficient (RED).
4. Implement canonical safe-decimal score validation, safe nonzero price validation in Zod contracts, and `Number.isSafeInteger` at the semantic decoder boundary.
5. Re-run focused tests and typecheck.

### Task 3: Correct deterministic placement snapshot proof

**Files:**
- Modify: `tests/worker/deterministic-reader-snapshot.test.ts`

1. Split the current parameterized placement test into explicit `after` and `before` assertions.
2. For `after`, first assert the test fails because it expects stale rejection; then assert successful placement's response/command version and exact authoritative mutations (processed command, account, wager, legs/snapshots, ledger, reconciliation, outbox, audit, alarm).
3. For `before`, retain the complete `LINE_CHANGED` replacement assertion and byte-for-byte zero durable mutation.
4. Do not modify production snapshot code.
5. Run only this test in the owned test harness and then its related worker/durable suites.

### Task 4: Cover pre-claim intervening failure fencing

**Files:**
- Modify: `tests/odds/ingestion.test.ts`

1. Add a barrier test that pauses invocation A before its claim, lets invocation B claim and fail, then resumes A.
2. Observe the intended test fail before production changes only if a real flaw is revealed; otherwise document it as a regression proof for the existing generation fencing.
3. Assert A floors timestamps from B's claimed health row, retains B's last-good availability, recomputes its due leagues, and wins final health through the generation guard.
4. Run the focused ingestion suite.

### Task 5: Validate and review

1. Run the targeted R17 test groups in a uniquely owned local harness that does not consume root `.dev.vars`.
2. Run typecheck and the handoff's relevant durable/worker settlement pair.
3. Use the regular `architecture-reviewer` for requirement/authority review, fix any findings, then use the regular `code-reviewer` on the final diff and fix any findings.
4. Only then run the larger T11 recovery gate and assess the later T16/T12/T20 work.

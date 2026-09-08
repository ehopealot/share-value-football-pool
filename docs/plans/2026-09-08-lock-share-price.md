# Lock Share Order Price at $1 Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add an optional server-enforced $1 share-order price with complete quote comparison details.

**Architecture:** Carry a boolean `lockPriceAtOneDollar` through browser, HTTP, and PoolDO command contracts. The PoolDO selects the only allowed fixed price, returns current price separately, and validates both version and server-derived price at execution. Render all comparison amounts from the immutable quote snapshot.

**Tech Stack:** TypeScript, Zod, React, Cloudflare Durable Objects, Vitest.

---

### Task 1: Define pricing-choice contracts

**Files:**
- Modify: `src/contracts/commands.ts`
- Modify: `src/contracts/http.ts`
- Modify: `src/durable/pool-commands.ts`
- Test: `tests/contracts/confirmation-protocol.test.ts`

1. Add failing contract tests for optional/default-false and checked request/snapshot/execution binding.
2. Run the focused contract test and confirm failure.
3. Add the boolean choice and quote current-price field; preserve omitted request compatibility.
4. Run the focused contract test and confirm success.

### Task 2: Enforce fixed pricing in PoolDO accounting

**Files:**
- Modify: `src/durable/accounting-commands.ts`
- Modify: `src/durable/accounting-repository.ts`
- Modify: `src/durable/pool-do.ts`
- Modify: `src/worker/routes.ts`
- Test: `tests/durable/orders-ledger.test.ts`

1. Add failing tests for shares/value modes, unchecked behavior, drift above/below/equal, stale versions, quote-price tampering, replay, immutable price, and reversal.
2. Run the focused durable test and confirm failure.
3. Derive execution price from the boolean and current server state; return current price for comparison.
4. Bind the choice through routes and commands, keeping omitted values false.
5. Run the focused durable test and confirm success.

### Task 3: Add checkbox and confirmation details

**Files:**
- Modify: `src/web/pages/AdminOrdersPage.tsx`
- Modify: `src/web/api.ts`
- Modify: `src/web/components/Confirmation.tsx`
- Test: `tests/contracts/confirmation-protocol.test.ts`

1. Add failing rendering/API tests for the checkbox’s request semantics and above/below/equal confirmation copy.
2. Run the focused test and confirm failure.
3. Add unchecked editor state, request binding, frozen execution construction, and quote-derived comparison rendering.
4. Run focused tests and confirm success.

### Task 4: Validate and commit

1. Run focused non-e2e tests.
2. Run typecheck and production build.
3. Inspect diff/status and commit the coherent implementation without pushing.

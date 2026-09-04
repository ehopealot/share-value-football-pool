# Commissioner Banner Notice Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Let a commissioner set, replace, and explicitly clear one durable notice that every authorized pool member sees in a prominent banner above primary navigation.

**Architecture:** Add a nullable, bounded `commissionerNotice` to authoritative PoolDO state and the exact `ReadPoolView` contract. Extend the existing commissioner-only settings command to accept either a trimmed string (set/replace) or `null` (clear), then have `Layout` render the returned state above the navigation ribbon. The join/closed gate continues to use its least-data response and never receives the notice.

**Tech Stack:** TypeScript, React, React Router, Zod, Cloudflare Durable Objects/SQLite, Hono, Vitest, Playwright.

---

### Task 1: Add an authoritative, strictly validated commissioner notice

**Files:**
- Modify: `src/contracts/http.ts`
- Modify: `src/durable/pool-commands.ts`
- Modify: `src/durable/schema.ts`
- Modify: `src/durable/pool-do.ts`
- Modify: `src/worker/routes.ts`
- Modify: `tests/contracts/read-pool-view.test.ts`
- Modify: `tests/contracts/t11-read-contracts.test.ts`
- Modify: `tests/durable/pool-authority.test.ts`
- Modify: `tests/worker/t11-admin-api.test.ts`
- Modify: `tests/worker/entry-read.test.ts`

**Step 1: Write failing exact-contract tests.**

Extend the settings request and view tests to require this shape:

```ts
const setNotice = {
  commissionerNotice: "  Draft starts at noon.  ",
  idempotencyKey: "notice-set"
};
expect(updatePoolSettingsRequest.parse(setNotice)).toEqual({
  commissionerNotice: "Draft starts at noon.",
  idempotencyKey: "notice-set"
});
expect(updatePoolSettingsRequest.parse({ commissionerNotice: null, idempotencyKey: "notice-clear" }))
  .toEqual({ commissionerNotice: null, idempotencyKey: "notice-clear" });
```

Require `ReadPoolView.pool.commissionerNotice` to be present and either a string or `null`. Reject omitted/undefined notice values, blank or whitespace-only strings, strings longer than 500 characters, and unknown settings fields.

**Step 2: Run the contract tests to verify they fail.**

Run:

```bash
npx vitest run --project=node tests/contracts/read-pool-view.test.ts tests/contracts/t11-read-contracts.test.ts
```

Expected: FAIL because neither settings nor the view contains `commissionerNotice`.

**Step 3: Write failing durable and HTTP authority tests.**

In the PoolDO authority test, initialize an owner and member, then prove all of the following:

```ts
expect((await send(slug, {
  type: "UpdatePoolSettings", commandId: "set-notice", actorId: "owner",
  commissionerNotice: "Draft starts at noon."
})).body).toMatchObject({ commandVersion: expect.any(String) });
expect((await send(slug, {
  type: "UpdatePoolSettings", commandId: "member-notice", actorId: "member",
  commissionerNotice: "Forged"
})).body).toEqual({ code: "FORBIDDEN" });
expect((await send(slug, {
  type: "UpdatePoolSettings", commandId: "clear-notice", actorId: "owner",
  commissionerNotice: null
})).body).toMatchObject({ commandVersion: expect.any(String) });
```

Read as a member after setting and clearing to assert the exact string and then `null`; reuse a setting command ID with changed notice content to assert `IDEMPOTENCY_CONFLICT`. Inspect the migrated legacy pool column with `PRAGMA table_info(pool)` and prove it reads as `NULL`.

Extend the real Worker route test to prove a commissioner can set/replace/clear without recent auth, a member receives 403, malformed values receive 400, and a member `GET /view` sees the authoritative value. Extend the entry-read test to prove `/gate` remains exactly the approved join/closed shape and never includes notice text.

**Step 4: Run the authority tests to verify they fail.**

Run:

```bash
npx vitest run --project=workers tests/durable/pool-authority.test.ts tests/worker/t11-admin-api.test.ts tests/worker/entry-read.test.ts
```

Expected: FAIL because the command, storage field, and route forwarding do not exist.

**Step 5: Implement the minimum authoritative path.**

1. In `src/contracts/http.ts`, define a reusable `commissionerNotice = z.string().trim().min(1).max(500)` and extend `updatePoolSettingsRequest` with `commissionerNotice: commissionerNotice.nullable().optional()`. Make the request object strict and update its “at least one setting” refinement to include this field. Add required `commissionerNotice: commissionerNotice.nullable()` to `ReadPoolView.pool`.
2. In `src/durable/pool-commands.ts`, add the same optional nullable field to the strict `UpdatePoolSettings` command shape.
3. In `src/durable/schema.ts`, add nullable `commissioner_notice` with a `trim`/length check to new `pool` tables. In `migrateSeasonCreatedAt`, add it idempotently to legacy pool tables; legacy rows naturally read as `NULL`.
4. In `src/durable/pool-do.ts`, select the column in both the authorization and view paths. Preserve it when omitted, write the trimmed string or SQL `NULL` when supplied, and expose `commissionerNotice` in `readPool`. Keep the existing commissioner/active-member authorization and idempotency flow intact.
5. In `src/worker/routes.ts`, forward `commissionerNotice` when it is not `undefined`, preserving `null` for explicit clears. Do not add it to the gate response, D1 projections, message-board data, emails, or member-export contracts.
6. Add `commissionerNotice: null` to every valid in-test `ReadPoolView` fixture (`tests/contracts/read-pool-view.test.ts`, `tests/contracts/t11-read-contracts.test.ts`, `tests/web-entry.test.ts`, and `tests/web-message-board-page.test.ts`).

**Step 6: Run focused tests to verify they pass.**

Run:

```bash
npx vitest run --project=node tests/contracts/read-pool-view.test.ts tests/contracts/t11-read-contracts.test.ts
npx vitest run --project=workers tests/durable/pool-authority.test.ts tests/worker/t11-admin-api.test.ts tests/worker/entry-read.test.ts
```

Expected: PASS. The gate remains least-data, while only authorized pool views include the explicit notice field.

**Step 7: Commit the authoritative change.**

```bash
git add src/contracts/http.ts src/durable/pool-commands.ts src/durable/schema.ts src/durable/pool-do.ts src/worker/routes.ts \
  tests/contracts/read-pool-view.test.ts tests/contracts/t11-read-contracts.test.ts \
  tests/durable/pool-authority.test.ts tests/worker/t11-admin-api.test.ts tests/worker/entry-read.test.ts \
  tests/web-entry.test.ts tests/web-message-board-page.test.ts
git commit -m "feat: add commissioner banner notice state"
```

### Task 2: Render and manage the accessible notice banner

**Files:**
- Modify: `src/web/components/Layout.tsx`
- Modify: `src/web/pages/AdminSettingsPage.tsx`
- Modify: `src/web/styles.css`
- Modify: `tests/accessibility/contrast.test.ts`
- Create: `tests/web-commissioner-banner-notice.test.ts`
- Create: `e2e/commissioner-banner-notice.spec.ts`

**Step 1: Write failing browser presentation tests.**

Add a small exported pure banner component to `Layout` and test its static markup:

```tsx
const markup = renderToStaticMarkup(
  createElement(CommissionerNotice, { notice: "Draft starts at noon." })
);
expect(markup).toContain('aria-label="Commissioner notice"');
expect(markup).toContain("Commissioner notice");
expect(markup).toContain("Draft starts at noon.");
expect(markup).not.toContain("aria-live");
```

Also assert source order places the notice after `.masthead` and before `<nav aria-label="Primary navigation">`, and assert its CSS uses semantic label text, `overflow-wrap: anywhere`, `white-space: pre-wrap`, and a high-contrast notice token pair. Extend `tests/accessibility/contrast.test.ts` to calculate AA contrast for that pair.

**Step 2: Run the browser tests to verify they fail.**

Run:

```bash
npx vitest run --project=node tests/web-commissioner-banner-notice.test.ts tests/accessibility/contrast.test.ts
```

Expected: FAIL because the component, placement, and notice styles do not exist.

**Step 3: Write a failing end-to-end member journey.**

Create `e2e/commissioner-banner-notice.spec.ts` using the real local Worker and browser sessions:

1. Create an active pool as commissioner.
2. Visit Pool settings, fill labelled `Commissioner notice`, save it, and wait for the labelled banner’s text rather than a timer.
3. Navigate through normal joined routes (Odds board, Standings, Message board, and Pool settings) and assert the banner persists above primary navigation.
4. Join a second signed-in member and assert they see the banner but receive the existing commissioner-only settings denial and a direct forged settings POST returns 403.
5. Use a third signed-in nonmember at `/p/:slug`; assert the join page shows no notice text.
6. As commissioner, clear the notice and wait for the banner to disappear for a fresh member view.

**Step 4: Run the E2E test to verify it fails.**

Run:

```bash
LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu npx playwright test e2e/commissioner-banner-notice.spec.ts --reporter=line
```

Expected: FAIL at the absent settings controls/banner. Do not add generic timeout increases; wait for the committed API-driven UI conditions.

**Step 5: Implement the minimum browser behavior.**

1. In `Layout.tsx`, render `CommissionerNotice` only when an authorized `view` for the current slug has a non-null notice. Place it after the masthead and immediately before the primary nav. Use a labelled `<aside>` with visible `Commissioner notice` text; do not use `role="alert"` or `aria-live`.
2. In `AdminSettingsPage.tsx`, initialize a controlled notice textarea from `view.pool.commissionerNotice`; add a labelled `Commissioner notice` textarea with `maxLength={500}`, a `Save notice` button, and a `Clear notice` button only when a server notice exists. Send a string to save and `commissionerNotice: null` to clear. Retire pending commands on edits, disable all notice controls while pending, surface errors through the existing alert, and call `invalidatePoolView()` after a successful command so the Layout refetches the authoritative ribbon state.
3. In `styles.css`, add an amber/high-contrast notice treatment, safe wrapping, and narrow-screen spacing without changing the nav’s 44px mobile target contract.

**Step 6: Run focused browser and E2E tests to verify they pass.**

Run:

```bash
npx vitest run --project=node tests/web-commissioner-banner-notice.test.ts tests/accessibility/contrast.test.ts
LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu npx playwright test e2e/commissioner-banner-notice.spec.ts --reporter=line
```

Expected: PASS. The banner is visible only after authorized membership and is immediately removed after an authoritative clear.

**Step 7: Commit the browser change.**

```bash
git add src/web/components/Layout.tsx src/web/pages/AdminSettingsPage.tsx src/web/styles.css \
  tests/accessibility/contrast.test.ts tests/web-commissioner-banner-notice.test.ts \
  e2e/commissioner-banner-notice.spec.ts
git commit -m "feat: show commissioner banner notice"
```

### Task 3: Verify, review, and prepare the unmerged feature PR

**Files:**
- Review: all changed files
- Update if needed: `docs/plans/2026-09-03-commissioner-banner-notice.md`

**Step 1: Inspect the final change set.**

Run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short --untracked-files=no
git log --oneline origin/main..HEAD
```

Expected: only the design/plan, notice implementation, and their tests are tracked; no generated or private files are staged.

**Step 2: Run the complete automated suite.**

Run:

```bash
npm test
npm run typecheck
npm run build
LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu npm run test:e2e
```

Expected: every command passes. If a failure occurs, use the systematic-debugging skill and reproduce the failing case before changing code.

**Step 3: Request an adversarial review.**

Ask a read-only reviewer to check strict nullable request handling, legacy schema migration, current-commissioner authorization, idempotency, member/nonmember notice exposure, cache invalidation, accessible semantics/contrast, and whether the change unintentionally alters exports, announcements, or betting authority. Resolve every Critical or Important finding and rerun affected tests.

**Step 4: Push and open an unmerged PR.**

```bash
git push -u origin feat/commissioner-banner-notice
gh pr create --base main --head feat/commissioner-banner-notice \
  --title "Add commissioner banner notices" \
  --body "## Summary
- add commissioner-controlled durable pool notices
- show an accessible high-contrast banner above member navigation
- cover authority, privacy, accessibility, and end-to-end flows

## Verification
- npm test
- npm run typecheck
- npm run build
- LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu npm run test:e2e"
```

Expected: a dedicated unmerged PR exists. Do not merge it.

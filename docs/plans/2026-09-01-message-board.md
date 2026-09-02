# Pool Message Board Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Deliver a member-only, durable pool message board with top-level posts, one-level replies, nickname/timestamp presentation, a final-nav unread `New` indicator, and per-member timestamp high-water marks.

**Architecture:** Keep board state entirely in each PoolDO's SQLite authority. A unified entry table stores a nullable top-level parent reference; a separate member read table stores each user's last observed strictly monotonic activity timestamp. A same-origin POST read atomically advances the reader watermark; post/reply commands are idempotent mutations that advance the author watermark but deliberately do not enter the D1 projection/outbox path. The Worker exposes strict member-only contracts; React renders nested threads and invalidates a race-safe cached pool view after board activity.

**Tech Stack:** Cloudflare Durable Objects/SQLite, Hono, TypeScript, Zod, React, Vitest, Playwright, CSS.

---

### Task 1: Define failing authoritative board contracts and persistence behavior

**Files:**
- Modify: `src/durable/schema.ts`
- Modify: `src/durable/pool-commands.ts`
- Modify: `src/durable/pool-do.ts`
- Modify: `src/contracts/http.ts`
- Test: `tests/durable/message-board.test.ts`
- Test: `tests/contracts/message-board.test.ts`
- Test: `tests/contracts/t11-read-contracts.test.ts`
- Test: `tests/contracts/read-pool-view.test.ts`
- Test: `tests/web-entry.test.ts`

**Step 1: Write failing durable and contract tests**

Create `tests/durable/message-board.test.ts` using the existing PoolDO command fixture style. Assert that:

- an active member can create a top-level post and a different member can create one chronological reply;
- a reply target that is missing or itself a reply is rejected;
- returned nested threads order newest parent activity first and replies chronologically;
- an exact duplicate post/reply command returns the original result without an extra row, while the same command id with changed text returns `IDEMPOTENCY_CONFLICT`;
- post/reply increment command version but create no outbox row, projection delivery, or alarm; `ReadMessageBoard` creates no processed-command row, outbox row, projection delivery, or alarm;
- one caller's `ReadMessageBoard` clears only that caller's HWM; a post/reply is unread for other members but not its author;
- a forced equal-clock or pre-existing latest activity value produces a strictly later board activity timestamp and remains unread;
- a member without a HWM sees an existing board as unread.

Add strict contract tests for `ReadMessageBoardResponse` and an exact `MessageBoardMutationResponse` (at minimum `{ commandVersion }`). Require `currentMember.hasUnreadBoard` in `ReadPoolView`, and update every affected fixture in `tests/contracts/read-pool-view.test.ts` and `tests/web-entry.test.ts`.

**Step 2: Run the focused tests to verify RED**

Run:

```bash
npx vitest run --project=node --project=workers tests/durable/message-board.test.ts tests/contracts/message-board.test.ts tests/contracts/t11-read-contracts.test.ts tests/contracts/read-pool-view.test.ts tests/web-entry.test.ts
```

Expected: failing imports, missing command variants, missing strict schemas/fields, or failed expected board behavior.

**Step 3: Implement the minimal authoritative model**

- Add `message_board_entry` and `message_board_read` plus query indexes to `poolSchema`. Use text-only data and `CHECK` constraints where practical; do not add D1 storage.
- Add strict command variants: `ReadMessageBoard`, `CreateMessageBoardPost`, and `ReplyToMessageBoardPost`. Require trimmed 1–1000 character text and normal command identity fields for post/reply only.
- Add strict browser DTO schemas for a message, reply, thread, board response, concrete mutation response, and `hasUnreadBoard`.
- In `PoolDO`, add a serialized `nextMessageBoardActivityAt` helper. It must produce fixed-format UTC ISO timestamps strictly greater than the maximum existing board activity time.
- Implement read and mutation handlers inside the existing transaction/authorization boundary. Update a read watermark only when actual latest activity exists; preserve its monotonic high-water value with an upsert.
- Insert a reply only after verifying its parent is top-level. Update the parent's activity timestamp to the reply activity timestamp.
- Classify `ReadMessageBoard` as a non-idempotent state-changing read: it executes in the existing transaction but is excluded from processed-command persistence, alarms, and outbox work. Make post/reply idempotent versioned mutations explicitly excluded from outbox/alarm work (for example, through a centralized `shouldEnqueueOutbox()` classifier).
- Compute `hasUnreadBoard` in `readPool` from the latest top-level activity and the caller's watermark.

**Step 4: Run the focused tests to verify GREEN**

Run the command from Step 2.

Expected: all focused durable and contract tests pass.

### Task 2: Add strict same-origin Worker routes and typed browser transport

**Files:**
- Modify: `src/contracts/http.ts`
- Modify: `src/worker/routes.ts`
- Modify: `src/web/api.ts`
- Test: `tests/worker/api.test.ts`
- Test: `tests/web-api.test.ts`

**Step 1: Write failing Worker and client tests**

Add cases that prove:

- `POST /api/p/:slug/board/read` requires an authenticated active member, a valid same-origin request, and a strict empty request body; it returns the strict board DTO and advances only that reader's HWM;
- no-origin and foreign-origin board-read requests are rejected and cannot advance a target member's HWM; no `GET /api/p/:slug/board` route exists;
- top-level and reply POST routes reject no origin/foreign origin, invalid or blank/too-long bodies, outsiders, and a reply-to-reply target;
- valid same-origin member post/reply requests return their strict concrete mutation contract;
- the Worker rejects missing and extra fields in malformed `router.send(...)` board/read and post/reply responses before returning them;
- the typed browser API parses valid board/mutation data, rejects malformed missing and extra response fields, URL-encodes the slug/post id, and sends the correct JSON body.

**Step 2: Run the focused tests to verify RED**

Run:

```bash
npx vitest run --project=node --project=workers tests/worker/api.test.ts tests/web-api.test.ts
```

Expected: routes/API methods do not yet exist or assertions fail.

**Step 3: Implement the minimal HTTP and API boundary**

- Add shared strict POST request schemas: an empty read body and post/reply bodies containing `text` and `idempotencyKey`.
- Add only these CSRF-protected member mutation routes:

  ```text
  POST /api/p/:slug/board/read
  POST /api/p/:slug/board/posts
  POST /api/p/:slug/board/posts/:postId/replies
  ```

- Route only parsed request values to the PoolDO. Parse `ReadMessageBoardResponse` and `MessageBoardMutationResponse` immediately after `router.send(...)` before returning them.
- Add `api.readMessageBoard`, `api.createMessageBoardPost`, and `api.replyToMessageBoardPost`. Each parses the corresponding strict response a second time rather than returning `unknown`.
- Add a local pool-view invalidation event and subscription helper beside the existing session invalidation event. It has no user data and only tells mounted layouts to re-read their authoritative view.
- Add concise user-facing messages for expected board errors where a page needs them, without leaking internal storage details.

**Step 4: Run the focused tests to verify GREEN**

Run the command from Step 2.

Expected: all Worker and browser API assertions pass.

### Task 3: Preserve message-board state in infrastructure backups

**Files:**
- Modify: `src/services/audit-export.ts`
- Test: `tests/worker/exports.test.ts`

**Step 1: Write the failing backup test**

Extend the infrastructure-export/backup test fixture with a top-level entry, reply, and read watermark. Require the encrypted backup plaintext to retain the raw board rows and watermark rows. Also assert the public member audit export does not gain message-board fields.

**Step 2: Run the focused test to verify RED**

Run:

```bash
npx vitest run --project=workers tests/worker/exports.test.ts
```

Expected: the infrastructure backup omits the new board state.

**Step 3: Implement the smallest backup extension**

Add ordered raw `messageBoardEntries` and `messageBoardReadStates` only to `infrastructureAuditExport`. Preserve member audit export shape and its strict public contract.

**Step 4: Run the focused test to verify GREEN**

Run the command from Step 2.

Expected: backup includes the authoritative board state and member export remains unchanged.

### Task 4: Build the accessible Message board page and final unread nav link

**Files:**
- Create: `src/web/pages/MessageBoardPage.tsx`
- Modify: `src/web/components/Layout.tsx`
- Modify: `src/web/router.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/web-message-board-page.test.ts`
- Test: `tests/web-entry.test.ts`
- Test: `tests/branding.test.ts`
- Test: `tests/accessibility/touch-target.test.ts`
- Test: `tests/accessibility/table-reflow.test.ts` (only if the page introduces a horizontally-scrollable tabular region; otherwise do not change it)

**Step 1: Write failing presentation tests**

Use `.test.ts` because the current Vitest configuration collects `.test.ts` but not `.test.tsx`. Use React `createElement`/static rendering or focused pure helpers rather than JSX. Require:

- the final pool navigation `NavLink` points to `/p/:slug/board` after Rules;
- `hasUnreadBoard` renders a visible `New` text marker inside the Message board link, contributing to its accessible name;
- a deferred stale `ReadPoolView` response containing `hasUnreadBoard: true` resolving after a newer false response cannot restore `New` in `Layout`;
- the route renders a labelled top-level textarea, semantic top-level/reply articles, nickname text, `<time dateTime>`, and reply controls only for parent posts;
- a successful initial read and successful post/reply invalidates the pool view; a text edit retires a frozen command identity;
- error and loading states preserve a usable pool-home link;
- parent thread cards, reply controls, and textareas meet the narrow-screen interaction rules.

**Step 2: Run the focused tests to verify RED**

Run:

```bash
npx vitest run --project=node tests/web-message-board-page.test.ts tests/web-entry.test.ts tests/branding.test.ts tests/accessibility/touch-target.test.ts
```

Expected: missing page/route/nav/link behavior and styles.

**Step 3: Implement the minimal user interface**

- Change `Layout` to retain `ReadPoolView`, subscribe to pool-view invalidation, and render its last pool navigation link as `Message board`. Render a visible `New` marker only when the current authoritative view reports `hasUnreadBoard`.
- Give each `Layout` view-load effect a cancellation flag or owned request generation. Cleanup/invalidation/navigation must prevent an older request from applying after a newer result.
- Build `MessageBoardPage` with typed loading/error state, a labelled new-post textarea/form, current-user post status/error feedback, and one toggleable labelled reply form per top-level thread.
- Use `useFrozenAdminCommand` for the top-level and reply request identity. On successful board load or post/reply, refresh local board data as needed and call `invalidatePoolView`.
- Render text as text, current nickname, localized visible time plus machine-readable `dateTime`, semantic nested articles, and no reply action for replies.
- Add targeted styles: alternating neutral parent-card backgrounds only, subordinate reply indentation/borders, responsive textarea width, compact thread spacing, and a mobile 44px minimum for Reply/Post controls. Avoid CSS that changes unrelated table/bet-slip behavior.
- Add the `/p/:slug/board` route.

**Step 4: Run the focused tests to verify GREEN**

Run the command from Step 2.

Expected: page, nav indicator, route, and accessibility/style assertions pass.

### Task 5: Exercise the end-to-end member flow

**Files:**
- Modify: `e2e/responsive-a11y.spec.ts`
- Create or modify: `e2e/message-board.spec.ts`

**Step 1: Write failing E2E scenarios**

Use real local accounts and pool membership to require:

- Message board is the final primary nav link and is reachable by keyboard;
- one member creates a post, a second active member sees `New`, opens the board through the same-origin POST read flow, sees the post/nickname/timestamp, replies, and the first member then sees `New`;
- opening the board clears the marker for that member; posting/replying clears the author's marker;
- only one reply nesting level is available in the UI;
- desktop and 390px mobile board pages have no viewport overflow, use accessible labels, visible focus, 44px controls, alternating parent cards, and no automated axe violations.

**Step 2: Run the focused E2E tests to verify RED**

Run:

```bash
LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu npx playwright test e2e/message-board.spec.ts e2e/responsive-a11y.spec.ts --grep "[Mm]essage board|authenticated primary routes"
```

Expected: route/link/forms/indicator are absent.

**Step 3: Implement only the code required by the failing scenarios**

Complete any fixture or deterministic test-support additions required for real authenticated member interactions. Do not add production-only test controls or bypass authorization/CSRF.

**Step 4: Run the focused E2E tests to verify GREEN**

Run the command from Step 2.

Expected: the real user flow and responsive accessibility assertions pass.

### Task 6: Independent review, full verification, and commit

**Files:**
- Review: all changed source, tests, styles, and docs

**Step 1: Run complete verification**

Run:

```bash
npm test -- --maxWorkers=7
npm run typecheck
git diff --check
```

Expected: all test projects, typecheck, and whitespace validation pass.

**Step 2: Conduct expert review loops**

- Request fresh-context expert code review focused on durable authority/idempotency/HWM ordering, no-outbox behavior, HTTP access control/CSRF (including state-changing reads), strict response boundaries, privacy/backup scope, and React/accessibility stale-response behavior.
- Validate every concrete finding against current source. Apply only valid in-scope fixes through the next TDD cycle, rerun affected tests, then request a focused re-review.
- Repeat until reviewers report no Critical or Important in-scope findings, or explicitly surface any decision requiring user input.

**Step 3: Final review and commit**

Inspect the final diff personally, confirm no untracked local artifacts are staged, then commit the reviewed feature and durable docs together:

```bash
git add docs/plans/2026-09-01-message-board-design.md docs/plans/2026-09-01-message-board.md src tests e2e
git commit -m "Add pool message board"
```

# Commissioner Announcements and Navigation Continuity Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Let only a pool commissioner publish a marked Message Board announcement and trigger a best-effort, per-recipient email blast to active non-commissioner members, while keeping the pool navigation ribbon visible during same-pool SPA navigation.

**Architecture:** Announcements remain PoolDO-authoritative top-level board posts with an explicit `is_announcement` column; they are not encoded into post text or reply metadata. The Worker schedules a best-effort `ExecutionContext.waitUntil()` fan-out only after the authoritative command commits, and deliberately swallows delivery failures at that boundary as approved by the user. A small in-memory browser navigation cache initializes a newly mounted per-route `Layout` from the last authoritative pool view, then refreshes it behind the scenes with existing generation fencing.

**Tech Stack:** Cloudflare Workers/Durable Objects/D1, Hono, React 19, React Router, Zod, Resend REST API, Vitest, Playwright.

---

## Non-negotiable behavior

- A normal member can still create ordinary posts and replies, but cannot set `announcement: true`, including by direct PoolDO or HTTP request.
- An announcement is top-level only, plain trimmed 1–1000-character text, and is marked persistently and in every board read.
- Only the current commissioner sees the announcement checkbox; the Worker independently relies on PoolDO authorization.
- On the first committed announcement command only, the Worker starts (but does not await) individual email sends to active members other than the commissioner/author. Failed or interrupted background sends are intentionally not retried; the post itself remains successful.
- Use a stable Resend `Idempotency-Key` per post/recipient to suppress accidental duplicate provider delivery inside Resend’s documented 24-hour window. Do not add a D1 delivery table, Queue workflow, or durable retry task.
- Never expose recipient addresses in browser/PoolDO payloads, logs, member exports, or email headers. Each Resend request has one `to` recipient.
- Thread UI uses a small inline microphone SVG whose `title` and accessible name are exactly `Commissioner announcement` (matching the requested spelling). The article receives `id="post-<postId>"` so emailed deep links work.
- Pool navigation must not disappear during route changes within a pool. Logout/session invalidation still clears it immediately; successful board activity must immediately clear this browser’s stale `New` marker while authoritative refresh stays generation-fenced.

## Task 1: Define announcement authority, strict contracts, and backup preservation

**Files:**
- Modify: `src/contracts/http.ts:30-90`
- Modify: `src/durable/pool-commands.ts:30-45`
- Modify: `src/durable/schema.ts:5-55`
- Modify: `src/durable/pool-do.ts:80-210,365-405`
- Modify: `src/services/audit-export.ts:35-50`
- Test: `tests/contracts/message-board.test.ts`
- Test: `tests/durable/message-board.test.ts`
- Test: `tests/worker/exports.test.ts`

**Step 1: Write failing strict-contract tests.**

Add assertions that:

```ts
const announcementPost = {
  type: "CreateMessageBoardPost", commandId: "announcement", actorId: "owner",
  text: "Draft starts at noon.", announcement: true
};
expect(poolCommandSchema.parse(announcementPost)).toEqual(announcementPost);
expect(poolCommandSchema.safeParse({ ...announcementPost, announcement: "true" }).success).toBe(false);
expect(ReadMessageBoardResponse.parse({
  commandVersion: "4", canAnnounce: true,
  threads: [{ ...thread, isAnnouncement: true }]
})).toMatchObject({ canAnnounce: true });
```

Make the post-mutation contract require `{ commandVersion, postId, isAnnouncement, replayed }`, while reply mutation results retain their existing exact `{ commandVersion }` contract.

**Step 2: Run the contract test and verify RED.**

Run: `npm test -- --project=node tests/contracts/message-board.test.ts`

Expected: FAIL because the announcement fields/schemas do not exist.

**Step 3: Write failing PoolDO/backup tests.**

Test that a commissioner announcement persists `isAnnouncement: true`, returns a stable `postId`, and a replay returns the same post id with `replayed: true`; a member direct command returns `FORBIDDEN` and creates no row; normal posts remain `false`; replies cannot carry announcement metadata. Extend the infrastructure backup assertion to include `is_announcement` but keep member audit exports free of all board rows.

**Step 4: Run durable/export tests and verify RED.**

Run: `npm test -- --project=workers tests/durable/message-board.test.ts tests/worker/exports.test.ts`

Expected: FAIL on missing column/response/authorization fields.

**Step 5: Implement the minimum authority changes.**

- Add `is_announcement INTEGER NOT NULL DEFAULT 0` to `message_board_entry` creation and add an idempotent `PRAGMA table_info(message_board_entry)` upgrade in the PoolDO schema migration function. Backfill absent/null legacy values to `0`.
- Give `CreateMessageBoardPost` an `announcement` boolean defaulting to `false` in both HTTP and PoolDO schemas so omitted legacy callers canonicalize identically.
- In `PoolDO.authorized`, reject `announcement: true` unless `pool.commissioner_id === actorId` and the active member role is `commissioner`; ordinary posts remain before the general commissioner-only administration gate.
- Insert/store/read `is_announcement`; board reads include `canAnnounce` from the active caller’s role.
- Generate the post UUID before insert and return `{ commandVersion, postId, isAnnouncement, replayed: false }`. Teach processed-command replay to return the stored result with `replayed: true` for `CreateMessageBoardPost` only.
- Add `is_announcement` to infrastructure backup SQL; do not add board data to member exports or D1 projections/outbox.

**Step 6: Run the focused tests and verify GREEN.**

Run: `npm test -- --project=node tests/contracts/message-board.test.ts && npm test -- --project=workers tests/durable/message-board.test.ts tests/worker/exports.test.ts`

Expected: all focused tests pass.

**Step 7: Commit the authority slice.**

```bash
git add src/contracts/http.ts src/durable/pool-commands.ts src/durable/schema.ts src/durable/pool-do.ts src/services/audit-export.ts tests/contracts/message-board.test.ts tests/durable/message-board.test.ts tests/worker/exports.test.ts
git commit -m "Add commissioner announcement posts"
```

## Task 2: Add best-effort, privacy-safe Resend delivery after a committed announcement

**Files:**
- Modify: `src/auth/email-sender.ts:1-85`
- Modify: `src/worker/routes.ts:1-140`
- Modify: `src/index.ts:1-60`
- Modify: `src/index.local.ts:1-45`
- Test: `tests/auth/resend-email-sender.test.ts`
- Test: `tests/worker/api.test.ts`

**Step 1: Write failing notifier tests.**

Specify a dedicated notifier method and exact mail shape:

```ts
await notifier.notifyCommissionerAnnouncement({
  to: "member@example.test", poolName: "Sunday Pool", authorName: "Alex",
  text: "Draft starts at noon.",
  boardUrl: "https://officepool.football/p/sunday/board#post-post-1",
  idempotencyKey: "announcement/post-1/member"
});
expect(request.headers).toMatchObject({ "idempotency-key": "announcement/post-1/member" });
expect(JSON.parse(String(request.body))).toMatchObject({
  to: ["member@example.test"],
  subject: "Commissioner announcement — Sunday Pool"
});
```

Assert text and HTML escape hostile pool/member/post text and that the HTML uses the encoded board URL only as an escaped attribute.

**Step 2: Run the notifier test and verify RED.**

Run: `npm test -- --project=node tests/auth/resend-email-sender.test.ts`

Expected: FAIL because the announcement notifier and idempotency header do not exist.

**Step 3: Implement the minimal Resend notifier.**

- Extend the existing notifier interface/factory instead of adding a second provider or secret.
- Let `sendResend` accept an optional idempotency key and set the documented `Idempotency-Key` header (max 256 chars); preserve its no-response-body error behavior and per-recipient `[to]` array.
- Reuse/rename the existing five-character HTML escaping helper so it safely escapes text, display names, pool names, and URLs in text/HTML content.
- Use an explicit subject, plaintext body, and HTML body with a `View announcement` link. Do not add mailing-list, marketing, or BCC behavior.

**Step 4: Write failing Worker route tests.**

Use a fake `ExecutionContext` that records `waitUntil` promises. Create owner/member/suspended users and a pool. Assert:

- only an owner announcement schedules background work;
- the HTTP response is 200 before a deliberately deferred notifier resolves;
- the notifier is eventually called once per active non-commissioner user, never for owner/suspended users, with a same-origin encoded `#post-...` link;
- a replayed post schedules no second blast;
- provider failure resolves the wait-until task without changing the successful post response;
- forged member announcements are 403 and schedule nothing.

**Step 5: Run the Worker test and verify RED.**

Run: `npm test -- --project=workers tests/worker/api.test.ts`

Expected: FAIL because the route has no notifier/context dispatch.

**Step 6: Implement the Worker boundary.**

- Add `announcementNotifier` to `RouteDependencies` and pass the same Resend-backed implementation in production. Local composition may inject a no-op/development notifier; no secret is read or printed.
- Update both exported Worker `fetch(request, env, ctx)` implementations to pass `ctx` into `app.fetch(request, env, ctx)`, making Hono’s `c.executionCtx.waitUntil()` valid in real Worker requests.
- After parsing the authoritative post result, and only if `isAnnouncement && !replayed`, call `c.executionCtx.waitUntil(dispatchAnnouncement(...).catch(() => undefined))`; never await it in the route.
- `dispatchAnnouncement` obtains a fresh authoritative `ReadPoolView`, filters `status === "active"` members excluding both the current pool commissioner and author, resolves only those IDs’ emails from D1 in bounded chunks, and invokes the notifier individually with `Promise.allSettled` in small batches. It returns no recipient data to the browser and emits no recipient/content logs.
- Build the deep link from `c.req.url`, `encodeURIComponent(slug)`, and `encodeURIComponent(postId)`.

**Step 7: Run focused notifier/Worker tests and verify GREEN.**

Run: `npm test -- --project=node tests/auth/resend-email-sender.test.ts && npm test -- --project=workers tests/worker/api.test.ts`

Expected: all focused tests pass.

**Step 8: Commit the best-effort delivery slice.**

```bash
git add src/auth/email-sender.ts src/worker/routes.ts src/index.ts src/index.local.ts tests/auth/resend-email-sender.test.ts tests/worker/api.test.ts
git commit -m "Email commissioner announcements"
```

## Task 3: Surface announcement controls and marker accessibly in the browser

**Files:**
- Modify: `src/web/api.ts:1-165`
- Modify: `src/web/pages/MessageBoardPage.tsx:1-130`
- Modify: `src/web/styles.css:145-170`
- Test: `tests/web-api.test.ts`
- Test: `tests/web-message-board-page.test.ts`
- Test: `e2e/message-board.spec.ts`

**Step 1: Write failing browser-contract and rendering tests.**

Require the browser API to parse the separate create-post result exactly, carry `announcement` in a frozen post body, and reject malformed announcement fields. Render an announcement thread and assert it contains `id="post-post-1"`, a microphone SVG wrapper, `title="Commissioner announcement"`, and `aria-label="Commissioner announcement"`. Assert non-commissioner board data renders no checkbox and commissioner data renders the explanatory checkbox and explicit email button label.

**Step 2: Run focused browser tests and verify RED.**

Run: `npm test -- --project=node tests/web-api.test.ts tests/web-message-board-page.test.ts`

Expected: FAIL because fields/controls/marker do not exist.

**Step 3: Implement the minimum browser changes.**

- Parse the distinct create-post response in `api.createMessageBoardPost`; keep reply parsing unchanged.
- Extend `BoardMutation` with `announcement: boolean`; add a controlled commissioner-only checkbox labelled with the active-member email consequence.
- Change the submit button label to `Post announcement and email league` when checked; keep ordinary `Post` otherwise.
- Treat checkbox edits like text edits: retire the frozen post command and clear error. Disable it while the command is pending, so retry holds its exact body/key.
- Render the inline SVG marker only on `thread.isAnnouncement`; retain semantic heading/article/reply structure and add the deep-link article id.
- Add compact styles without reducing existing 44px mobile button targets or introducing overflow.

**Step 4: Run focused browser tests and verify GREEN.**

Run: `npm test -- --project=node tests/web-api.test.ts tests/web-message-board-page.test.ts`

Expected: all focused tests pass.

**Step 5: Extend the existing member-flow E2E test.**

As commissioner, select the announcement checkbox, publish, and assert the marker/tooltip/explicit button appear. As a member, assert the checkbox is absent and the announcement is readable/replyable. Exercise an intentionally dropped create response, retry, and assert exactly one post/one scheduled local notification. Retain Axe, mobile target, and viewport checks.

**Step 6: Run Message Board E2E and verify GREEN.**

Run: `LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu npm run test:e2e -- e2e/message-board.spec.ts`

Expected: all scenarios pass.

**Step 7: Commit the browser slice.**

```bash
git add src/web/api.ts src/web/pages/MessageBoardPage.tsx src/web/styles.css tests/web-api.test.ts tests/web-message-board-page.test.ts e2e/message-board.spec.ts
git commit -m "Show commissioner announcements on the board"
```

## Task 4: Preserve the navigation ribbon across same-pool SPA route transitions

**Files:**
- Modify: `src/web/components/Layout.tsx:1-45`
- Test: `tests/web-message-board-page.test.ts`
- Test: `e2e/message-board.spec.ts` or create `e2e/navigation-continuity.spec.ts`

**Step 1: Write a failing cache-state unit test.**

Extract a small exported `PoolNavigationCache` (or equivalently testable state helper) and assert that it:

```ts
const cache = new PoolNavigationCache();
cache.store("pool", unreadView);
expect(cache.get("pool")).toEqual(unreadView);
expect(cache.markBoardRead("pool")?.currentMember.hasUnreadBoard).toBe(false);
cache.clear();
expect(cache.get("pool")).toBeUndefined();
```

Also retain the existing generation-fencing assertion so a delayed older response cannot restore `New`.

**Step 2: Run the unit test and verify RED.**

Run: `npm test -- --project=node tests/web-message-board-page.test.ts`

Expected: FAIL because no cache/state helper exists.

**Step 3: Implement the navigation continuity fix.**

- Root cause: every route renders a new `Layout`; its state starts undefined and its effect immediately calls `setView(undefined)`, so pool links disappear until the duplicate `/view` fetch finishes.
- Add a module-lifetime cache keyed by pool slug. Initialize `view` from that cache synchronously and retain cached view during a same-slug refresh; write successful authoritative `poolView` responses back to cache.
- Keep `PoolViewLoadGeneration` and cancellation checks. Session invalidation clears cached views and session state immediately.
- On the board-specific invalidation event, retain the navigation links but update cached/current `hasUnreadBoard` to `false` before scheduling the authoritative refresh. This avoids a stale `New` marker without the visual ribbon flash.
- Do not cache failed, cross-pool, or post-logout state.

**Step 4: Run the unit test and verify GREEN.**

Run: `npm test -- --project=node tests/web-message-board-page.test.ts`

Expected: all tests pass.

**Step 5: Write and run a failing route-transition E2E test.**

From an already-loaded pool page, arm the existing local response barrier for the next `/api/p/:slug/view`, click a pool navigation link, and require the Message board/other pool links to remain visible within a short timeout before the delayed response releases. Verify the destination URL/page afterward.

Run: `LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu npm run test:e2e -- e2e/message-board.spec.ts`

Expected before implementation: the short visibility assertion fails because the ribbon is removed.

**Step 6: Re-run the E2E after implementation and verify GREEN.**

Run the same command.

Expected: all tests pass without a navigation gap.

**Step 7: Commit the navigation slice.**

```bash
git add src/web/components/Layout.tsx tests/web-message-board-page.test.ts e2e/message-board.spec.ts
git commit -m "Keep pool navigation visible during route changes"
```

## Task 5: Integrated verification, review, and handoff

**Files:**
- Review: all files above
- Do not stage: `AGENTS.md`, `dist-local/`, `tsconfig.tsbuildinfo`, `.dev.vars`, or `.env*`

**Step 1: Inspect the complete staged diff.**

Run: `git diff --cached --check && git diff --cached --stat && git status --short`

Expected: only intended announcement/navigation files are staged; generated/private files remain untracked and unstaged.

**Step 2: Run the complete automated suite.**

Run: `npm test -- --maxWorkers=7 && npm run typecheck && git diff --check`

Expected: all Vitest projects pass, TypeScript has no errors, and diff check is clean.

**Step 3: Run focused browser validation.**

Run:

```bash
LD_LIBRARY_PATH=/tmp/playwright-local-libs/root/usr/lib/x86_64-linux-gnu npm run test:e2e -- e2e/message-board.spec.ts
```

Expected: announcement authorization, marker, deep link, best-effort local notification behavior, responsive targets, Axe, and navigation continuity all pass.

**Step 4: Request an adversarial code review.**

Ask a read-only reviewer to inspect announcement authorization, idempotency/replay behavior, recipient privacy, error swallowing, background context propagation, strict contracts, and navigation cache invalidation. Resolve every Critical/Important finding before finalizing.

**Step 5: Final commit and report.**

```bash
git status --short
git log -1 --oneline
```

Report exact verification evidence, the best-effort limitation (email can be interrupted and is not retried), review outcome, and that no production deployment is performed until explicitly requested.

# Reply Author Email Notification Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Email the author of a top-level message-board post when another active pool member replies, without delaying or changing the successful reply response.

**Architecture:** The PoolDO remains the authority for the reply and returns private delivery metadata only to the Worker. The Worker schedules a best-effort `waitUntil()` task after a new committed reply, rechecks the original author against the authoritative pool view, resolves their email in D1, and calls the existing Resend-backed notifier once. The public reply response remains exactly `{ commandVersion }`; self-replies, replays, inactive/suspended authors, missing email, and delivery failures generate no visible error or retry.

**Tech Stack:** TypeScript, Cloudflare Workers/Durable Objects, D1, Hono, Zod, Resend, Vitest.

---

### Task 1: Define and verify reply-notification delivery metadata

**Files:**
- Modify: `src/durable/pool-do.ts`
- Test: `tests/durable/message-board.test.ts`

**Step 1: Write the failing test**

Add a message-board test which creates a top-level post as `owner`, replies as `member`, and asserts the durable command result has a generated `replyId`, `postAuthorId: "owner"`, and `replayed: false`. Repeat the exact reply command and assert it returns the same durable identity with `replayed: true`, without inserting a second row. Keep the existing member-visible read contract unchanged.

**Step 2: Run test to verify it fails**

Run:

```sh
npx vitest run --project=workers tests/durable/message-board.test.ts
```

Expected: FAIL because the reply command currently exposes only `commandVersion` and replays do not identify themselves.

**Step 3: Write minimal implementation**

- Change `replyToMessageBoardPost()` to read the parent top-level post's `author_id` while validating it exists and is not itself a reply.
- Generate and retain a reply ID before inserting the row.
- Persist the internal result `{ commandVersion, replyId, postAuthorId, replayed: false }` in `processed_command`.
- In `execute()`, decorate only `ReplyToMessageBoardPost` replay results with `replayed: true`, mirroring the existing top-level-post replay behavior.
- Do not add a public contract field or enqueue an outbox event.

**Step 4: Run test to verify it passes**

Run:

```sh
npx vitest run --project=workers tests/durable/message-board.test.ts
```

Expected: PASS.

**Step 5: Commit**

```sh
git add src/durable/pool-do.ts tests/durable/message-board.test.ts
git commit -m "feat: retain reply notification identity"
```

### Task 2: Add a Resend notifier for a board reply

**Files:**
- Modify: `src/auth/email-sender.ts`
- Test: `tests/auth/resend-email-sender.test.ts`

**Step 1: Write the failing test**

Add a test invoking `notifyMessageBoardReply` with names/text/pool URL containing HTML-sensitive characters. Assert one direct-recipient Resend request has:

```ts
{
  subject: "New reply in Sunday & Pool",
  text: "Taylor replied to your post in Sunday & Pool:\n\nReply <text>\n\nView reply: https://officepool.football/p/sunday/board#post-post-1",
  html: "<p><strong>Taylor</strong> replied to your post in <strong>Sunday &amp; Pool</strong>.</p><p>Reply &lt;text&gt;</p><p><a href=\"https://officepool.football/p/sunday/board#post-post-1\">View reply</a></p>"
}
```

and idempotency header `reply/reply-1/owner`.

**Step 2: Run test to verify it fails**

Run:

```sh
npx vitest run --project=node tests/auth/resend-email-sender.test.ts
```

Expected: FAIL because `PoolJoinNotifier` has no reply-notification method.

**Step 3: Write minimal implementation**

- Extend `PoolJoinNotifier` with `notifyMessageBoardReply({ to, poolName, replierName, text, boardUrl, idempotencyKey })`.
- Implement it in `createResendPoolJoinNotifier()` with a clear reply subject, escaped HTML interpolation, a direct `to` recipient, and the supplied Resend idempotency key.
- Reuse `sendResend()`; do not log recipients or message content.

**Step 4: Run test to verify it passes**

Run:

```sh
npx vitest run --project=node tests/auth/resend-email-sender.test.ts
```

Expected: PASS.

**Step 5: Commit**

```sh
git add src/auth/email-sender.ts tests/auth/resend-email-sender.test.ts
git commit -m "feat: add message board reply email"
```

### Task 3: Schedule the notification from the Worker without changing the public API

**Files:**
- Modify: `src/worker/routes.ts`
- Test: `tests/worker/api.test.ts`

**Step 1: Write failing tests**

Add Worker tests using an injected notifier and a deferred promise to prove:

1. A member replying to another active author's post returns HTTP 200 with exactly `{ commandVersion }` before notification completion, then notifies only the original author with a same-origin `#post-<postId>` URL and idempotency key `reply/<replyId>/<authorId>`.
2. An exact request replay returns the same public response but schedules no second email.
3. A self-reply sends no email.
4. If the original author is suspended before dispatch, no email is sent.

**Step 2: Run tests to verify they fail**

Run:

```sh
npx vitest run --project=workers tests/worker/api.test.ts
```

Expected: FAIL because the reply route returns the durable result directly and schedules no background notification.

**Step 3: Write minimal implementation**

- Define a Worker-private strict Zod schema for the internal reply result: `commandVersion`, `replyId`, `postAuthorId`, and `replayed`.
- In the reply route, parse the internal result, construct the public response using `MessageBoardMutationResponse`, and return only that public schema.
- For a non-replayed, non-self reply with a notifier configured, use `c.executionCtx.waitUntil()` to dispatch a best-effort notification.
- The dispatcher must obtain a fresh authoritative `ReadPoolView` using the replier as actor; find the original post author, require `status === "active"`, resolve only that user's email from D1, derive the replier display name from the view (falling back to `user.name`), and notify once.
- Build the link from the request origin and encoded pool slug/post ID. Swallow all dispatch errors at the `waitUntil()` boundary. Do not expose recipient data or delivery status in HTTP responses.

**Step 4: Run tests to verify they pass**

Run:

```sh
npx vitest run --project=workers tests/worker/api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```sh
git add src/worker/routes.ts tests/worker/api.test.ts
git commit -m "feat: notify authors about board replies"
```

### Task 4: Validate the feature boundary

**Files:**
- Modify: `docs/plans/2026-09-04-reply-author-email.md`

**Step 1: Run focused feature tests**

```sh
npx vitest run --project=node tests/auth/resend-email-sender.test.ts
npx vitest run --project=workers tests/durable/message-board.test.ts tests/worker/api.test.ts
```

Expected: PASS.

**Step 2: Run static validation**

```sh
npm run typecheck
```

Expected: PASS.

**Step 3: Inspect the final diff**

```sh
git diff --check
git status --short
git log --oneline -3
```

Expected: only the feature source/tests/plan changes are present; no E2E suite is run under the project instruction.

**Step 4: Commit the plan update if needed**

```sh
git add docs/plans/2026-09-04-reply-author-email.md
git commit -m "docs: plan reply author email notification"
```

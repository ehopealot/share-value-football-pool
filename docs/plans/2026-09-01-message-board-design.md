# Pool Message Board Design

## Goal

Add a member-only pool message board as the final primary navigation link. Members can create top-level text posts and reply once to a top-level post. The board shows each author's current pool nickname and a timestamp, alternates top-level thread backgrounds, and shows a visible, accessible **New** marker when activity exists after that member's durable read high-water mark.

## Scope and judgment calls

- Messages are plain text only, trimmed to **1–1000 characters**. React renders text, never HTML or markdown.
- The board has top-level threads and exactly one reply level. Replies cannot target replies.
- Threads sort by their most recent activity, newest first; replies within a thread sort oldest first.
- There is no edit, delete, reaction, moderation, search, or pagination work in this feature. The pool is intentionally small and the requested interaction model does not require those controls.
- A post author is considered to have read the activity they just created. A member with no watermark and any existing board activity is unread.
- Nicknames are resolved from the current pool member record, matching existing standings and activity behavior; renaming a nickname updates its board display too.

## Alternatives considered

1. **D1-backed board:** rejected because D1 is explicitly a repairable discovery projection and cannot authorize membership or serialize the per-pool read watermark.
2. **One JSON blob per pool:** rejected because replies, independent idempotent commands, ordering, and high-water comparisons require serializable row-level state.
3. **Separate post and reply tables:** rejected as unnecessary for one reply level. One entry table supports the required hierarchy while keeping reads and backup small.

## Authoritative data model

The Pool Durable Object receives two SQLite tables through `poolSchema`:

```sql
message_board_entry (
  id TEXT PRIMARY KEY,
  parent_post_id TEXT NULL,
  author_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activity_at TEXT NOT NULL
)

message_board_read (
  member_id TEXT PRIMARY KEY,
  last_read_at TEXT NOT NULL
)
```

`parent_post_id` is `NULL` for a top-level post. The command handler verifies that a reply's parent exists and is itself top-level; it never accepts a reply-to-reply reference. A reply gets its own creation/activity timestamp and advances its parent's `activity_at` to that timestamp. Indexes support parent/reply chronological reads and top-level activity ordering.

`activity_at` is a UTC ISO timestamp generated in serialized DO code. Each new board activity is strictly later than the maximum existing board activity timestamp; when `Date.now()` repeats, the helper advances one millisecond. This avoids a same-millisecond post or reply being lost behind a timestamp high-water mark. Opening an empty board does not create a watermark, so the first later post cannot be missed.

The latest top-level `activity_at` is compared with the caller's `last_read_at`. No watermark plus an existing latest activity is unread. Otherwise, activity is unread only when it is lexically/chronologically greater than the watermark. The board-read operation updates the caller's watermark in the same Durable Object transaction that returns its threads, using a monotonic upsert. Post and reply commands also advance their author's watermark to their own activity timestamp.

## Commands, reads, and HTTP boundary

New member-only DO operations are:

- `ReadMessageBoard`: returns the nested thread DTO and atomically advances the caller's watermark to the latest observed activity. It creates no processed-command row, outbox event, or alarm.
- `CreateMessageBoardPost`: inserts a top-level entry, advances the author's watermark, and bumps the pool command version.
- `ReplyToMessageBoardPost`: verifies a top-level parent, inserts the reply, advances parent activity and the author's watermark, and bumps the pool command version.

Post and reply use existing processed-command idempotency, so a lost browser response can repeat exactly the same text and key without creating a duplicate. They are explicitly excluded from D1 projection/outbox and alarm work even though they increment command version. `ReadMessageBoard` is intentionally not an idempotent command and has no processed-command persistence. The implementation centralizes this decision (for example, a `shouldEnqueueOutbox()` classifier) and tests that create/reply emit no outbox row or alarm.

Because reading advances durable state, it is never exposed through a GET route. All board operations are authenticated, active-member-only, same-origin CSRF-protected POST requests:

- `POST /api/p/:slug/board/read`
- `POST /api/p/:slug/board/posts`
- `POST /api/p/:slug/board/posts/:postId/replies`

The read endpoint accepts only a strict empty request body and forwards `ReadMessageBoard` through the same member mutation/CSRF boundary; it does not create an idempotency record. Post/reply request bodies contain `text` and `idempotencyKey`, are validated at the HTTP boundary, require same-origin CSRF protection and an authenticated active member, then are revalidated by the authoritative command schema. No `GET /api/p/:slug/board` endpoint exists. Tests prove missing-origin and foreign-origin read requests cannot advance a watermark.

Every response is a strict Zod contract. `ReadMessageBoardResponse` is parsed by both the Worker after `router.send(...)` and the browser API. `MessageBoardMutationResponse` is a strict concrete object (at minimum `{ commandVersion }`) and is likewise parsed at both boundaries; neither path returns `unknown` to the page. `ReadPoolView.currentMember` gains required `hasUnreadBoard`, allowing the layout to render the marker without a second board request. All fixtures and typed test data must include this required field.

Infrastructure backups include raw message-board entries and watermark rows. The public member audit export intentionally remains unchanged: it is an accounting/audit contract, not a second message-board API.

## Browser behavior and accessibility

`Layout` retains the full `ReadPoolView`, listens for a local pool-view invalidation event, and renders **Message board** after **Rules** as the final pool link. When `hasUnreadBoard` is true, a visible text `New` marker is part of the link's accessible name; it is not color-only. Its asynchronous view loading uses effect-local cancellation or a monotonically owned request generation, so an older `hasUnreadBoard: true` response resolving after a newer false response cannot restore the marker.

`MessageBoardPage` loads the board using the CSRF-protected typed read API. A new top-level post textarea is explicitly labelled. Each top-level article has a Reply button that reveals an explicitly labelled reply textarea; replies have no reply control. The page uses `useFrozenAdminCommand` so a retry preserves a command's idempotency key and body until success or text changes. Successful board read/post/reply calls invalidate the pool view, clearing the current member's nav marker without a reload.

The thread uses semantic `<article>`, heading/author text, `<time dateTime>` timestamps, and nested reply articles. Only top-level thread cards alternate neutral backgrounds. Controls satisfy the existing narrow-screen 44px target rule; textareas are responsive and errors are focusable alerts.

## Validation contract

The implementation must demonstrate:

1. Only active members can read or mutate the board; anonymous, outsider, suspended, malformed, missing-origin, foreign-origin, and bad-parent requests are rejected. A rejected cross-site read cannot change the target member's HWM.
2. A top-level post and one reply level persist in the intended order, display current nicknames/timestamps, and no reply-to-reply command succeeds.
3. Identical post/reply retries are idempotent; a different body with the same key conflicts. Post/reply increment command version but generate no outbox record, projection delivery, or alarm; reads generate neither a processed-command row nor an outbox/alarm.
4. Timestamp generation and HWM comparison do not miss equal-clock activity; opening the board clears an existing indicator; author activity stays read for the author and appears new to other members.
5. Strict Worker and browser response contracts reject missing and extra fields. The strict required `hasUnreadBoard` field is present in every affected `ReadPoolView` fixture.
6. The final nav link/marker, semantic page controls, alternating parent cards, responsive layout, 44px mobile controls, and stale-layout-response protection are covered. A deferred old `true` view response resolving last cannot restore `New` after a newer false result.
7. Infrastructure backup retains the new durable board tables without widening the public member audit export.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const pools = (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO;
const send = async (slug: string, command: unknown): Promise<Record<string, any>> => {
  const response = await pools.get(pools.idFromName(slug)).fetch("https://pool.test/command", { method: "POST", body: JSON.stringify(command) });
  return response.json() as Promise<Record<string, any>>;
};
const storage = <T>(slug: string, callback: (instance: object, state: DurableObjectState) => T | Promise<T>) => runInDurableObject(pools.get(pools.idFromName(slug)), (instance, state) => callback(instance, state));
const initialize = (slug: string) => send(slug, { type: "InitializePool", commandId: "init", poolId: slug, slug, poolName: "Message board", creatorId: "owner", creatorName: "Owner", password: "correct-password" });
const join = (slug: string, actorId: string, displayName: string) => send(slug, { type: "JoinPool", commandId: `join-${actorId}`, actorId, displayName, password: "correct-password" });
const view = (slug: string, actorId: string, commandId = `view-${crypto.randomUUID()}`) => send(slug, { type: "ReadPoolView", commandId, actorId });
const read = (slug: string, actorId: string, commandId = `read-${crypto.randomUUID()}`) => send(slug, { type: "ReadMessageBoard", commandId, actorId });
const post = (slug: string, actorId: string, commandId: string, text: string) => send(slug, { type: "CreateMessageBoardPost", commandId, actorId, text });
const reply = (slug: string, actorId: string, commandId: string, postId: string, text: string) => send(slug, { type: "ReplyToMessageBoardPost", commandId, actorId, postId, text });

describe("PoolDO message board", () => {
  it("keeps top-level threads newest by activity while replies remain chronological and one level deep", async () => {
    const slug = `message-board-order-${crypto.randomUUID()}`;
    await initialize(slug);
    await join(slug, "member", "Original nickname");

    expect(await post(slug, "owner", "post-first", "First thread")).toEqual({ commandVersion: expect.any(String) });
    const firstPostId = String((await read(slug, "owner")).threads[0].postId);
    expect(await post(slug, "member", "post-second", "Second thread")).toEqual({ commandVersion: expect.any(String) });
    expect(await reply(slug, "member", "reply-first", firstPostId, "First reply")).toEqual({ commandVersion: expect.any(String) });
    expect(await reply(slug, "owner", "reply-second", firstPostId, "Second reply")).toEqual({ commandVersion: expect.any(String) });
    expect(await send(slug, { type: "UpdateMemberNickname", commandId: "rename-member", actorId: "member", displayName: "Sunday Shark" })).toMatchObject({ commandVersion: expect.any(String) });

    const board = await read(slug, "owner");
    expect(board.threads.map((thread: any) => thread.text)).toEqual(["First thread", "Second thread"]);
    expect(board.threads[0]).toMatchObject({ postId: firstPostId, authorDisplayName: "Owner", text: "First thread", createdAt: expect.any(String), activityAt: expect.any(String), replies: [{ replyId: expect.any(String), authorDisplayName: "Sunday Shark", text: "First reply", createdAt: expect.any(String) }, { replyId: expect.any(String), authorDisplayName: "Owner", text: "Second reply", createdAt: expect.any(String) }] });
    expect(board.threads[0].replies.map((item: any) => item.text)).toEqual(["First reply", "Second reply"]);
    expect(board.threads[0].activityAt).toBe(board.threads[0].replies[1].createdAt);

    expect(await reply(slug, "owner", "missing-parent", "missing-post", "Nope")).toEqual({ code: "MESSAGE_BOARD_POST_NOT_FOUND" });
    expect(await reply(slug, "owner", "reply-to-reply", board.threads[0].replies[0].replyId, "No nesting")).toEqual({ code: "MESSAGE_BOARD_REPLY_NOT_ALLOWED" });
  }, 30_000);

  it("replays board mutations without projection work and leaves state-changing reads unrecorded", async () => {
    const slug = `message-board-effects-${crypto.randomUUID()}`;
    await initialize(slug);
    await join(slug, "member", "Member");
    await storage(slug, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM outbox");
      await state.storage.deleteAlarm();
    });

    const beforePost = Number((await view(slug, "owner")).commandVersion);
    const first = await post(slug, "owner", "post-idempotent", "One durable post");
    expect(first).toEqual({ commandVersion: String(beforePost + 1) });
    expect(await post(slug, "owner", "post-idempotent", "One durable post")).toEqual(first);
    expect(await post(slug, "owner", "post-idempotent", "Changed text")).toEqual({ code: "IDEMPOTENCY_CONFLICT" });
    const postId = String((await read(slug, "owner", "board-read")).threads[0].postId);
    const beforeReply = Number((await view(slug, "member")).commandVersion);
    const firstReply = await reply(slug, "member", "reply-idempotent", postId, "One durable reply");
    expect(firstReply).toEqual({ commandVersion: String(beforeReply + 1) });
    expect(await reply(slug, "member", "reply-idempotent", postId, "One durable reply")).toEqual(firstReply);
    expect(await reply(slug, "member", "reply-idempotent", postId, "Changed reply")).toEqual({ code: "IDEMPOTENCY_CONFLICT" });

    expect(await storage(slug, async (_instance, state) => ({
      entries: [...state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM message_board_entry")][0],
      postCommand: [...state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM processed_command WHERE id = 'post-idempotent'")][0],
      replyCommand: [...state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM processed_command WHERE id = 'reply-idempotent'")][0],
      readCommand: [...state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM processed_command WHERE id = 'board-read'")][0],
      outbox: [...state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM outbox")][0],
      alarm: await state.storage.getAlarm()
    }))).toEqual({ entries: { count: 2 }, postCommand: { count: 1 }, replyCommand: { count: 1 }, readCommand: { count: 0 }, outbox: { count: 0 }, alarm: null });
  }, 30_000);

  it("tracks each member's unread high-water mark and never loses equal-clock board activity", async () => {
    const slug = `message-board-watermark-${crypto.randomUUID()}`;
    await initialize(slug);
    await join(slug, "member", "Member");
    expect((await view(slug, "owner")).currentMember.hasUnreadBoard).toBe(false);

    await post(slug, "owner", "post-watermark", "Unread for everyone else");
    expect((await view(slug, "owner")).currentMember.hasUnreadBoard).toBe(false);
    expect((await view(slug, "member")).currentMember.hasUnreadBoard).toBe(true);
    expect((await read(slug, "member", "member-read")).threads).toHaveLength(1);
    expect((await view(slug, "member")).currentMember.hasUnreadBoard).toBe(false);

    const postId = String((await read(slug, "owner")).threads[0].postId);
    await reply(slug, "member", "reply-watermark", postId, "This makes it new again");
    expect((await view(slug, "member")).currentMember.hasUnreadBoard).toBe(false);
    expect((await view(slug, "owner")).currentMember.hasUnreadBoard).toBe(true);
    await join(slug, "late-member", "Late member");
    expect((await view(slug, "late-member")).currentMember.hasUnreadBoard).toBe(true);

    const fixedActivityAt = "2099-01-01T00:00:00.000Z";
    await storage(slug, (instance, state) => {
      (instance as { authoritativeTime(): Date }).authoritativeTime = () => new Date(fixedActivityAt);
      state.storage.sql.exec("INSERT INTO message_board_entry (id, parent_post_id, author_id, text, created_at, activity_at) VALUES ('equal-clock-existing', NULL, 'owner', 'Existing at the frozen clock', ?, ?)", fixedActivityAt, fixedActivityAt);
    });
    await read(slug, "late-member", "late-member-frozen-read");
    expect((await view(slug, "late-member")).currentMember.hasUnreadBoard).toBe(false);
    await post(slug, "owner", "post-equal-clock", "Later than the frozen clock");
    expect(await storage(slug, (_instance, state) => [...state.storage.sql.exec<{ activity_at: string }>("SELECT activity_at FROM message_board_entry WHERE text = 'Later than the frozen clock'")][0])).toEqual({ activity_at: "2099-01-01T00:00:00.001Z" });
    expect((await view(slug, "late-member")).currentMember.hasUnreadBoard).toBe(true);
  }, 30_000);
});

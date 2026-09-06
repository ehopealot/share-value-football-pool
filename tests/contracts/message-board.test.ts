import { describe, expect, it } from "vitest";
import { MessageBoardMutationResponse, MessageBoardPostResponse, ReadMessageBoardResponse, messageBoardMutationRequest, messageBoardPostRequest } from "../../src/contracts/http";
import { poolCommandSchema } from "../../src/durable/pool-commands";

const createdAt = "2030-09-01T12:00:00.000Z";
const thread = {
  postId: "post-1",
  authorDisplayName: "Sunday Shark",
  text: "Ready for kickoff?",
  createdAt,
  activityAt: "2030-09-01T12:01:00.000Z", isAnnouncement: false,
  replies: [{ replyId: "reply-1", authorDisplayName: "Fourth Quarter", text: "Absolutely.", createdAt: "2030-09-01T12:01:00.000Z" }]
};

describe("message board contracts", () => {
  it("strictly parses announcement-aware board snapshots and exact mutation results", () => {
    expect(ReadMessageBoardResponse.parse({ commandVersion: "4", canAnnounce: true, threads: [{ ...thread, isAnnouncement: true }] })).toEqual({ commandVersion: "4", canAnnounce: true, threads: [{ ...thread, isAnnouncement: true }] });
    expect(MessageBoardPostResponse.parse({ commandVersion: "5", postId: "post-1", isAnnouncement: true, replayed: false })).toEqual({ commandVersion: "5", postId: "post-1", isAnnouncement: true, replayed: false });
    expect(MessageBoardMutationResponse.parse({ commandVersion: "5" })).toEqual({ commandVersion: "5" });

    expect(() => ReadMessageBoardResponse.parse({ commandVersion: "4", canAnnounce: true, threads: [{ ...thread, replies: [{ ...thread.replies[0], authorDisplayName: undefined }] }] })).toThrow();
    expect(() => ReadMessageBoardResponse.parse({ commandVersion: "4", canAnnounce: undefined, threads: [thread] })).toThrow();
    expect(() => ReadMessageBoardResponse.parse({ commandVersion: "4", canAnnounce: true, threads: [{ ...thread, extra: true }] })).toThrow();
    expect(() => ReadMessageBoardResponse.parse({ commandVersion: "4", canAnnounce: true, threads: [thread], extra: true })).toThrow();
    expect(MessageBoardPostResponse.parse({ commandVersion: "5", isAnnouncement: false, replayed: true })).toEqual({ commandVersion: "5", isAnnouncement: false, replayed: true });
    expect(() => MessageBoardPostResponse.parse({ commandVersion: "5", isAnnouncement: false, replayed: false })).toThrow();
    expect(() => MessageBoardPostResponse.parse({ commandVersion: "5", postId: "post-1", isAnnouncement: true })).toThrow();
    expect(() => MessageBoardMutationResponse.parse({})).toThrow();
    expect(() => MessageBoardMutationResponse.parse({ commandVersion: "5", postId: "unexpected" })).toThrow();
  });

  it("accepts only bounded announcement post shapes and keeps replies ordinary", () => {
    const post = { type: "CreateMessageBoardPost", commandId: "post-key", actorId: "member", text: "Game on", announcement: true };
    expect(poolCommandSchema.parse(post)).toEqual(post);
    expect(messageBoardPostRequest.parse({ text: "Game on", idempotencyKey: "post-key", announcement: true })).toEqual({ text: "Game on", idempotencyKey: "post-key", announcement: true });
    expect(messageBoardPostRequest.parse({ text: "Game on", idempotencyKey: "post-key" })).toEqual({ text: "Game on", idempotencyKey: "post-key", announcement: false });
    const reply = { text: "I agree", idempotencyKey: "reply-key" };
    expect(messageBoardMutationRequest.parse(reply)).toEqual(reply);
    expect(() => messageBoardMutationRequest.parse({ ...reply, announcement: true })).toThrow();
    expect(poolCommandSchema.parse({ type: "ReplyToMessageBoardPost", commandId: "reply-key", actorId: "member", postId: "post-key", text: "I agree" })).toEqual({ type: "ReplyToMessageBoardPost", commandId: "reply-key", actorId: "member", postId: "post-key", text: "I agree" });
    expect(poolCommandSchema.parse({ type: "ReadMessageBoard", commandId: "read-key", actorId: "member" })).toEqual({ type: "ReadMessageBoard", commandId: "read-key", actorId: "member" });

    for (const text of ["", "   ", "x".repeat(1001)]) {
      expect(poolCommandSchema.safeParse({ ...post, commandId: `${post.commandId}-${text.length}`, text }).success).toBe(false);
    }
    expect(poolCommandSchema.safeParse({ ...post, announcement: "true" }).success).toBe(false);
    expect(poolCommandSchema.safeParse({ ...post, extra: true }).success).toBe(false);
    expect(messageBoardPostRequest.safeParse({ text: "Game on", idempotencyKey: "post-key", announcement: "true" }).success).toBe(false);
    expect(poolCommandSchema.safeParse({ type: "ReplyToMessageBoardPost", commandId: "reply-key", actorId: "member", text: "No parent" }).success).toBe(false);
    expect(poolCommandSchema.safeParse({ type: "ReplyToMessageBoardPost", commandId: "reply-key", actorId: "member", postId: "post-key", text: "I agree", announcement: true }).success).toBe(false);
  });
});

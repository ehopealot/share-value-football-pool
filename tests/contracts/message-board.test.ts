import { describe, expect, it } from "vitest";
import { MessageBoardMutationResponse, ReadMessageBoardResponse } from "../../src/contracts/http";
import { poolCommandSchema } from "../../src/durable/pool-commands";

const createdAt = "2030-09-01T12:00:00.000Z";
const thread = {
  postId: "post-1",
  authorDisplayName: "Sunday Shark",
  text: "Ready for kickoff?",
  createdAt,
  activityAt: "2030-09-01T12:01:00.000Z",
  replies: [{ replyId: "reply-1", authorDisplayName: "Fourth Quarter", text: "Absolutely.", createdAt: "2030-09-01T12:01:00.000Z" }]
};

describe("message board contracts", () => {
  it("strictly parses the nested board snapshot and exact mutation result", () => {
    expect(ReadMessageBoardResponse.parse({ commandVersion: "4", threads: [thread] })).toEqual({ commandVersion: "4", threads: [thread] });
    expect(MessageBoardMutationResponse.parse({ commandVersion: "5" })).toEqual({ commandVersion: "5" });

    expect(() => ReadMessageBoardResponse.parse({ commandVersion: "4", threads: [{ ...thread, replies: [{ ...thread.replies[0], authorDisplayName: undefined }] }] })).toThrow();
    expect(() => ReadMessageBoardResponse.parse({ commandVersion: "4", threads: [{ ...thread, extra: true }] })).toThrow();
    expect(() => ReadMessageBoardResponse.parse({ commandVersion: "4", threads: [thread], extra: true })).toThrow();
    expect(() => MessageBoardMutationResponse.parse({})).toThrow();
    expect(() => MessageBoardMutationResponse.parse({ commandVersion: "5", postId: "unexpected" })).toThrow();
  });

  it("accepts only active-member board command shapes and bounded trimmed text", () => {
    const post = { type: "CreateMessageBoardPost", commandId: "post-key", actorId: "member", text: "Game on" };
    expect(poolCommandSchema.parse(post)).toEqual(post);
    expect(poolCommandSchema.parse({ type: "ReplyToMessageBoardPost", commandId: "reply-key", actorId: "member", postId: "post-key", text: "I agree" })).toMatchObject({ type: "ReplyToMessageBoardPost", postId: "post-key" });
    expect(poolCommandSchema.parse({ type: "ReadMessageBoard", commandId: "read-key", actorId: "member" })).toMatchObject({ type: "ReadMessageBoard", actorId: "member" });

    for (const text of ["", "   ", "x".repeat(1001)]) {
      expect(poolCommandSchema.safeParse({ ...post, commandId: `${post.commandId}-${text.length}`, text }).success).toBe(false);
    }
    expect(poolCommandSchema.safeParse({ ...post, extra: true }).success).toBe(false);
    expect(poolCommandSchema.safeParse({ type: "ReplyToMessageBoardPost", commandId: "reply-key", actorId: "member", text: "No parent" }).success).toBe(false);
  });
});

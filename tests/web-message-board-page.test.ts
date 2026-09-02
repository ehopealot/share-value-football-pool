import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PoolNavigation, PoolViewLoadGeneration } from "../src/web/components/Layout";
import { api, onPoolViewInvalidated } from "../src/web/api";
import { MessageBoardThreads, createMessageBoardPostAndInvalidate, readMessageBoardAndInvalidate, replyToMessageBoardPostAndInvalidate } from "../src/web/pages/MessageBoardPage";

const root = resolve(import.meta.dirname, "..");
const pageSource = () => readFileSync(resolve(root, "src/web/pages/MessageBoardPage.tsx"), "utf8");
const routerSource = () => readFileSync(resolve(root, "src/web/router.tsx"), "utf8");
const css = () => readFileSync(resolve(root, "src/web/styles.css"), "utf8");

const view = {
  commandVersion: "7",
  pool: { poolId: "pool-id", slug: "pool", name: "Office pool", commissionerId: "commissioner", signupsOpen: true, maxSideBetMicros: "800000000" },
  activeSeason: null, nextDraftSeason: null, latestClosedSeason: null,
  currentMember: { memberId: "member", role: "member" as const, seasonBalances: [], hasUnreadBoard: true },
  members: [], commissioner: null
};
const board = {
  commandVersion: "8",
  threads: [{ postId: "post-1", authorDisplayName: "Sunday Shark", text: "Who is ready?", createdAt: "2030-09-01T12:00:00.000Z", activityAt: "2030-09-01T12:01:00.000Z", replies: [{ replyId: "reply-1", authorDisplayName: "Fourth Quarter", text: "I am.", createdAt: "2030-09-01T12:01:00.000Z" }] }]
};

describe("Message board presentation and nav state", () => {
  afterEach(() => vi.restoreAllMocks());

  it("places the visible New marker in the final Message board pool link", () => {
    const markup = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/p/pool/overview"] }, createElement(PoolNavigation, { slug: "pool", view })));
    const rules = markup.indexOf('href="/p/pool/rules"');
    const boardLink = markup.indexOf('href="/p/pool/board"');
    expect(rules).toBeGreaterThan(-1);
    expect(boardLink).toBeGreaterThan(rules);
    expect(markup.slice(boardLink)).toContain("Message board");
    expect(markup.slice(boardLink)).toContain("New");
  });

  it("fences a deferred older pool view so it cannot restore an unread marker", () => {
    const loads = new PoolViewLoadGeneration();
    const staleTrue = loads.start();
    loads.invalidate();
    const freshFalse = loads.start();
    expect(loads.current(staleTrue)).toBe(false);
    expect(loads.current(freshFalse)).toBe(true);
  });

  it("renders labelled semantic threads and only offers replies on parents", () => {
    const markup = renderToStaticMarkup(createElement(MessageBoardThreads, {
      threads: board.threads, openReplyPostId: "post-1", replyText: "", replyPending: false,
      onToggleReply: () => {}, onReplyTextChange: () => {}, onReplySubmit: () => {}
    }));
    expect(markup).toContain("Sunday Shark");
    expect(markup).toContain("Fourth Quarter");
    expect(markup.match(/<article/g)).toHaveLength(2);
    expect(markup).toContain('dateTime="2030-09-01T12:00:00.000Z"');
    expect(markup).toContain('aria-label="Reply to Sunday Shark"');
    expect(markup.match(/>Reply<\/button>/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Reply to Sunday Shark"');
    const pendingMarkup = renderToStaticMarkup(createElement(MessageBoardThreads, {
      threads: board.threads, openReplyPostId: "post-1", replyText: "Frozen reply", replyPending: true,
      onToggleReply: () => {}, onReplyTextChange: () => {}, onReplySubmit: () => {}
    }));
    expect(pendingMarkup).toMatch(/message-board-reply-toggle"[^>]*disabled/);
    expect(pendingMarkup).toMatch(/<textarea[^>]*disabled/);
    expect(pageSource()).toContain('<label htmlFor="message-board-post">New post</label>');
    expect(pageSource()).toContain("disabled={post.pending}");
    expect(pageSource()).toContain("post.retire()");
    expect(pageSource()).toContain("reply.retire()");
    expect(pageSource()).toContain("onToggleReply={(postId) => { setReplyError");
    expect(pageSource()).not.toContain("onToggleReply={(postId) => { reply.retire()");
  });

  it("invalidates the authoritative pool view after successful reads and mutations", async () => {
    vi.stubGlobal("window", new EventTarget());
    const invalidated = vi.fn();
    const unsubscribe = onPoolViewInvalidated(invalidated);
    const read = vi.spyOn(api, "readMessageBoard").mockResolvedValue(board);
    const post = vi.spyOn(api, "createMessageBoardPost").mockResolvedValue({ commandVersion: "9" });
    const reply = vi.spyOn(api, "replyToMessageBoardPost").mockResolvedValue({ commandVersion: "10" });
    try {
      await expect(readMessageBoardAndInvalidate("pool")).resolves.toEqual(board);
      await expect(createMessageBoardPostAndInvalidate("pool", { text: "Post", idempotencyKey: "post-key" })).resolves.toEqual({ commandVersion: "9" });
      await expect(replyToMessageBoardPostAndInvalidate("pool", "post-1", { text: "Reply", idempotencyKey: "reply-key" })).resolves.toEqual({ commandVersion: "10" });
      expect(read).toHaveBeenCalledWith("pool");
      expect(post).toHaveBeenCalledWith("pool", { text: "Post", idempotencyKey: "post-key" });
      expect(reply).toHaveBeenCalledWith("pool", "post-1", { text: "Reply", idempotencyKey: "reply-key" });
      expect(invalidated).toHaveBeenCalledTimes(3);
    } finally {
      unsubscribe();
      vi.unstubAllGlobals();
    }
  });

  it("keeps a pool-home link in loading and error states and registers the route", () => {
    expect(pageSource()).toContain('role="status"');
    expect(pageSource()).toContain('to={`/p/${slug}/overview`}');
    expect(routerSource()).toContain('path="/p/:slug/board"');
  });

  it("uses responsive parent-card, reply, textarea, and touch-target styles", () => {
    expect(css()).toContain(".message-board-thread");
    expect(css()).toContain(".message-board-thread-alt");
    expect(css()).toContain(".message-board-replies");
    expect(css()).toContain(".message-board-page textarea");
    expect(css()).toMatch(/@media \(max-width: 600px\)[\s\S]*\.message-board-page button[\s\S]*min-height:\s*44px/);
  });
});

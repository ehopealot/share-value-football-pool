import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PoolNavigation, PoolNavigationCache, PoolViewLoadGeneration, SessionLoadGeneration } from "../src/web/components/Layout";
import { api, onPoolViewInvalidated } from "../src/web/api";
import { MessageBoardThreads, createMessageBoardPostAndInvalidate, readMessageBoardAndInvalidate, replyToMessageBoardPostAndInvalidate, scrollMessageBoardFragment, shouldScrollMessageBoardFragment } from "../src/web/pages/MessageBoardPage";

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
  commandVersion: "8", canAnnounce: false,
  threads: [{ postId: "post-1", authorDisplayName: "Sunday Shark", text: "Who is ready?", createdAt: "2030-09-01T12:00:00.000Z", activityAt: "2030-09-01T12:01:00.000Z", isAnnouncement: false, replies: [{ replyId: "reply-1", authorDisplayName: "Fourth Quarter", text: "I am.", createdAt: "2030-09-01T12:01:00.000Z" }] }]
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

  it("fences stale session reads before they can restore an old navigation identity", () => {
    const loads = new SessionLoadGeneration();
    const stale = loads.start();
    loads.invalidate();
    const current = loads.start();
    expect(loads.current(stale)).toBe(false);
    expect(loads.current(current)).toBe(true);
  });

  it("retains a cached pool ribbon only for its authenticated member while clearing a locally read New marker", () => {
    const cache = new PoolNavigationCache();
    cache.setSession({ id: "member-a" });
    cache.store("pool", view);
    expect(cache.get("pool")).toEqual(view);
    expect(cache.markBoardRead("pool")).toMatchObject({ currentMember: { hasUnreadBoard: false } });
    expect(cache.get("pool")).toMatchObject({ currentMember: { hasUnreadBoard: false } });
    cache.setSession({ id: "member-b" });
    expect(cache.get("pool")).toBeUndefined();
    cache.clear();
    expect(cache.get("pool")).toBeUndefined();
  });

  it("replays an encoded board fragment once after asynchronous threads mount", () => {
    const scrollIntoView = vi.fn();
    scrollMessageBoardFragment("#post-post%2F1", (id) => id === "post-post/1" ? { scrollIntoView } as unknown as HTMLElement : null);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(shouldScrollMessageBoardFragment(undefined, "pool", "#post-1")).toBe(true);
    expect(shouldScrollMessageBoardFragment("pool:#post-1", "pool", "#post-1")).toBe(false);
    expect(shouldScrollMessageBoardFragment("pool:#post-1", "pool", "#post-2")).toBe(true);
    expect(() => scrollMessageBoardFragment("#%E0%A4%A", () => null)).not.toThrow();
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
    const announcementMarkup = renderToStaticMarkup(createElement(MessageBoardThreads, {
      threads: [{ ...board.threads[0], isAnnouncement: true }], openReplyPostId: undefined, replyText: "", replyPending: false,
      onToggleReply: () => {}, onReplyTextChange: () => {}, onReplySubmit: () => {}
    }));
    expect(announcementMarkup).toContain('id="post-post-1"');
    expect(announcementMarkup).toContain('title="Commissioner announcement"');
    expect(announcementMarkup).toContain('aria-label="Commissioner announcement"');
    expect(announcementMarkup).toContain('class="message-board-announcement-icon-image"');
    expect(announcementMarkup).toMatch(/<img[^>]*src="[^"]*announcement-color-icon[^"]*"[^>]*alt=""/);
    expect(announcementMarkup).not.toContain("<svg");
    expect(pageSource()).toContain('src="/announcement-color-icon.svg"');
    expect(pageSource()).not.toContain('import announcementIcon');
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
    expect(pageSource()).toContain("board.canAnnounce");
    expect(pageSource()).toContain("Post announcement and email league");
    expect(pageSource()).toContain("Commissioner announcement");
  });

  it("invalidates the authoritative pool view after successful reads and mutations", async () => {
    vi.stubGlobal("window", new EventTarget());
    const invalidated = vi.fn();
    const unsubscribe = onPoolViewInvalidated(invalidated);
    const read = vi.spyOn(api, "readMessageBoard").mockResolvedValue(board);
    const post = vi.spyOn(api, "createMessageBoardPost").mockResolvedValue({ commandVersion: "9", postId: "post-2", isAnnouncement: false, replayed: false });
    const reply = vi.spyOn(api, "replyToMessageBoardPost").mockResolvedValue({ commandVersion: "10" });
    try {
      await expect(readMessageBoardAndInvalidate("pool")).resolves.toEqual(board);
      await expect(createMessageBoardPostAndInvalidate("pool", { text: "Post", idempotencyKey: "post-key", announcement: false })).resolves.toEqual({ commandVersion: "9", postId: "post-2", isAnnouncement: false, replayed: false });
      await expect(replyToMessageBoardPostAndInvalidate("pool", "post-1", { text: "Reply", idempotencyKey: "reply-key" })).resolves.toEqual({ commandVersion: "10" });
      expect(read).toHaveBeenCalledWith("pool");
      expect(post).toHaveBeenCalledWith("pool", { text: "Post", idempotencyKey: "post-key", announcement: false });
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
    expect(css()).toMatch(/\.message-board-announcement-option\s*\{[^}]*flex-direction:\s*row[^}]*justify-self:\s*start[^}]*font-size:\s*0\.85rem/s);
    expect(css()).toMatch(/\.message-board-announcement-icon-image\s*\{[^}]*display:\s*block[^}]*object-fit:\s*contain/s);
    expect(css()).toMatch(/@media \(max-width: 600px\)[\s\S]*\.message-board-page button[\s\S]*min-height:\s*44px/);
  });
});

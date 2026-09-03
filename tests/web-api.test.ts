import { describe, expect, it, vi } from "vitest";
import { api, ApiError, buildParlayPlacement, commandOutcome, errorMessage, invalidatePoolView, onPoolViewInvalidated, parseAuditExportSuccess, parseMessageBoardMutationSuccess, parseMessageBoardPostSuccess, parseOddsBoardSuccess, parseParlayQuoteSuccess, parseReadMessageBoardSuccess } from "../src/web/api";
import { FrozenAdminCommand } from "../src/web/admin-command";
import { boardEnablesWagerReview } from "../src/web/pages/OddsPage";

describe("wager recovery messages", () => {
  it("rejects malformed odds-board feed observations at the browser boundary", () => {
    const response = { offers: [], feed: { status: "no-offer", message: "No current odds are available.", lastPolledAt: null, lastSuccessAt: null } };
    expect(parseOddsBoardSuccess(response)).toEqual(response);
    expect(() => parseOddsBoardSuccess({ offers: [], feed: { ...response.feed, lastPolledAt: undefined } })).toThrow();
    expect(() => parseOddsBoardSuccess({ offers: [], feed: { ...response.feed, status: "made-up" } })).toThrow();
    expect(() => parseOddsBoardSuccess({ offers: [], feed: { ...response.feed, status: "current" } })).toThrow();
    const offer = { eventId: "event-1", league: "nfl", homeTeam: "Home", awayTeam: "Away", startsAt: "2030-09-01T12:00:00.000Z", market: "spread", canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z", offerVersion: "v1", policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -110, point: -3 }] };
    for (const status of ["stale", "provider-error", "no-offer"] as const) {
      const unavailable = { offers: [offer], feed: { ...response.feed, status } };
      expect(() => parseOddsBoardSuccess(unavailable)).toThrow();
      expect(boardEnablesWagerReview(unavailable)).toBe(false);
    }
    expect(boardEnablesWagerReview({ offers: [offer], feed: { ...response.feed, status: "current" } })).toBe(true);
  });

  it("uses strict board transport contracts and encoded member routes", async () => {
    const board = { commandVersion: "7", canAnnounce: true, threads: [{ postId: "post-1", authorDisplayName: "Sunday Shark", text: "Ready?", createdAt: "2030-09-01T12:00:00.000Z", activityAt: "2030-09-01T12:01:00.000Z", isAnnouncement: true, replies: [{ replyId: "reply-1", authorDisplayName: "Fourth Quarter", text: "Yes.", createdAt: "2030-09-01T12:01:00.000Z" }] }] };
    const post = { commandVersion: "8", postId: "post-2", isAnnouncement: true, replayed: false };
    expect(parseReadMessageBoardSuccess(board)).toEqual(board);
    expect(parseMessageBoardPostSuccess(post)).toEqual(post);
    expect(parseMessageBoardMutationSuccess({ commandVersion: "8" })).toEqual({ commandVersion: "8" });
    expect(() => parseReadMessageBoardSuccess({ ...board, unexpected: true })).toThrow();
    expect(() => parseReadMessageBoardSuccess({ commandVersion: "7", threads: [{ ...board.threads[0], replies: [{ ...board.threads[0].replies[0], extra: true }] }] })).toThrow();
    expect(() => parseMessageBoardPostSuccess({ ...post, replayed: undefined })).toThrow();
    expect(() => parseMessageBoardMutationSuccess({ commandVersion: "8", unexpected: true })).toThrow();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      return new Response(JSON.stringify(url.endsWith("/board/read") ? board : url.endsWith("/board/posts") ? post : { commandVersion: "8" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      await expect(api.readMessageBoard("pool/one")).resolves.toEqual(board);
      await expect(api.createMessageBoardPost("pool/one", { text: "Post", idempotencyKey: "post-key", announcement: true })).resolves.toEqual(post);
      await expect(api.replyToMessageBoardPost("pool/one", "post/one", { text: "Reply", idempotencyKey: "reply-key" })).resolves.toEqual({ commandVersion: "8" });
      expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/p/pool%2Fone/board/read", expect.objectContaining({ method: "POST", body: "{}", signal: expect.any(AbortSignal) }));
      expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/p/pool%2Fone/board/posts", expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "Post", idempotencyKey: "post-key", announcement: true }) }));
      expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/p/pool%2Fone/board/posts/post%2Fone/replies", expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "Reply", idempotencyKey: "reply-key" }) }));
    } finally { fetchMock.mockRestore(); }
  });

  it("rejects malformed board responses in the browser client", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ commandVersion: "7", canAnnounce: false, threads: [], extra: true }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      await expect(api.readMessageBoard("pool")).rejects.toThrow();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ commandVersion: "8", postId: "post", isAnnouncement: false, replayed: false, unexpected: true }), { status: 200, headers: { "content-type": "application/json" } }));
      await expect(api.createMessageBoardPost("pool", { text: "Post", idempotencyKey: "post-key", announcement: false })).rejects.toThrow();
    } finally { fetchMock.mockRestore(); }
  });

  it("requires complete owner wager terms at the browser boundary", async () => {
    const leg = { eventId: "event-1", league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-01-01T00:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", market: "spread", selection: "home", originalLine: "-3", originalOdds: 100, eventStartsAt: "2026-01-02T00:00:00.000Z" };
    const open = { wagerId: "open", seasonId: "s", memberId: "member", memberDisplayName: "Member", type: "straight", status: "open", confirmedAt: "2026-01-01T00:00:00.000Z", weekStart: "2025-12-30T05:00:00.000Z", performanceMicros: "0", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", legs: [leg] };
    const historical = { ...open, wagerId: "historic", status: "won", outcome: "won", returnMicros: "2000000", profitMicros: "1000000", settledOdds: null, settledAt: "2026-01-02T00:00:00.000Z" };
    const { returnMicros: _missing, ...incomplete } = historical;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ commandVersion: "1", wagers: [open, historical] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ commandVersion: "1", wagers: [incomplete] }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      await expect(api.wagers("pool")).resolves.toMatchObject({ wagers: [expect.objectContaining({ status: "open" }), expect.objectContaining({ settledOdds: null })] });
      await expect(api.wagers("pool")).rejects.toThrow();
    } finally { fetchMock.mockRestore(); }
  });

  it("notifies mounted layouts after local board activity", () => {
    vi.stubGlobal("window", new EventTarget());
    try {
      const listener = vi.fn();
      const unsubscribe = onPoolViewInvalidated(listener);
      invalidatePoolView();
      expect(listener).toHaveBeenCalledOnce();
      unsubscribe();
      invalidatePoolView();
      expect(listener).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it("uses concise board mutation errors without exposing authority internals", () => {
    expect(errorMessage(new ApiError("MESSAGE_BOARD_POST_NOT_FOUND", 400))).toBe("That post is no longer available.");
    expect(errorMessage(new ApiError("MESSAGE_BOARD_REPLY_NOT_ALLOWED", 400))).toBe("Replies can only be added to a top-level post.");
  });
  it("uses concise unavailable errors", () => {
    expect(errorMessage(new ApiError("REQUEST_FAILED", 504))).toBe("Service unavailable.");
    expect(errorMessage(new ApiError("RECENT_AUTH_REQUIRED", 403))).toBe("Sign in again.");
  });
  it("centralizes stale, retryable, and terminal confirmation outcomes", () => {
    for (const code of ["LINE_CHANGED", "ORDER_QUOTE_STALE"]) expect(commandOutcome(new ApiError(code, 400))).toBe("stale");
    for (const error of [new ApiError("POOL_NOT_AVAILABLE", 503), new ApiError("POOL_UNAVAILABLE", 503), new ApiError("RECENT_AUTH_REQUIRED", 403), new ApiError("UNKNOWN", 500), new Error("transport")]) expect(commandOutcome(error)).toBe("retryable");
    expect(commandOutcome(new ApiError("MARKET_LOCKED", 400))).toBe("terminal");
  });

  it("runtime-validates persisted result evidence at the browser audit boundary", () => {
    const providerResults = [{ eventId: "event-1", league: "nfl", status: "final", homeScore: 24, awayScore: 17, correctionVersion: "provider-1" }];
    const replacementResult = { source: "commissioner_correction", commandId: "correction-command", correctedResults: [{ eventId: "event-1", league: "nfl", status: "final", homeScore: 17, awayScore: 24, correctionVersion: "official-2" }], derived: { outcome: "loss", odds: null } };
    const exported = {
      format: "share-value-pool-audit-v1", commandVersion: "3", pool: { id: "p", slug: "pool", name: "Pool", commissionerId: "c", signupsOpen: true, commandVersion: "3" },
      seasons: [], seasonProviderResults: [], accounts: [], orders: [], ledger: [],
      settlements: [
        { id: "automatic", wagerId: "w", resultVersion: '[["event-1","provider-1"]]', outcome: "win", returnMicros: "2000000", profitMicros: "1000000", settledOdds: 100, sourceResult: providerResults, reversalOf: null, actorId: "system", reason: null, createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "reversal", wagerId: "w", resultVersion: '[["event-1","provider-1"]]', outcome: "reversal", returnMicros: "-2000000", profitMicros: "-1000000", settledOdds: null, sourceResult: providerResults, reversalOf: "automatic", actorId: "c", reason: "Official correction", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "manual", wagerId: "w", resultVersion: 'commissioner:correction-command:[["event-1","official-2"]]', outcome: "loss", returnMicros: "0", profitMicros: "0", settledOdds: null, sourceResult: replacementResult, reversalOf: "automatic", actorId: "c", reason: "Official correction", createdAt: "2026-01-01T00:00:00.000Z" }
      ],
      wagerCorrections: [{ id: "correction", wagerId: "w", actorId: "c", reason: "Official correction", sourceResult: providerResults, replacementResult, commandId: "correction-command", createdAt: "2026-01-01T00:00:00.000Z" }],
      administrationAudit: [], seasonAnnotations: [], wagers: []
    };
    expect(parseAuditExportSuccess(exported).settlements).toHaveLength(3);
    for (const sourceResult of [undefined, "provider-1", { status: "final" }, [{ ...providerResults[0], awayScore: null }]]) {
      expect(() => parseAuditExportSuccess({ ...exported, settlements: [{ ...exported.settlements[0], sourceResult }] })).toThrow();
    }
    for (const replacement of [undefined, 2, { ...replacementResult, derived: { outcome: "loss", odds: 100 } }]) {
      expect(() => parseAuditExportSuccess({ ...exported, wagerCorrections: [{ ...exported.wagerCorrections[0], replacementResult: replacement }] })).toThrow();
    }
  });

  it("preserves exact owner wager fields while parsing a time-redacted audit export", () => {
    const exported = {
      format: "share-value-pool-audit-v1", commandVersion: "3", pool: { id: "p", slug: "pool", name: "Pool", commissionerId: "c", signupsOpen: true, commandVersion: "3" },
      seasons: [], seasonProviderResults: [], accounts: [], orders: [], ledger: [], settlements: [], wagerCorrections: [], administrationAudit: [], seasonAnnotations: [],
      wagers: [{ wagerId: "w", seasonId: "s", memberId: "member", memberDisplayName: "Member", type: "teaser", status: "open", confirmedAt: "2026-01-01T00:00:00.000Z", weekStart: "2025-12-30T05:00:00.000Z", performanceMicros: "0", riskMicros: "900719925474099312345678", acceptedOdds: -120, rulesetVersion: "SHARE_POOL_2026_V1", legs: [{ eventId: "started-event", league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-01-01T00:00:00.000Z", policyVersion: "policy", offerVersion: "offer", market: "spread", selection: "home", originalOdds: -110, eventStartsAt: "2026-01-02T00:00:00.000Z" }] }]
    };
    expect(parseAuditExportSuccess(exported).wagers[0]).toMatchObject({ riskMicros: "900719925474099312345678", acceptedOdds: -120, rulesetVersion: "SHARE_POOL_2026_V1", legs: [{ eventId: "started-event" }] });
    expect(JSON.stringify(exported)).not.toContain("future-event");
  });

  it("uses a concise regrade-before-start error", () => {
    expect(errorMessage(new ApiError("WAGER_NOT_STARTED", 409))).toBe("Wager has not started.");
  });

  it("uses a concise active-season history error", () => {
    expect(errorMessage(new ApiError("SEASON_NOT_CLOSED", 400))).toBe("Season is not closed.");
  });
});

describe("frozen administration command identity", () => {
  it("sends Super Bowl confirmation through the bounded command transport", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ commandVersion: "2" }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      await api.confirmSuperBowl("pool", "season/one", "event", "frozen-key");
      expect(fetchMock).toHaveBeenCalledWith("/api/p/pool/admin/seasons/season%2Fone/super-bowl/confirm", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ eventId: "event", idempotencyKey: "frozen-key" }),
        signal: expect.any(AbortSignal)
      }));
    } finally { fetchMock.mockRestore(); }
  });

  it("replays the identical immutable body and key after a lost response, then retires it on success", async () => {
    const command = new FrozenAdminCommand<{ text: string; idempotencyKey: string }>();
    let text = "Original note";
    const received: Array<{ text: string; idempotencyKey: string }> = [];
    await expect(command.run("annotation:s0", () => ({ text, idempotencyKey: "key-1" }), async (body) => { received.push(body); throw new Error("response lost"); })).rejects.toThrow("response lost");
    text = "Changed without retirement";
    await command.run("annotation:s0", () => ({ text, idempotencyKey: "key-2" }), async (body) => { received.push(body); return {}; });
    await command.run("annotation:s0", () => ({ text, idempotencyKey: "key-3" }), async (body) => { received.push(body); return {}; });
    expect(received).toEqual([
      { text: "Original note", idempotencyKey: "key-1" },
      { text: "Original note", idempotencyKey: "key-1" },
      { text: "Changed without retirement", idempotencyKey: "key-3" }
    ]);
  });

  it("suppresses rapid duplicate submission while a command is in flight and retires on semantic edit", async () => {
    const command = new FrozenAdminCommand<{ resultVersion: string; idempotencyKey: string }>();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const received: Array<{ resultVersion: string; idempotencyKey: string }> = [];
    const first = command.run("regrade:w1", () => ({ resultVersion: "result-1", idempotencyKey: "key-1" }), async (body) => { received.push(body); await barrier; throw new Error("response lost"); });
    expect(command.pending).toBe(true);
    await expect(command.run("regrade:w1", () => ({ resultVersion: "result-2", idempotencyKey: "key-2" }), async (body) => { received.push(body); })).resolves.toBeUndefined();
    release();
    await expect(first).rejects.toThrow("response lost");
    command.retire();
    await command.run("regrade:w1", () => ({ resultVersion: "result-3", idempotencyKey: "key-3" }), async (body) => { received.push(body); });
    expect(received).toEqual([
      { resultVersion: "result-1", idempotencyKey: "key-1" },
      { resultVersion: "result-3", idempotencyKey: "key-3" }
    ]);
  });
});

describe("parlay browser boundary", () => {
  const time = "2030-09-01T12:00:00.000Z";
  const moneyline = {
    eventId: "event-1", league: "nfl", canonicalBook: "DraftKings", retrievedAt: time, policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "offer-1",
    canonicalOfferProof: { offerId: "event-1:moneyline:home", eventId: "event-1", offerVersion: "offer-1", canonicalBook: "DraftKings", market: "moneyline", selection: "home", odds: -110, line: null },
    market: "moneyline", selection: "home", originalLine: null, adjustedLine: null, originalOdds: -105,
    eventStartsAt: "2030-09-02T12:00:00.000Z", homeTeam: "Home", awayTeam: "Away"
  } as const;
  const total = {
    ...moneyline,
    canonicalOfferProof: { offerId: "event-1:total:over", eventId: "event-1", offerVersion: "offer-1", canonicalBook: "DraftKings", market: "total", selection: "over", odds: -110, line: 47.5 },
    market: "total", selection: "over", originalLine: 47.5, adjustedLine: 47.5, originalOdds: -110
  } as const;
  const request = {
    wagerId: "parlay-wager", quoteKey: "parlay-quote", commandId: "parlay-quote", seasonId: "season-1", riskMicros: "1000000", rulesetVersion: "PARLAY_2026_V1" as const,
    legs: [
      { eventId: moneyline.eventId, canonicalBook: moneyline.canonicalBook, market: moneyline.market, selection: moneyline.selection, offerId: moneyline.canonicalOfferProof.offerId, offerVersion: moneyline.offerVersion },
      { eventId: total.eventId, canonicalBook: total.canonicalBook, market: total.market, selection: total.selection, offerId: total.canonicalOfferProof.offerId, offerVersion: total.offerVersion }
    ]
  };
  const quote = { quoteKey: request.quoteKey, seasonId: request.seasonId, ownerMemberId: "member-1", riskMicros: request.riskMicros, acceptedOdds: 191, rulesetVersion: request.rulesetVersion, commandVersion: "12", legs: [moneyline, total] };

  it("parses parlay snapshots, builds fixed placements, and uses the dedicated quote transport", async () => {
    expect(parseParlayQuoteSuccess(request, quote)).toEqual(quote);
    expect(() => parseParlayQuoteSuccess(request, { ...quote, legs: [...quote.legs].reverse() })).toThrow();
    expect(buildParlayPlacement(quote, "placed-parlay", "parlay-place")).toMatchObject({
      wagerId: "placed-parlay",
      quoteKey: quote.quoteKey,
      quotedCommandVersion: quote.commandVersion,
      commandId: "parlay-place",
      mutationKey: "parlay-place",
      acceptedOdds: 191,
      legs: quote.legs
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(quote), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      await expect(api.quoteParlay("pool/one", request)).resolves.toEqual(quote);
      expect(fetchMock).toHaveBeenCalledWith("/api/p/pool%2Fone/wagers/parlays/quote", expect.objectContaining({ method: "POST", body: JSON.stringify(request), signal: expect.any(AbortSignal) }));
    } finally { fetchMock.mockRestore(); }
  });
});

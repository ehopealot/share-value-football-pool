import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/web/api";
import { HomeLoadGeneration, loadHome } from "../src/web/pages/HomePage";
import { destination } from "../src/web/pages/AuthPages";
import { boardEnablesWagerReview, failureReason, groupBoardByEvent, inWeek, nextWeekStart, SEASON_WEEK1_ANCHOR, straightPlacementBatchTransition, straightQuoteRequest, trayLabel, weekStartOf } from "../src/web/pages/OddsPage";
import { outcomeForSelection, selectionForOutcome } from "../src/web/selection-matcher";
import { addTeaserLeg, teaserLegForOutcome, validateTeaser } from "../src/web/teaser-slip";
import { editTeaserSemantic, recoverTeaserSemantic, retryTeaserSemantic, teaserPlacementAttemptTransition, teaserRecoveryTransition, teaserTerminalTransition, teaserUnknownPlacementMessage, teaserUnresolvedPlacementTransition } from "../src/web/pages/TeaserPage";
import { recoverStaleOrderEditor, retryReversalState } from "../src/web/pages/AdminOrdersPage";
import { projectAdminOrders } from "../src/web/pages/admin-orders-lifecycle";
import { PageGeneration } from "../src/web/page-generation";

describe("entry redirects", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("preserves same-origin application paths, query, and hash", () => {
    vi.stubGlobal("location", new URL("https://pool.example.test/"));
    expect(destination("?next=%2Fp%2Fpool%2Foverview%3Ftab%3Dactivity%23latest")).toBe("/p/pool/overview?tab=activity#latest");
  });
  it("rejects protocol-relative, absolute, encoded, and backslash redirect tricks", () => {
    vi.stubGlobal("location", new URL("https://pool.example.test/"));
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example", "/%5Cevil.example", "/.//evil.example", "/path/..//evil.example"]) expect(destination(`?next=${encodeURIComponent(next)}`)).toBe("/");
  });
  it("normalizes Better Auth's null session to ordinary signed-out state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null", { status: 200, headers: { "content-type": "application/json" } })));
    await expect(api.session()).resolves.toEqual({ user: undefined });
  });
  it("invalidates a delayed pre-logout Home load before it can restore memberships", () => {
    const loads = new HomeLoadGeneration();
    const beforeLogout = loads.start();
    expect(loads.invalidate()).toEqual({ user: null, error: "" });
    expect(loads.current(beforeLogout)).toBe(false);
    expect(loads.current(loads.start())).toBe(true);
  });
  it("retries the session-first Home load and returns recovered memberships", async () => {
    const session = vi.spyOn(api, "session").mockResolvedValue({ user: { id: "u1", name: "Member", email: "member@example.test" } });
    const memberships = vi.spyOn(api, "memberships").mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce({ memberships: [{ poolId: "p1", slug: "recovered", poolName: "Recovered Pool", role: "member", status: "active", projectionVersion: "1" }] });
    await expect(loadHome()).resolves.toMatchObject({ error: "We could not load your pool list. Try again from Home." });
    await expect(loadHome()).resolves.toMatchObject({ error: "", memberships: [expect.objectContaining({ poolName: "Recovered Pool" })] });
    expect(session).toHaveBeenCalledTimes(2);
    expect(memberships).toHaveBeenCalledTimes(2);
    session.mockRestore(); memberships.mockRestore();
  });
  it("projects Admin Orders lifecycle and reversal pairing from ReadPoolView", () => {
    const base = { commandVersion: "1", pool: { poolId: "pool", slug: "pool", name: "Pool", commissionerId: "commissioner", signupsOpen: true, maxSideBetMicros: "800000000", commissionerNotice: null }, currentMember: { memberId: "commissioner", role: "commissioner" as const, seasonBalances: [], hasUnreadBoard: false }, members: [{ memberId: "commissioner", displayName: "Commissioner", role: "commissioner" as const, status: "active" as const }], commissioner: { seasonOrders: [] } };
    expect(projectAdminOrders({ ...base, activeSeason: null, nextDraftSeason: null, latestClosedSeason: null })).toMatchObject({ notice: "No active season. Create and open a season before issuing orders.", canOrder: false });
    const active = { id: "season", label: "2026", rulesetVersion: "SHARE_POOL_2026_V1", state: "active" as const, defaultOrderMode: "shares" as const, defaultOrderAmountMicros: "1000000", createdAt: "2030-01-01T00:00:00.000Z", openedAt: "2030-01-01T00:00:00.000Z", closedAt: null, floatMicros: "0", notionalValueMicros: "0" };
    const original = { orderId: "original", memberId: "commissioner", mode: "shares" as const, requestedMicros: "1000000", sharesMicros: "1000000", valueMicros: "1000000", priceMicros: "1000000", reversalOf: null, reason: "Issue", createdAt: "2030-01-01T00:00:00.000Z" };
    const reversal = { ...original, orderId: "reversal", sharesMicros: "-1000000", valueMicros: "-1000000", reversalOf: "original", reason: "Correction" };
    const projection = projectAdminOrders({ ...base, activeSeason: active, nextDraftSeason: null, latestClosedSeason: null, commissioner: { seasonOrders: [{ seasonId: "season", orders: [original, reversal] }] } });
    expect(projection.canOrder).toBe(true); expect(projection.seasons[0]?.orders).toMatchObject([{ reversalStatus: "Already reversed", reversible: false }, { reversalStatus: "Reversal record", reversible: false, reason: "Correction" }]);
  });
  it("uses punctuation-preserving canonical identity for board clicks and outcome lookup", () => {
    const offer = { market: "spread" as const, homeTeam: "A-B", awayTeam: "AB", outcomes: [{ name: "A-B", price: -105, point: -2 }, { name: "AB", price: -115, point: 2 }] };
    expect(selectionForOutcome(offer, offer.outcomes[0]!)).toBe("home");
    expect(selectionForOutcome(offer, offer.outcomes[1]!)).toBe("away");
    expect(selectionForOutcome(offer, { name: "A B" })).toBeUndefined();
    expect(outcomeForSelection(offer, "home")).toBe(offer.outcomes[0]);
    expect(outcomeForSelection(offer, "away")).toBe(offer.outcomes[1]);
  });
  it("fails closed on ambiguous browser outcome lookup", () => {
    const offer = { market: "spread" as const, homeTeam: "Home Team", awayTeam: "Away Team", outcomes: [{ name: "Home" }, { name: "Home Team" }] };
    expect(outcomeForSelection(offer, "home")).toBeUndefined();
  });
  it("builds and merges only complete, non-conflicting canonical teaser selections", () => {
    const offer = { eventId: "event-1", league: "nfl" as const, canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", startsAt: "2030-09-01T12:00:00.000Z", market: "spread" as const };
    const home = teaserLegForOutcome(offer, { point: -3.5, price: -110 }, "home");
    expect(home.canonicalOfferProof).toMatchObject({ offerId: "event-1:spread:home", offerVersion: "v1", odds: -110, line: -3.5 });
    expect(addTeaserLeg([], home).legs).toEqual([home]);
    expect(addTeaserLeg([home], home).error).toBe("Duplicate selections are not allowed.");
    expect(addTeaserLeg([home], teaserLegForOutcome(offer, { point: 3.5, price: -110 }, "away")).error).toBe("Opposing selections are not allowed.");
  });
  it("caps new teaser slips at six legs without changing legacy server envelopes", () => {
    const leg = (index: number) => ({ eventId: `event-${index}`, league: "nfl" as const, canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", canonicalOfferProof: {}, market: "spread" as const, selection: "home" as const, originalLine: -3.5, originalOdds: -110, eventStartsAt: "2030-09-01T12:00:00.000Z" });
    const six = Array.from({ length: 6 }, (_, index) => leg(index));
    expect(addTeaserLeg(six.slice(0, 5), six[5]!).error).toBe("");
    expect(addTeaserLeg(six, leg(6)).error).toBe("Choose no more than six legs.");
    expect(validateTeaser(six, 6)).toBe("");
    expect(validateTeaser([...six, leg(6)], 6)).toBe("Choose two to six legs.");
  });

  it("re-resolves stale teaser semantics from current offers without accepting a replacement payload", async () => {
    const offer = { eventId: "event-1", league: "nfl" as const, homeTeam: "Home", awayTeam: "Away", startsAt: "2030-09-01T12:00:00.000Z", market: "spread" as const, canonicalBook: "CurrentBook", retrievedAt: "2030-09-01T10:00:00.000Z", offerVersion: "v2", policyVersion: "CANONICAL_BOOKS_2026_V1" as const, outcomes: [{ name: "Home", price: -105, point: -2.5 }] };
    const odds = vi.spyOn(api, "odds").mockResolvedValue({ offers: [offer], feed: { status: "current", message: "Odds are up to date.", lastPolledAt: "2030-09-01T10:00:00.000Z", lastSuccessAt: "2030-09-01T10:00:00.000Z" } });
    const teaser = await recoverTeaserSemantic("pool", { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", points: 6, legs: [{ eventId: "event-1", league: "nfl", canonicalBook: "OldBook", retrievedAt: "old", policyVersion: "old", offerVersion: "v1", canonicalOfferProof: {}, market: "spread", selection: "home", originalLine: -3.5, originalOdds: -110, eventStartsAt: "2030-09-01T12:00:00.000Z" }] });
    expect(teaser).toMatchObject({ tag: "recovered", editor: { wagerId: "wager-1", legs: [{ canonicalBook: "CurrentBook", offerVersion: "v2", originalLine: -2.5, canonicalOfferProof: { offerId: "event-1:spread:home", offerVersion: "v2" } }] } });
    if (teaser.tag === "recovered") {
      expect(teaser.editor.quoteKey).not.toBe("quote-v1");
      const teaserPage = teaserRecoveryTransition(teaser, { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", points: 6, legs: [] });
      expect(teaserPage).toMatchObject({ state: { tag: "editing", editor: { wagerId: "wager-1" } }, slip: teaser.editor.legs });
    }
    expect(odds).toHaveBeenCalledTimes(1);
  });
  it("recovers a punctuation-distinct teaser side without remapping it", async () => {
    const offer = { eventId: "punctuation", league: "nfl" as const, homeTeam: "A-B", awayTeam: "AB", startsAt: "2030-09-01T12:00:00.000Z", market: "spread" as const, canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z", offerVersion: "v2", policyVersion: "CANONICAL_BOOKS_2026_V1" as const, outcomes: [{ name: "A-B", price: -105, point: -2 }, { name: "AB", price: -115, point: 2 }] };
    const odds = vi.spyOn(api, "odds").mockResolvedValue({ offers: [offer], feed: { status: "current", message: "current", lastPolledAt: offer.retrievedAt, lastSuccessAt: offer.retrievedAt } });
    const recovered = await recoverTeaserSemantic("pool", { wagerId: "wager", quoteKey: "old", risk: "1", points: 6, legs: [{ eventId: "punctuation", market: "spread", selection: "away" }] as any });
    expect(recovered).toMatchObject({ tag: "recovered", editor: { legs: [{ selection: "away", originalLine: 2, originalOdds: -115 }] } });
    odds.mockRestore();
  });

  it("asserts every production identity retention and retirement transition", () => {
    const teaser = { wagerId: "teaser-wager", quoteKey: "teaser-quote", risk: "1", points: 6, legs: [] } as any;
    expect(retryTeaserSemantic(teaser)).toBe(teaser);
    const staleTeaser = teaserRecoveryTransition({ tag: "recovered", editor: { ...teaser, quoteKey: "teaser-fresh" } }, teaser);
    expect(staleTeaser.state.editor.wagerId).toBe(teaser.wagerId); expect(staleTeaser.state.editor.quoteKey).not.toBe(teaser.quoteKey);
    const terminalTeaser = teaserTerminalTransition(teaser) as Extract<ReturnType<typeof teaserTerminalTransition>, { tag: "editing" }>;
    expect(terminalTeaser.editor.wagerId).not.toBe(teaser.wagerId); expect(terminalTeaser.editor.quoteKey).not.toBe(teaser.quoteKey);
    const editedTeaser = editTeaserSemantic(teaser);
    expect(editedTeaser.wagerId).not.toBe(teaser.wagerId); expect(editedTeaser.quoteKey).not.toBe(teaser.quoteKey);
    const teaserQuote = { quoteKey: teaser.quoteKey };
    const unresolvedTeaser = teaserUnresolvedPlacementTransition({ tag: "reviewing", request: teaser, quote: teaserQuote, mutationKey: "teaser-place" });
    expect(unresolvedTeaser).toEqual({ tag: "placement-unknown", request: teaser, quote: teaserQuote, mutationKey: "teaser-place" });
    expect(teaserPlacementAttemptTransition(unresolvedTeaser)).toEqual({ state: { ...unresolvedTeaser, tag: "submitting" }, error: "" });
    expect(teaserUnknownPlacementMessage).toBe("Placement result unknown. Retry this exact placement to check its result.");

    const order = { seasonId: "s", memberId: "m", mode: "shares" as const, amount: "1", quoteKey: "order-quote" };
    const recoveredOrder = recoverStaleOrderEditor(order);
    expect(recoveredOrder.quoteKey).not.toBe(order.quoteKey);
    const reversal = { tag: "reviewing" as const, order: { orderId: "o" }, reason: "reason", idempotencyKey: "reversal-key" } as any;
    expect(retryReversalState(reversal)).toBe(reversal);
    expect(retryReversalState(reversal).idempotencyKey).toBe("reversal-key");
  });
  it("builds straight batch requests, groups the compact board, and names per-item failure reasons", () => {
    const offer = { eventId: "event-1", market: "spread" as const, homeTeam: "Home", awayTeam: "Away", canonicalBook: "DraftKings", offerVersion: "v2", startsAt: "2030-09-01T12:00:00.000Z", outcomes: [{ name: "Home", price: -105, point: -2.5 }] };
    const request = straightQuoteRequest({ pick: { offer, outcome: offer.outcomes[0]! }, risk: "3", wagerId: "wager-1", quoteKey: "quote-v1" }, "season-1");
    expect(request).toMatchObject({ wagerId: "wager-1", seasonId: "season-1", riskMicros: "3000000", rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: "event-1", canonicalBook: "DraftKings", market: "spread", selection: "home", offerId: "event-1:spread:home", offerVersion: "v2" }, quoteKey: "quote-v1", commandId: "quote-v1" });

    const later = { ...offer, eventId: "event-2", startsAt: "2030-09-01T13:00:00.000Z", market: "total" as const, outcomes: [{ name: "Over", price: -110, point: 44.5 }] };
    const moneyline = { ...offer, eventId: "event-3", startsAt: "2030-09-01T11:00:00.000Z", market: "moneyline" as const, outcomes: [{ name: "Home", price: -135 }, { name: "Away", price: 115 }] };
    const games = groupBoardByEvent([later, offer, moneyline]);
    expect(games.map((game) => game.eventId)).toEqual(["event-3", "event-1", "event-2"]);
    expect(games[1]).toMatchObject({ awayTeam: "Away", homeTeam: "Home", markets: { spread: { home: { label: "Home -2.5", selection: "home" } }, total: {}, moneyline: {} } });
    expect(games[2]).toMatchObject({ markets: { total: { over: { label: "O 44.5", selection: "over" } } } });
    expect(games[0]).toMatchObject({ markets: { moneyline: { home: { label: "Home -124" }, away: { label: "Away +124" } } } });
    const trayMoneyline = moneyline;
    const trayItem = { eventId: "event-3", market: "moneyline" as const, selection: "home" as const, wagerId: "tray-moneyline", risk: "" };
    expect(trayLabel({ offers: [trayMoneyline] }, trayItem, { offer: trayMoneyline, outcome: trayMoneyline.outcomes[0] })).toBe("Away at Home: moneyline — Home -124");

    const asApi = (code: string, status: number) => new ApiError(code, status);
    expect(failureReason(asApi("LINE_CHANGED", 400), "quote")).toBe("Line changed.");
    expect(failureReason(asApi("LINE_CHANGED", 400), "place")).toBe("Line changed.");
    expect(failureReason(asApi("POOL_UNAVAILABLE", 503), "place")).toBe("Placement result unknown.");
    expect(failureReason(new Error("offline"), "quote")).toBe("Odds unavailable.");
    expect(failureReason(asApi("MARKET_LOCKED", 400), "place")).toBe("Event has started.");
    expect(failureReason(asApi("SIDE_BET_LIMIT", 400), "place", "800000000")).toBe("Max bet: 800 shares.");
  });

  it("invalidates pending placement work when a route changes or unmounts", () => {
    const pages = new PageGeneration();
    const oldPool = pages.start("old-pool");
    expect(pages.capture("old-pool")).toBe(oldPool);
    expect(pages.current(oldPool)).toBe(true);

    const newPool = pages.start("new-pool");
    expect(pages.current(oldPool)).toBe(false);
    pages.invalidate(oldPool);
    expect(pages.current(newPool)).toBe(true);
    pages.invalidate(newPool);
    expect(pages.current(newPool)).toBe(false);
  });

  it("retains known straight-batch outcomes while retrying only unresolved placements", () => {
    const retry = [{ label: "Unknown placement" }] as any;
    const transition = straightPlacementBatchTransition(
      { entries: retry, quoteFailures: [{ label: "Unquoted", reason: "Odds unavailable." }], placed: ["Already placed"], failed: [{ label: "Already rejected", reason: "Event has started." }] } as any,
      { placed: [{ label: "Newly placed" }], failed: [{ label: "Rejected now", reason: "Not enough shares.", entry: {} }], retry } as any
    );
    expect(transition).toEqual({
      tag: "reviewing",
      entries: retry,
      quoteFailures: [{ label: "Unquoted", reason: "Odds unavailable." }],
      placed: ["Already placed", "Newly placed"],
      failed: [{ label: "Already rejected", reason: "Event has started." }, { label: "Rejected now", reason: "Not enough shares." }]
    });

    expect(straightPlacementBatchTransition(transition as any, { placed: [{ label: "Recovered placement" }], failed: [], retry: [] } as any)).toEqual({
      tag: "results",
      placed: ["Already placed", "Newly placed", "Recovered placement"],
      failed: [{ label: "Already rejected", reason: "Event has started." }, { label: "Rejected now", reason: "Not enough shares." }],
      retryPlacements: []
    });
  });

  it("anchors Tuesday weeks to Eastern Time boundaries", () => {
    // Monday 2026-08-31 23:59:59 ET is still Week 1; Tuesday 00:00 ET starts Week 2.
    expect(weekStartOf(new Date("2026-09-01T03:59:59.000Z")).toISOString()).toBe("2026-08-25T04:00:00.000Z");
    expect(weekStartOf(new Date("2026-09-01T04:00:00.000Z")).toISOString()).toBe("2026-09-01T04:00:00.000Z");
    expect(SEASON_WEEK1_ANCHOR).toBe(Date.parse("2026-08-25T04:00:00.000Z"));
  });

  it("keeps Eastern Tuesday week identity and sequencing correct across DST", () => {
    const fall = new Date("2026-10-27T04:00:00.000Z");
    expect(nextWeekStart(fall).toISOString()).toBe("2026-11-03T05:00:00.000Z");
    expect(inWeek("2026-11-10T04:59:59.000Z", "2026-11-03T05:00:00.000Z")).toBe(true);
    expect(inWeek("2026-11-10T05:00:00.000Z", "2026-11-03T05:00:00.000Z")).toBe(false);

    const spring = new Date("2026-03-03T05:00:00.000Z");
    expect(nextWeekStart(spring).toISOString()).toBe("2026-03-10T04:00:00.000Z");
    expect(inWeek("2026-03-17T03:59:59.000Z", "2026-03-10T04:00:00.000Z")).toBe(true);
    expect(inWeek("2026-03-17T04:00:00.000Z", "2026-03-10T04:00:00.000Z")).toBe(false);
  });

  it("uses the Tuesday identity for Sunday and Monday wagers in DST transition weeks", () => {
    const cases = [
      ["2026-11-01T23:59:59.000Z", "2026-10-27T04:00:00.000Z"],
      ["2026-11-03T04:59:59.000Z", "2026-10-27T04:00:00.000Z"],
      ["2026-03-08T23:59:59.000Z", "2026-03-03T05:00:00.000Z"],
      ["2026-03-10T03:59:59.000Z", "2026-03-03T05:00:00.000Z"],
    ] as const;
    for (const [startsAt, expectedWeek] of cases) {
      expect(weekStartOf(new Date(startsAt)).toISOString()).toBe(expectedWeek);
      expect(inWeek(startsAt, expectedWeek)).toBe(true);
    }
  });

  it("separates fetched semantic unavailability from retryable odds retrieval failure", async () => {
    const odds = vi.spyOn(api, "odds").mockResolvedValue({ offers: [], feed: { status: "no-offer", message: "No current odds are available.", lastPolledAt: null, lastSuccessAt: null } });
    await expect(recoverTeaserSemantic("pool", { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", points: 6, legs: [{ eventId: "event-1", market: "spread", selection: "home" }] as any })).resolves.toEqual({ tag: "unavailable" });
    odds.mockRejectedValueOnce(new Error("offline"));
    await expect(recoverTeaserSemantic("pool", { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", points: 6, legs: [] })).rejects.toThrow("offline");
    const teaserRequest = { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", points: 6, legs: [{ eventId: "event-1" }] } as any;
    expect(teaserRecoveryTransition({ tag: "unavailable" }, teaserRequest)).toMatchObject({ state: { tag: "editing", editor: { legs: [] } }, slip: [] });
    expect(teaserTerminalTransition(teaserRequest)).toMatchObject({ tag: "editing", editor: { risk: "1", legs: teaserRequest.legs } });
    odds.mockRestore();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/web/api";
import { HomeLoadGeneration, loadHome } from "../src/web/pages/HomePage";
import { destination } from "../src/web/pages/AuthPages";
import { editStraightSemantic, recoverStraightSemantic, recoverStraightState, retryStraightSemantic, straightRecoveryTransition, straightTerminalTransition } from "../src/web/pages/OddsPage";
import { outcomeForSelection, selectionForOutcome } from "../src/web/selection-matcher";
import { addTeaserLeg, teaserLegForOutcome } from "../src/web/teaser-slip";
import { editTeaserSemantic, recoverTeaserSemantic, retryTeaserSemantic, teaserRecoveryTransition, teaserTerminalTransition } from "../src/web/pages/TeaserPage";
import { recoverStaleOrderEditor, retryReversalState } from "../src/web/pages/AdminOrdersPage";
import { projectAdminOrders } from "../src/web/pages/admin-orders-lifecycle";

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
    const base = { commandVersion: "1", pool: { poolId: "pool", slug: "pool", name: "Pool", commissionerId: "commissioner", signupsOpen: true }, currentMember: { memberId: "commissioner", role: "commissioner" as const, seasonBalances: [] }, members: [{ memberId: "commissioner", displayName: "Commissioner", role: "commissioner" as const, status: "active" as const }], commissioner: { seasonOrders: [] } };
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
  it("re-resolves stale straight and teaser semantics from current offers without accepting a replacement payload", async () => {
    const offer = { eventId: "event-1", league: "nfl" as const, homeTeam: "Home", awayTeam: "Away", startsAt: "2030-09-01T12:00:00.000Z", market: "spread" as const, canonicalBook: "CurrentBook", retrievedAt: "2030-09-01T10:00:00.000Z", offerVersion: "v2", policyVersion: "CANONICAL_BOOKS_2026_V1" as const, outcomes: [{ name: "Home", price: -105, point: -2.5 }] };
    const odds = vi.spyOn(api, "odds").mockResolvedValue({ offers: [offer], feed: { status: "current", message: "Canonical offers are current.", lastPolledAt: "2030-09-01T10:00:00.000Z", lastSuccessAt: "2030-09-01T10:00:00.000Z" } });
    const straight = await recoverStraightSemantic("pool", { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", pick: { offer: { ...offer, canonicalBook: "OldBook", offerVersion: "v1" }, outcome: { name: "Home", price: -110, point: -3.5 } } });
    expect(straight).toMatchObject({ wagerId: "wager-1", risk: "1", pick: { offer: { canonicalBook: "CurrentBook", offerVersion: "v2" } } });
    expect(straight.quoteKey).not.toBe("quote-v1");
    const recoveredState = await recoverStraightState("pool", { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", pick: { offer: { ...offer, canonicalBook: "OldBook", offerVersion: "v1" }, outcome: { name: "Home", price: -110, point: -3.5 } } });
    expect(recoveredState.board.offers[0]).toBe(offer);
    const straightPage = straightRecoveryTransition(recoveredState);
    expect(straightPage.state).toMatchObject({ tag: "editing", editor: { wagerId: "wager-1", pick: { offer: { offerVersion: "v2" } } } });
    expect(straightPage.error).toContain("explicitly confirm again");
    const teaser = await recoverTeaserSemantic("pool", { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", points: 6, legs: [{ eventId: "event-1", league: "nfl", canonicalBook: "OldBook", retrievedAt: "old", policyVersion: "old", offerVersion: "v1", canonicalOfferProof: {}, market: "spread", selection: "home", originalLine: -3.5, originalOdds: -110, eventStartsAt: "2030-09-01T12:00:00.000Z" }] });
    expect(teaser).toMatchObject({ tag: "recovered", editor: { wagerId: "wager-1", legs: [{ canonicalBook: "CurrentBook", offerVersion: "v2", originalLine: -2.5, canonicalOfferProof: { offerId: "event-1:spread:home", offerVersion: "v2" } }] } });
    if (teaser.tag === "recovered") {
      expect(teaser.editor.quoteKey).not.toBe("quote-v1");
      const teaserPage = teaserRecoveryTransition(teaser, { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", points: 6, legs: [] });
      expect(teaserPage).toMatchObject({ state: { tag: "editing", editor: { wagerId: "wager-1" } }, slip: teaser.editor.legs });
    }
    expect(odds).toHaveBeenCalledTimes(3);
  });
  it("recovers a punctuation-distinct teaser side without remapping it", async () => {
    const offer = { eventId: "punctuation", league: "nfl" as const, homeTeam: "A-B", awayTeam: "AB", startsAt: "2030-09-01T12:00:00.000Z", market: "spread" as const, canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z", offerVersion: "v2", policyVersion: "CANONICAL_BOOKS_2026_V1" as const, outcomes: [{ name: "A-B", price: -105, point: -2 }, { name: "AB", price: -115, point: 2 }] };
    const odds = vi.spyOn(api, "odds").mockResolvedValue({ offers: [offer], feed: { status: "current", message: "current", lastPolledAt: offer.retrievedAt, lastSuccessAt: offer.retrievedAt } });
    const recovered = await recoverTeaserSemantic("pool", { wagerId: "wager", quoteKey: "old", risk: "1", points: 6, legs: [{ eventId: "punctuation", market: "spread", selection: "away" }] as any });
    expect(recovered).toMatchObject({ tag: "recovered", editor: { legs: [{ selection: "away", originalLine: 2, originalOdds: -115 }] } });
    odds.mockRestore();
  });

  it("asserts every production identity retention and retirement transition", () => {
    const straight = { wagerId: "straight-wager", quoteKey: "straight-quote", risk: "1", pick: { offer: { eventId: "e", market: "spread" }, outcome: { name: "Home" } } } as any;
    expect(retryStraightSemantic(straight)).toBe(straight);
    const staleStraight = straightRecoveryTransition({ tag: "recovered", board: { offers: [] }, editor: { ...straight, quoteKey: "straight-fresh" } });
    expect(staleStraight.state).toMatchObject({ editor: { wagerId: "straight-wager", quoteKey: "straight-fresh" } });
    expect((staleStraight.state as any).editor.quoteKey).not.toBe(straight.quoteKey);
    const terminalStraight = straightTerminalTransition(straight) as Extract<ReturnType<typeof straightTerminalTransition>, { tag: "editing" }>;
    expect(terminalStraight.editor.wagerId).not.toBe(straight.wagerId); expect(terminalStraight.editor.quoteKey).not.toBe(straight.quoteKey);
    const editedStraight = editStraightSemantic(straight);
    expect(editedStraight.wagerId).not.toBe(straight.wagerId); expect(editedStraight.quoteKey).not.toBe(straight.quoteKey);

    const teaser = { wagerId: "teaser-wager", quoteKey: "teaser-quote", risk: "1", points: 6, legs: [] } as any;
    expect(retryTeaserSemantic(teaser)).toBe(teaser);
    const staleTeaser = teaserRecoveryTransition({ tag: "recovered", editor: { ...teaser, quoteKey: "teaser-fresh" } }, teaser);
    expect(staleTeaser.state.editor.wagerId).toBe(teaser.wagerId); expect(staleTeaser.state.editor.quoteKey).not.toBe(teaser.quoteKey);
    const terminalTeaser = teaserTerminalTransition(teaser) as Extract<ReturnType<typeof teaserTerminalTransition>, { tag: "editing" }>;
    expect(terminalTeaser.editor.wagerId).not.toBe(teaser.wagerId); expect(terminalTeaser.editor.quoteKey).not.toBe(teaser.quoteKey);
    const editedTeaser = editTeaserSemantic(teaser);
    expect(editedTeaser.wagerId).not.toBe(teaser.wagerId); expect(editedTeaser.quoteKey).not.toBe(teaser.quoteKey);

    const order = { seasonId: "s", memberId: "m", mode: "shares" as const, amount: "1", quoteKey: "order-quote" };
    const recoveredOrder = recoverStaleOrderEditor(order);
    expect(recoveredOrder.quoteKey).not.toBe(order.quoteKey);
    const reversal = { tag: "reviewing" as const, order: { orderId: "o" }, reason: "reason", idempotencyKey: "reversal-key" } as any;
    expect(retryReversalState(reversal)).toBe(reversal);
    expect(retryReversalState(reversal).idempotencyKey).toBe("reversal-key");
  });
  it("separates fetched semantic unavailability from retryable odds retrieval failure", async () => {
    const request = { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", pick: { offer: { eventId: "event-1", market: "spread", homeTeam: "Home", awayTeam: "Away" }, outcome: { name: "Home" } } };
    const odds = vi.spyOn(api, "odds").mockResolvedValue({ offers: [], feed: { status: "no-offer", message: "No current canonical offers are available.", lastPolledAt: null, lastSuccessAt: null } });
    const unavailableStraight = await recoverStraightState("pool", request);
    expect(unavailableStraight).toMatchObject({ tag: "unavailable", board: { offers: [] } });
    // The production-used reducer unmounts frozen confirmation before a fresh editor can appear.
    expect(straightRecoveryTransition(unavailableStraight)).toMatchObject({ state: undefined, error: expect.stringContaining("no longer available") });
    await expect(recoverTeaserSemantic("pool", { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", points: 6, legs: [{ eventId: "event-1", market: "spread", selection: "home" }] as any })).resolves.toEqual({ tag: "unavailable" });
    odds.mockRejectedValueOnce(new Error("offline"));
    await expect(recoverStraightState("pool", request)).rejects.toThrow("offline");
    const frozenStraight = { ...request, quote: { quoteKey: "snapshot" }, mutationKey: "m" } as any;
    expect(straightTerminalTransition(frozenStraight)).toMatchObject({ tag: "editing", editor: { risk: "1" } });
    odds.mockRejectedValueOnce(new Error("offline"));
    await expect(recoverTeaserSemantic("pool", { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", points: 6, legs: [] })).rejects.toThrow("offline");
    const teaserRequest = { wagerId: "wager-1", quoteKey: "quote-v1", risk: "1", points: 6, legs: [{ eventId: "event-1" }] } as any;
    expect(teaserRecoveryTransition({ tag: "unavailable" }, teaserRequest)).toMatchObject({ state: { tag: "editing", editor: { legs: [] } }, slip: [] });
    expect(teaserTerminalTransition(teaserRequest)).toMatchObject({ tag: "editing", editor: { risk: "1", legs: teaserRequest.legs } });
    odds.mockRestore();
  });
});

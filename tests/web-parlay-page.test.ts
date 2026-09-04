import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { api } from "../src/web/api";
import { addParlayLeg, buildParlaySlip, parlayLegForOutcome, readParlaySlip, writeParlaySlip } from "../src/web/parlay-slip";
import { editParlaySemantic, ParlayLegTable, ParlayPageGeneration, parlayAdvisoryOdds, parlayPlacementAttemptTransition, parlayQuoteAttemptTransition, parlayQuoteRequest, parlayRecoveryTransition, parlayTerminalTransition, parlayUnknownPlacementMessage, parlayUnresolvedPlacementTransition, recoverParlaySemantic } from "../src/web/pages/ParlayPage";
import { buildCurrentParlayTransfer, ParlayTrayTransferGate, parlayTrayChangedMessage, runParlayTrayTransfer } from "../src/web/pages/OddsPage";
import type { TrayItem } from "../src/web/selection-tray";

const offer = (eventId: string, market: "spread" | "total" | "moneyline", outcome: { name: string; price: number; point?: number }) => ({
  eventId, league: "nfl" as const, canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: `v-${eventId}-${market}`, startsAt: "2030-09-01T12:00:00.000Z", homeTeam: "Home", awayTeam: "Away", market, outcomes: [outcome]
});
const item = (eventId: string, market: TrayItem["market"], selection: TrayItem["selection"]): TrayItem => ({ eventId, market, selection, wagerId: `${eventId}-${market}`, risk: "" });
const board = (offers: any[]) => ({ offers });

describe("parlay slip and page semantics", () => {
  it("transfers a complete valid tray all at once, permits a paired total, and never partially transfers an invalid directional pair", () => {
    const spread = offer("game-1", "spread", { name: "Home", price: -110, point: -3.5 });
    const total = offer("game-1", "total", { name: "Over", price: -110, point: 44.5 });
    const moneyline = { ...offer("game-1", "moneyline", { name: "Away", price: 125 }), outcomes: [{ name: "Away", price: 125 }, { name: "Home", price: -145 }] };
    const paired = buildParlaySlip([item("game-1", "spread", "home"), item("game-1", "total", "over")], board([spread, total]));
    expect(paired).toMatchObject({ error: "", legs: [{ market: "spread", selection: "home" }, { market: "total", selection: "over" }] });

    const invalid = buildParlaySlip([item("game-1", "spread", "home"), item("game-1", "total", "over"), item("game-1", "moneyline", "away")], board([spread, total, moneyline]));
    expect(invalid).toEqual({ legs: [], error: "Only one directional market is allowed per event." });

    const unavailable = buildParlaySlip([item("game-1", "spread", "home"), item("game-2", "total", "over")], board([spread]));
    expect(unavailable).toEqual({ legs: [], error: "A selected parlay leg is no longer available on the board." });
  });

  it("resolves an NFL-plus-NCAA tray against a fresh unfiltered board after filter transitions", async () => {
    const nfl = offer("nfl-game", "spread", { name: "Home", price: -110, point: -3.5 });
    const ncaaf = { ...offer("ncaaf-game", "total", { name: "Over", price: -110, point: 55.5 }), league: "ncaaf" as const };
    const load = vi.fn(async () => ({ offers: [nfl, ncaaf], feed: { status: "current", message: "Current", lastPolledAt: nfl.retrievedAt, lastSuccessAt: nfl.retrievedAt } } as any));
    const tray = [item("nfl-game", "spread", "home"), item("ncaaf-game", "total", "over")];
    const transferred = await buildCurrentParlayTransfer("pool", tray, load);
    expect(load).toHaveBeenCalledWith("pool");
    expect(transferred).toMatchObject({ error: "", legs: [{ eventId: "nfl-game", league: "nfl" }, { eventId: "ncaaf-game", league: "ncaaf" }] });

    const unavailable = await buildCurrentParlayTransfer("pool", tray, async () => ({ offers: [ncaaf] } as any));
    expect(unavailable).toEqual({ legs: [], error: "A selected parlay leg is no longer available on the board." });
  });

  it("fences a deferred transfer when the tray changes before the unfiltered board arrives", async () => {
    const nfl = offer("nfl-game", "spread", { name: "Home", price: -110, point: -3.5 });
    const ncaaf = { ...offer("ncaaf-game", "total", { name: "Over", price: -110, point: 55.5 }), league: "ncaaf" as const };
    const original = [item("nfl-game", "spread", "home"), item("ncaaf-game", "total", "over")];
    let current = original;
    let resolve!: (board: any) => void;
    const load = vi.fn(() => new Promise<any>((done) => { resolve = done; }));
    const gate = new ParlayTrayTransferGate();
    const transfer = runParlayTrayTransfer({ gate, slug: "pool", items: original, load, currentItems: () => current, currentSlug: () => "pool" });
    expect(gate.pending).toBe(true);
    expect(gate.begin("pool", original)).toBeUndefined();
    current = [...original, item("later-game", "spread", "home")];
    resolve({ offers: [nfl, ncaaf] });
    await expect(transfer).resolves.toEqual({ tag: "tray-changed" });
    expect(gate.pending).toBe(false);
    expect(parlayTrayChangedMessage).toBe("Your parlay selections changed while current odds loaded. Review and retry Build parlay.");
  });

  it("cancels an unmounted deferred transfer before any parlay commit side effect", async () => {
    const nfl = offer("nfl-game", "spread", { name: "Home", price: -110, point: -3.5 });
    const ncaaf = { ...offer("ncaaf-game", "total", { name: "Over", price: -110, point: 55.5 }), league: "ncaaf" as const };
    const original = [item("nfl-game", "spread", "home"), item("ncaaf-game", "total", "over")];
    let mounted = true;
    let resolve!: (board: any) => void;
    const load = vi.fn(() => new Promise<any>((done) => { resolve = done; }));
    const commit = { writeSlip: vi.fn(), clearTray: vi.fn(), setError: vi.fn(), navigate: vi.fn() };
    const gate = new ParlayTrayTransferGate();
    const transfer = runParlayTrayTransfer({ gate, slug: "pool", items: original, load, currentItems: () => original, currentSlug: () => "pool", isCurrent: () => mounted, onReady: () => { commit.writeSlip(); commit.clearTray(); commit.setError(); commit.navigate(); } });
    mounted = false;
    gate.cancel();
    resolve({ offers: [nfl, ncaaf] });
    await expect(transfer).resolves.toEqual({ tag: "cancelled" });
    expect(commit.writeSlip).not.toHaveBeenCalled();
    expect(commit.clearTray).not.toHaveBeenCalled();
    expect(commit.setError).not.toHaveBeenCalled();
    expect(commit.navigate).not.toHaveBeenCalled();
  });

  it("does not let a cancelled transfer clear a newer pending transfer", async () => {
    const nfl = offer("nfl-game", "spread", { name: "Home", price: -110, point: -3.5 });
    const ncaaf = { ...offer("ncaaf-game", "total", { name: "Over", price: -110, point: 55.5 }), league: "ncaaf" as const };
    const original = [item("nfl-game", "spread", "home"), item("ncaaf-game", "total", "over")];
    let oldMounted = true;
    let resolveOld!: (board: any) => void;
    let resolveNew!: (board: any) => void;
    const pending: boolean[] = [];
    const gate = new ParlayTrayTransferGate();
    const oldTransfer = runParlayTrayTransfer({ gate, slug: "pool", items: original, load: () => new Promise<any>((done) => { resolveOld = done; }), currentItems: () => original, currentSlug: () => "pool", isCurrent: () => oldMounted, onPending: (value) => pending.push(value) });
    oldMounted = false;
    gate.cancel();
    const newTransfer = runParlayTrayTransfer({ gate, slug: "pool", items: original, load: () => new Promise<any>((done) => { resolveNew = done; }), currentItems: () => original, currentSlug: () => "pool", onPending: (value) => pending.push(value) });
    resolveOld({ offers: [nfl, ncaaf] });
    await expect(oldTransfer).resolves.toEqual({ tag: "cancelled" });
    expect(pending).toEqual([true, true]);
    resolveNew({ offers: [nfl, ncaaf] });
    await expect(newTransfer).resolves.toMatchObject({ tag: "ready" });
    expect(pending).toEqual([true, true, false]);
  });

  it("constructs complete immutable client leg semantics from the current board", () => {
    const source = offer("game-1", "spread", { name: "Home", price: -110, point: -3.5 });
    const leg = parlayLegForOutcome(source, source.outcomes[0]!, "home");
    expect(leg).toMatchObject({ eventId: "game-1", originalLine: -3.5, originalOdds: -110, adjustedLine: null, canonicalOfferProof: { offerId: "game-1:spread:home", odds: -110, line: -3.5 } });
    const total = parlayLegForOutcome(offer("game-1", "total", { name: "Over", price: -110, point: 44.5 }), { price: -110, point: 44.5 }, "over");
    expect(addParlayLeg([leg], total)).toMatchObject({ error: "", legs: [leg, total] });
    expect(addParlayLeg([leg], { ...leg, market: "moneyline", originalLine: null, adjustedLine: null, selection: "away" })).toMatchObject({ error: "Only one directional market is allowed per event." });
  });

  it("keeps its session slip separate from the odds-board tray and restores only canonical, compatible legs", () => {
    let stored: Record<string, string> = {};
    vi.stubGlobal("sessionStorage", { getItem: (name: string) => stored[name] ?? null, setItem: (name: string, value: string) => { stored[name] = value; } });
    const legs = Array.from({ length: 7 }, (_, index) => parlayLegForOutcome(offer(`game-${index + 1}`, "spread", { name: "Home", price: -110, point: -3.5 }), { price: -110, point: -3.5 }, "home"));
    const [leg] = legs;
    writeParlaySlip("pool", [leg!]);
    expect(readParlaySlip("pool")).toEqual([leg]);
    expect(stored["share-pool:tray:pool"]).toBeUndefined();

    for (const malformed of [
      { eventId: "", canonicalOfferProof: { ...leg!.canonicalOfferProof, eventId: "" } },
      { retrievedAt: "not-a-date" },
      { eventStartsAt: "not-a-date" },
      { canonicalOfferProof: { ...leg!.canonicalOfferProof, offerId: "" } },
      { canonicalOfferProof: { ...leg!.canonicalOfferProof, line: 0 } }
    ]) {
      stored["share-pool:parlay:pool"] = JSON.stringify([{ ...leg, ...malformed }]);
      expect(readParlaySlip("pool")).toEqual([]);
    }

    for (let count = 1; count <= 6; count++) {
      stored["share-pool:parlay:pool"] = JSON.stringify(legs.slice(0, count));
      expect(readParlaySlip("pool")).toEqual(legs.slice(0, count));
    }
    const opposite = { ...leg!, selection: "away" as const, canonicalOfferProof: { ...leg!.canonicalOfferProof, offerId: "game-1:spread:away", selection: "away" as const } };
    const moneyline = { ...leg!, market: "moneyline" as const, selection: "away" as const, originalLine: null, canonicalOfferProof: { ...leg!.canonicalOfferProof, offerId: "game-1:moneyline:away", market: "moneyline" as const, selection: "away" as const, line: null } };
    for (const incompatible of [[leg!, leg!], [leg!, opposite], [leg!, moneyline], legs]) {
      stored["share-pool:parlay:pool"] = JSON.stringify(incompatible);
      expect(readParlaySlip("pool")).toEqual([]);
    }
    vi.unstubAllGlobals();
  });

  it("rebuilds stale parlay selections only from the fresh board and retires just the parlay slip", async () => {
    const current = offer("game-1", "spread", { name: "Home", price: -105, point: -2.5 });
    const odds = vi.spyOn(api, "odds").mockResolvedValue({ offers: [current], feed: { status: "current", message: "Current", lastPolledAt: current.retrievedAt, lastSuccessAt: current.retrievedAt } } as any);
    const request = { wagerId: "wager-1", quoteKey: "quote-old", risk: "3", legs: [{ eventId: "game-1", league: "nfl", canonicalBook: "OldBook", retrievedAt: "old", policyVersion: "old", offerVersion: "old", canonicalOfferProof: {}, market: "spread", selection: "home", originalLine: -3.5, originalOdds: -110, adjustedLine: null, eventStartsAt: current.startsAt, homeTeam: "Home", awayTeam: "Away" }] } as any;
    const recovered = await recoverParlaySemantic("pool", request);
    expect(recovered).toMatchObject({ tag: "recovered", editor: { wagerId: "wager-1", risk: "3", legs: [{ canonicalBook: "DraftKings", offerVersion: "v-game-1-spread", originalLine: -2.5, originalOdds: -105 }] } });
    if (recovered.tag === "recovered") {
      expect(recovered.editor.quoteKey).not.toBe("quote-old");
      expect(parlayRecoveryTransition(recovered, request)).toMatchObject({ state: { tag: "editing", editor: { wagerId: "wager-1" } }, slip: recovered.editor.legs });
    }
    odds.mockRestore();
  });

  it("uses a vig-free moneyline strike for advisory pricing while retaining the raw book proof", () => {
    const moneyline = { ...offer("game-1", "moneyline", { name: "Home", price: -135 }), outcomes: [{ name: "Home", price: -135 }, { name: "Away", price: 115 }] };
    const totalOffer = offer("game-1", "total", { name: "Over", price: -110, point: 44.5 });
    const moneylineLeg = parlayLegForOutcome(moneyline, moneyline.outcomes[0]!, "home");
    const totalLeg = parlayLegForOutcome(totalOffer, totalOffer.outcomes[0]!, "over");
    expect(moneylineLeg).toMatchObject({ originalOdds: -124, canonicalOfferProof: { odds: -135 } });
    expect(parlayAdvisoryOdds([moneylineLeg, totalLeg])).toBe(216);
  });

  it("keeps an unknown placement frozen and clears stale errors before its exact retry", () => {
    const request = { wagerId: "wager-1", quoteKey: "quote-1", risk: "2", legs: [] } as any;
    const quote = { quoteKey: "quote-1" };
    expect(parlayQuoteAttemptTransition(request)).toEqual({ state: { tag: "quoting", request }, error: "" });
    const reviewing = { tag: "reviewing" as const, request, quote, mutationKey: "place-1" };
    const unresolved = parlayUnresolvedPlacementTransition(reviewing);
    expect(unresolved).toEqual({ tag: "placement-unknown", request, quote, mutationKey: "place-1" });
    expect(unresolved.request).toBe(request);
    expect(unresolved.quote).toBe(quote);
    expect(parlayPlacementAttemptTransition(unresolved)).toEqual({ state: { ...unresolved, tag: "submitting" }, error: "" });
    expect(parlayUnknownPlacementMessage).toBe("Placement result unknown. Retry this exact placement to check its result.");
  });

  it("renders selected-leg rows without per-leg price claims", () => {
    const leg = parlayLegForOutcome(offer("game-1", "spread", { name: "Home", price: -110, point: -3.5 }), { price: -110, point: -3.5 }, "home");
    const markup = renderToStaticMarkup(createElement(ParlayLegTable, { legs: [leg], onRemove: () => undefined }));
    expect(markup).toContain("<caption>Selected parlay legs</caption>");
    expect(markup).toContain("<th>Matchup</th><th>Market</th><th>Action</th>");
    expect(markup).toContain("<span>Away at </span><strong>Home (-3.5)</strong>");
    expect(markup).not.toContain("Advisory leg price");
    expect(markup).not.toContain("-110");
  });

  it("rejects stale parlay async completions after a slug transition", () => {
    const page = new ParlayPageGeneration();
    const first = page.start("pool-a");
    const second = page.start("pool-b");
    expect(page.current(first)).toBe(false);
    expect(page.current(second)).toBe(true);
    page.invalidate(second);
    expect(page.current(second)).toBe(false);
  });

  it("keeps editor odds advisory while quote semantics remain authoritative and frozen", () => {
    const spread = parlayLegForOutcome(offer("game-1", "spread", { name: "Home", price: -110, point: -3.5 }), { price: -110, point: -3.5 }, "home");
    const total = parlayLegForOutcome(offer("game-1", "total", { name: "Over", price: -110, point: 44.5 }), { price: -110, point: 44.5 }, "over");
    const semantic = { wagerId: "wager-1", quoteKey: "quote-1", risk: "2", legs: [spread, total] };
    expect(parlayAdvisoryOdds(semantic.legs)).toBe(250);
    expect(parlayQuoteRequest(semantic, "season-1")).toMatchObject({ wagerId: "wager-1", quoteKey: "quote-1", commandId: "quote-1", seasonId: "season-1", riskMicros: "2000000", rulesetVersion: "PARLAY_2026_V1", legs: [{ offerId: "game-1:spread:home" }, { offerId: "game-1:total:over" }] });
    expect(editParlaySemantic(semantic).quoteKey).not.toBe(semantic.quoteKey);
    const terminal = parlayTerminalTransition(semantic);
    expect(terminal.editor.wagerId).not.toBe(semantic.wagerId);
    expect(terminal.editor.quoteKey).not.toBe(semantic.quoteKey);
  });
});

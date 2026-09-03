import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parlayRiskError, readSelectionTray, resolveTrayItem, straightBatchRiskError, teaserEligible, teaserRiskError, toggleMarketExclusive, toggleTrayItem, writeSelectionTray, type TrayItem } from "../src/web/selection-tray";
import { buildTeaserTransfer } from "../src/web/pages/OddsPage";

vi.stubGlobal("sessionStorage", (() => { let store: Record<string, string> = {}; return { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = String(v); }, removeItem: (k: string) => { delete store[k]; }, clear: () => { store = {}; } }; })());

const slug = "test-pool";
const base = { eventId: "e1", market: "spread", selection: "home" } as const;
const item = (over: Partial<TrayItem> = {}): TrayItem => ({ ...base, wagerId: "w1", risk: "", ...over });
const board = (offers: any[]) => ({ offers });

describe("selection tray", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  it("toggles items by identity and ignores risk/wagerId when matching", () => {
    const first = toggleTrayItem([], item());
    expect(first).toHaveLength(1);
    expect(toggleTrayItem(first, item({ risk: "5" }))).toEqual([]);
    expect(toggleTrayItem(first, item({ market: "total", selection: "over" }))).toHaveLength(2);
  });

  it("replaces the sibling selection from the same game and market column", () => {
    const home = toggleMarketExclusive([], item());
    const away = toggleMarketExclusive(home, item({ selection: "away" }));
    expect(away).toHaveLength(1);
    expect(away[0]!.selection).toBe("away");
    const over = toggleMarketExclusive(away, item({ market: "total", selection: "over" }));
    expect(over).toHaveLength(2);
    expect(toggleMarketExclusive(over, item({ market: "total", selection: "over" }))).toHaveLength(1);
  });

  it("persists and reads the tray per slug", () => {
    writeSelectionTray(slug, [item()]);
    writeSelectionTray("other-pool", [item({ eventId: "e2" })]);
    expect(readSelectionTray(slug)).toEqual([item()]);
    expect(readSelectionTray("other-pool")).toEqual([item({ eventId: "e2" })]);
    expect(readSelectionTray("never-written")).toEqual([]);
  });

  it("drops malformed persisted entries", () => {
    sessionStorage.setItem("share-pool:tray:test-pool", JSON.stringify([{ garbage: true }, item()]));
    expect(readSelectionTray(slug)).toEqual([item()]);
  });

  it("resolves items against the current board only", () => {
    const offer = { eventId: "e1", market: "spread", homeTeam: "KC", awayTeam: "DET", outcomes: [{ name: "KC", price: -110, point: -3.5 }] };
    expect(resolveTrayItem(board([offer]), item({ selection: "home" }))).toMatchObject({ offer, outcome: offer.outcomes[0] });
    expect(resolveTrayItem(board([offer]), item({ selection: "away" }))).toBeUndefined();
    expect(resolveTrayItem(board([]), item())).toBeUndefined();
  });

  it("marks only spreads and totals teaser-eligible", () => {
    expect(teaserEligible(item())).toBe(true);
    expect(teaserEligible(item({ market: "total", selection: "over" }))).toBe(true);
    expect(teaserEligible(item({ market: "moneyline" }))).toBe(false);
  });

  it("validates whole-share risks per item for the straight batch", () => {
    expect(straightBatchRiskError([item({ risk: "3" }), item({ risk: "10" })])).toBe("");
    expect(straightBatchRiskError([item({ risk: "0" })])).not.toBe("");
    expect(straightBatchRiskError([item({ risk: "2.5" })])).not.toBe("");
    expect(straightBatchRiskError([item({ risk: "" })])).not.toBe("");
  });

  it("reports configured per-side and available-balance risks before quoting", () => {
    expect(straightBatchRiskError([item({ risk: "801" })], { maxSideBetMicros: "800000000", availableMicros: "1000000000" })).toBe("Max bet per side: 800 shares.");
    expect(straightBatchRiskError([item({ risk: "500" }), item({ eventId: "e2", risk: "400" })], { maxSideBetMicros: "800000000", availableMicros: "800000000" })).toBe("Selected bets total 900 shares; only 800 shares are available.");
    expect(straightBatchRiskError([item({ risk: "800" })], { maxSideBetMicros: "800000000", availableMicros: "800000000" })).toBe("");
  });

  it("caps total teaser risk while checking the available balance before review", () => {
    expect(teaserRiskError("801", { maxSideBetMicros: "800000000", availableMicros: "3000000000" })).toBe("Max bet per side: 800 shares.");
    expect(teaserRiskError("800", { maxSideBetMicros: "800000000", availableMicros: "799000000" })).toBe("Teaser risk 800 shares; only 799 shares are available.");
    expect(teaserRiskError("800", { maxSideBetMicros: "800000000", availableMicros: "800000000" })).toBe("");
  });

  it("caps one whole-share parlay risk against the same limits", () => {
    expect(parlayRiskError("801", { maxSideBetMicros: "800000000", availableMicros: "3000000000" })).toBe("Max bet per side: 800 shares.");
    expect(parlayRiskError("800", { maxSideBetMicros: "800000000", availableMicros: "799000000" })).toBe("Parlay risk 800 shares; only 799 shares are available.");
    expect(parlayRiskError("800", { maxSideBetMicros: "800000000", availableMicros: "800000000" })).toBe("");
  });

  it("persists the seventh teaser selection retained across builder navigation", () => {
    const items = Array.from({ length: 7 }, (_, index) => item({ eventId: `e${index}`, wagerId: `w${index}` }));
    const offers = items.map((candidate) => ({ eventId: candidate.eventId, market: "spread" as const, homeTeam: "Home", awayTeam: "Away", canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: `v-${candidate.eventId}`, startsAt: "2030-09-01T12:00:00.000Z", outcomes: [{ name: "Home", price: -110, point: -3.5 }] }));
    const transfer = buildTeaserTransfer(items, board(offers));
    expect(transfer.slip).toHaveLength(6);
    expect(transfer.remaining).toEqual([items[6]]);
    writeSelectionTray(slug, transfer.remaining);
    expect(readSelectionTray(slug)).toEqual([items[6]]);
  });
});

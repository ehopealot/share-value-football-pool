import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatAmericanOdds, formatKickoff } from "../src/web/odds-format";
import { batchAfterPopState, filterGamesByTeam, oddsBoardTablePropsAreEqual, selectionTrayDisplayLabel, straightReviewDetails, type GameRow } from "../src/web/pages/OddsPage";

const oddsPageSource = readFileSync(resolve(import.meta.dirname, "../src/web/pages/OddsPage.tsx"), "utf8");

describe("member-facing odds display", () => {
  it("always prefixes a positive American price with +", () => {
    expect(formatAmericanOdds(100)).toBe("+100");
    expect(formatAmericanOdds(225)).toBe("+225");
    expect(formatAmericanOdds(-110)).toBe("-110");
  });

  it("uses one compact local kickoff formatter for the odds board and wager tables", () => {
    const date = new Date("2026-09-06T20:00:00.000Z");
    const hour = date.getHours() % 12 || 12;
    expect(formatKickoff("2026-09-06T20:00:00.000Z")).toBe(`${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}${date.getHours() >= 12 ? "p" : "a"}`);
    expect(oddsPageSource).toContain("formatKickoff(game.startsAt)");
  });

  it("provides complete straight-bet confirmation details including the amount to win", () => {
    expect(straightReviewDetails({
      item: { risk: "10" },
      quote: {
        riskMicros: "10000000",
        acceptedOdds: 125,
        leg: { awayTeam: "Away", homeTeam: "Home", market: "moneyline", selection: "away", originalLine: null, originalOdds: 125 }
      }
    } as any)).toEqual({ matchup: "Away at Home", pick: "Moneyline — Away", odds: "+125", risk: "10 shares", toWin: "12.50 shares" });
  });

  it("keeps total points unsigned in straight-bet confirmation details", () => {
    expect(straightReviewDetails({ item: { risk: "10" }, quote: { riskMicros: "10000000", acceptedOdds: -110, leg: { awayTeam: "Away", homeTeam: "Home", market: "total", selection: "over", originalLine: 45.5, originalOdds: -110 } } } as any).pick).toBe("Total — Over 45.5");
  });

  it("omits explicit market names from resolved bet-slip labels", () => {
    const offer = { awayTeam: "Away", homeTeam: "Home" };
    expect(selectionTrayDisplayLabel({ market: "spread", selection: "away" } as any, { offer: { ...offer, market: "spread" }, outcome: { name: "Away", point: 3, price: -110 } })).toBe("Away at Home: Away +3");
    expect(selectionTrayDisplayLabel({ market: "total", selection: "over" } as any, { offer: { ...offer, market: "total" }, outcome: { name: "Over", point: 44.5, price: -110 } })).toBe("Away at Home: Over 44.5");
    expect(selectionTrayDisplayLabel({ market: "moneyline", selection: "home" } as any, { offer: { ...offer, market: "moneyline" }, outcome: { name: "Home", price: 125 } })).toBe("Away at Home: Home +125");
  });

  it("returns both review and placement results to the odds board on browser back", () => {
    const reviewing = { tag: "reviewing", entries: [], quoteFailures: [] } as any;
    const results = { tag: "results", placed: [], failed: [], retryPlacements: [] } as any;
    const quoting = { tag: "quoting" } as any;
    const placing = { tag: "placing", entries: [], quoteFailures: [] } as any;

    expect(batchAfterPopState(reviewing)).toBeUndefined();
    expect(batchAfterPopState(results)).toBeUndefined();
    expect(batchAfterPopState(quoting)).toEqual(quoting);
    expect(batchAfterPopState(placing)).toEqual(placing);
  });

  it("keeps the odds table memoized while only a bet amount changes", () => {
    const games: any[] = [];
    const onToggle = () => undefined;
    const previous = { games, currentWeek: "2026-09-01T04:00:00.000Z", selectedPickIds: ["event:spread:away"], onToggle };
    expect(oddsBoardTablePropsAreEqual(previous, { ...previous, selectedPickIds: ["event:spread:away"] })).toBe(true);
    expect(oddsBoardTablePropsAreEqual(previous, { ...previous, selectedPickIds: ["event:spread:home"] })).toBe(false);
  });

  it("keeps the mobile bet slip summary compact and omits empty-tray instructions", () => {
    expect(oddsPageSource).toContain('Shares: <strong>{formatMicros(total, 2)}</strong> · Available: <strong>{formatMicros(available, 2)}</strong> · Share price: <strong>{shareValue}</strong>');
    expect(oddsPageSource).not.toContain('Check options on the board to build straight wagers, a teaser, or a parlay.');
  });

  it("keeps every feed status beside the pool and season context", () => {
    expect(oddsPageSource).toContain('<h1>Odds board</h1>');
    expect(oddsPageSource).toContain('<p className="pool-context">{view &&');
    expect(oddsPageSource).toContain('Feed status: {board?.feed.status ?? "loading"}');
    expect(oddsPageSource).toContain('className="odds-board-filters"');
    expect(oddsPageSource).toContain('board?.feed.status === "stale"');
    expect(oddsPageSource).toContain('<a href={window.location.href}>Reload odds</a>');
  });

  it("filters either team fuzzily while retaining input order", () => {
    const markets = { spread: {}, total: {}, moneyline: {} };
    const games: GameRow[] = [
      { eventId: "jets-broncos", startsAt: "2026-09-10T17:00:00.000Z", awayTeam: "New York Jets", homeTeam: "Denver Broncos", markets },
      { eventId: "chiefs-raiders", startsAt: "2026-09-10T20:00:00.000Z", awayTeam: "Kansas City Chiefs", homeTeam: "Las Vegas Raiders", markets },
      { eventId: "jets-dolphins", startsAt: "2026-09-11T17:00:00.000Z", awayTeam: "New Jersey Jets", homeTeam: "Miami Dolphins", markets }
    ];

    expect(filterGamesByTeam(games, "BRONCOS")).toEqual([games[0]]);
    expect(filterGamesByTeam(games, "cheifs")).toEqual([games[1]]);
    expect(filterGamesByTeam(games, "jets")).toEqual([games[0], games[2]]);
    expect(filterGamesByTeam(games, "")).toBe(games);
  });
});

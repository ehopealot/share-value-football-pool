import { describe, expect, it } from "vitest";
import { formatAmericanOdds } from "../src/web/odds-format";
import { oddsBoardTablePropsAreEqual, selectionTrayDisplayLabel, straightReviewDetails } from "../src/web/pages/OddsPage";

describe("member-facing odds display", () => {
  it("always prefixes a positive American price with +", () => {
    expect(formatAmericanOdds(100)).toBe("+100");
    expect(formatAmericanOdds(225)).toBe("+225");
    expect(formatAmericanOdds(-110)).toBe("-110");
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

  it("keeps the odds table memoized while only a bet amount changes", () => {
    const games: any[] = [];
    const onToggle = () => undefined;
    const previous = { games, currentWeek: "2026-09-01T04:00:00.000Z", selectedPickIds: ["event:spread:away"], onToggle };
    expect(oddsBoardTablePropsAreEqual(previous, { ...previous, selectedPickIds: ["event:spread:away"] })).toBe(true);
    expect(oddsBoardTablePropsAreEqual(previous, { ...previous, selectedPickIds: ["event:spread:home"] })).toBe(false);
  });
});

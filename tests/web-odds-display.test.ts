import { describe, expect, it } from "vitest";
import { formatAmericanOdds } from "../src/web/odds-format";
import { straightReviewDetails } from "../src/web/pages/OddsPage";

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
});

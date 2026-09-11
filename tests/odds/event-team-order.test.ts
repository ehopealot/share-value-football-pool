import { describe, expect, it } from "vitest";
import { orientProviderEvent } from "../../src/odds/event-team-order";
import type { ProviderEvent } from "../../src/odds/types";

const incoming: ProviderEvent = {
  id: "neutral", sport: "ncaaf", commenceTime: "2030-09-19T23:30:00.000Z", homeTeam: "Virginia", awayTeam: "West Virginia", homeScore: 17,
  bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [
    { key: "spread", outcomes: [{ name: "home", price: -110, point: 3 }, { name: "away", price: -110, point: -3 }] },
    { key: "moneyline", outcomes: [{ name: "Virginia", price: 120 }, { name: "West Virginia", price: -140 }] },
    { key: "total", outcomes: [{ name: "Over", price: -110, point: 45 }, { name: "Under", price: -110, point: 45 }] }
  ] }]
};

describe("neutral-site team orientation", () => {
  it("attaches side aliases and partial scores to teams while leaving prices and totals unchanged", () => {
    const oriented = orientProviderEvent({ homeTeam: "West Virginia", awayTeam: "Virginia" }, incoming)!;
    expect(oriented).toMatchObject({ homeTeam: "West Virginia", awayTeam: "Virginia", homeScore: undefined, awayScore: 17 });
    expect(oriented.bookmakers[0]!.markets[0]!.outcomes).toEqual([{ name: "Virginia", price: -110, point: 3 }, { name: "West Virginia", price: -110, point: -3 }]);
    expect(oriented.bookmakers[0]!.markets.slice(1)).toEqual(incoming.bookmakers[0]!.markets.slice(1));
    expect(incoming.bookmakers[0]!.markets[0]!.outcomes[0]!.name).toBe("home");
  });

  it("does not reinterpret a different or ambiguous matchup as a side swap", () => {
    expect(orientProviderEvent({ homeTeam: "Other", awayTeam: "Virginia" }, incoming)).toBeUndefined();
    expect(orientProviderEvent({ homeTeam: "Virginia", awayTeam: "Virginia" }, incoming)).toBeUndefined();
  });
});

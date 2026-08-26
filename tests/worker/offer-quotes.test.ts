import { describe, expect, it } from "vitest";
import { decodeStoredOffer } from "../../src/worker/offer-quotes";

const context = { market: "spread" as const, canonicalBook: "DraftKings", homeTeam: "Home Team", awayTeam: "Away Team" };
const offer = (outcomes: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes, ...extra });
const spread = [{ name: "Home Team", price: -110, point: -3 }, { name: "away", price: -110, point: 3 }];

describe("stored canonical offer trust boundary", () => {
  it("accepts exactly one market-appropriate counterpart per side", () => {
    expect(decodeStoredOffer(offer(spread), context).outcomes).toEqual(spread);
    expect(decodeStoredOffer(offer([{ name: "Over", price: -110, point: 47.5 }, { name: "Under", price: -110, point: 47.5 }]), { ...context, market: "total" }).outcomes).toHaveLength(2);
    expect(decodeStoredOffer(offer([{ name: "home", price: -135 }, { name: "Away Team", price: 115 }]), { ...context, market: "moneyline" }).outcomes).toHaveLength(2);
  });

  it.each([
    ["wrong policy", JSON.stringify({ policyVersion: "other", outcomes: spread }), context],
    ["unconfigured canonical book", offer(spread), { ...context, canonicalBook: "UntrustedBook" }],
    ["missing counterpart", offer(spread.slice(0, 1)), context],
    ["duplicate side alias", offer([spread[0], { name: "home", price: -105, point: -3 }, spread[1]]), context],
    ["ambiguous team aliases", offer([{ name: "home", price: -110, point: -3 }, { name: "away", price: -110, point: 3 }]), { ...context, homeTeam: "away" }],
    ["unrecognized outcome", offer([spread[0], { name: "Visitor", price: -110, point: 3 }]), context],
    ["missing point", offer([{ name: "Home Team", price: -110 }, spread[1]]), context],
    ["opposite spread mismatch", offer([{ ...spread[0], point: -3 }, { ...spread[1], point: 4 }]), context],
    ["total mismatch", offer([{ name: "Over", price: -110, point: 47.5 }, { name: "Under", price: -110, point: 48.5 }]), { ...context, market: "total" }],
    ["nonfinite point", `{"policyVersion":"CANONICAL_BOOKS_2026_V1","outcomes":[{"name":"Home Team","price":-110,"point":1e999},{"name":"Away Team","price":-110,"point":3}]}`, context],
    ["moneyline point", offer([{ name: "home", price: -135, point: 0 }, { name: "away", price: 115 }]), { ...context, market: "moneyline" }],
    ["zero price", offer([{ ...spread[0], price: 0 }, spread[1]]), context],
    ["fractional price", offer([{ ...spread[0], price: -110.5 }, spread[1]]), context],
    ["nonfinite price", `{"policyVersion":"CANONICAL_BOOKS_2026_V1","outcomes":[{"name":"Home Team","price":1e999,"point":-3},{"name":"Away Team","price":-110,"point":3}]}`, context],
    ["extra payload field", offer(spread, { provider: "asserted" }), context],
    ["extra outcome field", offer([{ ...spread[0], description: "asserted" }, spread[1]]), context]
  ])("rejects %s", (_name, payload, decodeContext) => {
    expect(() => decodeStoredOffer(payload as string, decodeContext as typeof context)).toThrow("MARKET_UNAVAILABLE");
  });
});

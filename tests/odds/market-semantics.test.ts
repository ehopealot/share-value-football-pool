import { describe, expect, it } from "vitest";
import { MarketSemanticError, resolveCanonicalOutcomeSide, validateCanonicalMarket } from "../../src/odds/market-semantics";

const context = { market: "spread" as const, canonicalBook: "DraftKings", policyVersion: "CANONICAL_BOOKS_2026_V1", homeTeam: "Home", awayTeam: "Away" };
const outcome = (name: string, point: number, price = -110) => ({ name, point, price });

describe("canonical market semantics", () => {
  it.each([
    ["opposite spread mismatch", "spread", [outcome("Home", -3), outcome("Away", 4)]],
    ["total mismatch", "total", [outcome("Over", 47.5), outcome("Under", 48.5)]],
    ["duplicate outcome", "spread", [outcome("Home", -3), outcome("home", -3)]],
    ["extra outcome", "spread", [outcome("Home", -3), outcome("Away", 3), outcome("Draw", 0)]],
    ["moneyline point", "moneyline", [outcome("Home", 0, -130), { name: "Away", price: 110 }]]
  ])("rejects %s", (_name, market, outcomes) => {
    expect(() => validateCanonicalMarket({ ...context, market: market as "spread" | "total" | "moneyline", outcomes })).toThrow(MarketSemanticError);
  });

  it("accepts exact counterparts and normalizes signed zero", () => {
    expect(validateCanonicalMarket({ ...context, outcomes: [outcome("Home", -0), outcome("Away", +0)] }).outcomes.map((item) => item.point)).toEqual([0, 0]);
    expect(validateCanonicalMarket({ ...context, outcomes: [outcome("Home", +0), outcome("Away", +0)] }).outcomes.map((item) => item.point)).toEqual([0, 0]);
    expect(validateCanonicalMarket({ ...context, market: "total", outcomes: [outcome("Over", 47.5), outcome("Under", 47.5)] }).outcomes).toHaveLength(2);
    expect(validateCanonicalMarket({ ...context, market: "moneyline", outcomes: [{ name: "Home", price: -130 }, { name: "Away", price: 110 }] }).outcomes).toHaveLength(2);
  });

  it("preserves punctuation when resolving distinct team identities", () => {
    const identity = { market: "spread" as const, homeTeam: "A-B", awayTeam: "AB" };
    expect(resolveCanonicalOutcomeSide(identity, "A-B")).toBe("home");
    expect(resolveCanonicalOutcomeSide(identity, "AB")).toBe("away");
    expect(resolveCanonicalOutcomeSide(identity, "A B")).toBeUndefined();
    expect(validateCanonicalMarket({ ...context, ...identity, outcomes: [outcome("A-B", -3), outcome("AB", 3)] }).outcomes).toHaveLength(2);
  });

  it("fails closed when normalized home and away identities are ambiguous", () => {
    expect(resolveCanonicalOutcomeSide({ market: "spread", homeTeam: "Team", awayTeam: " team " }, "Team")).toBeUndefined();
    expect(() => validateCanonicalMarket({ ...context, homeTeam: "Team", awayTeam: " team ", outcomes: [outcome("Home", -3), outcome("Away", 3)] })).toThrow("ambiguous");
  });
});

import { describe, expect, it } from "vitest";
import { ticketReturns } from "../src/web/wager-presentation";

describe("owner ticket presentation", () => {
  it("uses the shared half-even American-odds calculation for possible returns", () => {
    expect(ticketReturns("1000000", 150)).toEqual({ profit: "1.50", total: "2.50" });
    expect(ticketReturns("1000000", -200)).toEqual({ profit: "0.50", total: "1.50" });
  });

  it("preserves canonical micros above Number.MAX_SAFE_INTEGER in the owner display", () => {
    expect(ticketReturns("9007199254740993", 100)).toEqual({ profit: "9007199254.74", total: "18014398509.48" });
  });
});

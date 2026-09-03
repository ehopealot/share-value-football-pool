import { describe, expect, it } from "vitest";
import {
  PARLAY_ODDS_OUT_OF_RANGE,
  PARLAY_RULESET_ID,
  gradeParlay,
  parlayOdds,
  validateParlay,
  type ParlayLeg
} from "../../src/domain/parlay";
import type { LegGrade, Market, Selection } from "../../src/domain/types";

const leg = (eventId: string, market: Market, selection: Selection, originalOdds = -110): ParlayLeg => ({ eventId, market, selection, originalOdds });

const grades = (...values: LegGrade[]) => values;

describe("PARLAY_2026_V1 pricing and validation", () => {
  it("identifies the immutable ruleset and prices paired totals at -133", () => {
    expect(PARLAY_RULESET_ID).toBe("PARLAY_2026_V1");
    expect(parlayOdds([
      leg("one", "spread", "home", -110),
      leg("one", "total", "over", -110)
    ])).toBe(250);
  });

  it("uses +100 for unpaired spreads/totals and accepted moneyline prices", () => {
    expect(parlayOdds([
      leg("one", "moneyline", "home", -150),
      leg("two", "total", "over", -110)
    ])).toBe(233);
  });

  it("prices a same-event moneyline and total with the paired-total adjustment", () => {
    expect(parlayOdds([
      leg("one", "moneyline", "home", -150),
      leg("one", "total", "over", -110)
    ])).toBe(191);
  });

  it("enforces two through six selections", () => {
    expect(() => validateParlay([leg("one", "spread", "home")])).toThrow(/2.*6/i);
    expect(() => validateParlay(Array.from({ length: 7 }, (_, index) => leg(`game-${index}`, "spread", "home")))).toThrow(/2.*6/i);
    expect(() => validateParlay(Array.from({ length: 6 }, (_, index) => leg(`game-${index}`, "spread", "home")))).not.toThrow();
  });

  it("rejects duplicates, opposing selections, and two directional markets in one event", () => {
    expect(() => validateParlay([
      leg("one", "spread", "home"),
      leg("one", "spread", "home")
    ])).toThrow(/duplicate/i);
    expect(() => validateParlay([
      leg("one", "total", "over"),
      leg("one", "total", "under")
    ])).toThrow(/opposing/i);
    expect(() => validateParlay([
      leg("one", "spread", "home"),
      leg("one", "moneyline", "home")
    ])).toThrow(/directional/i);
  });

  it("uses the specified exact positive and negative American conversion boundaries", () => {
    expect(parlayOdds([
      leg("one", "moneyline", "home", -200),
      leg("two", "moneyline", "away", -300)
    ])).toBe(100);
    expect(parlayOdds([
      leg("one", "moneyline", "home", -1000),
      leg("two", "moneyline", "away", -1000)
    ])).toBe(-477);
  });

  it("treats +100 and -100 as the same even-money multiplier", () => {
    expect(gradeParlay(grades("win", "void"), [
      leg("one", "moneyline", "home", 100),
      leg("two", "total", "over")
    ])).toEqual({ outcome: "win", odds: 100, winningLegs: 1 });
    expect(gradeParlay(grades("win", "void"), [
      leg("one", "moneyline", "home", -100),
      leg("two", "total", "over")
    ])).toEqual({ outcome: "win", odds: 100, winningLegs: 1 });
  });

  it("rejects zero, fractional, unsafe input, and unsafe output odds with the canonical error", () => {
    for (const odds of [0, 100.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parlayOdds([
        leg("one", "moneyline", "home", odds),
        leg("two", "moneyline", "away", -110)
      ])).toThrow(PARLAY_ODDS_OUT_OF_RANGE);
    }
    expect(() => parlayOdds([
      leg("one", "moneyline", "home", Number.MAX_SAFE_INTEGER),
      leg("two", "moneyline", "away", Number.MAX_SAFE_INTEGER)
    ])).toThrow(PARLAY_ODDS_OUT_OF_RANGE);
  });

  it("uses loss precedence and refuses unresolved grading", () => {
    const legs = [leg("one", "spread", "home"), leg("two", "total", "over")];
    expect(gradeParlay(grades("loss", "pending"), legs)).toEqual({ outcome: "loss", winningLegs: 0 });
    expect(() => gradeParlay(grades("win", "pending"), legs)).toThrow(/pending/i);
  });

  it("reprices surviving legs, breaks same-game pairs, and refunds no survivors", () => {
    const paired = [
      leg("one", "spread", "home"),
      leg("one", "total", "over")
    ];
    expect(gradeParlay(grades("win", "win"), paired)).toEqual({ outcome: "win", odds: 250, winningLegs: 2 });
    expect(gradeParlay(grades("push", "win"), paired)).toEqual({ outcome: "win", odds: 100, winningLegs: 1 });
    expect(gradeParlay(grades("win", "void"), paired)).toEqual({ outcome: "win", odds: 100, winningLegs: 1 });
    expect(gradeParlay(grades("push", "void"), paired)).toEqual({ outcome: "refund", winningLegs: 0 });
  });

  it("reverts a paired total to +100 when its moneyline pushes or voids", () => {
    const paired = [
      leg("one", "moneyline", "home", -150),
      leg("one", "total", "over")
    ];
    expect(gradeParlay(grades("push", "win"), paired)).toEqual({ outcome: "win", odds: 100, winningLegs: 1 });
    expect(gradeParlay(grades("void", "win"), paired)).toEqual({ outcome: "win", odds: 100, winningLegs: 1 });
  });
});

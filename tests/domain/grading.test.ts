import { describe, expect, it } from "vitest";
import { adjustTeaserLine, gradeLeg, gradeTeaser, teaserSelectionConflict, validateTeaser } from "../../src/domain/grading";
import { isSupportedTeaserRuleset, LEGACY_TEASER_PAYOUT_MATRIX, LEGACY_TEASER_RULESET_ID, SHARE_POOL_RULESET_ID, TEASER_LEG_COUNTS, TEASER_PAYOUT_MATRIX, TEASER_POINT_OPTIONS, TEASER_RULESET_ID, teaserOdds, teaserOddsForRuleset } from "../../src/domain/teaser-table";
import type { TeaserLeg } from "../../src/domain/types";

const side = (selection: "home" | "away", line: number): Extract<TeaserLeg, { market: "spread" }> => ({ eventId: "game-1", market: "spread", selection, line });

describe("straight and teaser grading", () => {
  it("grades spread, total, moneyline, cancellation, and postponement rules", () => {
    expect(gradeLeg({ market: "spread", selection: "home", line: -3 }, { home: 24, away: 21 })).toBe("push");
    expect(gradeLeg({ market: "total", selection: "over", line: 44 }, { home: 24, away: 21 })).toBe("win");
    expect(gradeLeg({ market: "moneyline", selection: "home" }, { home: 21, away: 21 })).toBe("void");
    expect(gradeLeg({ market: "spread", selection: "away", line: 3 }, { home: 0, away: 0, status: "cancelled" })).toBe("void");
    expect(gradeLeg({ market: "spread", selection: "away", line: 3 }, { home: 0, away: 0, status: "postponed", sameEventId: true, hoursDelayed: 24 })).toBe("pending");
    expect(gradeLeg({ market: "spread", selection: "away", line: 3 }, { home: 0, away: 0, status: "postponed", sameEventId: true, hoursDelayed: 49 })).toBe("void");
    expect(gradeLeg({ market: "spread", selection: "away", line: 3 }, { home: 0, away: 0, status: "postponed", sameEventId: false, hoursDelayed: 1 })).toBe("void");
  });

  it("moves every permitted teaser selection toward the member", () => {
    expect(adjustTeaserLine({ market: "spread", selection: "home", line: -7 }, 6)).toBe(-1);
    expect(adjustTeaserLine({ market: "spread", selection: "away", line: 7 }, 6)).toBe(13);
    expect(adjustTeaserLine({ market: "total", selection: "over", line: 47 }, 6)).toBe(41);
    expect(adjustTeaserLine({ market: "total", selection: "under", line: 47 }, 6)).toBe(53);
  });

  it("pins the complete immutable teaser payout matrix and versioned ruleset identity", () => {
    const points = [6, 6.5, 7, 7.5, 10] as const;
    expect(TEASER_LEG_COUNTS).toEqual([2, 3, 4, 5, 6]);
    expect(TEASER_POINT_OPTIONS).toEqual([6, 6.5, 7, 7.5, 10]);
    expect(TEASER_LEG_COUNTS.map((legs) => points.map((adjustment) => teaserOdds(legs, adjustment)))).toEqual([
      [-110, -120, -130, -150, undefined],
      [165, 150, 135, 105, -110],
      [265, 235, 215, 140, undefined],
      [405, 350, 320, 235, undefined],
      [595, 550, 500, 325, undefined]
    ]);
    // Seven legs exist only on the retired card and can no longer be placed.
    expect(teaserOdds(7, 6)).toBeUndefined();
    expect(SHARE_POOL_RULESET_ID).toBe("SHARE_POOL_2026_V1");
    expect(TEASER_RULESET_ID).toBe("TEASER_2026_V2");
    expect(teaserOddsForRuleset).toBeTypeOf("function");
  });

  it("keeps the retired card immutable and reprices each ticket from its accepted ruleset", () => {
    expect([2, 3, 4, 5, 6, 7].map((legs) => [6, 6.5, 7, 7.5, 10].map((points) => teaserOddsForRuleset(LEGACY_TEASER_RULESET_ID, legs, points as 6)))).toEqual([
      [-120, -130, -140, -160, undefined],
      [150, 135, 120, 105, -120],
      [235, 215, 200, 140, undefined],
      [350, 320, 300, 235, undefined],
      [550, 500, 475, 325, undefined],
      [800, 700, 600, 445, undefined]
    ]);
    // Push repricing selects the table the ticket accepted, never the live card.
    expect(teaserOddsForRuleset(LEGACY_TEASER_RULESET_ID, 2, 6)).toBe(-120);
    expect(teaserOddsForRuleset(TEASER_RULESET_ID, 2, 6)).toBe(-110);
    expect(teaserOddsForRuleset("TEASER_FUTURE_V9", 2, 6)).toBeUndefined();
    expect(isSupportedTeaserRuleset(TEASER_RULESET_ID)).toBe(true);
    expect(isSupportedTeaserRuleset(LEGACY_TEASER_RULESET_ID)).toBe(true);
    expect(isSupportedTeaserRuleset("TEASER_FUTURE_V9")).toBe(false);
    expect(Object.isFrozen(LEGACY_TEASER_PAYOUT_MATRIX)).toBe(true);
    for (const row of Object.values(LEGACY_TEASER_PAYOUT_MATRIX)) expect(Object.isFrozen(row)).toBe(true);
    expect(() => ((LEGACY_TEASER_PAYOUT_MATRIX as Record<number, Record<number, number>>)[3][10] = 999)).toThrow(TypeError);
  });

  it("keeps exported teaser policy immutable at runtime", () => {
    expect(Object.isFrozen(TEASER_POINT_OPTIONS)).toBe(true);
    expect(Object.isFrozen(TEASER_LEG_COUNTS)).toBe(true);
    expect(Object.isFrozen(TEASER_PAYOUT_MATRIX)).toBe(true);
    for (const row of Object.values(TEASER_PAYOUT_MATRIX)) {
      expect(Object.isFrozen(row)).toBe(true);
    }

    expect(() => ((TEASER_POINT_OPTIONS as unknown as number[])[0] = 10)).toThrow(TypeError);
    expect(() => ((TEASER_LEG_COUNTS as unknown as number[])[0] = 7)).toThrow(TypeError);
    expect(() => ((TEASER_PAYOUT_MATRIX as Record<number, Record<number, number>>)[3][10] = 999)).toThrow(TypeError);

    expect(TEASER_POINT_OPTIONS).toEqual([6, 6.5, 7, 7.5, 10]);
    expect(TEASER_LEG_COUNTS).toEqual([2, 3, 4, 5, 6]);
    expect(teaserOdds(3, 10)).toBe(-110);
  });

  it("enforces fixed table and leg exclusion rules", () => {
    expect(teaserOdds(3, 10)).toBe(-110);
    expect(teaserOdds(2, 10)).toBeUndefined();
    expect(teaserSelectionConflict([side("home", -3)], side("home", -3))).toBe("duplicate");
    expect(teaserSelectionConflict([side("home", -3)], side("away", 3))).toBe("opposing");
    expect(() => validateTeaser([side("home", -3), side("away", 3)], 6)).toThrow(/opposing/i);
    expect(() => validateTeaser([{ eventId: "g", market: "moneyline", selection: "home" }, side("away", 3)], 6)).toThrow(/moneyline/i);
  });

  it("rejects invalid market-selection pairs before grading or validating", () => {
    const invalid = [
      { market: "spread", selection: "over", line: 3 },
      { market: "spread", selection: "under", line: 3 },
      { market: "total", selection: "home", line: 44 },
      { market: "total", selection: "away", line: 44 },
      { market: "moneyline", selection: "over" },
      { market: "moneyline", selection: "under" }
    ] as unknown as TeaserLeg[];
    for (const leg of invalid) {
      expect(() => gradeLeg(leg, { home: 21, away: 14 })).toThrow(/selection/i);
      expect(() => validateTeaser([{ ...leg, eventId: "game-1" }, side("away", 3)], 6)).toThrow(/selection/i);
    }
  });

  it("uses loss precedence, reprices valid winners, and refunds insufficient remainders", () => {
    expect(gradeTeaser(["win", "push", "win"], 6, TEASER_RULESET_ID)).toEqual({ outcome: "win", odds: -110, winningLegs: 2 });
    expect(gradeTeaser(["win", "push", "win"], 6, LEGACY_TEASER_RULESET_ID)).toEqual({ outcome: "win", odds: -120, winningLegs: 2 });
    expect(gradeTeaser(["win", "push", "win"], 10, TEASER_RULESET_ID)).toEqual({ outcome: "refund", winningLegs: 2 });
    expect(gradeTeaser(["win", "loss", "void"], 10, TEASER_RULESET_ID)).toEqual({ outcome: "loss", winningLegs: 1 });
    expect(gradeTeaser(["loss", "pending"], 6, TEASER_RULESET_ID)).toEqual({ outcome: "loss", winningLegs: 0 });
    expect(() => gradeTeaser(["win", "pending"], 6, TEASER_RULESET_ID)).toThrow(/pending/i);
    expect(gradeTeaser(["void", "push"], 6, TEASER_RULESET_ID)).toEqual({ outcome: "refund", winningLegs: 0 });
    // An unrecognized stored ruleset fails closed to a refund instead of inventing a price,
    // even when a losing grade would otherwise settle first.
    expect(gradeTeaser(["win", "win"], 6, "TEASER_FUTURE_V9")).toEqual({ outcome: "refund", winningLegs: 2 });
    expect(gradeTeaser(["loss", "win"], 6, "TEASER_FUTURE_V9")).toEqual({ outcome: "refund", winningLegs: 1 });
    expect(gradeTeaser(["loss", "pending"], 6, "TEASER_FUTURE_V9")).toEqual({ outcome: "refund", winningLegs: 0 });
  });
});

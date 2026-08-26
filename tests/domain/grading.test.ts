import { describe, expect, it } from "vitest";
import { adjustTeaserLine, gradeLeg, gradeTeaser, validateTeaser } from "../../src/domain/grading";
import { teaserOdds } from "../../src/domain/teaser-table";
import type { TeaserLeg } from "../../src/domain/types";

const side = (selection: "home" | "away", line: number): TeaserLeg => ({ eventId: "game-1", market: "spread", selection, line });

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

  it("enforces fixed table and leg exclusion rules", () => {
    expect(teaserOdds(3, 10)).toBe(-120);
    expect(teaserOdds(2, 10)).toBeUndefined();
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
    expect(gradeTeaser(["win", "push", "win"], 6)).toEqual({ outcome: "win", odds: -120, winningLegs: 2 });
    expect(gradeTeaser(["win", "push", "win"], 10)).toEqual({ outcome: "refund", winningLegs: 2 });
    expect(gradeTeaser(["win", "loss", "void"], 10)).toEqual({ outcome: "loss", winningLegs: 1 });
    expect(gradeTeaser(["loss", "pending"], 6)).toEqual({ outcome: "loss", winningLegs: 0 });
    expect(gradeTeaser(["void", "push"], 6)).toEqual({ outcome: "refund", winningLegs: 0 });
  });
});

import { describe, expect, it } from "vitest";
import { activityLegTimingClass, activitySelectedOutcomeClass, activityWagerPerformanceClass, formatActivityLeg, formatActivityPerformance, formatActivityStake, formatActivityWagerPerformance, groupActivityMembersForWeek, formatWeeklyPerformance } from "../src/web/activity-presentation";
type Wager = Parameters<typeof groupActivityMembersForWeek>[0][number];
const leg = (overrides: Record<string, unknown> = {}) => ({ eventId: "game", league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-09-01T00:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", market: "spread", selection: "away", originalLine: "-7.5", originalOdds: -110, eventStartsAt: "2026-09-06T20:00:00.000Z", awayTeam: "UCLA", homeTeam: "Arizona", ...overrides });
const wager = (overrides: Record<string, unknown> = {}) => ({ wagerId: "wager", seasonId: "s", memberId: "ucla", memberDisplayName: "Bruin", type: "straight", status: "won", confirmedAt: "2026-09-01T00:00:00.000Z", weekStart: "2026-09-01T04:00:00.000Z", performanceMicros: "500000000", profitMicros: "500000000", legs: [leg()], ...overrides }) as Wager;

describe("activity presentation", () => {
  it("groups the selected kickoff week by member and counts open tickets as zero performance", () => {
    const groups = groupActivityMembersForWeek([
      wager({ wagerId: "late", legs: [leg({ eventStartsAt: "2026-09-08T20:00:00.000Z" })] }),
      wager({ wagerId: "open", type: "teaser", status: "open", performanceMicros: "0", profitMicros: undefined, legs: [leg({ eventStartsAt: "2026-09-08T20:00:00.000Z" }), leg({ eventId: "earliest-parlay-leg", eventStartsAt: "2026-09-06T18:00:00.000Z" })] }),
      wager({ wagerId: "loss", status: "lost", performanceMicros: "-300000000", profitMicros: "0", legs: [leg({ eventStartsAt: "2026-09-07T20:00:00.000Z" })] }),
      wager({ wagerId: "other-week", weekStart: "2026-09-08T04:00:00.000Z", performanceMicros: "300000000", profitMicros: "300000000" }),
      wager({ wagerId: "other-member", memberId: "alpha", memberDisplayName: "Alpha", performanceMicros: "-300000000" })
    ], "2026-09-01T04:00:00.000Z");

    expect(groups).toEqual([
      expect.objectContaining({ memberId: "alpha", memberDisplayName: "Alpha", performanceMicros: "-300000000" }),
      expect.objectContaining({ memberId: "ucla", memberDisplayName: "Bruin", performanceMicros: "200000000", wagers: [expect.objectContaining({ wagerId: "open" }), expect.objectContaining({ wagerId: "loss" }), expect.objectContaining({ wagerId: "late" })] })
    ]);
    expect(formatWeeklyPerformance("500000000")).toBe("+500.00 shares");
    expect(formatWeeklyPerformance("-300000000")).toBe("-300.00 shares");
    expect(formatWeeklyPerformance("0")).toBe("0.00 shares");
  });

  it("omits the unit suffix from row P&L while keeping the weekly zero summary blank", () => {
    expect(formatActivityPerformance("0")).toBe("");
    expect(formatActivityPerformance("500000000")).toBe("+500.00 shares");
    expect(formatActivityWagerPerformance(wager({ status: "refunded", outcome: undefined, riskMicros: "1000000", performanceMicros: "0" }))).toBe("0.00");
    expect(formatActivityWagerPerformance(wager({ status: "open", outcome: undefined, riskMicros: "1000000", performanceMicros: "0" }))).toBe("");
    expect(formatActivityWagerPerformance(wager({ riskMicros: undefined, performanceMicros: "500000000" }))).toBe("+500.00");
    expect(activityWagerPerformanceClass(wager({ status: "won", outcome: undefined }))).toBe("activity-performance-won");
    expect(activityWagerPerformanceClass(wager({ status: "lost", outcome: undefined }))).toBe("activity-performance-lost");
    expect(activityWagerPerformanceClass(wager({ status: "refunded", outcome: undefined }))).toBe("activity-performance-refunded");
  });

  it("formats the stake as whole shares and accepted odds", () => {
    expect(formatActivityStake(wager({ riskMicros: "100000000", acceptedOdds: 150 }))).toEqual({ amount: "100", odds: "+150" });
    expect(formatActivityStake(wager({ riskMicros: "25000000", acceptedOdds: -110 }))).toEqual({ amount: "25", odds: "-110" });
    expect(formatActivityStake(wager({ riskMicros: "25000000", acceptedOdds: undefined }))).toEqual({ amount: "25" });
    expect(formatActivityStake(wager({ riskMicros: undefined, acceptedOdds: undefined }))).toBeUndefined();
  });

  it("dims wager lines before kickoff and leaves started lines black", () => {
    expect(activityLegTimingClass(leg({ eventStartsAt: "2026-09-06T20:00:00.000Z" }), Date.parse("2026-09-06T19:59:59.000Z"))).toBe("activity-wager-not-started");
    expect(activityLegTimingClass(leg({ eventStartsAt: "2026-09-06T20:00:00.000Z" }), Date.parse("2026-09-06T20:00:00.000Z"))).toBe("");
  });

  it("maps only wins and losses to selected-pick outcome classes", () => {
    expect(activitySelectedOutcomeClass(wager({ status: "won", outcome: undefined }))).toBe("activity-picked-won");
    expect(activitySelectedOutcomeClass(wager({ status: "lost", outcome: undefined }))).toBe("activity-picked-lost");
    expect(activitySelectedOutcomeClass(wager({ status: "refunded", outcome: undefined }))).toBe("");
    expect(activitySelectedOutcomeClass(wager({ status: "open", outcome: undefined }))).toBe("");
  });

  it("bolds only the selected side or total in readable activity matchup lines", () => {
    expect(formatActivityLeg(leg())).toEqual({ hidden: false, segments: [{ text: "UCLA (-7.5)", selected: true }, { text: " at Arizona", selected: false }] });
    expect(formatActivityLeg(leg({ selection: "home", originalLine: "7.5" }))).toEqual({ hidden: false, segments: [{ text: "UCLA at ", selected: false }, { text: "Arizona (+7.5)", selected: true }] });
    expect(formatActivityLeg(leg({ market: "total", selection: "over", originalLine: "44.5" }))).toEqual({ hidden: false, segments: [{ text: "UCLA at Arizona ", selected: false }, { text: "O44.5", selected: true }] });
  });

  it("uses concise NCAA names in wager legs", () => {
    expect(formatActivityLeg(leg({ league: "ncaaf", awayTeam: "Texas Longhorns", homeTeam: "Oklahoma Sooners" }))).toEqual({ hidden: false, segments: [{ text: "Texas (-7.5)", selected: true }, { text: " at Oklahoma", selected: false }] });
  });

  it("formats teaser legs independently and leaves redacted tickets explicitly hidden", () => {
    const teaser = wager({ type: "teaser", legs: [leg({ adjustedLine: "-1.5" }), leg({ eventId: "game-two", market: "total", selection: "over", originalLine: "44.5", adjustedLine: "38.5" })] });
    expect(teaser.legs!.map(formatActivityLeg)).toEqual([
      { hidden: false, segments: [{ text: "UCLA (-1.5)", selected: true }, { text: " at Arizona", selected: false }] },
      { hidden: false, segments: [{ text: "UCLA at Arizona ", selected: false }, { text: "O38.5", selected: true }] }
    ]);
    expect(groupActivityMembersForWeek([wager({ legs: undefined })], "2026-09-01T04:00:00.000Z")[0]!.wagers[0]!.legs).toBeUndefined();
  });
});

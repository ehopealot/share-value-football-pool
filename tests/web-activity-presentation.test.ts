import { describe, expect, it } from "vitest";
import { formatActivityLeg, groupActivityMembersForWeek, formatWeeklyPerformance } from "../src/web/activity-presentation";

type Wager = Parameters<typeof groupActivityMembersForWeek>[0][number];
const leg = (overrides: Record<string, unknown> = {}) => ({ eventId: "game", league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-09-01T00:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", market: "spread", selection: "away", originalLine: "-7.5", originalOdds: -110, eventStartsAt: "2026-09-06T20:00:00.000Z", awayTeam: "UCLA", homeTeam: "Arizona", ...overrides });
const wager = (overrides: Record<string, unknown> = {}) => ({ wagerId: "wager", seasonId: "s", memberId: "ucla", memberDisplayName: "Bruin", type: "straight", status: "won", confirmedAt: "2026-09-01T00:00:00.000Z", weekStart: "2026-09-01T04:00:00.000Z", performanceMicros: "500000000", profitMicros: "500000000", legs: [leg()], ...overrides }) as Wager;

describe("activity presentation", () => {
  it("groups the selected kickoff week by member and counts open tickets as zero performance", () => {
    const groups = groupActivityMembersForWeek([
      wager(),
      wager({ wagerId: "open", status: "open", performanceMicros: "0", profitMicros: undefined }),
      wager({ wagerId: "loss", status: "lost", performanceMicros: "-300000000", profitMicros: "0" }),
      wager({ wagerId: "other-week", weekStart: "2026-09-08T04:00:00.000Z", performanceMicros: "300000000", profitMicros: "300000000" }),
      wager({ wagerId: "other-member", memberId: "arizona", memberDisplayName: "Wildcat", performanceMicros: "-300000000" })
    ], "2026-09-01T04:00:00.000Z");

    expect(groups).toEqual([
      expect.objectContaining({ memberId: "ucla", memberDisplayName: "Bruin", performanceMicros: "200000000", wagers: [expect.objectContaining({ wagerId: "wager" }), expect.objectContaining({ wagerId: "open" }), expect.objectContaining({ wagerId: "loss" })] }),
      expect.objectContaining({ memberId: "arizona", memberDisplayName: "Wildcat", performanceMicros: "-300000000" })
    ]);
    expect(formatWeeklyPerformance("500000000")).toBe("+500.00 shares");
    expect(formatWeeklyPerformance("-300000000")).toBe("-300.00 shares");
    expect(formatWeeklyPerformance("0")).toBe("0.00 shares");
  });

  it("bolds only the selected side or total in readable activity matchup lines", () => {
    expect(formatActivityLeg(leg())).toEqual({ hidden: false, segments: [{ text: "UCLA (-7.5)", selected: true }, { text: " at Arizona", selected: false }] });
    expect(formatActivityLeg(leg({ selection: "home", originalLine: "7.5" }))).toEqual({ hidden: false, segments: [{ text: "UCLA at ", selected: false }, { text: "Arizona (+7.5)", selected: true }] });
    expect(formatActivityLeg(leg({ market: "total", selection: "over", originalLine: "44.5" }))).toEqual({ hidden: false, segments: [{ text: "UCLA at Arizona ", selected: false }, { text: "O44.5", selected: true }] });
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

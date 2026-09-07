import { describe, expect, it } from "vitest";
import { formatPickRecord, pickRecord, profileWeekOptions, seasonPerformanceMicros, splitProfileWeekWagers } from "../src/web/profile-presentation";

type Wager = Parameters<typeof splitProfileWeekWagers>[0][number];

const wager = (overrides: Partial<Wager> & Pick<Wager, "status" | "type">): Wager => ({
  wagerId: "wager-1", seasonId: "season-1", memberId: "member-1", memberDisplayName: "Bruin",
  confirmedAt: "2026-09-08T12:00:00.000Z", weekStart: "2026-09-08T04:00:00.000Z", performanceMicros: "0",
  ...overrides
});

const leg = (eventStartsAt: string) => ({ eventId: "game", league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-09-08T00:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", market: "spread", selection: "away", originalLine: "-7.5", originalOdds: -110, eventStartsAt, awayTeam: "UCLA", homeTeam: "Arizona" });

const week1 = "2026-08-25T04:00:00.000Z";
const week2 = "2026-09-01T04:00:00.000Z";
const week3 = "2026-09-08T04:00:00.000Z";
const week4 = "2026-09-15T04:00:00.000Z";

describe("profile presentation", () => {
  it("counts each settled ticket as exactly one pick regardless of leg count", () => {
    const wagers = [
      wager({ status: "won", type: "straight", performanceMicros: "100000000" }),
      wager({ status: "won", type: "parlay", performanceMicros: "200000000", legs: [leg("2026-09-08T17:00:00.000Z"), leg("2026-09-08T20:00:00.000Z"), leg("2026-09-09T01:00:00.000Z")] }),
      wager({ status: "lost", type: "teaser", performanceMicros: "-100000000", legs: [leg("2026-09-08T17:00:00.000Z"), leg("2026-09-08T20:00:00.000Z")] }),
      wager({ status: "refunded", type: "straight", performanceMicros: "0" }),
      wager({ status: "open", type: "straight" })
    ];
    expect(pickRecord(wagers)).toEqual({ wins: 2, losses: 1, refunded: 1 });
    expect(formatPickRecord(pickRecord(wagers))).toBe("2-1 (1 refunded)");
    expect(formatPickRecord({ wins: 0, losses: 0, refunded: 0 })).toBe("0-0");
    expect(seasonPerformanceMicros(wagers)).toBe("200000000");
  });

  it("lists every season week through the current week, plus weeks carrying the member's bets", () => {
    expect(profileWeekOptions([], new Date("2026-09-10T20:00:00.000Z"))).toEqual([week3, week2, week1]);
    expect(profileWeekOptions([week4, week2], new Date("2026-09-10T20:00:00.000Z"))).toEqual([week4, week3, week2, week1]);
    // Before the season anchor, only actual bet weeks remain selectable.
    expect(profileWeekOptions(["2026-08-18T04:00:00.000Z"], new Date("2026-08-20T20:00:00.000Z"))).toEqual(["2026-08-18T04:00:00.000Z"]);
  });

  it("keeps unstarted tickets off profile pages while showing in-process and settled ones", () => {
    const wagers = [
      wager({ status: "open", type: "straight", legs: [leg("2026-09-10T17:00:00.000Z"), leg("2026-09-11T01:00:00.000Z")] }),
      wager({ status: "open", type: "straight", legs: [leg("2026-09-12T17:00:00.000Z")] }),
      wager({ status: "open", type: "parlay", legs: undefined, hiddenLegCount: 3 }),
      wager({ status: "won", type: "straight", performanceMicros: "50000000" }),
      wager({ status: "lost", type: "parlay", performanceMicros: "-100000000" }),
      wager({ status: "refunded", type: "teaser", performanceMicros: "0" })
    ];
    const split = splitProfileWeekWagers(wagers, new Date("2026-09-10T20:00:00.000Z"));
    expect(split.inProcess.map((wager) => wager.status)).toEqual(["open"]);
    expect(split.inProcess[0]?.legs).toHaveLength(2);
    expect(split.settled.map((wager) => wager.status)).toEqual(["won", "lost", "refunded"]);
    // Unstarted tickets stay hidden but remain countable for the week notice.
    expect(split.unstarted.map((wager) => wager.type)).toEqual(["straight", "parlay"]);
  });
});

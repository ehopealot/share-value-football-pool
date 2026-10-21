import { describe, expect, it } from "vitest";
import type { ReadActivity } from "../src/contracts/http";
import { correctionEvents, correctedResults } from "../src/web/correction-results";

type Wager = ReadActivity["activity"]["wagers"][number];
const leg: NonNullable<Wager["legs"]>[number] = {
  eventId: "game", league: "nfl", homeTeam: "Kansas City Chiefs", awayTeam: "Buffalo Bills", eventStartsAt: "2026-01-01T00:00:00Z",
  canonicalBook: "DraftKings", retrievedAt: "2025-12-31T00:00:00Z", policyVersion: "policy", offerVersion: "offer", market: "spread", selection: "home", originalOdds: -110
};
const wager: Wager = { wagerId: "w", seasonId: "s", memberId: "m", memberDisplayName: "Member", type: "parlay", status: "open", confirmedAt: "2025-12-31T00:00:00Z", weekStart: "2025-12-30T08:00:00Z", performanceMicros: "0", legs: [leg] };
const now = Date.parse("2026-01-02T00:00:00Z");

describe("correction event drafts", () => {
  it("prefills each unique authorized event once in kickoff order, retaining team names and known zero scores", () => {
    const events = correctionEvents({ ...wager, legs: [{ ...leg, eventId: "later", eventStartsAt: "2026-01-01T20:00:00Z" }, { ...leg, homeScore: 0, awayScore: 17 }, { ...leg, market: "total", selection: "over" }] }, now);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ eventId: "game", league: "nfl", homeTeam: "Kansas City Chiefs", awayTeam: "Buffalo Bills", homeScore: "0", awayScore: "17", status: "final" });
    expect(events[1]).toMatchObject({ eventId: "later", homeScore: "", awayScore: "" });
  });

  it("does not infer missing, hidden, unstarted, or unsupported event evidence", () => {
    for (const value of [{ ...wager, legs: undefined }, { ...wager, legs: [] }, { ...wager, hiddenLegCount: 1 }, { ...wager, legs: [{ ...leg, eventStartsAt: "2027-01-01T00:00:00Z" }] }, { ...wager, legs: [{ ...leg, league: "unknown" }] }]) {
      expect(correctionEvents(value, now)).toEqual([]);
    }
  });

  it("falls back to honest home/away labels for legacy snapshots", () => {
    expect(correctionEvents({ ...wager, legs: [{ ...leg, homeTeam: undefined, awayTeam: undefined }] }, now)[0]).toMatchObject({ homeTeam: "Home team", awayTeam: "Away team" });
  });

  it("builds exact contract evidence with an automatically supplied version", () => {
    const event = correctionEvents(wager, now)[0];
    expect(correctedResults([{ ...event, homeScore: "0", awayScore: "17" }], "command-1")).toEqual([{ eventId: "game", league: "nfl", status: "final", homeScore: 0, awayScore: 17, correctionVersion: "commissioner:command-1" }]);
    for (const status of ["cancelled", "no_contest"] as const) {
      expect(correctedResults([{ ...event, status }], "command-1")[0]).toMatchObject({ status, homeScore: null, awayScore: null });
    }
  });

  it.each(["", " ", "-1", "1.5", "Infinity", "9007199254740992"])("rejects invalid scores %j instead of silently converting them", (score) => {
    const event = correctionEvents(wager, now)[0];
    expect(() => correctedResults([{ ...event, homeScore: score, awayScore: "17" }], "key")).toThrow("Kansas City Chiefs");
    expect(() => correctedResults([{ ...event, homeScore: "17", awayScore: score }], "key")).toThrow("Buffalo Bills");
  });
});

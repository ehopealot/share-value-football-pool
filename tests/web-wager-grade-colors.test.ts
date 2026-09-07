import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WagerLines } from "../src/web/pages/ActivityPage";
import { StandingsTable, defaultStandingsSort, sortStandings, toggleStandingsSort } from "../src/web/pages/StandingsPage";

type Standings = import("../src/contracts/http").ReadStandings["standings"];

const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);
const leg = (grade?: string) => ({
  eventId: `game-${grade ?? "pending"}`,
  league: "nfl",
  canonicalBook: "DraftKings",
  retrievedAt: "2026-09-01T00:00:00.000Z",
  policyVersion: "CANONICAL_BOOKS_2026_V1",
  offerVersion: "v1",
  market: "spread",
  selection: "away",
  originalLine: "-7.5",
  originalOdds: -110,
  eventStartsAt: "2026-09-06T20:00:00.000Z",
  awayTeam: "UCLA",
  homeTeam: "Arizona",
  ...(grade ? { grade } : {})
});
const wager = (legs: ReturnType<typeof leg>[]) => ({
  wagerId: "wager", seasonId: "season", memberId: "member", memberDisplayName: "Member", type: "parlay" as const, status: "lost" as const, confirmedAt: "2026-09-01T00:00:00.000Z", weekStart: "2026-09-01T04:00:00.000Z", performanceMicros: "-1000000", legs
});

describe("graded wager presentation", () => {
  it("colors every multi-leg wager from its own grade", () => {
    const html = render(createElement(WagerLines, { wager: wager([leg("loss"), leg("win"), leg("push"), leg("void"), leg()]) }));

    expect(html).toContain('class="activity-leg-loss"');
    expect(html).toContain('class="activity-leg-win"');
    expect(html).toContain('class="activity-leg-push"');
    expect(html).toContain('class="activity-leg-neutral"');
    expect(html.match(/class="activity-leg-neutral"/g)).toHaveLength(2);
    expect(html.match(/class="activity-leg-(?:loss|win|push|neutral)"/g)).toEqual([
      'class="activity-leg-loss"',
      'class="activity-leg-win"',
      'class="activity-leg-push"',
      'class="activity-leg-neutral"',
      'class="activity-leg-neutral"'
    ]);
  });
});

describe("standings presentation", () => {
  const row = (overrides: Partial<Standings[number]> = {}) => ({ userId: "member-1", rank: 1, displayName: "Member", availableMicros: "1000000", lockedMicros: "0", totalMicros: "1000000", notionalValueMicros: "1000000", priceMicros: "1000000", gainMicros: "0", riskedMicros: "0", ...overrides });
  it("shows total and locked holdings with risked, without an available column", () => {
    const html = render(createElement(StandingsTable, { standings: [row()] }));

    for (const label of ["Locked", "Total", "SVG", "Risked"]) {
      expect(html).toContain(`${label}<span class="standings-sort-indicator" aria-hidden="true"></span></button>`);
    }
    expect(html).not.toContain("Available");
    expect(html).not.toContain("Gain<span");
    // Every column header sorts, and the default rank order announces as ascending.
    expect(html.match(/<th>/g) ?? []).toHaveLength(0);
    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain('class="standings-sort"');
  });
  it("sorts numerically by value, alphabetically by member, and toggles direction", () => {
    const standings: Standings = [row({ rank: 1, displayName: "Zed", totalMicros: "5", riskedMicros: "1" }), row({ rank: 2, displayName: "Amy", totalMicros: "2", riskedMicros: "4" }), row({ rank: 3, displayName: "Mid", totalMicros: "5", riskedMicros: "4" })];
    expect(sortStandings(standings, defaultStandingsSort).map((entry) => entry.displayName)).toEqual(["Zed", "Amy", "Mid"]);
    // Numeric columns default to biggest-first; rank breaks the Zed/Mid total tie.
    const byTotal = toggleStandingsSort(defaultStandingsSort, "totalMicros");
    expect(byTotal).toEqual({ key: "totalMicros", ascending: false });
    expect(sortStandings(standings, byTotal).map((entry) => entry.displayName)).toEqual(["Zed", "Mid", "Amy"]);
    expect(sortStandings(standings, toggleStandingsSort(byTotal, "totalMicros")).map((entry) => entry.displayName)).toEqual(["Amy", "Zed", "Mid"]);
    const byRisked = toggleStandingsSort(defaultStandingsSort, "riskedMicros");
    expect(sortStandings(standings, byRisked).map((entry) => entry.displayName)).toEqual(["Amy", "Mid", "Zed"]);
    // Members sort alphabetically ascending on first click.
    const byMember = toggleStandingsSort(defaultStandingsSort, "displayName");
    expect(sortStandings(standings, byMember).map((entry) => entry.displayName)).toEqual(["Amy", "Mid", "Zed"]);
  });
  it("breaks equal member names by rank in both directions regardless of input order", () => {
    // Shuffled input with collation-equal names: only the rank tie-break can order the two Alex rows.
    const shuffled: Standings = [row({ rank: 2, displayName: "Alex", userId: "alex-2", totalMicros: "9" }), row({ rank: 1, displayName: "Alex", userId: "alex-1", totalMicros: "1" }), row({ rank: 3, displayName: "Zoe", userId: "zoe", totalMicros: "5" })];
    const ascending = toggleStandingsSort(defaultStandingsSort, "displayName");
    const descending = toggleStandingsSort(ascending, "displayName");
    expect(sortStandings(shuffled, ascending).map((entry) => entry.userId)).toEqual(["alex-1", "alex-2", "zoe"]);
    // Descending reverses the alphabet but never the rank order inside an equal-name tie.
    expect(sortStandings(shuffled, descending).map((entry) => entry.userId)).toEqual(["zoe", "alex-1", "alex-2"]);
  });
});

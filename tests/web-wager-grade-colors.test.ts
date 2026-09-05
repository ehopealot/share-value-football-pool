import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WagerLines } from "../src/web/pages/ActivityPage";
import { StandingsTable } from "../src/web/pages/StandingsPage";

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
    expect(html).toContain('class="activity-leg-neutral"');
    expect(html.match(/class="activity-leg-neutral"/g)).toHaveLength(3);
    expect(html.match(/class="activity-leg-(?:loss|win|neutral)"/g)).toEqual([
      'class="activity-leg-loss"',
      'class="activity-leg-win"',
      'class="activity-leg-neutral"',
      'class="activity-leg-neutral"',
      'class="activity-leg-neutral"'
    ]);
  });
});

describe("standings presentation", () => {
  it("shows total and locked holdings without an available column", () => {
    const html = render(createElement(StandingsTable, { standings: [{
      userId: "member-1", rank: 1, displayName: "Member", availableMicros: "1000000", lockedMicros: "0", totalMicros: "1000000", notionalValueMicros: "1000000", priceMicros: "1000000", gainMicros: "0"
    }] }));

    expect(html).toContain("<th>Locked</th>");
    expect(html).toContain("<th>Total</th>");
    expect(html).toContain("<th>SVG</th>");
    expect(html).not.toContain("<th>Available</th>");
    expect(html).not.toContain("<th>Gain</th>");
  });
});

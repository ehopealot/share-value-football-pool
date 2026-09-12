import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { MatchupDetails, MatchupBoxScore, matchupUnavailableMessage } from "../src/web/pages/MatchupDetailsPage";
import { MatchupLegLink } from "../src/web/components/MatchupLegLink";
import { ApiError } from "../src/web/api";
import { OddsBoardTable, matchupDetailsAvailable, type GameRow } from "../src/web/pages/OddsPage";

const game: GameRow = { eventId: "atl-pit", league: "nfl", startsAt: "2026-09-13T17:00:00.000Z", awayTeam: "Atlanta Falcons", homeTeam: "Pittsburgh Steelers", markets: { spread: {}, total: {}, moneyline: {} } };
const styles = readFileSync(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");

describe("in-app matchup details", () => {
  it("links only games in the actual current Pacific week, regardless of the board's selected week", () => {
    expect(matchupDetailsAvailable(game.startsAt, "2026-09-08T07:00:00.000Z")).toBe(true);
    expect(matchupDetailsAvailable(game.startsAt, "2026-09-15T07:00:00.000Z")).toBe(false);

    const active = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(OddsBoardTable, { games: [game], slug: "pool", currentWeek: "2026-09-08T07:00:00.000Z", selectedPickIds: [], onToggle: () => undefined })));
    const inactive = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(OddsBoardTable, { games: [game], slug: "pool", currentWeek: "2026-09-15T07:00:00.000Z", selectedPickIds: [], onToggle: () => undefined })));
    expect(active).toContain('href="/p/pool/matchups/atl-pit"');
    expect(inactive).not.toContain("/matchups/atl-pit");
  });

  it("presents records, season stats, venue, and recent results with table and heading semantics", () => {
    const html = renderToStaticMarkup(createElement(MatchupDetails, { matchup: {
      league: "nfl", startsAt: game.startsAt, venue: "Acrisure Stadium · Pittsburgh, PA",
      away: { name: "Atlanta Falcons", record: "1-0", recentResults: [{ date: "2026-09-06T17:00:00.000Z", opponent: "Pittsburgh Steelers", result: "W 24-17" }] },
      home: { name: "Pittsburgh Steelers", record: "0-1", recentResults: [{ date: "2026-09-06T17:00:00.000Z", opponent: "Atlanta Falcons", result: "L 17-24" }] },
      seasonStats: [{ label: "Yards/game", away: "350", home: "300" }]
    } }));

    expect(html).toContain("Kickoff:");
    expect(html).toContain("Acrisure Stadium");
    expect(html).toContain("Atlanta Falcons");
    expect(html).toContain("1-0");
    expect(html).toContain("<h2 class=\"table-ribbon\">Season team stats</h2>");
    expect(html).toContain('<th scope="col">Atlanta Falcons</th>');
    expect(html).toContain("<h2 class=\"table-ribbon\">Recent results</h2>");
    expect(html).toContain("matchup-team-ribbon");
    expect(html).toContain("W 24-17");
  });

  it("uses a truthful unavailable message when ESPN cannot match a current-week game", () => {
    expect(matchupUnavailableMessage(new ApiError("MATCHUP_NOT_AVAILABLE", 404))).toBe("Matchup details aren't available for this game.");
  });

  it("keeps mobile matchup links and the detail comparison within the existing touch-friendly visual system", () => {
    expect(styles).toMatch(/\.odds-matchup-link\s*\{[^}]*display:\s*block/);
    expect(styles).toMatch(/\.matchup-details\s*\{/);
    expect(styles).toMatch(/@media \(max-width: 600px\)[\s\S]*\.matchup-details/);
  });
});

const liveBox = {
  state: "live" as const, startsAt: game.startsAt, statusDetail: "2nd Qtr - 5:22", clock: "5:22", period: 2,
  away: { name: "Atlanta Falcons", score: "14" }, home: { name: "Pittsburgh Steelers", score: "10" },
  quarters: [{ label: "Q1", away: "7", home: "3" }, { label: "Q2", away: "7", home: "7" }, { label: "Q3" }, { label: "Q4" }],
  stats: []
};

describe("box score view", () => {
  it("shows the scoreline, live state, and quarter breakdown without stats while live", () => {
    const html = renderToStaticMarkup(createElement(MatchupBoxScore, { box: liveBox }));
    expect(html).toContain("ESPN box score");
    expect(html).toContain("14");
    expect(html).toContain("10");
    expect(html).toContain("2nd Qtr - 5:22");
    expect(html).toContain("Scoring by quarter");
    expect(html).toContain(">Q4<");
    expect(html).not.toContain("Team stats");
  });

  it("shows final results with team stats once final", () => {
    const html = renderToStaticMarkup(createElement(MatchupBoxScore, { box: { ...liveBox, state: "final", statusDetail: "Final", stats: [{ label: "Total Yards", away: "340", home: "208" }] } }));
    expect(html).toContain("Final");
    expect(html).toContain("Team stats");
    expect(html).toContain("Total Yards");
  });

  it("links current-week legs to their matchup without an underline and leaves other weeks as text", () => {
    const currentWeekLeg = { eventId: "leg-1", eventStartsAt: "2026-09-13T17:00:00.000Z" };
    const priorWeekLeg = { eventId: "leg-2", eventStartsAt: "2026-08-30T17:00:00.000Z" };
    const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement("div", {},
      createElement(MatchupLegLink, { slug: "pool", leg: currentWeekLeg, children: createElement("span", {}, "Falcons +3.5") }),
      createElement(MatchupLegLink, { slug: "pool", leg: priorWeekLeg, children: createElement("span", {}, "Browns +7") })
    )));
    expect(html).toContain('href="/p/pool/matchups/leg-1"');
    expect(html).toContain('class="matchup-link"');
    expect(html).not.toContain("leg-2");
    expect(styles).toMatch(/\.matchup-link,\s*\.odds-matchup-link\s*\{\s*text-decoration:\s*none/);
  });
});

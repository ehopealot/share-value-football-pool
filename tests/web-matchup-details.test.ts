import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { MatchupDetails, matchupUnavailableMessage } from "../src/web/pages/MatchupDetailsPage";
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

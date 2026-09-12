import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { MatchupDetails, MatchupBoxScore, MatchupLines, PoolExposure, matchupUnavailableMessage, matchupPageView } from "../src/web/pages/MatchupDetailsPage";
import type { EspnBoxScoreResponse as EspnBoxScore, PoolExposureResponse } from "../src/contracts/http";
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

  it("keeps matchup tables at the page's width so wide lines scroll inside the table, like Activity", () => {
    expect(styles).toMatch(/\.matchup-details > \* \{ min-width: 0; \}/);
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

describe("matchup page view precedence", () => {
  it("shows the box score for started games even when the pregame details call failed", () => {
    expect(matchupPageView({ error: "Matchup details aren't available for this game.", box: liveBox }).kind).toBe("box");
    expect(matchupPageView({ error: "Matchup details aren't available for this game.", box: { ...liveBox, state: "final" } }).kind).toBe("box");
  });
  it("keeps the error, loading, and details states for everything else", () => {
    expect(matchupPageView({ error: "broken", box: undefined, matchup: undefined }).kind).toBe("error");
    expect(matchupPageView({ error: "broken", box: { ...liveBox, state: "pregame" }, matchup: undefined }).kind).toBe("error");
    expect(matchupPageView({ error: "", box: undefined, matchup: undefined }).kind).toBe("loading");
    expect(matchupPageView({ error: "", box: { ...liveBox, state: "pregame" }, matchup: { league: "nfl", startsAt: game.startsAt, away: { name: "Atlanta Falcons", recentResults: [] }, home: { name: "Pittsburgh Steelers", recentResults: [] }, seasonStats: [] } }).kind).toBe("details");
  });
});

type ExposureLeg = NonNullable<PoolExposureResponse["wagers"][number]["legs"]>[number];
const leg = (eventId: string, market: string, selection: string, line?: string): ExposureLeg => ({ eventId, league: "nfl", canonicalBook: "book", retrievedAt: "2026-09-10T17:00:00.000Z", policyVersion: "1", offerVersion: "1", market, selection, ...(line ? { originalLine: line } : {}), originalOdds: -110, eventStartsAt: game.startsAt, homeTeam: "Pittsburgh Steelers", awayTeam: "Atlanta Falcons" } as ExposureLeg);
const exposureWager = (over: Partial<PoolExposureResponse["wagers"][number]>) => ({
  wagerId: `w-${Math.random().toString(36).slice(2, 8)}`, seasonId: "s1", memberId: "m1", memberDisplayName: "Member One", type: "straight", status: "won",
  confirmedAt: "2026-09-12T15:00:00.000Z", weekStart: "2026-09-08T07:00:00.000Z", performanceMicros: "0", legs: [leg("atl-pit", "spread", "Falcons +3.5")], ...over
} as PoolExposureResponse["wagers"][number]);

describe("pool exposure table", () => {
  it("groups bets under member ribbons and sums the pool net including double-counted parlays", () => {
    const wagers = [
      exposureWager({ wagerId: "w1", memberId: "m1", memberDisplayName: "Alice", type: "parlay", performanceMicros: "90000000", riskMicros: "50000000", acceptedOdds: 280, legs: [leg("atl-pit", "spread", "away", "3.5"), leg("other-game", "total", "over", "44.5")] }),
      exposureWager({ wagerId: "w2", memberId: "m1", memberDisplayName: "Alice", status: "open", performanceMicros: "0", riskMicros: "25000000", acceptedOdds: -110, legs: [leg("atl-pit", "total", "over", "40.5")] }),
      exposureWager({ wagerId: "w3", memberId: "m2", memberDisplayName: "Bob", status: "lost", performanceMicros: "-30000000", riskMicros: "30000000", acceptedOdds: -100, legs: [leg("atl-pit", "moneyline", "home")] })
    ];
    const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(PoolExposure, { wagers, slug: "pool" })));
    expect(html).toContain("Pool exposure");
    expect(html).toContain("Pool net +60.00 shares");
    expect(html).toContain("activity-day-member-ribbon");
    expect(html).toContain("Alice");
    expect(html).toContain("Bob");
    expect(html).toContain("Bob");
    expect(html).toContain("-30.00 shares");
    expect(html).toContain("+90.00 shares");
    expect(html).toContain("Atlanta (+3.5)");
    expect(html).toContain("O40.5");
  });

  it("shows a truthful notice when the pool has no bets on the game", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(PoolExposure, { wagers: [], slug: "pool" })));
    expect(html).toContain("No pool bets on this game.");
    expect(html).toContain("Pool net +0.00 shares");
  });
});

const boardLine = (market: "spread" | "total" | "moneyline", outcomes: Array<{ name: string; price: number; point?: number }>): NonNullable<EspnBoxScore["lines"]>[number] => ({
  eventId: "atl-pit", league: "nfl", homeTeam: "Pittsburgh Steelers", awayTeam: "Atlanta Falcons", startsAt: game.startsAt,
  market, canonicalBook: "DraftKings", retrievedAt: "2026-09-12T15:00:00.000Z", offerVersion: "v1", policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes
} as NonNullable<EspnBoxScore["lines"]>[number]);

describe("board lines on matchup pages", () => {
  it("renders spread, total, and moneyline chips when offered", () => {
    const lines = [
      boardLine("spread", [{ name: "Atlanta Falcons", point: 3.5, price: -110 }, { name: "Pittsburgh Steelers", point: -3.5, price: -110 }]),
      boardLine("total", [{ name: "Over", point: 44.5, price: -110 }, { name: "Under", point: 44.5, price: -110 }]),
      boardLine("moneyline", [{ name: "Atlanta Falcons", price: 150 }, { name: "Pittsburgh Steelers", price: -170 }])
    ];
    const html = renderToStaticMarkup(createElement(MatchupLines, { lines }));
    expect(html).toContain("Pittsburgh -3.5");
    expect(html).toContain("O/U 44.5");
    expect(html).toContain("Pittsburgh -157");
    expect(html).not.toContain("Atlanta +3.5");
    expect(html).not.toContain("O 44.5");
    expect((html.match(/class="matchup-line"/g) ?? []).length).toBe(3);
    expect(html).not.toContain("Atlanta +157");
  });

  it("renders nothing when no lines are offered and omits missing markets", () => {
    expect(renderToStaticMarkup(createElement(MatchupLines, { lines: undefined }))).toBe("");
    expect(renderToStaticMarkup(createElement(MatchupLines, { lines: [] }))).toBe("");
    const html = renderToStaticMarkup(createElement(MatchupLines, { lines: [boardLine("total", [{ name: "Over", point: 40.5, price: -105 }, { name: "Under", point: 40.5, price: -105 }])] }));
    expect(html).toContain("O/U 40.5");
    expect(html).not.toContain("+3.5");
  });
});

describe("matchup hint", () => {
  it("renders the tap hint smaller than the pickers, only where matchups link", async () => {
    const { MatchupHint, matchupHintText } = await import("../src/web/components/MatchupLegLink");
    const html = renderToStaticMarkup(createElement(MatchupHint));
    expect(html).toContain(matchupHintText);
    expect(styles).toMatch(/\.matchup-hint\s*\{[^}]*font-size:\s*0\.78rem/);
    const oddsSource = readFileSync(resolve(import.meta.dirname, "../src/web/pages/OddsPage.tsx"), "utf8");
    const activitySource = readFileSync(resolve(import.meta.dirname, "../src/web/pages/ActivityPage.tsx"), "utf8");
    const myWagersSource = readFileSync(resolve(import.meta.dirname, "../src/web/pages/MyWagersPage.tsx"), "utf8");
    expect(oddsSource).toContain("{week === currentWeek && <MatchupHint/>}");
    expect(activitySource).toContain("{(week === undefined || week === currentWeek) && <MatchupHint/>}");
    expect(myWagersSource).toContain("{(week === undefined || week === currentWeek) && <MatchupHint/>}");
  });
});

describe("quarter grid completeness", () => {
  it("always renders four quarter columns with blank unplayed cells", () => {
    const html = renderToStaticMarkup(createElement(MatchupBoxScore, { box: { ...liveBox, quarters: [{ label: "Q1", away: "7", home: "3" }, { label: "Q2" }, { label: "Q3" }, { label: "Q4" }] } }));
    expect(html).toContain(">Q1<");
    expect(html).toContain(">Q4<");
    const emptyCells = html.match(/<td><\/td>/g) ?? [];
    expect(emptyCells.length).toBe(6);
  });
});

describe("matchup links from member profiles", () => {
  it("threads the pool slug into profile activity sections so links resolve", async () => {
    const source = readFileSync(resolve(import.meta.dirname, "../src/web/pages/MemberProfilePage.tsx"), "utf8");
    expect(source).toContain('title="In process" slug={slug}');
    expect(source).toContain('title="Settled" slug={slug}');
  });
});

describe("box score lines", () => {
  it("keeps the started-game view free of board lines", () => {
    const html = renderToStaticMarkup(createElement(MatchupBoxScore, { box: { ...liveBox, lines: [boardLine("spread", [{ name: "Atlanta Falcons", point: 3.5, price: -110 }, { name: "Pittsburgh Steelers", point: -3.5, price: -110 }])] } }));
    expect(html).not.toContain("matchup-lines");
  });
});

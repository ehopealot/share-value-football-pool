import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatAmericanOdds, formatKickoff } from "../src/web/odds-format";
import { batchAfterPopState, filterGamesByTeam, groupBoardByEvent, OddsBoardTable, oddsBoardTablePropsAreEqual, selectionTrayDisplayLabel, straightReviewDetails, type GameRow } from "../src/web/pages/OddsPage";

const oddsPageSource = readFileSync(resolve(import.meta.dirname, "../src/web/pages/OddsPage.tsx"), "utf8");
const styles = readFileSync(resolve(import.meta.dirname, "../src/web/styles.css"), "utf8");
const cssBlockEnd = (source: string, start: number) => {
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return index + 1;
  }
  throw new Error("Unclosed CSS block");
};
const mobileBlocks = [...styles.matchAll(/@media \(max-width: 600px\)\s*\{/g)].map((match) => {
  const start = match.index;
  const end = cssBlockEnd(styles, start);
  return { start, end, source: styles.slice(start, end) };
});
const mobileOddsStyles = mobileBlocks.find((block) => block.source.includes(".odds-board {"))?.source ?? "";
const topLevelStyles = mobileBlocks.reduceRight((source, block) => source.slice(0, block.start) + source.slice(block.end), styles);

describe("member-facing odds display", () => {
  it("always prefixes a positive American price with +", () => {
    expect(formatAmericanOdds(100)).toBe("+100");
    expect(formatAmericanOdds(225)).toBe("+225");
    expect(formatAmericanOdds(-110)).toBe("-110");
  });

  it("uses one compact local kickoff formatter for the odds board and wager tables", () => {
    const previousTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(formatKickoff("2026-09-06T20:00:00.000Z")).toBe("09/06 04:00p");
      expect(oddsPageSource).toContain("formatKickoff(game.startsAt)");
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  const kickoffGame = (eventId: string, startsAt: string): GameRow => ({ eventId, startsAt, league: "nfl", awayTeam: "Away", homeTeam: "Home", markets: { spread: {}, total: {}, moneyline: {} } });
  const renderKickoffs = (games: GameRow[]) => renderToStaticMarkup(createElement(OddsBoardTable, { games, currentWeek: "2026-09-08T07:00:00.000Z", selectedPickIds: [], onToggle: () => undefined }));
  const kickoffRibbons = (html: string) => [...html.matchAll(/<tr class="odds-kickoff-row"><th colSpan="4"><span class="odds-kickoff-heading"><span>(.*?)<\/span><span>.*?<\/span><\/span><\/th><\/tr>/g)].map((match) => match[1]);

  it("adds one date/time ribbon per kickoff batch, including equivalent timestamp formats", () => {
    const starts = ["2026-09-13T17:00:00.000Z", "2026-09-13T13:00:00-04:00", "2026-09-13T20:25:00.000Z", "2026-09-14T17:00:00.000Z"];
    const html = renderKickoffs(starts.map((start, index) => kickoffGame(String(index), start)));
    expect(kickoffRibbons(html)).toEqual([starts[0], starts[2], starts[3]].map(formatKickoff));
    expect(html.match(/class="odds-game-top"/g)).toHaveLength(4);
    expect(html.match(/class="odds-game-bottom"/g)).toHaveLength(4);
    expect(html).not.toContain("odds-mobile-start");
    expect(html.match(/class="odds-start"/g)).toHaveLength(4);
  });

  it("labels kickoff ribbons with the league aligned opposite the date/time", () => {
    const games = [kickoffGame("nfl", "2026-09-13T17:00:00.000Z"), { ...kickoffGame("college", "2026-09-14T17:00:00.000Z"), league: "ncaaf" as const }];
    const html = renderKickoffs(games);
    expect(html).toContain(`<span class="odds-kickoff-heading"><span>${formatKickoff(games[0].startsAt)}</span><span>NFL</span></span>`);
    expect(html).toContain(`<span class="odds-kickoff-heading"><span>${formatKickoff(games[1].startsAt)}</span><span>NCAAF</span></span>`);
    expect(mobileOddsStyles).toMatch(/\.odds-kickoff-heading\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/);
  });

  it("keeps league labels accurate even if leagues unexpectedly share a kickoff", () => {
    const nfl = kickoffGame("nfl", "2026-09-13T17:00:00.000Z");
    const html = renderKickoffs([nfl, { ...nfl, eventId: "college", league: "ncaaf" }]);
    expect(kickoffRibbons(html)).toHaveLength(2);
    expect(html).toContain("<span>NFL</span>");
    expect(html).toContain("<span>NCAAF</span>");
  });

  it("keeps the kickoff heading when filtering removes the original first game", () => {
    const games = [kickoffGame("first", "2026-09-13T17:00:00.000Z"), { ...kickoffGame("second", "2026-09-13T17:00:00.000Z"), awayTeam: "Buffalo Bills" }];
    const html = renderKickoffs(filterGamesByTeam(games, "Buffalo"));
    expect(kickoffRibbons(html)).toEqual([formatKickoff(games[1].startsAt)]);
    expect(html).toMatch(/<tbody><tr class="odds-kickoff-row">/);
    expect(kickoffRibbons(renderKickoffs([]))).toEqual([]);
  });

  it("shows thin kickoff ribbons only on mobile with the My Bets date-ribbon styling", () => {
    expect(topLevelStyles).toMatch(/\.odds-kickoff-row\s*\{\s*display:\s*none;/);
    expect(mobileOddsStyles).toMatch(/\.odds-kickoff-row\s*\{\s*display:\s*table-row;/);
    const ribbonStyles = mobileOddsStyles.match(/\.odds-board \.odds-kickoff-row th\s*\{([^}]*)\}/)?.[1] ?? "";
    for (const declaration of ["padding: 0 0.25rem", "background: var(--blue)", "color: #fff", "font-size: 0.78rem", "line-height: 1.1", "text-size-adjust: none", "-webkit-text-size-adjust: none"]) expect(ribbonStyles).toContain(declaration);
    expect(styles).not.toContain(".odds-mobile-start");
  });

  it("provides straight-bet confirmation totals without repeating the selected matchup", () => {
    expect(straightReviewDetails({
      item: { risk: "10" },
      quote: {
        riskMicros: "10000000",
        acceptedOdds: 125,
        leg: { awayTeam: "Away", homeTeam: "Home", market: "moneyline", selection: "away", originalLine: null, originalOdds: 125 }
      }
    } as any)).toEqual({ odds: "+125", risk: "10 shares", toWin: "12.50 shares" });
  });

  it("omits explicit market names from resolved bet-slip labels", () => {
    const offer = { awayTeam: "Away", homeTeam: "Home" };
    expect(selectionTrayDisplayLabel({ market: "spread", selection: "away" } as any, { offer: { ...offer, market: "spread" }, outcome: { name: "Away", point: 3, price: -110 } })).toBe("Away at Home: Away +3");
    expect(selectionTrayDisplayLabel({ market: "total", selection: "over" } as any, { offer: { ...offer, market: "total" }, outcome: { name: "Over", point: 44.5, price: -110 } })).toBe("Away at Home: Over 44.5");
    expect(selectionTrayDisplayLabel({ market: "moneyline", selection: "home" } as any, { offer: { ...offer, market: "moneyline" }, outcome: { name: "Home", price: 125 } })).toBe("Away at Home: Home +125");
    expect(selectionTrayDisplayLabel({ market: "spread", selection: "away" } as any, { offer: { league: "ncaaf", awayTeam: "Texas Longhorns", homeTeam: "Oklahoma Sooners", market: "spread" }, outcome: { name: "Texas Longhorns", point: -3, price: -110 } })).toBe("Texas at Oklahoma: Texas -3");
  });

  it("returns both review and placement results to the odds board on browser back", () => {
    const reviewing = { tag: "reviewing", entries: [], quoteFailures: [] } as any;
    const results = { tag: "results", placed: [], failed: [], retryPlacements: [] } as any;
    const quoting = { tag: "quoting" } as any;
    const placing = { tag: "placing", entries: [], quoteFailures: [] } as any;

    expect(batchAfterPopState(reviewing)).toBeUndefined();
    expect(batchAfterPopState(results)).toBeUndefined();
    expect(batchAfterPopState(quoting)).toEqual(quoting);
    expect(batchAfterPopState(placing)).toEqual(placing);
  });

  it("stacks bold odds-board team names around a normal-weight at", () => {
    const markup = renderToStaticMarkup(createElement(OddsBoardTable, {
      games: [{ eventId: "game", league: "nfl", startsAt: "2030-09-01T12:00:00.000Z", awayTeam: "Away", homeTeam: "Home", markets: { spread: {}, total: {}, moneyline: {} } }],
      currentWeek: "2030-09-01T04:00:00.000Z",
      selectedPickIds: [],
      onToggle: () => undefined
    }));

    expect(markup).toContain('<strong class="odds-matchup-team">Away</strong><span class="odds-matchup-at">at</span><strong class="odds-matchup-team">Home</strong>');
    expect(styles).toMatch(/\.odds-matchup-team\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap[^}]*line-height:\s*1\.15/);
    expect(styles).toMatch(/\.odds-matchup-at\s*\{[^}]*display:\s*block[^}]*font-weight:\s*400[^}]*line-height:\s*1/);
  });

  it("gives the mobile matchup column more room than the market columns", () => {
    expect(mobileOddsStyles).toMatch(/\.odds-board thead th:nth-child\(2\)\s*\{[^}]*width:\s*5\.5rem/);
    expect(mobileOddsStyles).toMatch(/th:nth-child\(3\),\s*\.odds-board thead th:nth-child\(4\),\s*\.odds-board thead th:nth-child\(5\)\s*\{[^}]*width:\s*4\.25rem/);
  });

  it("keeps the two odds-board sub-rows equal beneath row-spanning matchup cells", () => {
    expect(topLevelStyles).toMatch(/\.odds-board \.odds-game-top, \.odds-board \.odds-game-bottom\s*\{[^}]*height:\s*2\.4rem/);
    expect(topLevelStyles).toMatch(/\.odds-game-top > \.odds-matchup\s*\{[^}]*height:\s*4\.8rem/);
    expect(mobileOddsStyles).toMatch(/\.odds-board \.odds-game-top, \.odds-board \.odds-game-bottom\s*\{[^}]*height:\s*2\.1rem/);
    expect(mobileOddsStyles).toMatch(/\.odds-game-top > \.odds-matchup\s*\{[^}]*height:\s*4\.2rem/);
  });

  it("keeps the odds table memoized while only a bet amount changes", () => {
    const games: any[] = [];
    const onToggle = () => undefined;
    const previous = { games, currentWeek: "2026-09-01T04:00:00.000Z", selectedPickIds: ["event:spread:away"], onToggle };
    expect(oddsBoardTablePropsAreEqual(previous, { ...previous, selectedPickIds: ["event:spread:away"] })).toBe(true);
    expect(oddsBoardTablePropsAreEqual(previous, { ...previous, selectedPickIds: ["event:spread:home"] })).toBe(false);
  });

  it("keeps the mobile bet slip summary compact and omits empty-tray instructions", () => {
    expect(oddsPageSource).toContain('Shares: <strong>{formatMicros(total, 2)}</strong> · Available: <strong>{formatMicros(available, 2)}</strong> · Share price: <strong>{shareValue}</strong>');
    expect(oddsPageSource).not.toContain('Check options on the board to build straight wagers, a teaser, or a parlay.');
  });

  it("explains last-known odds beside the pool context and offers a reload after failed refreshes", () => {
    expect(oddsPageSource).toContain('<h1>Odds board</h1>');
    expect(oddsPageSource).toContain('<p className="pool-context">{view &&');
    expect(oddsPageSource).toContain('<span role="status">{board?.feed.message ?? "Loading odds…"}</span>');
    expect(oddsPageSource).toContain('board?.feed.status === "provider-error"');
    expect(oddsPageSource).toContain('Last successful refresh:');
    expect(oddsPageSource).toContain('className="odds-board-filters"');
    expect(oddsPageSource).toContain('board?.feed.status === "stale"');
    expect(oddsPageSource).toContain('<a href={window.location.href}>Reload odds</a>');
  });

  it("uses concise NCAA school names on the odds board", () => {
    const games = groupBoardByEvent([{ eventId: "texas-oklahoma", league: "ncaaf", startsAt: "2026-09-10T17:00:00.000Z", awayTeam: "Texas Longhorns", homeTeam: "Oklahoma Sooners", market: "spread", outcomes: [{ name: "Texas Longhorns", price: -110, point: -3 }, { name: "Oklahoma Sooners", price: -110, point: 3 }] }]);
    const html = renderToStaticMarkup(createElement(OddsBoardTable, { games, currentWeek: "2026-09-07T04:00:00.000Z", selectedPickIds: [], onToggle: () => undefined }));
    expect(html).toContain("Texas");
    expect(html).toContain("Oklahoma");
    expect(html).not.toContain("Texas Longhorns");
    expect(html).not.toContain("Oklahoma Sooners");
  });

  it("shows only vig-free moneylines through the inclusive +/-1200 limit", () => {
    const moneyline = (eventId: string, price: number) => ({ eventId, league: "nfl", startsAt: "2026-09-10T17:00:00.000Z", awayTeam: "Away", homeTeam: "Home", market: "moneyline", outcomes: [{ name: "Away", price }, { name: "Home", price: -price }] });
    const games = groupBoardByEvent([moneyline("at-limit", 1200), moneyline("over-limit", 1201)]);

    expect(games[0]!.markets.moneyline.away?.odds).toBe("+1200");
    expect(games[0]!.markets.moneyline.home?.odds).toBe("-1200");
    expect(games[1]!.markets.moneyline).toEqual({});
  });

  it.each([
    [-1300, 1192, 1200, true],
    [-1300, 1193, 1201, false],
    [-1200, 1300, 1292, false]
  ])("filters book prices %s/%s by their vig-free strike, not raw prices", (home, away, strike, available) => {
    const [game] = groupBoardByEvent([{ eventId: "vig-limit", league: "nfl", startsAt: "2026-09-10T17:00:00.000Z", homeTeam: "Home", awayTeam: "Away", market: "moneyline", outcomes: [{ name: "Home", price: home }, { name: "Away", price: away }] }]);
    if (available) {
      expect(game!.markets.moneyline.home?.odds).toBe(`-${strike}`);
      expect(game!.markets.moneyline.away?.odds).toBe(`+${strike}`);
      expect(game!.markets.moneyline.home?.outcome.price).toBe(home);
    } else expect(game!.markets.moneyline).toEqual({});
  });

  it("filters either team fuzzily while retaining input order", () => {
    const markets = { spread: {}, total: {}, moneyline: {} };
    const games: GameRow[] = [
      { eventId: "jets-broncos", league: "nfl", startsAt: "2026-09-10T17:00:00.000Z", awayTeam: "New York Jets", homeTeam: "Denver Broncos", markets },
      { eventId: "chiefs-raiders", league: "nfl", startsAt: "2026-09-10T20:00:00.000Z", awayTeam: "Kansas City Chiefs", homeTeam: "Las Vegas Raiders", markets },
      { eventId: "jets-dolphins", league: "nfl", startsAt: "2026-09-11T17:00:00.000Z", awayTeam: "New Jersey Jets", homeTeam: "Miami Dolphins", markets }
    ];

    expect(filterGamesByTeam(games, "BRONCOS")).toEqual([games[0]]);
    expect(filterGamesByTeam(games, "cheifs")).toEqual([games[1]]);
    expect(filterGamesByTeam(games, "jets")).toEqual([games[0], games[2]]);
    expect(filterGamesByTeam(games, "")).toBe(games);
  });
});

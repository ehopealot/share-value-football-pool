import { describe, expect, it, vi } from "vitest";
import { lookupEspnMatchup, matchupCacheRequest, type EspnMatchupCache, type EspnMatchupInput } from "../src/services/espn-matchup";

const input: EspnMatchupInput = {
  league: "nfl", startsAt: "2026-09-13T17:00:00.000Z", awayTeam: "Atlanta Falcons", homeTeam: "Pittsburgh Steelers"
};

const team = (id: string, displayName: string) => ({ id, displayName, location: displayName.split(" ").slice(0, -1).join(" "), name: displayName.split(" ").at(-1), abbreviation: displayName.slice(0, 3).toUpperCase(), logo: `https://images.example/${id}.png` });
const game = (overrides: Record<string, unknown> = {}) => ({
  id: "espn-game", date: input.startsAt,
  competitions: [{
    venue: { fullName: "Acrisure Stadium", address: { city: "Pittsburgh", state: "PA" } },
    competitors: [
      { homeAway: "away", team: team("away", "Atlanta Falcons"), records: [{ type: "total", summary: "1-0" }] },
      { homeAway: "home", team: team("home", "Pittsburgh Steelers"), records: [{ type: "total", summary: "0-1" }] }
    ]
  }],
  ...overrides
});
const stats = (yards: string) => ({ status: "success", results: { stats: { categories: [{ name: "rushing", stats: [{ name: "totalYards", displayName: "Total Yards", displayValue: yards, perGameDisplayValue: "350" }, { name: "rushingYards", displayName: "Rushing Yards", displayValue: "120", perGameDisplayValue: "120" }] }, { name: "passing", stats: [{ name: "passingYards", displayName: "Passing Yards", displayValue: "230", perGameDisplayValue: "230" }] }, { name: "scoring", stats: [{ name: "totalTouchdowns", displayName: "Total Touchdowns", displayValue: "3" }] }, { name: "defensive", stats: [{ name: "sacks", displayName: "Sacks", displayValue: "4" }] }] } } });
const schedule = (teamId: string, teamName: string, opponent: string) => ({ events: [{
  id: `${teamId}-last`, date: "2026-09-06T17:00:00.000Z", status: { type: { completed: true } },
  competitions: [{ competitors: [
    { homeAway: "away", winner: true, score: "24", team: team(teamId, teamName) },
    { homeAway: "home", winner: false, score: "17", team: team(`${teamId}-opponent`, opponent) }
  ] }]
}] });

class MemoryCache implements EspnMatchupCache {
  entries = new Map<string, Response>();
  async match(request: Request) { return this.entries.get(request.url)?.clone(); }
  async put(request: Request, response: Response) { this.entries.set(request.url, response.clone()); }
}

const responseFor = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
const successfulFetcher = () => vi.fn(async (url: string | URL | Request) => {
  const value = String(url);
  if (value.includes("scoreboard")) return responseFor({ events: [game()] });
  if (value.includes("teams/away/statistics")) return responseFor(stats("350"));
  if (value.includes("teams/home/statistics")) return responseFor(stats("300"));
  if (value.includes("teams/away/schedule")) return responseFor(schedule("away", "Atlanta Falcons", "Pittsburgh Steelers"));
  if (value.includes("teams/home/schedule")) return responseFor(schedule("home", "Pittsburgh Steelers", "Atlanta Falcons"));
  return responseFor({ code: "not-found" }, { status: 404 });
});

describe("ESPN matchup lookup", () => {
  it("uses an exact home/away/date scoreboard match and returns cacheable, normalized detail", async () => {
    const fetcher = successfulFetcher();
    const cache = new MemoryCache();

    const result = await lookupEspnMatchup(input, { fetcher, cache });

    expect(result).toMatchObject({
      status: "ok",
      matchup: {
        league: "nfl", startsAt: input.startsAt, venue: "Acrisure Stadium · Pittsburgh, PA",
        away: { name: "Atlanta Falcons", record: "1-0", recentResults: [{ result: "W 24-17", opponent: "Pittsburgh Steelers" }] },
        home: { name: "Pittsburgh Steelers", record: "0-1", recentResults: [{ result: "W 24-17", opponent: "Atlanta Falcons" }] },
        seasonStats: [
          { label: "Yards/game", away: "350", home: "350" },
          { label: "Passing yards/game", away: "230", home: "230" },
          { label: "Rushing yards/game", away: "120", home: "120" },
          { label: "Touchdowns", away: "3", home: "3" },
          { label: "Defensive sacks", away: "4", home: "4" }
        ]
      }
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(cache.entries.get(matchupCacheRequest(input).url)).toBeDefined();
  });

  it("reads the cached blob before requesting ESPN and keys it by league, both teams, and game date", async () => {
    const cache = new MemoryCache();
    await lookupEspnMatchup(input, { fetcher: successfulFetcher(), cache });
    const fetcher = vi.fn(async () => { throw new Error("ESPN should not be called for a cache hit"); });

    const result = await lookupEspnMatchup(input, { fetcher, cache });

    expect(result.status).toBe("ok");
    expect(fetcher).not.toHaveBeenCalled();
    expect(matchupCacheRequest(input).url).toContain("/nfl/2026-09-13/atlanta-falcons__pittsburgh-steelers");
    expect(matchupCacheRequest({ ...input, homeTeam: "Cleveland Browns" }).url).not.toBe(matchupCacheRequest(input).url);
  });

  it("ignores a malformed cached blob and refetches a validated matchup", async () => {
    const cache = new MemoryCache();
    await cache.put(matchupCacheRequest(input), responseFor({ matchup: { league: "nfl", startsAt: input.startsAt, away: { name: input.awayTeam }, home: { name: input.homeTeam }, seasonStats: [] } }));
    const fetcher = successfulFetcher();

    await expect(lookupEspnMatchup(input, { fetcher, cache })).resolves.toMatchObject({ status: "ok", matchup: { away: { recentResults: expect.any(Array) } } });
    expect(fetcher).toHaveBeenCalled();
  });

  it("accepts only explicit aliases while still requiring both correct sides and the exact date", async () => {
    const college: EspnMatchupInput = { league: "ncaaf", startsAt: input.startsAt, awayTeam: "Southern California Trojans", homeTeam: "UConn Huskies" };
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).includes("scoreboard")) return responseFor({ results: { stats: { categories: [] } }, events: [] });
      return responseFor({ events: [game({ competitions: [{ competitors: [
        { homeAway: "away", team: team("away", "USC Trojans"), records: [] },
        { homeAway: "home", team: team("home", "Connecticut Huskies"), records: [] }
      ] }] })] });
    });

    expect((await lookupEspnMatchup(college, { fetcher })).status).toBe("ok");
    expect((await lookupEspnMatchup({ ...college, startsAt: "2026-09-14T17:00:00.000Z" }, { fetcher })).status).toBe("not-found");
    expect((await lookupEspnMatchup({ ...college, awayTeam: "USC Trojans", homeTeam: "Pittsburgh Steelers" }, { fetcher })).status).toBe("not-found");
  });

  it("never selects an ambiguous or reversed ESPN event", async () => {
    const fetcher = vi.fn(async () => responseFor({ events: [game(), game()] }));
    const reversed = vi.fn(async () => responseFor({ events: [game({ competitions: [{ competitors: [
      { homeAway: "home", team: team("away", "Atlanta Falcons"), records: [] },
      { homeAway: "away", team: team("home", "Pittsburgh Steelers"), records: [] }
    ] }] })] }));

    await expect(lookupEspnMatchup(input, { fetcher })).resolves.toEqual({ status: "not-found" });
    await expect(lookupEspnMatchup(input, { fetcher: reversed })).resolves.toEqual({ status: "not-found" });
  });

  it("reports an unavailable ESPN upstream without leaking a partial or stale matchup", async () => {
    const fetcher = vi.fn(async () => responseFor({ message: "down" }, { status: 503 }));

    await expect(lookupEspnMatchup(input, { fetcher })).resolves.toEqual({ status: "upstream-unavailable" });
  });

  it("treats a malformed scoreboard as an ESPN failure instead of inventing a missing matchup", async () => {
    const fetcher = vi.fn(async () => responseFor({ unexpected: true }));

    await expect(lookupEspnMatchup(input, { fetcher })).resolves.toEqual({ status: "upstream-unavailable" });
  });
});

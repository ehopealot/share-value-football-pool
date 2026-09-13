export type EspnLeague = "nfl" | "ncaaf";
export type EspnMatchupInput = { league: EspnLeague; startsAt: string; awayTeam: string; homeTeam: string };
export type EspnRecentResult = { date: string; opponent: string; result: string };
export type EspnMatchupTeam = { name: string; record?: string; logo?: string; recentResults: EspnRecentResult[] };
export type EspnSeasonStat = { label: string; away?: string; home?: string };
export type EspnMatchup = { league: EspnLeague; startsAt: string; venue?: string; away: EspnMatchupTeam; home: EspnMatchupTeam; seasonStats: EspnSeasonStat[] };
export type EspnMatchupResult = { status: "ok"; matchup: EspnMatchup } | { status: "not-found" } | { status: "upstream-unavailable" };
/** The Cache API surface needed for a JSON matchup blob, easily replaced in focused unit tests. */
export type EspnMatchupCache = { match(request: Request): Promise<Response | undefined>; put(request: Request, response: Response): Promise<void> };
export type EspnMatchupDependencies = { fetcher?: typeof fetch; cache?: EspnMatchupCache; cacheScope?: string };

type JsonObject = Record<string, unknown>;
type EspnTeam = { id: string; displayName: string; logo?: string };
type EspnCompetitor = { homeAway: "home" | "away"; team: EspnTeam; record?: string; score?: string; lineScores?: Array<number | null> };
type EspnGameState = "pre" | "in" | "post";
type EspnEvent = { id: string; date: string; away: EspnCompetitor; home: EspnCompetitor; venue?: string; state?: EspnGameState; statusDetail?: string; clock?: string; period?: number; possessionSide?: "away" | "home"; downDistance?: string };

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/football";
const ESPN_TIMEOUT_MS = 4_000;
/**
 * site.api.espn.com (Akamai) rejects requests whose User-Agent is empty, browser-like, or an unknown
 * product token — including workerd's default header-less fetch — with 403. A recognized HTTP-client
 * token must come first; our product token rides after it. Verified from workerd 2026-09-12.
 */
export const ESPN_USER_AGENT = "curl/8.5.0 office-pool-reborn/1.0";
const MATCHUP_CACHE_SECONDS = 15 * 60;
const leaguePath = (league: EspnLeague) => league === "nfl" ? "nfl" : "college-football";
const asObject = (value: unknown): JsonObject | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const asText = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const asArray = (value: unknown): unknown[] | undefined => Array.isArray(value) ? value : undefined;
const normalized = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

/** Explicit historical/school aliases are deliberately narrow; there is no fuzzy team matching. */
const teamAliasGroups = [
  ["Southern California Trojans", "USC Trojans"],
  ["Connecticut Huskies", "UConn Huskies"],
  ["Central Florida Knights", "UCF Knights"],
  ["Brigham Young Cougars", "BYU Cougars"],
  ["Southern Methodist Mustangs", "SMU Mustangs"],
  ["Texas San Antonio Roadrunners", "Texas-San Antonio Roadrunners", "UTSA Roadrunners"],
  ["Texas El Paso Miners", "Texas-El Paso Miners", "UTEP Miners"],
  ["Louisiana Monroe Warhawks", "Louisiana-Monroe Warhawks", "UL Monroe Warhawks"],
  ["Massachusetts Minutemen", "UMass Minutemen"],
  ["Miami Ohio RedHawks", "Miami OH RedHawks", "Miami (OH) RedHawks"],
  ["North Carolina State Wolfpack", "NC State Wolfpack"],
  ["Pittsburgh Panthers", "Pitt Panthers"],
  ["Florida International Panthers", "FIU Panthers"],
  ["Washington Football Team", "Washington Commanders"]
] as const;
const canonicalAlias = new Map(teamAliasGroups.flatMap((group) => group.map((name) => [normalized(name), normalized(group[0])] as const)));
const canonicalTeamName = (name: string) => canonicalAlias.get(normalized(name)) ?? normalized(name);
const sameTeam = (expected: string, candidate: EspnTeam): boolean => canonicalTeamName(expected) === canonicalTeamName(candidate.displayName);
const gameDate = (startsAt: string): string | undefined => {
  const date = new Date(startsAt);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
};
/** ESPN groups late US games under the preceding local slate, so include both adjacent UTC days. */
const scoreboardDateRange = (startsAt: string): string | undefined => {
  const kickoff = new Date(startsAt);
  if (Number.isNaN(kickoff.getTime())) return undefined;
  const priorDay = new Date(kickoff.getTime() - 24 * 60 * 60 * 1000);
  return [priorDay, kickoff].map((date) => date.toISOString().slice(0, 10).replaceAll("-", "")).join("-");
};
const cacheName = (name: string) => canonicalTeamName(name).replace(/ /g, "-");

/** The cache identity includes every canonical source field that determines the ESPN game lookup. */
export const matchupCacheRequest = (input: EspnMatchupInput, scope = "shared"): Request => {
  const date = gameDate(input.startsAt) ?? "invalid-date";
  return new Request(`https://espn-matchup-cache.invalid/${encodeURIComponent(scope)}/${input.league}/${date}/${encodeURIComponent(`${cacheName(input.awayTeam)}__${cacheName(input.homeTeam)}`)}`);
};

const httpsUrl = (value: unknown): string | undefined => {
  const url = asText(value);
  if (!url) return undefined;
  try { return new URL(url).protocol === "https:" ? url : undefined; } catch { return undefined; }
};
const recordSummary = (competitor: JsonObject): string | undefined => {
  const records = asArray(competitor.records) ?? [];
  for (const entry of records) {
    const record = asObject(entry);
    if (!record) continue;
    if (record.type === "total" || record.name === "overall") return asText(record.summary);
  }
  return undefined;
};
const readCompetitor = (value: unknown): EspnCompetitor | undefined => {
  const competitor = asObject(value); const team = competitor && asObject(competitor.team);
  const homeAway = competitor && asText(competitor.homeAway); const id = team && asText(team.id); const displayName = team && asText(team.displayName); const logo = team && httpsUrl(team.logo);
  if (!competitor || !team || (homeAway !== "home" && homeAway !== "away") || !id || !displayName) return undefined;
  return { homeAway, team: { id, displayName, ...(logo ? { logo } : {}) }, ...(recordSummary(competitor) ? { record: recordSummary(competitor) } : {}) };
};

/** Returns an event only when exactly one ESPN candidate has the requested UTC date and both named sides. */
export const findEspnEvent = (scoreboard: unknown, input: EspnMatchupInput): EspnEvent | undefined => {
  const root = asObject(scoreboard); const expectedDate = gameDate(input.startsAt); const events = root && asArray(root.events);
  if (!root || !expectedDate || !events) return undefined;
  const candidates: EspnEvent[] = [];
  for (const rawEvent of events) {
    const event = asObject(rawEvent); const id = event && asText(event.id); const date = event && asText(event.date);
    const competition = event && asArray(event.competitions)?.[0]; const competitionObject = asObject(competition); const competitors = competitionObject && asArray(competitionObject.competitors);
    if (!event || !id || !date || gameDate(date) !== expectedDate || !competitionObject || !competitors || competitors.length !== 2) continue;
    const parsed = competitors.map(readCompetitor);
    if (parsed.some((competitor) => !competitor)) continue;
    const sides = parsed as EspnCompetitor[];
    const away = sides.find((competitor) => competitor.homeAway === "away"); const home = sides.find((competitor) => competitor.homeAway === "home");
    if (!away || !home || !sameTeam(input.awayTeam, away.team) || !sameTeam(input.homeTeam, home.team)) continue;
    const venue = asObject(competitionObject.venue); const address = venue && asObject(venue.address);
    const venueParts = [venue && asText(venue.fullName), address && asText(address.city), address && asText(address.state)].filter((part): part is string => Boolean(part));
    const statusObject = asObject(event.status); const statusType = statusObject && asObject(statusObject.type);
    const state = asText(statusType?.state);
    const lineScores = (competitor: EspnCompetitor): Array<number | null> | undefined => {
      const rawCompetitor = asObject(competitors.find((entry) => asObject(entry)?.homeAway === competitor.homeAway));
      const raw = asArray(rawCompetitor?.linescores);
      if (!raw) return undefined;
      const scores = raw.map((entry) => { const value = asObject(entry)?.value; return typeof value === "number" ? value : null; });
      return scores.length ? scores : undefined;
    };
    const rawScores = (homeAway: "home" | "away"): { score?: string; lineScores?: Array<number | null> } => {
      const competitor = sides.find((side) => side.homeAway === homeAway);
      const rawCompetitor = asObject(competitors.find((entry) => asObject(entry)?.homeAway === homeAway));
      return { score: asText(rawCompetitor?.score), lineScores: competitor ? lineScores(competitor) : undefined };
    };
    const awayRaw = rawScores("away"); const homeRaw = rawScores("home");
    const situation = asObject(competitionObject.situation);
    const possessionId = asText(situation?.possession); const downDistance = asText(situation?.downDistanceText);
    candidates.push({
      id, date, away: { ...away, ...(awayRaw.score ? { score: awayRaw.score } : {}), ...(awayRaw.lineScores ? { lineScores: awayRaw.lineScores } : {}) }, home: { ...home, ...(homeRaw.score ? { score: homeRaw.score } : {}), ...(homeRaw.lineScores ? { lineScores: homeRaw.lineScores } : {}) },
      ...(venueParts.length ? { venue: venueParts.length > 1 ? `${venueParts[0]} · ${venueParts.slice(1).join(", ")}` : venueParts[0] } : {}),
      ...(state === "pre" || state === "in" || state === "post" ? { state } : {}),
      ...(asText(statusType?.shortDetail) ? { statusDetail: asText(statusType?.shortDetail) } : {}),
      ...(state === "in" && asText(statusObject?.displayClock) ? { clock: asText(statusObject?.displayClock) } : {}),
      ...(possessionId === away.team.id || possessionId === home.team.id ? { possessionSide: possessionId === away.team.id ? "away" as const : "home" as const } : {}),
      ...(downDistance ? { downDistance } : {}),
      ...(state === "in" && typeof asObject(statusObject?.period)?.number === "number" ? { period: asObject(statusObject?.period)!.number as number } : {})
    });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
};

const responseJson = async (fetcher: typeof fetch, url: string): Promise<unknown | undefined> => {
  try {
    const response = await fetcher(url, { headers: { accept: "application/json", "user-agent": ESPN_USER_AGENT }, signal: AbortSignal.timeout(ESPN_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    return await response.json();
  } catch { return undefined; }
};
const displayStat = (stat: JsonObject, perGame = false): string | undefined => perGame ? asText(stat.perGameDisplayValue) ?? asText(stat.displayValue) : asText(stat.displayValue);
const findStatObject = (payload: unknown, name: string, category?: string): JsonObject | undefined => {
  const root = asObject(payload); const results = root && asObject(root.results); const stats = results && asObject(results.stats); const categories = stats && asArray(stats.categories);
  if (!categories) return undefined;
  for (const rawCategory of categories) {
    const current = asObject(rawCategory);
    if (!current || (category && current.name !== category)) continue;
    for (const rawStat of asArray(current.stats) ?? []) {
      const stat = asObject(rawStat);
      if (stat?.name === name) return stat;
    }
  }
  return undefined;
};
const findStat = (payload: unknown, name: string, category?: string, perGame = false): string | undefined => {
  const stat = findStatObject(payload, name, category);
  return stat ? displayStat(stat, perGame) : undefined;
};
const numericStat = (value: string | undefined): number | undefined => {
  const text = asText(value);
  if (!text) return undefined;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
};
/** The NFL carries perGameDisplayValue; FBS/FCS payloads carry only totals, so derive those from games played. */
const perGameStat = (payload: unknown, name: string, category: string, gamesPlayed: number | undefined): string | undefined => {
  const direct = asText(findStatObject(payload, name, category)?.perGameDisplayValue);
  if (direct) return direct;
  const total = numericStat(asText(findStatObject(payload, name, category)?.displayValue));
  if (total === undefined || !gamesPlayed) return undefined;
  return String(Math.round(total / gamesPlayed));
};
const gamesPlayedOf = (payload: unknown): number | undefined => numericStat(asText(findStatObject(payload, "gamesPlayed", "general")?.displayValue));
const teamSeasonStats = (payload: unknown): Record<string, string | undefined> => {
  const games = gamesPlayedOf(payload);
  return {
    "Yards/game": perGameStat(payload, "totalYards", "rushing", games),
    "Passing yards/game": perGameStat(payload, "passingYards", "passing", games),
    "Rushing yards/game": perGameStat(payload, "rushingYards", "rushing", games),
    Touchdowns: findStat(payload, "totalTouchdowns", "scoring"),
    "Defensive sacks": findStat(payload, "sacks", "defensive")
  };
};
const scheduleResults = (payload: unknown, teamId: string, before: string): EspnRecentResult[] => {
  const root = asObject(payload); const events = root && asArray(root.events);
  if (!events) return [];
  const results: EspnRecentResult[] = [];
  const scoreText = (competitor: JsonObject | undefined): string | undefined => asText(competitor?.score) ?? asText(asObject(competitor?.score)?.displayValue);
  for (const rawEvent of events) {
    const event = asObject(rawEvent); const date = event && asText(event.date);
    const competition = event && asArray(event.competitions)?.[0]; const competitionObject = asObject(competition); const competitors = competitionObject && asArray(competitionObject.competitors);
    /** Current-season schedules carry a top-level status; `?season=` history payloads only carry it on the competition. */
    const statusSource = asObject(event?.status) ?? (competitionObject ? asObject(competitionObject.status) : undefined);
    const statusType = statusSource && asObject(statusSource.type);
    if (!event || !date || date >= before || statusType?.completed !== true || !competitors) continue;
    const own = competitors.map(asObject).find((competitor) => asObject(competitor?.team)?.id === teamId);
    const opponent = competitors.map(asObject).find((competitor) => competitor !== own);
    const ownTeam = own && asObject(own.team); const opponentTeam = opponent && asObject(opponent.team);
    const ownScore = scoreText(own); const opponentScore = scoreText(opponent); const opponentName = opponentTeam && asText(opponentTeam.displayName);
    if (!own || !ownTeam || !opponent || !opponentName || !ownScore || !opponentScore || typeof own.winner !== "boolean") continue;
    results.push({ date, opponent: opponentName, result: `${own.winner ? "W" : "L"} ${ownScore}-${opponentScore}` });
  }
  return results.sort((left, right) => right.date.localeCompare(left.date)).slice(0, 3);
};
const cachedRecentResults = (value: unknown): EspnRecentResult[] | undefined => {
  const results = asArray(value);
  if (!results || results.length > 3) return undefined;
  const parsed: EspnRecentResult[] = [];
  for (const value of results) {
    const result = asObject(value); const date = result && asText(result.date); const opponent = result && asText(result.opponent); const summary = result && asText(result.result);
    if (!date || Number.isNaN(new Date(date).getTime()) || !opponent || !summary) return undefined;
    parsed.push({ date, opponent, result: summary });
  }
  return parsed;
};
const cachedTeam = (value: unknown): EspnMatchupTeam | undefined => {
  const team = asObject(value); const name = team && asText(team.name); const recentResults = team && cachedRecentResults(team.recentResults);
  if (!team || !name || !recentResults) return undefined;
  const record = asText(team.record); const logo = httpsUrl(team.logo);
  if (team.record !== undefined && !record) return undefined;
  if (team.logo !== undefined && !logo) return undefined;
  return { name, ...(record ? { record } : {}), ...(logo ? { logo } : {}), recentResults };
};
const cachedMatchup = (value: unknown): EspnMatchup | undefined => {
  const root = asObject(value); const matchup = root && asObject(root.matchup); const away = matchup && cachedTeam(matchup.away); const home = matchup && cachedTeam(matchup.home);
  const league = matchup?.league; const startsAt = matchup && asText(matchup.startsAt); const venue = matchup && asText(matchup.venue); const seasonStats = matchup && asArray(matchup.seasonStats);
  if (!matchup || !away || !home || (league !== "nfl" && league !== "ncaaf") || !startsAt || Number.isNaN(new Date(startsAt).getTime()) || (matchup.venue !== undefined && !venue) || !seasonStats || seasonStats.length > 5) return undefined;
  const parsedStats: EspnSeasonStat[] = [];
  for (const value of seasonStats) {
    const stat = asObject(value); const label = stat && asText(stat.label); const awayValue = stat && asText(stat.away); const homeValue = stat && asText(stat.home);
    if (!stat || !label || (!awayValue && !homeValue) || (stat.away !== undefined && !awayValue) || (stat.home !== undefined && !homeValue)) return undefined;
    parsedStats.push({ label, ...(awayValue ? { away: awayValue } : {}), ...(homeValue ? { home: homeValue } : {}) });
  }
  return { league, startsAt, ...(venue ? { venue } : {}), away, home, seasonStats: parsedStats };
};
const readCache = async (cache: EspnMatchupCache | undefined, key: Request): Promise<EspnMatchup | undefined> => {
  try {
    const response = await cache?.match(key);
    return response ? cachedMatchup(await response.json()) : undefined;
  } catch { return undefined; }
};
const writeCache = async (cache: EspnMatchupCache | undefined, key: Request, matchup: EspnMatchup): Promise<void> => {
  if (!cache) return;
  try { await cache.put(key, Response.json({ matchup }, { headers: { "cache-control": `public, max-age=${MATCHUP_CACHE_SECONDS}` } })); } catch { /* Cache failure must not fail a details read. */ }
};

/** Fetches ESPN only from the Worker, returning no matchup whenever the scoreboard identity is uncertain. */
export async function lookupEspnMatchup(input: EspnMatchupInput, dependencies: EspnMatchupDependencies = {}): Promise<EspnMatchupResult> {
  const key = matchupCacheRequest(input, dependencies.cacheScope); const fromCache = await readCache(dependencies.cache, key);
  if (fromCache) return { status: "ok", matchup: fromCache };
  const fetcher = dependencies.fetcher ?? fetch;
  const date = gameDate(input.startsAt); const dates = scoreboardDateRange(input.startsAt);
  if (!date || !dates) return { status: "not-found" };
  const scoreboard = await responseJson(fetcher, `${ESPN_BASE}/${leaguePath(input.league)}/scoreboard?dates=${dates}`);
  if (!scoreboard || !asArray(asObject(scoreboard)?.events)) return { status: "upstream-unavailable" };
  const event = findEspnEvent(scoreboard, input);
  if (!event) return { status: "not-found" };
  const base = `${ESPN_BASE}/${leaguePath(input.league)}/teams`;
  const seasonYear = new Date(input.startsAt).getUTCFullYear();
  const [awayStats, homeStats, awaySchedule, homeSchedule] = await Promise.all([
    responseJson(fetcher, `${base}/${encodeURIComponent(event.away.team.id)}/statistics?season=${seasonYear}`),
    responseJson(fetcher, `${base}/${encodeURIComponent(event.home.team.id)}/statistics?season=${seasonYear}`),
    responseJson(fetcher, `${base}/${encodeURIComponent(event.away.team.id)}/schedule`),
    responseJson(fetcher, `${base}/${encodeURIComponent(event.home.team.id)}/schedule`)
  ]);
  const away = teamSeasonStats(awayStats); const home = teamSeasonStats(homeStats);
  const seasonStats = Object.keys(away).map((label) => ({ label, ...(away[label] ? { away: away[label] } : {}), ...(home[label] ? { home: home[label] } : {}) })).filter((stat) => stat.away || stat.home);
  const matchup: EspnMatchup = {
    league: input.league, startsAt: input.startsAt, ...(event.venue ? { venue: event.venue } : {}),
    away: { name: event.away.team.displayName, ...(event.away.record ? { record: event.away.record } : {}), ...(event.away.team.logo ? { logo: event.away.team.logo } : {}), recentResults: scheduleResults(awaySchedule, event.away.team.id, input.startsAt) },
    home: { name: event.home.team.displayName, ...(event.home.record ? { record: event.home.record } : {}), ...(event.home.team.logo ? { logo: event.home.team.logo } : {}), recentResults: scheduleResults(homeSchedule, event.home.team.id, input.startsAt) },
    seasonStats
  };
  // Keep the score/record view available during a partial ESPN outage, but retry it rather than caching an empty details page.
  if (awayStats || homeStats || awaySchedule || homeSchedule) await writeCache(dependencies.cache, key, matchup);
  return { status: "ok", matchup };
}

export type EspnBoxQuarter = { label: string; away?: string; home?: string };
export type EspnBoxTeam = { name: string; logo?: string; score?: string };
export type EspnScoringPlay = { id: string; quarter: string; clock: string; team: string; text: string; away: string; home: string };
export type EspnBoxScore = { state: "pregame" | "live" | "final"; startsAt: string; away: EspnBoxTeam; home: EspnBoxTeam; statusDetail: string; clock?: string; period?: number; possession?: "away" | "home"; downDistance?: string; quarters: EspnBoxQuarter[]; scoringPlays: EspnScoringPlay[]; stats: EspnSeasonStat[] };
export type EspnBoxScoreResult = { status: "ok"; box: EspnBoxScore } | { status: "not-found" } | { status: "upstream-unavailable" };
/** Live game state may lag kickoff by up to this long; box reads trade freshness for upstream protection. */
const BOX_CACHE_SECONDS = 60;
const BOX_STAT_LABELS = ["1st Downs", "3rd down efficiency", "4th down efficiency", "Total Plays", "Total Yards", "Yards per Play", "Passing", "Comp/Att", "Interceptions thrown", "Sacks-Yards Lost", "Rushing", "Yards per rush", "Red Zone (Made-Att)", "Penalties", "Turnovers", "Fumbles lost", "Possession"] as const;
const quarterLabel = (period: number): string => period <= 4 ? `Q${period}` : period === 5 ? "OT" : `${period - 4}OT`;
export const boxCacheRequest = (input: EspnMatchupInput, scope = "shared"): Request => {
  const date = gameDate(input.startsAt) ?? "invalid-date";
  return new Request(`https://espn-box-cache.invalid/${encodeURIComponent(scope)}/${input.league}/${date}/${encodeURIComponent(`${cacheName(input.awayTeam)}__${cacheName(input.homeTeam)}`)}`);
};
/** Final-game team stats come from the summary payload's labeled boxscore statistics. */
const summaryStats = (payload: unknown): EspnSeasonStat[] => {
  const boxscore = asObject(asObject(payload)?.boxscore); const teams = boxscore && asArray(boxscore.teams);
  if (!teams) return [];
  const valuesFor = (homeAway: "away" | "home") => {
    const raw = asObject(teams.find((team) => asObject(team)?.homeAway === homeAway)); const statistics = raw && asArray(raw.statistics);
    const byLabel = new Map<string, string>();
    for (const entry of statistics ?? []) {
      const stat = asObject(entry); const label = asText(stat?.label) ?? asText(stat?.displayName); const value = asText(stat?.displayValue);
      if (label && value) byLabel.set(label, value);
    }
    return byLabel;
  };
  const away = valuesFor("away"); const home = valuesFor("home");
  return BOX_STAT_LABELS.flatMap((label) => {
    const awayValue = away.get(label); const homeValue = home.get(label);
    return awayValue || homeValue ? [{ label, ...(awayValue ? { away: awayValue } : {}), ...(homeValue ? { home: homeValue } : {}) }] : [];
  });
};
/** Scoring plays come from the same summary payload that supplies team stats; scores are the running totals after each play. */
const scoringPlaysOf = (payload: unknown): EspnScoringPlay[] => {
  const plays = asArray(asObject(payload)?.scoringPlays) ?? [];
  const parsed: EspnScoringPlay[] = [];
  for (const raw of plays.slice(0, 40)) {
    const play = asObject(raw);
    const id = play && asText(play.id); const period = asObject(play?.period); const clock = play && asText(play.clock);
    const team = play && asText(play.team); const text = play && asText(play.text);
    const awayScore = play?.awayScore; const homeScore = play?.homeScore;
    if (!play || !id || !clock || !team || !text || typeof period?.number !== "number" || typeof awayScore !== "number" || typeof homeScore !== "number") continue;
    parsed.push({ id, quarter: quarterLabel(period.number), clock, team, text, away: String(awayScore), home: String(homeScore) });
  }
  return parsed;
};
const cachedBoxScore = (value: unknown): EspnBoxScore | undefined => {
  const box = asObject(value); const away = box && asObject(box.away); const home = box && asObject(box.home);
  const state = box?.state; const startsAt = box && asText(box.startsAt); const statusDetail = box && asText(box.statusDetail);
  const quarters = box && asArray(box.quarters); const stats = box && asArray(box.stats); const scoringPlays = box && asArray(box.scoringPlays);
  const clock = box && asText(box.clock); const period = typeof box?.period === "number" ? box.period : undefined;
  const possession = box?.possession; const downDistance = box && asText(box.downDistance);
  if ((possession !== undefined && possession !== "away" && possession !== "home") || (box?.downDistance !== undefined && !downDistance)) return undefined;
  if (!box || !away || !home || (state !== "pregame" && state !== "live" && state !== "final") || !asText(away.name) || !asText(home.name) || !startsAt || Number.isNaN(new Date(startsAt).getTime()) || !statusDetail || !quarters || quarters.length > 10 || !scoringPlays || scoringPlays.length > 40 || !stats || stats.length > BOX_STAT_LABELS.length) return undefined;
  return { state, startsAt, statusDetail, ...(clock ? { clock } : {}), ...(period !== undefined ? { period } : {}), ...(possession === "away" || possession === "home" ? { possession } : {}), ...(downDistance ? { downDistance } : {}), away: { name: asText(away.name)!, ...(asText(away.score) ? { score: asText(away.score)! } : {}) }, home: { name: asText(home.name)!, ...(asText(home.score) ? { score: asText(home.score)! } : {}) }, quarters: quarters.flatMap((quarter) => {
      const object = asObject(quarter); const label = object && asText(object.label); const away = object && asText(object.away); const home = object && asText(object.home);
      return label ? [{ label, ...(away ? { away } : {}), ...(home ? { home } : {}) }] : [];
    }), scoringPlays: scoringPlays.flatMap((play) => {
      const object = asObject(play); const id = object && asText(object.id); const quarter = object && asText(object.quarter); const clock = object && asText(object.clock);
      const team = object && asText(object.team); const text = object && asText(object.text); const awayScore = object && asText(object.away); const homeScore = object && asText(object.home);
      return id && quarter && clock && team && text && awayScore !== undefined && homeScore !== undefined ? [{ id, quarter, clock, team, text, away: awayScore, home: homeScore }] : [];
    }), stats: stats.flatMap((stat) => {
      const object = asObject(stat); const label = object && asText(object.label); const away = object && asText(object.away); const home = object && asText(object.home);
      return label && (away || home) ? [{ label, ...(away ? { away } : {}), ...(home ? { home } : {}) }] : [];
    }) };
};

/** Box state comes from the scoreboard payload; final games add summary stats. Cached for one minute. */
export async function lookupEspnBoxScore(input: EspnMatchupInput, dependencies: EspnMatchupDependencies = {}): Promise<EspnBoxScoreResult> {
  const key = boxCacheRequest(input, dependencies.cacheScope);
  try {
    const cached = await dependencies.cache?.match(key);
    const parsed = cached ? cachedBoxScore(await cached.json()) : undefined;
    if (parsed) return { status: "ok", box: parsed };
  } catch { /* Cache failures must not fail a box read. */ }
  const fetcher = dependencies.fetcher ?? fetch;
  const dates = scoreboardDateRange(input.startsAt);
  if (!dates) return { status: "not-found" };
  const scoreboard = await responseJson(fetcher, `${ESPN_BASE}/${leaguePath(input.league)}/scoreboard?dates=${dates}`);
  if (!scoreboard || !asArray(asObject(scoreboard)?.events)) return { status: "upstream-unavailable" };
  const event = findEspnEvent(scoreboard, input);
  if (!event) return { status: "not-found" };
  const state = event.state === "in" ? "live" : event.state === "post" ? "final" : "pregame";
  /** The quarter grid always shows Q1-Q4; unplayed quarters stay blank rather than absent or zero. */
  const periods = state === "pregame" ? Math.max(event.away.lineScores?.length ?? 0, event.home.lineScores?.length ?? 0) : Math.max(4, event.away.lineScores?.length ?? 0, event.home.lineScores?.length ?? 0);
  const quarters: EspnBoxQuarter[] = Array.from({ length: periods }, (_, index) => {
    const awayValue = event.away.lineScores?.[index]; const homeValue = event.home.lineScores?.[index];
    return { label: quarterLabel(index + 1), ...(typeof awayValue === "number" ? { away: String(awayValue) } : {}), ...(typeof homeValue === "number" ? { home: String(homeValue) } : {}) };
  });
  const summary = state !== "pregame" ? await responseJson(fetcher, `${ESPN_BASE}/${leaguePath(input.league)}/summary?event=${encodeURIComponent(event.id)}`) : undefined;
  const stats = summary ? summaryStats(summary) : [];
  const scoringPlays = summary ? scoringPlaysOf(summary) : [];
  const box: EspnBoxScore = {
    state, startsAt: input.startsAt,
    away: { name: event.away.team.displayName, ...(event.away.team.logo ? { logo: event.away.team.logo } : {}), ...(event.away.score ? { score: event.away.score } : {}) },
    home: { name: event.home.team.displayName, ...(event.home.team.logo ? { logo: event.home.team.logo } : {}), ...(event.home.score ? { score: event.home.score } : {}) },
    statusDetail: event.statusDetail ?? (state === "final" ? "Final" : state === "live" ? "In progress" : "Pregame"),
    ...(state === "live" && event.clock ? { clock: event.clock } : {}), ...(state === "live" && event.period ? { period: event.period } : {}),
    ...(state === "live" && event.possessionSide ? { possession: event.possessionSide } : {}), ...(state === "live" && event.downDistance ? { downDistance: event.downDistance } : {}),
    quarters, scoringPlays, stats
  };
  try { await dependencies.cache?.put(key, Response.json(box, { headers: { "cache-control": `public, max-age=${BOX_CACHE_SECONDS}` } })); } catch { /* Cache failure must not fail a box read. */ }
  return { status: "ok", box };
}

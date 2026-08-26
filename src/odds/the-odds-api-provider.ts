import { theOddsApiOddsResponse, theOddsApiScoresResponse } from "../contracts/provider";
import type { EventStatus, League, OddsProvider, ProviderBook, ProviderEvent, ProviderMarket, ProviderOutcome, ProviderPoll } from "./types";

const sportKey: Record<League, string> = { nfl: "americanfootball_nfl", ncaaf: "americanfootball_ncaaf" };
type ApiEvent = ReturnType<typeof theOddsApiOddsResponse.parse>[number];
type ApiScoreEvent = ReturnType<typeof theOddsApiScoresResponse.parse>[number];
const market = (value: ApiEvent["bookmakers"] extends infer _ ? { key: "spreads" | "totals" | "h2h"; outcomes: Array<{ name: string; price: number; point?: number }> } : never): ProviderMarket => ({
  key: value.key === "spreads" ? "spread" : value.key === "totals" ? "total" : "moneyline",
  outcomes: value.outcomes.map((outcome): ProviderOutcome => ({ name: outcome.name, price: outcome.price, ...(outcome.point === undefined ? {} : { point: outcome.point }) }))
});
const status = (score: ApiScoreEvent | undefined, commenceTime: string, now: Date): EventStatus | undefined => {
  if (!score) return undefined;
  if (score.completed) return "final";
  // A score response is evidence that the provider is tracking this event; after
  // kickoff its non-completed, nullable scores represent a started non-final game.
  return new Date(commenceTime).getTime() <= now.getTime() ? "in_progress" : "scheduled";
};
const quota = (response: Response) => {
  const integer = (name: string) => { const value = response.headers.get(name); return value !== null && /^\d+$/.test(value) ? Number(value) : undefined; };
  const remaining = integer("x-requests-remaining"); const used = integer("x-requests-used");
  return remaining === undefined && used === undefined ? undefined : { ...(remaining === undefined ? {} : { remaining }), ...(used === undefined ? {} : { used }) };
};

/** Documented The Odds API adapter. It validates external JSON before normalization. */
export class TheOddsApiProvider implements OddsProvider {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch, private readonly now: () => Date = () => new Date()) {}
  async events(league: League): Promise<ProviderPoll> {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey[league]}`;
    const oddsResponse = await this.fetcher(`${url}/odds/?apiKey=${encodeURIComponent(this.apiKey)}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`);
    if (!oddsResponse.ok) throw new Error(`Odds provider request failed (${oddsResponse.status})`);
    const scoreResponse = await this.fetcher(`${url}/scores/?apiKey=${encodeURIComponent(this.apiKey)}&daysFrom=3`);
    if (!scoreResponse.ok) throw new Error(`Odds score request failed (${scoreResponse.status})`);
    const odds = theOddsApiOddsResponse.parse(await oddsResponse.json());
    const scores = theOddsApiScoresResponse.parse(await scoreResponse.json());
    assertUniqueRawIds(odds, "odds");
    assertUniqueRawIds(scores, "score");
    scores.forEach(assertUnambiguousScoreTeams);
    const scoreById = new Map(scores.map((event) => [event.id, event]));
    const oddsById = new Map(odds.map((event) => [event.id, event]));
    const events = [...new Set([...oddsById.keys(), ...scoreById.keys()])].map((id): ProviderEvent => {
      const quote = oddsById.get(id); const scoreEvent = scoreById.get(id); const base = quote ?? scoreEvent!;
      const homeTeam = scoreEvent?.home_team ?? quote?.home_team ?? base.home_team;
      const awayTeam = scoreEvent?.away_team ?? quote?.away_team ?? base.away_team;
      const homeScore = scoreEvent?.scores?.find((item) => teamIdentity(item.name) === teamIdentity(homeTeam))?.score;
      const awayScore = scoreEvent?.scores?.find((item) => teamIdentity(item.name) === teamIdentity(awayTeam))?.score;
      const commenceTime = scoreEvent?.commence_time ?? quote?.commence_time ?? base.commence_time;
      const eventStatus = status(scoreEvent, commenceTime, this.now());
      return {
        id, sport: league, commenceTime, homeTeam, awayTeam,
        ...(eventStatus === undefined ? {} : { status: eventStatus }),
        ...(homeScore === undefined || homeScore === null ? {} : { homeScore: Number(homeScore) }),
        ...(awayScore === undefined || awayScore === null ? {} : { awayScore: Number(awayScore) }),
        ...(scoreEvent?.postseason ?? quote?.postseason) === undefined ? {} : { postseason: scoreEvent?.postseason ?? quote?.postseason },
        ...(scoreEvent?.title ?? quote?.title) === undefined ? {} : { eventName: scoreEvent?.title ?? quote?.title },
        bookmakers: (quote?.bookmakers ?? []).map((book): ProviderBook => ({ key: book.key, title: book.title, markets: book.markets.map(market) }))
      };
    });
    return { events, quota: quota(scoreResponse) ?? quota(oddsResponse) };
  }
}

const assertUniqueRawIds = (events: Array<{ id: string }>, container: "odds" | "score"): void => {
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.id)) throw new Error(`Duplicate raw ${container} event ID: ${event.id}`);
    ids.add(event.id);
  }
};

// The scores endpoint and event container use the same case-insensitive,
// whitespace-insensitive team identity for matching.
const teamIdentity = (name: string): string => name.trim().toLocaleLowerCase("en-US");
const assertUnambiguousScoreTeams = (event: ApiScoreEvent): void => {
  if (!event.scores) return;
  const home = teamIdentity(event.home_team); const away = teamIdentity(event.away_team);
  if (home === away) throw new Error(`Ambiguous raw score event teams: ${event.id}`);
  const identities = new Set<string>();
  for (const item of event.scores) {
    const identity = teamIdentity(item.name);
    if (identities.has(identity)) throw new Error(`Duplicate raw score team identity: ${identity}`);
    identities.add(identity);
    const matches = Number(identity === home) + Number(identity === away);
    if (matches !== 1) throw new Error(`Ambiguous raw score team identity: ${identity}`);
  }
};

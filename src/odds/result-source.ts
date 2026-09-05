export interface FinalResultVersion {
  eventId: string; league: "nfl" | "ncaaf"; status: "final" | "cancelled" | "no_contest";
  homeScore: number | null; awayScore: number | null; correctionVersion: string;
  eventName?: string | null; postseason?: boolean;
}

/** Read-only D1 query boundary. PoolDO retains all season authority; D1 supplies provider evidence only. */
export interface ResultSource { getFinalResults(eventIds: readonly string[]): Promise<FinalResultVersion[]>; getScheduledSuperBowls?(): Promise<Array<{ eventId: string; eventName: string; startsAt: string }>>; }

type ScheduledSuperBowlRow = { provider_event_id: string; event_name: string; starts_at: string };
type FinalResultRow = {
  provider_event_id: string;
  league: string;
  status: string;
  home_score: string | null;
  away_score: string | null;
  correction_version: string;
  event_name: string | null;
  postseason: number;
};

export class D1ResultSource implements ResultSource {
  constructor(private readonly db: D1Database) {}
  async getScheduledSuperBowls(): Promise<Array<{ eventId: string; eventName: string; startsAt: string }>> {
    const result = await this.db.prepare("SELECT provider_event_id, event_name, starts_at FROM sports_event WHERE league = 'nfl' AND postseason = 1 AND event_name LIKE '%Super Bowl%' AND status IN ('scheduled','in_progress') ORDER BY starts_at, provider_event_id").all<ScheduledSuperBowlRow>();
    return result.results.map((row) => ({ eventId: row.provider_event_id, eventName: row.event_name, startsAt: row.starts_at }));
  }
  async getFinalResults(eventIds: readonly string[]): Promise<FinalResultVersion[]> {
    if (eventIds.length === 0) return [];
    const placeholders = eventIds.map(() => "?").join(",");
    const result = await this.db.prepare(`SELECT provider_event_id, league, status, home_score, away_score, correction_version, event_name, postseason FROM sports_event WHERE provider_event_id IN (${placeholders}) AND status IN ('final','cancelled','no_contest')`).bind(...eventIds).all<FinalResultRow>();
    return result.results.map((row) => ({
      eventId: String(row.provider_event_id), league: row.league === "ncaaf" ? "ncaaf" : "nfl", status: row.status as FinalResultVersion["status"],
      homeScore: row.home_score === null ? null : Number(row.home_score), awayScore: row.away_score === null ? null : Number(row.away_score), correctionVersion: String(row.correction_version), eventName: row.event_name, postseason: Number(row.postseason) === 1
    }));
  }
}

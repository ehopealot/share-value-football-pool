export interface FinalResultVersion {
  eventId: string; league: "nfl" | "ncaaf"; status: "final" | "cancelled" | "no_contest";
  homeScore: number | null; awayScore: number | null; correctionVersion: string;
  eventName?: string | null; postseason?: boolean;
}

/** D1-only timing proves that a scheduled provider refresh preceded a PoolDO checkpoint. */
export interface FinalResultObservation extends FinalResultVersion {
  providerRefresh?: { finalizedAt: string | null; lastPolledAt: string | null };
}

/** Read-only D1 query boundary. PoolDO retains all season authority; D1 supplies provider evidence only. */
export interface ResultSource { getFinalResults(eventIds: readonly string[]): Promise<FinalResultObservation[]>; getScheduledSuperBowls?(): Promise<Array<{ eventId: string; eventName: string; startsAt: string }>>; }

export class D1ResultSource implements ResultSource {
  constructor(private readonly db: D1Database) {}
  async getScheduledSuperBowls(): Promise<Array<{ eventId: string; eventName: string; startsAt: string }>> {
    const result = await this.db.prepare("SELECT provider_event_id, event_name, starts_at FROM sports_event WHERE league = 'nfl' AND postseason = 1 AND event_name LIKE '%Super Bowl%' AND status IN ('scheduled','in_progress') ORDER BY starts_at, provider_event_id").all<{ provider_event_id: string; event_name: string | null; starts_at: string }>();
    return result.results.map((row) => ({ eventId: row.provider_event_id, eventName: row.event_name ?? "Super Bowl", startsAt: row.starts_at }));
  }
  async getFinalResults(eventIds: readonly string[]): Promise<FinalResultObservation[]> {
    if (eventIds.length === 0) return [];
    const placeholders = eventIds.map(() => "?").join(",");
    const result = await this.db.prepare(`SELECT provider_event_id, league, status, home_score, away_score, correction_version, finalized_at, last_polled_at, event_name, postseason FROM sports_event WHERE provider_event_id IN (${placeholders}) AND status IN ('final','cancelled','no_contest')`).bind(...eventIds).all<Record<string, string | null>>();
    return result.results.map((row) => ({
      eventId: String(row.provider_event_id), league: row.league === "ncaaf" ? "ncaaf" : "nfl", status: row.status as FinalResultVersion["status"],
      homeScore: row.home_score === null ? null : Number(row.home_score), awayScore: row.away_score === null ? null : Number(row.away_score), correctionVersion: String(row.correction_version), eventName: row.event_name, postseason: Number(row.postseason) === 1,
      providerRefresh: { finalizedAt: row.finalized_at, lastPolledAt: row.last_polled_at }
    }));
  }
}

import { ZodError } from "zod";
import { providerEventSnapshot } from "../contracts/provider";
import { canonicalize } from "./canonicalize";
import type { Clock } from "../platform/clock";
import { systemClock } from "../platform/clock";
import type { EventStatus, League, ProviderEvent, ProviderPoll } from "./types";

export interface IngestionProvider { events(league: League): Promise<ProviderPoll>; }
const HOUR = 60 * 60 * 1000;
const DISCOVERY_INTERVAL = 6 * HOUR;
const terminal = (status: EventStatus) => status === "final" || status === "cancelled" || status === "no_contest";

export function pollInterval(event: ProviderEvent, now: Date): number {
  const status: EventStatus = event.status ?? "scheduled";
  if (terminal(status)) return 15 * 60 * 1000;
  if (status === "in_progress" || now.getTime() >= new Date(event.commenceTime).getTime()) return 2 * 60 * 1000;
  const untilStart = new Date(event.commenceTime).getTime() - now.getTime();
  if (untilStart > 24 * HOUR) return 6 * HOUR;
  if (untilStart > HOUR) return 30 * 60 * 1000;
  return 5 * 60 * 1000;
}
export function finalReconciliationDue(finalizedAt: Date, lastPollAt: Date | undefined, now: Date): boolean {
  return [15 * 60 * 1000, 24 * HOUR].some((delay) => { const target = new Date(finalizedAt.getTime() + delay); return target <= now && (!lastPollAt || lastPollAt < target); });
}
export function shouldPollEvent(event: ProviderEvent, lastPollAt: Date | undefined, now: Date, quotaBackoffMs = 0, finalizedAt?: Date): boolean {
  if (terminal(event.status ?? "scheduled") && finalizedAt) {
    return finalReconciliationDue(finalizedAt, lastPollAt, now) && (!lastPollAt || now.getTime() - lastPollAt.getTime() >= quotaBackoffMs);
  }
  return !lastPollAt || now.getTime() - lastPollAt.getTime() >= Math.max(pollInterval(event, now), quotaBackoffMs);
}
export function offerIsStale(retrievedAt: string, event: Pick<ProviderEvent, "commenceTime" | "status">, now: Date): boolean {
  return now.getTime() - new Date(retrievedAt).getTime() > pollInterval({ id: "", sport: "nfl", commenceTime: event.commenceTime, homeTeam: "", awayTeam: "", status: event.status, bookmakers: [] }, now);
}

type EventScheduleRow = { provider_event_id: string; league: League; starts_at: string; status: EventStatus; last_polled_at: string | null; finalized_at: string | null };
type LeaguePollRow = { last_discovery_at: string | null };
type ExistingEventRow = { provider_event_id: string; status: EventStatus; home_score: string | null; away_score: string | null; correction_version: string; finalized_at: string | null };
type ClaimedIngestion = { poll_generation: number; last_polled_at: string | null; last_success_at: string | null; canonical_book_availability_json: string; quota_json: string | null };
const score = (value: number | undefined): string | null => value === undefined ? null : String(value);
const quotaBackoff = (poll: ProviderPoll) => poll.quota?.remaining !== undefined && poll.quota.remaining <= 1 ? DISCOVERY_INTERVAL : 0;

/** D1 is written before any later durable settlement reader can inspect result versions. */
export class OddsIngestion {
  constructor(
    private readonly db: D1Database,
    private readonly provider: IngestionProvider,
    private readonly clock: Clock = systemClock,
    private readonly beforeClaim: () => Promise<void> = async () => undefined
  ) {}
  async poll(): Promise<{ events: number; offers: number }> {
    const now = this.clock.now();
    // The preflight avoids generation and health mutation when no request is due. Its
    // snapshot is never used after the atomic claim.
    const preflight = await this.db.prepare("SELECT quota_json FROM odds_ingestion WHERE provider = 'odds'").first<{ quota_json: string | null }>();
    const preflightBackoff = backoffFrom(preflight?.quota_json);
    const preflightDue = await this.dueLeagues(now, preflightBackoff);
    if (preflightDue.length === 0) return { events: 0, offers: 0 };

    await this.beforeClaim();
    const claimed = await this.claimGeneration();
    const generation = claimed.poll_generation;
    // A custom/backward clock must never regress persisted provider, event, offer,
    // league, or success times. Only the atomic post-claim row supplies the floor.
    const at = [now.toISOString(), claimed.last_polled_at, claimed.last_success_at]
      .filter((value): value is string => value !== null)
      .reduce((latest, value) => value > latest ? value : latest);
    const dueLeagues = await this.dueLeagues(now, backoffFrom(claimed.quota_json));
    if (dueLeagues.length === 0) return { events: 0, offers: 0 }; // preserve feed health and availability exactly
    try {
      const fetched = await Promise.all(dueLeagues.map(async ({ league }) => ({ league, poll: await this.provider.events(league) })));
      // Validate every completed provider response, including container identity, before canonicalization or D1 mutation.
      const parsed = fetched.map(({ league, poll }) => ({ league, poll, events: poll.events.map((event) => providerEventSnapshot.parse(event)) }));
      assertUniqueNormalizedIds(parsed);
      const normalized = parsed.map(({ league, poll, events }) => ({
        league, poll, events: events.map((event) => ({ event, canonical: canonicalize(event, at) }))
      }));
      // Read all prior state and derive the complete replacement before constructing any mutation.
      const existingByLeague = new Map(await Promise.all(normalized.map(async ({ league }) => {
        const existing = await this.db.prepare("SELECT provider_event_id, status, home_score, away_score, correction_version, finalized_at FROM sports_event WHERE league = ?").bind(league).all<ExistingEventRow>();
        return [league, existing.results] as const;
      })));
      const availability = Object.fromEntries(Object.entries(parseJson<Record<string, string[]>>(claimed.canonical_book_availability_json, {})).map(([id, markets]) => [id, [...markets]]));
      const statements: D1PreparedStatement[] = [];
      let events = 0; let offers = 0;
      for (const { league, events: validated } of normalized) {
        events += validated.length;
        const existing = existingByLeague.get(league) ?? [];
        const oldById = new Map(existing.map((row) => [row.provider_event_id, row]));
        const ids = new Set(validated.map(({ event }) => event.id));
        for (const missing of existing.filter((row) => !ids.has(row.provider_event_id))) {
          // Keep result history, but remove absent events from active scheduling in the same commit as feed success.
          statements.push(this.db.prepare("DELETE FROM market_offer WHERE event_id = ? AND ? = (SELECT poll_generation FROM odds_ingestion WHERE provider = 'odds')").bind(missing.provider_event_id, generation));
          statements.push(this.db.prepare("UPDATE sports_event SET omitted_at = ?, last_polled_at = ? WHERE provider_event_id = ? AND ? = (SELECT poll_generation FROM odds_ingestion WHERE provider = 'odds')").bind(at, at, missing.provider_event_id, generation));
          delete availability[missing.provider_event_id];
        }
        for (const { event, canonical } of validated) {
          const status = event.status ?? "scheduled";
          const old = oldById.get(event.id);
          const changed = old?.status !== status || old?.home_score !== score(event.homeScore) || old?.away_score !== score(event.awayScore);
          const correctionVersion = terminal(status) ? (old ? (changed ? (BigInt(old.correction_version) + 1n).toString() : old.correction_version) : "1") : (old?.correction_version ?? "0");
          const finalizedAt = terminal(status) ? old?.finalized_at ?? at : null;
          statements.push(this.db.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, home_score, away_score, correction_version, finalized_at, last_polled_at, event_name, postseason) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ? = (SELECT poll_generation FROM odds_ingestion WHERE provider = 'odds') ON CONFLICT(provider_event_id) DO UPDATE SET league=excluded.league, home_team=excluded.home_team, away_team=excluded.away_team, starts_at=excluded.starts_at, status=excluded.status, home_score=excluded.home_score, away_score=excluded.away_score, correction_version=excluded.correction_version, finalized_at=excluded.finalized_at, last_polled_at=excluded.last_polled_at, omitted_at=NULL, event_name=excluded.event_name, postseason=excluded.postseason WHERE ? = (SELECT poll_generation FROM odds_ingestion WHERE provider = 'odds')")
            .bind(event.id, event.id, event.sport, event.homeTeam, event.awayTeam, event.commenceTime, status, score(event.homeScore), score(event.awayScore), correctionVersion, finalizedAt, at, event.eventName ?? null, event.postseason ? 1 : 0, generation, generation));
          availability[event.id] = canonical.map((offer) => offer.market);
          statements.push(this.db.prepare("DELETE FROM market_offer WHERE event_id = ? AND ? = (SELECT poll_generation FROM odds_ingestion WHERE provider = 'odds')").bind(event.id, generation));
          for (const offer of canonical) {
            offers++;
            statements.push(this.db.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) SELECT ?, ?, ?, ?, ?, ? WHERE ? = (SELECT poll_generation FROM odds_ingestion WHERE provider = 'odds')").bind(offer.eventId, offer.market, offer.canonicalBook, offer.retrievedAt, offer.offerVersion, JSON.stringify({ policyVersion: offer.policyVersion, outcomes: offer.payload.outcomes }), generation));
          }
        }
        statements.push(this.db.prepare("INSERT INTO odds_league_poll (league, last_discovery_at, last_success_at, last_error) SELECT ?, ?, ?, NULL WHERE ? = (SELECT poll_generation FROM odds_ingestion WHERE provider = 'odds') ON CONFLICT(league) DO UPDATE SET last_discovery_at=excluded.last_discovery_at, last_success_at=excluded.last_success_at, last_error=NULL WHERE ? = (SELECT poll_generation FROM odds_ingestion WHERE provider = 'odds')").bind(league, at, at, generation, generation));
      }
      const quota = aggregateQuota(fetched.map(({ poll }) => poll.quota));
      const successQuota = quota ? { ...quota, backoffMs: quotaBackoff({ events: [], quota }) } : undefined;
      // This final guarded result is the definitive indication that the whole atomic batch was current and applied.
      statements.push(this.db.prepare("UPDATE odds_ingestion SET quota_json=COALESCE(?, quota_json), last_polled_at=?, last_success_at=?, last_error=NULL, canonical_book_availability_json=? WHERE provider='odds' AND poll_generation=?").bind(successQuota ? JSON.stringify(successQuota) : null, at, at, JSON.stringify(availability), generation));
      const results = await this.db.batch(statements);
      if (results.at(-1)?.meta.changes !== 1) return { events: 0, offers: 0 };
      return { events, offers };
    } catch (error) {
      // Only the latest attempted failed response advances health; last-good event/offer bytes are retained.
      await this.recordFailure(generation, at, providerFailureMessage(error));
      throw error;
    }
  }
  private async dueLeagues(now: Date, quotaBackoffMs: number): Promise<Array<{ league: League; due: true }>> {
    const states = await Promise.all((["nfl", "ncaaf"] as const).map(async (league) => ({ league, due: await this.leagueDue(league, now, quotaBackoffMs) })));
    return states.filter((state): state is { league: League; due: true } => state.due);
  }
  private async leagueDue(league: League, now: Date, quotaBackoffMs: number): Promise<boolean> {
    const state = await this.db.prepare("SELECT last_discovery_at FROM odds_league_poll WHERE league = ?").bind(league).first<LeaguePollRow>();
    const discoveryDue = !state?.last_discovery_at || now.getTime() - new Date(state.last_discovery_at).getTime() >= Math.max(DISCOVERY_INTERVAL, quotaBackoffMs);
    const rows = await this.db.prepare("SELECT provider_event_id, league, starts_at, status, last_polled_at, finalized_at FROM sports_event WHERE league = ? AND omitted_at IS NULL").bind(league).all<EventScheduleRow>();
    return discoveryDue || rows.results.some((row) => shouldPollEvent({ id: row.provider_event_id, sport: row.league, commenceTime: row.starts_at, homeTeam: "", awayTeam: "", status: row.status, bookmakers: [] }, row.last_polled_at ? new Date(row.last_polled_at) : undefined, now, quotaBackoffMs, row.finalized_at ? new Date(row.finalized_at) : undefined));
  }
  private async claimGeneration(): Promise<ClaimedIngestion> {
    const claimed = await this.db.prepare("INSERT INTO odds_ingestion (provider, poll_generation, canonical_book_availability_json) VALUES ('odds', 1, '{}') ON CONFLICT(provider) DO UPDATE SET poll_generation=odds_ingestion.poll_generation+1 RETURNING poll_generation,last_polled_at,last_success_at,canonical_book_availability_json,quota_json").first<ClaimedIngestion>();
    if (!claimed) throw new Error("Unable to claim odds poll generation");
    return claimed;
  }
  private async recordFailure(generation: number, at: string, error: string) {
    await this.db.prepare("UPDATE odds_ingestion SET last_polled_at=?, last_error=? WHERE provider='odds' AND poll_generation=?").bind(at, error, generation).run();
  }
}

const assertUniqueNormalizedIds = (responses: Array<{ league: League; events: Array<{ id: string }> }>): void => {
  const ids = new Set<string>();
  for (const { events } of responses) {
    for (const event of events) {
      if (ids.has(event.id)) throw new Error(`Duplicate normalized event ID: ${event.id}`);
      ids.add(event.id);
    }
  }
};
const providerFailureMessage = (error: unknown): string => {
  const detail = error instanceof ZodError
    ? `Malformed provider response: ${error.issues.map((issue) => `${issue.path.join(".") || "response"} ${issue.message}`).join("; ")}`
    : error instanceof Error ? error.message : "Provider unavailable";
  const normalized = detail.replace(/\s+/g, " ").trim() || "Provider unavailable";
  return normalized.slice(0, 512);
};

const aggregateQuota = (observations: Array<ProviderPoll["quota"]>) => {
  const present = observations.filter((quota): quota is NonNullable<ProviderPoll["quota"]> => quota !== undefined);
  if (present.length === 0) return undefined;
  const remaining = present.flatMap((quota) => quota.remaining === undefined ? [] : [quota.remaining]);
  const used = present.flatMap((quota) => quota.used === undefined ? [] : [quota.used]);
  return { ...(remaining.length ? { remaining: Math.min(...remaining) } : {}), ...(used.length ? { used: Math.max(...used) } : {}) };
};
const parseJson = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const backoffFrom = (quotaJson: string | null | undefined): number => {
  const quota = parseJson<{ backoffMs?: number }>(quotaJson, {});
  return Number.isFinite(quota.backoffMs) ? quota.backoffMs ?? 0 : 0;
};

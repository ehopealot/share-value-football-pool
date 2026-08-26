import type { Hono } from "hono";
import { z } from "zod";
import { LOCAL_FIXTURE_EVENTS } from "../odds/fixtures/runtime";
import { validateCanonicalMarket } from "../odds/market-semantics";
import { ProjectionConsumer, durableProjectionSnapshotReader } from "../services/projections";

const timestamp = z.string().datetime().refine((value) => Number.isFinite(new Date(value).getTime()));
const currentTimeRequest = z.object({ poolSlug: z.string().min(1).max(64), currentTime: timestamp.nullable() });
const resultRequest = z.object({ eventId: z.enum(["local-nfl-upcoming", "local-nfl-super-bowl"]), homeScore: z.number().int().min(0).max(300), awayScore: z.number().int().min(0).max(300), correctionVersion: z.string().min(1).max(64).optional() });
const alarmRequest = z.object({ poolSlug: z.string().min(1).max(64), currentTime: timestamp });
const offerRequest = z.object({ eventId: z.literal("local-nfl-upcoming"), market: z.literal("spread"), selection: z.enum(["home", "away"]), price: z.number().int().refine((value) => value !== 0), point: z.number().finite(), offerVersion: z.string().min(1).max(64), removeSelection: z.boolean().optional() });
const offerStateRequest = z.object({ eventId: z.literal("local-nfl-upcoming"), market: z.literal("spread"), state: z.enum(["current", "stale", "locked"]) });
const feedStateRequest = z.object({ state: z.enum(["current", "stale", "provider-error", "no-offer"]), lastPolledAt: timestamp, lastSuccessAt: timestamp, retrievedAt: timestamp });
const seasonStateRequest = z.object({ poolSlug: z.string().min(1).max(64), state: z.literal("closed") });
const expireSessionRequest = z.object({ userId: z.string().min(1).max(128) });
const responseBarrierRequest = z.object({ mode: z.enum(["delay", "drop"]), delayMs: z.number().int().min(0).max(5_000).optional(), pathname: z.string().regex(/^\/api\/[^?#]+$/).optional() });

/** A local-only, one-use transport seam. It operates after the real handler completes. */
export class LocalResponseBarrier {
  private armed: { mode: "delay" | "drop"; delayMs: number; pathname?: string } | null = null;
  arm(input: z.infer<typeof responseBarrierRequest>) { this.armed = { mode: input.mode, delayMs: input.delayMs ?? 250, pathname: input.pathname }; }
  async apply(request: Request, response: Response): Promise<Response> {
    const armed = this.armed;
    const pathname = new URL(request.url).pathname;
    if (!armed || !pathname.startsWith("/api/") || (armed.pathname && pathname !== armed.pathname)) return response;
    this.armed = null;
    if (armed.mode === "delay") { await new Promise((resolve) => setTimeout(resolve, armed.delayMs)); return response; }
    // Do not manufacture an error response: the already-completed response is deliberately not released.
    return new Promise<Response>(() => undefined);
  }
}

export type LocalTestControls = {
  enabled: boolean;
  seed(): Promise<{ seeded: true }>;
  setCurrentTime(input: z.infer<typeof currentTimeRequest>): Promise<{ currentTime: string | null }>;
  finalizeResult(input: z.infer<typeof resultRequest>): Promise<{ finalized: true; eventId: string }>;
  triggerAlarm(input: z.infer<typeof alarmRequest>): Promise<{ settled: true }>;
  /** Fixture-only canonical-offer mutation for real Worker reconfirmation paths. */
  updateOffer?(input: z.infer<typeof offerRequest>): Promise<{ updated: true }>;
  setOfferState?(input: z.infer<typeof offerStateRequest>): Promise<{ updated: true }>;
  setFeedState?(input: z.infer<typeof feedStateRequest>): Promise<{ updated: true }>;
  closeSeason?(input: z.infer<typeof seasonStateRequest>): Promise<{ closed: true }>;
  /** Makes an actual Better Auth session older than the production recent-auth window. */
  expireSession?(input: z.infer<typeof expireSessionRequest>): Promise<{ expired: true }>;
  /** Test-only development mailbox inspection; omitted controls do not expose a route. */
  mailbox?(): Promise<{ messages: Array<{ kind: "verification" | "password-reset"; to: string; token: string }> }>;
  /** Fixture-only escape valve for a deliberately multi-account browser journey. */
  resetAuthLimiter?(): void;
  responseBarrier?: LocalResponseBarrier;
};

/**
 * Deliberately separate from production routing. Callers must explicitly opt in;
 * when omitted no local-control path is registered and Hono returns 404.
 */
export function installLocalTestControls(app: Hono, controls: LocalTestControls): void {
  if (!controls.enabled) return;
  app.post("/__local-test/seed", async (c) => c.json(await controls.seed()));
  app.post("/__local-test/current-time", async (c) => {
    const parsed = currentTimeRequest.safeParse(await c.req.json());
    return parsed.success ? c.json(await controls.setCurrentTime(parsed.data)) : c.json({ code: "INVALID_LOCAL_CONTROL" }, 400);
  });
  app.post("/__local-test/result", async (c) => {
    const parsed = resultRequest.safeParse(await c.req.json());
    return parsed.success ? c.json(await controls.finalizeResult(parsed.data)) : c.json({ code: "INVALID_LOCAL_CONTROL" }, 400);
  });
  app.post("/__local-test/alarm", async (c) => {
    const parsed = alarmRequest.safeParse(await c.req.json());
    return parsed.success ? c.json(await controls.triggerAlarm(parsed.data)) : c.json({ code: "INVALID_LOCAL_CONTROL" }, 400);
  });
  if (controls.updateOffer) app.post("/__local-test/offer", async (c) => {
    const parsed = offerRequest.safeParse(await c.req.json());
    return parsed.success ? c.json(await controls.updateOffer!(parsed.data)) : c.json({ code: "INVALID_LOCAL_CONTROL" }, 400);
  });
  if (controls.setOfferState) app.post("/__local-test/offer-state", async (c) => {
    const parsed = offerStateRequest.safeParse(await c.req.json());
    return parsed.success ? c.json(await controls.setOfferState!(parsed.data)) : c.json({ code: "INVALID_LOCAL_CONTROL" }, 400);
  });
  if (controls.setFeedState) app.post("/__local-test/feed-state", async (c) => {
    const parsed = feedStateRequest.safeParse(await c.req.json());
    return parsed.success ? c.json(await controls.setFeedState!(parsed.data)) : c.json({ code: "INVALID_LOCAL_CONTROL" }, 400);
  });
  if (controls.closeSeason) app.post("/__local-test/season", async (c) => {
    const parsed = seasonStateRequest.safeParse(await c.req.json());
    return parsed.success ? c.json(await controls.closeSeason!(parsed.data)) : c.json({ code: "INVALID_LOCAL_CONTROL" }, 400);
  });
  if (controls.expireSession) app.post("/__local-test/expire-session", async (c) => {
    const parsed = expireSessionRequest.safeParse(await c.req.json());
    return parsed.success ? c.json(await controls.expireSession!(parsed.data)) : c.json({ code: "INVALID_LOCAL_CONTROL" }, 400);
  });
  if (controls.mailbox) app.get("/__local-test/mailbox", async (c) => c.json(await controls.mailbox!()));
  if (controls.resetAuthLimiter) app.post("/__local-test/reset-auth-limiter", (c) => { controls.resetAuthLimiter!(); return c.json({ reset: true }); });
  const responseBarrier = controls.responseBarrier;
  if (responseBarrier) app.post("/__local-test/response-barrier", async (c) => {
    const parsed = responseBarrierRequest.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ code: "INVALID_LOCAL_CONTROL" }, 400);
    responseBarrier.arm(parsed.data);
    return c.json({ armed: true, mode: parsed.data.mode });
  });
}

/** Seeds only deterministic fixture data; it never contacts an odds, email, or Turnstile service. */
export function localFixtureControls(db: D1Database, pools: DurableObjectNamespace, projectionServiceToken?: string): LocalTestControls {
  const seed = async (): Promise<{ seeded: true }> => {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('local-owner', 'local-owner', 'local-owner@example.test', 1, 0, 0)"),
      db.prepare("INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('local-member', 'local-member', 'local-member@example.test', 1, 0, 0)")
    ]);
    for (const event of LOCAL_FIXTURE_EVENTS) {
      // Fixture modules can be bundled before Wrangler starts, so establish placeable offers at seed time.
      // Keep the established upcoming fixture first, with the canonical Super Bowl one minute later.
      const startsAt = !event.completed ? new Date(Date.now() + (event.id === "local-nfl-upcoming" ? 5 : 6) * 60 * 1000).toISOString() : event.commenceTime;
      await db.prepare("INSERT OR REPLACE INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, home_score, away_score, correction_version, finalized_at, event_name, postseason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'local-v1', ?, ?, ?)")
        .bind(event.id, event.id, event.sport, event.homeTeam, event.awayTeam, startsAt, event.status, event.homeScore === undefined ? null : String(event.homeScore), event.awayScore === undefined ? null : String(event.awayScore), event.completed ? startsAt : null, event.eventName ?? null, event.postseason ? 1 : 0).run();
      for (const market of event.bookmakers[0].markets) {
        await db.prepare("INSERT OR REPLACE INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES (?, ?, 'DraftKings', ?, 'local-v1', ?)")
          .bind(event.id, market.key, new Date().toISOString(), JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: market.outcomes })).run();
      }
    }
    const observedAt = new Date().toISOString();
    await db.prepare("INSERT INTO odds_ingestion (provider, last_polled_at, last_success_at, last_error) VALUES ('odds', ?, ?, NULL) ON CONFLICT(provider) DO UPDATE SET last_polled_at=excluded.last_polled_at, last_success_at=excluded.last_success_at, last_error=NULL").bind(observedAt, observedAt).run();
    return { seeded: true };
  };
  return {
    enabled: true,
    seed,
    async setCurrentTime({ poolSlug, currentTime }) {
      const record = await db.prepare("SELECT pool_id FROM pool_registry WHERE normalized_slug = ? AND status = 'ready'").bind(poolSlug.toLowerCase()).first<{ pool_id: string }>();
      if (!record) throw new Error("POOL_NOT_AVAILABLE");
      // Advance or reset (null) the pool's stored fixture read clock; nothing but read shaping observes it.
      const response = await pools.get(pools.idFromName(record.pool_id)).fetch("https://pool.internal/__local-test/current-time", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentTime }) });
      if (!response.ok) throw new Error("LOCAL_READ_TIME_FAILED");
      return { currentTime };
    },
    async finalizeResult({ eventId, homeScore, awayScore, correctionVersion = "local-final-v1" }) {
      const updated = await db.prepare("UPDATE sports_event SET status = 'final', home_score = ?, away_score = ?, correction_version = ?, finalized_at = ? WHERE provider_event_id = ?").bind(String(homeScore), String(awayScore), correctionVersion, new Date().toISOString(), eventId).run();
      if (!updated.meta.changes) throw new Error("LOCAL_EVENT_NOT_FOUND");
      return { finalized: true, eventId };
    },
    async updateOffer({ eventId, market, selection, price, point, offerVersion, removeSelection }) {
      const event = await db.prepare("SELECT home_team, away_team FROM sports_event WHERE provider_event_id = ?").bind(eventId).first<{ home_team: string; away_team: string }>();
      const current = await db.prepare("SELECT canonical_book, payload_json FROM market_offer WHERE event_id = ? AND market = ?").bind(eventId, market).first<{ canonical_book: string; payload_json: string }>();
      if (!event || !current) throw new Error("LOCAL_OFFER_NOT_FOUND");
      const team = selection === "home" ? event.home_team : event.away_team;
      const payload = JSON.parse(current.payload_json) as { policyVersion: unknown; outcomes: Array<{ name: string; price: number; point?: number }> };
      payload.outcomes = removeSelection
        ? payload.outcomes.filter((outcome) => outcome.name !== team)
        : payload.outcomes.map((outcome) => outcome.name === team ? { ...outcome, price, point } : { ...outcome, point: -point });
      if (!removeSelection) payload.outcomes = validateCanonicalMarket({ market, canonicalBook: current.canonical_book, policyVersion: payload.policyVersion, homeTeam: event.home_team, awayTeam: event.away_team, outcomes: payload.outcomes }).outcomes;
      const observedAt = new Date().toISOString();
      await db.batch([
        db.prepare("UPDATE market_offer SET retrieved_at = ?, offer_version = ?, payload_json = ? WHERE event_id = ? AND market = ?").bind(observedAt, offerVersion, JSON.stringify(payload), eventId, market),
        db.prepare("INSERT INTO odds_ingestion (provider, last_polled_at, last_success_at, last_error) VALUES ('odds', ?, ?, NULL) ON CONFLICT(provider) DO UPDATE SET last_polled_at=excluded.last_polled_at, last_success_at=excluded.last_success_at, last_error=NULL").bind(observedAt, observedAt)
      ]);
      return { updated: true };
    },
    async setOfferState({ eventId, market, state }) {
      const startsAt = state === "locked" ? new Date(Date.now() - 60_000).toISOString() : new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const retrievedAt = state === "stale" ? new Date(Date.now() - 10 * 60 * 1000).toISOString() : new Date().toISOString();
      const updated = await db.batch([
        db.prepare("UPDATE sports_event SET starts_at = ? WHERE provider_event_id = ?").bind(startsAt, eventId),
        db.prepare("UPDATE market_offer SET retrieved_at = ? WHERE event_id = ? AND market = ?").bind(retrievedAt, eventId, market),
        db.prepare("INSERT INTO odds_ingestion (provider, last_polled_at, last_success_at, last_error) VALUES ('odds', ?, ?, NULL) ON CONFLICT(provider) DO UPDATE SET last_polled_at=excluded.last_polled_at, last_success_at=excluded.last_success_at, last_error=NULL").bind(retrievedAt, retrievedAt)
      ]);
      if (updated.some((result) => !result.meta.changes)) throw new Error("LOCAL_OFFER_NOT_FOUND");
      return { updated: true };
    },
    async setFeedState({ state, lastPolledAt, lastSuccessAt, retrievedAt }) {
      if (state === "no-offer") await db.prepare("DELETE FROM market_offer").run();
      else {
        const storedRetrievedAt = state === "stale" ? "2000-01-01T00:00:00.000Z" : retrievedAt;
        await db.prepare("UPDATE market_offer SET retrieved_at = ?").bind(storedRetrievedAt).run();
      }
      await db.prepare("INSERT INTO odds_ingestion (provider, last_polled_at, last_success_at, last_error) VALUES ('odds', ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET last_polled_at=excluded.last_polled_at, last_success_at=excluded.last_success_at, last_error=excluded.last_error")
        .bind(lastPolledAt, lastSuccessAt, state === "provider-error" ? "Local provider failure observation" : null).run();
      return { updated: true };
    },
    async closeSeason({ poolSlug }) {
      const record = await db.prepare("SELECT pool_id FROM pool_registry WHERE normalized_slug = ? AND status = 'ready'").bind(poolSlug.toLowerCase()).first<{ pool_id: string }>();
      if (!record) throw new Error("POOL_NOT_AVAILABLE");
      const response = await pools.get(pools.idFromName(record.pool_id)).fetch("https://pool.internal/__local-test/close-season", { method: "POST" });
      if (!response.ok) throw new Error("LOCAL_SEASON_CLOSE_FAILED");
      return { closed: true };
    },
    async expireSession({ userId }) {
      // Better Auth's D1 adapter stores timestamp columns in seconds. Epoch zero is
      // unambiguously outside the fifteen-minute production recent-auth window.
      const expiredAt = 0;
      const updated = await db.prepare("UPDATE session SET createdAt = ?, updatedAt = ? WHERE userId = ?").bind(expiredAt, expiredAt, userId).run();
      if (!updated.meta.changes) throw new Error("LOCAL_SESSION_NOT_FOUND");
      return { expired: true };
    },
    async triggerAlarm({ poolSlug, currentTime }) {
      const record = await db.prepare("SELECT pool_id FROM pool_registry WHERE normalized_slug = ? AND status = 'ready'").bind(poolSlug.toLowerCase()).first<{ pool_id: string }>();
      if (!record) throw new Error("POOL_NOT_AVAILABLE");
      const response = await pools.get(pools.idFromName(record.pool_id)).fetch(`https://pool.internal/__local-test/alarm?currentTime=${encodeURIComponent(currentTime)}`, { method: "POST" });
      if (!response.ok) throw new Error("LOCAL_ALARM_FAILED");
      const body = await response.json() as { messages?: unknown[] };
      // The loopback control drives the same production Queue consumer, rather
      // than manufacturing a D1 projection or relying on Wrangler's idle Queue
      // scheduler. Queue delivery may subsequently duplicate these messages.
      const consumer = new ProjectionConsumer(db, durableProjectionSnapshotReader(pools, projectionServiceToken));
      for (const message of body.messages ?? []) await consumer.consume(message);
      return { settled: true };
    }
  };
}

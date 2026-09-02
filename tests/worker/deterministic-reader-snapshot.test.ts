import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import pollGenerationMigration from "../../src/db/migrations/0002_odds_poll_generation.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import { OddsIngestion, type IngestionProvider } from "../../src/odds/ingestion";
import type { ProviderEvent } from "../../src/odds/types";
import { createWorkerApp } from "../../src/worker/app";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace; POOL_COMMAND_AUTHENTICATOR_KEY: string };
const origin = "https://pool.example.test";
const OLD_AT = "2030-09-10T00:00:00.000Z";
const NEW_AT = "2030-09-10T00:05:00.000Z";
let migrated = false;

type Boundary = "before" | "after";
type Market = "spread" | "total";
const http = (path: string, body?: unknown, method = "POST") => new Request(`${origin}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json", origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const provider = (events: ProviderEvent[]): IngestionProvider => ({ events: async (league) => ({ events: events.filter((event) => event.sport === league) }) });
const event = (id: string, version: "old" | "new"): ProviderEvent => {
  const delta = version === "old" ? 0 : 1;
  return {
    id, sport: "nfl", commenceTime: "2099-09-10T20:00:00.000Z", homeTeam: `${id} Home`, awayTeam: `${id} Away`, status: "scheduled",
    bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [
      { key: "spread", outcomes: [{ name: `${id} Home`, price: -110 - delta, point: -3 - delta }, { name: `${id} Away`, price: -110 + delta, point: 3 + delta }] },
      { key: "total", outcomes: [{ name: "Over", price: -108 - delta, point: 45 + delta }, { name: "Under", price: -112 + delta, point: 45 + delta }] }
    ] }]
  };
};

async function poll(events: ProviderEvent[], at: string) {
  await new OddsIngestion(bindings.DB, provider(events), { now: () => new Date(at) }).poll();
}
async function seedOld(ids: string[]) {
  await poll(ids.map((id) => event(id, "old")), OLD_AT);
  await bindings.DB.exec("UPDATE sports_event SET last_polled_at='2029-09-09T00:00:00.000Z'; UPDATE odds_league_poll SET last_discovery_at='2029-09-09T00:00:00.000Z';");
}
async function send(poolId: string, command: unknown) {
  return bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)).fetch("https://pool.internal/command", { method: "POST", body: JSON.stringify(command) });
}
async function setupPool(poolId: string, slug: string) {
  await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, slug, poolId, `create-${poolId}`, new Date().toISOString()).run();
  await send(poolId, { type: "InitializePool", commandId: `init-${poolId}`, poolId, slug, creatorId: "owner", creatorName: "Owner", poolName: "Reader Pool", password: "correct-password" });
  await send(poolId, { type: "JoinPool", commandId: `join-${poolId}`, actorId: "member", displayName: "Member", password: "correct-password" });
  await send(poolId, { type: "CreateSeason", commandId: `season-${poolId}`, actorId: "owner", seasonId: "s1", label: "2030" });
  await send(poolId, { type: "OpenSeason", commandId: `open-${poolId}`, actorId: "owner", seasonId: "s1" });
}

/** Delegates every query to real D1; it places a poll commit only after the complete targeted read set. */
function readerBarrier(real: D1Database, boundary: Boundary, commit: () => Promise<void>, afterTargetReads = 1) {
  const wrappedToReal = new WeakMap<object, D1PreparedStatement>();
  const sqlByWrapped = new WeakMap<object, string>();
  let fired = false;
  let targetBatchStatements = 0;
  let targetReads = 0;
  const target = (sql: string) => /JOIN market_offer/.test(sql) || /FROM odds_ingestion/.test(sql);
  const boundaryHere = (): boolean => {
    if (fired) return false;
    targetReads++;
    if ((boundary === "before" && targetReads === 1) || (boundary === "after" && targetReads === afterTargetReads)) {
      fired = true;
      return true;
    }
    return false;
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement as object, {
      get(_value, property) {
        if (property === "bind") return (...values: unknown[]) => wrap((statement.bind as (...args: unknown[]) => D1PreparedStatement)(...values), sql);
        const member = (statement as unknown as Record<PropertyKey, unknown>)[property];
        if (typeof member !== "function") return member;
        return async (...args: unknown[]) => {
          const invoke = () => (member as (...args: unknown[]) => unknown).apply(statement, args);
          if (!target(sql) || !boundaryHere()) return invoke();
          if (boundary === "before") await commit();
          const result = await invoke();
          if (boundary === "after") await commit();
          return result;
        };
      }
    }) as D1PreparedStatement;
    wrappedToReal.set(proxy as object, statement); sqlByWrapped.set(proxy as object, sql);
    return proxy;
  };
  const db = new Proxy(real as object, {
    get(_value, property) {
      if (property === "prepare") return (sql: string) => wrap(real.prepare(sql), sql);
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const sql = statements.map((statement) => sqlByWrapped.get(statement as object) ?? "");
        if (!sql.some(target) || !boundaryHere()) return real.batch(statements.map((statement) => wrappedToReal.get(statement as object) ?? statement));
        targetBatchStatements = sql.filter(target).length;
        if (boundary === "before") await commit();
        const result = await real.batch(statements.map((statement) => wrappedToReal.get(statement as object) ?? statement));
        // Miniflare can reuse D1 result row objects after a later write. Clone the
        // complete batch before opening the after-read boundary so the reader
        // receives the snapshot it actually captured.
        const captured = JSON.parse(JSON.stringify(result)) as typeof result;
        if (boundary === "after") await commit();
        return captured;
      };
      const member = (real as unknown as Record<PropertyKey, unknown>)[property];
      return typeof member === "function" ? (member as Function).bind(real) : member;
    }
  }) as D1Database;
  return { db, proof: () => ({ fired, targetBatchStatements, targetReads }) };
}

const semanticLeg = (eventId: string, market: Market, version: Boundary) => ({
  eventId, canonicalBook: "DraftKings", market, selection: market === "spread" ? "home" : "over",
  offerId: `${eventId}:${market}:${market === "spread" ? "home" : "over"}`,
  offerVersion: `${eventId}:${market}:${version === "after" ? OLD_AT : NEW_AT}`
});
const expected = (boundary: Boundary) => boundary === "after" ? { at: OLD_AT, spreadLine: -3, totalLine: 45, spreadOdds: -110, totalOdds: -108 } : { at: NEW_AT, spreadLine: -4, totalLine: 46, spreadOdds: -111, totalOdds: -109 };

beforeEach(async () => {
  if (!migrated) {
    await applyD1Migrations(bindings.DB, [
      { name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) },
      { name: "0002_odds_poll_generation.sql", queries: pollGenerationMigration.split(";\n").filter(Boolean) }
    ]);
    migrated = true;
  }
  await bindings.DB.exec("DELETE FROM market_offer; DELETE FROM sports_event; DELETE FROM odds_ingestion; DELETE FROM odds_league_poll; DELETE FROM pool_registry_command_response; DELETE FROM pool_registry; INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'reader-owner@example.test', 1, 0, 0), ('member', 'Member', 'reader-member@example.test', 1, 0, 0);");
});

describe("deterministic D1 reader snapshots", () => {
  it.each(["after", "before"] as const)("returns an authenticated board from the complete %s-poll snapshot", async (boundary) => {
    const poolId = `reader-board-${boundary}-${crypto.randomUUID()}`; const slug = `reader-board-${boundary}-${crypto.randomUUID()}`;
    await setupPool(poolId, slug); await seedOld(["board-one", "board-two"]);
    const barrier = readerBarrier(bindings.DB, boundary, () => poll([event("board-one", "new"), event("board-two", "new")], NEW_AT));
    const app = createWorkerApp({ db: barrier.db, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const response = await app.fetch(http(`/api/p/${slug}/odds`, undefined, "GET")); expect(response.status).toBe(200);
    const board = await response.json() as any; const state = expected(boundary);
    expect(barrier.proof()).toEqual({ fired: true, targetBatchStatements: 2, targetReads: 1 });
    expect(board.feed).toMatchObject({ status: "current", lastPolledAt: state.at, lastSuccessAt: state.at });
    expect(board.offers).toHaveLength(4);
    for (const offer of board.offers) {
      expect(offer.retrievedAt).toBe(state.at); expect(offer.offerVersion).toBe(`${offer.eventId}:${offer.market}:${state.at}`);
      expect(offer.canonicalBook).toBe("DraftKings"); expect(offer.policyVersion).toBe("CANONICAL_BOOKS_2026_V1");
      const selected = offer.outcomes.find((outcome: any) => outcome.name === (offer.market === "spread" ? `${offer.eventId} Home` : "Over"));
      expect(selected).toMatchObject({ price: offer.market === "spread" ? state.spreadOdds : state.totalOdds, point: offer.market === "spread" ? state.spreadLine : state.totalLine });
    }
  }, 90_000);

  it.each(["after", "before"] as const)("quotes a straight wager from the complete %s-poll snapshot", async (boundary) => {
    const poolId = `reader-straight-${boundary}-${crypto.randomUUID()}`; const slug = `reader-straight-${boundary}-${crypto.randomUUID()}`; const eventId = "straight-reader";
    await setupPool(poolId, slug); await seedOld([eventId]);
    const barrier = readerBarrier(bindings.DB, boundary, () => poll([event(eventId, "new")], NEW_AT));
    const app = createWorkerApp({ db: barrier.db, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const key = `straight-${boundary}`;
    const response = await app.fetch(http(`/api/p/${slug}/wagers/straight/quote`, { quoteKey: key, commandId: key, wagerId: key, seasonId: "s1", riskMicros: "1000000", rulesetVersion: "SHARE_POOL_2026_V1", leg: semanticLeg(eventId, "spread", boundary) }));
    expect(response.status).toBe(200); const quote = await response.json() as any; const state = expected(boundary);
    expect(barrier.proof()).toEqual({ fired: true, targetBatchStatements: 2, targetReads: 1 });
    expect(quote.leg).toMatchObject({ retrievedAt: state.at, offerVersion: `${eventId}:spread:${state.at}`, canonicalBook: "DraftKings", policyVersion: "CANONICAL_BOOKS_2026_V1", originalLine: state.spreadLine, adjustedLine: state.spreadLine, originalOdds: state.spreadOdds, canonicalOfferProof: { offerVersion: `${eventId}:spread:${state.at}`, line: state.spreadLine, odds: state.spreadOdds } });
  }, 90_000);

  it.each([["same-event", ["teaser-same", "teaser-same"], ["spread", "total"]], ["different-event", ["teaser-one", "teaser-two"], ["spread", "spread"]]] as const)("quotes %s teaser legs without crossing the first-leg boundary", async (_name, ids, markets) => {
    for (const boundary of ["after", "before"] as const) {
      const uniqueIds = [...new Set(ids)]; const poolId = `reader-teaser-${boundary}-${crypto.randomUUID()}`; const slug = `reader-teaser-${boundary}-${crypto.randomUUID()}`;
      await setupPool(poolId, slug); await seedOld(uniqueIds);
      const barrier = readerBarrier(bindings.DB, boundary, () => poll(uniqueIds.map((id) => event(id, "new")), NEW_AT));
      const app = createWorkerApp({ db: barrier.db, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
      const key = `teaser-${boundary}-${crypto.randomUUID()}`;
      const response = await app.fetch(http(`/api/p/${slug}/wagers/teasers/quote`, { quoteKey: key, commandId: key, wagerId: key, seasonId: "s1", riskMicros: "1000000", teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: ids.map((id, index) => semanticLeg(id, markets[index], boundary)) }));
      expect(response.status).toBe(200); const quote = await response.json() as any; const state = expected(boundary);
      expect(barrier.proof()).toEqual({ fired: true, targetBatchStatements: 3, targetReads: 1 });
      expect(new Set(quote.legs.map((leg: any) => leg.retrievedAt))).toEqual(new Set([state.at]));
      for (const leg of quote.legs) expect(leg).toMatchObject({ retrievedAt: state.at, offerVersion: `${leg.eventId}:${leg.market}:${state.at}`, canonicalBook: "DraftKings", policyVersion: "CANONICAL_BOOKS_2026_V1", originalLine: leg.market === "spread" ? state.spreadLine : state.totalLine, originalOdds: leg.market === "spread" ? state.spreadOdds : state.totalOdds });
      await bindings.DB.exec("DELETE FROM market_offer; DELETE FROM sports_event; DELETE FROM odds_ingestion; DELETE FROM odds_league_poll;");
    }
  }, 180_000);

  it.each(["after", "before"] as const)("uses the complete %s-poll read boundary for placement authority", async (boundary) => {
    const eventId = "placement-reader"; const poolId = `reader-place-${boundary}-${crypto.randomUUID()}`; const slug = `reader-place-${boundary}-${crypto.randomUUID()}`;
    await setupPool(poolId, slug); await seedOld([eventId]);
    const fundingQuote = await (await send(poolId, { type: "QuoteShareOrder", commandId: `fund-q-${boundary}`, actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000" })).json() as any;
    await send(poolId, { type: "ExecuteShareOrder", commandId: `fund-${boundary}`, actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000", quote: fundingQuote, reason: "reader proof" });
    const ordinary = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const quoteKey = `place-quote-${boundary}`; const quoteResponse = await ordinary.fetch(http(`/api/p/${slug}/wagers/straight/quote`, { quoteKey, commandId: quoteKey, wagerId: `wager-${boundary}`, seasonId: "s1", riskMicros: "1000000", rulesetVersion: "SHARE_POOL_2026_V1", leg: semanticLeg(eventId, "spread", "after") }));
    expect(quoteResponse.status).toBe(200); const quote = await quoteResponse.json() as any; const { ownerMemberId: _owner, commandVersion, ...terms } = quote;
    const placement = { ...terms, wagerId: `wager-${boundary}`, commandId: `mutation-${boundary}`, mutationKey: `mutation-${boundary}`, quotedCommandVersion: commandVersion };
    const snapshot = () => runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)), (_instance, state) => Object.fromEntries(["pool", "processed_command", "wager_quote", "wager", "wager_leg", "wager_leg_snapshot", "share_account", "ledger_entry", "event_reconciliation", "outbox", "administration_audit"].map((table) => [table, JSON.stringify([...state.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`)])])));
    const before = await snapshot();
    const barrier = readerBarrier(bindings.DB, boundary, () => poll([event(eventId, "new")], NEW_AT), boundary === "after" ? 2 : 1);
    const app = createWorkerApp({ db: barrier.db, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const placementStartedAt = Date.now();
    const response = await app.fetch(http(`/api/p/${slug}/wagers/straight/place`, placement));
    const responseBody = await response.json() as any;
    expect(barrier.proof()).toEqual({ fired: true, targetBatchStatements: 2, targetReads: boundary === "after" ? 2 : 1 });
    if (boundary === "after") {
      expect(response.status).toBe(200);
      expect(responseBody).toEqual({ wagerId: "wager-after", commandVersion: "6" });
      const after = await snapshot();
      expect(after).not.toEqual(before);
      const rows = (table: keyof typeof after): Array<Record<string, unknown>> => JSON.parse(after[table]);
      expect(rows("pool")).toEqual([expect.objectContaining({ command_version: "6", active_season_id: "s1" })]);
      const processed = rows("processed_command");
      expect(processed).toHaveLength(8);
      const placementCommand = processed.find((row) => row.id === "mutation-after");
      expect(placementCommand).toMatchObject({ type: "PlaceStraightWager", actor_id: "member" });
      expect(JSON.parse(String(placementCommand?.response_json))).toEqual(responseBody);
      const storedQuote = rows("wager_quote");
      expect(storedQuote).toHaveLength(1);
      expect(storedQuote[0]).toMatchObject({ actor_id: "member", quote_key: "place-quote-after", wager_id: "wager-after", kind: "straight", command_version: "5" });
      expect(JSON.parse(String(storedQuote[0]?.terms_json))).toMatchObject({ quoteKey: "place-quote-after", riskMicros: "1000000", acceptedOdds: 100, leg: { retrievedAt: OLD_AT, offerVersion: `${eventId}:spread:${OLD_AT}`, originalLine: -3, originalOdds: -110 } });
      expect(rows("share_account")).toEqual(expect.arrayContaining([expect.objectContaining({ season_id: "s1", member_id: "member", available_micros: "0", locked_micros: "1000000", row_version: "6" })]));
      expect(rows("wager")).toEqual([expect.objectContaining({ id: "wager-after", season_id: "s1", owner_id: "member", type: "straight", risk_micros: "1000000", accepted_odds: 100, status: "open" })]);
      expect(rows("wager_leg")).toEqual([expect.objectContaining({ id: "wager-after:0", wager_id: "wager-after", event_id: eventId, league: "nfl", canonical_book: "DraftKings", retrieved_at: OLD_AT, offer_version: `${eventId}:spread:${OLD_AT}`, market: "spread", selection: "home", original_line: "-3", original_odds: -110 })]);
      expect(rows("wager_leg_snapshot")).toEqual([{ wager_leg_id: "wager-after:0", home_team: `${eventId} Home`, away_team: `${eventId} Away` }]);
      expect(rows("ledger_entry")).toEqual(expect.arrayContaining([expect.objectContaining({ id: "ledger:lock:wager-after", season_id: "s1", member_id: "member", available_delta: "-1000000", locked_delta: "1000000", float_delta: "0", causation_id: "wager-after", kind: "wager_lock" })]));
      expect(rows("event_reconciliation")).toEqual([expect.objectContaining({ event_id: eventId, event_starts_at: "2099-09-10T20:00:00.000Z", phase: "open", attempts: 0, error_attempts: 0, next_attempt_at: "2099-09-10T20:00:00.000Z" })]);
      const placementOutbox = rows("outbox").map((row) => ({ ...row, payload: JSON.parse(String(row.payload_json)) })).find((row) => row.payload.commandId === "mutation-after");
      expect(placementOutbox).toMatchObject({ event_type: "CommandApplied", version: "6", payload: { poolId, actorId: "member", commandId: "mutation-after", commandType: "PlaceStraightWager", seasonId: "s1", memberId: "member", wagerId: "wager-after" } });
      expect(rows("administration_audit")).toEqual([]);
      const alarm = await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)), (_instance, state) => state.storage.getAlarm());
      expect(alarm).not.toBeNull();
      // The drain grace is compile-time configurable (far-future in the vitest Worker) so the scheduled alarm is asserted relative to it.
      const drainGraceMs = await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)), () => (globalThis as { POOL_OUTBOX_DRAIN_GRACE_MS?: number }).POOL_OUTBOX_DRAIN_GRACE_MS ?? 1_000);
      expect(alarm!).toBeGreaterThanOrEqual(placementStartedAt);
      expect(alarm!).toBeLessThanOrEqual(placementStartedAt + drainGraceMs + 5_000);
      return;
    }
    expect(response.status).toBe(400);
    expect(responseBody).toMatchObject({ code: "LINE_CHANGED", reconfirmationRequired: true, replacement: { leg: { retrievedAt: NEW_AT, offerVersion: `${eventId}:spread:${NEW_AT}`, canonicalBook: "DraftKings", originalLine: -4, adjustedLine: -4, originalOdds: -111, policyVersion: "CANONICAL_BOOKS_2026_V1", canonicalOfferProof: { offerVersion: `${eventId}:spread:${NEW_AT}`, line: -4, odds: -111 } } } });
    expect(await snapshot()).toEqual(before);
  }, 120_000);
});

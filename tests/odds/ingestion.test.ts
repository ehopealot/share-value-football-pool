import { applyD1Migrations, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import pollGenerationMigration from "../../src/db/migrations/0002_odds_poll_generation.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import nflFixture from "../fixtures/odds/nfl-final.json";
import nflScoresFixture from "../fixtures/odds/nfl-final-scores.json";
import ncaafFixture from "../fixtures/odds/ncaaf-scheduled.json";
import ncaafScoresFixture from "../fixtures/odds/ncaaf-scheduled-scores.json";
import { canonicalize, isSuperBowl } from "../../src/odds/canonicalize";
import { providerEventSnapshot } from "../../src/contracts/provider";
import { OddsIngestion, finalReconciliationDue, offerIsStale, pollInterval, shouldPollEvent, type IngestionProvider } from "../../src/odds/ingestion";
import { D1ResultSource } from "../../src/odds/result-source";
import { settleWagers } from "../../src/durable/settlement";
import { canonicalizeWagerQuote, OfferQuotes } from "../../src/worker/offer-quotes";
import { TheOddsApiProvider } from "../../src/odds/the-odds-api-provider";
import type { ProviderEvent, ProviderPoll, ProviderQuota } from "../../src/odds/types";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace; POOL_COMMAND_AUTHENTICATOR_KEY: string };
const db = bindings.DB;
let migrated = false;
const event = (overrides: Partial<ProviderEvent> = {}): ProviderEvent => ({
  id: "event-1", sport: "nfl", commenceTime: "2026-09-10T20:00:00.000Z", homeTeam: "Home", awayTeam: "Away", status: "scheduled", bookmakers: [
    { key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "Home", price: -110, point: -3.5 }, { name: "Away", price: -110, point: 3.5 }] }] },
    { key: "fanduel", title: "FanDuel", markets: [{ key: "spread", outcomes: [{ name: "Home", price: -105, point: -3.5 }, { name: "Away", price: -115, point: 3.5 }] }, { key: "total", outcomes: [{ name: "Over", price: -110, point: 47.5 }, { name: "Under", price: -110, point: 47.5 }] }, { key: "moneyline", outcomes: [{ name: "Home", price: -140 }, { name: "Away", price: 120 }] }] }
  ], ...overrides
});
type QuotaByLeague = Partial<Record<"nfl" | "ncaaf", ProviderQuota>>;
const isQuotaByLeague = (quota: ProviderQuota | QuotaByLeague): quota is QuotaByLeague => !("remaining" in quota || "used" in quota);
class Provider implements IngestionProvider {
  calls: string[] = [];
  constructor(readonly current: ProviderEvent[], readonly quota?: ProviderQuota | QuotaByLeague) {}
  async events(league: "nfl" | "ncaaf"): Promise<ProviderPoll> {
    this.calls.push(league);
    const quota: ProviderQuota | undefined = !this.quota ? undefined : isQuotaByLeague(this.quota) ? this.quota[league] : this.quota;
    return { events: this.current.filter((item) => item.sport === league), quota };
  }
}
class DeferredProvider implements IngestionProvider {
  readonly called: Promise<void>;
  readonly response: Promise<ProviderPoll>;
  private markCalled!: () => void;
  resolve!: (poll: ProviderPoll) => void;
  reject!: (error: Error) => void;
  constructor() {
    this.called = new Promise((resolve) => { this.markCalled = resolve; });
    this.response = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  }
  async events(): Promise<ProviderPoll> { this.markCalled(); return this.response; }
}
class ClaimBarrier {
  readonly entered: Promise<void>;
  private markEntered!: () => void;
  private readonly released: Promise<void>;
  release!: () => void;
  constructor() {
    this.entered = new Promise((resolve) => { this.markEntered = resolve; });
    this.released = new Promise((resolve) => { this.release = resolve; });
  }
  wait = async (): Promise<void> => { this.markEntered(); await this.released; };
}

const lastGoodD1Snapshot = async () => ({
  events: (await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results,
  offers: (await db.prepare("SELECT * FROM market_offer ORDER BY event_id,market").all()).results,
  availability: await db.prepare("SELECT canonical_book_availability_json,last_success_at FROM odds_ingestion WHERE provider='odds'").first()
});

/** Builds and settles an authoritative wager so rejected provider input can prove it did not regrade state. */
async function settledWagerPool(eventId: string) {
  const poolId = `provider-rejection-${crypto.randomUUID()}`;
  const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId));
  const command = async (body: unknown) => (await stub.fetch("https://pool.test/command", { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
  await command({ type: "InitializePool", commandId: "init", poolId, slug: poolId, poolName: "Provider rejection", creatorId: "owner", creatorName: "Owner", password: "correct-password" });
  await command({ type: "JoinPool", commandId: "join", actorId: "member", displayName: "Member", password: "correct-password" });
  await command({ type: "CreateSeason", commandId: "draft", actorId: "owner", seasonId: "s1", label: "2026" });
  await command({ type: "OpenSeason", commandId: "open", actorId: "owner", seasonId: "s1" });
  const orderQuote = await command({ type: "QuoteShareOrder", commandId: "fund-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000" });
  await command({ type: "ExecuteShareOrder", commandId: "fund", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000", quote: { priceMicros: orderQuote.priceMicros, commandVersion: orderQuote.commandVersion }, reason: "virtual funding" });
  const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const leg = { eventId, league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-09-09T00:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: `${eventId}:spread:v1`, canonicalOfferProof: { offerId: `${eventId}:spread:home`, eventId, offerVersion: `${eventId}:spread:v1`, canonicalBook: "DraftKings", market: "spread", selection: "home", odds: -110, line: -3.5 }, market: "spread", selection: "home", originalLine: -3.5, adjustedLine: -3.5, originalOdds: -110, eventStartsAt: startsAt, homeTeam: "Home", awayTeam: "Away" };
  const view = await command({ type: "ReadPoolView", commandId: "place-view", actorId: "member" });
  const quoteKey = "wager-quote";
  const projection = { quoteKey, ownerMemberId: "member", commandVersion: view.commandVersion, fingerprint: "provider-rejection-proof", wagerId: "wager", actorId: "member", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg };
  const wagerQuote = await command({ type: "QuoteStraightWager", commandId: quoteKey, actorId: "member", identity: { actorId: "member", quoteKey, fingerprint: projection.fingerprint }, projection });
  await command({ type: "PlaceStraightWager", commandId: "place", actorId: "member", wagerId: "wager", quoteKey, quotedCommandVersion: wagerQuote.commandVersion, seasonId: wagerQuote.seasonId, riskMicros: wagerQuote.riskMicros, acceptedOdds: wagerQuote.acceptedOdds, rulesetVersion: wagerQuote.rulesetVersion, leg: wagerQuote.leg });
  await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("UPDATE event_reconciliation SET next_attempt_at = ? WHERE event_id = ?", new Date(Date.now() - 1_000).toISOString(), eventId));
  await runDurableObjectAlarm(stub);
  const snapshot = () => runInDurableObject(stub, (_instance, state) => Object.fromEntries(["pool", "processed_command", "wager", "wager_leg", "wager_leg_snapshot", "share_account", "ledger_entry", "settlement", "event_reconciliation", "outbox", "administration_audit"].map((table) => [table, JSON.stringify([...state.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`)])] )));
  return { snapshot, stub };
}

beforeEach(async () => {
  if (!migrated) {
    await applyD1Migrations(db, [
      { name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) },
      { name: "0002_odds_poll_generation.sql", queries: pollGenerationMigration.split(";\n").filter(Boolean) }
    ]);
    migrated = true;
  }
  await db.exec("DROP TRIGGER IF EXISTS ingestion_fail_offer_insert; DELETE FROM market_offer; DELETE FROM sports_event; DELETE FROM odds_ingestion; DELETE FROM odds_league_poll;");
});

describe("odds ingestion", () => {
  it("uses the first complete canonical book per market and never selection-shops", () => {
    const offers = canonicalize(event(), "2026-09-10T00:00:00.000Z");
    expect(offers.map(({ market, canonicalBook }) => [market, canonicalBook])).toEqual([["spread", "DraftKings"], ["total", "FanDuel"], ["moneyline", "FanDuel"]]);
  });

  it("falls through incomplete configured markets but rejects a contradictory selected market", () => {
    const incomplete = event({ bookmakers: [
      { key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "Home", price: -110, point: -3 }] }] },
      { key: "fanduel", title: "FanDuel", markets: [{ key: "spread", outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] }] }
    ] });
    expect(canonicalize(incomplete, "2026-09-10T00:00:00.000Z")[0]?.canonicalBook).toBe("FanDuel");
    const contradictory = event({ bookmakers: [
      { key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 4 }] }] },
      { key: "fanduel", title: "FanDuel", markets: [{ key: "spread", outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] }] }
    ] });
    expect(() => canonicalize(contradictory, "2026-09-10T00:00:00.000Z")).toThrow("Spread points must be exact additive opposites");
  });

  it.each([
    ["forward", [
      { key: "draftkings", title: "Other", markets: [{ key: "spread" as const, outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] }] },
      { key: "other", title: "DraftKings", markets: [{ key: "spread" as const, outcomes: [{ name: "Home", price: -120, point: -4 }, { name: "Away", price: 100, point: 4 }] }] }
    ]],
    ["reverse", [
      { key: "other", title: "DraftKings", markets: [{ key: "spread" as const, outcomes: [{ name: "Home", price: -120, point: -4 }, { name: "Away", price: 100, point: 4 }] }] },
      { key: "draftkings", title: "Other", markets: [{ key: "spread" as const, outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] }] }
    ]]
  ])("rejects duplicate configured bookmaker identities independent of %s order", (_order, bookmakers) => {
    expect(() => canonicalize(event({ bookmakers }), "2026-09-10T00:00:00.000Z")).toThrow("Duplicate configured bookmaker");
  });

  it.each(["forward", "reverse"])("rejects duplicate market keys independent of %s order", (order) => {
    const markets = [
      { key: "spread" as const, outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] },
      { key: "spread" as const, outcomes: [{ name: "Home", price: -120, point: -4 }, { name: "Away", price: 100, point: 4 }] }
    ];
    expect(() => canonicalize(event({ bookmakers: [{ key: "draftkings", title: "DraftKings", markets: order === "forward" ? markets : [...markets].reverse() }] }), "2026-09-10T00:00:00.000Z")).toThrow("Duplicate market key");
  });

  it("rejects duplicate markets after real provider normalization", async () => {
    const rawEvent = { id: "raw-duplicate", commence_time: "2026-09-10T20:00:00.000Z", home_team: "Home", away_team: "Away", bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [
      { key: "spreads", outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] },
      { key: "spreads", outcomes: [{ name: "Home", price: -120, point: -4 }, { name: "Away", price: 100, point: 4 }] }
    ] }] };
    const responses = [new Response(JSON.stringify([rawEvent])), new Response("[]")];
    const normalized = (await new TheOddsApiProvider("key", async () => responses.shift()!).events("nfl")).events[0]!;
    expect(() => canonicalize(normalized, "2026-09-10T00:00:00.000Z")).toThrow("Duplicate market key");
  });

  it("calls the injected provider fetcher without binding it to the adapter instance", async () => {
    const responses = [new Response(JSON.stringify(nflFixture)), new Response(JSON.stringify(nflScoresFixture))];
    let receiver: unknown = "not-called";
    const fetcher = function(this: unknown) { receiver = this; return Promise.resolve(responses.shift()!); } as typeof fetch;

    await expect(new TheOddsApiProvider("key", fetcher).events("nfl")).resolves.toMatchObject({ events: expect.any(Array) });
    expect(receiver).toBeUndefined();
  });

  it.each(["forward", "reverse"] as const)("rejects %s same-ID odds and score responses with swapped ordered sides", async (direction) => {
    const ordered = { home_team: "Home", away_team: "Away" };
    const swapped = { home_team: "Away", away_team: "Home" };
    const odds = { id: "swapped-sides", commence_time: "2026-09-10T20:00:00.000Z", ...(direction === "forward" ? ordered : swapped), bookmakers: [] };
    const score = { id: "swapped-sides", commence_time: "2026-09-10T20:00:00.000Z", ...(direction === "forward" ? swapped : ordered), completed: true, scores: [] };
    const responses = [new Response(JSON.stringify([odds])), new Response(JSON.stringify([score]))];
    await expect(new TheOddsApiProvider("key", async () => responses.shift()!).events("nfl")).rejects.toThrow("Conflicting raw odds/score event sides: swapped-sides");
  });

  it.each(["forward", "reverse"] as const)("records provider-error health and preserves last-good D1 and PoolDO bytes for %s swapped odds and score sides", async (direction) => {
    const eventId = "last-good";
    await new OddsIngestion(db, new Provider([event({ id: eventId, status: "final", homeScore: 24, awayScore: 17 })]), { now: () => new Date("2026-09-09T00:00:00.000Z") }).poll();
    await db.exec("UPDATE sports_event SET last_polled_at='2026-09-09T00:00:00.000Z' WHERE provider_event_id='last-good'; UPDATE odds_league_poll SET last_discovery_at='2026-09-09T06:01:00.000Z' WHERE league='ncaaf';");
    const { snapshot, stub } = await settledWagerPool(eventId);
    const beforeD1 = await lastGoodD1Snapshot();
    const beforeDurable = await snapshot();
    const ordered = { home_team: "Home", away_team: "Away" };
    const swapped = { home_team: "Away", away_team: "Home" };
    const odds = { id: "swapped-sides", commence_time: "2026-09-10T20:00:00.000Z", ...(direction === "forward" ? ordered : swapped), bookmakers: [] };
    const score = { id: "swapped-sides", commence_time: "2026-09-10T20:00:00.000Z", ...(direction === "forward" ? swapped : ordered), completed: true, scores: [] };
    const responses = [new Response(JSON.stringify([odds])), new Response(JSON.stringify([score]))];
    await expect(new OddsIngestion(db, new TheOddsApiProvider("key", async () => responses.shift()!), { now: () => new Date("2026-09-09T06:01:00.000Z") }).poll()).rejects.toThrow("Conflicting raw odds/score event sides: swapped-sides");
    expect(await lastGoodD1Snapshot()).toEqual(beforeD1);
    expect(await db.prepare("SELECT last_error FROM odds_ingestion WHERE provider='odds'").first()).toEqual({ last_error: "Conflicting raw odds/score event sides: swapped-sides" });
    const results = await new D1ResultSource(db).getFinalResults([eventId]);
    await runInDurableObject(stub, (_instance, state) => settleWagers(state.storage.sql, results));
    expect(await snapshot()).toEqual(beforeDurable);
  }, 30_000);

  it.each(["", " ", "+1", "-1", "1.0", "1e2", "01", "00", "9007199254740992"])("rejects noncanonical raw score string %j at the external adapter boundary", async (score) => {
    const rawScore = { id: "malformed-score", commence_time: "2026-09-10T20:00:00.000Z", home_team: "Home", away_team: "Away", completed: true, scores: [{ name: "Home", score }, { name: "Away", score: "17" }] };
    const responses = [new Response("[]"), new Response(JSON.stringify([rawScore]))];
    await expect(new TheOddsApiProvider("key", async () => responses.shift()!).events("nfl")).rejects.toThrow();
  });

  it.each([0, Number.MAX_SAFE_INTEGER + 1])("rejects raw American price %d at the external adapter boundary", async (price) => {
    const rawOdds = { id: "malformed-price", commence_time: "2026-09-10T20:00:00.000Z", home_team: "Home", away_team: "Away", bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "spreads", outcomes: [{ name: "Home", price, point: -3 }, { name: "Away", price: -110, point: 3 }] }] }] };
    const responses = [new Response(JSON.stringify([rawOdds])), new Response("[]")];
    await expect(new TheOddsApiProvider("key", async () => responses.shift()!).events("nfl")).rejects.toThrow();
  });

  it.each([0, Number.MAX_SAFE_INTEGER + 1])("rejects normalized American price %d before canonicalization", (price) => {
    const unsafe = event({ bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "Home", price, point: -3 }, { name: "Away", price: -110, point: 3 }] }] }] });
    expect(providerEventSnapshot.safeParse(unsafe).success).toBe(false);
    expect(() => canonicalize(unsafe, "2026-09-10T00:00:00.000Z")).toThrow("Outcome price is invalid");
  });

  it("rejects malformed provider scores and prices through ingestion without mutating last-good D1 or settled PoolDO state", async () => {
    const eventId = "malformed-number-state";
    await new OddsIngestion(db, new Provider([event({ id: eventId, status: "final", homeScore: 24, awayScore: 17 })]), { now: () => new Date("2026-09-09T00:00:00.000Z") }).poll();
    await db.exec(`UPDATE sports_event SET last_polled_at='2026-09-09T00:00:00.000Z' WHERE provider_event_id='${eventId}'; UPDATE odds_league_poll SET last_discovery_at='2026-09-09T06:01:00.000Z' WHERE league='ncaaf';`);
    const { snapshot, stub } = await settledWagerPool(eventId);
    const beforeD1 = await lastGoodD1Snapshot();
    const beforeDurable = await snapshot();
    const assertRetained = async () => {
      expect(await lastGoodD1Snapshot()).toEqual(beforeD1);
      const results = await new D1ResultSource(db).getFinalResults([eventId]);
      await runInDurableObject(stub, (_instance, state) => settleWagers(state.storage.sql, results));
      expect(await snapshot()).toEqual(beforeDurable);
    };

    for (const score of ["", " ", "+1", "-1", "1.0", "1e2", "01", "00", "9007199254740992"]) {
      const scoreOnly = { id: eventId, commence_time: "2026-09-10T20:00:00.000Z", home_team: "Home", away_team: "Away", completed: true, scores: [{ name: "Home", score }, { name: "Away", score: "17" }] };
      const responses = [new Response("[]"), new Response(JSON.stringify([scoreOnly]))];
      await expect(new OddsIngestion(db, new TheOddsApiProvider("key", async () => responses.shift()!), { now: () => new Date("2026-09-09T06:01:00.000Z") }).poll()).rejects.toThrow();
      await assertRetained();
    }

    for (const price of [0, Number.MAX_SAFE_INTEGER + 1]) {
      const rawOdds = { id: eventId, commence_time: "2026-09-10T20:00:00.000Z", home_team: "Home", away_team: "Away", bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "spreads", outcomes: [{ name: "Home", price, point: -3.5 }, { name: "Away", price: -110, point: 3.5 }] }] }] };
      const goodScore = { id: eventId, commence_time: "2026-09-10T20:00:00.000Z", home_team: "Home", away_team: "Away", completed: true, scores: [{ name: "Home", score: "24" }, { name: "Away", score: "17" }] };
      const responses = [new Response(JSON.stringify([rawOdds])), new Response(JSON.stringify([goodScore]))];
      await expect(new OddsIngestion(db, new TheOddsApiProvider("key", async () => responses.shift()!), { now: () => new Date("2026-09-09T06:01:00.000Z") }).poll()).rejects.toThrow();
      await assertRetained();
    }

    for (const price of [0, Number.MAX_SAFE_INTEGER + 1]) {
      const malformed = event({ id: eventId, status: "final", homeScore: 24, awayScore: 17, bookmakers: [{ key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "Home", price, point: -3.5 }, { name: "Away", price: -110, point: 3.5 }] }] }] });
      await expect(new OddsIngestion(db, new Provider([malformed]), { now: () => new Date("2026-09-09T06:01:00.000Z") }).poll()).rejects.toThrow();
      await assertRetained();
    }
    expect(await db.prepare("SELECT last_error FROM odds_ingestion WHERE provider='odds'").first<{ last_error: string }>()).toMatchObject({ last_error: expect.stringMatching(/^Malformed provider response:/) });
  }, 30_000);

  it("rejects a later score-only event whose ordered sides differ from the persisted event without mutating last-good D1 or PoolDO settlement state", async () => {
    const eventId = "persisted-sides";
    await new OddsIngestion(db, new Provider([event({ id: eventId, status: "final", homeScore: 24, awayScore: 17 })]), { now: () => new Date("2026-09-09T00:00:00.000Z") }).poll();
    await db.exec(`UPDATE sports_event SET last_polled_at='2026-09-09T00:00:00.000Z' WHERE provider_event_id='${eventId}'; UPDATE odds_league_poll SET last_discovery_at='2026-09-09T06:01:00.000Z' WHERE league='ncaaf';`);
    const { snapshot } = await settledWagerPool(eventId);
    const beforeDurable = await snapshot();
    expect(JSON.parse(String(beforeDurable.wager))).toEqual([expect.objectContaining({ id: "wager", status: "won" })]);
    const beforeD1 = await lastGoodD1Snapshot();

    const scoreOnly = { id: eventId, commence_time: "2026-09-10T20:00:00.000Z", home_team: "Away", away_team: "Home", completed: true, scores: [{ name: "Away", score: "17" }, { name: "Home", score: "24" }] };
    const responses = [new Response("[]"), new Response(JSON.stringify([scoreOnly]))];
    await expect(new OddsIngestion(db, new TheOddsApiProvider("key", async () => responses.shift()!), { now: () => new Date("2026-09-09T06:01:00.000Z") }).poll()).rejects.toThrow(`Immutable provider event sides changed: ${eventId}`);
    expect((await lastGoodD1Snapshot())).toEqual(beforeD1);
    expect(await db.prepare("SELECT last_error FROM odds_ingestion WHERE provider='odds'").first()).toEqual({ last_error: `Immutable provider event sides changed: ${eventId}` });
    expect(await snapshot()).toEqual(beforeDurable);
  }, 30_000);

  it.each(["forward", "reverse"])("rejects duplicate raw odds IDs before %s-order collapse and retains last-good D1 bytes", async (order) => {
    await new OddsIngestion(db, new Provider([event({ id: "last-good" })]), { now: () => new Date("2026-09-09T00:00:00.000Z") }).poll();
    const beforeEvents = (await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results;
    const beforeOffers = (await db.prepare("SELECT * FROM market_offer ORDER BY event_id,market").all()).results;
    await db.prepare("UPDATE odds_league_poll SET last_discovery_at='2026-09-09T06:01:00.000Z' WHERE league='ncaaf'").run();
    const raw = { id: "raw-duplicate", commence_time: "2026-09-10T20:00:00.000Z", home_team: "Home", away_team: "Away", bookmakers: [] };
    const duplicate = { ...raw, home_team: "Contradictory Home" };
    const responses = [new Response(JSON.stringify(order === "forward" ? [raw, duplicate] : [duplicate, raw])), new Response("[]")];
    const adapter = new TheOddsApiProvider("key", async () => responses.shift()!);
    await expect(new OddsIngestion(db, adapter, { now: () => new Date("2026-09-09T06:01:00.000Z") }).poll()).rejects.toThrow("Duplicate raw odds event ID: raw-duplicate");
    expect((await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results).toEqual(beforeEvents);
    expect((await db.prepare("SELECT * FROM market_offer ORDER BY event_id,market").all()).results).toEqual(beforeOffers);
    expect(await db.prepare("SELECT last_error FROM odds_ingestion WHERE provider='odds'").first()).toEqual({ last_error: "Duplicate raw odds event ID: raw-duplicate" });
  });

  it.each(["forward", "reverse"])("rejects duplicate raw score IDs before %s-order collapse and retains last-good D1 bytes", async (order) => {
    await new OddsIngestion(db, new Provider([event({ id: "last-good" })]), { now: () => new Date("2026-09-09T00:00:00.000Z") }).poll();
    const beforeEvents = (await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results;
    const beforeOffers = (await db.prepare("SELECT * FROM market_offer ORDER BY event_id,market").all()).results;
    await db.prepare("UPDATE odds_league_poll SET last_discovery_at='2026-09-09T06:01:00.000Z' WHERE league='ncaaf'").run();
    const raw = { id: "score-duplicate", commence_time: "2026-09-10T20:00:00.000Z", home_team: "Home", away_team: "Away", completed: true, scores: [] };
    const duplicate = { ...raw, completed: false };
    const responses = [new Response("[]"), new Response(JSON.stringify(order === "forward" ? [raw, duplicate] : [duplicate, raw]))];
    const adapter = new TheOddsApiProvider("key", async () => responses.shift()!);
    await expect(new OddsIngestion(db, adapter, { now: () => new Date("2026-09-09T06:01:00.000Z") }).poll()).rejects.toThrow("Duplicate raw score event ID: score-duplicate");
    expect((await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results).toEqual(beforeEvents);
    expect((await db.prepare("SELECT * FROM market_offer ORDER BY event_id,market").all()).results).toEqual(beforeOffers);
    expect(await db.prepare("SELECT last_error FROM odds_ingestion WHERE provider='odds'").first()).toEqual({ last_error: "Duplicate raw score event ID: score-duplicate" });
  });

  it.each(["forward", "reverse"])("rejects duplicate normalized score-team identities through ingestion independent of %s order", async (order) => {
    await new OddsIngestion(db, new Provider([event({ id: "last-good" })]), { now: () => new Date("2026-09-09T00:00:00.000Z") }).poll();
    const beforeEvents = (await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results;
    const beforeOffers = (await db.prepare("SELECT * FROM market_offer ORDER BY event_id,market").all()).results;
    const beforeGoodFeed = await db.prepare("SELECT canonical_book_availability_json,last_success_at FROM odds_ingestion WHERE provider='odds'").first();
    await db.prepare("UPDATE odds_league_poll SET last_discovery_at='2026-09-09T06:01:00.000Z' WHERE league='ncaaf'").run();
    const duplicateScores = [
      { name: "Home", score: "21" },
      { name: " home ", score: "99" },
      { name: "Away", score: "17" }
    ];
    const rawScore = { id: "nested-duplicate", commence_time: "2026-09-10T20:00:00.000Z", home_team: "Home", away_team: "Away", completed: true, scores: order === "forward" ? duplicateScores : [...duplicateScores].reverse() };
    const responses = [new Response("[]"), new Response(JSON.stringify([rawScore]))];
    const adapter = new TheOddsApiProvider("key", async () => responses.shift()!);
    await expect(new OddsIngestion(db, adapter, { now: () => new Date("2026-09-09T06:01:00.000Z") }).poll()).rejects.toThrow("Duplicate raw score team identity: home");
    expect((await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results).toEqual(beforeEvents);
    expect((await db.prepare("SELECT * FROM market_offer ORDER BY event_id,market").all()).results).toEqual(beforeOffers);
    expect(await db.prepare("SELECT canonical_book_availability_json,last_success_at FROM odds_ingestion WHERE provider='odds'").first()).toEqual(beforeGoodFeed);
    expect(await db.prepare("SELECT last_error FROM odds_ingestion WHERE provider='odds'").first()).toEqual({ last_error: "Duplicate raw score team identity: home" });
  });

  it("normalizes fixture-backed score-only events and real Super Bowl metadata", async () => {
    const responses = [new Response(JSON.stringify(nflFixture)), new Response(JSON.stringify(nflScoresFixture))];
    const provider = new TheOddsApiProvider("key", async () => responses.shift()!, () => new Date("2026-08-01T00:00:00.000Z"));
    const { events } = await provider.events("nfl");
    const normalized = events.find((item) => item.id === "fixture-nfl-final")!;
    const live = events.find((item) => item.id === "fixture-nfl-live")!;
    expect(normalized).toMatchObject({ status: "final", homeScore: 24, awayScore: 17, eventName: "Super Bowl LX", postseason: true });
    expect(live).toMatchObject({ status: "in_progress", homeScore: 7, awayScore: 3, bookmakers: [] });
    expect(isSuperBowl(normalized)).toBe(true);
  });

  it("writes offers and final/correction versions D1-first for result-source readers", async () => {
    const first = event({ status: "final", homeScore: 24, awayScore: 17, postseason: true, eventName: "Super Bowl LX" });
    const ingestion = new OddsIngestion(db, new Provider([first]), { now: () => new Date("2026-09-10T00:00:00.000Z") });
    await ingestion.poll();
    expect(await db.prepare("SELECT canonical_book FROM market_offer WHERE event_id = ? AND market = 'spread'").bind("event-1").first()).toMatchObject({ canonical_book: "DraftKings" });
    const source = new D1ResultSource(db);
    expect(await source.getFinalResults(["event-1"])).toEqual([expect.objectContaining({ eventId: "event-1", correctionVersion: "1", homeScore: 24, awayScore: 17 })]);
    await new OddsIngestion(db, new Provider([event({ status: "final", homeScore: 27, awayScore: 17 })]), { now: () => new Date("2026-09-10T00:15:00.000Z") }).poll();
    expect(await source.getFinalResults(["event-1"])).toEqual([expect.objectContaining({ correctionVersion: "2", homeScore: 27 })]);
    expect(isSuperBowl(first)).toBe(true);
  });

  it("removes a disappeared market from current D1 offers", async () => {
    await new OddsIngestion(db, new Provider([event()]), { now: () => new Date("2026-09-10T00:00:00.000Z") }).poll();
    await new OddsIngestion(db, new Provider([event({ bookmakers: [] })]), { now: () => new Date("2026-09-10T00:30:00.000Z") }).poll();
    expect(await new OfferQuotes(db).current(event(), "spread", new Date("2026-09-10T00:30:00.000Z"))).toBeNull();
  });

  it("records outages and separates the polling and stale windows", async () => {
    await new OddsIngestion(db, new Provider([event()]), { now: () => new Date("2026-09-09T18:00:00.000Z") }).poll();
    const failing: IngestionProvider = { events: async () => { throw new Error("provider unavailable"); } };
    await expect(new OddsIngestion(db, failing, { now: () => new Date("2026-09-10T00:01:00.000Z") }).poll()).rejects.toThrow("provider unavailable");
    expect(await db.prepare("SELECT last_error, last_success_at FROM odds_ingestion WHERE provider = 'odds'").first()).toMatchObject({ last_error: "provider unavailable", last_success_at: "2026-09-09T18:00:00.000Z" });
    const now = new Date("2026-09-10T00:00:00.000Z");
    const distant = event({ commenceTime: "2026-09-12T00:00:00.000Z" });
    const withinDay = event({ commenceTime: "2026-09-10T12:00:00.000Z" });
    expect(pollInterval(distant, now)).toBe(20 * 60 * 1000);
    expect(pollInterval(event({ commenceTime: "2026-09-11T00:00:00.001Z" }), now)).toBe(20 * 60 * 1000);
    expect(pollInterval(event({ commenceTime: "2026-09-11T00:00:00.000Z" }), now)).toBe(5 * 60 * 1000);
    expect(pollInterval(withinDay, now)).toBe(5 * 60 * 1000);
    expect(pollInterval(event({ commenceTime: now.toISOString() }), now)).toBe(2 * 60 * 1000);
    expect(pollInterval(event({ commenceTime: "2026-09-10T00:30:00.000Z" }), now)).toBe(5 * 60 * 1000);
    expect(pollInterval(event({ status: "in_progress" }), now)).toBe(2 * 60 * 1000);
    expect(pollInterval(event({ status: "final" }), now)).toBe(5 * 60 * 1000);
    expect(shouldPollEvent(distant, new Date(now.getTime() - 19 * 60 * 1000), now)).toBe(false);
    expect(shouldPollEvent(distant, new Date(now.getTime() - 20 * 60 * 1000), now)).toBe(true);
    expect(shouldPollEvent(withinDay, new Date(now.getTime() - 4 * 60 * 1000), now)).toBe(false);
    expect(shouldPollEvent(withinDay, new Date(now.getTime() - 5 * 60 * 1000), now)).toBe(true);
    const finalized = new Date("2026-09-09T00:00:00.000Z");
    expect(finalReconciliationDue(finalized, undefined, new Date("2026-09-09T00:04:00.000Z"))).toBe(false);
    expect(finalReconciliationDue(finalized, undefined, new Date("2026-09-09T00:05:00.000Z"))).toBe(true);
    expect(finalReconciliationDue(finalized, new Date("2026-09-09T00:06:00.000Z"), new Date("2026-09-09T01:59:00.000Z"))).toBe(false);
    expect(finalReconciliationDue(finalized, new Date("2026-09-09T00:06:00.000Z"), new Date("2026-09-09T02:00:00.000Z"))).toBe(true);
    expect(finalReconciliationDue(finalized, new Date("2026-09-09T02:01:00.000Z"), new Date("2026-09-09T23:59:00.000Z"))).toBe(false);
    expect(finalReconciliationDue(finalized, new Date("2026-09-09T02:01:00.000Z"), new Date("2026-09-10T00:00:00.000Z"))).toBe(true);
  });

  it("uses a fixed 30-minute stale boundary for upcoming offers", () => {
    const now = new Date("2026-09-10T00:00:00.000Z");
    expect(offerIsStale(new Date(now.getTime() - 30 * 60 * 1000).toISOString(), now)).toBe(false);
    expect(offerIsStale(new Date(now.getTime() - 30 * 60 * 1000 - 1).toISOString(), now)).toBe(true);
  });

  it("applies the fixed stale boundary to distant quote reads", async () => {
    const at = new Date("2026-09-10T00:00:00.000Z");
    const distant = event({ commenceTime: "2027-09-10T20:00:00.000Z" });
    await new OddsIngestion(db, new Provider([distant]), { now: () => at }).poll();
    const quotes = new OfferQuotes(db);
    await expect(quotes.current(distant, "spread", new Date(at.getTime() + 29 * 60 * 1000))).resolves.not.toBeNull();
    await expect(quotes.current(distant, "spread", new Date(at.getTime() + 30 * 60 * 1000 + 1))).resolves.toBeNull();
  });

  it("runs terminal reconciliation at five minutes, two hours, and 24 hours when discovery is not due", async () => {
    const at = new Date("2026-09-09T00:00:00.000Z");
    const terminalEvent = event({ status: "final", homeScore: 21, awayScore: 17 });
    const provider = new Provider([terminalEvent]);
    await new OddsIngestion(db, provider, { now: () => at }).poll();
    provider.calls.length = 0;
    await new OddsIngestion(db, provider, { now: () => new Date(at.getTime() + 4 * 60 * 1000) }).poll();
    expect(provider.calls).toEqual([]);
    await new OddsIngestion(db, provider, { now: () => new Date(at.getTime() + 5 * 60 * 1000) }).poll();
    expect(provider.calls).toEqual(["nfl"]);
    provider.calls.length = 0;
    await new OddsIngestion(db, provider, { now: () => new Date(at.getTime() + 6 * 60 * 1000) }).poll();
    expect(provider.calls).toEqual([]);

    await db.prepare("UPDATE odds_league_poll SET last_discovery_at = ?").bind(new Date(at.getTime() + 118 * 60 * 1000).toISOString()).run();
    await new OddsIngestion(db, provider, { now: () => new Date(at.getTime() + 119 * 60 * 1000) }).poll();
    expect(provider.calls).toEqual([]);
    await new OddsIngestion(db, provider, { now: () => new Date(at.getTime() + 2 * 60 * 60 * 1000) }).poll();
    expect(provider.calls).toEqual(["nfl"]);
    provider.calls.length = 0;
    await new OddsIngestion(db, provider, { now: () => new Date(at.getTime() + 2 * 60 * 60 * 1000 + 60 * 1000) }).poll();
    expect(provider.calls).toEqual([]);

    await db.prepare("UPDATE odds_league_poll SET last_discovery_at = ?").bind(new Date(at.getTime() + 24 * 60 * 60 * 1000 - 60 * 1000).toISOString()).run();
    await new OddsIngestion(db, provider, { now: () => new Date(at.getTime() + 24 * 60 * 60 * 1000) }).poll();
    expect(provider.calls).toEqual(["nfl"]);
  });

  it("preserves the provider failure when recording failure health also fails", async () => {
    await new OddsIngestion(db, new Provider([event()]), { now: () => new Date("2026-09-09T00:00:00.000Z") }).poll();
    await db.exec("CREATE TRIGGER ingestion_fail_health_write BEFORE UPDATE ON odds_ingestion WHEN NEW.last_error IS NOT NULL BEGIN SELECT RAISE(ABORT, 'induced health write failure'); END;");
    try {
      const unavailable: IngestionProvider = { events: async () => { throw new Error("original provider failure"); } };
      await expect(new OddsIngestion(db, unavailable, { now: () => new Date("2026-09-10T00:00:00.000Z") }).poll()).rejects.toThrow("original provider failure");
    } finally {
      await db.exec("DROP TRIGGER ingestion_fail_health_write;");
    }
  });

  it("preserves feed state on no-op and merges availability from undued leagues", async () => {
    const nfl = event({ id: "nfl-event" }); const ncaaf = event({ id: "ncaaf-event", sport: "ncaaf", commenceTime: "2026-09-12T20:00:00.000Z" });
    const provider = new Provider([nfl, ncaaf]);
    await new OddsIngestion(db, provider, { now: () => new Date("2026-09-09T00:00:00.000Z") }).poll();
    const before = await db.prepare("SELECT last_success_at, canonical_book_availability_json FROM odds_ingestion WHERE provider='odds'").first();
    provider.calls.length = 0;
    await new OddsIngestion(db, provider, { now: () => new Date("2026-09-09T00:01:00.000Z") }).poll();
    expect(provider.calls).toEqual([]);
    expect(await db.prepare("SELECT last_success_at, canonical_book_availability_json FROM odds_ingestion WHERE provider='odds'").first()).toEqual(before);

    // Keep NCAAF undued while NFL is due; fetched NFL availability must not erase it.
    await db.exec("UPDATE odds_league_poll SET last_discovery_at='2026-09-09T06:00:00.000Z' WHERE league='ncaaf'; UPDATE sports_event SET last_polled_at='2026-09-09T06:00:00.000Z' WHERE provider_event_id='ncaaf-event';");
    await new OddsIngestion(db, new Provider([event({ id: "nfl-event", bookmakers: [] }), ncaaf]), { now: () => new Date("2026-09-09T06:01:00.000Z") }).poll();
    const availability = JSON.parse(String((await db.prepare("SELECT canonical_book_availability_json FROM odds_ingestion WHERE provider='odds'").first<{ canonical_book_availability_json: string }>())!.canonical_book_availability_json));
    expect(availability).toMatchObject({ "nfl-event": [], "ncaaf-event": ["spread", "total", "moneyline"] });
  });

  it("fails closed after a malformed due short-window poll without refreshing a filtered long-window offer", async () => {
    const at = new Date("2026-09-09T00:00:00.000Z");
    const short = event({ id: "short-window", commenceTime: "2026-09-09T00:30:00.000Z" });
    const long = event({ id: "long-window", commenceTime: "2026-09-12T00:00:00.000Z" });
    await new OddsIngestion(db, new Provider([short, long]), { now: () => at }).poll();
    const quotes = new OfferQuotes(db);
    expect(await quotes.current(long, "spread", new Date("2026-09-09T00:06:00.000Z"))).not.toBeNull();
    const before = await db.prepare("SELECT payload_json, retrieved_at FROM market_offer WHERE event_id='long-window' AND market='spread'").first();
    const malformed: IngestionProvider = { events: async (league) => ({ events: league === "nfl" ? [{ ...short, homeTeam: "" }, long] as ProviderEvent[] : [] }) };
    await expect(new OddsIngestion(db, malformed, { now: () => new Date("2026-09-09T00:06:00.000Z") }).poll()).rejects.toThrow();
    expect(await db.prepare("SELECT payload_json, retrieved_at FROM market_offer WHERE event_id='long-window' AND market='spread'").first()).toEqual(before);
    expect(await db.prepare("SELECT last_polled_at, last_success_at, last_error FROM odds_ingestion WHERE provider='odds'").first()).toMatchObject({ last_polled_at: "2026-09-09T00:06:00.000Z", last_success_at: "2026-09-09T00:00:00.000Z", last_error: expect.stringMatching(/^Malformed provider response:/) });
    expect(await quotes.current(long, "spread", new Date("2026-09-09T00:06:00.000Z"))).toBeNull();
  });

  it("precomputes every mixed poll and preserves all last-good bytes on semantic failure", async () => {
    const firstNfl = event({ id: "nfl-good" });
    const firstNcaaf = event({ id: "ncaaf-good", sport: "ncaaf" });
    await new OddsIngestion(db, new Provider([firstNfl, firstNcaaf]), { now: () => new Date("2026-09-09T00:00:00.000Z") }).poll();
    const beforeEvents = (await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results;
    const beforeOffers = (await db.prepare("SELECT * FROM market_offer ORDER BY event_id, market").all()).results;
    const beforeFeed = await db.prepare("SELECT canonical_book_availability_json, last_success_at FROM odds_ingestion WHERE provider='odds'").first();
    const changedNfl = event({ id: "nfl-good", status: "in_progress" });
    const invalidNcaaf = event({ id: "ncaaf-good", sport: "ncaaf", bookmakers: [
      { key: "draftkings", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] }] },
      { key: "other", title: "DraftKings", markets: [{ key: "spread", outcomes: [{ name: "Home", price: -120, point: -4 }, { name: "Away", price: 100, point: 4 }] }] }
    ] });
    await expect(new OddsIngestion(db, new Provider([changedNfl, invalidNcaaf]), { now: () => new Date("2026-09-09T06:01:00.000Z") }).poll()).rejects.toThrow("Duplicate configured bookmaker");
    expect((await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results).toEqual(beforeEvents);
    expect((await db.prepare("SELECT * FROM market_offer ORDER BY event_id, market").all()).results).toEqual(beforeOffers);
    expect(await db.prepare("SELECT canonical_book_availability_json, last_success_at FROM odds_ingestion WHERE provider='odds'").first()).toEqual(beforeFeed);
    expect(await db.prepare("SELECT last_polled_at, last_error FROM odds_ingestion WHERE provider='odds'").first()).toMatchObject({ last_polled_at: "2026-09-09T06:01:00.000Z", last_error: "Duplicate configured bookmaker: DraftKings" });
    expect(await new OfferQuotes(db).current(firstNfl, "spread", new Date("2026-09-09T06:01:00.000Z"))).toBeNull();
  });

  it("atomically replaces a multi-league poll and preserves only bounded failure health on a mid-batch error", async () => {
    const nfl = event({ id: "atomic-nfl", status: "final", homeScore: 21, awayScore: 17 });
    const ncaaf = event({ id: "atomic-ncaaf", sport: "ncaaf", homeTeam: "College Home", awayTeam: "College Away" });
    await new OddsIngestion(db, new Provider([nfl, ncaaf]), { now: () => new Date("2026-09-09T00:00:00.000Z") }).poll();
    await db.exec("CREATE TRIGGER ingestion_fail_offer_insert BEFORE INSERT ON market_offer WHEN NEW.event_id = 'atomic-ncaaf' BEGIN SELECT RAISE(ABORT, 'induced offer insert failure'); END;");

    const beforeEvents = (await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results;
    const beforeOffers = (await db.prepare("SELECT * FROM market_offer ORDER BY event_id, market").all()).results;
    const beforeLeagues = (await db.prepare("SELECT * FROM odds_league_poll ORDER BY league").all()).results;
    const beforeFeed = await db.prepare("SELECT quota_json, last_success_at, canonical_book_availability_json FROM odds_ingestion WHERE provider='odds'").first();

    const changedNfl = event({ id: "atomic-nfl", status: "final", homeScore: 24, awayScore: 17, bookmakers: [] });
    const changedNcaaf = event({ id: "atomic-ncaaf", sport: "ncaaf", homeTeam: "College Home", awayTeam: "College Away" });
    await expect(new OddsIngestion(db, new Provider([changedNfl, changedNcaaf], { remaining: 3, used: 97 }), { now: () => new Date("2026-09-09T06:01:00.000Z") }).poll()).rejects.toThrow("induced offer insert failure");

    expect((await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results).toEqual(beforeEvents);
    expect((await db.prepare("SELECT * FROM market_offer ORDER BY event_id, market").all()).results).toEqual(beforeOffers);
    expect((await db.prepare("SELECT * FROM odds_league_poll ORDER BY league").all()).results).toEqual(beforeLeagues);
    expect(await db.prepare("SELECT quota_json, last_success_at, canonical_book_availability_json FROM odds_ingestion WHERE provider='odds'").first()).toEqual(beforeFeed);
    expect(await db.prepare("SELECT last_polled_at, last_error FROM odds_ingestion WHERE provider='odds'").first()).toMatchObject({ last_polled_at: "2026-09-09T06:01:00.000Z", last_error: expect.stringContaining("induced offer insert failure") });

    await db.exec("DROP TRIGGER ingestion_fail_offer_insert;");
    const recovered = await new OddsIngestion(db, new Provider([changedNfl, changedNcaaf], { remaining: 3, used: 97 }), { now: () => new Date("2026-09-09T06:02:00.000Z") }).poll();
    expect(recovered).toEqual({ events: 2, offers: 3 });
    expect(await db.prepare("SELECT home_team, home_score, correction_version FROM sports_event WHERE provider_event_id='atomic-nfl'").first()).toMatchObject({ home_team: "Home", home_score: "24", correction_version: "2" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM market_offer").first()).toEqual({ count: 3 });
    expect(await db.prepare("SELECT last_success_at, last_error FROM odds_ingestion WHERE provider='odds'").first()).toMatchObject({ last_success_at: "2026-09-09T06:02:00.000Z", last_error: null });
  });

  it.each([
    ["same-league forward", [event({ id: "duplicate" }), event({ id: "duplicate", homeTeam: "Contradictory" })]],
    ["same-league reverse", [event({ id: "duplicate", homeTeam: "Contradictory" }), event({ id: "duplicate" })]],
    ["cross-league forward", [event({ id: "duplicate" }), event({ id: "duplicate", sport: "ncaaf", homeTeam: "Contradictory" })]],
    ["cross-league reverse", [event({ id: "duplicate", sport: "ncaaf", homeTeam: "Contradictory" }), event({ id: "duplicate" })]]
  ])("rejects normalized duplicate IDs before collapse (%s) and preserves last-good bytes", async (_label, duplicates) => {
    await new OddsIngestion(db, new Provider([event({ id: "last-good" })]), { now: () => new Date("2026-09-09T00:00:00.000Z") }).poll();
    const beforeEvents = (await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results;
    const beforeOffers = (await db.prepare("SELECT * FROM market_offer ORDER BY event_id, market").all()).results;
    await expect(new OddsIngestion(db, new Provider(duplicates), { now: () => new Date("2026-09-09T06:01:00.000Z") }).poll()).rejects.toThrow("Duplicate normalized event ID: duplicate");
    expect((await db.prepare("SELECT * FROM sports_event ORDER BY provider_event_id").all()).results).toEqual(beforeEvents);
    expect((await db.prepare("SELECT * FROM market_offer ORDER BY event_id, market").all()).results).toEqual(beforeOffers);
  });

  it("claims current metadata and rechecks scheduling after a pre-claim success", async () => {
    const nfl = event({ id: "nfl-current" });
    const ncaaf = event({ id: "ncaaf-current", sport: "ncaaf" });
    await new OddsIngestion(db, new Provider([nfl, ncaaf]), { now: () => new Date("2026-09-10T00:00:00.000Z") }).poll();
    await db.exec("UPDATE sports_event SET last_polled_at=CASE WHEN league='nfl' THEN '2026-09-09T00:00:00.000Z' ELSE '2026-09-10T06:00:00.000Z' END; UPDATE odds_league_poll SET last_discovery_at=CASE WHEN league='nfl' THEN '2026-09-09T00:00:00.000Z' ELSE '2026-09-10T06:00:00.000Z' END;");

    const barrier = new ClaimBarrier();
    const staleProvider = new Provider([event({ id: "nfl-current" }), ncaaf]);
    const stalePoll = new OddsIngestion(db, staleProvider, { now: () => new Date("2026-09-10T06:01:00.000Z") }, barrier.wait).poll();
    await barrier.entered;

    await new OddsIngestion(db, new Provider([event({ id: "nfl-current", bookmakers: [] }), ncaaf]), { now: () => new Date("2026-09-10T06:01:00.000Z") }).poll();
    const afterCurrentSuccess = await db.prepare("SELECT last_polled_at,last_success_at,last_error,canonical_book_availability_json FROM odds_ingestion WHERE provider='odds'").first();
    barrier.release();
    expect(await stalePoll).toEqual({ events: 0, offers: 0 });
    expect(staleProvider.calls).toEqual([]);
    expect(await db.prepare("SELECT last_polled_at,last_success_at,last_error,canonical_book_availability_json FROM odds_ingestion WHERE provider='odds'").first()).toEqual(afterCurrentSuccess);
    expect(JSON.parse(String((afterCurrentSuccess as { canonical_book_availability_json: string }).canonical_book_availability_json))).toMatchObject({ "nfl-current": [], "ncaaf-current": ["spread", "total", "moneyline"] });
  });

  it("uses the post-claim due set and merges availability from a pre-claim success", async () => {
    const nfl = event({ id: "nfl-due" }); const ncaaf = event({ id: "ncaaf-due", sport: "ncaaf" });
    await new OddsIngestion(db, new Provider([nfl, ncaaf]), { now: () => new Date("2026-09-10T00:00:00.000Z") }).poll();
    await db.exec("UPDATE sports_event SET last_polled_at=CASE WHEN league='nfl' THEN '2026-09-09T00:00:00.000Z' ELSE '2026-09-10T06:00:00.000Z' END; UPDATE odds_league_poll SET last_discovery_at=CASE WHEN league='nfl' THEN '2026-09-09T00:00:00.000Z' ELSE '2026-09-10T06:00:00.000Z' END;");
    const barrier = new ClaimBarrier(); const provider = new Provider([nfl, ncaaf]);
    const poll = new OddsIngestion(db, provider, { now: () => new Date("2026-09-10T06:01:00.000Z") }, barrier.wait).poll();
    await barrier.entered;
    await new OddsIngestion(db, new Provider([event({ id: "nfl-due", bookmakers: [] }), ncaaf]), { now: () => new Date("2026-09-10T06:01:00.000Z") }).poll();
    await db.exec("UPDATE sports_event SET last_polled_at='2026-09-09T00:00:00.000Z' WHERE league='ncaaf'; UPDATE odds_league_poll SET last_discovery_at='2026-09-09T00:00:00.000Z' WHERE league='ncaaf';");
    barrier.release();
    expect(await poll).toEqual({ events: 1, offers: 3 });
    expect(provider.calls).toEqual(["ncaaf"]);
    const availability = JSON.parse(String((await db.prepare("SELECT canonical_book_availability_json FROM odds_ingestion WHERE provider='odds'").first<{ canonical_book_availability_json: string }>())!.canonical_book_availability_json));
    expect(availability).toMatchObject({ "nfl-due": [], "ncaaf-due": ["spread", "total", "moneyline"] });
  });

  it("recovers from an intervening pre-claim failure with a claimed timestamp floor and generation-fenced health", async () => {
    const nfl = event({ id: "nfl-preclaim-failure" });
    const ncaaf = event({ id: "ncaaf-preclaim-failure", sport: "ncaaf" });
    await new OddsIngestion(db, new Provider([nfl, ncaaf]), { now: () => new Date("2026-09-10T00:00:00.000Z") }).poll();
    await db.exec("UPDATE sports_event SET last_polled_at=CASE WHEN league='nfl' THEN '2026-09-09T00:00:00.000Z' ELSE '2026-09-10T06:00:00.000Z' END; UPDATE odds_league_poll SET last_discovery_at=CASE WHEN league='nfl' THEN '2026-09-09T00:00:00.000Z' ELSE '2026-09-10T06:00:00.000Z' END;");
    const beforeAvailability = await db.prepare("SELECT canonical_book_availability_json,last_success_at FROM odds_ingestion WHERE provider='odds'").first();

    const barrier = new ClaimBarrier();
    const recovering = new Provider([event({ id: "nfl-preclaim-failure", bookmakers: [] }), ncaaf]);
    const recoveryPoll = new OddsIngestion(db, recovering, { now: () => new Date("2026-09-10T06:00:00.000Z") }, barrier.wait).poll();
    await barrier.entered;

    const failed = new OddsIngestion(db, { events: async () => { throw new Error("intervening pre-claim failure"); } }, { now: () => new Date("2026-09-10T06:01:00.000Z") });
    await expect(failed.poll()).rejects.toThrow("intervening pre-claim failure");
    expect(await db.prepare("SELECT poll_generation,last_polled_at,last_success_at,last_error,canonical_book_availability_json FROM odds_ingestion WHERE provider='odds'").first()).toEqual({ poll_generation: 2, last_polled_at: "2026-09-10T06:01:00.000Z", last_success_at: "2026-09-10T00:00:00.000Z", last_error: "intervening pre-claim failure", canonical_book_availability_json: (beforeAvailability as { canonical_book_availability_json: string }).canonical_book_availability_json });

    barrier.release();
    expect(await recoveryPoll).toEqual({ events: 1, offers: 0 });
    expect(recovering.calls).toEqual(["nfl"]);
    expect(await db.prepare("SELECT poll_generation,last_polled_at,last_success_at,last_error FROM odds_ingestion WHERE provider='odds'").first()).toEqual({ poll_generation: 3, last_polled_at: "2026-09-10T06:01:00.000Z", last_success_at: "2026-09-10T06:01:00.000Z", last_error: null });
    const availability = JSON.parse(String((await db.prepare("SELECT canonical_book_availability_json FROM odds_ingestion WHERE provider='odds'").first<{ canonical_book_availability_json: string }>())!.canonical_book_availability_json));
    expect(availability).toMatchObject({ "nfl-preclaim-failure": [], "ncaaf-preclaim-failure": ["spread", "total", "moneyline"] });
    expect(await db.prepare("SELECT last_polled_at FROM sports_event WHERE provider_event_id='nfl-preclaim-failure'").first()).toEqual({ last_polled_at: "2026-09-10T06:01:00.000Z" });
    const staleFailure = await db.prepare("UPDATE odds_ingestion SET last_error='stale failure' WHERE provider='odds' AND poll_generation=?").bind(2).run();
    expect(staleFailure.meta.changes).toBe(0);
    expect(await db.prepare("SELECT last_error FROM odds_ingestion WHERE provider='odds'").first()).toEqual({ last_error: null });
  });

  it.each(["newer-first", "older-first"])("makes the newer generation win overlapping successes (%s), including equal timestamps", async (order) => {
    await db.prepare("INSERT INTO odds_league_poll (league,last_discovery_at) VALUES ('ncaaf','2026-09-10T00:00:00.000Z')").run();
    const older = new DeferredProvider(); const newer = new DeferredProvider();
    const at = { now: () => new Date("2026-09-10T00:00:00.000Z") };
    const olderPoll = new OddsIngestion(db, older, at).poll(); await older.called;
    const newerPoll = new OddsIngestion(db, newer, at).poll(); await newer.called;
    const oldEvent = event({ status: "final", homeScore: 10, awayScore: 7 });
    const newEvent = event({ status: "final", homeScore: 21, awayScore: 17, bookmakers: [] });
    if (order === "newer-first") {
      newer.resolve({ events: [newEvent] }); expect(await newerPoll).toEqual({ events: 1, offers: 0 });
      older.resolve({ events: [oldEvent] }); expect(await olderPoll).toEqual({ events: 0, offers: 0 });
    } else {
      older.resolve({ events: [oldEvent] }); expect(await olderPoll).toEqual({ events: 0, offers: 0 });
      newer.resolve({ events: [newEvent] }); expect(await newerPoll).toEqual({ events: 1, offers: 0 });
    }
    expect(await db.prepare("SELECT home_score, away_score, correction_version, last_polled_at FROM sports_event WHERE provider_event_id='event-1'").first()).toMatchObject({ home_score: "21", away_score: "17", correction_version: "1", last_polled_at: "2026-09-10T00:00:00.000Z" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM market_offer").first()).toEqual({ count: 0 });
  });

  it("does not regress persisted times when a later generation uses a backward custom clock", async () => {
    await new OddsIngestion(db, new Provider([event()]), { now: () => new Date("2026-09-10T00:05:00.000Z") }).poll();
    await db.exec("UPDATE sports_event SET last_polled_at='2026-09-09T00:00:00.000Z'; UPDATE odds_league_poll SET last_discovery_at='2026-09-09T00:00:00.000Z' WHERE league='nfl';");
    await new OddsIngestion(db, new Provider([event({ status: "in_progress" })]), { now: () => new Date("2026-09-10T00:04:00.000Z") }).poll();
    expect(await db.prepare("SELECT last_polled_at,last_success_at FROM odds_ingestion WHERE provider='odds'").first()).toMatchObject({ last_polled_at: "2026-09-10T00:05:00.000Z", last_success_at: "2026-09-10T00:05:00.000Z" });
    expect(await db.prepare("SELECT last_polled_at FROM sports_event WHERE provider_event_id='event-1'").first()).toEqual({ last_polled_at: "2026-09-10T00:05:00.000Z" });
    expect(await db.prepare("SELECT retrieved_at FROM market_offer WHERE event_id='event-1' LIMIT 1").first()).toEqual({ retrieved_at: "2026-09-10T00:05:00.000Z" });
  });

  it("prevents stale failures from restoring errors and stale successes from replacing a newer failure", async () => {
    await db.prepare("INSERT INTO odds_league_poll (league,last_discovery_at) VALUES ('ncaaf','2026-09-10T00:00:00.000Z')").run();
    const older = new DeferredProvider(); const newer = new DeferredProvider();
    const olderPoll = new OddsIngestion(db, older, { now: () => new Date("2026-09-10T00:00:00.000Z") }).poll(); await older.called;
    const newerPoll = new OddsIngestion(db, newer, { now: () => new Date("2026-09-10T00:01:00.000Z") }).poll(); await newer.called;
    newer.resolve({ events: [event({ status: "in_progress" })] }); await newerPoll;
    older.resolve({ events: [event(), event({ homeTeam: "Stale contradictory duplicate" })] });
    await expect(olderPoll).rejects.toThrow("Duplicate normalized event ID: event-1");
    expect(await db.prepare("SELECT last_error, last_success_at FROM odds_ingestion WHERE provider='odds'").first()).toMatchObject({ last_error: null, last_success_at: "2026-09-10T00:01:00.000Z" });

    await db.exec("UPDATE sports_event SET last_polled_at='2026-09-09T00:00:00.000Z'; UPDATE odds_league_poll SET last_discovery_at='2026-09-09T00:00:00.000Z' WHERE league='nfl';");
    const staleSuccess = new DeferredProvider(); const latestFailure = new DeferredProvider();
    const stalePoll = new OddsIngestion(db, staleSuccess, { now: () => new Date("2026-09-10T00:02:00.000Z") }).poll(); await staleSuccess.called;
    const failurePoll = new OddsIngestion(db, latestFailure, { now: () => new Date("2026-09-10T00:03:00.000Z") }).poll(); await latestFailure.called;
    latestFailure.reject(new Error("latest failure")); await expect(failurePoll).rejects.toThrow("latest failure");
    staleSuccess.resolve({ events: [event()] }); expect(await stalePoll).toEqual({ events: 0, offers: 0 });
    expect(await db.prepare("SELECT status FROM sports_event WHERE provider_event_id='event-1'").first()).toEqual({ status: "in_progress" });
    expect(await db.prepare("SELECT last_error, last_polled_at FROM odds_ingestion WHERE provider='odds'").first()).toMatchObject({ last_error: "latest failure", last_polled_at: "2026-09-10T00:03:00.000Z" });
  });

  it("assigns only the winning concurrent score a new correction version", async () => {
    await new OddsIngestion(db, new Provider([event({ status: "final", homeScore: 7, awayScore: 3 })]), { now: () => new Date("2026-09-09T00:00:00.000Z") }).poll();
    await db.exec("UPDATE sports_event SET last_polled_at='2026-09-09T00:00:00.000Z'; UPDATE odds_league_poll SET last_discovery_at=CASE WHEN league='nfl' THEN '2026-09-09T00:00:00.000Z' ELSE '2026-09-10T00:00:00.000Z' END;");
    const older = new DeferredProvider(); const newer = new DeferredProvider();
    const oldPoll = new OddsIngestion(db, older, { now: () => new Date("2026-09-10T00:00:00.000Z") }).poll(); await older.called;
    const newPoll = new OddsIngestion(db, newer, { now: () => new Date("2026-09-10T00:00:00.000Z") }).poll(); await newer.called;
    newer.resolve({ events: [event({ status: "final", homeScore: 14, awayScore: 3 })] }); await newPoll;
    older.resolve({ events: [event({ status: "final", homeScore: 10, awayScore: 3 })] }); expect(await oldPoll).toEqual({ events: 0, offers: 0 });
    expect(await db.prepare("SELECT home_score, correction_version FROM sports_event WHERE provider_event_id='event-1'").first()).toEqual({ home_score: "14", correction_version: "2" });
  });

  it("persists 20-minute empty/completed-league discovery cadence and quota backoff", async () => {
    const empty = new Provider([]);
    await new OddsIngestion(db, empty, { now: () => new Date("2026-09-01T00:00:00.000Z") }).poll();
    empty.calls.length = 0;
    await new OddsIngestion(db, empty, { now: () => new Date("2026-09-01T00:19:00.000Z") }).poll();
    expect(empty.calls).toEqual([]);
    await new OddsIngestion(db, empty, { now: () => new Date("2026-09-01T00:20:00.000Z") }).poll();
    expect(empty.calls).toEqual(["nfl", "ncaaf"]);

    const finalEvent = event({ id: "completed", status: "final", homeScore: 1, awayScore: 0 });
    await new OddsIngestion(db, new Provider([finalEvent]), { now: () => new Date("2026-09-02T00:00:00.000Z") }).poll();
    const nextSeason = new Provider([event({ id: "next-season", commenceTime: "2027-09-10T20:00:00.000Z" })]);
    await new OddsIngestion(db, nextSeason, { now: () => new Date("2026-09-02T00:20:00.000Z") }).poll();
    expect(nextSeason.calls).toContain("nfl");
    expect(await db.prepare("SELECT provider_event_id FROM sports_event WHERE provider_event_id='next-season'").first()).toBeTruthy();

    await db.exec("DELETE FROM market_offer; DELETE FROM sports_event; DELETE FROM odds_ingestion; DELETE FROM odds_league_poll;");
    const limited = new Provider([
      event({ id: "terminal-limited", status: "final", homeScore: 1, awayScore: 0 }),
      event({ id: "ncaaf-limited", sport: "ncaaf", status: "in_progress" })
    ], { nfl: { remaining: 7, used: 93 }, ncaaf: { remaining: 1, used: 99 } });
    await new OddsIngestion(db, limited, { now: () => new Date("2026-09-03T00:00:00.000Z") }).poll();
    limited.calls.length = 0;
    await new OddsIngestion(db, limited, { now: () => new Date("2026-09-03T00:05:00.000Z") }).poll();
    expect(limited.calls).toEqual([]); // persisted backoff governs in-progress polling
    await new OddsIngestion(db, limited, { now: () => new Date("2026-09-03T00:15:00.000Z") }).poll();
    expect(limited.calls).toEqual([]); // it also governs the otherwise-due terminal reconciliation
    await new OddsIngestion(db, limited, { now: () => new Date("2026-09-03T05:59:00.000Z") }).poll();
    expect(limited.calls).toEqual([]);
    await new OddsIngestion(db, limited, { now: () => new Date("2026-09-03T06:00:00.000Z") }).poll();
    expect(limited.calls).toEqual(["nfl", "ncaaf"]);
    const storedQuota = String((await db.prepare("SELECT quota_json FROM odds_ingestion WHERE provider='odds'").first<{ quota_json: string }>())!.quota_json);
    expect(storedQuota).toContain('"remaining":1');
    expect(storedQuota).toContain('"used":99');
    expect(storedQuota).toContain('"backoffMs":21600000');
  });

  it("reads multi-leg quote decisions from one old-or-new D1 ingestion snapshot", async () => {
    const first = event({ id: "snapshot-one" });
    const second = event({ id: "snapshot-two", homeTeam: "Second Home", awayTeam: "Second Away" });
    await new OddsIngestion(db, new Provider([first, second]), { now: () => new Date("2026-09-10T00:00:00.000Z") }).poll();

    const changed = (source: ProviderEvent): ProviderEvent => ({ ...source, bookmakers: source.bookmakers.map((book) => ({
      ...book,
      markets: book.markets.map((market) => ({ ...market, outcomes: market.outcomes.map((outcome) => ({ ...outcome, price: outcome.price < 0 ? outcome.price - 1 : outcome.price + 1 })) }))
    })) });
    await db.exec("UPDATE sports_event SET last_polled_at = '2026-09-09T00:00:00.000Z'; UPDATE odds_league_poll SET last_discovery_at = '2026-09-09T00:00:00.000Z';");
    const nextPoll = new OddsIngestion(db, new Provider([changed(first), changed(second)]), { now: () => new Date("2026-09-10T00:05:00.000Z") }).poll();
    const quote = (legs: Array<{ eventId: string; market: "spread" | "total"; selection: "home" | "over" }>) => canonicalizeWagerQuote(db, {
      type: "PlaceTeaserWager", commandId: crypto.randomUUID(), actorId: "member", wagerId: crypto.randomUUID(), quoteKey: crypto.randomUUID(), quotedCommandVersion: "0", seasonId: "s1", riskMicros: "1000000", acceptedOdds: -110, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs
    } as any, new Date("2026-09-10T00:05:00.000Z"));
    const reads = await Promise.all([
      ...Array.from({ length: 8 }, () => quote([{ eventId: first.id, market: "spread", selection: "home" }, { eventId: first.id, market: "total", selection: "over" }])),
      ...Array.from({ length: 8 }, () => quote([{ eventId: first.id, market: "spread", selection: "home" }, { eventId: second.id, market: "spread", selection: "home" }])),
      nextPoll
    ]);
    for (const decision of reads.slice(0, -1) as any[]) {
      expect(new Set(decision.legs.map((leg: any) => leg.retrievedAt)).size).toBe(1);
      expect(["2026-09-10T00:00:00.000Z", "2026-09-10T00:05:00.000Z"]).toContain(decision.legs[0].retrievedAt);
    }
  });

  it("reconciles omitted offers, rejects invalid input before D1 writes, and validates documented league fixtures", async () => {
    const first = new Provider([event({ id: "kept" }), event({ id: "omitted", status: "in_progress" })]);
    await new OddsIngestion(db, first, { now: () => new Date("2026-09-04T00:00:00.000Z") }).poll();
    const omission = new Provider([event({ id: "kept" })]);
    await new OddsIngestion(db, omission, { now: () => new Date("2026-09-04T06:01:00.000Z") }).poll();
    expect(await new OfferQuotes(db).current(event({ id: "omitted" }), "spread", new Date("2026-09-04T06:01:00.000Z"))).toBeNull();
    expect(await db.prepare("SELECT status, home_score, away_score, omitted_at FROM sports_event WHERE provider_event_id='omitted'").first()).toMatchObject({ status: "in_progress", omitted_at: "2026-09-04T06:01:00.000Z" });
    omission.calls.length = 0;
    await new OddsIngestion(db, omission, { now: () => new Date("2026-09-04T06:03:00.000Z") }).poll();
    expect(omission.calls).toEqual([]); // omitted active event no longer triggers a two-minute hot loop
    const invalid: IngestionProvider = { events: async () => ({ events: [{ ...event(), homeTeam: "" }] as ProviderEvent[] }) };
    const beforeInvalid = await db.prepare("SELECT COUNT(*) AS count FROM sports_event").first<{ count: number }>();
    const beforeSuccess = await db.prepare("SELECT last_success_at FROM odds_ingestion WHERE provider='odds'").first();
    await expect(new OddsIngestion(db, invalid, { now: () => new Date("2026-09-05T00:00:00.000Z") }).poll()).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) AS count FROM sports_event").first()).toEqual(beforeInvalid);
    const failedFeed = await db.prepare("SELECT last_polled_at, last_success_at, last_error FROM odds_ingestion WHERE provider='odds'").first<{ last_polled_at: string; last_success_at: string; last_error: string }>();
    expect(failedFeed).toMatchObject({ last_polled_at: "2026-09-05T00:00:00.000Z", ...beforeSuccess });
    expect(failedFeed!.last_error).toMatch(/^Malformed provider response:/);
    expect(failedFeed!.last_error.length).toBeLessThanOrEqual(512);

    const responses = [new Response(JSON.stringify(nflFixture), { headers: { "x-requests-remaining": "7", "x-requests-used": "93" } }), new Response(JSON.stringify(nflScoresFixture)), new Response(JSON.stringify(ncaafFixture)), new Response(JSON.stringify(ncaafScoresFixture))];
    const adapter = new TheOddsApiProvider("key", async () => responses.shift()!, () => new Date("2026-08-01T00:00:00.000Z"));
    const nflPoll = await adapter.events("nfl");
    const nfl = nflPoll.events.find((item) => item.id === "fixture-nfl-final")!;
    const ncaaf = (await adapter.events("ncaaf")).events.find((item) => item.id === "fixture-ncaaf-scheduled")!;
    expect(nflPoll.quota).toEqual({ remaining: 7, used: 93 });
    expect(nfl).toMatchObject({ sport: "nfl", status: "final", homeScore: 24, awayScore: 17, eventName: "Super Bowl LX", postseason: true });
    expect(ncaaf).toMatchObject({ sport: "ncaaf", status: "scheduled", eventName: "Fixture Bowl" });
    expect(isSuperBowl(nfl)).toBe(true);
    await expect(new TheOddsApiProvider("key", async () => new Response("[{bad}]" )).events("nfl")).rejects.toThrow();
  });
});

import { applyD1Migrations, env } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerApp } from "../../src/worker/app";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace; POOL_COMMAND_AUTHENTICATOR_KEY: string };
const origin = "https://pool.example.test";
let migrated = false;
const now = new Date("2026-09-09T18:00:00.000Z");
const activeEvent = { id: "active-matchup", league: "nfl", awayTeam: "Atlanta Falcons", homeTeam: "Pittsburgh Steelers", startsAt: "2026-09-13T17:00:00.000Z" };

async function send(poolId: string, command: unknown) {
  return bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)).fetch("https://pool.internal/command", { method: "POST", body: JSON.stringify(command) });
}
async function setupPool(poolId: string, slug: string) {
  await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, slug, poolId, `create-${poolId}`, now.toISOString()).run();
  await send(poolId, { type: "InitializePool", commandId: `init-${poolId}`, poolId, slug, creatorId: "owner", creatorName: "Owner", poolName: "Matchup Pool", password: "correct-password" });
  await send(poolId, { type: "JoinPool", commandId: `join-${poolId}`, actorId: "member", displayName: "Member", password: "correct-password" });
}
async function insertEvent(event = activeEvent) {
  await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', '0')")
    .bind(event.id, `provider-${event.id}`, event.league, event.homeTeam, event.awayTeam, event.startsAt).run();
}
class MemoryCache {
  values = new Map<string, Response>();
  async match(request: Request) { return this.values.get(request.url)?.clone(); }
  async put(request: Request, response: Response) { this.values.set(request.url, response.clone()); }
}
const responseFor = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
const espnFetcher = () => vi.fn(async (url: string | URL | Request) => {
  const value = String(url);
  if (value.includes("scoreboard")) return responseFor({ events: [{ id: "espn", date: activeEvent.startsAt, competitions: [{ venue: { fullName: "Acrisure Stadium" }, competitors: [
    { homeAway: "away", team: { id: "away", displayName: activeEvent.awayTeam }, records: [{ type: "total", summary: "1-0" }] },
    { homeAway: "home", team: { id: "home", displayName: activeEvent.homeTeam }, records: [{ type: "total", summary: "0-1" }] }
  ] }] }] });
  return responseFor({ results: { stats: { categories: [] } }, events: [] });
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  if (!migrated) { await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
  await bindings.DB.exec("DELETE FROM market_offer; DELETE FROM sports_event; DELETE FROM pool_registry_command_response; DELETE FROM pool_registry; INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'owner-matchup@example.test', 1, 0, 0), ('member', 'Member', 'member-matchup@example.test', 1, 0, 0);");
});
afterEach(() => vi.useRealTimers());

describe("matchup details HTTP boundary", () => {
  it("allows a member to read only a canonical active-week event and reuses its server cache", async () => {
    const poolId = `matchup-${crypto.randomUUID()}`; const slug = `matchup-${crypto.randomUUID()}`;
    await setupPool(poolId, slug); await insertEvent();
    const fetcher = espnFetcher(); const cache = new MemoryCache();
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }), matchupFetcher: fetcher, matchupCache: cache });

    const first = await app.fetch(new Request(`${origin}/api/p/${slug}/matchups/${activeEvent.id}`));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ league: "nfl", startsAt: activeEvent.startsAt, venue: "Acrisure Stadium", away: { name: activeEvent.awayTeam, record: "1-0" }, home: { name: activeEvent.homeTeam, record: "0-1" } });
    const callsAfterFirst = fetcher.mock.calls.length;
    expect((await app.fetch(new Request(`${origin}/api/p/${slug}/matchups/${activeEvent.id}`))).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(callsAfterFirst);
  }, 90_000);

  it("does not expose a previous-week event even when its opaque event id is known", async () => {
    const poolId = `inactive-matchup-${crypto.randomUUID()}`; const slug = `inactive-matchup-${crypto.randomUUID()}`;
    await setupPool(poolId, slug); await insertEvent({ ...activeEvent, id: "prior-week", startsAt: "2026-08-30T17:00:00.000Z" });
    const fetcher = espnFetcher();
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }), matchupFetcher: fetcher });

    const response = await app.fetch(new Request(`${origin}/api/p/${slug}/matchups/prior-week`));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "MATCHUP_NOT_AVAILABLE" });
    expect(fetcher).not.toHaveBeenCalled();
  }, 90_000);

  it("keeps the route member-only and reports ESPN failure as an available error state", async () => {
    const poolId = `error-matchup-${crypto.randomUUID()}`; const slug = `error-matchup-${crypto.randomUUID()}`;
    await setupPool(poolId, slug); await insertEvent();
    const unavailable = vi.fn(async () => responseFor({ code: "down" }, { status: 503 }));
    const memberApp = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }), matchupFetcher: unavailable });
    const upstream = await memberApp.fetch(new Request(`${origin}/api/p/${slug}/matchups/${activeEvent.id}`));
    expect(upstream.status).toBe(503);
    expect(await upstream.json()).toEqual({ code: "ESPN_UNAVAILABLE" });

    const outsiderApp = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "outsider", name: "Outsider" }), matchupFetcher: espnFetcher() });
    expect((await outsiderApp.fetch(new Request(`${origin}/api/p/${slug}/matchups/${activeEvent.id}`))).status).toBe(403);
  }, 90_000);
});

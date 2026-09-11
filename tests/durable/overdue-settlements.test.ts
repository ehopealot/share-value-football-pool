import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { countOverdueWagers } from "../../src/durable/overdue-settlements";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace };
let migrated = false;
beforeEach(async () => {
  if (!migrated) { await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
  await bindings.DB.exec("DELETE FROM market_offer; DELETE FROM sports_event;");
});
async function game(id: string, status: string, finalizedAt: number | null) {
  await bindings.DB.prepare("INSERT INTO sports_event (id,provider_event_id,league,home_team,away_team,starts_at,status,finalized_at,correction_version) VALUES (?,?,'nfl','Home','Away','2030-01-01T00:00:00.000Z',?,?,'1')").bind(id, id, status, finalizedAt === null ? null : new Date(finalizedAt).toISOString()).run();
}
async function pool(events: string[], status = "open") {
  const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("INSERT INTO wager (id,season_id,owner_id,type,risk_micros,accepted_odds,status,ruleset_version,confirmed_at) VALUES ('w','s','m','parlay','1000000',100,?,'SHARE_POOL_2026_V1','2030-01-01T00:00:00Z')", status);
    for (const id of events) state.storage.sql.exec("INSERT INTO wager_leg (id,wager_id,event_id,league,canonical_book,retrieved_at,policy_version,offer_version,market,selection,original_odds,event_starts_at) VALUES (?,'w',?,'nfl','DraftKings','2030-01-01T00:00:00Z','CANONICAL_BOOKS_2026_V1','v1','spread','home',-110,'2030-01-01T00:00:00Z')", id, id);
  });
  return stub;
}
const MINUTE = 60_000;
describe("unsettled-wager inspection", () => {
  it("alerts at 20 minutes from observed final, including final games with missing scores", async () => {
    const final = Date.parse("2030-09-10T23:00:00Z");
    await game("g", "final", final);
    const stub = await pool(["g"]);
    expect(await runInDurableObject(stub, (_instance, state) => countOverdueWagers(state.storage.sql, bindings.DB, final + 20 * MINUTE - 1))).toBe(0);
    expect(await runInDurableObject(stub, (_instance, state) => countOverdueWagers(state.storage.sql, bindings.DB, final + 20 * MINUTE))).toBe(1);
  });

  it("waits for the last game of a multi-leg wager and excludes settled wagers", async () => {
    const now = Date.now();
    await game("g1", "final", now - 60 * MINUTE);
    await game("g2", "in_progress", null);
    const stub = await pool(["g1", "g2"]);
    const count = () => runInDurableObject(stub, (_instance, state) => countOverdueWagers(state.storage.sql, bindings.DB, now));
    expect(await count()).toBe(0);
    await bindings.DB.prepare("UPDATE sports_event SET status='cancelled',finalized_at=? WHERE id='g2'").bind(new Date(now - 19 * MINUTE).toISOString()).run();
    expect(await count()).toBe(0);
    await bindings.DB.prepare("UPDATE sports_event SET finalized_at=? WHERE id='g2'").bind(new Date(now - 20 * MINUTE).toISOString()).run();
    expect(await count()).toBe(1);
    await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("UPDATE wager SET status='won'"));
    expect(await count()).toBe(0);
  });

  it("rechecks open status after reading D1 and requires read-only ops authorization", async () => {
    const now = Date.now();
    await game("g", "final", now - 30 * MINUTE);
    const stub = await pool(["g"]);
    expect((await stub.fetch("https://pool.internal/internal/ops/overdue-settlements")).status).toBe(404);
    expect(await (await stub.fetch("https://pool.internal/internal/ops/overdue-settlements", { headers: { "x-ops-service-token": "test-only-ops-token" } })).json()).toEqual({ overdueWagers: 1 });
    expect(await runInDurableObject(stub, (_instance, state) => countOverdueWagers(state.storage.sql, { prepare: (query: string) => bindings.DB.prepare(query), batch: async (statements: D1PreparedStatement[]) => {
      const result = await bindings.DB.batch(statements);
      state.storage.sql.exec("UPDATE wager SET status='won'");
      return result;
    } } as D1Database, now))).toBe(0);
  });
});

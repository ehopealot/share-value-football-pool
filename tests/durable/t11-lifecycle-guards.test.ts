import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const pools = (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO;
const send = async (slug: string, command: unknown) => {
  const response = await pools.get(pools.idFromName(slug)).fetch("https://pool.test/command", { method: "POST", body: JSON.stringify(command) });
  return await response.json() as Record<string, any>;
};
const storage = <T>(slug: string, callback: (state: DurableObjectState) => T) => runInDurableObject(pools.get(pools.idFromName(slug)), (_instance, state) => callback(state));

async function seasonPool(state: "draft" | "active" | "closed") {
  const slug = `t11-lifecycle-${state}-${crypto.randomUUID()}`;
  await send(slug, { type: "InitializePool", commandId: "init", poolId: slug, slug, poolName: "Lifecycle", creatorId: "owner", creatorName: "Owner", password: "correct-password" });
  await send(slug, { type: "CreateSeason", commandId: "draft", actorId: "owner", seasonId: "s1", label: "2026" });
  if (state !== "draft") await send(slug, { type: "OpenSeason", commandId: "open", actorId: "owner", seasonId: "s1" });
  if (state === "closed") await send(slug, { type: "CloseSeason", commandId: "close", actorId: "owner", seasonId: "s1", reason: "archived" });
  return slug;
}

const lifecycleSnapshot = (slug: string) => storage(slug, (state) => Object.fromEntries([
  "pool", "season", "season_super_bowl", "season_super_bowl_reconciliation", "event_result_snapshot", "wager_leg_snapshot", "event_reconciliation", "processed_command", "administration_audit", "season_annotation", "outbox"
].map((table) => [table, JSON.stringify([...state.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`)])])));

const seedCandidate = (slug: string) => storage(slug, (state) => {
  state.storage.sql.exec("INSERT INTO season_super_bowl (season_id, event_id, provider_event_name, event_starts_at, confirmed_at) VALUES ('s1', 'super-event', 'Super Bowl LX', '2030-02-10T23:00:00.000Z', NULL)");
});

describe("T11 season lifecycle mutation guards", () => {
  it("denies draft and active annotations without mutation and appends to closed history", async () => {
    for (const seasonState of ["draft", "active"] as const) {
      const slug = await seasonPool(seasonState);
      const before = await lifecycleSnapshot(slug);
      expect(await send(slug, { type: "CreateSeasonAnnotation", commandId: `annotate-${seasonState}`, actorId: "owner", seasonId: "s1", text: "Not archive history" })).toEqual({ code: "SEASON_NOT_CLOSED" });
      expect(await lifecycleSnapshot(slug)).toEqual(before);
    }

    const closed = await seasonPool("closed");
    expect(await send(closed, { type: "CreateSeasonAnnotation", commandId: "annotate-closed", actorId: "owner", seasonId: "s1", text: "Archive note" })).toMatchObject({ commandVersion: expect.any(String) });
    expect(await storage(closed, (state) => [...state.storage.sql.exec("SELECT season_id, text FROM season_annotation")])).toEqual([{ season_id: "s1", text: "Archive note" }]);
  }, 60_000);

  it("denies draft and closed Super Bowl confirmation without any durable mutation and confirms an active season once", async () => {
    for (const seasonState of ["draft", "closed"] as const) {
      const slug = await seasonPool(seasonState);
      await seedCandidate(slug);
      const before = await lifecycleSnapshot(slug);
      expect(await send(slug, { type: "ConfirmSuperBowl", commandId: `confirm-${seasonState}`, actorId: "owner", seasonId: "s1", eventId: "super-event" })).toEqual({ code: "SEASON_NOT_ACTIVE" });
      expect(await lifecycleSnapshot(slug)).toEqual(before);
    }

    const active = await seasonPool("active");
    await seedCandidate(active);
    const beforeVersion = Number((await send(active, { type: "ReadPoolView", commandId: "before", actorId: "owner" })).commandVersion);
    const command = { type: "ConfirmSuperBowl", commandId: "confirm-active", actorId: "owner", seasonId: "s1", eventId: "super-event" };
    expect(await send(active, command)).toEqual({ commandVersion: String(beforeVersion + 1) });
    expect(await send(active, command)).toEqual({ commandVersion: String(beforeVersion + 1) });
    expect(await storage(active, (state) => ({
      candidate: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM season_super_bowl WHERE season_id = 's1' AND confirmed_at IS NOT NULL")][0],
      reconciliation: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM event_reconciliation WHERE event_id = 'super-event'")][0],
      processed: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM processed_command WHERE id = 'confirm-active'")][0]
    }))).toEqual({ candidate: { count: 1 }, reconciliation: { count: 1 }, processed: { count: 1 } });
  }, 60_000);
});

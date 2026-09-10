import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSeasonClosureReminderCron, seasonClosureReminderConfigured } from "../../src/worker/season-closure-reminder-cron";
import type { PoolNotifier } from "../../src/auth/email-sender";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace };
let migrated = false;
const token = "test-only-settlement-token";
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  if (!migrated) { await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
  await bindings.DB.exec("CREATE TABLE IF NOT EXISTS season_closure_reminder_cursor (name TEXT PRIMARY KEY, last_pool_id TEXT); DELETE FROM season_closure_reminder_cursor; DELETE FROM pool_registry_command_response; DELETE FROM pool_registry; DELETE FROM user;");
  await bindings.DB.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'owner@example.test', 1, 0, 0)").run();
});

const notifier = (send: NonNullable<PoolNotifier["notifySeasonClosureReminder"]>): PoolNotifier & { notifySeasonClosureReminder: NonNullable<PoolNotifier["notifySeasonClosureReminder"]> } => ({
  notifySeasonClosureReminder: send,
  async notifyPoolJoin() {}, async notifyCommissionerTransfer() {}, async notifyShareOrderFulfilled() {}, async notifyCommissionerAnnouncement() {}
});

async function readyActivePool(now: number) {
  const poolId = `reminder-cron-${crypto.randomUUID()}`;
  const slug = `slug-${crypto.randomUUID()}`;
  await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, slug, poolId, `create-${poolId}`, new Date().toISOString()).run();
  const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId));
  const send = (body: unknown) => stub.fetch("https://pool.internal/command", { method: "POST", body: JSON.stringify(body) });
  await send({ type: "InitializePool", commandId: "init", poolId, slug, poolName: "Sunday Pool", creatorId: "owner", creatorName: "Owner", password: "correct-password" });
  await send({ type: "CreateSeason", commandId: "season", actorId: "owner", seasonId: "s1", label: "2030" });
  await send({ type: "OpenSeason", commandId: "open", actorId: "owner", seasonId: "s1" });
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("INSERT INTO season_super_bowl (season_id, event_id, provider_event_name, event_starts_at) VALUES ('s1', 'sb-1', 'Super Bowl LX', ?)", new Date(now + DAY).toISOString());
    // Existing eligible pools must be swept even when no lifecycle alarm remains.
    await state.storage.deleteAlarm();
  });
  return { poolId, slug, stub };
}

describe("season closure reminder cron", () => {
  it("is safely disabled unless both email and lifecycle credentials are configured", () => {
    expect(seasonClosureReminderConfigured({})).toBe(false);
    expect(seasonClosureReminderConfigured({ RESEND_API_KEY: "key" })).toBe(false);
    expect(seasonClosureReminderConfigured({ SETTLEMENT_SERVICE_TOKEN: token })).toBe(false);
    expect(seasonClosureReminderConfigured({ RESEND_API_KEY: "  ", SETTLEMENT_SERVICE_TOKEN: token })).toBe(false);
    expect(seasonClosureReminderConfigured({ RESEND_API_KEY: "key", SETTLEMENT_SERVICE_TOKEN: token })).toBe(true);
  });

  it("sends through the notifier, links only to authenticated season administration, and marks provider acceptance", async () => {
    const now = Date.parse("2030-02-09T23:00:00.000Z");
    const { slug, stub } = await readyActivePool(now);
    const send = vi.fn<NonNullable<PoolNotifier["notifySeasonClosureReminder"]>>().mockResolvedValue(undefined);
    expect(await runSeasonClosureReminderCron({ db: bindings.DB, pools: bindings.POOL_DO, settlementServiceToken: token, notifier: notifier(send), adminOrigin: "https://officepool.football" }, () => now)).toEqual({ attemptedPools: 1, sent: 1 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@example.test", poolName: "Sunday Pool", seasonLabel: "2030", gameName: "Super Bowl LX", adminUrl: `https://officepool.football/p/${encodeURIComponent(slug)}/admin/season`, idempotencyKey: expect.stringMatching(/^season-closure\/[0-9a-f]{64}$/) }));
    expect(await runSeasonClosureReminderCron({ db: bindings.DB, pools: bindings.POOL_DO, settlementServiceToken: token, notifier: notifier(send), adminOrigin: "https://officepool.football" }, () => now + 2 * 60 * 1000)).toEqual({ attemptedPools: 1, sent: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await runInDurableObject(stub, (_instance, state) => [...state.storage.sql.exec("SELECT attempts, last_outcome, delivered_at FROM season_closure_reminder")][0])).toMatchObject({ attempts: 1, last_outcome: "accepted", delivered_at: new Date(now).toISOString() });
  }, 60_000);

  it.each(["prepare", "claim"])("rechecks actual time after %s rather than using the sweep start time", async (delayedAction) => {
    const at = Date.parse("2030-02-09T23:00:00.000Z");
    const { stub } = await readyActivePool(at);
    await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("UPDATE season_super_bowl SET event_starts_at = ?", new Date(at + 1000).toISOString()));
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    const pools = {
      idFromName: (name: string) => bindings.POOL_DO.idFromName(name),
      get: (id: DurableObjectId) => ({ fetch: async (url: string, init: RequestInit) => {
        const response = await bindings.POOL_DO.get(id).fetch(url, init);
        if (JSON.parse(String(init.body)).action === delayedAction) clock.mockReturnValue(at + 1000);
        return response;
      } })
    } as unknown as DurableObjectNamespace;
    const send = vi.fn<NonNullable<PoolNotifier["notifySeasonClosureReminder"]>>().mockResolvedValue(undefined);
    try {
      expect(await runSeasonClosureReminderCron({ db: bindings.DB, pools, settlementServiceToken: token, notifier: notifier(send), adminOrigin: "https://officepool.football" })).toEqual({ attemptedPools: 1, sent: 0 });
      expect(send).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  }, 60_000);

  it("records provider failure and reuses the exact payload and idempotency key on bounded retry", async () => {
    const now = Date.parse("2030-02-05T00:00:00.000Z");
    const { stub } = await readyActivePool(now);
    await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("UPDATE season_super_bowl SET event_starts_at = ?", new Date(now + 6 * DAY).toISOString()));
    const send = vi.fn<NonNullable<PoolNotifier["notifySeasonClosureReminder"]>>().mockRejectedValueOnce(new Error("ambiguous")).mockResolvedValueOnce(undefined);
    const dependencies = { db: bindings.DB, pools: bindings.POOL_DO, settlementServiceToken: token, notifier: notifier(send), adminOrigin: "https://officepool.football" };
    expect(await runSeasonClosureReminderCron(dependencies, () => now)).toEqual({ attemptedPools: 1, sent: 0 });
    expect(await runInDurableObject(stub, (_instance, state) => [...state.storage.sql.exec("SELECT last_outcome, delivered_at FROM season_closure_reminder")][0])).toEqual({ last_outcome: "provider_failed", delivered_at: null });
    await runSeasonClosureReminderCron(dependencies, () => now + 15 * 60 * 1000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  }, 60_000);

  it("pages ready pools fairly, bounds each run to 50, and continues after a pool failure", async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `page-${String(index).padStart(3, "0")}`);
    for (const id of ids) await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, '2030-01-01T00:00:00.000Z')").bind(id, id, id, `create-${id}`).run();
    const attempted: string[] = [];
    const pools = {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({ fetch: async (_url: string, init: RequestInit) => { expect(init.signal).toBeInstanceOf(AbortSignal); attempted.push(String(id)); if (id === ids[0]) throw new Error("one pool unavailable"); return Response.json({ status: "none" }); } })
    } as unknown as DurableObjectNamespace;
    const dependencies = { db: bindings.DB, pools, settlementServiceToken: token, notifier: notifier(async () => undefined), adminOrigin: "https://officepool.football" };
    expect(await runSeasonClosureReminderCron(dependencies, () => Date.parse("2030-02-01T00:00:00.000Z"))).toEqual({ attemptedPools: 50, sent: 0 });
    expect(attempted).toEqual(ids.slice(0, 50));
    expect(await runSeasonClosureReminderCron(dependencies, () => Date.parse("2030-02-01T00:02:00.000Z"))).toEqual({ attemptedPools: 1, sent: 0 });
    expect(attempted.at(-1)).toBe(ids[50]);
    expect(await runSeasonClosureReminderCron(dependencies, () => Date.parse("2030-02-01T00:04:00.000Z"))).toEqual({ attemptedPools: 50, sent: 0 });
    expect(attempted.slice(-50)).toEqual(ids.slice(0, 50));
  }, 60_000);

  it("advances the cursor when the run budget is reached before the page ends", async () => {
    for (const id of ["budget-a", "budget-b"]) await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, '2030-01-01T00:00:00.000Z')").bind(id, id, id, `create-${id}`).run();
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const attempted: string[] = [];
    const pools = {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({ fetch: async () => { attempted.push(String(id)); clock.mockReturnValue(20_000); return Response.json({ status: "none" }); } })
    } as unknown as DurableObjectNamespace;
    const dependencies = { db: bindings.DB, pools, settlementServiceToken: token, notifier: notifier(async () => undefined), adminOrigin: "https://officepool.football" };
    try {
      expect(await runSeasonClosureReminderCron(dependencies)).toEqual({ attemptedPools: 1, sent: 0 });
      expect(attempted).toEqual(["budget-a"]);
      expect(await runSeasonClosureReminderCron(dependencies)).toEqual({ attemptedPools: 1, sent: 0 });
      expect(attempted).toEqual(["budget-a", "budget-b"]);
    } finally { clock.mockRestore(); }
  });

  it("does not claim or send when the authoritative commissioner has no account email", async () => {
    const now = Date.parse("2030-02-09T23:00:00.000Z");
    const { stub } = await readyActivePool(now);
    await bindings.DB.prepare("UPDATE user SET email='' WHERE id='owner'").run();
    const send = vi.fn<NonNullable<PoolNotifier["notifySeasonClosureReminder"]>>();
    expect(await runSeasonClosureReminderCron({ db: bindings.DB, pools: bindings.POOL_DO, settlementServiceToken: token, notifier: notifier(send), adminOrigin: "https://officepool.football" }, () => now)).toEqual({ attemptedPools: 1, sent: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await runInDurableObject(stub, (_instance, state) => [...state.storage.sql.exec("SELECT attempts, delivered_at FROM season_closure_reminder")][0])).toEqual({ attempts: 0, delivered_at: null });
  }, 60_000);
});

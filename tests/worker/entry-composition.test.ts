import { applyD1Migrations, env } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "../../src/index";

/**
 * The vitest Worker entry is deliberately slim (no queue consumer or cron
 * trigger), so this file is the one place the production entrypoint's queue and
 * scheduled handlers are exercised as wired in src/index.ts. `worker.fetch`
 * composition is covered by tests/worker/security.test.ts.
 */
const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace; POOL_PROJECTION_SERVICE_TOKEN: string };
let migrated = false;

beforeEach(async () => {
  if (!migrated) { await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
  await bindings.DB.exec("DELETE FROM projection_delivery; DELETE FROM projection_state; DELETE FROM membership_projection; DELETE FROM season_projection;");
});

describe("production entrypoint composition", () => {
  it("drains a delivered outbox message through the queue handler into D1 projections", async () => {
    const poolId = `composition-${crypto.randomUUID()}`;
    const initialize = await bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)).fetch("https://pool.test/command", { method: "POST", body: JSON.stringify({ type: "InitializePool", commandId: "init", poolId, slug: poolId, creatorId: "owner", creatorName: "Owner", poolName: "Composition Pool", password: "correct-password" }) });
    expect(initialize.status).toBe(200);

    let acked = false;
    let retried = false;
    const batch = {
      messages: [{
        id: "composition-message", timestamp: Date.now(), attempts: 1,
        body: { eventId: "event-1", version: "1", eventType: "CommandApplied", payload: { poolId, actorId: "owner", commandId: "init", commandType: "InitializePool", memberId: "owner" } },
        ack: () => { acked = true; }, retry: () => { retried = true; }
      }]
    } as unknown as Parameters<NonNullable<typeof worker.queue>>[0];
    const background: Promise<unknown>[] = [];
    const context = { waitUntil: (promise: Promise<unknown>) => { background.push(promise); } } as unknown as ExecutionContext;
    worker.queue!(batch, env as unknown as Env, context);
    await Promise.all(background);

    expect(acked).toBe(true);
    expect(retried).toBe(false);
    expect(await bindings.DB.prepare("SELECT event_id, projection_version, delivered_at, last_error FROM projection_delivery WHERE event_id = 'event-1'").first()).toMatchObject({ event_id: "event-1", projection_version: "1", delivered_at: expect.any(String), last_error: null });
    expect(await bindings.DB.prepare("SELECT user_id, pool_name, role, status, projection_version FROM membership_projection WHERE pool_id = ?").bind(poolId).first()).toEqual({ user_id: "owner", pool_name: "Composition Pool", role: "commissioner", status: "active", projection_version: "1" });
  }, 30_000);

  it("runs the scheduled handler as a no-op without odds or backup configuration", async () => {
    const background: Promise<unknown>[] = [];
    const context = { waitUntil: (promise: Promise<unknown>) => { background.push(promise); } } as unknown as ExecutionContext;
    worker.scheduled!({} as ScheduledEvent, env as unknown as Env, context);
    await Promise.all(background);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS count FROM projection_delivery").first<{ count: number }>()).toMatchObject({ count: 0 });
  }, 30_000);
});

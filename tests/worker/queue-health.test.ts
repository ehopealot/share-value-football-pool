import { applyD1Migrations, env } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectionConsumer, recordQueuedProjection } from "../../src/services/projections";
import { createWorkerApp } from "../../src/worker/app";
import type { PoolOutboxMessage } from "../../src/contracts/commands";

const db = (env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace }).DB;
let migrated = false;
const message = (eventId: string, version: string): PoolOutboxMessage => ({
  eventId, version, eventType: "CommandApplied",
  payload: { poolId: "pool-1", actorId: "owner", commandId: eventId, commandType: "JoinPool", memberId: "member" }
});

beforeEach(async () => {
  if (!migrated) { await applyD1Migrations(db, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
  await db.exec("DELETE FROM projection_delivery; DELETE FROM projection_state; DELETE FROM membership_projection; DELETE FROM season_projection; DELETE FROM odds_ingestion;");
});

describe("projection Queue consumer", () => {
  it("persists attempts, ignores duplicate/stale versions, and keeps projections repairable", async () => {
    let calls = 0;
    const consumer = new ProjectionConsumer(db, async () => {
      calls++;
      return { poolId: "pool-1", commandVersion: "2", poolName: calls === 1 ? "Original" : "Newer", members: [{ userId: "member", displayName: "Member", role: "member", status: "active" }], seasons: [{ seasonId: "season", label: "2026", state: "active", openedAt: "2026-01-01T00:00:00.000Z", closedAt: null }] };
    });
    await consumer.consume(message("event-2", "2"));
    await consumer.consume(message("event-2", "2"));
    await consumer.consume(message("event-1", "1"));
    expect(calls).toBe(1);
    expect(await db.prepare("SELECT pool_name, projection_version FROM membership_projection WHERE pool_id = ? AND user_id = ?").bind("pool-1", "member").first()).toMatchObject({ pool_name: "Original", projection_version: "2" });
    expect(await db.prepare("SELECT attempts, delivered_at FROM projection_delivery WHERE event_id = ?").bind("event-1").first()).toMatchObject({ attempts: 1, delivered_at: expect.any(String) });
  });

  it("records a failed attempt, retries it, and repairs delivery", async () => {
    let fail = true;
    const consumer = new ProjectionConsumer(db, async () => {
      if (fail) throw new Error("DO temporarily unavailable");
      return { poolId: "pool-1", commandVersion: "3", poolName: "Recovered", members: [{ userId: "member", displayName: "Member", role: "member", status: "active" }], seasons: [] };
    });
    await expect(consumer.consume(message("retry", "3"))).rejects.toThrow("DO temporarily unavailable");
    expect(await db.prepare("SELECT attempts, delivered_at, last_error FROM projection_delivery WHERE event_id = ?").bind("retry").first()).toMatchObject({ attempts: 1, delivered_at: null, last_error: "DO temporarily unavailable" });
    fail = false;
    await consumer.consume(message("retry", "3"));
    expect(await db.prepare("SELECT attempts, delivered_at, last_error FROM projection_delivery WHERE event_id = ?").bind("retry").first()).toMatchObject({ attempts: 2, delivered_at: expect.any(String), last_error: null });
  });
});

describe("service-only projection snapshot", () => {
  it("denies unauthenticated callers and returns only repairable directory fields", async () => {
    const pools = (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO;
    const poolId = `projection-${crypto.randomUUID()}`;
    const stub = pools.get(pools.idFromName(poolId));
    await stub.fetch("https://pool.internal/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "InitializePool", commandId: "initialize", poolId, slug: "projection-test", creatorId: "owner", creatorName: "Owner", poolName: "Projection Test", password: "correct-password" }) });
    expect((await stub.fetch("https://pool.internal/internal/projection")).status).toBe(404);
    await stub.fetch("https://pool.internal/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "JoinPool", commandId: "join", actorId: "member", displayName: "Member", password: "correct-password" }) });
    await stub.fetch("https://pool.internal/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "SuspendMember", commandId: "suspend", actorId: "owner", memberId: "member" }) });
    const response = await stub.fetch("https://pool.internal/internal/projection", { headers: { "x-projection-service-token": "test-only-projection-token" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ poolId, commandVersion: "3", poolName: "Projection Test", members: [{ userId: "owner", displayName: "Owner", role: "commissioner", status: "active" }, { userId: "member", displayName: "Member", role: "member", status: "suspended" }], seasons: [] });
  }, 90_000);
});

describe("non-sensitive operational health", () => {
  const health = async () => {
    const app = createWorkerApp({ db, pools: (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO, queue: {} as Queue, oddsConfigured: true, currentUser: async () => null });
    return (await app.fetch(new Request("https://pool.example.test/health/queue"))).json();
  };

  it("reports configured, degraded, and error states without operational data", async () => {
    const app = createWorkerApp({ db, pools: (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO, queue: {} as Queue, oddsConfigured: true, currentUser: async () => null });
    expect(await (await app.fetch(new Request("https://pool.example.test/health/app"))).json()).toEqual({ status: "ok" });
    expect(await (await app.fetch(new Request("https://pool.example.test/health/d1"))).json()).toEqual({ status: "ok" });
    expect(await (await app.fetch(new Request("https://pool.example.test/health/odds"))).json()).toEqual({ status: "degraded" });
    await db.prepare("INSERT INTO odds_ingestion (provider, last_polled_at, last_error) VALUES ('odds', ?, ?)").bind("2026-01-01T00:00:00.000Z", "provider unavailable").run();
    expect(await (await app.fetch(new Request("https://pool.example.test/health/odds"))).json()).toEqual({ status: "error" });
    expect(await health()).toEqual({ status: "ok" });
  });

  it("reports the worst undelivered delivery rather than only the oldest", async () => {
    await recordQueuedProjection(db, message("older-healthy", "1"));
    await recordQueuedProjection(db, message("newer-degraded", "2"));
    await db.prepare("UPDATE projection_delivery SET attempts = 3, last_error = 'failed' WHERE event_id = ?").bind("newer-degraded").run();
    expect(await health()).toEqual({ status: "error" });
  });

  it("measures producer-time queue lag and retains it across retries, failures, recovery, duplicates, and stale delivery", async () => {
    const delayed = message("delayed-before-first-attempt", "2");
    await recordQueuedProjection(db, delayed, new Date(Date.now() - 16 * 60_000).toISOString());
    expect(await health()).toEqual({ status: "error" });
    expect(await db.prepare("SELECT attempts, queued_at FROM projection_delivery WHERE event_id = ?").bind(delayed.eventId).first()).toMatchObject({ attempts: 0, queued_at: expect.any(String) });

    await db.exec("DELETE FROM projection_delivery;");
    const retrying = message("retrying", "3");
    await recordQueuedProjection(db, retrying);
    await db.prepare("UPDATE projection_delivery SET attempts = 2 WHERE event_id = ?").bind(retrying.eventId).run();
    expect(await health()).toEqual({ status: "degraded" });

    await db.prepare("UPDATE projection_delivery SET attempts = 3, last_error = 'failed' WHERE event_id = ?").bind(retrying.eventId).run();
    expect(await health()).toEqual({ status: "error" });

    await db.prepare("UPDATE projection_delivery SET delivered_at = ?, last_error = NULL WHERE event_id = ?").bind(new Date().toISOString(), retrying.eventId).run();
    expect(await health()).toEqual({ status: "ok" });

    const queuedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const duplicate = message("duplicate", "4");
    await recordQueuedProjection(db, duplicate, queuedAt);
    await recordQueuedProjection(db, duplicate, new Date().toISOString());
    expect(await db.prepare("SELECT attempts, queued_at FROM projection_delivery WHERE event_id = ?").bind(duplicate.eventId).first()).toEqual({ attempts: 0, queued_at: queuedAt });

    const current = message("current", "2");
    await recordQueuedProjection(db, current);
    const consumer = new ProjectionConsumer(db, async () => ({ poolId: "pool-1", commandVersion: "2", poolName: "Current", members: [], seasons: [] }));
    await consumer.consume(current);
    const stale = message("stale", "1");
    const staleQueuedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await recordQueuedProjection(db, stale, staleQueuedAt);
    await consumer.consume(stale);
    expect(await db.prepare("SELECT attempts, queued_at, delivered_at FROM projection_delivery WHERE event_id = ?").bind(stale.eventId).first()).toMatchObject({ attempts: 1, queued_at: staleQueuedAt, delivered_at: expect.any(String) });
  });
});

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { PoolDO } from "../../src/durable/pool-do";

const pools = (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO;
const dsn = "https://public@sentry.invalid/1";

describe("enabled production PoolDO safe-fault reporting", () => {
  it("captures an unknown uppercase command fault without trace-link storage", async () => {
    const stub = pools.get(pools.idFromName(`sentry-pool-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown>; execute: () => unknown };
      runtime.env.SENTRY_DSN = dsn;
      runtime.env.SENTRY_TEST_TRANSPORT = () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true });
      runtime.execute = () => { throw new Error("OUTBOX_IDENTITY_MISSING"); };
      const response = await (instance as unknown as { fetch(request: Request): Promise<Response> }).fetch(new Request("https://pool.test/command", { method: "POST", body: JSON.stringify({ type: "InitializePool", commandId: "init", poolId: "pool", slug: "pool", poolName: "Pool", creatorId: "owner", creatorName: "Owner", password: "correct-password" }) }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "OUTBOX_IDENTITY_MISSING" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(envelopes).toHaveLength(1);
      expect(JSON.stringify(envelopes)).not.toContain("OUTBOX_IDENTITY_MISSING");
      const keys = await state.storage.list();
      expect([...keys.keys()].some((key) => String(key).includes("__SENTRY_TRACE_LINK__"))).toBe(false);
    });
  });

  it("reports post-commit alarm failure once while preserving the initialized replay", async () => {
    const stub = pools.get(pools.idFromName(`sentry-postcommit-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown>; fetch(request: Request): Promise<Response> };
      runtime.env.SENTRY_DSN = dsn;
      runtime.env.SENTRY_TEST_TRANSPORT = () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true });
      const alarm = vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(new Error("alarm scheduling failed"));
      const command = { type: "InitializePool", commandId: "init", poolId: "pool", slug: "pool", poolName: "Pool", creatorId: "owner", creatorName: "Owner", password: "correct-password" };
      const first = await runtime.fetch(new Request("https://pool.test/command", { method: "POST", body: JSON.stringify(command) }));
      expect(first.status).toBe(400);
      expect(await first.json()).toEqual({ code: "alarm scheduling failed" });
      expect([...state.storage.sql.exec("SELECT id FROM pool")]).toHaveLength(1);
      alarm.mockRestore();
      const replay = await runtime.fetch(new Request("https://pool.test/command", { method: "POST", body: JSON.stringify(command) }));
      expect(replay.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(envelopes).toHaveLength(1);
      expect(JSON.stringify(envelopes)).not.toContain("alarm scheduling failed");
    });
  });

  it("runs caught alarm provider retry once while enabled transport failure stays fail-open", async () => {
    const stub = pools.get(pools.idFromName(`sentry-alarm-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown>; fetch(request: Request): Promise<Response> };
      runtime.env.SENTRY_DSN = dsn;
      runtime.env.SENTRY_TEST_TRANSPORT = () => ({ send: async () => { throw new Error("transport rejected"); }, flush: async () => true });
      runtime.env.DB = { prepare: () => { throw new Error("provider failure"); } };
      state.storage.sql.exec("INSERT INTO event_reconciliation (event_id, event_starts_at, phase, attempts, error_attempts, next_attempt_at) VALUES ('event', '2026-01-01T00:00:00.000Z', 'open', 0, 0, '1970-01-01T00:00:00.000Z')");
      const response = await runtime.fetch(new Request("https://pool.test/internal/settle", { method: "POST", headers: { "x-settlement-service-token": String(runtime.env.SETTLEMENT_SERVICE_TOKEN) } }));
      expect(response.status).toBe(200);
      expect([...state.storage.sql.exec("SELECT error_attempts, next_attempt_at FROM event_reconciliation WHERE event_id = 'event'")][0]).toMatchObject({ error_attempts: 1, next_attempt_at: expect.any(String) });
      expect([...await state.storage.list()].some(([key]) => String(key).includes("__SENTRY_TRACE_LINK__"))).toBe(false);
    });
  });

  it("keeps alarm retry business state when reporter option initialization throws", async () => {
    const stub = pools.get(pools.idFromName(`sentry-alarm-init-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown>; fetch(request: Request): Promise<Response> };
      runtime.env.SENTRY_DSN = dsn;
      runtime.env.SENTRY_TEST_TRANSPORT = () => { throw new Error("init transport failure"); };
      runtime.env.DB = { prepare: () => { throw new Error("provider failure"); } };
      state.storage.sql.exec("INSERT INTO event_reconciliation (event_id, event_starts_at, phase, attempts, error_attempts, next_attempt_at) VALUES ('event', '2026-01-01T00:00:00.000Z', 'open', 0, 0, '1970-01-01T00:00:00.000Z')");
      const response = await runtime.fetch(new Request("https://pool.test/internal/settle", { method: "POST", headers: { "x-settlement-service-token": String(runtime.env.SETTLEMENT_SERVICE_TOKEN) } }));
      expect(response.status).toBe(200);
      expect([...state.storage.sql.exec("SELECT error_attempts FROM event_reconciliation WHERE event_id = 'event'")][0]).toEqual({ error_attempts: 1 });
    });
  });

  it("captures actual outbox producer failure after persisted retry without changing alarm response", async () => {
    const stub = pools.get(pools.idFromName(`sentry-outbox-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    const flushes: Promise<unknown>[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown> };
      const pool = new PoolDO(state, { ...runtime.env, SENTRY_DSN: dsn, SENTRY_TEST_TRANSPORT: () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true }), SENTRY_TEST_FLUSHES: flushes, POOL_EVENTS: { send: async () => { throw new Error("queue unavailable"); } } as unknown as Queue });
      state.storage.sql.exec("INSERT INTO outbox (id, event_type, version, payload_json, attempts, next_attempt_at, created_at) VALUES ('event', 'CommandApplied', '1', ?, 0, ?, ?)", JSON.stringify({ poolId: "pool", actorId: "owner", commandId: "command", commandType: "JoinPool", memberId: "member" }), new Date(0).toISOString(), new Date(0).toISOString());
      const response = await pool.fetch(new Request("https://pool.test/internal/settle", { method: "POST", headers: { "x-settlement-service-token": String(runtime.env.SETTLEMENT_SERVICE_TOKEN) } }));
      expect(response.status).toBe(200);
      expect([...state.storage.sql.exec("SELECT attempts, delivered_at FROM outbox WHERE id = 'event'")][0]).toEqual({ attempts: 1, delivered_at: null });
      await Promise.all(flushes);
      expect(envelopes).toHaveLength(1);
    });
  });

  it("captures and rethrows the identical final alarm scheduling error", async () => {
    const stub = pools.get(pools.idFromName(`sentry-alarm-final-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    const flushes: Promise<unknown>[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown> };
      const error = new Error("final alarm scheduling failure");
      const pool = new PoolDO(state, { ...runtime.env, SENTRY_DSN: dsn, SENTRY_TEST_TRANSPORT: () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true }), SENTRY_TEST_FLUSHES: flushes, POOL_EVENTS: { send: async () => undefined } as unknown as Queue });
      state.storage.sql.exec("INSERT INTO outbox (id, event_type, version, payload_json, attempts, next_attempt_at, created_at) VALUES ('future', 'CommandApplied', '1', ?, 0, ?, ?)", JSON.stringify({ poolId: "pool", actorId: "owner", commandId: "command", commandType: "JoinPool", memberId: "member" }), new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
      const alarm = vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(error);
      const request = new Request("https://pool.test/internal/settle", { method: "POST", headers: { "x-settlement-service-token": String(runtime.env.SETTLEMENT_SERVICE_TOKEN) } });
      await expect(pool.fetch(request)).rejects.toBe(error);
      alarm.mockRestore();
      await Promise.all(flushes);
      expect(envelopes).toHaveLength(1);
      expect(JSON.stringify(envelopes)).not.toContain("final alarm scheduling failure");
      const envelope = envelopes[0] as [unknown, Array<[unknown, { tags: Record<string, string>; fingerprint: string[] }]>];
      expect(envelope[1][0][1].tags.sentry_category).toBe("durable-alarm-escaping-failure");
      expect(envelope[1][0][1].fingerprint).toEqual(["sentry", "durable-object", "durable-alarm-escaping-failure"]);
    });
  });

  it("keeps expected command rejection quiet with enabled reporting", async () => {
    const stub = pools.get(pools.idFromName(`sentry-expected-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    await runInDurableObject(stub, async (instance) => {
      const runtime = instance as unknown as { env: Record<string, unknown>; fetch(request: Request): Promise<Response> };
      runtime.env.SENTRY_DSN = dsn;
      runtime.env.SENTRY_TEST_TRANSPORT = () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true });
      const response = await runtime.fetch(new Request("https://pool.test/command", { method: "POST", body: "{}" }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "INVALID_COMMAND" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(envelopes).toEqual([]);
    });
  });
});

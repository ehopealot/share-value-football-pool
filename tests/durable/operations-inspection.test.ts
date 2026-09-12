import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const pools = (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO;
const token = "test-only-ops-token";
const request = (stub: DurableObjectStub, path: string, init: RequestInit = {}) => stub.fetch(`https://pool.internal${path}`, { ...init, headers: { "x-ops-service-token": token, ...init.headers } });

async function initializedPool() {
  const id = `ops-inspection-${crypto.randomUUID()}`;
  const stub = pools.get(pools.idFromName(id));
  await stub.fetch("https://pool.internal/command", { method: "POST", body: JSON.stringify({ type: "InitializePool", commandId: "init", poolId: id, slug: id, creatorId: "owner", creatorName: "Owner", poolName: "Operations", password: "correct-password" }) });
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("INSERT INTO event_reconciliation (event_id,event_starts_at,phase,attempts,error_attempts,next_attempt_at,last_error) VALUES ('private-event','2100-01-01T00:00:00.000Z','open',0,0,'2100-01-01T00:02:00.000Z','raw provider secret')");
    state.storage.sql.exec("INSERT INTO outbox (id,event_type,version,payload_json,attempts,next_attempt_at,delivered_at,last_error,created_at) VALUES ('private-outbox','CommandApplied','2','{\"selection\":\"private-home\"}',5,'2026-01-01T00:01:00.000Z',NULL,'private queue payload','2026-01-01T00:00:00.000Z')");
  });
  return { id, stub };
}

describe("PoolDO operational inspection", () => {
  it("requires the dedicated token and returns only safe scheduling metadata", async () => {
    const { stub } = await initializedPool();
    expect((await stub.fetch("https://pool.internal/internal/ops/inspection")).status).toBe(404);
    const response = await request(stub, "/internal/ops/inspection");
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ initialized: true, reconciliationRetryAt: "2100-01-01T00:02:00.000Z", pendingReconciliationCount: 1, exhaustedOutboxCount: 1, exhaustedOutboxCategories: ["delivery_failed"] });
    expect(JSON.stringify(body)).not.toMatch(/private-event|private-outbox|private-home|raw provider secret|private queue payload|payload_json|selection/);
  });

  it("does not change initialized SQL rows or the alarm", async () => {
    const { stub } = await initializedPool();
    const snapshot = async () => runInDurableObject(stub, async (_instance, state) => ({
      pool: [...state.storage.sql.exec("SELECT * FROM pool ORDER BY id")],
      reconciliation: [...state.storage.sql.exec("SELECT * FROM event_reconciliation ORDER BY event_id")],
      outbox: [...state.storage.sql.exec("SELECT * FROM outbox ORDER BY id")],
      alarm: await state.storage.getAlarm()
    }));
    const before = await snapshot();
    await request(stub, "/internal/ops/inspection");
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it("reports corrupt retry evidence as unknown instead of idle", async () => {
    const { stub } = await initializedPool();
    await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("UPDATE event_reconciliation SET next_attempt_at='not-a-time'"));
    expect(await (await request(stub, "/internal/ops/inspection")).json()).toMatchObject({ initialized: true, status: "unknown", reconciliationRetryAt: null, pendingReconciliationCount: 1 });
  });

  it("labels constructor bootstrap without treating an empty fresh object as healthy", async () => {
    const stub = pools.get(pools.idFromName(`fresh-${crypto.randomUUID()}`));
    const response = await request(stub, "/internal/ops/inspection");
    expect(await response.json()).toMatchObject({ initialized: false, status: "unknown", reconciliationRetryAt: null, pendingReconciliationCount: 0 });
  });
});

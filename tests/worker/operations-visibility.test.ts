import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import migration1 from "../../src/db/migrations/0001_initial.sql?raw";
import migration2 from "../../src/db/migrations/0002_odds_poll_generation.sql?raw";
import migration3 from "../../src/db/migrations/0003_operations.sql?raw";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordJobStatus } from "../../src/worker/job-status";
import { createWorkerApp } from "../../src/worker/app";
import { parseOperatorAllowlist } from "../../src/worker/ops-auth";
import localWorker from "../../src/index.local";
import type { Env } from "../../src/index";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace };
const split = (sql: string) => sql.split(";\n").map((query) => query.trim()).filter(Boolean);
const origin = "https://pool.example.test";

beforeAll(async () => applyD1Migrations(bindings.DB, [
  { name: "0001_initial.sql", queries: split(migration1) },
  { name: "0002_odds_poll_generation.sql", queries: split(migration2) },
  { name: "0003_operations.sql", queries: split(migration3) }
]));
beforeEach(async () => bindings.DB.exec("PRAGMA ignore_check_constraints=OFF; DELETE FROM ops_job_status; DELETE FROM pool_registry;"));

const app = (input: { ids?: string; user?: string | null; now?: number } = {}) => createWorkerApp({
  db: bindings.DB,
  pools: bindings.POOL_DO,
  currentUser: async () => input.user === null ? null : { id: input.user ?? "operator-1", name: "Operator" },
  opsOperatorUserIds: input.ids,
  opsServiceToken: "test-only-ops-token",
  oddsConfigured: true,
  healthNow: () => input.now ?? Date.now()
});

describe("minimal operational job evidence", () => {
  it("preserves the greatest successful completion while accepting a newer attempt outcome", async () => {
    await recordJobStatus(bindings.DB, { jobKind: "odds", attemptKey: "2026-09-10T00:00:00.000Z/a", status: "success", safeCategory: "provider_published", observedAt: "2026-09-10T00:05:00.000Z", successfulAt: "2026-09-10T00:05:00.000Z" });
    await recordJobStatus(bindings.DB, { jobKind: "odds", attemptKey: "2026-09-10T00:02:00.000Z/b", status: "success", safeCategory: "provider_published", observedAt: "2026-09-10T00:03:00.000Z", successfulAt: "2026-09-10T00:03:00.000Z" });
    expect(await bindings.DB.prepare("SELECT attempt_key,observed_at,successful_at FROM ops_job_status WHERE job_kind='odds'").first()).toEqual({ attempt_key: "2026-09-10T00:02:00.000Z/b", observed_at: "2026-09-10T00:03:00.000Z", successful_at: "2026-09-10T00:05:00.000Z" });
  });

  it("does not let an older completing attempt overwrite newer evidence", async () => {
    expect(await recordJobStatus(bindings.DB, { jobKind: "odds", attemptKey: "2026-09-10T00:02:00.000Z/new", status: "success", safeCategory: "provider_published", observedAt: "2026-09-10T00:02:05.000Z", successfulAt: "2026-09-10T00:02:05.000Z" })).toBe(true);
    expect(await recordJobStatus(bindings.DB, { jobKind: "odds", attemptKey: "2026-09-10T00:00:00.000Z/old", status: "failed", safeCategory: "provider_failed", observedAt: "2026-09-10T00:03:00.000Z" })).toBe(false);
    expect(await bindings.DB.prepare("SELECT attempt_key,status,safe_category,successful_at FROM ops_job_status WHERE job_kind='odds'").first()).toEqual({ attempt_key: "2026-09-10T00:02:00.000Z/new", status: "success", safe_category: "provider_published", successful_at: "2026-09-10T00:02:05.000Z" });
  });

  it("reports missing, stale, and failed scheduler evidence without stale-positive health", async () => {
    const now = Date.parse("2026-09-10T00:10:00.000Z");
    let response = await app({ now }).fetch(new Request(`${origin}/health/scheduler`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unknown", lastObservedAt: null, expectedBy: null });
    await recordJobStatus(bindings.DB, { jobKind: "odds", attemptKey: "a", status: "success", safeCategory: "provider_published", observedAt: "2026-09-10T00:00:00.000Z", successfulAt: "2026-09-10T00:00:00.000Z" });
    response = await app({ now }).fetch(new Request(`${origin}/health/scheduler`));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "stale" });
    await recordJobStatus(bindings.DB, { jobKind: "odds", attemptKey: "b", status: "failed", safeCategory: "provider_failed", observedAt: "2026-09-10T00:09:30.000Z" });
    response = await app({ now }).fetch(new Request(`${origin}/health/scheduler`));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "failed", lastObservedAt: "2026-09-10T00:09:30.000Z" });
    expect(await bindings.DB.prepare("SELECT successful_at FROM ops_job_status WHERE job_kind='odds'").first()).toEqual({ successful_at: "2026-09-10T00:00:00.000Z" });
  });

  it.each([
    ["future observation", "success", "2100-01-01T00:00:00.000Z", "2026-09-10T00:00:00.000Z"],
    ["noncanonical observation", "success", "2026-09-10T00:09:30Z", "2026-09-10T00:00:00.000Z"],
    ["future successful timestamp", "success", "2026-09-10T00:09:30.000Z", "2100-01-01T00:00:00.000Z"],
    ["unsupported status", "unexpected", "2026-09-10T00:09:30.000Z", "2026-09-10T00:00:00.000Z"]
  ])("treats %s as unknown in scheduler, job health, and ops", async (_name, status, observedAt, successfulAt) => {
    await bindings.DB.exec("PRAGMA ignore_check_constraints=ON");
    await bindings.DB.prepare("INSERT INTO ops_job_status(job_kind,attempt_key,status,safe_category,observed_at,successful_at) VALUES('odds','invalid',?,'provider_published',?,?)").bind(status, observedAt, successfulAt).run();
    const current = Date.parse("2026-09-10T00:10:00.000Z");
    const visibility = app({ ids: "operator-1", now: current });
    for (const path of ["/health/scheduler", "/health/odds"]) {
      const response = await visibility.fetch(new Request(`${origin}${path}`));
      expect(response.status, path).toBe(503);
      expect(await response.json(), path).toMatchObject({ status: "unknown" });
    }
    const ops = await (await visibility.fetch(new Request(`${origin}/ops/api/summary`))).json() as any;
    expect(ops.jobs).toEqual([expect.objectContaining({ status: "unknown", freshness: "unknown", observed_at: null, successful_at: null })]);
    await bindings.DB.exec("PRAGMA ignore_check_constraints=OFF");
  });

  it("treats unreadable job timestamps as unknown", async () => {
    await recordJobStatus(bindings.DB, { jobKind: "odds", attemptKey: "bad", status: "success", safeCategory: "provider_published", observedAt: "not-a-time", successfulAt: "not-a-time" });
    const response = await app({ now: Date.now() }).fetch(new Request(`${origin}/health/scheduler`));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unknown", lastObservedAt: null, expectedBy: null });
  });

  it("treats local odds scheduling as disabled while actual local backup evidence satisfies scheduler freshness", async () => {
    const localEnv = { ...(env as unknown as Env), BETTER_AUTH_SECRET: "local-auth-secret-long-enough", OPS_OPERATOR_USER_IDS: "operator-1", OPS_SERVICE_TOKEN: "local-ops-token", BACKUP_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
    const pending: Promise<unknown>[] = [];
    localWorker.scheduled!({ scheduledTime: Date.now(), cron: "*/2 * * * *", noRetry: () => undefined } as unknown as ScheduledEvent, localEnv, { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);

    const scheduler = await localWorker.fetch!(new Request("http://localhost/health/scheduler") as unknown as Parameters<NonNullable<typeof localWorker.fetch>>[0], localEnv, {} as ExecutionContext);
    expect(scheduler.status).toBe(200);
    expect(await scheduler.json()).toMatchObject({ status: "ok" });
    const summary = await localWorker.fetch!(new Request("http://localhost/ops/api/summary", { headers: { "x-local-test-user": "operator-1" } }) as unknown as Parameters<NonNullable<typeof localWorker.fetch>>[0], localEnv, {} as ExecutionContext);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({ readiness: { oddsJob: false, backupJob: true } });
  });

  it("inspects only a ready pool through the authenticated bounded read-only path", async () => {
    await bindings.DB.exec("INSERT OR IGNORE INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('owner','Owner','ops-owner@example.test',1,0,0); INSERT INTO pool_registry(pool_id,normalized_slug,do_name,creator_id,status,command_id,created_at) VALUES('ready-pool','ready-pool','ready-pool','owner','ready','create-ready','2026-09-10T00:00:00.000Z')");
    const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName("ready-pool"));
    await stub.fetch("https://pool.internal/command", { method: "POST", body: JSON.stringify({ type: "InitializePool", commandId: "init-ready", poolId: "ready-pool", slug: "ready-pool", creatorId: "owner", creatorName: "Owner", poolName: "Ready", password: "correct-password" }) });
    const snapshot = () => runInDurableObject(stub, async (_instance, state) => ({ pool: [...state.storage.sql.exec("SELECT * FROM pool")], outbox: [...state.storage.sql.exec("SELECT * FROM outbox")], alarm: await state.storage.getAlarm() }));
    const before = await snapshot();
    const response = await app({ ids: "operator-1" }).fetch(new Request(`${origin}/ops/api/pools/ready-pool/inspection`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ initialized: true, status: "observed", pendingOutboxCount: expect.any(Number), exhaustedOutboxCount: 0 });
    expect(await snapshot()).toEqual(before);
    expect((await app({ ids: "operator-1" }).fetch(new Request(`${origin}/ops/api/pools/not-ready/inspection`))).status).toBe(404);

    const malformedPools = { idFromName: () => ({}) as DurableObjectId, get: () => ({ fetch: async () => Response.json({ initialized: true, status: "observed", sampledAt: new Date().toISOString() }) }) } as unknown as DurableObjectNamespace;
    const malformedApp = createWorkerApp({ db: bindings.DB, pools: malformedPools, currentUser: async () => ({ id: "operator-1", name: "Operator" }), opsOperatorUserIds: "operator-1", opsServiceToken: "token" });
    expect((await malformedApp.fetch(new Request(`${origin}/ops/api/pools/ready-pool/inspection`))).status).toBe(503);
  });

  it("rejects absent, empty-segment, whitespace-only, and duplicate operator configuration", () => {
    for (const configured of [undefined, "", "  ", "operator-1,,operator-2", "operator-1,operator-1"]) expect(parseOperatorAllowlist(configured)).toBeNull();
    expect(parseOperatorAllowlist("operator-1, operator-2")).toEqual(new Set(["operator-1", "operator-2"]));
  });

  it("fails closed unless the authenticated exact immutable user ID is allowlisted", async () => {
    expect((await app().fetch(new Request(`${origin}/ops/api/summary`))).status).toBe(503);
    expect((await app({ ids: "operator-1", user: null }).fetch(new Request(`${origin}/ops/api/summary`))).status).toBe(401);
    expect((await app({ ids: "other", user: "operator-1" }).fetch(new Request(`${origin}/ops/api/summary`))).status).toBe(403);
    expect((await app({ ids: "operator-1" }).fetch(new Request(`${origin}/ops/api/summary`))).status).toBe(200);
  });
});

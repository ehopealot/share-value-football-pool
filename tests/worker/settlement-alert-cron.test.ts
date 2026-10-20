import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { runSettlementAlertCron } from "../../src/worker/settlement-alert-cron";

const db = (env as unknown as { DB: D1Database }).DB;
let migrated = false;
beforeEach(async () => {
  if (!migrated) { await applyD1Migrations(db, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
  await db.exec("DROP TABLE IF EXISTS settlement_alert_cursor; DELETE FROM pool_registry_command_response; DELETE FROM pool_registry; INSERT OR IGNORE INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('owner','Owner','owner@example.test',1,0,0);");
});
async function ready(id: string) {
  await db.prepare("INSERT INTO pool_registry (pool_id,normalized_slug,do_name,creator_id,status,command_id,created_at) VALUES (?,?,?,'owner','ready',?,'2030-01-01T00:00:00Z')").bind(id, id, id, id).run();
}
describe("periodic overdue-settlement alerts", () => {
  it("uses a bounded fair cursor, isolates failures, and alerts only overdue pools", async () => {
    for (let i = 0; i < 51; i++) await ready(`p-${String(i).padStart(2, "0")}`);
    const calls: string[] = [];
    const pools = { idFromName: (id: string) => id, get: (id: string) => ({ fetch: async (url: string, init: RequestInit) => {
      expect(url).toContain("/internal/ops/overdue-settlements");
      expect(init.headers).toEqual({ "x-ops-service-token": "ops-test" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      calls.push(id);
      if (id === "p-00") throw new Error("unavailable");
      return Response.json({ overdueWagers: id === "p-01" ? 3 : 0 });
    } }) } as unknown as DurableObjectNamespace;
    const report = vi.fn().mockResolvedValue(undefined);
    const dependencies = { db, pools, opsServiceToken: "ops-test", alerts: { report } };
    expect(await runSettlementAlertCron(dependencies)).toEqual({ inspected: 50 });
    expect(report.mock.calls.map(([alert]) => alert)).toEqual([{ kind: "settlement_check", scope: "p-00" }, { kind: "settlement_overdue", scope: "p-01", count: 3 }]);
    expect(await runSettlementAlertCron(dependencies)).toEqual({ inspected: 1 });
    expect(calls.at(-1)).toBe("p-50");
    await runSettlementAlertCron(dependencies);
    expect(calls[51]).toBe("p-00");
  });

  it("allows 15 seconds per inspection and preserves the between-pool scan budget", async () => {
    await ready("budget-a");
    await ready("budget-b");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const fetch = vi.fn().mockImplementation(async () => {
      clock.mockReturnValue(20_000);
      return Response.json({ overdueWagers: 0 });
    });
    const pools = { idFromName: (id: string) => id, get: () => ({ fetch }) } as unknown as DurableObjectNamespace;
    const report = vi.fn();
    try {
      expect(await runSettlementAlertCron({ db, pools, opsServiceToken: "ops-test", alerts: { report } })).toEqual({ inspected: 1 });
      expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
      expect(report).not.toHaveBeenCalled();
      expect((await db.prepare("SELECT last_pool_id FROM settlement_alert_cursor").first<{ last_pool_id: string }>())?.last_pool_id).toBe("budget-a");
    } finally { timeout.mockRestore(); clock.mockRestore(); }
  });

  it("does not access storage without the read-only ops token", async () => {
    expect(await runSettlementAlertCron({ db: {} as D1Database, pools: {} as DurableObjectNamespace, alerts: { report: vi.fn() } })).toEqual({ inspected: 0 });
  });
});

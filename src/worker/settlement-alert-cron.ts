import type { OperationalAlerts } from "../services/operational-alerts";

type Dependencies = { db: D1Database; pools: DurableObjectNamespace; opsServiceToken?: string; alerts: OperationalAlerts };

/** Independent of settlement alarms: silent/stopped processing must still be observable. */
export async function runSettlementAlertCron({ db, pools, opsServiceToken, alerts }: Dependencies): Promise<{ inspected: number }> {
  if (!opsServiceToken?.trim()) return { inspected: 0 };
  const startedAt = Date.now();
  await db.prepare("CREATE TABLE IF NOT EXISTS settlement_alert_cursor (name TEXT PRIMARY KEY,last_pool_id TEXT)").run();
  const cursor = await db.prepare("SELECT last_pool_id FROM settlement_alert_cursor WHERE name='scheduled'").first<{ last_pool_id: string }>();
  let page = await db.prepare("SELECT pool_id FROM pool_registry WHERE status='ready' AND pool_id > ? ORDER BY pool_id LIMIT 50").bind(cursor?.last_pool_id ?? "").all<{ pool_id: string }>();
  if (!page.results.length && cursor?.last_pool_id) page = await db.prepare("SELECT pool_id FROM pool_registry WHERE status='ready' ORDER BY pool_id LIMIT 50").all<{ pool_id: string }>();
  let inspected = 0; let last: string | undefined;
  for (const { pool_id: poolId } of page.results) {
    if (inspected && Date.now() - startedAt >= 20_000) break;
    inspected++; last = poolId;
    try {
      const response = await pools.get(pools.idFromName(poolId)).fetch("https://pool.internal/internal/ops/overdue-settlements", { headers: { "x-ops-service-token": opsServiceToken }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error("SETTLEMENT_INSPECTION_FAILED");
      const value = await response.json<{ overdueWagers?: unknown }>();
      if (!Number.isSafeInteger(value?.overdueWagers) || Number(value.overdueWagers) < 0) throw new Error("SETTLEMENT_INSPECTION_INVALID");
      if (Number(value.overdueWagers) > 0) await alerts.report({ kind: "settlement_overdue", scope: poolId, count: Number(value.overdueWagers) });
    } catch { await alerts.report({ kind: "settlement_check", scope: poolId }).catch(() => undefined); }
  }
  if (last !== undefined) await db.prepare("INSERT INTO settlement_alert_cursor (name,last_pool_id) VALUES ('scheduled',?) ON CONFLICT(name) DO UPDATE SET last_pool_id=excluded.last_pool_id").bind(last).run();
  return { inspected };
}

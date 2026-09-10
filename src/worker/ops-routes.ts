import type { Hono } from "hono";
import { z } from "zod";
import { requireOperatorRead, type OperatorReadDependencies } from "./ops-auth";
import { isJobStatus, parseOperationalTimestamp } from "./job-status";

export type OpsDependencies = OperatorReadDependencies & {
  db: D1Database;
  pools: DurableObjectNamespace;
  opsServiceToken?: string;
  oddsConfigured?: boolean;
  backupConfigured?: boolean;
};

const canonicalTime = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
});
const inspectionResponse = z.object({
  initialized: z.boolean(),
  status: z.enum(["observed", "unknown"]),
  sampledAt: canonicalTime,
  reconciliationRetryAt: canonicalTime.nullable(),
  discoveryRetryAt: canonicalTime.nullable(),
  outboxRetryAt: canonicalTime.nullable(),
  alarmAt: canonicalTime.nullable(),
  pendingReconciliationCount: z.number().int().min(0),
  pendingOutboxCount: z.number().int().min(0),
  exhaustedOutboxCount: z.number().int().min(0),
  exhaustedOutboxCategories: z.array(z.enum(["invalid_delivery", "delivery_failed"])).max(2)
}).strict();

export function installOpsRoutes(app: Hono, dependencies: OpsDependencies): void {
  app.get("/ops/api/summary", async (c) => {
    const auth = await requireOperatorRead(c, dependencies);
    if (auth.response) return auth.response;
    try {
      const capturedNow = Date.now();
      const jobs = await dependencies.db.prepare("SELECT job_kind,status,safe_category,observed_at,successful_at FROM ops_job_status ORDER BY job_kind").all<{ job_kind: string; status: string; safe_category: string; observed_at: string; successful_at: string | null }>();
      const safeJobs = jobs.results.map((job) => {
        const observedAt = parseOperationalTimestamp(job.observed_at, capturedNow);
        const successfulAt = job.successful_at === null ? null : parseOperationalTimestamp(job.successful_at, capturedNow);
        const readable = isJobStatus(job.status) && observedAt !== null && (job.successful_at === null || successfulAt !== null);
        return readable ? { ...job, freshness: capturedNow <= observedAt + 4 * 60_000 ? "current" : "stale", observed_at: new Date(observedAt).toISOString(), successful_at: successfulAt === null ? null : new Date(successfulAt).toISOString() }
          : { job_kind: job.job_kind, status: "unknown", freshness: "unknown", safe_category: "unreadable_evidence", observed_at: null, successful_at: null };
      });
      return c.json({
        readiness: { operatorAllowlist: true, poolInspection: Boolean(dependencies.opsServiceToken?.trim()), oddsJob: Boolean(dependencies.oddsConfigured), backupJob: Boolean(dependencies.backupConfigured) },
        jobs: safeJobs,
        limitations: { perPoolBackgroundMonitoring: false, automatedNotifications: false, inAppRepair: false }
      });
    } catch {
      return c.json({ code: "OPS_UNAVAILABLE" }, 503);
    }
  });

  app.get("/ops/api/pools/:poolId/inspection", async (c) => {
    const auth = await requireOperatorRead(c, dependencies);
    if (auth.response) return auth.response;
    if (!dependencies.opsServiceToken?.trim()) return c.json({ code: "POOL_INSPECTION_UNAVAILABLE" }, 503);
    const poolId = c.req.param("poolId");
    if (!poolId || poolId.length > 200) return c.json({ code: "INVALID_REQUEST" }, 400);
    const ready = await dependencies.db.prepare("SELECT pool_id FROM pool_registry WHERE pool_id=? AND status='ready'").bind(poolId).first<{ pool_id: string }>();
    if (!ready) return c.json({ code: "POOL_NOT_FOUND" }, 404);
    try {
      const signal = AbortSignal.timeout(3_000);
      const request = dependencies.pools.get(dependencies.pools.idFromName(poolId)).fetch("https://pool.internal/internal/ops/inspection", {
        headers: { "x-ops-service-token": dependencies.opsServiceToken }, signal
      });
      const response = await Promise.race([request, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("INSPECTION_TIMEOUT")), 3_000))]);
      if (!response.ok) return c.json({ code: "POOL_INSPECTION_UNKNOWN" }, 503);
      const parsed = inspectionResponse.safeParse(await response.json());
      if (!parsed.success || Math.abs(Date.now() - Date.parse(parsed.data.sampledAt)) > 6_000) return c.json({ code: "POOL_INSPECTION_UNKNOWN" }, 503);
      return c.json(parsed.data);
    } catch {
      return c.json({ code: "POOL_INSPECTION_UNKNOWN" }, 503);
    }
  });
}

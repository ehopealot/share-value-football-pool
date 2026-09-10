import type { Context, Hono } from "hono";
import { isJobStatus, parseOperationalTimestamp } from "./job-status";

export type HealthDependencies = { db?: D1Database; pools?: DurableObjectNamespace; queue?: Queue; oddsConfigured?: boolean; backupConfigured?: boolean; healthNow?: () => number };
const response = (c: Context, status: "ok" | "configured" | "disabled" | "degraded" | "error", httpStatus: 200 | 503 = 200) => c.json({ status }, httpStatus);

const jobResponse = async (c: Context, dependencies: HealthDependencies, kind: "odds" | "backup", configured: boolean) => {
  if (!configured) return response(c, "disabled");
  if (!dependencies.db) return c.json({ status: "unknown", lastObservedAt: null, lastSuccessfulAt: null }, 503);
  const capturedNow = (dependencies.healthNow ?? Date.now)();
  try {
    const row = await dependencies.db.prepare("SELECT status,observed_at,successful_at FROM ops_job_status WHERE job_kind=?").bind(kind).first<{ status: string; observed_at: string; successful_at: string | null }>();
    const observedAt = row ? parseOperationalTimestamp(row.observed_at, capturedNow) : null;
    const successfulAt = row?.successful_at ? parseOperationalTimestamp(row.successful_at, capturedNow) : null;
    if (!row || !isJobStatus(row.status) || observedAt === null || (row.successful_at !== null && successfulAt === null)) return c.json({ status: "unknown", lastObservedAt: null, lastSuccessfulAt: null }, 503);
    const stale = capturedNow > observedAt + 4 * 60_000;
    const status = stale ? "stale" : row.status === "success" || row.status === "not_due" ? "ok" : row.status;
    return c.json({ status, lastObservedAt: new Date(observedAt).toISOString(), lastSuccessfulAt: successfulAt === null ? null : new Date(successfulAt).toISOString() }, status === "ok" ? 200 : 503);
  } catch {
    return c.json({ status: "unknown", lastObservedAt: null, lastSuccessfulAt: null }, 503);
  }
};

/** Public operational checks intentionally expose only a coarse state, never errors, identifiers, or member data. */
export function installHealthRoutes(app: Hono, dependencies: HealthDependencies): void {
  app.get("/health/app", (c) => response(c, "ok"));
  app.get("/health/scheduler", async (c) => {
    if (!dependencies.db) return c.json({ status: "unknown", lastObservedAt: null, expectedBy: null }, 503);
    const capturedNow = (dependencies.healthNow ?? Date.now)();
    try {
      const rows = (await dependencies.db.prepare("SELECT job_kind,status,observed_at,successful_at FROM ops_job_status").all<{ job_kind: string; status: string; observed_at: string; successful_at: string | null }>()).results;
      const expectedKinds = [dependencies.oddsConfigured ? "odds" : null, dependencies.backupConfigured ? "backup" : null].filter((kind): kind is string => kind !== null);
      if (!expectedKinds.length || expectedKinds.some((kind) => !rows.some((row) => row.job_kind === kind))) return c.json({ status: "unknown", lastObservedAt: null, expectedBy: null }, 503);
      const relevantRows = rows.filter((row) => expectedKinds.includes(row.job_kind));
      const observed = relevantRows.map((row) => parseOperationalTimestamp(row.observed_at, capturedNow));
      const invalid = relevantRows.some((row) => !isJobStatus(row.status) || (row.successful_at !== null && parseOperationalTimestamp(row.successful_at, capturedNow) === null));
      if (invalid || observed.some((value) => value === null)) return c.json({ status: "unknown", lastObservedAt: null, expectedBy: null }, 503);
      const observedTimes = observed as number[];
      const lastObserved = Math.max(...observedTimes);
      const expectedBy = Math.min(...observedTimes.map((value) => value + 4 * 60_000));
      const stale = capturedNow > expectedBy;
      const failed = relevantRows.some((row) => row.status === "failed");
      const unknown = relevantRows.some((row) => row.status === "unknown" || row.status === "superseded");
      const status = stale ? "stale" : failed ? "failed" : unknown ? "unknown" : "ok";
      return c.json({ status, lastObservedAt: new Date(lastObserved).toISOString(), expectedBy: new Date(expectedBy).toISOString() }, status === "ok" ? 200 : 503);
    } catch {
      return c.json({ status: "unknown", lastObservedAt: null, expectedBy: null }, 503);
    }
  });
  app.get("/health/d1", async (c) => {
    if (!dependencies.db) return response(c, "degraded", 503);
    try { await dependencies.db.prepare("SELECT 1").first(); return response(c, "ok"); } catch { return response(c, "error", 503); }
  });
  app.get("/health/do", (c) => response(c, dependencies.pools ? "configured" : "degraded"));
  app.get("/health/queue", async (c) => {
    if (!dependencies.db || !dependencies.queue) return response(c, "degraded");
    try {
      const states = await dependencies.db.prepare("SELECT attempts, last_error, queued_at FROM projection_delivery WHERE delivered_at IS NULL").all<{ attempts: number; last_error: string | null; queued_at: string }>();
      let status: "ok" | "degraded" | "error" = "ok";
      for (const state of states.results) {
        const age = Date.now() - new Date(state.queued_at).getTime();
        if (!Number.isFinite(age) || state.attempts >= 3 || (state.last_error && age >= 60_000) || age >= 15 * 60_000) return response(c, "error");
        if (state.attempts > 1 || state.last_error || age >= 5 * 60_000) status = "degraded";
      }
      return response(c, status);
    } catch { return response(c, "error"); }
  });
  app.get("/health/backups", (c) => jobResponse(c, dependencies, "backup", Boolean(dependencies.backupConfigured)));
  app.get("/health/odds", (c) => jobResponse(c, dependencies, "odds", Boolean(dependencies.oddsConfigured)));
}

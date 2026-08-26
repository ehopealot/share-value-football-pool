import type { Context, Hono } from "hono";

export type HealthDependencies = { db?: D1Database; pools?: DurableObjectNamespace; queue?: Queue; oddsConfigured?: boolean; backupConfigured?: boolean };
const response = (c: Context, status: "ok" | "configured" | "disabled" | "degraded" | "error") => c.json({ status });

/** Public operational checks intentionally expose only a coarse state, never errors, identifiers, or member data. */
export function installHealthRoutes(app: Hono, dependencies: HealthDependencies): void {
  app.get("/health/app", (c) => response(c, "ok"));
  app.get("/health/d1", async (c) => {
    if (!dependencies.db) return response(c, "degraded");
    try { await dependencies.db.prepare("SELECT 1").first(); return response(c, "ok"); } catch { return response(c, "error"); }
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
  app.get("/health/backups", (c) => response(c, dependencies.backupConfigured ? "configured" : "disabled"));
  app.get("/health/odds", async (c) => {
    if (!dependencies.db || !dependencies.oddsConfigured) return response(c, "degraded");
    try {
      const row = await dependencies.db.prepare("SELECT last_error FROM odds_ingestion WHERE provider = 'odds'").first<{ last_error: string | null }>();
      return response(c, row?.last_error ? "error" : row ? "ok" : "degraded");
    } catch { return response(c, "error"); }
  });
}

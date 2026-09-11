import { sendOperationalAlertEmail } from "../auth/email-sender";
import { parseOperatorAllowlist } from "../worker/ops-auth";

const descriptions = {
  odds_update: ["Odds update failed", "An odds update failed. Inspect Worker logs for provider or ingestion errors; cached offers may remain visible."],
  placement: ["Wager operation failed", "A wager quote or placement encountered a technical failure. The client outcome may be unknown; inspect authoritative records before retrying or correcting anything."],
  settlement: ["Settlement processing failed", "Settlement processing encountered a technical failure. Existing retry behavior is unchanged; inspect the affected pool and Worker logs."],
  settlement_overdue: ["Settlement overdue", "Wagers remain open at least 20 minutes after all required games were first observed terminal by the provider feed. For multi-leg wagers the latest game determines the deadline."],
  settlement_check: ["Settlement monitoring unavailable", "The periodic unsettled-wager inspection failed. This is unknown settlement health, not proof that wagers are overdue."]
} as const;
export type OperationalAlert = { kind: keyof typeof descriptions; scope: string; count?: number };
export type OperationalAlerts = { report(alert: OperationalAlert): Promise<void> };
export type OperationalAlertEnv = { DB?: D1Database; RESEND_API_KEY?: string; OPS_OPERATOR_USER_IDS?: string };
const COOLDOWN_MS = 30 * 60 * 1000;

/** Reservation is intentionally before delivery: failed mail can be lost until the next cooldown. No retry queue. */
export function createOperationalAlerts(env: OperationalAlertEnv, options: { fetcher?: typeof fetch; clock?: () => number } = {}): OperationalAlerts | undefined {
  const operators = parseOperatorAllowlist(env.OPS_OPERATOR_USER_IDS);
  if (!env.DB || !env.RESEND_API_KEY?.trim() || !operators?.size || operators.size > 50) return undefined;
  const db = env.DB; const apiKey = env.RESEND_API_KEY; const ids = [...operators];
  return { async report(alert) {
    try {
      const recipients = await db.prepare(`SELECT email FROM user WHERE id IN (${ids.map(() => "?").join(",")}) AND emailVerified = 1 AND length(trim(email)) > 0 ORDER BY id`).bind(...ids).all<{ email: string }>();
      if (!recipients.results.length) return;
      await db.prepare("CREATE TABLE IF NOT EXISTS operational_alert_throttle (kind TEXT NOT NULL, scope TEXT NOT NULL, next_alert_at INTEGER NOT NULL, PRIMARY KEY(kind,scope))").run();
      const now = (options.clock ?? Date.now)();
      const claimed = await db.prepare("INSERT INTO operational_alert_throttle (kind,scope,next_alert_at) VALUES (?,?,?) ON CONFLICT(kind,scope) DO UPDATE SET next_alert_at=excluded.next_alert_at WHERE operational_alert_throttle.next_alert_at <= ? RETURNING next_alert_at").bind(alert.kind, alert.scope, now + COOLDOWN_MS, now).first();
      if (!claimed) return;
      const [title, description] = descriptions[alert.kind];
      await Promise.all(recipients.results.map(async ({ email }) => {
        try { await sendOperationalAlertEmail({ apiKey, from: "Yourfootballpool <noreply@officepool.football>", fetcher: options.fetcher }, { to: email, title, description, scope: alert.scope, observedAt: new Date(now).toISOString(), count: alert.count }); }
        catch { console.warn({ event: "operational_alert_delivery_failed", kind: alert.kind }); }
      }));
    } catch { console.warn({ event: "operational_alert_unavailable", kind: alert.kind }); }
  } };
}

/** Also guards synchronous callback/scheduling failures; reporting cannot alter a business outcome. */
export function scheduleOperationalAlert(owner: { waitUntil(promise: Promise<unknown>): void }, alerts: OperationalAlerts | undefined, alert: OperationalAlert): void {
  if (!alerts) return;
  try { owner.waitUntil(alerts.report(alert).catch(() => undefined)); } catch { /* best effort */ }
}

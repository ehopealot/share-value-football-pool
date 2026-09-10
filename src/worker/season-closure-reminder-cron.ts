import type { PoolNotifier } from "../auth/email-sender";

const PAGE_SIZE = 50;
const RUN_BUDGET_MS = 20_000;

type Configuration = { RESEND_API_KEY: string; SETTLEMENT_SERVICE_TOKEN: string };
export function seasonClosureReminderConfigured(env: { RESEND_API_KEY?: string; SETTLEMENT_SERVICE_TOKEN?: string }): env is Configuration {
  return Boolean(env.RESEND_API_KEY?.trim() && env.SETTLEMENT_SERVICE_TOKEN?.trim());
}

type SeasonClosureReminderMessage = Parameters<NonNullable<PoolNotifier["notifySeasonClosureReminder"]>>[0];
type SeasonClosureReminderNotifier = { notifySeasonClosureReminder(message: SeasonClosureReminderMessage): Promise<void> };

export type SeasonClosureReminderCronDependencies = {
  db: D1Database;
  pools: DurableObjectNamespace;
  settlementServiceToken: string;
  notifier: SeasonClosureReminderNotifier;
  adminOrigin: string;
};

type Prepared = { status: "prepared"; attemptToken: string; commissionerId: string };
type Claimed = {
  status: "claimed"; attemptToken: string; commissionerId: string; recipientEmail: string; poolName: string; poolSlug: string; seasonLabel: string;
  gameName: string; kickoff: string; idempotencyKey: string;
};

const validPrepared = (value: unknown): value is Prepared => {
  const row = value as Partial<Prepared> | null;
  return row?.status === "prepared" && typeof row.attemptToken === "string" && typeof row.commissionerId === "string";
};
const validClaimed = (value: unknown): value is Claimed => {
  const row = value as Partial<Claimed> | null;
  return row?.status === "claimed" && typeof row.attemptToken === "string" && typeof row.commissionerId === "string" && typeof row.recipientEmail === "string"
    && typeof row.poolName === "string" && typeof row.poolSlug === "string" && typeof row.seasonLabel === "string" && typeof row.gameName === "string"
    && typeof row.kickoff === "string" && typeof row.idempotencyKey === "string";
};

async function reminderOperation(stub: DurableObjectStub, token: string, body: Record<string, string>): Promise<unknown> {
  const response = await stub.fetch("https://pool.internal/internal/season-closure-reminder", {
    method: "POST", headers: { "content-type": "application/json", "x-settlement-service-token": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error("REMINDER_OPERATION_FAILED");
  return response.json();
}

/** Bounded ready-pool sweep; each pool failure is isolated and the cursor advances fairly. */
export async function runSeasonClosureReminderCron(dependencies: SeasonClosureReminderCronDependencies, clock: () => number = Date.now): Promise<{ attemptedPools: number; sent: number }> {
  const startedAt = Date.now();
  await dependencies.db.prepare("CREATE TABLE IF NOT EXISTS season_closure_reminder_cursor (name TEXT PRIMARY KEY, last_pool_id TEXT)").run();
  const cursor = await dependencies.db.prepare("SELECT last_pool_id FROM season_closure_reminder_cursor WHERE name = 'scheduled'").first<{ last_pool_id: string | null }>();
  const after = cursor?.last_pool_id ?? "";
  let page = await dependencies.db.prepare("SELECT pool_id FROM pool_registry WHERE status = 'ready' AND pool_id > ? ORDER BY pool_id LIMIT ?").bind(after, PAGE_SIZE).all<{ pool_id: string }>();
  if (!page.results.length && after) page = await dependencies.db.prepare("SELECT pool_id FROM pool_registry WHERE status = 'ready' ORDER BY pool_id LIMIT ?").bind(PAGE_SIZE).all<{ pool_id: string }>();

  let attemptedPools = 0;
  let sent = 0;
  let lastAttempted: string | null = null;
  // Scheduled events can be delayed; refresh time at every authority boundary.
  const now = () => new Date(clock()).toISOString();
  for (const row of page.results) {
    if (attemptedPools > 0 && Date.now() - startedAt >= RUN_BUDGET_MS) break;
    attemptedPools++;
    lastAttempted = row.pool_id;
    try {
      const stub = dependencies.pools.get(dependencies.pools.idFromName(row.pool_id));
      const preparedValue = await reminderOperation(stub, dependencies.settlementServiceToken, { action: "prepare", now: now() });
      if (!validPrepared(preparedValue)) continue;
      const recipient = await dependencies.db.prepare("SELECT email FROM user WHERE id = ?").bind(preparedValue.commissionerId).first<{ email: string }>();
      if (!recipient?.email?.trim()) continue;
      const claimValue = await reminderOperation(stub, dependencies.settlementServiceToken, {
        action: "claim", now: now(), attemptToken: preparedValue.attemptToken, commissionerId: preparedValue.commissionerId, recipientEmail: recipient.email
      });
      if (!validClaimed(claimValue)) continue;
      // A delayed claim response must not initiate email once kickoff has arrived.
      if (!(clock() < Date.parse(claimValue.kickoff))) continue;
      try {
        await dependencies.notifier.notifySeasonClosureReminder({
          to: claimValue.recipientEmail, poolName: claimValue.poolName, seasonLabel: claimValue.seasonLabel, gameName: claimValue.gameName,
          kickoff: claimValue.kickoff, adminUrl: `${dependencies.adminOrigin}/p/${encodeURIComponent(claimValue.poolSlug)}/admin/season`, idempotencyKey: claimValue.idempotencyKey
        });
        await reminderOperation(stub, dependencies.settlementServiceToken, { action: "complete", now: now(), attemptToken: claimValue.attemptToken });
        sent++;
      } catch {
        await reminderOperation(stub, dependencies.settlementServiceToken, { action: "fail", now: now(), attemptToken: claimValue.attemptToken }).catch(() => undefined);
      }
    } catch {
      // One unavailable pool must not prevent fair progress through the bounded page.
    }
  }
  if (lastAttempted !== null) await dependencies.db.prepare("INSERT INTO season_closure_reminder_cursor (name, last_pool_id) VALUES ('scheduled', ?) ON CONFLICT(name) DO UPDATE SET last_pool_id = excluded.last_pool_id").bind(lastAttempted).run();
  return { attemptedPools, sent };
}

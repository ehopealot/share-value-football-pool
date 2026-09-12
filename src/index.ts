import { createAuthBoundary } from "./auth";
import { authenticatedUserFromSession, sessionIsRecentForUser } from "./auth/session";
import { createResendEmailSender, createResendPoolNotifier } from "./auth/email-sender";
import { TheOddsApiProvider } from "./odds/the-odds-api-provider";
import { OddsIngestion } from "./odds/ingestion";
import { runOddsCron } from "./worker/cron";
import { createWorkerApp } from "./worker/app";
import { RateLimiter } from "./security/rate-limit";
import { createAuthAbuseGuard } from "./security/turnstile";
import { consumeProjectionQueue } from "./worker/queue";
import { handleInternalSettlement } from "./worker/internal-settlement";
import { backupConfigured, runBackupCron } from "./worker/backup-cron";
import { jobAttemptKey, recordJobStatus } from "./worker/job-status";
import { createOperationalAlerts, scheduleOperationalAlert } from "./services/operational-alerts";
import { runSettlementAlertCron } from "./worker/settlement-alert-cron";

const authLimiter = new RateLimiter(5);
const poolMutationLimiter = new RateLimiter();
const placementRefreshLimiter = new RateLimiter(10, 60_000);
const productionAuthOrigin = "https://officepool.football";
const productionTurnstileHostname = new URL(productionAuthOrigin).hostname;
const productionEmailFrom = "Yourfootballpool <noreply@officepool.football>";
export { PoolDO } from "./durable/pool-do";

export interface Env {
  DB: D1Database; POOL_DO: DurableObjectNamespace; ODDS_API_KEY?: string; BETTER_AUTH_SECRET?: string; RESEND_API_KEY?: string;
  POOL_COMMAND_AUTHENTICATOR_KEY?: string; TURNSTILE_SECRET_KEY?: string;
  SETTLEMENT_SERVICE_TOKEN?: string; POOL_PROJECTION_SERVICE_TOKEN?: string; POOL_BACKUP_SERVICE_TOKEN?: string; OPS_SERVICE_TOKEN?: string; OPS_OPERATOR_USER_IDS?: string;
  BACKUP_ENCRYPTION_KEY?: string; BACKUPS?: R2Bucket; POOL_EVENTS?: Queue; ASSETS: Fetcher;
}

export { handleInternalSettlement };

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx): Promise<Response> {
    const internalSettlement = await handleInternalSettlement(request, env);
    if (internalSettlement) return internalSettlement;
    if (!env.BETTER_AUTH_SECRET || !env.RESEND_API_KEY?.trim()) return Response.json({ code: "AUTH_CONFIGURATION_UNAVAILABLE" }, { status: 503 });
    const emailOptions = { apiKey: env.RESEND_API_KEY, from: productionEmailFrom };
    const auth = createAuthBoundary({ db: env.DB, baseURL: productionAuthOrigin, secret: env.BETTER_AUTH_SECRET, emailSender: createResendEmailSender(emailOptions) });
    const app = createWorkerApp({
      db: env.DB, pools: env.POOL_DO, commandAuthenticatorKey: env.POOL_COMMAND_AUTHENTICATOR_KEY, turnstileSecret: env.TURNSTILE_SECRET_KEY, turnstileExpectedHostname: productionTurnstileHostname,
      authHandler: auth.handler, limiter: poolMutationLimiter,
      authAbuseGuard: createAuthAbuseGuard({ secret: env.TURNSTILE_SECRET_KEY, expectedHostname: productionTurnstileHostname, allowInsecureLocalAuth: false, limiter: authLimiter }),
      allowInsecureLocalAuth: false, queue: env.POOL_EVENTS, spaAssets: env.ASSETS, poolNotifier: createResendPoolNotifier(emailOptions), oddsConfigured: Boolean(env.ODDS_API_KEY), backupConfigured: backupConfigured(env),
      opsOperatorUserIds: env.OPS_OPERATOR_USER_IDS, opsServiceToken: env.OPS_SERVICE_TOKEN, operationalAlerts: createOperationalAlerts(env),
      placementRefreshLimiter,
      async refreshPlacementOdds(leagues) {
        if (!env.ODDS_API_KEY) return;
        // One shared deadline covers both odds and score requests across all ticket leagues.
        const signal = AbortSignal.timeout(4000);
        const provider = new TheOddsApiProvider(env.ODDS_API_KEY, (input, init) => fetch(input, { ...init, signal }));
        const result = await new OddsIngestion(env.DB, provider).poll({ placementLeagues: leagues });
        return result.placementEvents;
      },
      async currentUser(sessionRequest) { return authenticatedUserFromSession(await auth.api.getSession({ headers: sessionRequest.headers })); },
      async recentlyAuthenticated(sessionRequest, user) { return sessionIsRecentForUser(await auth.api.getSession({ headers: sessionRequest.headers }), user.id); }
    });
    return app.fetch(request, env, ctx);
  },
  scheduled(event, env, ctx): void {
    const scheduledAt = new Date(typeof event.scheduledTime === "number" ? event.scheduledTime : Date.now());
    const alerts = createOperationalAlerts(env);
    if (alerts && env.OPS_SERVICE_TOKEN?.trim()) {
      ctx.waitUntil(runSettlementAlertCron({ db: env.DB, pools: env.POOL_DO, opsServiceToken: env.OPS_SERVICE_TOKEN, alerts }).catch(() => alerts.report({ kind: "settlement_check", scope: "global" })));
    }
    if (env.ODDS_API_KEY) {
      const startedAt = scheduledAt;
      const attemptKey = jobAttemptKey(startedAt);
      ctx.waitUntil(runOddsCron(env.DB, new TheOddsApiProvider(env.ODDS_API_KEY)).then(async (result) => {
        const observedAt = new Date().toISOString();
        const status = result.operationalOutcome === "published" ? "success" : result.operationalOutcome === "not_due" ? "not_due" : "superseded";
        await recordJobStatus(env.DB, { jobKind: "odds", attemptKey, status, safeCategory: status === "success" ? "provider_published" : status === "not_due" ? "provider_not_due" : "provider_superseded", observedAt, ...(status === "success" ? { successfulAt: observedAt } : {}) }).catch(() => undefined);
      }).catch(async (error) => {
        await recordJobStatus(env.DB, { jobKind: "odds", attemptKey, status: "failed", safeCategory: "provider_failed", observedAt: new Date().toISOString() }).catch(() => undefined);
        scheduleOperationalAlert(ctx, alerts, { kind: "odds_update", scope: "global" });
        throw error;
      }));
    }
    if (backupConfigured(env)) {
      const attemptKey = jobAttemptKey(scheduledAt);
      ctx.waitUntil(runBackupCron({ db: env.DB, pools: env.POOL_DO, bucket: env.BACKUPS, encryptionKey: env.BACKUP_ENCRYPTION_KEY, backupServiceToken: env.POOL_BACKUP_SERVICE_TOKEN }, async (outcome) => {
        const observedAt = new Date().toISOString();
        await recordJobStatus(env.DB, { jobKind: "backup", attemptKey, status: outcome.status, safeCategory: outcome.safeCategory, observedAt, ...(outcome.status === "success" ? { successfulAt: observedAt } : {}) });
      }));
    }
  },
  queue(batch, env, ctx): void { ctx.waitUntil(consumeProjectionQueue(batch, { db: env.DB, pools: env.POOL_DO, projectionServiceToken: env.POOL_PROJECTION_SERVICE_TOKEN })); }
};
export default worker;

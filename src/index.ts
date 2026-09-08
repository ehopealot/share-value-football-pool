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
  SETTLEMENT_SERVICE_TOKEN?: string; POOL_PROJECTION_SERVICE_TOKEN?: string; POOL_BACKUP_SERVICE_TOKEN?: string;
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
  scheduled(_event, env, ctx): void { if (env.ODDS_API_KEY) ctx.waitUntil(runOddsCron(env.DB, new TheOddsApiProvider(env.ODDS_API_KEY))); if (backupConfigured(env)) ctx.waitUntil(runBackupCron({ db: env.DB, pools: env.POOL_DO, bucket: env.BACKUPS, encryptionKey: env.BACKUP_ENCRYPTION_KEY, backupServiceToken: env.POOL_BACKUP_SERVICE_TOKEN })); },
  queue(batch, env, ctx): void { ctx.waitUntil(consumeProjectionQueue(batch, { db: env.DB, pools: env.POOL_DO, projectionServiceToken: env.POOL_PROJECTION_SERVICE_TOKEN })); }
};
export default worker;

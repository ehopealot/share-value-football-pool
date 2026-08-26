import { PoolDO } from "./durable/pool-do";
import { createAuthBoundary } from "./auth";
import type { EmailSender } from "./auth/email-sender";
import { TheOddsApiProvider } from "./odds/the-odds-api-provider";
import { runOddsCron } from "./worker/cron";
import { createWorkerApp } from "./worker/app";
import { RateLimiter } from "./security/rate-limit";
import { createAuthAbuseGuard } from "./security/turnstile";
import { internalSettlementCommand } from "./contracts/commands";
import { consumeProjectionQueue } from "./worker/queue";
import { backupConfigured, runBackupCron } from "./worker/backup-cron";

const authLimiter = new RateLimiter(5);
const poolMutationLimiter = new RateLimiter();
/** Production email cannot silently become a development mailbox. */
const unavailableEmailSender: EmailSender = { async send() { throw new Error("EMAIL_SENDER_UNAVAILABLE"); } };
export { PoolDO } from "./durable/pool-do";

export interface Env {
  DB: D1Database; POOL_DO: DurableObjectNamespace; ODDS_API_KEY?: string; BETTER_AUTH_SECRET?: string;
  POOL_COMMAND_AUTHENTICATOR_KEY?: string; TURNSTILE_SECRET_KEY?: string;
  SETTLEMENT_SERVICE_TOKEN?: string; POOL_PROJECTION_SERVICE_TOKEN?: string; POOL_BACKUP_SERVICE_TOKEN?: string;
  BACKUP_ENCRYPTION_KEY?: string; BACKUPS?: R2Bucket; POOL_EVENTS?: Queue; ASSETS: Fetcher;
}

export async function handleInternalSettlement(request: Request, env: Pick<Env, "POOL_DO" | "SETTLEMENT_SERVICE_TOKEN">): Promise<Response | null> {
  const settlementPath = new URL(request.url).pathname.match(/^\/internal\/pools\/([^/]+)\/settle$/);
  if (!settlementPath) return null;
  const token = request.headers.get("x-settlement-service-token");
  const command = internalSettlementCommand.safeParse({ poolId: settlementPath[1], serviceToken: token });
  if (request.method !== "POST" || request.headers.has("origin") || !env.SETTLEMENT_SERVICE_TOKEN || !command.success || token !== env.SETTLEMENT_SERVICE_TOKEN) return new Response("Not found", { status: 404 });
  return env.POOL_DO.get(env.POOL_DO.idFromName(command.data.poolId)).fetch("https://pool.internal/internal/settle", { method: "POST", headers: { "x-settlement-service-token": token } });
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const internalSettlement = await handleInternalSettlement(request, env);
    if (internalSettlement) return internalSettlement;
    if (!env.BETTER_AUTH_SECRET) return Response.json({ code: "AUTH_CONFIGURATION_UNAVAILABLE" }, { status: 503 });
    const auth = createAuthBoundary({ db: env.DB, baseURL: new URL(request.url).origin, secret: env.BETTER_AUTH_SECRET, emailSender: unavailableEmailSender });
    const app = createWorkerApp({
      db: env.DB, pools: env.POOL_DO, commandAuthenticatorKey: env.POOL_COMMAND_AUTHENTICATOR_KEY, turnstileSecret: env.TURNSTILE_SECRET_KEY,
      authHandler: auth.handler, limiter: poolMutationLimiter,
      authAbuseGuard: createAuthAbuseGuard({ secret: env.TURNSTILE_SECRET_KEY, allowInsecureLocalAuth: false, limiter: authLimiter }),
      allowInsecureLocalAuth: false, queue: env.POOL_EVENTS, spaAssets: env.ASSETS, oddsConfigured: Boolean(env.ODDS_API_KEY), backupConfigured: backupConfigured(env),
      async currentUser(sessionRequest) { const session = await auth.api.getSession({ headers: sessionRequest.headers }); return session?.user ? { id: session.user.id, name: session.user.name } : null; },
      async recentlyAuthenticated(sessionRequest, user) { const session = await auth.api.getSession({ headers: sessionRequest.headers }); if (!session?.user || session.user.id !== user.id) return false; const createdAt = new Date(session.session.createdAt).getTime(); return Number.isFinite(createdAt) && Date.now() - createdAt <= 15 * 60 * 1000; }
    });
    return app.fetch(request, env);
  },
  scheduled(_event, env, ctx): void { if (env.ODDS_API_KEY) ctx.waitUntil(runOddsCron(env.DB, new TheOddsApiProvider(env.ODDS_API_KEY))); if (backupConfigured(env) && env.BACKUPS && env.BACKUP_ENCRYPTION_KEY && env.POOL_BACKUP_SERVICE_TOKEN) ctx.waitUntil(runBackupCron({ db: env.DB, pools: env.POOL_DO, bucket: env.BACKUPS, encryptionKey: env.BACKUP_ENCRYPTION_KEY, backupServiceToken: env.POOL_BACKUP_SERVICE_TOKEN })); },
  queue(batch, env, ctx): void { ctx.waitUntil(consumeProjectionQueue(batch, { db: env.DB, pools: env.POOL_DO, projectionServiceToken: env.POOL_PROJECTION_SERVICE_TOKEN })); }
};
export default worker;

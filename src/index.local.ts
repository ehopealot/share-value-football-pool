import { PoolDO } from "./durable/local-pool-do";
import { createAuthBoundary } from "./auth";
import { DevelopmentMailbox } from "./auth/development-mailbox";
import { createWorkerApp } from "./worker/app";
import { installLocalAppControls } from "./worker/local-app";
import { refreshLocalFixtures } from "./worker/test-controls";
import { RateLimiter } from "./security/rate-limit";
import { createAuthAbuseGuard } from "./security/turnstile";
import { internalSettlementCommand } from "./contracts/commands";
import { consumeProjectionQueue } from "./worker/queue";
import { backupConfigured, runBackupCron } from "./worker/backup-cron";
import type { Env } from "./index";

const authLimiter = new RateLimiter(5);
const poolMutationLimiter = new RateLimiter();
const developmentMailbox = new DevelopmentMailbox();
export { PoolDO } from "./durable/local-pool-do";

const localWorker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const settlementPath = new URL(request.url).pathname.match(/^\/internal\/pools\/([^/]+)\/settle$/);
    if (settlementPath) {
      const token = request.headers.get("x-settlement-service-token");
      const command = internalSettlementCommand.safeParse({ poolId: settlementPath[1], serviceToken: token });
      if (request.method !== "POST" || request.headers.has("origin") || !env.SETTLEMENT_SERVICE_TOKEN || !command.success || token !== env.SETTLEMENT_SERVICE_TOKEN) return new Response("Not found", { status: 404 });
      return env.POOL_DO.get(env.POOL_DO.idFromName(command.data.poolId)).fetch("https://pool.internal/internal/settle", { method: "POST", headers: { "x-settlement-service-token": token } });
    }
    if (!env.BETTER_AUTH_SECRET) return Response.json({ code: "AUTH_CONFIGURATION_UNAVAILABLE" }, { status: 503 });
    const auth = createAuthBoundary({ db: env.DB, baseURL: new URL(request.url).origin, secret: env.BETTER_AUTH_SECRET, emailSender: developmentMailbox, autoVerifyEmail: true });
    const app = createWorkerApp({ db: env.DB, pools: env.POOL_DO, commandAuthenticatorKey: env.POOL_COMMAND_AUTHENTICATOR_KEY, turnstileSecret: env.TURNSTILE_SECRET_KEY, authHandler: auth.handler, limiter: poolMutationLimiter, authAbuseGuard: createAuthAbuseGuard({ secret: env.TURNSTILE_SECRET_KEY, allowInsecureLocalAuth: true, limiter: authLimiter }), allowInsecureLocalAuth: true, queue: env.POOL_EVENTS, spaAssets: env.ASSETS, oddsConfigured: true, backupConfigured: backupConfigured(env), beforeOddsRead: () => refreshLocalFixtures(env.DB), async currentUser(sessionRequest) { const host = new URL(sessionRequest.url).hostname; const user = (host === "127.0.0.1" || host === "localhost" || host === "::1") ? sessionRequest.headers.get("x-local-test-user") : null; if (user) return { id: user, name: user }; const session = await auth.api.getSession({ headers: sessionRequest.headers }); return session?.user ? { id: session.user.id, name: session.user.name } : null; }, async recentlyAuthenticated(sessionRequest, user) { const session = await auth.api.getSession({ headers: sessionRequest.headers }); return Boolean(session?.user && session.user.id === user.id && Date.now() - new Date(session.session.createdAt).getTime() <= 15 * 60 * 1000); } });
    const responseBarrier = installLocalAppControls(app, { db: env.DB, pools: env.POOL_DO, localMailbox: async () => ({ messages: developmentMailbox.messages.map(({ kind, to, token }) => ({ kind, to, token })) }), resetLocalAuthLimiter: () => authLimiter.clear(), projectionServiceToken: env.POOL_PROJECTION_SERVICE_TOKEN });
    const response = await app.fetch(request, env);
    return responseBarrier.apply(request, response);
  },
  scheduled(_event, env, ctx) { if (backupConfigured(env) && env.BACKUPS && env.BACKUP_ENCRYPTION_KEY && env.POOL_BACKUP_SERVICE_TOKEN) ctx.waitUntil(runBackupCron({ db: env.DB, pools: env.POOL_DO, bucket: env.BACKUPS, encryptionKey: env.BACKUP_ENCRYPTION_KEY, backupServiceToken: env.POOL_BACKUP_SERVICE_TOKEN })); },
  queue(batch, env, ctx) { ctx.waitUntil(consumeProjectionQueue(batch, { db: env.DB, pools: env.POOL_DO, projectionServiceToken: env.POOL_PROJECTION_SERVICE_TOKEN })); }
};
export default localWorker;

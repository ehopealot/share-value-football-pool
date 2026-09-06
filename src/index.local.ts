import { createAuthBoundary } from "./auth";
import { authenticatedUserFromSession, sessionIsRecentForUser } from "./auth/session";
import { DevelopmentMailbox } from "./auth/development-mailbox";
import { createWorkerApp } from "./worker/app";
import { installLocalAppControls } from "./worker/local-app";
import { refreshLocalFixtures } from "./worker/test-controls";
import { RateLimiter } from "./security/rate-limit";
import { createAuthAbuseGuard, isLoopbackHostname } from "./security/turnstile";
import { consumeProjectionQueue } from "./worker/queue";
import { handleInternalSettlement } from "./worker/internal-settlement";
import { backupConfigured, runBackupCron } from "./worker/backup-cron";
import type { Env } from "./index";

const authLimiter = new RateLimiter(5);
const poolMutationLimiter = new RateLimiter();
const developmentMailbox = new DevelopmentMailbox();
export { PoolDO } from "./durable/local-pool-do";

const localWorker: ExportedHandler<Env> = {
  async fetch(request, env, ctx): Promise<Response> {
    const internalSettlement = await handleInternalSettlement(request, env);
    if (internalSettlement) return internalSettlement;
    if (!env.BETTER_AUTH_SECRET) return Response.json({ code: "AUTH_CONFIGURATION_UNAVAILABLE" }, { status: 503 });
    const auth = createAuthBoundary({ db: env.DB, baseURL: new URL(request.url).origin, secret: env.BETTER_AUTH_SECRET, emailSender: developmentMailbox, autoVerifyEmail: true });
    const app = createWorkerApp({ db: env.DB, pools: env.POOL_DO, commandAuthenticatorKey: env.POOL_COMMAND_AUTHENTICATOR_KEY, turnstileSecret: env.TURNSTILE_SECRET_KEY, authHandler: auth.handler, limiter: poolMutationLimiter, authAbuseGuard: createAuthAbuseGuard({ secret: env.TURNSTILE_SECRET_KEY, allowInsecureLocalAuth: true, limiter: authLimiter }), allowInsecureLocalAuth: true, queue: env.POOL_EVENTS, spaAssets: env.ASSETS, oddsConfigured: true, backupConfigured: backupConfigured(env), beforeOddsRead: () => refreshLocalFixtures(env.DB), async currentUser(sessionRequest) { const host = new URL(sessionRequest.url).hostname; const user = isLoopbackHostname(host) ? sessionRequest.headers.get("x-local-test-user") : null; if (user) return { id: user, name: user }; return authenticatedUserFromSession(await auth.api.getSession({ headers: sessionRequest.headers })); }, async recentlyAuthenticated(sessionRequest, user) { return sessionIsRecentForUser(await auth.api.getSession({ headers: sessionRequest.headers }), user.id); } });
    const responseBarrier = installLocalAppControls(app, { db: env.DB, pools: env.POOL_DO, localMailbox: async () => ({ messages: developmentMailbox.messages.map(({ kind, to, token }) => ({ kind, to, token })) }), resetLocalAuthLimiter: () => authLimiter.clear(), projectionServiceToken: env.POOL_PROJECTION_SERVICE_TOKEN });
    const response = await app.fetch(request, env, ctx);
    return responseBarrier.apply(request, response);
  },
  scheduled(_event, env, ctx) { if (backupConfigured(env)) ctx.waitUntil(runBackupCron({ db: env.DB, pools: env.POOL_DO, bucket: env.BACKUPS, encryptionKey: env.BACKUP_ENCRYPTION_KEY, backupServiceToken: env.POOL_BACKUP_SERVICE_TOKEN })); },
  queue(batch, env, ctx) { ctx.waitUntil(consumeProjectionQueue(batch, { db: env.DB, pools: env.POOL_DO, projectionServiceToken: env.POOL_PROJECTION_SERVICE_TOKEN })); }
};
export default localWorker;

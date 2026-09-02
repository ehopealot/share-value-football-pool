import { applyD1Migrations, env } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import { createAuthBoundary } from "../../src/auth";
import { DevelopmentMailbox } from "../../src/auth/development-mailbox";
import type { EmailSender } from "../../src/auth/email-sender";
import { createWorkerApp } from "../../src/worker/app";
import { RateLimiter } from "../../src/security/rate-limit";
import { createAuthAbuseGuard, verifyTurnstile } from "../../src/security/turnstile";
import { createPoolRequest, joinPoolRequest } from "../../src/contracts/http";
import worker, { handleInternalSettlement, type Env } from "../../src/index";
import { canonicalizeWagerQuote, revalidateWagerOffers } from "../../src/worker/offer-quotes";
import type { PoolCommand } from "../../src/durable/pool-commands";
import { CANONICAL_BOOK_POLICY_VERSION } from "../../src/odds/types";

/**
 * Single home for tests that import the production auth/entry module graph
 * (src/index.ts and src/auth pull in better-auth/drizzle). Every vitest worker
 * test file evaluates its imports in a fresh workerd isolate, so splitting
 * these across files multiplied the suite's dominant module-evaluation cost;
 * keep new tests that import src/index or src/auth here instead of adding a
 * new file. The slim vitest Worker entry declares no queue consumer or cron
 * trigger, so the production queue and scheduled handlers are exercised here.
 */
const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace; POOL_COMMAND_AUTHENTICATOR_KEY: string; SETTLEMENT_SERVICE_TOKEN: string; POOL_PROJECTION_SERVICE_TOKEN: string };
const db = bindings.DB;
let migrated = false;
const ensureMigrations = async () => {
  if (!migrated) { await applyD1Migrations(db, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
};
const request = (path: string, body: unknown, headers: Record<string, string> = {}, method = "POST") => new Request(`https://pool.example.test${path}`, { method, headers: { "content-type": "application/json", origin: "https://pool.example.test", ...headers }, body: JSON.stringify(body) });
const appFor = (user: { id: string; name: string } | null, options: { turnstileSecret?: string; turnstileExpectedHostname?: string; allowInsecureLocalAuth?: boolean; fetcher?: typeof fetch; limiter?: RateLimiter; recentlyAuthenticated?: boolean } = {}) => {
  const { recentlyAuthenticated, ...dependencies } = options;
  return createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => user, recentlyAuthenticated: async () => recentlyAuthenticated === true, ...dependencies });
};

describe("Better Auth D1 boundary", () => {
  beforeEach(async () => {
    await ensureMigrations();
    await db.exec("DELETE FROM verification; DELETE FROM session; DELETE FROM account; DELETE FROM user;");
  });

  it("passes Better Auth's canonical verification URL to email delivery", async () => {
    const messages: Array<{ kind: "verification" | "password-reset"; to: string; token: string; url?: string }> = [];
    const emailSender: EmailSender = { async send(message) { messages.push(message); } };
    const auth = createAuthBoundary({ db, baseURL: "https://officepool.football", secret: "a-long-test-secret-that-is-never-production", emailSender });

    await auth.api.signUpEmail({ body: { name: "Member", email: "member@example.test", password: "first-password" } });

    expect(messages).toHaveLength(1);
    const verification = messages[0]!;
    expect(verification.kind).toBe("verification");
    const url = new URL(verification.url!);
    expect(url.origin).toBe("https://officepool.football");
    expect(url.pathname).toBe("/api/auth/verify-email");
    expect(url.searchParams.get("token")).toBe(verification.token);
  });

  it("auto-verifies local signups without retaining verification mail", async () => {
    const mailbox = new DevelopmentMailbox();
    const auth = createAuthBoundary({ db, baseURL: "http://localhost:5173", secret: "a-long-test-secret-that-is-never-production", emailSender: mailbox, autoVerifyEmail: true });

    const signup = await auth.api.signUpEmail({ body: { name: "Local Member", email: "local-member@example.test", password: "first-password" } });

    expect(mailbox.messages).toEqual([]);
    expect((await db.prepare("SELECT emailVerified FROM user WHERE email = ?").bind("local-member@example.test").first<{ emailVerified: number }>())?.emailVerified).toBe(1);
    const login = await auth.api.signInEmail({ body: { email: "local-member@example.test", password: "first-password" }, asResponse: true });
    expect(login.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
  });

  it("persists signup/login, verification/reset mail, reset, and rotating sessions", async () => {
    const mailbox = new DevelopmentMailbox();
    const auth = createAuthBoundary({ db, baseURL: "https://pool.example.test", secret: "a-long-test-secret-that-is-never-production", emailSender: mailbox });
    const signup = await auth.api.signUpEmail({ body: { name: "Member", email: "member@example.test", password: "first-password" } });
    expect(signup.user.email).toBe("member@example.test");
    expect(mailbox.messages).toContainEqual(expect.objectContaining({ kind: "verification", to: "member@example.test" }));
    const verification = mailbox.messages.find((message) => message.kind === "verification")!;
    await auth.api.verifyEmail({ query: { token: verification.token } });
    const firstLogin = await auth.api.signInEmail({ body: { email: "member@example.test", password: "first-password" }, asResponse: true });
    expect(firstLogin.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect((await db.prepare("SELECT token FROM session WHERE userId = ?").bind(signup.user.id).all<{ token: string }>()).results.length).toBeGreaterThan(0);
    await auth.api.requestPasswordReset({ body: { email: "member@example.test", redirectTo: "https://pool.example.test/reset-password" } });
    const reset = mailbox.messages.find((message) => message.kind === "password-reset")!;
    expect((await db.prepare("SELECT createdAt, updatedAt FROM verification").all<{ createdAt: number | null; updatedAt: number | null }>()).results).toContainEqual(expect.objectContaining({ createdAt: expect.any(Number), updatedAt: expect.any(Number) }));
    await auth.api.resetPassword({ body: { token: reset.token, newPassword: "second-password" } });
    expect((await db.prepare("SELECT token FROM session WHERE userId = ?").bind(signup.user.id).all<{ token: string }>()).results).toEqual([]);
    const secondLogin = await auth.api.signInEmail({ body: { email: "member@example.test", password: "second-password" }, asResponse: true });
    expect(secondLogin.headers.get("set-cookie")).not.toBe(firstLogin.headers.get("set-cookie"));
    expect((await db.prepare("SELECT token FROM session WHERE userId = ?").bind(signup.user.id).all<{ token: string }>()).results).toHaveLength(1);
  });
});

describe("authenticated pool HTTP boundary", () => {
  beforeEach(async () => {
    await ensureMigrations();
    await bindings.DB.exec("DELETE FROM pool_registry_command_response; DELETE FROM pool_registry; INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'owner@example.test', 1, 0, 0), ('member', 'Member', 'member@example.test', 1, 0, 0);");
  });

  it("fails closed before serving production traffic when Resend is not configured", async () => {
    const productionEnv = { ...env, BETTER_AUTH_SECRET: "test-only-auth-secret-that-is-long-enough", RESEND_API_KEY: undefined } as Env;
    const request = new Request("https://attacker.example/health/app") as unknown as Parameters<NonNullable<typeof worker.fetch>>[0];
    const response = await worker.fetch!(request, productionEnv, {} as ExecutionContext);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "AUTH_CONFIGURATION_UNAVAILABLE" });
  });

  it("rejects unauthenticated and cross-origin mutations", async () => {
    const body = { slug: "secure-pool", poolName: "Secure Pool", password: "correct-password", idempotencyKey: "create" };
    expect((await appFor(null).fetch(request("/api/pools", body))).status).toBe(401);
    expect((await appFor({ id: "owner", name: "Owner" }).fetch(request("/api/pools", body, { origin: "https://attacker.test" }))).status).toBe(403);
    const missingOrigin = new Request("https://pool.example.test/api/pools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await appFor({ id: "owner", name: "Owner" }).fetch(missingOrigin)).status).toBe(403);
  });

  it("validates, Turnstile-protects, creates, joins, and routes authoritative mutations", async () => {
    const turnstile = async () => new Response(JSON.stringify({ success: true, action: "submit", hostname: "pool.example.test" }));
    const owner = appFor({ id: "owner", name: "Owner" }, { turnstileSecret: "turnstile-secret", fetcher: turnstile, recentlyAuthenticated: true });
    expect((await owner.fetch(request("/api/pools", { slug: "secure-pool", poolName: "Secure Pool", password: "correct-password", idempotencyKey: "create", turnstileToken: "token" }))).status).toBe(201);
    const staleOwner = appFor({ id: "owner", name: "Owner" }, { turnstileSecret: "turnstile-secret", fetcher: turnstile });
    expect((await staleOwner.fetch(request("/api/p/secure-pool/admin/settings", { password: "rotated-password", idempotencyKey: "settings" }, { "x-recent-auth": "true" }))).status).toBe(403);
    expect((await owner.fetch(request("/api/p/secure-pool/admin/settings", { password: "rotated-password", idempotencyKey: "settings" }))).status).toBe(200);
    const member = appFor({ id: "member", name: "Member" }, { turnstileSecret: "turnstile-secret", fetcher: turnstile });
    expect((await member.fetch(request("/api/p/secure-pool/join", { password: "rotated-password", idempotencyKey: "join", turnstileToken: "token" }))).status).toBe(200);
    expect((await owner.fetch(request("/api/p/secure-pool/admin/seasons", { seasonId: "s1", label: "2026", idempotencyKey: "draft" }))).status).toBe(200);
    expect((await owner.fetch(request("/api/p/secure-pool/admin/seasons/s1/open", { idempotencyKey: "open" }))).status).toBe(200);
    expect((await owner.fetch(request("/api/p/secure-pool/admin/seasons/s1/close", { idempotencyKey: "close", reason: "season closed" }, { "x-recent-auth": "true" }))).status).toBe(404);
  }, 90_000);

  it("fails closed for a missing production Turnstile secret and permits only explicit local opt-in", async () => {
    const body = { slug: "missing-secret", poolName: "Missing Secret", password: "correct-password", idempotencyKey: "create" };
    const production = appFor({ id: "owner", name: "Owner" });
    expect((await production.fetch(request("/api/pools", body))).status).toBe(403);
    expect((await production.fetch(request("/api/p/missing-secret/join", { password: "correct-password", idempotencyKey: "join" }))).status).toBe(403);
    expect(await verifyTurnstile({ allowInsecureLocalAuth: true, hostname: "127.0.0.1" })).toBe(true);
    expect(await verifyTurnstile({ allowInsecureLocalAuth: true, hostname: "pool.example.test" })).toBe(false);
  });

  it("binds completed Turnstile tokens to the expected action and hostname", async () => {
    const input = { secret: "turnstile-secret", token: "token", action: "submit", hostname: "officepool.football" };
    const verify = (result: Record<string, unknown>) => verifyTurnstile({ ...input, fetcher: async () => new Response(JSON.stringify(result)) });

    expect(await verify({ success: true, action: "submit", hostname: "officepool.football" })).toBe(true);
    expect(await verify({ success: true, action: "other", hostname: "officepool.football" })).toBe(false);
    expect(await verify({ success: true, action: "submit", hostname: "attacker.example" })).toBe(false);

    const app = appFor({ id: "owner", name: "Owner" }, {
      turnstileSecret: "turnstile-secret", turnstileExpectedHostname: "officepool.football",
      fetcher: async () => new Response(JSON.stringify({ success: true, action: "submit", hostname: "pool.example.test" }))
    });
    expect((await app.fetch(request("/api/pools", { slug: "hostname-bound-pool", poolName: "Hostname Bound Pool", password: "correct-password", idempotencyKey: "hostname-bound", turnstileToken: "token" }))).status).toBe(403);
  });

  it("fails closed for missing or fabricated Turnstile tokens and applies rate limits", async () => {
    const app = appFor({ id: "owner", name: "Owner" }, { turnstileSecret: "turnstile-secret", fetcher: async (_url, init) => new Response(JSON.stringify({ success: new URLSearchParams(String(init?.body)).get("response") === "valid-response", action: "submit", hostname: "pool.example.test" })), limiter: new RateLimiter(1) });
    const body = { slug: "another-pool", poolName: "Another Pool", password: "correct-password", idempotencyKey: "create" };
    expect((await app.fetch(request("/api/pools", body))).status).toBe(403);
    expect((await app.fetch(request("/api/pools", { ...body, turnstileToken: "local" }))).status).toBe(403);
    expect((await app.fetch(request("/api/pools", { ...body, turnstileToken: "valid-response" }))).status).toBe(201);
    expect((await app.fetch(request("/api/pools", { ...body, slug: "third-pool", idempotencyKey: "second", turnstileToken: "valid-response" }))).status).toBe(429);
  }, 30_000);

  it("executes the shared signup/signin abuse guard before the auth handler", async () => {
    const authHandler = async () => Response.json({ handled: true });
    const secured = createWorkerApp({
      db: bindings.DB, pools: bindings.POOL_DO, currentUser: async () => null, authHandler,
      authAbuseGuard: createAuthAbuseGuard({ secret: "turnstile-secret", limiter: new RateLimiter(), fetcher: async () => new Response(JSON.stringify({ success: true, action: "submit", hostname: "pool.example.test" })) })
    });
    expect((await secured.fetch(request("/api/auth/sign-up/email", { email: "a@example.test" }))).status).toBe(403);
    expect((await secured.fetch(request("/api/auth/sign-in/email", { email: "a@example.test", turnstileToken: "token" }))).status).toBe(200);
    expect((await secured.fetch(request("/api/auth/sign-up/email", { email: "a@example.test", turnstileToken: "token" }, { origin: "https://attacker.test" }))).status).toBe(403);
    const localAuth = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, currentUser: async () => null, authHandler, authAbuseGuard: createAuthAbuseGuard({ allowInsecureLocalAuth: true, limiter: new RateLimiter() }) });
    const loopbackSignup = new Request("http://127.0.0.1/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1" }, body: JSON.stringify({ email: "a@example.test" }) });
    expect((await localAuth.fetch(loopbackSignup)).status).toBe(200);
    const limitedAuth = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, currentUser: async () => null, authHandler, authAbuseGuard: createAuthAbuseGuard({ allowInsecureLocalAuth: true, limiter: new RateLimiter(1) }) });
    const loopbackSignin = () => new Request("http://localhost/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({}) });
    expect((await limitedAuth.fetch(loopbackSignin())).status).toBe(200);
    expect((await limitedAuth.fetch(loopbackSignin())).status).toBe(429);
  });

  it("denies browser settlement and gates the real PoolDO alarm behind its service token", async () => {
    const slug = `settlement-${crypto.randomUUID()}`;
    const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug));
    const direct = (token?: string) => stub.fetch("https://pool.example.test/internal/settle", { method: "POST", headers: token ? { "x-settlement-service-token": token } : {} });
    expect((await direct()).status).toBe(404);
    expect((await direct("wrong")).status).toBe(404);
    expect((await direct(bindings.SETTLEMENT_SERVICE_TOKEN)).status).toBe(200);
    const invoke = (headers: HeadersInit = {}) => handleInternalSettlement(new Request(`https://pool.example.test/internal/pools/${slug}/settle`, { method: "POST", headers }), { POOL_DO: bindings.POOL_DO, SETTLEMENT_SERVICE_TOKEN: bindings.SETTLEMENT_SERVICE_TOKEN });
    expect((await invoke({ "x-settlement-service-token": bindings.SETTLEMENT_SERVICE_TOKEN, origin: "https://pool.example.test" }))?.status).toBe(404);
    expect((await invoke({ "x-settlement-service-token": bindings.SETTLEMENT_SERVICE_TOKEN }))?.status).toBe(200);
  });

  it("revalidates moneyline placement terms against the canonical D1 offer with vig-free ticket pricing", async () => {
    const startsAt = "2099-09-10T20:00:00.000Z";
    const retrievedAt = new Date().toISOString();
    await bindings.DB.exec("DELETE FROM market_offer; DELETE FROM sports_event; DELETE FROM odds_ingestion;");
    await bindings.DB.prepare("INSERT INTO odds_ingestion (provider, last_polled_at, last_success_at, last_error) VALUES ('odds', ?, ?, NULL)").bind(retrievedAt, retrievedAt).run();
    await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES (?, ?, 'nfl', 'Fixture Home', 'Fixture Away', ?, 'scheduled', '1')").bind("trusted-event", "trusted-event", startsAt).run();
    await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES (?, 'moneyline', 'DraftKings', ?, 'trusted-v1', ?)").bind("trusted-event", retrievedAt, JSON.stringify({ policyVersion: CANONICAL_BOOK_POLICY_VERSION, outcomes: [{ name: "Fixture Home", price: -135 }, { name: "Fixture Away", price: 115 }] })).run();
    // Ticket economics use the vig-free line: implied probabilities normalized by the overround.
    const command: any = { type: "PlaceStraightWager", commandId: "moneyline", actorId: "member", wagerId: "moneyline", seasonId: "s1", riskMicros: "1000000", acceptedOdds: -124, rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: "trusted-event", league: "nfl", canonicalBook: "DraftKings", retrievedAt, policyVersion: CANONICAL_BOOK_POLICY_VERSION, offerVersion: "trusted-v1", canonicalOfferProof: { offerId: "trusted-event:moneyline:home", eventId: "trusted-event", offerVersion: "trusted-v1", canonicalBook: "DraftKings", market: "moneyline", selection: "home", odds: -135, line: null }, market: "moneyline", selection: "home", originalLine: null, adjustedLine: null, originalOdds: -124, eventStartsAt: startsAt, homeTeam: "Fixture Home", awayTeam: "Fixture Away" } };
    await expect(revalidateWagerOffers(bindings.DB, command)).resolves.toEqual(command);
    // The book price itself is no longer a valid strike: the ticket must use the vig-free line.
    const bookPriced = { ...command, acceptedOdds: -135, leg: { ...command.leg, originalOdds: -135 } };
    await expect(revalidateWagerOffers(bindings.DB, bookPriced)).rejects.toThrow("LINE_CHANGED");
    const quoted = await canonicalizeWagerQuote(bindings.DB, { ...command, acceptedOdds: 100 } as any);
    expect(quoted.acceptedOdds).toBe(-124);
    expect((quoted as Extract<typeof quoted, { type: "PlaceStraightWager" }>).leg.originalOdds).toBe(-124);
    expect((quoted as Extract<typeof quoted, { type: "PlaceStraightWager" }>).leg.canonicalOfferProof.odds).toBe(-135);
    const forged = { ...command, leg: { ...command.leg, canonicalBook: "FanDuel", offerVersion: "forged-v9", originalOdds: 200, canonicalOfferProof: { ...command.leg.canonicalOfferProof, canonicalBook: "FanDuel", offerVersion: "forged-v9", odds: 200 } } };
    await expect(revalidateWagerOffers(bindings.DB, forged)).rejects.toThrow("LINE_CHANGED");

    const duplicateTeaser = {
      ...command,
      type: "PlaceTeaserWager",
      teaserPoints: 6,
      acceptedOdds: -110,
      legs: [command.leg, { ...command.leg }]
    } as any;
    await expect(canonicalizeWagerQuote(bindings.DB, duplicateTeaser)).rejects.toThrow("MARKET_UNAVAILABLE");
    await expect(revalidateWagerOffers(bindings.DB, duplicateTeaser)).rejects.toThrow("MARKET_UNAVAILABLE");
  });

  it("uses shared contracts and treats both unavailable pool states as retryable", async () => {
    expect(createPoolRequest.safeParse({ slug: "pool", poolName: "Pool", password: "correct-password", idempotencyKey: "id" }).success).toBe(true);
    expect(joinPoolRequest.safeParse({ password: "correct-password", idempotencyKey: "id" }).success).toBe(true);
    const app = appFor({ id: "owner", name: "Owner" }, { allowInsecureLocalAuth: true });
    const response = await app.fetch(new Request("http://127.0.0.1/api/p/no-such-pool/join", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1" }, body: JSON.stringify({ password: "correct-password", idempotencyKey: "join" }) }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "POOL_NOT_AVAILABLE" });

    await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind("unavailable-id", "unavailable", "unavailable-id", "owner", "ready", "unavailable-command", "now").run();
    const unavailablePools = {
      idFromName: () => "ignored",
      get: () => ({ fetch: async () => { throw new Error("offline"); } })
    } as unknown as DurableObjectNamespace;
    const unavailableApp = createWorkerApp({ db: bindings.DB, pools: unavailablePools, currentUser: async () => ({ id: "owner", name: "Owner" }), allowInsecureLocalAuth: true });
    const unavailable = await unavailableApp.fetch(new Request("http://localhost/api/p/unavailable/join", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ password: "correct-password", idempotencyKey: "offline" }) }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ code: "POOL_UNAVAILABLE" });
  });
});

describe("production entrypoint composition", () => {
  beforeEach(async () => {
    await ensureMigrations();
    await bindings.DB.exec("DELETE FROM projection_delivery; DELETE FROM projection_state; DELETE FROM membership_projection; DELETE FROM season_projection;");
  });

  it("drains a delivered outbox message through the queue handler into D1 projections", async () => {
    const poolId = `composition-${crypto.randomUUID()}`;
    const initialize = await bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)).fetch("https://pool.test/command", { method: "POST", body: JSON.stringify({ type: "InitializePool", commandId: "init", poolId, slug: poolId, creatorId: "owner", creatorName: "Owner", poolName: "Composition Pool", password: "correct-password" }) });
    expect(initialize.status).toBe(200);

    let acked = false;
    let retried = false;
    const batch = {
      messages: [{
        id: "composition-message", timestamp: Date.now(), attempts: 1,
        body: { eventId: "event-1", version: "1", eventType: "CommandApplied", payload: { poolId, actorId: "owner", commandId: "init", commandType: "InitializePool", memberId: "owner" } },
        ack: () => { acked = true; }, retry: () => { retried = true; }
      }]
    } as unknown as Parameters<NonNullable<typeof worker.queue>>[0];
    const background: Promise<unknown>[] = [];
    const context = { waitUntil: (promise: Promise<unknown>) => { background.push(promise); } } as unknown as ExecutionContext;
    worker.queue!(batch, env as unknown as Env, context);
    await Promise.all(background);

    expect(acked).toBe(true);
    expect(retried).toBe(false);
    expect(await bindings.DB.prepare("SELECT event_id, projection_version, delivered_at, last_error FROM projection_delivery WHERE event_id = 'event-1'").first()).toMatchObject({ event_id: "event-1", projection_version: "1", delivered_at: expect.any(String), last_error: null });
    expect(await bindings.DB.prepare("SELECT user_id, pool_name, role, status, projection_version FROM membership_projection WHERE pool_id = ?").bind(poolId).first()).toEqual({ user_id: "owner", pool_name: "Composition Pool", role: "commissioner", status: "active", projection_version: "1" });
  }, 30_000);

  it("runs the scheduled handler as a no-op without odds or backup configuration", async () => {
    const background: Promise<unknown>[] = [];
    const context = { waitUntil: (promise: Promise<unknown>) => { background.push(promise); } } as unknown as ExecutionContext;
    worker.scheduled!({} as ScheduledEvent, env as unknown as Env, context);
    await Promise.all(background);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS count FROM projection_delivery").first<{ count: number }>()).toMatchObject({ count: 0 });
  }, 30_000);
});

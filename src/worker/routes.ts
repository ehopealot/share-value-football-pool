import type { Context, Hono } from "hono";
import { z } from "zod";
import { PoolRegistry } from "../services/pool-registry";
import { DurablePoolCommandClient } from "../services/pool-command-client";
import { freeSeasonEntitlement, type SeasonEntitlementService } from "../services/season-entitlement";
import { PoolCommandError, PoolCommandRouter } from "./do-router";
import { createPoolSchema, createSeasonSchema, joinPoolSchema, seasonIdSchema, updateSettingsSchema } from "./schemas";
import { executeShareOrderRequest, shareOrderQuoteRequest, reverseShareOrderRequest, transferCommissionerRequest, memberStatusRequest, voidWagerRequest, regradeWagerRequest, seasonAnnotationRequest, updateMemberNicknameRequest, messageBoardReadRequest, messageBoardMutationRequest } from "../contracts/http";
import { auditExportResponse, OddsBoardResponse, ReadPoolView, ReadStandings, ReadActivity, ReadSeasonHistory, ReadMessageBoardResponse, MessageBoardMutationResponse, straightWagerQuoteRequest, teaserWagerQuoteRequest, straightWagerPlacementRequest, teaserWagerPlacementRequest, straightWagerQuoteSnapshot, teaserWagerQuoteSnapshot } from "../contracts/http";
import { LineChangedError, QuoteLineChangedError, canonicalizeWagerQuote, decodeStoredOffer, quoteRequestMatchesCanonical, revalidateWagerOffers } from "./offer-quotes";
import { RateLimiter } from "../security/rate-limit";
import { verifyTurnstile } from "../security/turnstile";
import { offerIsStale } from "../odds/ingestion";
import type { PoolJoinNotifier } from "../auth/email-sender";

export type AuthenticatedUser = { id: string; name: string };
export type RouteDependencies = {
  db: D1Database; pools: DurableObjectNamespace; commandAuthenticatorKey?: string; turnstileSecret?: string;
  /** Fixed in production; local callers derive the request hostname. */
  turnstileExpectedHostname?: string;
  /** Deliberate local-development opt-in; production omits this and fails closed. */
  allowInsecureLocalAuth?: boolean;
  currentUser(request: Request): Promise<AuthenticatedUser | null>;
  recentlyAuthenticated?(request: Request, user: AuthenticatedUser): Promise<boolean>;
  entitlement?: SeasonEntitlementService; limiter?: RateLimiter; fetcher?: typeof fetch; poolJoinNotifier?: PoolJoinNotifier;
  /** Local composition can renew its deterministic board before an authenticated odds read. */
  beforeOddsRead?: () => Promise<void>;
};
const jsonError = (c: Context, code: string, status: 400 | 401 | 403 | 429 | 503 = 400) => c.json({ code }, status);
const clientIp = (c: Context) => c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown";
const csrf = (c: Context) => {
  const origin = c.req.header("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return origin === parsed.origin && parsed.origin === new URL(c.req.url).origin;
  } catch { return false; }
};
const quoteRequestFingerprint = (ticket: Record<string, unknown>) => JSON.stringify(ticket);

/** Installs only early authenticated pool mutations; reads, wagers, exports, and settlement stay deferred. */
export function installPoolRoutes(app: Hono, dependencies: RouteDependencies): void {
  const registry = new PoolRegistry(dependencies.db, new DurablePoolCommandClient(dependencies.pools), dependencies.commandAuthenticatorKey);
  const router = new PoolCommandRouter(registry, dependencies.pools, dependencies.db);
  const limiter = dependencies.limiter ?? new RateLimiter();
  const requireUser = async (c: Context) => {
    if (!csrf(c)) return undefined;
    return dependencies.currentUser(c.req.raw);
  };
  const mutation = async (c: Context, action: (user: AuthenticatedUser) => Promise<Response>) => {
    const user = await requireUser(c);
    if (user === undefined) return jsonError(c, "CSRF_REJECTED", 403);
    if (!user) return jsonError(c, "UNAUTHENTICATED", 401);
    try { return await action(user); } catch (error) {
      // A malformed post-commit authority response leaves the browser with an unknown outcome.
      if (error instanceof z.ZodError) return jsonError(c, "POOL_UNAVAILABLE", 503);
      const code = error instanceof Error ? error.message : "COMMAND_FAILED";
      const unavailable = code === "POOL_UNAVAILABLE" || code === "POOL_NOT_AVAILABLE";
      if (error instanceof QuoteLineChangedError) return c.json({ code: "LINE_CHANGED", reconfirmationRequired: true }, 400);
      if (error instanceof LineChangedError) return c.json({ code: "LINE_CHANGED", replacement: error.replacement, reconfirmationRequired: true }, 400);
      if (error instanceof PoolCommandError) return c.json({ ...error.details, code, ...(code === "ORDER_QUOTE_STALE" ? { reconfirmationRequired: true } : {}) }, unavailable ? 503 : code === "FORBIDDEN" || code === "SUSPENDED" ? 403 : 400);
      if (code === "FORBIDDEN" || code === "SUSPENDED") return jsonError(c, code, 403);
      return jsonError(c, code, unavailable ? 503 : 400);
    }
  };

  const memberRead = async (c: Context, action: (user: AuthenticatedUser) => Promise<Response>) => {
    const user = await dependencies.currentUser(c.req.raw);
    if (!user) return jsonError(c, "UNAUTHENTICATED", 401);
    try { return await action(user); } catch (error) {
      const code = error instanceof Error ? error.message : "COMMAND_FAILED";
      if (code === "FORBIDDEN" || code === "SUSPENDED") return jsonError(c, code, 403);
      return jsonError(c, code, code === "POOL_UNAVAILABLE" || code === "POOL_NOT_AVAILABLE" ? 503 : 400);
    }
  };

  /** Projected directory data is discovery-only; direct pool access always rechecks the PoolDO. */
  app.get("/api/pools", async (c) => {
    const user = await dependencies.currentUser(c.req.raw);
    if (!user) return jsonError(c, "UNAUTHENTICATED", 401);
    const result = await dependencies.db.prepare("SELECT m.pool_id AS poolId, r.normalized_slug AS slug, m.pool_name AS poolName, m.role, m.status, m.projection_version AS projectionVersion FROM membership_projection m JOIN pool_registry r ON r.pool_id = m.pool_id WHERE m.user_id = ? AND m.status = 'active' ORDER BY m.pool_name COLLATE NOCASE").bind(user.id).all<{ poolId: string; slug: string; poolName: string; role: string; status: string; projectionVersion: string }>();
    return c.json({ memberships: result.results });
  });
  app.get("/api/p/:slug/gate", async (c) => {
    const user = await dependencies.currentUser(c.req.raw);
    if (!user) return jsonError(c, "UNAUTHENTICATED", 401);
    try { return c.json(await router.send(c.req.param("slug"), { type: "ReadPoolGate", commandId: crypto.randomUUID(), actorId: user.id })); }
    catch (error) {
      const code = error instanceof Error ? error.message : "COMMAND_FAILED";
      if (code === "SUSPENDED") return jsonError(c, code, 403);
      return jsonError(c, code, code === "POOL_UNAVAILABLE" || code === "POOL_NOT_AVAILABLE" ? 503 : 400);
    }
  });

  const read = (type: "ReadPoolView" | "ReadStandings" | "ReadActivity" | "ReadWagers" | "ReadMyWagers" | "ReadSeasonHistory") => (c: Context) => memberRead(c, async (user) => {
    const slug = c.req.param("slug");
    if (!slug) return jsonError(c, "INVALID_REQUEST");
    if (type === "ReadSeasonHistory") {
      const seasonId = c.req.param("seasonId");
      if (!seasonId) return jsonError(c, "INVALID_REQUEST");
      return c.json(ReadSeasonHistory.parse(await router.send(slug, { type, commandId: crypto.randomUUID(), actorId: user.id, seasonId })));
    }
    const result = await router.send(slug, { type, commandId: crypto.randomUUID(), actorId: user.id });
    const schema = type === "ReadPoolView" ? ReadPoolView : type === "ReadStandings" ? ReadStandings : type === "ReadActivity" ? ReadActivity : undefined;
    return c.json(schema ? schema.parse(result) : result);
  });
  app.get("/api/p/:slug/view", read("ReadPoolView"));
  app.get("/api/p/:slug/standings", read("ReadStandings"));
  app.get("/api/p/:slug/activity", read("ReadActivity"));
  app.get("/api/p/:slug/wagers", read("ReadMyWagers"));
  app.get("/api/p/:slug/history/:seasonId", read("ReadSeasonHistory"));
  app.get("/api/p/:slug/export", (c) => memberRead(c, async (user) => c.json(auditExportResponse.parse(await router.send(c.req.param("slug"), { type: "ReadAuditExport", commandId: crypto.randomUUID(), actorId: user.id })))));
  // Reading the board advances a durable per-member watermark, so it shares the CSRF-protected mutation boundary.
  app.post("/api/p/:slug/board/read", (c) => mutation(c, async (user) => {
    const parsed = messageBoardReadRequest.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    const slug = c.req.param("slug");
    if (!slug) return jsonError(c, "INVALID_REQUEST");
    return c.json(ReadMessageBoardResponse.parse(await router.send(slug, { type: "ReadMessageBoard", commandId: crypto.randomUUID(), actorId: user.id })));
  }));
  app.post("/api/p/:slug/board/posts", (c) => mutation(c, async (user) => {
    const parsed = messageBoardMutationRequest.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    const slug = c.req.param("slug");
    if (!slug) return jsonError(c, "INVALID_REQUEST");
    return c.json(MessageBoardMutationResponse.parse(await router.send(slug, { type: "CreateMessageBoardPost", commandId: parsed.data.idempotencyKey, actorId: user.id, text: parsed.data.text })));
  }));
  app.post("/api/p/:slug/board/posts/:postId/replies", (c) => mutation(c, async (user) => {
    const parsed = messageBoardMutationRequest.safeParse(await c.req.json());
    const slug = c.req.param("slug"); const postId = c.req.param("postId");
    if (!parsed.success || !slug || !postId) return jsonError(c, "INVALID_REQUEST");
    return c.json(MessageBoardMutationResponse.parse(await router.send(slug, { type: "ReplyToMessageBoardPost", commandId: parsed.data.idempotencyKey, actorId: user.id, postId, text: parsed.data.text })));
  }));

  /** D1 supplies only canonical public offers; the prior PoolDO member read above is the access boundary. */
  app.get("/api/p/:slug/odds", (c) => memberRead(c, async (user) => {
    const slug = c.req.param("slug");
    if (!slug) return jsonError(c, "INVALID_REQUEST");
    ReadPoolView.parse(await router.send(slug, { type: "ReadPoolView", commandId: crypto.randomUUID(), actorId: user.id }));
    await dependencies.beforeOddsRead?.();
    const league = c.req.query("league"); const market = c.req.query("market"); const date = c.req.query("date");
    const clauses = ["e.status = 'scheduled'", "e.starts_at > ?"]; const values: string[] = [new Date().toISOString()];
    if (league === "nfl" || league === "ncaaf") { clauses.push("e.league = ?"); values.push(league); }
    if (market === "spread" || market === "total" || market === "moneyline") { clauses.push("o.market = ?"); values.push(market); }
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) { clauses.push("substr(e.starts_at, 1, 10) = ?"); values.push(date); }
    const [offersResult, ingestionResult] = await dependencies.db.batch([
      dependencies.db.prepare(`SELECT e.id, e.league, e.home_team, e.away_team, e.starts_at, o.market, o.canonical_book, o.retrieved_at, o.offer_version, o.payload_json FROM sports_event e JOIN market_offer o ON o.event_id = e.id WHERE ${clauses.join(" AND ")} ORDER BY e.starts_at, e.id, o.market`).bind(...values),
      dependencies.db.prepare("SELECT last_polled_at, last_success_at, last_error FROM odds_ingestion WHERE provider = 'odds' LIMIT 1")
    ]);
    type BoardOfferRow = { id: string; league: string; home_team: string; away_team: string; starts_at: string; market: string; canonical_book: string; retrieved_at: string; offer_version: string; payload_json: string };
    const offers = offersResult.results as BoardOfferRow[];
    const ingestion = ingestionResult.results.length === 1 ? ingestionResult.results[0] as { last_polled_at: string | null; last_success_at: string | null; last_error: string | null } : undefined;
    const now = new Date();
    const decoded = offers.map((offer) => {
      try { return { offer, payload: decodeStoredOffer(offer.payload_json, { market: offer.market as "spread" | "total" | "moneyline", canonicalBook: offer.canonical_book, homeTeam: offer.home_team, awayTeam: offer.away_team }) }; }
      catch { return null; }
    });
    const allValid = decoded.every((item) => item !== null);
    const allFresh = offers.every((offer) => !offerIsStale(offer.retrieved_at, { commenceTime: offer.starts_at, status: "scheduled" }, now));
    const successCoversOffers = ingestion?.last_success_at !== null && ingestion?.last_success_at !== undefined
      && offers.every((offer) => new Date(ingestion.last_success_at!).getTime() >= new Date(offer.retrieved_at).getTime());
    const boardIsCurrent = offers.length > 0 && !ingestion?.last_error && allValid && allFresh && successCoversOffers;
    const rows = boardIsCurrent ? decoded.map((item) => {
      const { offer, payload } = item!;
      return { eventId: offer.id, league: offer.league, homeTeam: offer.home_team, awayTeam: offer.away_team, startsAt: offer.starts_at, market: offer.market, canonicalBook: offer.canonical_book, retrievedAt: offer.retrieved_at, offerVersion: offer.offer_version, policyVersion: payload.policyVersion, outcomes: payload.outcomes };
    }) : [];
    // A latest failure remains truthful even when older offer bytes are retained; no failed-closed state exposes reviewable offers.
    const status = ingestion?.last_error ? "provider-error" : boardIsCurrent ? "current" : offers.length > 0 && allValid && !allFresh ? "stale" : "no-offer";
    const message = status === "current" ? "Odds are up to date." : status === "stale" ? "Current odds are stale; new bets are disabled." : status === "provider-error" ? "Odds provider error; accepted bets remain intact." : "No current odds are available.";
    return c.json(OddsBoardResponse.parse({ offers: rows, feed: { status, message, lastPolledAt: ingestion?.last_polled_at ?? null, lastSuccessAt: ingestion?.last_success_at ?? null } }));
  }));

  const wager = (kind: "straight" | "teasers", quote: boolean) => (c: Context) => mutation(c, async (user) => {
    const parsed = (quote ? (kind === "straight" ? straightWagerQuoteRequest : teaserWagerQuoteRequest) : (kind === "straight" ? straightWagerPlacementRequest : teaserWagerPlacementRequest)).safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    const slug = c.req.param("slug"); if (!slug) return jsonError(c, "INVALID_REQUEST");
    ReadPoolView.parse(await router.send(slug, { type: "ReadPoolView", commandId: crypto.randomUUID(), actorId: user.id }));
    if (!quote) {
      const data = parsed.data as any;
      // mutationKey is an HTTP idempotency assertion, not a PoolDO command field.
      const command = kind === "straight"
        ? { type: "PlaceStraightWager" as const, commandId: data.commandId, actorId: user.id, wagerId: data.wagerId, quoteKey: data.quoteKey, quotedCommandVersion: data.quotedCommandVersion, seasonId: data.seasonId, riskMicros: data.riskMicros, acceptedOdds: data.acceptedOdds, rulesetVersion: data.rulesetVersion, leg: data.leg }
        : { type: "PlaceTeaserWager" as const, commandId: data.commandId, actorId: user.id, wagerId: data.wagerId, quoteKey: data.quoteKey, quotedCommandVersion: data.quotedCommandVersion, seasonId: data.seasonId, riskMicros: data.riskMicros, acceptedOdds: data.acceptedOdds, teaserPoints: data.teaserPoints, rulesetVersion: data.rulesetVersion, legs: data.legs };
      // Exact mutation replay is deliberately before D1 freshness/revalidation.
      const replay = await router.send(slug, { type: "ProbePlacementReplay", commandId: crypto.randomUUID(), actorId: user.id, placement: command });
      if (replay.replayed === true) return c.json(replay.response);
      await revalidateWagerOffers(dependencies.db, command as any);
      return c.json(await router.send(slug, command));
    }
    const data = parsed.data as any;
    // The fingerprint is only semantic quote input plus identity; no accepted terms
    // or envelope fields can influence quote authority.
    const fingerprint = kind === "straight"
      ? quoteRequestFingerprint({ wagerId: data.wagerId, seasonId: data.seasonId, riskMicros: data.riskMicros, rulesetVersion: data.rulesetVersion, leg: data.leg, actorId: user.id })
      : quoteRequestFingerprint({ wagerId: data.wagerId, seasonId: data.seasonId, riskMicros: data.riskMicros, teaserPoints: data.teaserPoints, rulesetVersion: data.rulesetVersion, legs: data.legs, actorId: user.id });
    try { return c.json(await router.send(slug, { type: "ReplayWagerQuote", commandId: data.quoteKey, actorId: user.id, identity: { actorId: user.id, quoteKey: data.quoteKey, fingerprint } })); }
    catch (error) { if (!(error instanceof Error) || error.message !== "QUOTE_NOT_FOUND") throw error; }
    // D1 contributes canonical public offers only after exact durable replay missed.
    const seed: any = kind === "straight" ? { type: "PlaceStraightWager", commandId: "quote-seed", actorId: user.id, wagerId: data.wagerId, quoteKey: data.quoteKey, quotedCommandVersion: "0", seasonId: data.seasonId, riskMicros: data.riskMicros, acceptedOdds: 100, rulesetVersion: data.rulesetVersion, leg: data.leg } : { type: "PlaceTeaserWager", commandId: "quote-seed", actorId: user.id, wagerId: data.wagerId, quoteKey: data.quoteKey, quotedCommandVersion: "0", seasonId: data.seasonId, riskMicros: data.riskMicros, acceptedOdds: 100, teaserPoints: data.teaserPoints, rulesetVersion: data.rulesetVersion, legs: data.legs };
    const canonical: any = await canonicalizeWagerQuote(dependencies.db, seed);
    // A quote request is a semantic identity assertion. Never bind current D1 terms
    // to an older browser fingerprint/key when the board turned over mid-quote.
    if (!quoteRequestMatchesCanonical(data, canonical)) throw new QuoteLineChangedError();
    const view = ReadPoolView.parse(await router.send(slug, { type: "ReadPoolView", commandId: crypto.randomUUID(), actorId: user.id }));
    const snapshot: any = kind === "straight"
      ? { quoteKey: data.quoteKey, seasonId: canonical.seasonId, ownerMemberId: user.id, riskMicros: canonical.riskMicros, acceptedOdds: canonical.acceptedOdds, rulesetVersion: canonical.rulesetVersion, leg: canonical.leg, commandVersion: view.commandVersion }
      : { quoteKey: data.quoteKey, seasonId: canonical.seasonId, ownerMemberId: user.id, riskMicros: canonical.riskMicros, acceptedOdds: canonical.acceptedOdds, teaserPoints: canonical.teaserPoints, rulesetVersion: canonical.rulesetVersion, legs: canonical.legs, commandVersion: view.commandVersion };
    const projectionParsed: any = (kind === "straight" ? straightWagerQuoteSnapshot : teaserWagerQuoteSnapshot).parse(snapshot);
    const projection: any = kind === "straight"
      ? { quoteKey: projectionParsed.quoteKey, seasonId: projectionParsed.seasonId, ownerMemberId: projectionParsed.ownerMemberId, riskMicros: projectionParsed.riskMicros, acceptedOdds: projectionParsed.acceptedOdds, rulesetVersion: projectionParsed.rulesetVersion, leg: projectionParsed.leg, commandVersion: projectionParsed.commandVersion, wagerId: data.wagerId, actorId: user.id, fingerprint }
      : { quoteKey: projectionParsed.quoteKey, seasonId: projectionParsed.seasonId, ownerMemberId: projectionParsed.ownerMemberId, riskMicros: projectionParsed.riskMicros, acceptedOdds: projectionParsed.acceptedOdds, teaserPoints: projectionParsed.teaserPoints, rulesetVersion: projectionParsed.rulesetVersion, legs: projectionParsed.legs, commandVersion: projectionParsed.commandVersion, wagerId: data.wagerId, actorId: user.id, fingerprint };
    return c.json(await router.send(slug, { type: kind === "straight" ? "QuoteStraightWager" : "QuoteTeaserWager", commandId: data.quoteKey, actorId: user.id, projection, identity: { actorId: user.id, quoteKey: data.quoteKey, fingerprint } } as any));
  });
  app.post("/api/p/:slug/wagers/straight/quote", wager("straight", true));
  app.post("/api/p/:slug/wagers/straight/place", wager("straight", false));
  app.post("/api/p/:slug/wagers/teasers/quote", wager("teasers", true));
  app.post("/api/p/:slug/wagers/teasers/place", wager("teasers", false));

  app.post("/api/pools",  (c) => mutation(c, async (user) => {
    const parsed = createPoolSchema.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    if (!(await verifyTurnstile({ secret: dependencies.turnstileSecret, token: parsed.data.turnstileToken, action: "submit", remoteIp: clientIp(c), hostname: dependencies.turnstileExpectedHostname ?? new URL(c.req.url).hostname, fetcher: dependencies.fetcher, allowInsecureLocalAuth: dependencies.allowInsecureLocalAuth }))) return jsonError(c, "TURNSTILE_REJECTED", 403);
    if (!limiter.allow(`create:${user.id}:${clientIp(c)}`)) return jsonError(c, "RATE_LIMITED", 429);
    if (!(await (dependencies.entitlement ?? freeSeasonEntitlement).mayCreatePool(user.id)).allowed) return jsonError(c, "POOL_CREATION_NOT_ENTITLED", 403);
    const record = await registry.create({ slug: parsed.data.slug, creatorId: user.id, creatorName: parsed.data.creatorName ?? user.name, poolName: parsed.data.poolName, password: parsed.data.password, idempotencyKey: parsed.data.idempotencyKey });
    return c.json(record, record.status === "failed" ? 503 : 201);
  }));

  app.post("/api/p/:slug/join", (c) => mutation(c, async (user) => {
    const parsed = joinPoolSchema.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    const key = `join:${c.req.param("slug")}:${user.id}:${clientIp(c)}`;
    if (!limiter.allow(key)) return jsonError(c, "RATE_LIMITED", 429);
    if (!(await verifyTurnstile({ secret: dependencies.turnstileSecret, token: parsed.data.turnstileToken, action: "submit", remoteIp: clientIp(c), hostname: dependencies.turnstileExpectedHostname ?? new URL(c.req.url).hostname, fetcher: dependencies.fetcher, allowInsecureLocalAuth: dependencies.allowInsecureLocalAuth }))) return jsonError(c, "TURNSTILE_REJECTED", 403);
    const slug = c.req.param("slug");
    const result = await router.send(slug, { type: "JoinPool", commandId: parsed.data.idempotencyKey, actorId: user.id, displayName: parsed.data.displayName ?? user.name, password: parsed.data.password });
    if (result.joined === true && result.replayed !== true && dependencies.poolJoinNotifier) {
      const view = ReadPoolView.parse(await router.send(slug, { type: "ReadPoolView", commandId: crypto.randomUUID(), actorId: user.id }));
      const commissioner = await dependencies.db.prepare("SELECT email FROM user WHERE id = ?").bind(view.pool.commissionerId).first<{ email: string }>();
      if (commissioner?.email) { try { await dependencies.poolJoinNotifier.notifyPoolJoin({ to: commissioner.email, poolName: view.pool.name, memberName: parsed.data.displayName ?? user.name }); } catch {} }
    }
    limiter.reset(key);
    return c.json(result);
  }));

  app.post("/api/p/:slug/nickname", (c) => mutation(c, async (user) => {
    const parsed = updateMemberNicknameRequest.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    return c.json(await router.send(c.req.param("slug"), { type: "UpdateMemberNickname", commandId: parsed.data.idempotencyKey, actorId: user.id, displayName: parsed.data.displayName }));
  }));

  app.post("/api/p/:slug/admin/settings", (c) => mutation(c, async (user) => {
    const parsed = updateSettingsSchema.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    if (parsed.data.password !== undefined && !(await dependencies.recentlyAuthenticated?.(c.req.raw, user))) return jsonError(c, "RECENT_AUTH_REQUIRED", 403);
    return c.json(await router.send(c.req.param("slug"), { type: "UpdatePoolSettings", commandId: parsed.data.idempotencyKey, actorId: user.id, ...(parsed.data.poolName === undefined ? {} : { poolName: parsed.data.poolName }), ...(parsed.data.password === undefined ? {} : { password: parsed.data.password }), ...(parsed.data.signupsOpen === undefined ? {} : { signupsOpen: parsed.data.signupsOpen }), ...(parsed.data.maxSideBet === undefined ? {} : { maxSideBetMicros: (BigInt(parsed.data.maxSideBet) * 1000000n).toString() }) }));
  }));

  app.post("/api/p/:slug/admin/orders/quote", (c) => mutation(c, async (user) => {
    const parsed = shareOrderQuoteRequest.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    return c.json(await router.send(c.req.param("slug"), { type: "QuoteShareOrder", commandId: parsed.data.idempotencyKey, actorId: user.id, seasonId: parsed.data.seasonId, memberId: parsed.data.memberId, mode: parsed.data.mode, amountMicros: parsed.data.amountMicros }));
  }));
  app.post("/api/p/:slug/admin/orders/execute", (c) => mutation(c, async (user) => {
    const parsed = executeShareOrderRequest.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    const slug = c.req.param("slug");
    const result = await router.send(slug, { type: "ExecuteShareOrder", commandId: parsed.data.idempotencyKey, actorId: user.id, seasonId: parsed.data.seasonId, memberId: parsed.data.memberId, mode: parsed.data.mode, amountMicros: parsed.data.amountMicros, quote: parsed.data.quote, reason: parsed.data.reason });
    if (result.replayed !== true && dependencies.poolJoinNotifier && typeof result.sharesMicros === "string" && typeof result.valueMicros === "string") {
      try {
        const view = ReadPoolView.parse(await router.send(slug, { type: "ReadPoolView", commandId: crypto.randomUUID(), actorId: user.id }));
        const recipient = await dependencies.db.prepare("SELECT email FROM user WHERE id = ?").bind(parsed.data.memberId).first<{ email: string }>();
        if (recipient?.email) await dependencies.poolJoinNotifier.notifyShareOrderFulfilled({ to: recipient.email, poolName: view.pool.name, sharesMicros: result.sharesMicros, valueMicros: result.valueMicros });
      } catch {}
    }
    return c.json(result);
  }));

  app.post("/api/p/:slug/admin/orders/:orderId/reverse", (c) => mutation(c, async (user) => {
    const parsed = reverseShareOrderRequest.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    if (!(await dependencies.recentlyAuthenticated?.(c.req.raw, user))) return jsonError(c, "RECENT_AUTH_REQUIRED", 403);
    return c.json(await router.send(c.req.param("slug"), { type: "ReverseShareOrder", commandId: parsed.data.idempotencyKey, actorId: user.id, orderId: c.req.param("orderId"), reason: parsed.data.reason }));
  }));
  app.post("/api/p/:slug/admin/transfer", (c) => mutation(c, async (user) => {
    const parsed = transferCommissionerRequest.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    if (!(await dependencies.recentlyAuthenticated?.(c.req.raw, user))) return jsonError(c, "RECENT_AUTH_REQUIRED", 403);
    const slug = c.req.param("slug");
    const result = await router.send(slug, { type: "TransferCommissioner", commandId: parsed.data.idempotencyKey, actorId: user.id, memberId: parsed.data.memberId, reason: parsed.data.reason });
    if (result.transferred === true && result.replayed !== true && dependencies.poolJoinNotifier) {
      const view = ReadPoolView.parse(await router.send(slug, { type: "ReadPoolView", commandId: crypto.randomUUID(), actorId: user.id }));
      const newCommissioner = view.members.find((member) => member.memberId === parsed.data.memberId);
      const formerCommissioner = view.members.find((member) => member.memberId === user.id);
      const [newRecipient, formerRecipient] = await Promise.all([
        dependencies.db.prepare("SELECT email FROM user WHERE id = ?").bind(parsed.data.memberId).first<{ email: string }>(),
        dependencies.db.prepare("SELECT email FROM user WHERE id = ?").bind(user.id).first<{ email: string }>()
      ]);
      const details = { poolName: view.pool.name, formerCommissionerName: formerCommissioner?.displayName ?? user.name, newCommissionerName: newCommissioner?.displayName ?? parsed.data.memberId };
      if (newRecipient?.email) { try { await dependencies.poolJoinNotifier.notifyCommissionerTransfer({ to: newRecipient.email, ...details, recipient: "new" }); } catch {} }
      if (formerRecipient?.email) { try { await dependencies.poolJoinNotifier.notifyCommissionerTransfer({ to: formerRecipient.email, ...details, recipient: "former" }); } catch {} }
    }
    return c.json(result);
  }));
  for (const action of ["suspend", "restore"] as const) app.post(`/api/p/:slug/admin/members/:memberId/${action}`, (c) => mutation(c, async (user) => {
    const parsed = memberStatusRequest.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    return c.json(await router.send(c.req.param("slug"), { type: action === "suspend" ? "SuspendMember" : "RestoreMember", commandId: parsed.data.idempotencyKey, actorId: user.id, memberId: c.req.param("memberId") }));
  }));
  app.post("/api/p/:slug/admin/corrections/:wagerId/void", (c) => mutation(c, async (user) => {
    const parsed = voidWagerRequest.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    if (!(await dependencies.recentlyAuthenticated?.(c.req.raw, user))) return jsonError(c, "RECENT_AUTH_REQUIRED", 403);
    return c.json(await router.send(c.req.param("slug"), { type: "VoidWager", commandId: parsed.data.idempotencyKey, actorId: user.id, wagerId: c.req.param("wagerId"), reason: parsed.data.reason }));
  }));
  app.post("/api/p/:slug/admin/corrections/:wagerId/regrade", (c) => mutation(c, async (user) => {
    const parsed = regradeWagerRequest.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    if (!(await dependencies.recentlyAuthenticated?.(c.req.raw, user))) return jsonError(c, "RECENT_AUTH_REQUIRED", 403);
    return c.json(await router.send(c.req.param("slug"), { type: "RegradeWager", commandId: parsed.data.idempotencyKey, actorId: user.id, wagerId: c.req.param("wagerId"), reason: parsed.data.reason, correctedResults: parsed.data.correctedResults }));
  }));
  app.post("/api/p/:slug/admin/history/:seasonId/annotations", (c) => mutation(c, async (user) => {
    const parsed = seasonAnnotationRequest.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    return c.json(await router.send(c.req.param("slug"), { type: "CreateSeasonAnnotation", commandId: parsed.data.idempotencyKey, actorId: user.id, seasonId: c.req.param("seasonId"), text: parsed.data.text }));
  }));

  app.post("/api/p/:slug/admin/seasons", (c) => mutation(c, async (user) => {
    const parsed = createSeasonSchema.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    return c.json(await router.send(c.req.param("slug"), { type: "CreateSeason", commandId: parsed.data.idempotencyKey, actorId: user.id, seasonId: parsed.data.seasonId, label: parsed.data.label, ...(parsed.data.defaultOrder === undefined ? {} : { defaultOrder: parsed.data.defaultOrder }) }));
  }));
  app.post("/api/p/:slug/admin/seasons/:seasonId/open", (c) => mutation(c, async (user) => {
    const parsed = seasonIdSchema.safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    return c.json(await router.send(c.req.param("slug"), { type: "OpenSeason", commandId: parsed.data.idempotencyKey, actorId: user.id, seasonId: c.req.param("seasonId") }));
  }));
  app.post("/api/p/:slug/admin/seasons/:seasonId/super-bowl/confirm", (c) => mutation(c, async (user) => {
    const parsed = seasonIdSchema.extend({ eventId: z.string().min(1) }).safeParse(await c.req.json());
    if (!parsed.success) return jsonError(c, "INVALID_REQUEST");
    return c.json(await router.send(c.req.param("slug"), { type: "ConfirmSuperBowl", commandId: parsed.data.idempotencyKey, actorId: user.id, seasonId: c.req.param("seasonId"), eventId: parsed.data.eventId }));
  }));

}

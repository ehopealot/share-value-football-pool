import { auditExportResponse, OddsBoardResponse, ReadPoolView, ReadStandings, ReadActivity, ReadSeasonHistory, ReadMessageBoardResponse, MessageBoardMutationResponse, MessageBoardPostResponse, shareOrderQuoteSnapshot, straightWagerQuoteSnapshot, teaserWagerQuoteSnapshot, straightWagerPlacementRequest, teaserWagerPlacementRequest, executeShareOrderRequest, type AuditExportResponse, type OddsBoardResponse as OddsBoardResponseType, type ReadPoolView as ReadPoolViewType, type ReadStandings as ReadStandingsType, type ReadActivity as ReadActivityType, type ReadSeasonHistory as ReadSeasonHistoryType } from "../contracts/http";
import type { z } from "zod";

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly details: Record<string, unknown> = {}) { super(code); }
}

export type CommandOutcome = "stale" | "retryable" | "terminal";

/** Browser confirmation recovery taxonomy. Transport and availability failures must replay the frozen command. */
export const commandOutcome = (error: unknown): CommandOutcome => {
  if (!(error instanceof ApiError) || error.status >= 500) return "retryable";
  if (error.code === "LINE_CHANGED" || error.code === "ORDER_QUOTE_STALE") return "stale";
  if (["POOL_NOT_AVAILABLE", "POOL_UNAVAILABLE", "RECENT_AUTH_REQUIRED"].includes(error.code)) return "retryable";
  return "terminal";
};

export const errorMessage = (error: unknown) => {
  if (!(error instanceof ApiError)) return "Service unavailable.";
  const messages: Record<string, string> = { LINE_CHANGED: "Line changed.", SUSPENDED: "Pool access suspended.", INSUFFICIENT_SHARES: "Not enough shares.", SIDE_BET_LIMIT: "Side bet limit reached.", WHOLE_SHARE_RISK_REQUIRED: "Whole shares required.", MARKET_STALE: "Odds are stale.", MARKET_UNAVAILABLE: "Market unavailable.", MARKET_LOCKED: "Event has started.", WAGER_NOT_STARTED: "Wager has not started.", SEASON_CLOSED: "Season is closed.", SEASON_NOT_ACTIVE: "No active season.", SEASON_NOT_CLOSED: "Season is not closed.", ORDER_QUOTE_STALE: "Share price changed.", ORDER_REVERSAL_INSUFFICIENT_AVAILABLE_SHARES: "Not enough shares to reverse this order.", RECENT_AUTH_REQUIRED: "Sign in again.", IDEMPOTENCY_CONFLICT: "Duplicate request.", MESSAGE_BOARD_POST_NOT_FOUND: "That post is no longer available.", MESSAGE_BOARD_REPLY_NOT_ALLOWED: "Replies can only be added to a top-level post.", REQUEST_FAILED: "Service unavailable.", POOL_NOT_AVAILABLE: "Pool unavailable.", POOL_UNAVAILABLE: "Pool unavailable." };
  return messages[error.code] ?? `Request failed: ${error.code}.`;
};

type StraightQuoteRequest = { wagerId: string; quoteKey: string; commandId: string; seasonId: string; riskMicros: string; rulesetVersion: string; leg: { eventId: string; canonicalBook: string; market: string; selection: string; offerId: string; offerVersion: string } };
type TeaserQuoteRequest = { wagerId: string; quoteKey: string; commandId: string; seasonId: string; riskMicros: string; teaserPoints: number; rulesetVersion: string; legs: Array<{ eventId: string; canonicalBook: string; market: string; selection: string; offerId: string; offerVersion: string }> };
type OrderQuoteRequest = { seasonId: string; memberId: string; mode: string; amountMicros: string; idempotencyKey: string };
const responseMismatch = () => { throw new ApiError("QUOTE_RESPONSE_MISMATCH", 502); };
export const parseStraightQuoteSuccess = (request: StraightQuoteRequest, value: unknown) => {
  const quote = straightWagerQuoteSnapshot.parse(value); const leg = quote.leg;
  if (quote.quoteKey !== request.quoteKey || quote.seasonId !== request.seasonId || quote.riskMicros !== request.riskMicros || quote.rulesetVersion !== request.rulesetVersion || leg.eventId !== request.leg.eventId || leg.canonicalBook !== request.leg.canonicalBook || leg.market !== request.leg.market || leg.selection !== request.leg.selection || leg.canonicalOfferProof.offerId !== request.leg.offerId || leg.offerVersion !== request.leg.offerVersion) responseMismatch();
  return quote;
};
export const parseTeaserQuoteSuccess = (request: TeaserQuoteRequest, value: unknown) => {
  const quote = teaserWagerQuoteSnapshot.parse(value);
  if (quote.quoteKey !== request.quoteKey || quote.seasonId !== request.seasonId || quote.riskMicros !== request.riskMicros || quote.teaserPoints !== request.teaserPoints || quote.rulesetVersion !== request.rulesetVersion || quote.legs.length !== request.legs.length) responseMismatch();
  quote.legs.forEach((leg, index) => { const expected = request.legs[index]; if (!expected || leg.eventId !== expected.eventId || leg.canonicalBook !== expected.canonicalBook || leg.market !== expected.market || leg.selection !== expected.selection || leg.canonicalOfferProof.offerId !== expected.offerId || leg.offerVersion !== expected.offerVersion) responseMismatch(); });
  return quote;
};
export const parseShareOrderQuoteSuccess = (request: OrderQuoteRequest, value: unknown, expectedMemberId = request.memberId) => {
  const quote = shareOrderQuoteSnapshot.parse(value);
  if (quote.seasonId !== request.seasonId || quote.memberId !== request.memberId || quote.memberId !== expectedMemberId || quote.mode !== request.mode || quote.amountMicros !== request.amountMicros) responseMismatch();
  return quote;
};
/** Placement builders deliberately select only authority fields, never response ownership/display fields. */
export const buildStraightPlacement = (quote: z.infer<typeof straightWagerQuoteSnapshot>, wagerId: string, mutationKey: string) => straightWagerPlacementRequest.parse({ wagerId, quoteKey: quote.quoteKey, quotedCommandVersion: quote.commandVersion, mutationKey, commandId: mutationKey, seasonId: quote.seasonId, riskMicros: quote.riskMicros, acceptedOdds: quote.acceptedOdds, rulesetVersion: quote.rulesetVersion, leg: quote.leg });
export const buildTeaserPlacement = (quote: z.infer<typeof teaserWagerQuoteSnapshot>, wagerId: string, mutationKey: string) => teaserWagerPlacementRequest.parse({ wagerId, quoteKey: quote.quoteKey, quotedCommandVersion: quote.commandVersion, mutationKey, commandId: mutationKey, seasonId: quote.seasonId, riskMicros: quote.riskMicros, acceptedOdds: quote.acceptedOdds, teaserPoints: quote.teaserPoints, rulesetVersion: quote.rulesetVersion, legs: quote.legs });
export const buildShareOrderExecution = (quote: z.infer<typeof shareOrderQuoteSnapshot>, mutationKey: string, reason: string) => executeShareOrderRequest.parse({ seasonId: quote.seasonId, memberId: quote.memberId, mode: quote.mode, amountMicros: quote.amountMicros, quote: { priceMicros: quote.priceMicros, commandVersion: quote.commandVersion }, reason, idempotencyKey: mutationKey });
export const parseAuditExportSuccess = (value: unknown): AuditExportResponse => auditExportResponse.parse(value);
export const parseOddsBoardSuccess = (value: unknown): OddsBoardResponseType => OddsBoardResponse.parse(value);
export const parseReadMessageBoardSuccess = (value: unknown) => ReadMessageBoardResponse.parse(value);
export const parseMessageBoardMutationSuccess = (value: unknown) => MessageBoardMutationResponse.parse(value);
export const parseMessageBoardPostSuccess = (value: unknown) => MessageBoardPostResponse.parse(value);

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({})) as { code?: string } & T;
  if (!response.ok) throw new ApiError(body.code ?? "REQUEST_FAILED", response.status, body as Record<string, unknown>);
  return body;
};

export class TurnstileClientError extends Error {
  constructor() { super("TURNSTILE_UNAVAILABLE"); }
}

type TurnstileClient = {
  render: (container: HTMLElement, options: { sitekey: string; action: string; execution: "execute"; callback: (token: string) => void; "error-callback": () => void; "expired-callback": () => void }) => string;
  execute: (widgetId: string) => void;
  remove?: (widgetId: string) => void;
};
type TurnstileWindow = Window & { __officePoolRebornTurnstileReady?: Promise<TurnstileClient> };
const configuredSiteKey = () => {
  const siteKey = document.querySelector<HTMLMetaElement>('meta[name="turnstile-site-key"]')?.content;
  return siteKey && !siteKey.startsWith("%") ? siteKey : undefined;
};

/** Resolves only after the explicit Turnstile API script has fired its load event. */
const loadedTurnstileClient = async (): Promise<TurnstileClient> => {
  const loaded = (window as TurnstileWindow).__officePoolRebornTurnstileReady;
  if (!loaded) throw new TurnstileClientError();
  try {
    const client = await loaded;
    if (typeof client?.render !== "function" || typeof client.execute !== "function") throw new Error("TURNSTILE_CLIENT_INVALID");
    return client;
  } catch {
    throw new TurnstileClientError();
  }
};

/**
 * Explicit Turnstile widgets return their response exclusively through callbacks.
 * The target is visible to assistive technology and lives beside the protected form.
 */
export async function acquireTurnstileToken(target?: HTMLElement | null): Promise<string | undefined> {
  const siteKey = configuredSiteKey();
  if (!siteKey) return undefined;
  const turnstile = await loadedTurnstileClient();
  const container = target ?? document.createElement("div");
  const transientTarget = !target;
  if (!container.id) container.id = `turnstile-${crypto.randomUUID()}`;
  if (transientTarget) { container.setAttribute("aria-label", "Anti-abuse verification"); document.body.appendChild(container); }
  return new Promise<string>((resolve, reject) => {
    let widgetId = ""; let settled = false;
    const cleanup = () => {
      if (widgetId) turnstile.remove?.(widgetId);
      (container as HTMLElement & { replaceChildren?: () => void }).replaceChildren?.();
      if (transientTarget) container.remove();
    };
    const fail = () => { if (settled) return; settled = true; cleanup(); reject(new TurnstileClientError()); };
    const succeed = (token: string) => { if (!token) return fail(); if (settled) return; settled = true; cleanup(); resolve(token); };
    try {
      widgetId = turnstile.render(container, { sitekey: siteKey, action: "submit", execution: "execute", callback: succeed, "error-callback": fail, "expired-callback": fail });
      turnstile.execute(widgetId);
    } catch { fail(); }
  });
}

export type Membership = { poolId: string; slug: string; poolName: string; role: string; status: string; projectionVersion: string };
export type PoolGate = { membership: "member" } | { membership: "joinable"; poolName: string; signupsOpen: true } | { membership: "closed"; signupsOpen: false };
type Turnstile = { turnstileToken?: string };

export type Session = { user?: { id: string; name: string; email: string } };
const sessionInvalidated = "share-pool:session-invalidated";
export const invalidateSession = () => window.dispatchEvent(new Event(sessionInvalidated));
export const onSessionInvalidated = (listener: () => void) => {
  window.addEventListener(sessionInvalidated, listener);
  return () => window.removeEventListener(sessionInvalidated, listener);
};
const poolViewInvalidated = "share-pool:pool-view-invalidated";
/** Board reads and successful board mutations use this local event to refresh the authoritative nav marker. */
export const invalidatePoolView = () => window.dispatchEvent(new Event(poolViewInvalidated));
export const onPoolViewInvalidated = (listener: () => void) => {
  window.addEventListener(poolViewInvalidated, listener);
  return () => window.removeEventListener(poolViewInvalidated, listener);
};

const REQUEST_TIMEOUT_MS = 5_000;
/** A withheld completed quote or placement must return control to its retry state. */
const boundedJson = <T>(path: string, init?: RequestInit) => json<T>(path, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

export const api = {
  session: async (): Promise<Session> => (await json<Session | null>("/api/auth/get-session", { method: "GET", headers: {} })) ?? {},
  memberships: () => json<{ memberships: Membership[] }>("/api/pools", { method: "GET", headers: {} }),
  gate: (slug: string) => json<PoolGate>(`/api/p/${encodeURIComponent(slug)}/gate`, { method: "GET", headers: {} }),
  signUp: (name: string, email: string, password: string, security: Turnstile) => json("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ name, email, password, ...security }) }),
  signIn: (email: string, password: string, security: Turnstile) => json("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password, ...security }) }),
  signOut: () => json("/api/auth/sign-out", { method: "POST", body: JSON.stringify({}) }),
  forgotPassword: (email: string, next: string) => json("/api/auth/request-password-reset", { method: "POST", body: JSON.stringify({ email, redirectTo: `${location.origin}/reset-password?next=${encodeURIComponent(next)}` }) }),
  resetPassword: (token: string, newPassword: string) => json("/api/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword }) }),
  createPool: (input: { poolName: string; slug: string; password: string; idempotencyKey: string } & Turnstile) => json<{ slug: string }>("/api/pools", { method: "POST", body: JSON.stringify(input) }),
  joinPool: (slug: string, password: string, idempotencyKey: string, security: Turnstile) => json(`/api/p/${encodeURIComponent(slug)}/join`, { method: "POST", body: JSON.stringify({ password, idempotencyKey, ...security }) }),
  updateNickname: (slug: string, displayName: string, idempotencyKey: string) => api.command(slug, "/nickname", { displayName, idempotencyKey }),
  poolView: async (slug: string): Promise<ReadPoolViewType> => ReadPoolView.parse(await json<unknown>(`/api/p/${encodeURIComponent(slug)}/view`, { method: "GET", headers: {} })),
  readMessageBoard: async (slug: string) => parseReadMessageBoardSuccess(await boundedJson<unknown>(`/api/p/${encodeURIComponent(slug)}/board/read`, { method: "POST", body: JSON.stringify({}) })),
  createMessageBoardPost: async (slug: string, body: { text: string; idempotencyKey: string; announcement: boolean }) => parseMessageBoardPostSuccess(await boundedJson<unknown>(`/api/p/${encodeURIComponent(slug)}/board/posts`, { method: "POST", body: JSON.stringify(body) })),
  replyToMessageBoardPost: async (slug: string, postId: string, body: { text: string; idempotencyKey: string }) => parseMessageBoardMutationSuccess(await boundedJson<unknown>(`/api/p/${encodeURIComponent(slug)}/board/posts/${encodeURIComponent(postId)}/replies`, { method: "POST", body: JSON.stringify(body) })),
  // Bound a lost local/network odds response so stale-confirmation replay remains reachable.
  odds: async (slug: string, query = ""): Promise<OddsBoardResponseType> => parseOddsBoardSuccess(await json<unknown>(`/api/p/${encodeURIComponent(slug)}/odds${query}`, { method: "GET", headers: {}, signal: AbortSignal.timeout(5_000) })),
  standings: async (slug: string): Promise<ReadStandingsType> => ReadStandings.parse(await json<unknown>(`/api/p/${encodeURIComponent(slug)}/standings`, { method: "GET", headers: {} })),
  activity: async (slug: string): Promise<ReadActivityType> => ReadActivity.parse(await json<unknown>(`/api/p/${encodeURIComponent(slug)}/activity`, { method: "GET", headers: {} })),
  history: async (slug: string, seasonId: string): Promise<ReadSeasonHistoryType> => ReadSeasonHistory.parse(await json<unknown>(`/api/p/${encodeURIComponent(slug)}/history/${encodeURIComponent(seasonId)}`, { method: "GET", headers: {} })),
  auditExport: async (slug: string): Promise<AuditExportResponse> => parseAuditExportSuccess(await json<unknown>(`/api/p/${encodeURIComponent(slug)}/export`, { method: "GET", headers: {} })),
  wagers: (slug: string) => json<any>(`/api/p/${encodeURIComponent(slug)}/wagers`, { method: "GET", headers: {} }),
  /** Administration retries need a bounded lost-response path so the frozen command can be replayed. */
  command: (slug: string, path: string, body: unknown) => boundedJson<unknown>(`/api/p/${encodeURIComponent(slug)}${path}`, { method: "POST", body: JSON.stringify(body) }),
  /** Only durable placement/execution retries need bounded response recovery. */
  placeCommand: (slug: string, path: string, body: unknown) => boundedJson<unknown>(`/api/p/${encodeURIComponent(slug)}${path}`, { method: "POST", body: JSON.stringify(body) }),
  quoteStraight: async (slug: string, body: StraightQuoteRequest) => parseStraightQuoteSuccess(body, await boundedJson<unknown>(`/api/p/${encodeURIComponent(slug)}/wagers/straight/quote`, { method: "POST", body: JSON.stringify(body) })),
  quoteTeaser: async (slug: string, body: TeaserQuoteRequest) => parseTeaserQuoteSuccess(body, await boundedJson<unknown>(`/api/p/${encodeURIComponent(slug)}/wagers/teasers/quote`, { method: "POST", body: JSON.stringify(body) })),
  quoteOrder: async (slug: string, body: OrderQuoteRequest, expectedMemberId = body.memberId) => parseShareOrderQuoteSuccess(body, await boundedJson<unknown>(`/api/p/${encodeURIComponent(slug)}/admin/orders/quote`, { method: "POST", body: JSON.stringify(body) }), expectedMemberId),
  reverseOrder: (slug: string, orderId: string, body: { reason: string; idempotencyKey: string }) => json<unknown>(`/api/p/${encodeURIComponent(slug)}/admin/orders/${encodeURIComponent(orderId)}/reverse`, { method: "POST", body: JSON.stringify(body) }),
  confirmSuperBowl: (slug: string, seasonId: string, eventId: string, idempotencyKey: string) => api.command(slug, `/admin/seasons/${encodeURIComponent(seasonId)}/super-bowl/confirm`, { eventId, idempotencyKey })
};

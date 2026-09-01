import { offerIsStale } from "../odds/ingestion";
import { resolveCanonicalOutcomeSide, validateCanonicalMarket, vigFreeMoneylinePrice } from "../odds/market-semantics";
import { CANONICAL_BOOK_POLICY_VERSION, type MarketName, type ProviderEvent } from "../odds/types";
import type { PoolCommand } from "../durable/pool-commands";
import { TEASER_RULESET_ID, teaserOdds } from "../domain/teaser-table";
import { adjustTeaserLine } from "../domain/grading";
import type { TeaserLeg } from "../domain/types";

export class LineChangedError extends Error {
  constructor(readonly replacement: Record<string, unknown>) { super("LINE_CHANGED"); }
}

/** A quote miss found a different current canonical semantic offer; no snapshot may be persisted. */
export class QuoteLineChangedError extends Error {
  constructor() { super("LINE_CHANGED"); }
}

export type OfferQuote = { eventId: string; market: MarketName; canonicalBook: string; retrievedAt: string; offerVersion: string; payload: unknown };
type Placement = Extract<PoolCommand, { type: "PlaceStraightWager" | "PlaceTeaserWager" }>;
type PlacementLeg = Extract<PoolCommand, { type: "PlaceStraightWager" }>['leg'] | Extract<PoolCommand, { type: "PlaceTeaserWager" }>['legs'][number];
type OfferRow = Record<"league" | "home_team" | "away_team" | "starts_at" | "status" | "canonical_book" | "retrieved_at" | "offer_version" | "payload_json", string>;
type IngestionRow = { last_success_at: string | null; last_error: string | null };
export type StoredOutcome = { name: string; price: number; point?: number };
export type StoredOffer = { policyVersion: typeof CANONICAL_BOOK_POLICY_VERSION; outcomes: StoredOutcome[] };
export type StoredOfferContext = { market: MarketName; canonicalBook: string; homeTeam: string; awayTeam: string };

/** Worker read boundary: D1 supplies disposable offers, never account authorization or settlement coverage. */
export class OfferQuotes {
  constructor(private readonly db: D1Database) {}
  async current(event: Pick<ProviderEvent, "id" | "commenceTime" | "status" | "homeTeam" | "awayTeam">, market: MarketName, now = new Date()): Promise<OfferQuote | null> {
    if ((event.status !== undefined && event.status !== "scheduled") || new Date(event.commenceTime) <= now) return null;
    const [offerResult, ingestionResult] = await this.db.batch([
      this.db.prepare("SELECT canonical_book, retrieved_at, offer_version, payload_json FROM market_offer WHERE event_id = ? AND market = ?").bind(event.id, market),
      this.db.prepare("SELECT last_success_at, last_error FROM odds_ingestion WHERE provider = 'odds' LIMIT 1")
    ]);
    const row = offerResult.results[0] as Record<string, string> | undefined;
    const ingestion = ingestionResult.results[0] as IngestionRow | undefined;
    if (!row || offerIsStale(row.retrieved_at, event, now) || !ingestionCoversOffer(ingestion, row.retrieved_at)) return null;
    try {
      return { eventId: event.id, market, canonicalBook: row.canonical_book, retrievedAt: row.retrieved_at, offerVersion: row.offer_version, payload: decodeStoredOffer(row.payload_json, { market, canonicalBook: row.canonical_book, homeTeam: event.homeTeam, awayTeam: event.awayTeam }) };
    } catch { return null; }
  }
}

/**
 * Rechecks every placement term against the canonical D1 offer immediately before
 * Worker-to-PoolDO dispatch. A changed quote must be shown and confirmed again;
 * the DO only receives the D1-validated immutable proof.
 */
/** Builds a quote's accepted terms solely from the current canonical D1 offer. */
export async function canonicalizeWagerQuote(db: D1Database, proposed: Placement, now = new Date()): Promise<Placement> {
  const proposedLegs = proposed.type === "PlaceStraightWager" ? [proposed.leg] : proposed.legs;
  const snapshot = await readPlacementSnapshot(db, proposedLegs);
  const canonicalLegs = proposedLegs.map((leg, index) => canonicalLeg(snapshot.rows[index], snapshot.ingestion, leg, now));
  if (proposed.type === "PlaceStraightWager") {
    const leg = canonicalLegs[0]!;
    return { ...proposed, acceptedOdds: leg.market === "moneyline" ? leg.originalOdds : 100, rulesetVersion: TEASER_RULESET_ID, leg: { ...leg, adjustedLine: leg.originalLine } } as Placement;
  }
  const legs = canonicalLegs.map((leg) => ({ ...leg, adjustedLine: adjustTeaserLine({ eventId: leg.eventId, market: leg.market, selection: leg.selection, line: leg.originalLine! } as TeaserLeg, proposed.teaserPoints) }));
  const acceptedOdds = teaserOdds(legs.length, proposed.teaserPoints);
  if (acceptedOdds === undefined) throw new Error("NON_CANONICAL_QUOTE");
  return { ...proposed, acceptedOdds, rulesetVersion: TEASER_RULESET_ID, legs } as Placement;
}

/** The semantic request is an assertion about the exact current canonical offer, not a canonicalization hint. */
export function quoteRequestMatchesCanonical(submitted: { rulesetVersion: string; leg?: Record<string, unknown>; legs?: Array<Record<string, unknown>> }, canonical: Placement): boolean {
  const currentLegs = canonical.type === "PlaceStraightWager" ? [canonical.leg] : canonical.legs;
  const submittedLegs = submitted.leg ? [submitted.leg] : submitted.legs;
  if (!submittedLegs || submittedLegs.length !== currentLegs.length || submitted.rulesetVersion !== canonical.rulesetVersion) return false;
  return submittedLegs.every((leg, index) => {
    const current = currentLegs[index]!;
    return leg.eventId === current.eventId
      && leg.canonicalBook === current.canonicalBook
      && leg.market === current.market
      && leg.selection === current.selection
      && leg.offerId === current.canonicalOfferProof.offerId
      && leg.offerVersion === current.offerVersion;
  });
}

export async function revalidateWagerOffers(db: D1Database, command: Placement, now = new Date()): Promise<Placement> {
  const legs = command.type === "PlaceStraightWager" ? [command.leg] : command.legs;
  const snapshot = await readPlacementSnapshot(db, legs);
  try {
    const teaserAdjustment = command.type === "PlaceTeaserWager" ? command.teaserPoints : undefined;
    legs.forEach((leg, index) => revalidateLeg(snapshot.rows[index], snapshot.ingestion, leg, now, teaserAdjustment));
  } catch (error) {
    if (error instanceof LineChangedError) {
      // An absent selected outcome cannot produce replacement terms, but it is
      // still a stale quote rather than an unrelated market-read failure.
      try {
        throw new LineChangedError(await canonicalizeWagerQuote(db, command, now) as Record<string, unknown>);
      } catch (replacementError) {
        if (replacementError instanceof LineChangedError || !(replacementError instanceof Error) || replacementError.message !== "MARKET_UNAVAILABLE") throw replacementError;
        throw error;
      }
    }
    throw error;
  }
  // Payout terms are fixed authority, never client-selected presentation values.
  if (command.type === "PlaceStraightWager") {
    const expectedOdds = command.leg.market === "moneyline" ? command.leg.originalOdds : 100;
    if (command.acceptedOdds !== expectedOdds || command.rulesetVersion !== TEASER_RULESET_ID) throw new Error("NON_CANONICAL_QUOTE");
  } else {
    const expectedOdds = teaserOdds(command.legs.length, command.teaserPoints);
    if (expectedOdds === undefined || command.acceptedOdds !== expectedOdds || command.rulesetVersion !== TEASER_RULESET_ID) throw new Error("NON_CANONICAL_QUOTE");
    for (const leg of command.legs) {
      const expected = adjustTeaserLine({ eventId: leg.eventId, market: leg.market, selection: leg.selection, line: leg.originalLine } as TeaserLeg, command.teaserPoints);
      if (leg.adjustedLine !== expected) throw new Error("NON_CANONICAL_QUOTE");
    }
  }
  return command;
}

async function readPlacementSnapshot(db: D1Database, legs: PlacementLeg[]): Promise<{ rows: Array<OfferRow | undefined>; ingestion: IngestionRow | undefined }> {
  const identities = legs.map((leg) => `${leg.eventId}\u0000${leg.market}`);
  if (new Set(identities).size !== identities.length) throw new Error("MARKET_UNAVAILABLE");
  const statements = legs.map((leg) => db.prepare("SELECT e.league, e.home_team, e.away_team, e.starts_at, e.status, mo.canonical_book, mo.retrieved_at, mo.offer_version, mo.payload_json FROM sports_event e JOIN market_offer mo ON mo.event_id = e.id WHERE e.provider_event_id = ? AND mo.market = ?").bind(leg.eventId, leg.market));
  statements.push(db.prepare("SELECT last_success_at, last_error FROM odds_ingestion WHERE provider = 'odds' LIMIT 1"));
  const results = await db.batch(statements);
  return {
    rows: results.slice(0, -1).map((result) => result.results.length === 1 ? result.results[0] as OfferRow : undefined),
    ingestion: results.at(-1)?.results.length === 1 ? results.at(-1)!.results[0] as IngestionRow : undefined
  };
}

function canonicalLeg(row: OfferRow | undefined, ingestion: IngestionRow | undefined, leg: PlacementLeg, now: Date): PlacementLeg {
  if (!row) throw new Error("MARKET_UNAVAILABLE");
  if (row.status !== "scheduled" || new Date(row.starts_at) <= now) throw new Error("MARKET_LOCKED");
  if (offerIsStale(row.retrieved_at, { commenceTime: row.starts_at, status: "scheduled" }, now)) throw new Error("MARKET_STALE");
  if (!ingestionCoversOffer(ingestion, row.retrieved_at)) throw new Error("MARKET_UNAVAILABLE");
  const payload = decodeStoredOffer(row.payload_json, { market: leg.market, canonicalBook: row.canonical_book, homeTeam: row.home_team, awayTeam: row.away_team });
  const matching = payload.outcomes.filter((item) => resolveCanonicalOutcomeSide({ market: leg.market, homeTeam: row.home_team, awayTeam: row.away_team }, item.name) === leg.selection);
  const outcome = matching.length === 1 ? matching[0] : undefined;
  if (!outcome) throw new Error("MARKET_UNAVAILABLE");
  const originalLine = outcome.point;
  // Moneyline tickets strike at the vig-free fair line; the proof keeps the true book price as source.
  const strikeOdds = leg.market === "moneyline" && (leg.selection === "home" || leg.selection === "away") ? vigFreeMoneylinePrice({ homeTeam: row.home_team, awayTeam: row.away_team }, payload.outcomes, leg.selection) : outcome.price;
  if (strikeOdds === undefined) throw new Error("MARKET_UNAVAILABLE");
  const canonicalOfferProof = { offerId: `${leg.eventId}:${leg.market}:${leg.selection}`, eventId: leg.eventId, offerVersion: row.offer_version, canonicalBook: row.canonical_book, market: leg.market, selection: leg.selection, odds: outcome.price, line: originalLine ?? null };
  return { eventId: leg.eventId, league: row.league as "nfl" | "ncaaf", canonicalBook: row.canonical_book, retrievedAt: row.retrieved_at, policyVersion: payload.policyVersion, offerVersion: row.offer_version, canonicalOfferProof, market: leg.market, selection: leg.selection, originalLine: originalLine ?? null, adjustedLine: originalLine ?? null, originalOdds: strikeOdds, eventStartsAt: row.starts_at, homeTeam: row.home_team, awayTeam: row.away_team } as PlacementLeg;
}

function revalidateLeg(row: OfferRow | undefined, ingestion: IngestionRow | undefined, leg: PlacementLeg, now: Date, teaserPoints?: Extract<PoolCommand, { type: "PlaceTeaserWager" }>["teaserPoints"]): void {
  if (!row) throw new Error("MARKET_UNAVAILABLE");
  if (row.status !== "scheduled" || new Date(row.starts_at) <= now) throw new Error("MARKET_LOCKED");
  if (offerIsStale(row.retrieved_at, { commenceTime: row.starts_at, status: "scheduled" }, now)) throw new Error("MARKET_STALE");
  if (!ingestionCoversOffer(ingestion, row.retrieved_at)) throw new Error("MARKET_UNAVAILABLE");
  let payload: StoredOffer;
  try {
    payload = decodeStoredOffer(row.payload_json, { market: leg.market, canonicalBook: row.canonical_book, homeTeam: row.home_team, awayTeam: row.away_team });
  } catch {
    // A formerly quoted offer whose stored semantics are no longer admissible is
    // placement turnover, not a reason to mutate the PoolDO with stale terms.
    throw new LineChangedError({ eventId: leg.eventId, market: leg.market, selection: leg.selection, canonicalOfferProof: null });
  }
  const matching = payload.outcomes.filter((item) => resolveCanonicalOutcomeSide({ market: leg.market, homeTeam: row.home_team, awayTeam: row.away_team }, item.name) === leg.selection);
  const outcome = matching.length === 1 ? matching[0] : undefined;
  const line = outcome?.point ?? null;
  // The strike the ticket must carry: the vig-free fair line for moneyline, the book price otherwise.
  const expectedStrikeOdds = leg.market === "moneyline" && (leg.selection === "home" || leg.selection === "away") ? (outcome ? vigFreeMoneylinePrice({ homeTeam: row.home_team, awayTeam: row.away_team }, payload.outcomes, leg.selection) : undefined) : outcome?.price;
  const offerId = `${leg.eventId}:${leg.market}:${leg.selection}`;
  const proof = leg.canonicalOfferProof;
  const expectedAdjustedLine = teaserPoints === undefined
    ? leg.market === "moneyline" ? null : line
    : adjustTeaserLine({ eventId: leg.eventId, market: leg.market, selection: leg.selection, line: leg.originalLine! } as TeaserLeg, teaserPoints);
  const matches = payload.policyVersion === CANONICAL_BOOK_POLICY_VERSION
    && leg.league === row.league
    && leg.canonicalBook === row.canonical_book
    && leg.retrievedAt === row.retrieved_at
    && leg.policyVersion === payload.policyVersion
    && leg.offerVersion === row.offer_version
    && leg.eventStartsAt === row.starts_at
    && outcome !== undefined
    && expectedStrikeOdds !== undefined
    && leg.originalOdds === expectedStrikeOdds
    && leg.originalLine === line
    && leg.adjustedLine === expectedAdjustedLine
    && proof.offerId === offerId
    && proof.eventId === leg.eventId
    && proof.offerVersion === row.offer_version
    && proof.canonicalBook === row.canonical_book
    && proof.market === leg.market
    && proof.selection === leg.selection
    && proof.odds === outcome.price
    && proof.line === line;
  if (!matches) throw new LineChangedError({
    eventId: leg.eventId, league: row.league, canonicalBook: row.canonical_book, retrievedAt: row.retrieved_at,
    policyVersion: payload.policyVersion, offerVersion: row.offer_version, market: leg.market, selection: leg.selection,
    originalOdds: expectedStrikeOdds, originalLine: line, adjustedLine: line, eventStartsAt: row.starts_at, homeTeam: row.home_team, awayTeam: row.away_team,
    canonicalOfferProof: outcome ? { offerId, eventId: leg.eventId, offerVersion: row.offer_version, canonicalBook: row.canonical_book, market: leg.market, selection: leg.selection, odds: outcome.price, line } : null
  });
}

/** The single context-aware fail-closed decoder for provider offer bytes stored in D1. */
export function decodeStoredOffer(payloadJson: string, context: StoredOfferContext): StoredOffer {
  const unavailable = (): never => { throw new Error("MARKET_UNAVAILABLE"); };
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (!plainObjectWithKeys(parsed, ["outcomes", "policyVersion"])) unavailable();
    const payload = parsed as Record<string, unknown>;
    const validated = validateCanonicalMarket({ ...context, policyVersion: payload.policyVersion, outcomes: payload.outcomes });
    return { policyVersion: CANONICAL_BOOK_POLICY_VERSION, outcomes: validated.outcomes };
  } catch (error) {
    if (error instanceof Error && error.message === "MARKET_UNAVAILABLE") throw error;
    throw new Error("MARKET_UNAVAILABLE");
  }
}

function plainObjectWithKeys(value: unknown, allowedKeys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === allowedKeys.length
    && Object.keys(value).every((key) => allowedKeys.includes(key));
}

function ingestionCoversOffer(ingestion: IngestionRow | undefined, retrievedAt: string): boolean {
  return !!ingestion && !ingestion.last_error && ingestion.last_success_at !== null
    && new Date(ingestion.last_success_at).getTime() >= new Date(retrievedAt).getTime();
}

import { timestamp } from "../contracts/commands";
import { validateParlay } from "../domain/parlay";
import { vigFreeMoneylinePrice } from "../odds/market-semantics";
import { resolveTrayItem, type TrayItem } from "./selection-tray";

export type ParlayLeg = {
  eventId: string;
  league: "nfl" | "ncaaf";
  canonicalBook: string;
  retrievedAt: string;
  policyVersion: string;
  offerVersion: string;
  canonicalOfferProof: { offerId: string; eventId: string; offerVersion: string; canonicalBook: string; market: string; selection: string; odds: number; line: number | null };
  market: "spread" | "total" | "moneyline";
  selection: "home" | "away" | "over" | "under";
  originalLine: number | null;
  originalOdds: number;
  adjustedLine: null;
  eventStartsAt: string;
  homeTeam?: string;
  awayTeam?: string;
};
type Offer = {
  eventId: string;
  league: "nfl" | "ncaaf";
  canonicalBook: string;
  retrievedAt: string;
  policyVersion: string;
  offerVersion: string;
  startsAt: string;
  market: ParlayLeg["market"];
  homeTeam: string;
  awayTeam: string;
  outcomes: Array<{ name?: string; price: number; point?: number }>;
};
type Outcome = { price: number; point?: number };
const key = (slug: string) => `share-pool:parlay:${slug}`;

/** Builds complete unadjusted parlay semantics only from a canonical board offer. */
export const parlayLegForOutcome = (offer: Offer, outcome: Outcome, selection: ParlayLeg["selection"]): ParlayLeg => {
  const originalLine = offer.market === "moneyline" ? null : outcome.point ?? null;
  const originalOdds = offer.market === "moneyline" && (selection === "home" || selection === "away")
    ? vigFreeMoneylinePrice({ homeTeam: offer.homeTeam, awayTeam: offer.awayTeam }, offer.outcomes, selection)
    : outcome.price;
  // Parsed board offers always contain both moneyline outcomes. Refuse malformed direct callers rather than estimating from vigged terms.
  if (originalOdds === undefined) throw new Error("CURRENT_OFFER_UNAVAILABLE");
  return {
    eventId: offer.eventId, league: offer.league, canonicalBook: offer.canonicalBook, retrievedAt: offer.retrievedAt, policyVersion: offer.policyVersion, offerVersion: offer.offerVersion,
    canonicalOfferProof: { offerId: `${offer.eventId}:${offer.market}:${selection}`, eventId: offer.eventId, offerVersion: offer.offerVersion, canonicalBook: offer.canonicalBook, market: offer.market, selection, odds: outcome.price, line: originalLine },
    market: offer.market, selection, originalLine, originalOdds, adjustedLine: null, eventStartsAt: offer.startsAt, homeTeam: offer.homeTeam, awayTeam: offer.awayTeam
  };
};

const opposite = (leg: Pick<ParlayLeg, "eventId" | "market" | "selection">) => leg.market === "total"
  ? `${leg.eventId}:total:${leg.selection === "over" ? "under" : "over"}`
  : `${leg.eventId}:${leg.market}:${leg.selection === "home" ? "away" : "home"}`;
const identity = (leg: Pick<ParlayLeg, "eventId" | "market" | "selection">) => `${leg.eventId}:${leg.market}:${leg.selection}`;
const directional = (market: ParlayLeg["market"]) => market === "spread" || market === "moneyline";

/** Adds a client leg without allowing a duplicate, an opposite, two directional markets, or a seventh leg. */
export const addParlayLeg = (legs: ParlayLeg[], leg: ParlayLeg): { legs: ParlayLeg[]; error: string } => {
  if (legs.length >= 6) return { legs, error: "Choose no more than six legs." };
  if (legs.some((candidate) => identity(candidate) === identity(leg))) return { legs, error: "Duplicate parlay selection." };
  if (legs.some((candidate) => identity(candidate) === opposite(leg))) return { legs, error: "Opposing parlay selections are not allowed." };
  if (directional(leg.market) && legs.some((candidate) => candidate.eventId === leg.eventId && directional(candidate.market) && candidate.market !== leg.market)) return { legs, error: "Only one directional market is allowed per event." };
  return { legs: [...legs, leg], error: "" };
};

/** Resolves and validates every tray selection before allowing any selection to leave the board. */
export const buildParlaySlip = (items: TrayItem[], board: { offers?: any[] }): { legs: ParlayLeg[]; error: string } => {
  let legs: ParlayLeg[] = [];
  for (const item of items) {
    const resolved = resolveTrayItem(board, item);
    if (!resolved) return { legs: [], error: "A selected parlay leg is no longer available on the board." };
    try {
      const next = addParlayLeg(legs, parlayLegForOutcome(resolved.offer, resolved.outcome, item.selection));
      if (next.error) return { legs: [], error: next.error };
      legs = next.legs;
    } catch { return { legs: [], error: "A selected parlay leg is no longer available on the board." }; }
  }
  try {
    validateParlay(legs);
    return { legs, error: "" };
  } catch (error) {
    return { legs: [], error: error instanceof Error ? error.message : "Invalid parlay selections." };
  }
};

const isAmericanOdds = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value !== 0;
const isFiniteLine = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNonemptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isTimestamp = (value: unknown): value is string => timestamp.safeParse(value).success;
const isParlayLeg = (value: unknown): value is ParlayLeg => {
  if (typeof value !== "object" || value === null) return false;
  const leg = value as Record<string, unknown>;
  const validMarket = leg.market === "spread" || leg.market === "total" || leg.market === "moneyline";
  const validSelection = leg.market === "total"
    ? leg.selection === "over" || leg.selection === "under"
    : leg.selection === "home" || leg.selection === "away";
  const proof = leg.canonicalOfferProof;
  if (typeof proof !== "object" || proof === null) return false;
  const canonicalOfferProof = proof as Record<string, unknown>;
  const validProof = isNonemptyString(canonicalOfferProof.offerId) && isNonemptyString(canonicalOfferProof.eventId)
    && isNonemptyString(canonicalOfferProof.offerVersion) && isNonemptyString(canonicalOfferProof.canonicalBook)
    && canonicalOfferProof.market === leg.market && canonicalOfferProof.selection === leg.selection
    && isAmericanOdds(canonicalOfferProof.odds) && (canonicalOfferProof.line === null || isFiniteLine(canonicalOfferProof.line));
  const validLine = leg.market === "moneyline" ? leg.originalLine === null : isFiniteLine(leg.originalLine);
  return isNonemptyString(leg.eventId) && (leg.league === "nfl" || leg.league === "ncaaf")
    && isNonemptyString(leg.canonicalBook) && isTimestamp(leg.retrievedAt) && isNonemptyString(leg.policyVersion)
    && isNonemptyString(leg.offerVersion) && isTimestamp(leg.eventStartsAt) && validMarket && validSelection
    && isAmericanOdds(leg.originalOdds) && validLine && leg.adjustedLine === null && validProof
    && canonicalOfferProof.eventId === leg.eventId && canonicalOfferProof.offerVersion === leg.offerVersion
    && canonicalOfferProof.canonicalBook === leg.canonicalBook && canonicalOfferProof.line === leg.originalLine
    && (leg.market === "moneyline" || canonicalOfferProof.odds === leg.originalOdds)
    && (leg.homeTeam === undefined || isNonemptyString(leg.homeTeam)) && (leg.awayTeam === undefined || isNonemptyString(leg.awayTeam));
};
const validParlaySlip = (value: unknown): value is ParlayLeg[] => {
  if (!Array.isArray(value) || !value.every(isParlayLeg)) return false;
  let legs: ParlayLeg[] = [];
  for (const leg of value) {
    const next = addParlayLeg(legs, leg);
    if (next.error) return false;
    legs = next.legs;
  }
  return true;
};
export const readParlaySlip = (slug: string): ParlayLeg[] => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key(slug)) ?? "[]");
    return validParlaySlip(parsed) ? parsed : [];
  } catch { return []; }
};
export const writeParlaySlip = (slug: string, legs: ParlayLeg[]) => sessionStorage.setItem(key(slug), JSON.stringify(legs));

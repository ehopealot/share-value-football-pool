import { validateParlay } from "../domain/parlay";
import { outcomeForSelection, type CanonicalSelection } from "./selection-matcher";
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
  homeTeam?: string;
  awayTeam?: string;
};
type Outcome = { price: number; point?: number };
const key = (slug: string) => `share-pool:parlay:${slug}`;

/** Builds complete unadjusted parlay semantics only from a canonical board offer. */
export const parlayLegForOutcome = (offer: Offer, outcome: Outcome, selection: ParlayLeg["selection"]): ParlayLeg => {
  const originalLine = offer.market === "moneyline" ? null : outcome.point ?? null;
  return {
    eventId: offer.eventId, league: offer.league, canonicalBook: offer.canonicalBook, retrievedAt: offer.retrievedAt, policyVersion: offer.policyVersion, offerVersion: offer.offerVersion,
    canonicalOfferProof: { offerId: `${offer.eventId}:${offer.market}:${selection}`, eventId: offer.eventId, offerVersion: offer.offerVersion, canonicalBook: offer.canonicalBook, market: offer.market, selection, odds: outcome.price, line: originalLine },
    market: offer.market, selection, originalLine, originalOdds: outcome.price, adjustedLine: null, eventStartsAt: offer.startsAt, homeTeam: offer.homeTeam, awayTeam: offer.awayTeam
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
    const selection = item.selection as CanonicalSelection;
    // resolveTrayItem establishes this selection against the offer; retain this explicit guard for untyped callers.
    if (!outcomeForSelection(resolved.offer, selection)) return { legs: [], error: "A selected parlay leg is no longer available on the board." };
    const next = addParlayLeg(legs, parlayLegForOutcome(resolved.offer, resolved.outcome, selection as ParlayLeg["selection"]));
    if (next.error) return { legs: [], error: next.error };
    legs = next.legs;
  }
  try {
    validateParlay(legs);
    return { legs, error: "" };
  } catch (error) {
    return { legs: [], error: error instanceof Error ? error.message : "Invalid parlay selections." };
  }
};

const isParlayLeg = (value: unknown): value is ParlayLeg => {
  if (typeof value !== "object" || value === null) return false;
  const leg = value as Record<string, unknown>;
  return typeof leg.eventId === "string" && (leg.market === "spread" || leg.market === "total" || leg.market === "moneyline")
    && (leg.selection === "home" || leg.selection === "away" || leg.selection === "over" || leg.selection === "under")
    && typeof leg.originalOdds === "number" && typeof leg.offerVersion === "string";
};
export const readParlaySlip = (slug: string): ParlayLeg[] => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key(slug)) ?? "[]");
    return Array.isArray(parsed) && parsed.every(isParlayLeg) ? parsed : [];
  } catch { return []; }
};
export const writeParlaySlip = (slug: string, legs: ParlayLeg[]) => sessionStorage.setItem(key(slug), JSON.stringify(legs));

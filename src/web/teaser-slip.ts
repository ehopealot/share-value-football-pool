import { adjustTeaserLine } from "../domain/grading";
import type { TeaserLeg as DomainTeaserLeg } from "../domain/types";
export type TeaserLeg = { eventId:string; league:"nfl"|"ncaaf"; canonicalBook:string; retrievedAt:string; policyVersion:string; offerVersion:string; canonicalOfferProof:any; market:"spread"|"total"; selection:"home"|"away"|"over"|"under"; originalLine:number; originalOdds:number; eventStartsAt:string; homeTeam?:string; awayTeam?:string; adjustedLine?:number };
type Offer = { eventId:string; league:"nfl"|"ncaaf"; canonicalBook:string; retrievedAt:string; policyVersion:string; offerVersion:string; startsAt:string; market:"spread"|"total"; homeTeam?:string; awayTeam?:string };
type Outcome = { price:number; point:number };
const key = (slug:string) => `share-pool:teaser:${slug}`;

/** Builds the complete client-held semantic identity only from a canonical board offer. */
export const teaserLegForOutcome = (offer: Offer, outcome: Outcome, selection: TeaserLeg["selection"]): TeaserLeg => ({
 eventId: offer.eventId, league: offer.league, canonicalBook: offer.canonicalBook, retrievedAt: offer.retrievedAt, policyVersion: offer.policyVersion, offerVersion: offer.offerVersion,
 canonicalOfferProof: { offerId: `${offer.eventId}:${offer.market}:${selection}`, eventId: offer.eventId, offerVersion: offer.offerVersion, canonicalBook: offer.canonicalBook, market: offer.market, selection, odds: outcome.price, line: outcome.point },
 market: offer.market, selection, originalLine: outcome.point, originalOdds: outcome.price, eventStartsAt: offer.startsAt, homeTeam: offer.homeTeam, awayTeam: offer.awayTeam
});

/** Adds one eligible semantic leg without allowing a duplicate, an opposite, or more than six new legs. */
export const addTeaserLeg = (legs: TeaserLeg[], leg: TeaserLeg): { legs: TeaserLeg[]; error: string } => {
 if (legs.length >= 6) return { legs, error: "Choose no more than six legs." };
 const identity = `${leg.eventId}:${leg.market}:${leg.selection}`;
 const opposite = `${leg.eventId}:${leg.market}:${leg.market === "spread" ? leg.selection === "home" ? "away" : "home" : leg.selection === "over" ? "under" : "over"}`;
 if (legs.some((candidate) => `${candidate.eventId}:${candidate.market}:${candidate.selection}` === identity)) return { legs, error: "Duplicate selections are not allowed." };
 if (legs.some((candidate) => `${candidate.eventId}:${candidate.market}:${candidate.selection}` === opposite)) return { legs, error: "Opposing selections are not allowed." };
 return { legs: [...legs, leg], error: "" };
};
export const readTeaserSlip = (slug:string): TeaserLeg[] => { try { return JSON.parse(sessionStorage.getItem(key(slug)) ?? "[]"); } catch { return []; } };
export const writeTeaserSlip = (slug:string, legs:TeaserLeg[]) => sessionStorage.setItem(key(slug), JSON.stringify(legs));
export const adjustedLine = (leg:TeaserLeg, points:number) => adjustTeaserLine({ eventId: leg.eventId, market: leg.market, selection: leg.selection, line: leg.originalLine } as DomainTeaserLeg, points as 6 | 6.5 | 7 | 7.5 | 10);
export const validateTeaser = (legs:TeaserLeg[], points:number) => {
 if (legs.length < 2 || legs.length > 6 || (points === 10 && legs.length !== 3)) return points === 10 ? "A 10-point teaser requires exactly three legs." : "Choose two to six legs.";
 const ids = new Set<string>(); for (const leg of legs) { const id=`${leg.eventId}:${leg.market}:${leg.selection}`; if(ids.has(id)) return "Duplicate selections are not allowed."; ids.add(id); const opposite=leg.market === "spread" ? `${leg.eventId}:spread:${leg.selection === "home" ? "away" : "home"}` : `${leg.eventId}:total:${leg.selection === "over" ? "under" : "over"}`; if(ids.has(opposite)) return "Opposing selections are not allowed."; }
 return "";
};

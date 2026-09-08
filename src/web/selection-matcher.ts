import { resolveCanonicalOutcomeSide, type CanonicalOutcomeSide, vigFreeMoneylinePrice } from "../odds/market-semantics";
import { moneylineStrikeIsAvailable } from "../odds/moneyline-policy";
import type { MarketName } from "../odds/types";

export type CanonicalSelection = CanonicalOutcomeSide;
type SelectionOffer<T extends { name?: string; price?: number } = { name?: string; price?: number }> = { market: MarketName; homeTeam?: string; awayTeam?: string; outcomes?: T[] };

/** Browser adapter for the one neutral canonical resolver; malformed identities remain unavailable. */
export function selectionForOutcome(offer: SelectionOffer, outcome: { name?: string }): CanonicalSelection | undefined {
  return resolveCanonicalOutcomeSide({ market: offer.market, homeTeam: offer.homeTeam ?? "", awayTeam: offer.awayTeam ?? "" }, outcome.name);
}

/** Lookup is unique, not first-match: contradictory board bytes can never choose by array order. */
export function outcomeForSelection<T extends { name?: string; price?: number }>(offer: SelectionOffer<T>, selection: CanonicalSelection): T | undefined {
  const matches = offer.outcomes?.filter((outcome) => selectionForOutcome(offer, outcome) === selection) ?? [];
  if (matches.length !== 1) return undefined;
  if (offer.market !== "moneyline") return matches[0];
  if (selection !== "home" && selection !== "away") return undefined;
  const pricedOutcomes = (offer.outcomes ?? []).filter((outcome): outcome is T & { price: number } => typeof outcome.price === "number");
  const strikeOdds = vigFreeMoneylinePrice({ homeTeam: offer.homeTeam ?? "", awayTeam: offer.awayTeam ?? "" }, pricedOutcomes, selection);
  return strikeOdds !== undefined && moneylineStrikeIsAvailable(strikeOdds) ? matches[0] : undefined;
}

/** Shapes only outcomes with a unique canonical side and an available strike for browser board controls. */
export function selectableOutcomes<T extends { name?: string; price?: number }>(offer: SelectionOffer<T>): T[] {
  return offer.outcomes?.filter((outcome) => {
    const side = selectionForOutcome(offer, outcome);
    return side !== undefined && outcomeForSelection(offer, side) === outcome;
  }) ?? [];
}

import { resolveCanonicalOutcomeSide, type CanonicalOutcomeSide } from "../odds/market-semantics";
import type { MarketName } from "../odds/types";

export type CanonicalSelection = CanonicalOutcomeSide;
type SelectionOffer<T extends { name?: string } = { name?: string }> = { market: MarketName; homeTeam?: string; awayTeam?: string; outcomes?: T[] };

/** Browser adapter for the one neutral canonical resolver; malformed identities remain unavailable. */
export function selectionForOutcome(offer: SelectionOffer, outcome: { name?: string }): CanonicalSelection | undefined {
  return resolveCanonicalOutcomeSide({ market: offer.market, homeTeam: offer.homeTeam ?? "", awayTeam: offer.awayTeam ?? "" }, outcome.name);
}

/** Lookup is unique, not first-match: contradictory board bytes can never choose by array order. */
export function outcomeForSelection<T extends { name?: string }>(offer: SelectionOffer<T>, selection: CanonicalSelection): T | undefined {
  const matches = offer.outcomes?.filter((outcome) => selectionForOutcome(offer, outcome) === selection) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

/** Shapes only outcomes with a unique canonical side for browser board controls. */
export function selectableOutcomes<T extends { name?: string }>(offer: SelectionOffer<T>): T[] {
  return offer.outcomes?.filter((outcome) => {
    const side = selectionForOutcome(offer, outcome);
    return side !== undefined && outcomeForSelection(offer, side) === outcome;
  }) ?? [];
}

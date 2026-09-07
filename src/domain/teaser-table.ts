export const SHARE_POOL_RULESET_ID = "SHARE_POOL_2026_V1" as const;
/**
 * Teaser pricing is versioned independently of the season and straight-wager rules, exactly like
 * the parlay ruleset. Tickets store the ruleset they accepted; settlement reprices each ticket
 * from its own table so accepted prices never change under a live operator repricing.
 */
export const TEASER_RULESET_ID = "TEASER_2026_V2" as const;
/** Tickets accepted while teasers used the season ruleset reprice from the legacy table forever. */
export const LEGACY_TEASER_RULESET_ID = SHARE_POOL_RULESET_ID;
export const TEASER_POINT_OPTIONS = Object.freeze([6, 6.5, 7, 7.5, 10] as const);
export const TEASER_LEG_COUNTS = Object.freeze([2, 3, 4, 5, 6, 7] as const);

export type TeaserPoints = (typeof TEASER_POINT_OPTIONS)[number];
type TeaserPayoutMatrix = Readonly<Partial<Record<number, Readonly<Partial<Record<TeaserPoints, number>>>>>>;

/** Operator card TEASER_2026_V2: two-leg bases -110/-120/-130/-150, three-leg 10-point -110. */
export const TEASER_PAYOUT_MATRIX: TeaserPayoutMatrix = Object.freeze({
  2: Object.freeze({ 6: -110, 6.5: -120, 7: -130, 7.5: -150 }),
  3: Object.freeze({ 6: 165, 6.5: 150, 7: 135, 7.5: 105, 10: -110 }),
  4: Object.freeze({ 6: 265, 6.5: 235, 7: 215, 7.5: 140 }),
  5: Object.freeze({ 6: 405, 6.5: 350, 7: 320, 7.5: 235 }),
  6: Object.freeze({ 6: 595, 6.5: 550, 7: 500, 7.5: 325 }),
  7: Object.freeze({ 6: 860, 6.5: 800, 7: 700, 7.5: 445 })
});

/** The original card accepted under the season ruleset; immutable once retired. */
export const LEGACY_TEASER_PAYOUT_MATRIX: TeaserPayoutMatrix = Object.freeze({
  2: Object.freeze({ 6: -120, 6.5: -130, 7: -140, 7.5: -160 }),
  3: Object.freeze({ 6: 150, 6.5: 135, 7: 120, 7.5: 105, 10: -120 }),
  4: Object.freeze({ 6: 235, 6.5: 215, 7: 200, 7.5: 140 }),
  5: Object.freeze({ 6: 350, 6.5: 320, 7: 300, 7.5: 235 }),
  6: Object.freeze({ 6: 550, 6.5: 500, 7: 475, 7.5: 325 }),
  7: Object.freeze({ 6: 800, 6.5: 700, 7: 600, 7.5: 445 })
});

/** Current-card price for placement validation and quoting; new tickets always price from it. */
export function teaserOdds(legs: number, points: TeaserPoints): number | undefined {
  return TEASER_PAYOUT_MATRIX[legs]?.[points];
}

/** Settlement reprices from the table the ticket's stored ruleset accepted; unknown rulesets refund-safety fails closed. */
export function teaserOddsForRuleset(rulesetVersion: string, legs: number, points: TeaserPoints): number | undefined {
  if (rulesetVersion === TEASER_RULESET_ID) return TEASER_PAYOUT_MATRIX[legs]?.[points];
  if (rulesetVersion === LEGACY_TEASER_RULESET_ID) return LEGACY_TEASER_PAYOUT_MATRIX[legs]?.[points];
  return undefined;
}

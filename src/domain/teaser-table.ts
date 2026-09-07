export const SHARE_POOL_RULESET_ID = "SHARE_POOL_2026_V1" as const;
/** Compatibility alias for teaser consumers; season and straight-wager rules use SHARE_POOL_RULESET_ID. */
export const TEASER_RULESET_ID = SHARE_POOL_RULESET_ID;
export const TEASER_POINT_OPTIONS = Object.freeze([6, 6.5, 7, 7.5, 10] as const);
export const TEASER_LEG_COUNTS = Object.freeze([2, 3, 4, 5, 6] as const);

export type TeaserPoints = (typeof TEASER_POINT_OPTIONS)[number];
type TeaserPayoutMatrix = Readonly<Partial<Record<number, Readonly<Partial<Record<TeaserPoints, number>>>>>>;

/** Operator card: two-leg bases -110/-120/-130/-150, three-leg 10-point -110, capped at six legs. */
export const TEASER_PAYOUT_MATRIX: TeaserPayoutMatrix = Object.freeze({
  2: Object.freeze({ 6: -110, 6.5: -120, 7: -130, 7.5: -150 }),
  3: Object.freeze({ 6: 165, 6.5: 150, 7: 135, 7.5: 105, 10: -110 }),
  4: Object.freeze({ 6: 265, 6.5: 235, 7: 215, 7.5: 140 }),
  5: Object.freeze({ 6: 405, 6.5: 350, 7: 320, 7.5: 235 }),
  6: Object.freeze({ 6: 595, 6.5: 550, 7: 500, 7.5: 325 })
});

/** The single authoritative card for quoting, placement, and settlement repricing. */
export function teaserOdds(legs: number, points: TeaserPoints): number | undefined {
  return TEASER_PAYOUT_MATRIX[legs]?.[points];
}

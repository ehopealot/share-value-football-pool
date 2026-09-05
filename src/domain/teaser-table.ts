export const SHARE_POOL_RULESET_ID = "SHARE_POOL_2026_V1" as const;
/** Compatibility alias for teaser consumers; season and straight-wager rules use SHARE_POOL_RULESET_ID. */
export const TEASER_RULESET_ID = SHARE_POOL_RULESET_ID;
export const TEASER_POINT_OPTIONS = Object.freeze([6, 6.5, 7, 7.5, 10] as const);
export const TEASER_LEG_COUNTS = Object.freeze([2, 3, 4, 5, 6, 7] as const);

export type TeaserPoints = (typeof TEASER_POINT_OPTIONS)[number];
export const TEASER_PAYOUT_MATRIX: Readonly<Partial<Record<number, Readonly<Partial<Record<TeaserPoints, number>>>>>> = Object.freeze({
  2: Object.freeze({ 6: -120, 6.5: -130, 7: -140, 7.5: -160 }),
  3: Object.freeze({ 6: 150, 6.5: 135, 7: 120, 7.5: 105, 10: -120 }),
  4: Object.freeze({ 6: 235, 6.5: 215, 7: 200, 7.5: 140 }),
  5: Object.freeze({ 6: 350, 6.5: 320, 7: 300, 7.5: 235 }),
  6: Object.freeze({ 6: 550, 6.5: 500, 7: 475, 7.5: 325 }),
  7: Object.freeze({ 6: 800, 6.5: 700, 7: 600, 7.5: 445 })
});

export function teaserOdds(legs: number, points: TeaserPoints): number | undefined {
  return TEASER_PAYOUT_MATRIX[legs]?.[points];
}

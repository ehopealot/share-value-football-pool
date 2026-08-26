export const TEASER_RULESET_ID = "SHARE_POOL_2026_V1" as const;

const table: Record<number, Partial<Record<6 | 6.5 | 7 | 7.5 | 10, number>>> = {
  2: { 6: -120, 6.5: -130, 7: -140, 7.5: -160 },
  3: { 6: 150, 6.5: 135, 7: 120, 7.5: 105, 10: -120 },
  4: { 6: 235, 6.5: 215, 7: 200, 7.5: 140 },
  5: { 6: 350, 6.5: 320, 7: 300, 7.5: 235 },
  6: { 6: 550, 6.5: 500, 7: 475, 7.5: 325 },
  7: { 6: 800, 6.5: 700, 7: 600, 7.5: 445 }
};

export type TeaserPoints = 6 | 6.5 | 7 | 7.5 | 10;
export function teaserOdds(legs: number, points: TeaserPoints): number | undefined {
  return table[legs]?.[points];
}

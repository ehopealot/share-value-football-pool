/** American odds are signed; positive prices must retain their explicit plus sign. */
export const formatAmericanOdds = (value: number): string => value > 0 ? `+${value}` : `${value}`;

/** Point spreads use the same signed presentation, while totals remain unsigned. */
export const formatSignedLine = (value: number): string => value > 0 ? `+${value}` : `${value}`;

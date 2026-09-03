/** American odds are signed; positive prices must retain their explicit plus sign. */
export const formatAmericanOdds = (value: number): string => value > 0 ? `+${value}` : `${value}`;

/** Local kickoff display shared by the odds board and wager tables. */
export const formatKickoff = (startsAt: string): string => new Date(startsAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Point spreads use the same signed presentation, while totals remain unsigned. */
export const formatSignedLine = (value: number): string => value > 0 ? `+${value}` : `${value}`;

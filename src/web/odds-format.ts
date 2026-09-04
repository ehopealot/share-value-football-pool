/** American odds are signed; positive prices must retain their explicit plus sign. */
export const formatAmericanOdds = (value: number): string => value > 0 ? `+${value}` : `${value}`;

/** Compact local kickoff display shared by the odds board and wager tables. */
export const formatKickoff = (startsAt: string): string => {
  const date = new Date(startsAt);
  const hour = date.getHours() % 12 || 12;
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}${date.getHours() >= 12 ? "p" : "a"}`;
};

/** Point spreads use the same signed presentation, while totals remain unsigned. */
export const formatSignedLine = (value: number): string => value > 0 ? `+${value}` : `${value}`;

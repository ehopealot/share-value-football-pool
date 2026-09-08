/** Moneyline strikes outside this inclusive American-odds range are not offered. */
export const MAXIMUM_MONEYLINE_ODDS = 1_200;

/** Limits apply to the vig-free strike used for a ticket, never to its raw book proof. */
export const moneylineStrikeIsAvailable = (odds: number): boolean =>
  Number.isSafeInteger(odds) && odds !== 0 && Math.abs(odds) <= MAXIMUM_MONEYLINE_ODDS;

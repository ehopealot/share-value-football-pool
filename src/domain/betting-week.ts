/** Weeks run Tuesday–Monday inclusive in Pacific Time; season Week 1 starts Tuesday 2026-08-25 at 00:00 PT. */
const PT_TIME_ZONE = "America/Los_Angeles";
const ptOffsetMs = (instant: Date): number => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: PT_TIME_ZONE, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)) - instant.getTime();
};
const ptMidnightUtc = (ptDate: string): number => { const wallClock = Date.parse(`${ptDate}T00:00:00Z`); return wallClock - ptOffsetMs(new Date(wallClock)); };

export const SEASON_WEEK1_ANCHOR = ptMidnightUtc("2026-08-25");
export function weekStartOf(date: Date): Date {
  const shifted = new Date(date.getTime() + ptOffsetMs(date));
  const daysSinceTuesday = (shifted.getUTCDay() + 5) % 7;
  shifted.setUTCDate(shifted.getUTCDate() - daysSinceTuesday);
  return new Date(ptMidnightUtc(shifted.toISOString().slice(0, 10)));
}
export function nextWeekStart(weekStart: Date): Date {
  const shifted = new Date(weekStart.getTime() + ptOffsetMs(weekStart));
  shifted.setUTCDate(shifted.getUTCDate() + 7);
  return new Date(ptMidnightUtc(shifted.toISOString().slice(0, 10)));
}
/** Betting opens Tuesday at 10am PT; week identities still turn over at midnight PT. */
export const bettingOpensAt = (date: Date): Date => new Date(weekStartOf(date).getTime() + 10 * 60 * 60 * 1000);
// US daylight-saving changes occur on Sundays, never between Tuesday midnight and 10am.
export const isBettingOpen = (date: Date): boolean => date.getTime() >= bettingOpensAt(date).getTime();
export const BETTING_CLOSED_MESSAGE = "Betting opens Tuesday at 10:00 a.m. PT. The betting week still ends Monday at midnight PT.";
export function assertBettingOpen(date: Date): void {
  if (!isBettingOpen(date)) throw new Error("BETTING_CLOSED");
}

/** Membership compares canonical Pacific week identities so daylight-saving weeks are calendar weeks. */
export const inWeek = (startsAt: string, weekStart: string): boolean => weekStartOf(new Date(startsAt)).toISOString() === weekStart;
export const weekNumberLabel = (weekStart: string): string => { const number = Math.floor((new Date(weekStart).getTime() - SEASON_WEEK1_ANCHOR) / (7 * 24 * 60 * 60 * 1000)) + 1; return number >= 1 ? `Week ${number}` : "Preseason"; };

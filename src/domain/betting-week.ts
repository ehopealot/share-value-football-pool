/** Weeks run Tuesday–Monday inclusive in Eastern Time; season Week 1 starts Tuesday 2026-08-25 at 00:00 ET. */
const ET_TIME_ZONE = "America/New_York";
const etOffsetMs = (instant: Date): number => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ET_TIME_ZONE, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)) - instant.getTime();
};
const etMidnightUtc = (etDate: string): number => { const wallClock = Date.parse(`${etDate}T00:00:00Z`); return wallClock - etOffsetMs(new Date(wallClock)); };

export const SEASON_WEEK1_ANCHOR = etMidnightUtc("2026-08-25");
export function weekStartOf(date: Date): Date {
  const shifted = new Date(date.getTime() + etOffsetMs(date));
  const daysSinceTuesday = (shifted.getUTCDay() + 5) % 7;
  shifted.setUTCDate(shifted.getUTCDate() - daysSinceTuesday);
  return new Date(etMidnightUtc(shifted.toISOString().slice(0, 10)));
}
export function nextWeekStart(weekStart: Date): Date {
  const shifted = new Date(weekStart.getTime() + etOffsetMs(weekStart));
  shifted.setUTCDate(shifted.getUTCDate() + 7);
  return new Date(etMidnightUtc(shifted.toISOString().slice(0, 10)));
}
/** Membership compares canonical Eastern week identities so daylight-saving weeks are calendar weeks. */
export const inWeek = (startsAt: string, weekStart: string): boolean => weekStartOf(new Date(startsAt)).toISOString() === weekStart;
export const weekNumberLabel = (weekStart: string): string => { const number = Math.floor((new Date(weekStart).getTime() - SEASON_WEEK1_ANCHOR) / (7 * 24 * 60 * 60 * 1000)) + 1; return number >= 1 ? `Week ${number}` : "Preseason"; };

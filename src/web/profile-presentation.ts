import type { ReadActivity } from "../contracts/http";
import { parseIntegerText } from "../domain/fixed-point";
import { nextWeekStart, SEASON_WEEK1_ANCHOR, weekStartOf } from "../domain/betting-week";

type Wager = ReadActivity["activity"]["wagers"][number];

export type PickRecord = { wins: number; losses: number; refunded: number };

/** Season pick record: each settled ticket counts as exactly one pick, so multis never add per-leg wins. */
export function pickRecord(wagers: Wager[]): PickRecord {
  const record: PickRecord = { wins: 0, losses: 0, refunded: 0 };
  for (const wager of wagers) {
    if (wager.status === "won") record.wins += 1;
    else if (wager.status === "lost") record.losses += 1;
    else if (wager.status === "refunded") record.refunded += 1;
  }
  return record;
}

export function formatPickRecord(record: PickRecord): string {
  const winsLosses = `${record.wins}-${record.losses}`;
  return record.refunded > 0 ? `${winsLosses} (${record.refunded} refunded)` : winsLosses;
}

/** Season P&L sums every settled ticket's performance; open tickets contribute zero. */
export function seasonPerformanceMicros(wagers: Wager[]): string {
  return wagers.reduce((total, wager) => total + parseIntegerText(wager.performanceMicros), 0n).toString();
}

/** A defensive ceiling so an absurd clock can neither spin enumeration nor flood the selector. */
const MAX_PROFILE_WEEKS = 80;
const PROFILE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Profile weeks list every season week from Week 1 through the current Eastern
 * week, plus any week carrying one of the member's bets (early tickets on
 * future-week games). Weeks are most-recent-first like the Activity selector.
 * A clock far past the season anchor keeps the most recent weeks, always
 * including the current week, instead of silently dropping it.
 */
export function profileWeekOptions(betWeeks: Iterable<string>, now: Date): string[] {
  const weeks = new Set(betWeeks);
  const currentWeek = weekStartOf(now);
  const anchor = weekStartOf(new Date(SEASON_WEEK1_ANCHOR));
  const elapsedWeeks = Math.floor((currentWeek.getTime() - anchor.getTime()) / PROFILE_WEEK_MS);
  // Half a week of slack before snapping absorbs DST drift so the skipped start lands
  // inside the intended Eastern calendar week, never the one before it.
  const firstWeek = weekStartOf(new Date(anchor.getTime() + Math.max(0, elapsedWeeks - MAX_PROFILE_WEEKS + 1) * PROFILE_WEEK_MS + PROFILE_WEEK_MS / 2));
  for (let week = firstWeek, guard = 0; week.getTime() <= currentWeek.getTime() && guard < MAX_PROFILE_WEEKS; week = nextWeekStart(week), guard += 1) weeks.add(week.toISOString());
  weeks.add(currentWeek.toISOString());
  return [...weeks].sort().reverse();
}

export type ProfileWeekWagers = { inProcess: Wager[]; settled: Wager[]; unstarted: Wager[] };

/** Unstarted tickets stay off profile pages for every viewer; the owner keeps My Bets. */
export function splitProfileWeekWagers(wagers: Wager[], now: Date): ProfileWeekWagers {
  const inProcess: Wager[] = [];
  const settled: Wager[] = [];
  const unstarted: Wager[] = [];
  for (const wager of wagers) {
    if (wager.status !== "open") settled.push(wager);
    else if ((wager.legs ?? []).some((leg) => Date.parse(leg.eventStartsAt) <= now.getTime())) inProcess.push(wager);
    else unstarted.push(wager);
  }
  return { inProcess, settled, unstarted };
}

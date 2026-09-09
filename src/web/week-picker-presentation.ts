export const ALL_WEEKS_VALUE = "all";

/** Adds the current week so an empty week remains reachable from wager views. */
export function wagerWeekOptions(wagerWeeks: Iterable<string>, currentWeek: string): string[] {
  return [...new Set([...wagerWeeks, currentWeek])].sort().reverse();
}

/** All weeks is the sole non-week option; stale selections reset to the current week. */
export function selectedWeekOrCurrent(selectedWeek: string, weeks: readonly string[], currentWeek: string): string | undefined {
  return selectedWeek === ALL_WEEKS_VALUE ? undefined : weeks.includes(selectedWeek) ? selectedWeek : currentWeek;
}

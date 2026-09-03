import type { ReadActivity } from "../contracts/http";
import { formatMicros, parseIntegerText } from "../domain/fixed-point";
import { sortWagersByStartTime } from "./wager-presentation";

type Wager = ReadActivity["activity"]["wagers"][number];
type Leg = NonNullable<Wager["legs"]>[number];

export type ActivityMemberWeek = { memberId: string; memberDisplayName: string; performanceMicros: string; wagers: Wager[] };
export type ActivityLegLine = { hidden: boolean; segments: Array<{ text: string; selected: boolean }> };

/** Groups safe activity records by the server-projected kickoff week and member. */
export function groupActivityMembersForWeek(wagers: Wager[], weekStart: string): ActivityMemberWeek[] {
  const groups = new Map<string, ActivityMemberWeek & { performance: bigint }>();
  for (const wager of wagers) {
    if (wager.weekStart !== weekStart) continue;
    const group = groups.get(wager.memberId) ?? { memberId: wager.memberId, memberDisplayName: wager.memberDisplayName, performanceMicros: "0", performance: 0n, wagers: [] };
    group.performance += parseIntegerText(wager.performanceMicros);
    group.wagers.push(wager);
    groups.set(wager.memberId, group);
  }
  return [...groups.values()].map(({ performance, ...group }) => ({ ...group, performanceMicros: performance.toString(), wagers: sortWagersByStartTime(group.wagers) }));
}

export function formatWeeklyPerformance(profitMicros: string): string {
  const value = parseIntegerText(profitMicros);
  return `${value > 0n ? "+" : ""}${formatMicros(value, 2)} shares`;
}

/** Zero is not a meaningful Activity result before or after a wager resolves. */
export function formatActivityPerformance(performanceMicros: string): string {
  return performanceMicros === "0" ? "" : formatWeeklyPerformance(performanceMicros);
}

export function formatActivityWagerPerformance(wager: Pick<Wager, "performanceMicros">): string {
  return formatActivityPerformance(wager.performanceMicros);
}

const signedLine = (line: string | undefined) => line && !line.startsWith("-") ? `+${line}` : line ?? "";
const teams = (leg: Leg) => ({ away: leg.awayTeam ?? "Away", home: leg.homeTeam ?? "Home" });

/** Returns text segments so Activity can emphasize only the selected side or total. */
export function formatActivityLeg(leg: Leg): ActivityLegLine {
  const { away, home } = teams(leg);
  const line = leg.adjustedLine ?? leg.originalLine;
  if (leg.market === "total") return { hidden: false, segments: [{ text: `${away} at ${home} `, selected: false }, { text: `${leg.selection === "over" ? "O" : "U"}${line ?? ""}`, selected: true }] };
  if (leg.selection === "away") return { hidden: false, segments: [{ text: `${away}${line === undefined ? "" : ` (${signedLine(line)})`}`, selected: true }, { text: ` at ${home}`, selected: false }] };
  return { hidden: false, segments: [{ text: `${away} at `, selected: false }, { text: `${home}${line === undefined ? "" : ` (${signedLine(line)})`}`, selected: true }] };
}

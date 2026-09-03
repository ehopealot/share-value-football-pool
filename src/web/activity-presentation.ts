import type { ReadActivity } from "../contracts/http";
import { formatMicros, parseIntegerText } from "../domain/fixed-point";
import { formatAmericanOdds } from "./odds-format";
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

type WagerOutcome = { status: string; outcome?: "won" | "lost" | "refunded" };

export function formatActivityWagerPerformance(wager: WagerOutcome & Pick<Wager, "performanceMicros">): string {
  return wager.performanceMicros === "0" && wager.outcome === "refunded" ? "0.00 shares" : formatActivityPerformance(wager.performanceMicros);
}

export function activityWagerPerformanceClass(wager: WagerOutcome): string {
  return wager.outcome === "won" ? "activity-performance-won" : wager.outcome === "lost" ? "activity-performance-lost" : "";
}

/** Public Activity terms are optional when a ticket must be redacted. */
export function formatActivityStake(wager: Pick<Wager, "riskMicros" | "acceptedOdds">): { amount: string; odds: string } | undefined {
  if (wager.riskMicros === undefined || wager.acceptedOdds === undefined) return undefined;
  return { amount: (parseIntegerText(wager.riskMicros) / 1_000_000n).toString(), odds: formatAmericanOdds(wager.acceptedOdds) };
}

/** Only settled wins and losses color the selected text; open and refunded tickets stay neutral. */
export function activitySelectedOutcomeClass(wager: WagerOutcome): string {
  return wager.outcome === "won" ? "activity-picked-won" : wager.outcome === "lost" ? "activity-picked-lost" : "";
}

/** The available feed has kickoff, but no live/finished game-state signal. */
export function activityLegTimingClass(leg: Pick<Leg, "eventStartsAt">, now = Date.now()): string {
  return Date.parse(leg.eventStartsAt) > now ? "activity-wager-not-started" : "";
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

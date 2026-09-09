import type { ReadActivity } from "../contracts/http";
import { formatMicros, MICROS_PER_UNIT, parseIntegerText } from "../domain/fixed-point";
import { formatAmericanOdds } from "./odds-format";
import { sortWagersByAnchorTime } from "./wager-presentation";
import { displayTeamName } from "./team-display";

type Wager = ReadActivity["activity"]["wagers"][number];
type Leg = NonNullable<Wager["legs"]>[number];

export type ActivityMemberWeek = { memberId: string; memberDisplayName: string; performanceMicros: string; wagers: Wager[] };
export type ActivityLegLine = { hidden: boolean; segments: Array<{ text: string; selected: boolean }> };

/** Groups safe activity records by member, optionally restricting them to one server-projected kickoff week. */
export function groupActivityMembers(wagers: Wager[], weekStart?: string): ActivityMemberWeek[] {
  const groups = new Map<string, ActivityMemberWeek & { performance: bigint }>();
  for (const wager of wagers) {
    if (weekStart !== undefined && wager.weekStart !== weekStart) continue;
    const group = groups.get(wager.memberId) ?? { memberId: wager.memberId, memberDisplayName: wager.memberDisplayName, performanceMicros: "0", performance: 0n, wagers: [] };
    group.performance += parseIntegerText(wager.performanceMicros);
    group.wagers.push(wager);
    groups.set(wager.memberId, group);
  }
  return [...groups.values()].sort((left, right) => left.memberDisplayName.localeCompare(right.memberDisplayName)).map(({ performance, ...group }) => ({ ...group, performanceMicros: performance.toString(), wagers: sortWagersByAnchorTime(group.wagers) }));
}

export function groupActivityMembersForWeek(wagers: Wager[], weekStart: string): ActivityMemberWeek[] {
  return groupActivityMembers(wagers, weekStart);
}

export function formatWeeklyPerformance(profitMicros: string): string {
  const value = parseIntegerText(profitMicros);
  return `${value > 0n ? "+" : ""}${formatMicros(value, 2)} shares`;
}

/** Member ribbons always show the weekly net, including an explicit signed zero. */
export function formatActivityPerformance(performanceMicros: string): string {
  return performanceMicros === "0" ? "+0.00 shares" : formatWeeklyPerformance(performanceMicros);
}

type WagerOutcome = { status: string; outcome?: "won" | "lost" | "refunded" };
const terminalOutcome = (wager: WagerOutcome) => wager.outcome ?? (wager.status === "won" || wager.status === "lost" || wager.status === "refunded" ? wager.status : undefined);

export function formatActivityWagerPerformance(wager: WagerOutcome & Pick<Wager, "performanceMicros">): string {
  if (wager.performanceMicros === "0") return terminalOutcome(wager) === "refunded" ? "0.00" : "";
  const value = parseIntegerText(wager.performanceMicros);
  return `${value > 0n ? "+" : ""}${formatMicros(value, 2)}`;
}

export function activityWagerPerformanceClass(wager: WagerOutcome): string {
  return terminalOutcome(wager) === "won" ? "activity-performance-won" : terminalOutcome(wager) === "lost" ? "activity-performance-lost" : terminalOutcome(wager) === "refunded" ? "activity-performance-refunded" : "";
}

/** Public Activity stakes may omit protected accepted odds. */
export function formatActivityStake(wager: Pick<Wager, "riskMicros" | "acceptedOdds">): { amount: string; odds?: string } | undefined {
  if (wager.riskMicros === undefined) return undefined;
  return { amount: (parseIntegerText(wager.riskMicros) / MICROS_PER_UNIT).toString(), ...(wager.acceptedOdds === undefined ? {} : { odds: formatAmericanOdds(wager.acceptedOdds) }) };
}

/** Keeps settled leg grades visually consistent across Activity and My Bets. */
export function activityLegGradeClass(grade: string | undefined): string {
  return grade === "win" ? "activity-leg-win" : grade === "loss" ? "activity-leg-loss" : grade === "push" ? "activity-leg-push" : "activity-leg-neutral";
}

/** Active matches the black/neutral legs already shown on Activity, excluding future owner-visible selections. */
export function hasActiveActivityGame(wager: Wager, now: number): boolean {
  return (wager.legs ?? []).some((leg) => activityLegGradeClass(leg.grade) === "activity-leg-neutral" && Date.parse(leg.eventStartsAt) <= now);
}

const signedLine = (line: string | undefined) => line && !line.startsWith("-") ? `+${line}` : line ?? "";
const teams = (leg: Leg) => ({ away: displayTeamName(leg.league, leg.awayTeam ?? "Away"), home: displayTeamName(leg.league, leg.homeTeam ?? "Home") });

/** Returns text segments so Activity can emphasize only the selected side or total. */
export function formatActivityLeg(leg: Leg): ActivityLegLine {
  const { away, home } = teams(leg);
  const line = leg.adjustedLine ?? leg.originalLine;
  if (leg.market === "total") return { hidden: false, segments: [{ text: `${away} at ${home} `, selected: false }, { text: `${leg.selection === "over" ? "O" : "U"}${line ?? ""}`, selected: true }] };
  if (leg.selection === "away") return { hidden: false, segments: [{ text: `${away}${line === undefined ? "" : ` (${signedLine(line)})`}`, selected: true }, { text: ` at ${home}`, selected: false }] };
  return { hidden: false, segments: [{ text: `${away} at `, selected: false }, { text: `${home}${line === undefined ? "" : ` (${signedLine(line)})`}`, selected: true }] };
}

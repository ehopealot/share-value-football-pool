import { teaserOdds, type TeaserPoints } from "./teaser-table";
import type { LegGrade, ScoreResult, TeaserLeg } from "./types";

/** Guards untyped boundary data in addition to the discriminated TeaserLeg type. */
function assertValidMarketSelection(leg: TeaserLeg): void {
  if (leg.market === "spread" && leg.selection !== "home" && leg.selection !== "away") throw new Error("Spread selection must be home or away.");
  if (leg.market === "total" && leg.selection !== "over" && leg.selection !== "under") throw new Error("Total selection must be over or under.");
  if (leg.market === "moneyline" && leg.selection !== "home" && leg.selection !== "away") throw new Error("Moneyline selection must be home or away.");
}

export function gradeLeg(leg: TeaserLeg, result: ScoreResult): LegGrade {
  assertValidMarketSelection(leg);
  if (result.status === "cancelled" || result.status === "no_contest") return "void";
  if (result.status === "postponed" && (!result.sameEventId || (result.hoursDelayed ?? Infinity) > 48)) return "void";
  if (result.status === "postponed") return "pending";
  const differential = result.home - result.away;
  if (leg.market === "moneyline") {
    if (differential === 0) return "void";
    return (leg.selection === "home") === (differential > 0) ? "win" : "loss";
  }
  if (leg.line === undefined) throw new Error("Spread and total legs require a line.");
  const value = leg.market === "spread"
    ? differential + (leg.selection === "home" ? leg.line : -leg.line)
    : result.home + result.away - leg.line;
  const favoredPositive = leg.market === "spread" ? leg.selection === "home" : leg.selection === "over";
  if (value === 0) return "push";
  return (value > 0) === favoredPositive ? "win" : "loss";
}

export function adjustTeaserLine(leg: TeaserLeg, points: TeaserPoints): number {
  assertValidMarketSelection(leg);
  if (leg.market === "moneyline") throw new Error("Moneylines cannot be teaser legs.");
  if (leg.market === "total") return leg.selection === "over" ? leg.line - points : leg.line + points;
  // Spread lines are stored from the selected team's perspective: both favorites
  // (toward zero) and underdogs (away from zero) receive positive teaser points.
  return leg.line + points;
}

export function validateTeaser(legs: TeaserLeg[], points: TeaserPoints): void {
  if (teaserOdds(legs.length, points) === undefined) throw new Error("The requested leg count is not available for this teaser size.");
  const exact = new Set<string>();
  const opposing = new Set<string>();
  for (const leg of legs) {
    assertValidMarketSelection(leg);
    if (!leg.eventId) throw new Error("Teaser legs require an event ID.");
    if (leg.market === "moneyline") throw new Error("Moneyline legs are not allowed in teasers.");
    const key = `${leg.eventId}:${leg.market}:${leg.selection}`;
    if (exact.has(key)) throw new Error("Duplicate teaser selection.");
    exact.add(key);
    const opposition = leg.market === "spread"
      ? `${leg.eventId}:spread:${leg.selection === "home" ? "away" : "home"}`
      : `${leg.eventId}:total:${leg.selection === "over" ? "under" : "over"}`;
    if (opposing.has(key) || exact.has(opposition)) throw new Error("Opposing teaser selections are not allowed.");
    opposing.add(opposition);
  }
}

export function gradeTeaser(grades: LegGrade[], points: TeaserPoints): { outcome: "win" | "loss" | "refund"; odds?: number; winningLegs: number } {
  const winningLegs = grades.filter((grade) => grade === "win").length;
  if (grades.includes("loss")) return { outcome: "loss", winningLegs };
  if (grades.includes("pending")) throw new Error("Cannot grade a teaser with a pending leg.");
  const odds = teaserOdds(winningLegs, points);
  return odds === undefined ? { outcome: "refund", winningLegs } : { outcome: "win", odds, winningLegs };
}

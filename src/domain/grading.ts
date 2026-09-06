import { teaserOdds, type TeaserPoints } from "./teaser-table";
import type { LegGrade, ScoreResult, TeaserLeg } from "./types";

/** Validates the selection pair for a typed/canonical market; callers must supply a supported market. */
function assertSelectionMatchesKnownMarket(leg: TeaserLeg): void {
  if (leg.market === "spread" && leg.selection !== "home" && leg.selection !== "away") throw new Error("Spread selection must be home or away.");
  if (leg.market === "total" && leg.selection !== "over" && leg.selection !== "under") throw new Error("Total selection must be over or under.");
  if (leg.market === "moneyline" && leg.selection !== "home" && leg.selection !== "away") throw new Error("Moneyline selection must be home or away.");
}

export function gradeLeg(leg: TeaserLeg, result: ScoreResult): LegGrade {
  assertSelectionMatchesKnownMarket(leg);
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
  assertSelectionMatchesKnownMarket(leg);
  if (leg.market === "moneyline") throw new Error("Moneylines cannot be teaser legs.");
  if (leg.market === "total") return leg.selection === "over" ? leg.line - points : leg.line + points;
  // Spread lines are stored from the selected team's perspective: both favorites
  // (toward zero) and underdogs (away from zero) receive positive teaser points.
  return leg.line + points;
}

type TeaserSelectionIdentity = { eventId?: string; market: "spread" | "total"; selection: "home" | "away" | "over" | "under" };

const teaserSelectionKey = (leg: TeaserSelectionIdentity) => `${leg.eventId}:${leg.market}:${leg.selection}`;

/** Shared duplicate/opposition policy; callers retain their own admission limits and error text. */
export function teaserSelectionConflict(existing: readonly TeaserSelectionIdentity[], candidate: TeaserSelectionIdentity): "duplicate" | "opposing" | undefined {
  const identity = teaserSelectionKey(candidate);
  if (existing.some((leg) => teaserSelectionKey(leg) === identity)) return "duplicate";
  const opposite = candidate.market === "spread"
    ? `${candidate.eventId}:spread:${candidate.selection === "home" ? "away" : "home"}`
    : `${candidate.eventId}:total:${candidate.selection === "over" ? "under" : "over"}`;
  return existing.some((leg) => teaserSelectionKey(leg) === opposite) ? "opposing" : undefined;
}

export function validateTeaser(legs: TeaserLeg[], points: TeaserPoints): void {
  if (teaserOdds(legs.length, points) === undefined) throw new Error("The requested leg count is not available for this teaser size.");
  const accepted: TeaserSelectionIdentity[] = [];
  for (const leg of legs) {
    assertSelectionMatchesKnownMarket(leg);
    if (!leg.eventId) throw new Error("Teaser legs require an event ID.");
    if (leg.market === "moneyline") throw new Error("Moneyline legs are not allowed in teasers.");
    const conflict = teaserSelectionConflict(accepted, leg);
    if (conflict === "duplicate") throw new Error("Duplicate teaser selection.");
    if (conflict === "opposing") throw new Error("Opposing teaser selections are not allowed.");
    accepted.push(leg);
  }
}

export function gradeTeaser(grades: LegGrade[], points: TeaserPoints): { outcome: "win" | "loss" | "refund"; odds?: number; winningLegs: number } {
  const winningLegs = grades.filter((grade) => grade === "win").length;
  if (grades.includes("loss")) return { outcome: "loss", winningLegs };
  if (grades.includes("pending")) throw new Error("Cannot grade a teaser with a pending leg.");
  const odds = teaserOdds(winningLegs, points);
  return odds === undefined ? { outcome: "refund", winningLegs } : { outcome: "win", odds, winningLegs };
}

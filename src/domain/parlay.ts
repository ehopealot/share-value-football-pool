import type { LegGrade, Market, Selection } from "./types";

export const PARLAY_RULESET_ID = "PARLAY_2026_V1" as const;
export const PARLAY_ODDS_OUT_OF_RANGE = "PARLAY_ODDS_OUT_OF_RANGE" as const;

/** The immutable pricing inputs retained on a parlay leg. */
export interface ParlayLeg {
  eventId: string;
  market: Market;
  selection: Selection;
  originalOdds: number;
}

export type ParlayGrade =
  | { outcome: "loss"; winningLegs: number }
  | { outcome: "refund"; winningLegs: 0 }
  | { outcome: "win"; odds: number; winningLegs: number };

type Fraction = { numerator: bigint; denominator: bigint };

const MAX_SAFE_ODDS = BigInt(Number.MAX_SAFE_INTEGER);

function oddsOutOfRange(): never {
  throw new Error(PARLAY_ODDS_OUT_OF_RANGE);
}

function assertSafeAmericanOdds(odds: number): void {
  if (!Number.isSafeInteger(odds) || odds === 0) oddsOutOfRange();
}

function assertValidSelection(leg: ParlayLeg): void {
  if (!leg || typeof leg.eventId !== "string" || !leg.eventId) throw new Error("Parlay legs require an event ID.");
  if (leg.market === "spread" || leg.market === "moneyline") {
    if (leg.selection !== "home" && leg.selection !== "away") throw new Error("Directional parlay legs require a home or away selection.");
  } else if (leg.market === "total") {
    if (leg.selection !== "over" && leg.selection !== "under") throw new Error("Total parlay legs require an over or under selection.");
  } else {
    throw new Error("Parlay legs require a supported market.");
  }
  assertSafeAmericanOdds(leg.originalOdds);
}

/** Validates the selection rules for a newly accepted 2–6 leg parlay. */
export function validateParlay(legs: readonly ParlayLeg[]): void {
  if (legs.length < 2 || legs.length > 6) throw new Error("Parlays require between 2 and 6 legs.");

  const selections = new Map<string, Selection>();
  const directionalMarkets = new Map<string, "spread" | "moneyline">();
  for (const leg of legs) {
    assertValidSelection(leg);
    const marketKey = `${leg.eventId}:${leg.market}`;
    const selected = selections.get(marketKey);
    if (selected === leg.selection) throw new Error("Duplicate parlay selection.");
    if (selected !== undefined) throw new Error("Opposing parlay selections are not allowed.");
    selections.set(marketKey, leg.selection);

    if (leg.market === "spread" || leg.market === "moneyline") {
      const existing = directionalMarkets.get(leg.eventId);
      if (existing !== undefined && existing !== leg.market) throw new Error("Only one directional market is allowed per event.");
      directionalMarkets.set(leg.eventId, leg.market);
    }
  }
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function reduce(numerator: bigint, denominator: bigint): Fraction {
  if (denominator <= 0n || numerator <= 0n) oddsOutOfRange();
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function multiply(left: Fraction, right: Fraction): Fraction {
  return reduce(left.numerator * right.numerator, left.denominator * right.denominator);
}

function americanMultiplier(odds: number): Fraction {
  assertSafeAmericanOdds(odds);
  const price = BigInt(odds);
  const absolute = price < 0n ? -price : price;
  return price > 0n
    ? reduce(absolute + 100n, 100n)
    : reduce(absolute + 100n, absolute);
}

function effectiveLegOdds(leg: ParlayLeg, legs: readonly ParlayLeg[]): number {
  if (leg.market === "spread") return 100;
  if (leg.market === "total") {
    return legs.some((candidate) => candidate.eventId === leg.eventId && (candidate.market === "spread" || candidate.market === "moneyline")) ? -133 : 100;
  }
  return leg.originalOdds;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function conservativeAmericanOdds(multiplier: Fraction): number {
  const { numerator, denominator } = multiplier;
  if (numerator <= denominator || denominator <= 0n) oddsOutOfRange();
  const profit = numerator - denominator;
  const american = numerator >= 2n * denominator
    ? (100n * profit) / denominator
    : -ceilDivide(100n * denominator, profit);
  if (american === 0n || american > MAX_SAFE_ODDS || american < -MAX_SAFE_ODDS) oddsOutOfRange();
  return Number(american);
}

function priceLegs(legs: readonly ParlayLeg[]): number {
  let multiplier: Fraction = { numerator: 1n, denominator: 1n };
  for (const leg of legs) multiplier = multiply(multiplier, americanMultiplier(effectiveLegOdds(leg, legs)));
  return conservativeAmericanOdds(multiplier);
}

/** Returns the authoritative accepted odds for a valid new parlay. */
export function parlayOdds(legs: readonly ParlayLeg[]): number {
  validateParlay(legs);
  return priceLegs(legs);
}

/** Grades immutable legs after final results, removing pushes and voids before repricing. */
export function gradeParlay(grades: readonly LegGrade[], legs: readonly ParlayLeg[]): ParlayGrade {
  validateParlay(legs);
  if (grades.length !== legs.length) throw new Error("Parlay grades must match leg count.");

  const winningLegs = legs.filter((_, index) => grades[index] === "win");
  if (grades.includes("loss")) return { outcome: "loss", winningLegs: winningLegs.length };
  if (grades.includes("pending")) throw new Error("Cannot grade a parlay with a pending leg.");
  if (winningLegs.length === 0) return { outcome: "refund", winningLegs: 0 };
  return { outcome: "win", odds: priceLegs(winningLegs), winningLegs: winningLegs.length };
}

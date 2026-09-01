import { CANONICAL_BOOK_POLICY_VERSION, canonicalBooks, type MarketName, type ProviderOutcome } from "./types";

export type CanonicalMarketContext = {
  market: MarketName;
  canonicalBook: string;
  policyVersion: unknown;
  homeTeam: string;
  awayTeam: string;
  outcomes: unknown;
};

/** Distinguishes a book without a complete market from a present market that contradicts canonical semantics. */
export class MarketSemanticError extends Error {
  constructor(readonly kind: "incomplete" | "invalid", message: string) {
    super(message);
    this.name = "MarketSemanticError";
  }
}

export type CanonicalOutcomeSide = "home" | "away" | "over" | "under";
export type OutcomeSideContext = Pick<CanonicalMarketContext, "market" | "homeTeam" | "awayTeam">;

/** Locale-fixed and punctuation-preserving team identity used for provider and market-side comparisons. */
export const canonicalTeamIdentity = (value: string): string => value.trim().toLocaleLowerCase("en-US");

const americanToProbability = (price: number): number | undefined => price > 0 ? 100 / (price + 100) : price < 0 ? (-price) / (-price + 100) : undefined;

/**
 * The vig-free (fair) moneyline price for one side: implied probability normalized
 * by the two-sided overround, rounded back to American odds. Returns nothing when
 * either side is missing or unpriceable, because a one-sided market has no fair line.
 */
export function vigFreeMoneylinePrice(context: Pick<CanonicalMarketContext, "homeTeam" | "awayTeam">, outcomes: ReadonlyArray<{ name?: string; price: number }>, selection: "home" | "away"): number | undefined {
  const priceFor = (side: "home" | "away") => {
    const matches = outcomes.filter((item) => resolveCanonicalOutcomeSide({ market: "moneyline", homeTeam: context.homeTeam, awayTeam: context.awayTeam }, item.name) === side);
    return matches.length === 1 ? matches[0]!.price : undefined;
  };
  const own = priceFor(selection); const other = priceFor(selection === "home" ? "away" : "home");
  const ownProbability = own === undefined ? undefined : americanToProbability(own); const otherProbability = other === undefined ? undefined : americanToProbability(other);
  if (ownProbability === undefined || otherProbability === undefined || ownProbability + otherProbability <= 0) return undefined;
  const fairProbability = ownProbability / (ownProbability + otherProbability);
  const decimal = 1 / fairProbability;
  return Math.round(decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1));
}

/** Locale-fixed and punctuation-preserving identity resolver used at every server/browser outcome boundary. */
export function resolveCanonicalOutcomeSide(context: OutcomeSideContext, outcomeName: unknown): CanonicalOutcomeSide | undefined {
  if (typeof outcomeName !== "string") return undefined;
  const name = canonicalTeamIdentity(outcomeName);
  const candidates: Array<{ side: CanonicalOutcomeSide; aliases: string[] }> = context.market === "total"
    ? [{ side: "over", aliases: ["over"] }, { side: "under", aliases: ["under"] }]
    : [{ side: "home", aliases: [canonicalTeamIdentity(context.homeTeam), "home"] }, { side: "away", aliases: [canonicalTeamIdentity(context.awayTeam), "away"] }];
  if (context.market !== "total" && canonicalTeamIdentity(context.homeTeam) === canonicalTeamIdentity(context.awayTeam)) return undefined;
  const matches = candidates.filter((candidate) => candidate.aliases.includes(name));
  return matches.length === 1 ? matches[0]!.side : undefined;
}

const exactKeys = (value: object, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

/** Side-effect-free semantic trust boundary shared by provider, Worker, placement, and browser contracts. */
export function validateCanonicalMarket(context: CanonicalMarketContext): { outcomes: ProviderOutcome[] } {
  const fail = (kind: "incomplete" | "invalid", message: string): never => { throw new MarketSemanticError(kind, message); };
  if (!canonicalBooks.includes(context.canonicalBook as typeof canonicalBooks[number])) fail("invalid", "Unconfigured canonical book");
  if (context.policyVersion !== CANONICAL_BOOK_POLICY_VERSION) fail("invalid", "Unknown canonical book policy");
  const candidates = context.outcomes;
  if (!Array.isArray(candidates)) throw new MarketSemanticError("invalid", "Outcomes must be an array");
  if (candidates.length < 2) fail("incomplete", "Canonical market is incomplete");
  if (candidates.length !== 2) fail("invalid", "Canonical market must contain exactly two outcomes");

  const expectedKeys = context.market === "moneyline" ? ["name", "price"] : ["name", "point", "price"];
  const outcomes: ProviderOutcome[] = candidates.map((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !exactKeys(candidate, expectedKeys)) fail("invalid", "Outcome fields are not canonical");
    const item = candidate as Record<string, unknown>;
    if (typeof item.name !== "string" || item.name.trim().length === 0) fail("invalid", "Outcome name is invalid");
    if (typeof item.price !== "number" || !Number.isSafeInteger(item.price) || item.price === 0) fail("invalid", "Outcome price is invalid");
    if (context.market !== "moneyline" && (typeof item.point !== "number" || !Number.isFinite(item.point))) fail("invalid", "Outcome point is invalid");
    return {
      name: item.name as string,
      price: item.price as number,
      ...(context.market === "moneyline" ? {} : { point: Object.is(item.point, -0) ? 0 : item.point as number })
    };
  });

  const sides = outcomes.map((item) => resolveCanonicalOutcomeSide(context, item.name));
  if (sides.some((side) => side === undefined)) fail("invalid", "Outcome is unrecognized or ambiguous");
  const expectedSides: CanonicalOutcomeSide[] = context.market === "total" ? ["over", "under"] : ["home", "away"];
  if (expectedSides.some((side) => sides.filter((candidate) => candidate === side).length !== 1)) fail("invalid", "Outcome counterparts are duplicated");

  const bySide = expectedSides.map((side) => outcomes[sides.indexOf(side)]!);
  const firstPoint = bySide[0]!.point;
  const secondPoint = bySide[1]!.point;
  if (context.market === "spread" && firstPoint !== -secondPoint!) fail("invalid", "Spread points must be exact additive opposites");
  if (context.market === "total" && firstPoint !== secondPoint) fail("invalid", "Total points must be identical");
  return { outcomes };
}

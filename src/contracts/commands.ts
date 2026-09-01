import { z } from "zod";
import { validateTeaser } from "../domain/grading";
import type { TeaserLeg } from "../domain/types";

export const canonicalIntegerText = z.string().regex(/^(?:0|-?[1-9]\d*)$/, "Expected canonical integer text.");
export const positiveCanonicalIntegerText = canonicalIntegerText.superRefine((value, ctx) => {
  // The regex above is the guard for BigInt: malformed text must be a normal
  // validation failure, not an exception escaping command handling.
  if (/^(?:0|-?[1-9]\d*)$/.test(value) && BigInt(value) <= 0n) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Amount must be positive." });
});
export const americanOdds = z.number().int().refine((value) => value !== 0, "American odds cannot be zero.");
export const timestamp = z.string().datetime();
export const quoteKey = z.string().min(1).max(128);
export const wagerId = z.string().min(1).max(128);
export const orderMode = z.enum(["shares", "value"]);
export const teaserPoints = z.union([z.literal(6), z.literal(6.5), z.literal(7), z.literal(7.5), z.literal(10)]);
/** Canonical correction evidence contains public event results only, never immutable wager selections. */
export const correctedEventResult = z.discriminatedUnion("status", [
  z.object({ eventId: z.string().min(1).max(128), league: z.enum(["nfl", "ncaaf"]), status: z.literal("final"), homeScore: z.number().int().nonnegative(), awayScore: z.number().int().nonnegative(), correctionVersion: z.string().min(1).max(500) }).strict(),
  z.object({ eventId: z.string().min(1).max(128), league: z.enum(["nfl", "ncaaf"]), status: z.enum(["cancelled", "no_contest"]), homeScore: z.null(), awayScore: z.null(), correctionVersion: z.string().min(1).max(500) }).strict()
]);
export type CorrectedEventResult = z.infer<typeof correctedEventResult>;

export const canonicalOfferProof = z.object({ offerId: z.string().min(1), eventId: z.string().min(1), offerVersion: z.string().min(1), canonicalBook: z.string().min(1), market: z.enum(["spread", "total", "moneyline"]), selection: z.enum(["home", "away", "over", "under"]), odds: americanOdds, line: z.number().finite().nullable() }).strict();
// Canonical accepted legs are complete records, not partial browser tickets. Lines are
// explicit: moneylines use null/null; straight spread/totals preserve the source line.
const commonLegShape = { eventId: z.string().min(1), league: z.enum(["nfl", "ncaaf"]), canonicalBook: z.string().min(1), retrievedAt: timestamp, policyVersion: z.string().min(1), offerVersion: z.string().min(1), canonicalOfferProof, market: z.enum(["spread", "total", "moneyline"]), selection: z.enum(["home", "away", "over", "under"]), originalLine: z.number().finite().nullable(), adjustedLine: z.number().finite().nullable(), originalOdds: americanOdds, eventStartsAt: timestamp, homeTeam: z.string().min(1), awayTeam: z.string().min(1) };
const proofIssues = (leg: z.infer<typeof canonicalLeg>, ctx: z.RefinementCtx) => {
  const p = leg.canonicalOfferProof;
  // Moneyline legs strike at the vig-free line while the proof attests the book price, so only the
  // non-moneyline legs require the proof odds to mirror the strike.
  if (p.eventId !== leg.eventId || p.offerVersion !== leg.offerVersion || p.canonicalBook !== leg.canonicalBook || p.market !== leg.market || p.selection !== leg.selection || (leg.market !== "moneyline" && p.odds !== leg.originalOdds) || p.line !== (leg.originalLine ?? null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "proof must mirror leg" });
};
const canonicalLeg = z.object(commonLegShape).strict();
export const straightLeg = canonicalLeg.superRefine((leg, ctx) => {
  proofIssues(leg, ctx);
  const selectionOK = leg.market === "total" ? leg.selection === "over" || leg.selection === "under" : leg.selection === "home" || leg.selection === "away";
  if (!selectionOK || (leg.market === "moneyline" ? (leg.originalLine !== null || leg.adjustedLine !== null) : (leg.originalLine === null || leg.adjustedLine !== leg.originalLine))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid straight leg terms" });
});
export const teaserLeg = (points: z.infer<typeof teaserPoints>) => canonicalLeg.superRefine((leg, ctx) => {
  proofIssues(leg, ctx);
  const selectionOK = leg.market === "spread" ? leg.selection === "home" || leg.selection === "away" : leg.market === "total" && (leg.selection === "over" || leg.selection === "under");
  if (!selectionOK || leg.originalLine === null || leg.adjustedLine === null || leg.market === "moneyline") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid teaser leg terms" });
  const adjusted = leg.adjustedLine;
  const expected = leg.market === "spread" ? leg.originalLine! + points : leg.selection === "over" ? leg.originalLine! - points : leg.originalLine! + points;
  if (adjusted !== expected) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid teaser adjustment" });
});
// Preserve a separately constructible complete leg with the adjustment required by teaser snapshots.
export const completeTeaserLeg = canonicalLeg.extend({ market: z.enum(["spread", "total"]), originalLine: z.number().finite(), adjustedLine: z.number().finite() }).strict();
export const straightQuoteRequestLeg = z.object({ eventId: z.string().min(1), canonicalBook: z.string().min(1), market: z.enum(["spread", "total", "moneyline"]), selection: z.enum(["home", "away", "over", "under"]), offerId: z.string().min(1), offerVersion: z.string().min(1) }).strict();
export const teaserQuoteRequestLeg = straightQuoteRequestLeg.extend({ market: z.enum(["spread", "total"]) }).strict();
export const quoteStraightSemantic = z.object({ wagerId, seasonId: z.string().min(1), riskMicros: positiveCanonicalIntegerText, rulesetVersion: z.string().min(1), leg: straightQuoteRequestLeg }).strict();
export const quoteTeaserSemanticBase = z.object({ wagerId, seasonId: z.string().min(1), riskMicros: positiveCanonicalIntegerText, teaserPoints, rulesetVersion: z.string().min(1), legs: z.array(teaserQuoteRequestLeg).min(2).max(7) }).strict();
export const teaserSemanticIssues = (v: { teaserPoints: z.infer<typeof teaserPoints>; legs: Array<{ eventId: string; market: "spread" | "total"; selection: "home" | "away" | "over" | "under" }> }, ctx: z.RefinementCtx) => {
  if (v.teaserPoints === 10 && v.legs.length !== 3) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "10-point teasers require exactly three legs" });
  try {
    validateTeaser(v.legs.map((leg) => ({ eventId: leg.eventId, market: leg.market, selection: leg.selection, line: 0 } as TeaserLeg)), v.teaserPoints);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["legs"], message: error instanceof Error ? error.message : "invalid teaser selections" });
  }
};
export const quoteTeaserSemantic = quoteTeaserSemanticBase.superRefine(teaserSemanticIssues);
export const quoteIdentity = z.object({ actorId: z.string().min(1), quoteKey, fingerprint: z.string().min(1) }).strict();
const straightWagerQuoteSnapshotBase = z.object({ quoteKey, seasonId: z.string().min(1), ownerMemberId: z.string().min(1), riskMicros: positiveCanonicalIntegerText, acceptedOdds: americanOdds, rulesetVersion: z.string().min(1), leg: straightLeg, commandVersion: canonicalIntegerText }).strict();
export const straightWagerQuoteSnapshot = straightWagerQuoteSnapshotBase;
const teaserWagerQuoteSnapshotBase = z.object({ quoteKey, seasonId: z.string().min(1), ownerMemberId: z.string().min(1), riskMicros: positiveCanonicalIntegerText, acceptedOdds: americanOdds, teaserPoints, rulesetVersion: z.string().min(1), legs: z.array(completeTeaserLeg).min(2).max(7), commandVersion: canonicalIntegerText }).strict();
const teaserSnapshotIssues = (v: z.infer<typeof teaserWagerQuoteSnapshotBase>, ctx: z.RefinementCtx) => {
  v.legs.forEach((leg, i) => {
    if (!teaserLeg(v.teaserPoints).safeParse(leg).success) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["legs", i], message: "invalid teaser leg" });
  });
  teaserSemanticIssues(v, ctx);
};
export const teaserWagerQuoteSnapshot = teaserWagerQuoteSnapshotBase.superRefine(teaserSnapshotIssues);
export const shareOrderQuoteSnapshot = z.object({ seasonId: z.string().min(1), memberId: z.string().min(1), mode: orderMode, amountMicros: positiveCanonicalIntegerText, sharesMicros: canonicalIntegerText, valueMicros: canonicalIntegerText, priceMicros: canonicalIntegerText, commandVersion: canonicalIntegerText }).strict();
/** Trusted Worker-to-PoolDO projections contain every canonical placement term. */
export const canonicalStraightQuoteProjection = straightWagerQuoteSnapshotBase.extend({ wagerId, actorId: z.string().min(1), fingerprint: z.string().min(1) }).strict();
export const canonicalTeaserQuoteProjection = teaserWagerQuoteSnapshotBase.extend({ wagerId, actorId: z.string().min(1), fingerprint: z.string().min(1) }).strict().superRefine(teaserSnapshotIssues);
export const placeStraightWager = straightWagerQuoteSnapshotBase.omit({ ownerMemberId: true, quoteKey: true, commandVersion: true }).extend({ type: z.literal("PlaceStraightWager"), commandId: z.string().min(1), actorId: z.string().min(1), wagerId, quoteKey, quotedCommandVersion: canonicalIntegerText }).strict();
export const placeTeaserWagerShape = teaserWagerQuoteSnapshotBase.omit({ ownerMemberId: true, quoteKey: true, commandVersion: true }).extend({ type: z.literal("PlaceTeaserWager"), commandId: z.string().min(1), actorId: z.string().min(1), wagerId, quoteKey, quotedCommandVersion: canonicalIntegerText }).strict();
export const placeTeaserWager = placeTeaserWagerShape.superRefine((value, ctx) => {
  value.legs.forEach((leg, index) => {
    if (!teaserLeg(value.teaserPoints).safeParse(leg).success) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["legs", index], message: "invalid teaser leg" });
  });
  teaserSemanticIssues(value, ctx);
});
export type PlaceStraightWager = z.infer<typeof placeStraightWager>;
export type PlaceTeaserWager = z.infer<typeof placeTeaserWager>;

export const shareOrderQuote = z.object({ priceMicros: canonicalIntegerText, commandVersion: canonicalIntegerText });
export const quoteShareOrderCommand = z.object({ commandId: z.string().min(1), actorId: z.string().min(1), seasonId: z.string().min(1), memberId: z.string().min(1) });
export const executeShareOrderCommand = quoteShareOrderCommand.extend({ mode: orderMode, amountMicros: positiveCanonicalIntegerText, quote: shareOrderQuote, reason: z.string().trim().min(1).max(500) });
export const reverseShareOrderCommand = z.object({ commandId: z.string().min(1), actorId: z.string().min(1), orderId: z.string().min(1), reason: z.string().trim().min(1).max(500) });
export const commandEnvelope = z.object({ commandId: z.string().min(1), actorId: z.string().min(1), type: z.string().min(1), payload: z.unknown() });
export type CommandEnvelope = z.infer<typeof commandEnvelope>;
export const idempotencyConflict = "IDEMPOTENCY_CONFLICT" as const;

/** Service-only settlement is deliberately not an HTTP/browser command envelope. */
export const internalSettlementCommand = z.object({ poolId: z.string().min(1), serviceToken: z.string().min(1) });
const eventEnvelope = { eventId: z.string().min(1), version: canonicalIntegerText };
const commandEventBase = z.object({ poolId: z.string().min(1), actorId: z.string().min(1), commandId: z.string().min(1) });
const commandEventPayload = z.discriminatedUnion("commandType", [
  commandEventBase.extend({ commandType: z.literal("InitializePool"), memberId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("JoinPool"), memberId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("UpdatePoolSettings") }).strict(), commandEventBase.extend({ commandType: z.literal("CreateSeason"), seasonId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("OpenSeason"), seasonId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("CloseSeason"), seasonId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("ConfirmSuperBowl"), seasonId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("ExecuteShareOrder"), seasonId: z.string().min(1), memberId: z.string().min(1), orderId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("ReverseShareOrder"), seasonId: z.string().min(1), memberId: z.string().min(1), orderId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("SuspendMember"), memberId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("RestoreMember"), memberId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("TransferCommissioner"), memberId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("VoidWager"), wagerId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("RegradeWager"), wagerId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("CreateSeasonAnnotation"), seasonId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("PlaceStraightWager"), seasonId: z.string().min(1), memberId: z.string().min(1), wagerId: z.string().min(1) }).strict(), commandEventBase.extend({ commandType: z.literal("PlaceTeaserWager"), seasonId: z.string().min(1), memberId: z.string().min(1), wagerId: z.string().min(1) }).strict()
]);
const settlementEventPayload = z.object({ poolId: z.string().min(1), seasonId: z.string().min(1), memberId: z.string().min(1), wagerId: z.string().min(1), resultIdentity: z.array(z.object({ eventId: z.string().min(1), correctionVersion: z.string().min(1) })).min(1), priorResultVersion: z.string().min(1).optional() }).strict();
const closureEventPayload = z.object({ poolId: z.string().min(1), seasonId: z.string().min(1), closeReason: z.enum(["float_exhausted", "super_bowl_final", "commissioner_closed"]) }).strict();
export const poolOutboxMessage = z.discriminatedUnion("eventType", [z.object({ ...eventEnvelope, eventType: z.literal("CommandApplied"), payload: commandEventPayload }), z.object({ ...eventEnvelope, eventType: z.literal("SettlementApplied"), payload: settlementEventPayload }), z.object({ ...eventEnvelope, eventType: z.literal("SettlementRegraded"), payload: settlementEventPayload.extend({ priorResultVersion: z.string().min(1) }) }), z.object({ ...eventEnvelope, eventType: z.literal("SeasonClosed"), payload: closureEventPayload })]);
export type PoolOutboxMessage = z.infer<typeof poolOutboxMessage>;

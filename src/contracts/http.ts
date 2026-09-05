import { z } from "zod";
import { validateCanonicalMarket } from "../odds/market-semantics";
import { americanOdds, canonicalIntegerText, positiveCanonicalIntegerText, quoteKey, wagerId, teaserPoints, quoteStraightSemantic, quoteTeaserSemanticBase, teaserSemanticIssues, quoteParlaySemanticBase, parlaySemanticIssues, straightWagerQuoteSnapshot, teaserWagerQuoteSnapshot, parlayWagerQuoteSnapshot, shareOrderQuoteSnapshot, placeStraightWager, placeTeaserWager, placeTeaserWagerShape, placeParlayWager, placeParlayWagerShape, correctedEventResult } from "./commands";

export const idempotencyKey = z.string().min(1).max(128);
const password = z.string().min(8).max(256);
const turnstileToken = z.string().min(1).optional();

/** Live browser request contracts for the authenticated pool HTTP boundary. */
export const createPoolRequest = z.object({
  slug: z.string().min(3).max(64),
  poolName: z.string().trim().min(1).max(100),
  creatorName: z.string().trim().min(1).max(100).optional(),
  password,
  idempotencyKey,
  turnstileToken
});
export const joinPoolRequest = z.object({ displayName: z.string().trim().min(1).max(100).optional(), password, idempotencyKey, turnstileToken });
export const updateMemberNicknameRequest = z.object({ displayName: z.string().trim().min(1).max(100), idempotencyKey });
const commissionerNotice = z.string().trim().min(1).max(500);
export const updatePoolSettingsRequest = z.object({ poolName: z.string().trim().min(1).max(100).optional(), password: password.optional(), signupsOpen: z.boolean().optional(), maxSideBet: z.string().regex(/^[1-9]\d*$/).optional(), commissionerNotice: commissionerNotice.nullable().optional(), idempotencyKey }).strict().refine((body) => body.poolName !== undefined || body.password !== undefined || body.signupsOpen !== undefined || body.maxSideBet !== undefined || body.commissionerNotice !== undefined, "At least one setting is required.");
export const createSeasonRequest = z.object({ seasonId: z.string().min(1).max(128), label: z.string().trim().min(1).max(100), defaultOrder: z.object({ mode: z.enum(["shares", "value"]), amountMicros: z.string().regex(/^[1-9]\d*$/) }).optional(), idempotencyKey });
export const seasonCommandRequest = z.object({ idempotencyKey, reason: z.string().trim().min(1).max(500).optional() });
const auditReason = z.string().trim().min(1).max(500);
export const reverseShareOrderRequest = z.object({ idempotencyKey, reason: auditReason });
export const transferCommissionerRequest = z.object({ memberId: z.string().min(1).max(128), idempotencyKey, reason: auditReason });
export const memberStatusRequest = z.object({ idempotencyKey });
export const voidWagerRequest = z.object({ idempotencyKey, reason: auditReason });
export const regradeWagerRequest = z.object({ idempotencyKey, reason: auditReason, correctedResults: z.array(correctedEventResult).min(1).max(7) }).strict();
export const seasonAnnotationRequest = z.object({ idempotencyKey, text: z.string().trim().min(1).max(2000) });
export const shareOrderQuoteRequest = z.object({ seasonId: z.string().min(1).max(128), memberId: z.string().min(1).max(128), mode: z.enum(["shares", "value"]), amountMicros: z.string().regex(/^[1-9]\d*$/), idempotencyKey });
export const executeShareOrderRequest = shareOrderQuoteRequest.extend({ mode: z.enum(["shares", "value"]), amountMicros: z.string().regex(/^[1-9]\d*$/), quote: z.object({ priceMicros: z.string().regex(/^(?:0|[1-9]\d*)$/), commandVersion: z.string().regex(/^(?:0|[1-9]\d*)$/) }), reason: z.string().trim().min(1).max(500) });
/** A board read changes only the caller's durable HWM, so it still needs a strict POST body. */
export const messageBoardReadRequest = z.object({}).strict();
export const messageBoardMutationRequest = z.object({ text: z.string().trim().min(1).max(1000), idempotencyKey }).strict();
/** Announcement is a top-level-post capability, never a reply field. */
export const messageBoardPostRequest = messageBoardMutationRequest.extend({ announcement: z.boolean().default(false) }).strict();

/** Browser quote inputs are independently constructible semantic requests: no accepted terms or command version. */
export const straightWagerQuoteRequest = quoteStraightSemantic.extend({ quoteKey, commandId: quoteKey }).strict().superRefine((value, ctx) => { if (value.quoteKey !== value.commandId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quoteKey must equal commandId" }); });
// Compose the semantic fields and quote identity in one strict object. Intersecting two
// strict objects rejects the fields owned by the other side.
export const teaserWagerQuoteRequest = quoteTeaserSemanticBase.extend({ quoteKey, commandId: quoteKey }).strict().superRefine((value, ctx) => {
  teaserSemanticIssues(value, ctx);
  if (value.quoteKey !== value.commandId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quoteKey must equal commandId" });
});
export const parlayWagerQuoteRequest = quoteParlaySemanticBase.extend({ quoteKey, commandId: quoteKey }).strict().superRefine((value, ctx) => {
  parlaySemanticIssues(value, ctx);
  if (value.quoteKey !== value.commandId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quoteKey must equal commandId" });
});
/** Complete response and placement schemas are parsed at the HTTP/UI boundary. */
export { straightWagerQuoteSnapshot, teaserWagerQuoteSnapshot, parlayWagerQuoteSnapshot, shareOrderQuoteSnapshot, placeStraightWager, placeTeaserWager, placeParlayWager };
export const straightWagerPlacementRequest = placeStraightWager.omit({ actorId: true, type: true }).extend({ mutationKey: z.string().min(1) }).strict().superRefine((value, ctx) => { if (value.commandId !== value.mutationKey) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mutationKey must equal commandId" }); });
export const teaserWagerPlacementRequest = placeTeaserWagerShape.omit({ actorId: true, type: true }).extend({ mutationKey: z.string().min(1) }).strict().superRefine((value, ctx) => {
  if (value.commandId !== value.mutationKey) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mutationKey must equal commandId" });
  const { mutationKey: _mutationKey, ...placement } = value;
  if (!placeTeaserWager.safeParse({ ...placement, actorId: "http", type: "PlaceTeaserWager" }).success) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["legs"], message: "invalid teaser placement" });
});
export const parlayWagerPlacementRequest = placeParlayWagerShape.omit({ actorId: true, type: true }).extend({ mutationKey: z.string().min(1) }).strict().superRefine((value, ctx) => {
  if (value.commandId !== value.mutationKey) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mutationKey must equal commandId" });
  const { mutationKey: _mutationKey, ...placement } = value;
  if (!placeParlayWager.safeParse({ ...placement, actorId: "http", type: "PlaceParlayWager" }).success) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["legs"], message: "invalid parlay placement" });
});
/** @deprecated Compatibility aliases; in-repository code should use the placement request names. */
export const straightWagerRequest = straightWagerPlacementRequest;
export const teaserWagerRequest = teaserWagerPlacementRequest;

/** Member-only lifecycle snapshot. Readers must parse this exact shape rather than infer state from legacy fields. */
export const decimalString = z.string().regex(/^(?:0|-?[1-9]\d*)$/);
export const seasonSummary = z.object({
  id: z.string().min(1), label: z.string().min(1), rulesetVersion: z.string().min(1), state: z.enum(["draft", "active"]),
  createdAt: z.string().datetime(), openedAt: z.string().datetime().nullable(), closedAt: z.null(),
  defaultOrderMode: z.enum(["shares", "value"]).nullable(), defaultOrderAmountMicros: decimalString.nullable(),
  floatMicros: decimalString, notionalValueMicros: decimalString,
  superBowlCandidate: z.object({ eventId: z.string().min(1), providerEventName: z.string().min(1), confirmedAt: z.string().datetime().nullable() }).strict().nullable().optional()
}).strict();
export const closedSeasonSummary = seasonSummary.extend({ state: z.literal("closed"), closedAt: z.string().datetime(), closeReason: z.string().nullable() }).strict();
export const seasonBalance = z.object({ seasonId: z.string().min(1), availableMicros: decimalString, lockedMicros: decimalString }).strict();
export const shareOrderSummary = z.object({ orderId: z.string().min(1), memberId: z.string().min(1), mode: z.enum(["shares", "value"]), requestedMicros: decimalString, sharesMicros: decimalString, valueMicros: decimalString, priceMicros: decimalString, reversalOf: z.string().min(1).nullable(), reason: z.string(), createdAt: z.string().datetime() }).strict();
export const seasonOrders = z.object({ seasonId: z.string().min(1), orders: z.array(shareOrderSummary) }).strict();
export const memberDirectoryEntry = z.object({ memberId: z.string().min(1), displayName: z.string().min(1), role: z.enum(["commissioner", "member"]), status: z.enum(["active", "suspended"]) }).strict();
export const ReadPoolView = z.object({
  commandVersion: decimalString,
  pool: z.object({ poolId: z.string().min(1), slug: z.string().min(1), name: z.string().min(1), commissionerId: z.string().min(1), signupsOpen: z.boolean(), maxSideBetMicros: positiveCanonicalIntegerText, commissionerNotice: commissionerNotice.nullable() }).strict(),
  activeSeason: seasonSummary.nullable(), nextDraftSeason: seasonSummary.nullable(), latestClosedSeason: closedSeasonSummary.nullable(),
  currentMember: z.object({ memberId: z.string().min(1), role: z.enum(["commissioner", "member"]), seasonBalances: z.array(seasonBalance), hasUnreadBoard: z.boolean() }).strict(),
  members: z.array(memberDirectoryEntry), commissioner: z.object({ seasonOrders: z.array(seasonOrders) }).strict().nullable()
}).strict();
export type ReadPoolView = z.infer<typeof ReadPoolView>;

const messageBoardReply = z.object({
  replyId: z.string().min(1), authorDisplayName: z.string().min(1), text: z.string().min(1), createdAt: z.string().datetime()
}).strict();
const messageBoardThread = z.object({
  postId: z.string().min(1), authorDisplayName: z.string().min(1), text: z.string().min(1), createdAt: z.string().datetime(), activityAt: z.string().datetime(), isAnnouncement: z.boolean(), replies: z.array(messageBoardReply)
}).strict();
/** Exact member-visible board snapshot; its read operation atomically advances a durable HWM. */
export const ReadMessageBoardResponse = z.object({ commandVersion: decimalString, canAnnounce: z.boolean(), threads: z.array(messageBoardThread) }).strict();
/** Replies intentionally expose only their committed authority version. */
export const MessageBoardMutationResponse = z.object({ commandVersion: decimalString }).strict();
/** A top-level post returns its durable identity so the Worker can schedule one best-effort announcement blast. */
export const MessageBoardPostResponse = z.object({ commandVersion: decimalString, postId: z.string().min(1).optional(), isAnnouncement: z.boolean(), replayed: z.boolean() }).strict().superRefine((response, ctx) => {
  if (response.postId === undefined && (!response.replayed || response.isAnnouncement)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["postId"], message: "Only a legacy ordinary replay may omit a post identity." });
});
export type ReadMessageBoardResponse = z.infer<typeof ReadMessageBoardResponse>;
export type MessageBoardMutationResponse = z.infer<typeof MessageBoardMutationResponse>;
export type MessageBoardPostResponse = z.infer<typeof MessageBoardPostResponse>;

/** Exact authenticated odds-board response. Poll observations are stored provider facts, never inferred from offer timestamps. */
export const OddsBoardResponse = z.object({
  offers: z.array(z.object({
    eventId: z.string().min(1), league: z.enum(["nfl", "ncaaf"]), homeTeam: z.string().min(1), awayTeam: z.string().min(1), startsAt: z.string().datetime(),
    market: z.enum(["spread", "total", "moneyline"]), canonicalBook: z.string().min(1), retrievedAt: z.string().datetime(), offerVersion: z.string().min(1), policyVersion: z.literal("CANONICAL_BOOKS_2026_V1"),
    outcomes: z.array(z.object({ name: z.string().trim().min(1), price: z.number().int().refine((price) => price !== 0), point: z.number().finite().optional() }).strict()).min(1)
  }).strict()),
  feed: z.object({ status: z.enum(["current", "stale", "provider-error", "no-offer"]), message: z.string().min(1), lastPolledAt: z.string().datetime().nullable(), lastSuccessAt: z.string().datetime().nullable() }).strict()
}).strict().superRefine((board, ctx) => {
  if ((board.feed.status === "current") !== (board.offers.length > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["offers"], message: "Only a current board may expose reviewable offers." });
  board.offers.forEach((offer, index) => {
    try {
      validateCanonicalMarket({ market: offer.market, canonicalBook: offer.canonicalBook, policyVersion: offer.policyVersion, homeTeam: offer.homeTeam, awayTeam: offer.awayTeam, outcomes: offer.outcomes });
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["offers", index, "outcomes"], message: "Offer counterpart semantics are invalid." });
    }
  });
});
export type OddsBoardResponse = z.infer<typeof OddsBoardResponse>;

const wagerType = z.enum(["straight", "teaser", "parlay"]);
const wagerStatus = z.enum(["open", "won", "lost", "refunded"]);
const settledOdds = z.number().int().safe().refine((odds) => odds !== 0);
const wagerLeg = z.object({ eventId: z.string(), league: z.string(), canonicalBook: z.string(), retrievedAt: z.string().datetime(), policyVersion: z.string(), offerVersion: z.string(), market: z.string(), selection: z.string(), originalLine: z.string().optional(), originalOdds: z.number(), teaserAdjustment: z.string().optional(), adjustedLine: z.string().optional(), eventStartsAt: z.string().datetime(), homeTeam: z.string().optional(), awayTeam: z.string().optional(), grade: z.string().optional(), resultVersion: z.string().optional() });
const ownerWagerLeg = wagerLeg.strict();
const activityWagerLeg = wagerLeg.strict();

/** Authoritative member reads use canonical accounting text and may omit protected ticket fields. */
export const memberWager = z.object({
  wagerId: z.string().min(1), seasonId: z.string().min(1), memberId: z.string().min(1), memberDisplayName: z.string().min(1), type: wagerType, status: wagerStatus, confirmedAt: z.string().datetime(), weekStart: z.string().datetime(), performanceMicros: decimalString,
  riskMicros: decimalString.optional(), acceptedOdds: z.number().int().optional(), rulesetVersion: z.string().optional(), outcome: z.enum(["won", "lost", "refunded"]).optional(), returnMicros: decimalString.optional(), profitMicros: decimalString.optional(), settledOdds: settledOdds.nullable().optional(), settledAt: z.string().datetime().optional(),
  legs: z.array(wagerLeg).optional()
});

const activityWager = memberWager.extend({ legs: z.array(activityWagerLeg).optional(), hiddenLegCount: z.number().int().positive().optional() }).strict();

const ownerWagerBase = z.object({
  wagerId: z.string().min(1), seasonId: z.string().min(1), memberId: z.string().min(1), memberDisplayName: z.string().min(1), type: wagerType, confirmedAt: z.string().datetime(), weekStart: z.string().datetime(), performanceMicros: decimalString,
  riskMicros: positiveCanonicalIntegerText, acceptedOdds: americanOdds, rulesetVersion: z.string().min(1), legs: z.array(ownerWagerLeg).min(1)
});
const openOwnerWager = ownerWagerBase.extend({ status: z.literal("open") }).strict();
const settledOwnerWager = ownerWagerBase.extend({ status: z.enum(["won", "lost", "refunded"]), outcome: z.enum(["won", "lost", "refunded"]), returnMicros: decimalString, profitMicros: decimalString, settledOdds: americanOdds.nullable(), settledAt: z.string().datetime() }).strict();
/** Exact owner ticket terms consumed by My Wagers; generic member reads remain redacted separately. */
export const ownerWager = z.discriminatedUnion("status", [openOwnerWager, settledOwnerWager]);

const auditId = z.string().min(1);
const auditTimestamp = z.string().datetime();
const auditPool = z.object({ id: auditId, slug: auditId, name: auditId, commissionerId: auditId, signupsOpen: z.boolean(), commandVersion: canonicalIntegerText }).strict();
const auditSeason = z.object({ id: auditId, label: auditId, rulesetVersion: auditId, state: z.enum(["draft", "active", "closed"]), openedAt: auditTimestamp.nullable(), closedAt: auditTimestamp.nullable(), closeReason: z.string().nullable(), floatMicros: canonicalIntegerText, notionalMicros: canonicalIntegerText, defaultMode: z.enum(["shares", "value"]).nullable(), defaultAmountMicros: canonicalIntegerText.nullable(), commandVersion: canonicalIntegerText }).strict();
const auditAccount = z.object({ seasonId: auditId, memberId: auditId, availableMicros: canonicalIntegerText, lockedMicros: canonicalIntegerText, rowVersion: canonicalIntegerText }).strict();
export const auditOrder = z.object({ id: auditId, seasonId: auditId, memberId: auditId, actorId: auditId, mode: z.enum(["shares", "value"]), requestedMicros: canonicalIntegerText, sharesMicros: canonicalIntegerText, valueMicros: canonicalIntegerText, priceMicros: canonicalIntegerText, reversalOf: auditId.nullable(), reason: z.string().min(1), commandId: auditId, createdAt: auditTimestamp }).strict();
export const auditLedgerEntry = z.object({ id: auditId, seasonId: auditId, memberId: auditId, actorId: auditId, availableDelta: canonicalIntegerText, lockedDelta: canonicalIntegerText, floatDelta: canonicalIntegerText, notionalDelta: canonicalIntegerText, causationId: auditId, kind: auditId, createdAt: auditTimestamp }).strict();

export const terminalAuditResult = z.discriminatedUnion("status", [
  z.object({ eventId: auditId, league: z.enum(["nfl", "ncaaf"]), status: z.literal("final"), homeScore: z.number().int().nonnegative(), awayScore: z.number().int().nonnegative(), correctionVersion: auditId, eventName: z.string().nullable().optional(), postseason: z.boolean().optional() }).strict(),
  z.object({ eventId: auditId, league: z.enum(["nfl", "ncaaf"]), status: z.enum(["cancelled", "no_contest"]), homeScore: z.null(), awayScore: z.null(), correctionVersion: auditId, eventName: z.string().nullable().optional(), postseason: z.boolean().optional() }).strict()
]);
const uniqueResultArray = <T extends z.ZodTypeAny>(item: T) => z.array(item).min(1).max(7).superRefine((results, ctx) => {
  const eventLeagues = results.map((result) => {
    const evidence = result as { eventId: string; league: string };
    return `${evidence.eventId}\u0000${evidence.league}`;
  });
  if (new Set(eventLeagues).size !== eventLeagues.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Result evidence must contain each event and league exactly once." });
});
const providerResultEvidence = uniqueResultArray(terminalAuditResult);
const openWagerCorrectionSource = z.object({ status: z.literal("open"), wagerId: auditId }).strict();
const correctionDerived = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("win"), odds: z.number().int().refine((odds) => odds !== 0) }).strict(),
  z.object({ outcome: z.enum(["loss", "refund"]), odds: z.null() }).strict()
]);
const commissionerCorrectionEvidence = z.object({ source: z.literal("commissioner_correction"), commandId: auditId, correctedResults: uniqueResultArray(correctedEventResult), derived: correctionDerived }).strict();
const commissionerVoidEvidence = z.object({ source: z.literal("commissioner_void"), commandId: auditId, outcome: z.literal("refund") }).strict();
const commissionerResultEvidence = z.discriminatedUnion("source", [commissionerCorrectionEvidence, commissionerVoidEvidence]);
const settlementResultEvidence = z.union([providerResultEvidence, commissionerResultEvidence]);
const correctionSourceEvidence = z.union([providerResultEvidence, openWagerCorrectionSource, commissionerResultEvidence]);
const evidenceResultVersion = (evidence: z.infer<typeof settlementResultEvidence>): string => {
  if (Array.isArray(evidence)) return JSON.stringify(evidence.map((result) => [result.eventId, result.correctionVersion]));
  if (evidence.source === "commissioner_void") return `commissioner-void:${evidence.commandId}`;
  return `commissioner:${evidence.commandId}:${JSON.stringify(evidence.correctedResults.map((result) => [result.eventId, result.correctionVersion]))}`;
};

export const auditSettlement = z.object({ id: auditId, wagerId: auditId, resultVersion: auditId, outcome: z.enum(["win", "loss", "refund", "reversal"]), returnMicros: canonicalIntegerText, profitMicros: canonicalIntegerText, settledOdds: settledOdds.nullable(), sourceResult: settlementResultEvidence, reversalOf: auditId.nullable(), actorId: auditId, reason: z.string().min(1).nullable(), createdAt: auditTimestamp }).strict().superRefine((settlement, ctx) => {
  if (settlement.resultVersion !== evidenceResultVersion(settlement.sourceResult)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resultVersion"], message: "Result version must identify the persisted source evidence." });
  if (settlement.outcome !== "win" && settlement.settledOdds !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["settledOdds"], message: "Only winning settlements may record effective odds." });
  if (settlement.outcome === "reversal" || Array.isArray(settlement.sourceResult)) return;
  const evidenceOutcome = settlement.sourceResult.source === "commissioner_void" ? "refund" : settlement.sourceResult.derived.outcome;
  if (settlement.outcome !== evidenceOutcome) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Settlement outcome must match commissioner evidence." });
});
export const auditWagerCorrection = z.object({ id: auditId, wagerId: auditId, actorId: auditId, reason: z.string().min(1), sourceResult: correctionSourceEvidence, replacementResult: commissionerResultEvidence, commandId: auditId, createdAt: auditTimestamp }).strict().superRefine((correction, ctx) => {
  if (correction.replacementResult.commandId !== correction.commandId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["replacementResult", "commandId"], message: "Replacement evidence must belong to the correction command." });
  if (!Array.isArray(correction.sourceResult) && "status" in correction.sourceResult && correction.sourceResult.wagerId !== correction.wagerId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceResult", "wagerId"], message: "Open source evidence must identify the corrected wager." });
});
export const auditSeasonProviderResult = z.object({ seasonId: auditId, eventId: auditId, league: z.enum(["nfl", "ncaaf"]), correctionVersion: auditId, observedAt: auditTimestamp, appendOrder: positiveCanonicalIntegerText, result: terminalAuditResult }).strict().superRefine((entry, ctx) => {
  if (entry.eventId !== entry.result.eventId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["result", "eventId"], message: "Result event must match its immutable provider identity." });
  if (entry.league !== entry.result.league) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["result", "league"], message: "Result league must match its immutable provider identity." });
  if (entry.correctionVersion !== entry.result.correctionVersion) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["result", "correctionVersion"], message: "Result correction must match its immutable provider identity." });
});
const administrationAudit = z.object({ id: auditId, actorId: auditId, action: auditId, subjectId: auditId, reason: z.string().min(1), commandId: auditId, createdAt: auditTimestamp }).strict();
const seasonAnnotation = z.object({ id: auditId, seasonId: auditId, actorId: auditId, text: z.string(), createdAt: auditTimestamp }).strict();
/** Exact member audit boundary. Protected wager terms remain governed by memberWager redaction. */
export const auditExportResponse = z.object({ format: z.literal("share-value-pool-audit-v1"), commandVersion: canonicalIntegerText, pool: auditPool, seasons: z.array(auditSeason), seasonProviderResults: z.array(auditSeasonProviderResult), accounts: z.array(auditAccount), orders: z.array(auditOrder), ledger: z.array(auditLedgerEntry), settlements: z.array(auditSettlement), wagerCorrections: z.array(auditWagerCorrection), administrationAudit: z.array(administrationAudit), seasonAnnotations: z.array(seasonAnnotation), wagers: z.array(memberWager) }).strict().superRefine((audit, ctx) => {
  const seasonIds = new Set(audit.seasons.map((season) => season.id));
  const nextAppendOrder = new Map<string, bigint>();
  const completedSeasons = new Set<string>();
  let currentSeason: string | undefined;
  audit.seasonProviderResults.forEach((entry, index) => {
    if (!seasonIds.has(entry.seasonId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["seasonProviderResults", index, "seasonId"], message: "Provider result must belong to an exported season." });
    if (currentSeason !== entry.seasonId) {
      if (currentSeason !== undefined) completedSeasons.add(currentSeason);
      if (completedSeasons.has(entry.seasonId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["seasonProviderResults", index, "seasonId"], message: "Each season's provider results must be contiguous." });
      currentSeason = entry.seasonId;
    }
    const expected = nextAppendOrder.get(entry.seasonId) ?? 1n;
    if (BigInt(entry.appendOrder) !== expected) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["seasonProviderResults", index, "appendOrder"], message: "Provider results must preserve exact append order." });
    nextAppendOrder.set(entry.seasonId, expected + 1n);
  });
});
export type AuditExportResponse = z.infer<typeof auditExportResponse>;

export const activityOrder = z.object({ orderId: z.string().min(1), memberId: z.string().min(1), memberDisplayName: z.string().min(1), sharesMicros: decimalString, valueMicros: decimalString, priceMicros: decimalString, reason: z.string(), createdAt: z.string().datetime() }).strict();
export const ReadStandings = z.object({ commandVersion: decimalString, standings: z.array(z.object({ rank: z.number().int().positive(), userId: z.string().min(1), displayName: z.string().min(1), availableMicros: decimalString, lockedMicros: decimalString, totalMicros: decimalString, priceMicros: decimalString, notionalValueMicros: decimalString, gainMicros: decimalString })) });
export const ReadActivity = z.object({ commandVersion: decimalString, activity: z.object({ orders: z.array(activityOrder), wagers: z.array(activityWager) }).strict() }).strict();
/** Exact owner-only wager response, including nullable historical effective settlement odds. */
export const ReadMyWagers = z.object({ commandVersion: decimalString, wagers: z.array(ownerWager) }).strict();
const historyStanding = ReadStandings.shape.standings.element;
const historyAccount = z.object({ memberId: auditId, memberDisplayName: auditId, availableMicros: canonicalIntegerText, lockedMicros: canonicalIntegerText, totalMicros: canonicalIntegerText, holdingValueMicros: canonicalIntegerText, gainMicros: canonicalIntegerText }).strict();
const historyOrder = auditOrder.extend({ memberDisplayName: auditId }).strict();
const historyLedgerEntry = auditLedgerEntry.extend({ memberDisplayName: auditId }).strict();
export const ReadSeasonHistory = z.object({
  commandVersion: decimalString,
  season: z.object({ seasonId: auditId, label: auditId, rulesetVersion: auditId, state: z.literal("closed"), openedAt: auditTimestamp.nullable(), closedAt: auditTimestamp, closeReason: z.string().nullable(), floatMicros: canonicalIntegerText, notionalMicros: canonicalIntegerText, priceMicros: canonicalIntegerText }).strict(),
  accounts: z.array(historyAccount), standings: z.array(historyStanding), orders: z.array(historyOrder), ledger: z.array(historyLedgerEntry),
  wagers: z.array(memberWager), settlements: z.array(auditSettlement), wagerCorrections: z.array(auditWagerCorrection),
  eventResults: z.array(z.object({ eventId: auditId, result: terminalAuditResult, observedAt: auditTimestamp }).strict()),
  annotations: z.array(z.object({ annotationId: auditId, authorDisplayName: auditId, text: z.string(), createdAt: auditTimestamp }).strict())
}).strict();
export type ReadStandings = z.infer<typeof ReadStandings>;
export type ReadActivity = z.infer<typeof ReadActivity>;
export type ReadMyWagers = z.infer<typeof ReadMyWagers>;
export type ReadSeasonHistory = z.infer<typeof ReadSeasonHistory>;

export const commandResponse = z.object({ commandVersion: z.string(), code: z.string().optional() });
export const createPoolResponse = commandResponse.extend({ poolId: z.string(), slug: z.string(), status: z.enum(["initializing", "ready", "failed"]), lastError: z.string().optional() });
export type CreatePoolRequest = z.infer<typeof createPoolRequest>;
export type CreatePoolResponse = z.infer<typeof createPoolResponse>;

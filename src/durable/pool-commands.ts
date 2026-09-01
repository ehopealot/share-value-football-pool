import { z } from "zod";
import { canonicalIntegerText, positiveCanonicalIntegerText, placeStraightWager, placeTeaserWager, placeTeaserWagerShape, canonicalStraightQuoteProjection, canonicalTeaserQuoteProjection, quoteIdentity, correctedEventResult } from "../contracts/commands";

const commandId = z.string().min(1);
const actor = z.string().min(1);
const integerText = canonicalIntegerText;
const positiveIntegerText = positiveCanonicalIntegerText;
const common = { commandId, actorId: actor };
const poolCommandSchemaBase = z.discriminatedUnion("type", [
  z.object({ type: z.literal("InitializePool"), commandId, poolId: z.string().min(1), slug: z.string().min(1), creatorId: z.string().min(1), creatorName: z.string().min(1), poolName: z.string().min(1), password: z.string().min(8) }),
  z.object({ type: z.literal("JoinPool"), ...common, displayName: z.string().min(1), password: z.string().min(8) }),
  z.object({ type: z.literal("UpdatePoolSettings"), ...common, poolName: z.string().trim().min(1).optional(), password: z.string().min(8).optional(), signupsOpen: z.boolean().optional(), maxSideBetMicros: positiveIntegerText.optional() }),
  z.object({ type: z.literal("CreateSeason"), ...common, seasonId: z.string().min(1), label: z.string().min(1), defaultOrder: z.object({ mode: z.enum(["shares", "value"]), amountMicros: positiveIntegerText }).optional() }),
  z.object({ type: z.literal("OpenSeason"), ...common, seasonId: z.string().min(1) }),
  z.object({ type: z.literal("CloseSeason"), ...common, seasonId: z.string().min(1), reason: z.string().trim().min(1) }),
  z.object({ type: z.literal("QuoteShareOrder"), ...common, seasonId: z.string().min(1), memberId: z.string().min(1), mode: z.enum(["shares", "value"]), amountMicros: positiveIntegerText }),
  z.object({ type: z.literal("ExecuteShareOrder"), ...common, seasonId: z.string().min(1), memberId: z.string().min(1), mode: z.enum(["shares", "value"]), amountMicros: positiveIntegerText, quote: z.object({ priceMicros: integerText, commandVersion: integerText }), reason: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal("ReverseShareOrder"), ...common, orderId: z.string().min(1), reason: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal("SuspendMember"), ...common, memberId: z.string().min(1) }),
  z.object({ type: z.literal("RestoreMember"), ...common, memberId: z.string().min(1) }),
  z.object({ type: z.literal("TransferCommissioner"), ...common, memberId: z.string().min(1), reason: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal("VoidWager"), ...common, wagerId: z.string().min(1), reason: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal("RegradeWager"), ...common, wagerId: z.string().min(1), reason: z.string().trim().min(1).max(500), correctedResults: z.array(correctedEventResult).min(1).max(7) }).strict(),
  z.object({ type: z.literal("CreateSeasonAnnotation"), ...common, seasonId: z.string().min(1), text: z.string().trim().min(1).max(2000) }),
  z.object({ type: z.literal("ReplayWagerQuote"), ...common, identity: quoteIdentity }).strict(),
  z.object({ type: z.literal("QuoteStraightWager"), ...common, projection: canonicalStraightQuoteProjection, identity: quoteIdentity }).strict(),
  z.object({ type: z.literal("QuoteTeaserWager"), ...common, projection: canonicalTeaserQuoteProjection, identity: quoteIdentity }).strict(),
  // Authenticated, non-mutating lookup used to replay a successful placement before mutable offer validation.
  z.object({ type: z.literal("ProbePlacementReplay"), ...common, placement: z.unknown() }).strict(),
  placeStraightWager,
  placeTeaserWagerShape,
  z.object({ type: z.literal("ConfirmSuperBowl"), ...common, seasonId: z.string().min(1), eventId: z.string().min(1) }),
  /** Least-data authenticated entry check: nonmembers never receive pool views. */
  z.object({ type: z.literal("ReadPoolGate"), ...common }),
  z.object({ type: z.literal("ReadPoolView"), ...common }),
  z.object({ type: z.literal("ReadStandings"), ...common }),
  z.object({ type: z.literal("ReadActivity"), ...common }),
  z.object({ type: z.literal("ReadSeasonHistory"), ...common, seasonId: z.string().min(1) }),
  z.object({ type: z.literal("ReadWagers"), ...common }),
  z.object({ type: z.literal("ReadMyWagers"), ...common }),
  z.object({ type: z.literal("ReadAuditExport"), ...common })
]);
/** Keep the discriminated command union while applying the refined teaser contract. */
export const poolCommandSchema = poolCommandSchemaBase.superRefine((command, ctx) => {
  if (command.type === "PlaceTeaserWager" && !placeTeaserWager.safeParse(command).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid teaser placement" });
  }
});
export type PoolCommand = z.infer<typeof poolCommandSchema>;
export type PoolCommandResult = Record<string, unknown> & { commandVersion: string };

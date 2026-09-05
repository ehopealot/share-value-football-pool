import { describe, expect, it } from "vitest";
import {
  canonicalParlayQuoteProjection,
  parlayWagerQuoteSnapshot,
  placeParlayWager,
  quoteParlaySemantic,
  teaserWagerQuoteSnapshot
} from "../../src/contracts/commands";
import {
  parlayWagerPlacementRequest,
  parlayWagerQuoteRequest,
  teaserWagerPlacementRequest,
  teaserWagerQuoteRequest
} from "../../src/contracts/http";
import { buildParlayPlacement, parseParlayQuoteSuccess } from "../../src/web/api";

const time = "2030-09-01T12:00:00.000Z";

const fullLeg = (overrides: Record<string, unknown> = {}) => ({
  eventId: "event-1",
  league: "nfl",
  canonicalBook: "DraftKings",
  retrievedAt: time,
  policyVersion: "CANONICAL_BOOKS_2026_V1",
  offerVersion: "offer-1",
  canonicalOfferProof: {
    offerId: "event-1:moneyline:home",
    eventId: "event-1",
    offerVersion: "offer-1",
    canonicalBook: "DraftKings",
    market: "moneyline",
    selection: "home",
    odds: -110,
    line: null
  },
  market: "moneyline",
  selection: "home",
  originalLine: null,
  adjustedLine: null,
  originalOdds: -105,
  eventStartsAt: "2030-09-02T12:00:00.000Z",
  homeTeam: "Home",
  awayTeam: "Away",
  ...overrides
});

const moneyline = fullLeg();
const total = fullLeg({
  eventId: "event-1",
  canonicalOfferProof: {
    offerId: "event-1:total:over",
    eventId: "event-1",
    offerVersion: "offer-1",
    canonicalBook: "DraftKings",
    market: "total",
    selection: "over",
    odds: -110,
    line: 47.5
  },
  market: "total",
  selection: "over",
  originalLine: 47.5,
  adjustedLine: 47.5,
  originalOdds: -110
});

const semantic = {
  wagerId: "parlay-wager",
  seasonId: "season-1",
  riskMicros: "1000000",
  rulesetVersion: "PARLAY_2026_V1",
  legs: [
    { eventId: moneyline.eventId, canonicalBook: moneyline.canonicalBook, market: moneyline.market, selection: moneyline.selection, offerId: moneyline.canonicalOfferProof.offerId, offerVersion: moneyline.offerVersion },
    { eventId: total.eventId, canonicalBook: total.canonicalBook, market: total.market, selection: total.selection, offerId: total.canonicalOfferProof.offerId, offerVersion: total.offerVersion }
  ]
};

const snapshot = {
  quoteKey: "parlay-quote",
  seasonId: "season-1",
  ownerMemberId: "member-1",
  riskMicros: "1000000",
  acceptedOdds: 191,
  rulesetVersion: "PARLAY_2026_V1",
  commandVersion: "12",
  legs: [moneyline, total]
};

describe("parlay quote contracts", () => {
  it("requires immutable PARLAY_2026_V1 semantic requests with two through six valid selections", () => {
    expect(quoteParlaySemantic.parse(semantic)).toEqual(semantic);
    expect(() => quoteParlaySemantic.parse({ ...semantic, rulesetVersion: "SHARE_POOL_2026_V1" })).toThrow();
    expect(() => quoteParlaySemantic.parse({ ...semantic, legs: [semantic.legs[0]] })).toThrow();
    expect(() => quoteParlaySemantic.parse({ ...semantic, legs: Array.from({ length: 7 }, (_, index) => ({ ...semantic.legs[0], eventId: `event-${index}`, offerId: `event-${index}:moneyline:home` })) })).toThrow();
    expect(() => quoteParlaySemantic.parse({ ...semantic, legs: [{ ...semantic.legs[0], market: "spread", offerId: "event-1:spread:home" }, semantic.legs[0]] })).toThrow();
  });

  it("keeps every accepted leg complete while preserving the moneyline proof/strike distinction", () => {
    expect(parlayWagerQuoteSnapshot.parse(snapshot)).toEqual(snapshot);
    expect(() => parlayWagerQuoteSnapshot.parse({ ...snapshot, acceptedOdds: 0 })).toThrow();
    expect(() => parlayWagerQuoteSnapshot.parse({ ...snapshot, acceptedOdds: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => parlayWagerQuoteSnapshot.parse({ ...snapshot, legs: [{ ...moneyline, originalOdds: 0 }, total] })).toThrow();
    expect(() => parlayWagerQuoteSnapshot.parse({ ...snapshot, legs: [moneyline, { ...total, canonicalOfferProof: { ...total.canonicalOfferProof, odds: Number.MAX_SAFE_INTEGER + 1 } }] })).toThrow();
    expect(() => parlayWagerQuoteSnapshot.parse({ ...snapshot, legs: [{ ...moneyline, canonicalOfferProof: { ...moneyline.canonicalOfferProof, odds: -105 } }, total] })).not.toThrow();
    expect(() => parlayWagerQuoteSnapshot.parse({ ...snapshot, legs: [moneyline, { ...total, canonicalOfferProof: { ...total.canonicalOfferProof, odds: -105 } }] })).toThrow();
    expect(() => parlayWagerQuoteSnapshot.parse({ ...snapshot, legs: [{ ...moneyline, canonicalOfferProof: undefined }, total] })).toThrow();
  });

  it("projects and places the complete fixed snapshot without browser ownership fields", () => {
    const projection = { ...snapshot, wagerId: "parlay-wager", actorId: "member-1", fingerprint: "fingerprint" };
    expect(canonicalParlayQuoteProjection.parse(projection)).toEqual(projection);
    const placement = {
      type: "PlaceParlayWager",
      commandId: "parlay-place",
      actorId: "member-1",
      wagerId: "parlay-wager",
      quoteKey: snapshot.quoteKey,
      quotedCommandVersion: snapshot.commandVersion,
      seasonId: snapshot.seasonId,
      riskMicros: snapshot.riskMicros,
      acceptedOdds: snapshot.acceptedOdds,
      rulesetVersion: snapshot.rulesetVersion,
      legs: snapshot.legs
    };
    expect(placeParlayWager.parse(placement)).toEqual(placement);
    expect(() => placeParlayWager.parse({ ...placement, rulesetVersion: "other" })).toThrow();
    const quoteRequest = parlayWagerQuoteRequest.parse({ ...semantic, quoteKey: "parlay-quote", commandId: "parlay-quote" });
    expect(quoteRequest).toEqual({ ...semantic, quoteKey: "parlay-quote", commandId: "parlay-quote" });
    expect(() => parlayWagerQuoteRequest.parse({ ...semantic, quoteKey: snapshot.quoteKey, commandId: "other" })).toThrow();
    const parsedSnapshot = parseParlayQuoteSuccess(quoteRequest, snapshot);
    expect(parsedSnapshot).toEqual(snapshot);
    const expectSchemaValidParlayMismatch = (value: unknown) => {
      expect(parlayWagerQuoteSnapshot.safeParse(value).success).toBe(true);
      expect(() => parseParlayQuoteSuccess(quoteRequest, value)).toThrow();
    };
    for (const mismatch of [
      { ...snapshot, quoteKey: "other-quote" },
      { ...snapshot, seasonId: "other-season" },
      { ...snapshot, riskMicros: "2000000" }
    ]) expectSchemaValidParlayMismatch(mismatch);
    // A parser-level ruleset mismatch is unreachable because both public parlay schemas intentionally require this literal.
    expect(parlayWagerQuoteSnapshot.safeParse({ ...snapshot, rulesetVersion: "SHARE_POOL_2026_V1" }).success).toBe(false);

    const thirdLeg = fullLeg({
      eventId: "event-3",
      canonicalOfferProof: { ...moneyline.canonicalOfferProof, eventId: "event-3", offerId: "event-3:moneyline:home" }
    });
    expectSchemaValidParlayMismatch({ ...snapshot, legs: [...snapshot.legs, thirdLeg] });
    expectSchemaValidParlayMismatch({ ...snapshot, legs: [...snapshot.legs].reverse() });

    const firstLegIdentityMismatches = [
      { ...moneyline, eventId: "other-event", canonicalOfferProof: { ...moneyline.canonicalOfferProof, eventId: "other-event" } },
      { ...moneyline, canonicalBook: "OtherBook", canonicalOfferProof: { ...moneyline.canonicalOfferProof, canonicalBook: "OtherBook" } },
      { ...moneyline, market: "spread", originalLine: -3.5, adjustedLine: -3.5, originalOdds: -110, canonicalOfferProof: { ...moneyline.canonicalOfferProof, market: "spread", line: -3.5 } },
      { ...moneyline, selection: "away", canonicalOfferProof: { ...moneyline.canonicalOfferProof, selection: "away" } },
      { ...moneyline, canonicalOfferProof: { ...moneyline.canonicalOfferProof, offerId: "other-offer" } },
      { ...moneyline, offerVersion: "offer-2", canonicalOfferProof: { ...moneyline.canonicalOfferProof, offerVersion: "offer-2" } }
    ];
    for (const leg of firstLegIdentityMismatches) expectSchemaValidParlayMismatch({ ...snapshot, legs: [leg, total] });
    const browserPlacement = {
      wagerId: "parlay-wager",
      quoteKey: "parlay-quote",
      quotedCommandVersion: "12",
      mutationKey: "parlay-place",
      commandId: "parlay-place",
      seasonId: "season-1",
      riskMicros: "1000000",
      acceptedOdds: 191,
      rulesetVersion: "PARLAY_2026_V1",
      legs: [moneyline, total]
    };
    expect(buildParlayPlacement(parsedSnapshot, "parlay-wager", "parlay-place")).toEqual(browserPlacement);
    expect(parlayWagerPlacementRequest.parse(browserPlacement)).toEqual(browserPlacement);
    expect(() => parlayWagerPlacementRequest.parse({ ...browserPlacement, mutationKey: "other" })).toThrow();
    for (const protectedFields of [
      { actorId: "member-1" },
      { ownerMemberId: "member-1" },
      { fingerprint: "browser-fingerprint" }
    ]) expect(() => parlayWagerPlacementRequest.parse({ ...browserPlacement, ...protectedFields })).toThrow();
  });

  it("continues to parse seven-leg teaser envelopes for legacy replay", () => {
    const semanticLegs = Array.from({ length: 7 }, (_, index) => ({
      eventId: `legacy-${index}`,
      canonicalBook: "DraftKings",
      market: "spread" as const,
      selection: "home" as const,
      offerId: `legacy-${index}:spread:home`,
      offerVersion: "offer-1"
    }));
    expect(teaserWagerQuoteRequest.parse({
      quoteKey: "legacy-quote",
      commandId: "legacy-quote",
      wagerId: "legacy-wager",
      seasonId: "season-1",
      riskMicros: "1000000",
      teaserPoints: 6,
      rulesetVersion: "SHARE_POOL_2026_V1",
      legs: semanticLegs
    }).legs).toHaveLength(7);

    const snapshotLegs = semanticLegs.map((leg) => fullLeg({
      eventId: leg.eventId,
      canonicalOfferProof: { offerId: leg.offerId, eventId: leg.eventId, offerVersion: leg.offerVersion, canonicalBook: leg.canonicalBook, market: "spread", selection: "home", odds: -110, line: -3 },
      market: "spread",
      selection: "home",
      originalLine: -3,
      adjustedLine: 3,
      originalOdds: -110
    }));
    const legacySnapshot = { quoteKey: "legacy-quote", seasonId: "season-1", ownerMemberId: "member-1", riskMicros: "1000000", acceptedOdds: 800, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", commandVersion: "12", legs: snapshotLegs };
    expect(teaserWagerQuoteSnapshot.parse(legacySnapshot).legs).toHaveLength(7);
    expect(teaserWagerPlacementRequest.parse({ wagerId: "legacy-wager", quoteKey: legacySnapshot.quoteKey, quotedCommandVersion: legacySnapshot.commandVersion, mutationKey: "legacy-place", commandId: "legacy-place", seasonId: legacySnapshot.seasonId, riskMicros: legacySnapshot.riskMicros, acceptedOdds: legacySnapshot.acceptedOdds, teaserPoints: legacySnapshot.teaserPoints, rulesetVersion: legacySnapshot.rulesetVersion, legs: legacySnapshot.legs }).legs).toHaveLength(7);
  });
});

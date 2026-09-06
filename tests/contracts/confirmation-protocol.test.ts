import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Confirmation } from "../../src/web/components/Confirmation";
import { straightWagerQuoteRequest, straightWagerPlacementRequest, teaserWagerQuoteRequest, teaserWagerPlacementRequest, shareOrderQuoteRequest, shareOrderQuoteSnapshot } from "../../src/contracts/http";
import { buildShareOrderExecution, buildStraightPlacement, buildTeaserPlacement, parseShareOrderQuoteSuccess, parseStraightQuoteSuccess, parseTeaserQuoteSuccess } from "../../src/web/api";

const time = "2030-09-01T12:00:00.000Z";
const request: z.infer<typeof straightWagerQuoteRequest> = { quoteKey: "quote-1", commandId: "quote-1", wagerId: "wager-1", seasonId: "season-1", riskMicros: "1000000", rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: "event-1", canonicalBook: "DraftKings", market: "spread", selection: "home", offerId: "event-1:spread:home", offerVersion: "7" } };

describe("immutable confirmation protocol", () => {
  it("constructs a browser quote without accepted terms", () => {
    expect(straightWagerQuoteRequest.parse(request)).toMatchObject(request);
    expect(straightWagerQuoteRequest.safeParse({ ...request, acceptedOdds: 100 }).success).toBe(false);
  });
  it("accepts one strict composed teaser quote request", () => {
    const leg = { eventId: "event-1", canonicalBook: "DraftKings", market: "spread", selection: "home", offerId: "event-1:spread:home", offerVersion: "7" };
    expect(teaserWagerQuoteRequest.safeParse({ quoteKey: "quote-2", commandId: "quote-2", wagerId: "wager-2", seasonId: "season-1", riskMicros: "1000000", teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: [leg, { ...leg, eventId: "event-2", offerId: "event-2:spread:home" }] }).success).toBe(true);
  });
  it("rejects duplicate and opposing teaser selections before quote establishment", () => {
    const leg = { eventId: "event-1", canonicalBook: "DraftKings", market: "spread" as const, selection: "home" as const, offerId: "event-1:spread:home", offerVersion: "7" };
    const base = { quoteKey: "quote-duplicate", commandId: "quote-duplicate", wagerId: "wager-duplicate", seasonId: "season-1", riskMicros: "1000000", teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1" };
    expect(teaserWagerQuoteRequest.safeParse({ ...base, legs: [leg, { ...leg }] }).success).toBe(false);
    expect(teaserWagerQuoteRequest.safeParse({ ...base, legs: [leg, { ...leg, selection: "away", offerId: "event-1:spread:away" }] }).success).toBe(false);
  });
  it("requires exact immutable placement binding", () => {
    const placement = { commandId: "mutation-1", mutationKey: "mutation-1", wagerId: "wager-1", quoteKey: "quote-1", quotedCommandVersion: "12", seasonId: "season-1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: "event-1", league: "nfl", canonicalBook: "DraftKings", retrievedAt: time, policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "7", canonicalOfferProof: { offerId: "event-1:spread:home", eventId: "event-1", offerVersion: "7", canonicalBook: "DraftKings", market: "spread", selection: "home", odds: -110, line: -3.5 }, market: "spread", selection: "home", originalLine: -3.5, adjustedLine: -3.5, originalOdds: -110, eventStartsAt: time, homeTeam: "Home", awayTeam: "Away" } };
    expect(straightWagerPlacementRequest.parse(placement).quotedCommandVersion).toBe("12");
    expect(straightWagerPlacementRequest.safeParse({ ...placement, acceptedOdds: 0 }).success).toBe(false);
    expect(straightWagerPlacementRequest.safeParse({ ...placement, leg: { ...placement.leg, adjustedLine: -2.5 } }).success).toBe(false);
    expect(straightWagerPlacementRequest.safeParse({ ...placement, leg: { ...placement.leg, homeTeam: "" } }).success).toBe(false);
  });
  it("builds placement from frozen authority only and rejects malformed success", () => {
    const quote = { quoteKey: "quote-1", seasonId: "season-1", ownerMemberId: "owner", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", commandVersion: "12", leg: { eventId: "event-1", league: "nfl", canonicalBook: "DraftKings", retrievedAt: time, policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "7", canonicalOfferProof: { offerId: "event-1:spread:home", eventId: "event-1", offerVersion: "7", canonicalBook: "DraftKings", market: "spread", selection: "home", odds: -110, line: -3.5 }, market: "spread", selection: "home", originalLine: -3.5, adjustedLine: -3.5, originalOdds: -110, eventStartsAt: time, homeTeam: "Home", awayTeam: "Away" } };
    const parsedQuote = parseStraightQuoteSuccess(request, quote);
    const body = buildStraightPlacement(parsedQuote, "wager-1", "mutation-1");
    // Quote and placement retries must send byte-identical body/key identities.
    expect(parseStraightQuoteSuccess(request, quote)).toEqual(parsedQuote);
    expect(buildStraightPlacement(parsedQuote, "wager-1", "mutation-1")).toEqual(body);
    expect(body).not.toHaveProperty("ownerMemberId"); expect(body).not.toHaveProperty("commandVersion");
    expect(() => parseStraightQuoteSuccess(request, { ...quote, ownerMemberId: "" })).toThrow();
    expect(() => parseStraightQuoteSuccess(request, { ...quote, quoteKey: "other" })).toThrow();
    expect(() => parseStraightQuoteSuccess(request, { ...quote, riskMicros: "2000000" })).toThrow();
    // Every request-mirrored straight field is checked before immutable review may begin.
    for (const [key, value] of Object.entries({ quoteKey: "other-quote", seasonId: "other-season", riskMicros: "2000000", rulesetVersion: "other-rules" })) expect(() => parseStraightQuoteSuccess(request, { ...quote, [key]: value })).toThrow();
    expect(() => parseStraightQuoteSuccess(request, { ...quote, leg: { ...quote.leg, canonicalOfferProof: { ...quote.leg.canonicalOfferProof, offerId: "other-offer" } } })).toThrow();
    for (const [key, value] of Object.entries({ eventId: "other-event", canonicalBook: "OtherBook", market: "total", selection: "over", offerVersion: "8" })) {
      const proof = { ...quote.leg.canonicalOfferProof, ...(key === "eventId" ? { eventId: value, offerId: "other-event:spread:home" } : key === "canonicalBook" ? { canonicalBook: value } : key === "market" ? { market: value } : key === "selection" ? { selection: value } : { offerVersion: value }) };
      expect(() => parseStraightQuoteSuccess(request, { ...quote, leg: { ...quote.leg, [key]: value, canonicalOfferProof: proof } })).toThrow();
    }
    const order = shareOrderQuoteSnapshot.parse({ seasonId: "season-1", memberId: "member", mode: "shares", amountMicros: "1000000", sharesMicros: "1000000", valueMicros: "1000000", priceMicros: "1000000", commandVersion: "12" });
    const orderRequest: z.infer<typeof shareOrderQuoteRequest> = { seasonId: "season-1", memberId: "member", mode: "shares", amountMicros: "1000000", idempotencyKey: "order-quote" };
    for (const [key, value] of Object.entries({ seasonId: "other-season", memberId: "other-member", mode: "value", amountMicros: "2000000" })) expect(() => parseShareOrderQuoteSuccess(orderRequest, { ...order, [key]: value })).toThrow();
    expect(buildShareOrderExecution(order, "mutation", "reason")).toMatchObject({ seasonId: "season-1", memberId: "member", mode: "shares", amountMicros: "1000000" });
    expect(buildTeaserPlacement({ quoteKey: "quote-teaser", seasonId: "season-1", ownerMemberId: "owner", riskMicros: "1000000", acceptedOdds: -120, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", commandVersion: "13", legs: [{ ...quote.leg, adjustedLine: 2.5 }, { ...quote.leg, adjustedLine: 2.5, eventId: "event-2", canonicalOfferProof: { ...quote.leg.canonicalOfferProof, eventId: "event-2", offerId: "event-2:spread:home" } }, { ...quote.leg, adjustedLine: 2.5, eventId: "event-3", canonicalOfferProof: { ...quote.leg.canonicalOfferProof, eventId: "event-3", offerId: "event-3:spread:home" } }] } as any, "wager-teaser", "mutation-teaser")).toMatchObject({ wagerId: "wager-teaser", quoteKey: "quote-teaser", teaserPoints: 6 });
  });
  it("renders the production Confirmation from its typed snapshot alone", () => {
    const quote = { quoteKey: "quote-render", seasonId: "season-1", ownerMemberId: "owner", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", commandVersion: "12", leg: { eventId: "event-render", league: "nfl" as const, canonicalBook: "DraftKings", retrievedAt: time, policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "7", canonicalOfferProof: { offerId: "event-render:spread:home", eventId: "event-render", offerVersion: "7", canonicalBook: "DraftKings", market: "spread" as const, selection: "home" as const, odds: -110, line: -3.5 }, market: "spread" as const, selection: "home" as const, originalLine: -3.5, adjustedLine: -3.5, originalOdds: -110, eventStartsAt: time, homeTeam: "Snapshot Home", awayTeam: "Snapshot Away" } };
    const html = renderToStaticMarkup(createElement(Confirmation, { snapshot: { kind: "straight", quote }, editor: { homeTeam: "editor-injection", riskMicros: "999999999", acceptedOdds: -999 } } as any));
    expect(html).toContain("Snapshot Away at Snapshot Home");
    expect(html).toContain("Risk 1 whole shares; ruleset SHARE_POOL_2026_V1; possible profit 1.00 shares; total return 2.00 shares.");
    expect(html).toContain("100");
    expect(html).not.toContain("editor-injection");
    expect(html).not.toContain("999999999");
  });
  it("renders straight, teaser, and order confirmations from snapshots without editor data", () => {
    const leg = { eventId: "event-render", league: "nfl" as const, canonicalBook: "SnapshotBook", retrievedAt: time, policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "7", canonicalOfferProof: { offerId: "event-render:spread:home", eventId: "event-render", offerVersion: "7", canonicalBook: "SnapshotBook", market: "spread" as const, selection: "home" as const, odds: -110, line: -3.5 }, market: "spread" as const, selection: "home" as const, originalLine: -3.5, adjustedLine: 2.5, originalOdds: -110, eventStartsAt: time, homeTeam: "Snapshot Home", awayTeam: "Snapshot Away" };
    const teaser = renderToStaticMarkup(createElement(Confirmation, { snapshot: { kind: "teaser", quote: { quoteKey: "teaser", seasonId: "season", ownerMemberId: "owner", riskMicros: "1000000", acceptedOdds: -120, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", commandVersion: "1", legs: [leg, { ...leg, eventId: "event-2" }, { ...leg, eventId: "event-3" }] } }, editor: { teaserPoints: 99, homeTeam: "editor-injection", riskMicros: "999999999" } } as any));
    const order = renderToStaticMarkup(createElement(Confirmation, { snapshot: { kind: "order", quote: { seasonId: "season", memberId: "member", mode: "shares", amountMicros: "1000000", sharesMicros: "1000000", valueMicros: "1000000", priceMicros: "1000000", commandVersion: "1" }, memberDisplayName: "Frozen Member" }, editor: { amountMicros: "999999999", memberId: "editor-injection" } } as any));
    expect(teaser).toContain("Snapshot Away at Snapshot Home"); expect(teaser).toContain("6-point teaser"); expect(teaser).toContain("<strong>Win:</strong> 0.83"); expect(teaser).toContain("<strong>Payout:</strong> 1.83"); expect(order).toContain("Issue <strong>1</strong> shares to Frozen Member"); expect(order).toContain("Locked price: <strong>$1.00</strong> per share.");
    expect(`${teaser}${order}`).not.toContain("editor-injection"); expect(`${teaser}${order}`).not.toContain("999999999");
  });
  it("requires canonical null moneyline lines and strict teaser direction/count", () => {
    const moneyline = { commandId: "mutation-money", mutationKey: "mutation-money", wagerId: "wager-money", quoteKey: "quote-money", quotedCommandVersion: "12", seasonId: "season-1", riskMicros: "1000000", acceptedOdds: 150, rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: "event-money", league: "nfl", canonicalBook: "DraftKings", retrievedAt: time, policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "7", canonicalOfferProof: { offerId: "event-money:moneyline:home", eventId: "event-money", offerVersion: "7", canonicalBook: "DraftKings", market: "moneyline", selection: "home", odds: 150, line: null }, market: "moneyline", selection: "home", originalLine: null, adjustedLine: null, originalOdds: 150, eventStartsAt: time, homeTeam: "Home", awayTeam: "Away" } };
    expect(straightWagerPlacementRequest.safeParse(moneyline).success).toBe(true);
    expect(straightWagerPlacementRequest.safeParse({ ...moneyline, leg: { ...moneyline.leg, adjustedLine: 0 } }).success).toBe(false);
    const teaserLeg = { ...moneyline.leg, market: "spread" as const, originalLine: -3, adjustedLine: 7, selection: "home" as const, canonicalOfferProof: { ...moneyline.leg.canonicalOfferProof, market: "spread" as const, selection: "home" as const, line: -3 } };
    const teaser = { commandId: "mutation-teaser", mutationKey: "mutation-teaser", wagerId: "wager-teaser", quoteKey: "quote-teaser", quotedCommandVersion: "12", seasonId: "season-1", riskMicros: "1000000", acceptedOdds: -120, teaserPoints: 10, rulesetVersion: "SHARE_POOL_2026_V1", legs: [teaserLeg, { ...teaserLeg, eventId: "e2", canonicalOfferProof: { ...teaserLeg.canonicalOfferProof, eventId: "e2", offerId: "e2:spread:home" } }, { ...teaserLeg, eventId: "e3", canonicalOfferProof: { ...teaserLeg.canonicalOfferProof, eventId: "e3", offerId: "e3:spread:home" } }] };
    expect(teaserWagerPlacementRequest.safeParse(teaser).success).toBe(true);
    expect(teaserWagerPlacementRequest.safeParse({ ...teaser, legs: teaser.legs.slice(0, 2) }).success).toBe(false);
    expect(teaserWagerPlacementRequest.safeParse({ ...teaser, legs: [{ ...teaserLeg, adjustedLine: -13 }, ...teaser.legs.slice(1)] }).success).toBe(false);
    const teaserRequest: z.infer<typeof teaserWagerQuoteRequest> = { quoteKey: "quote-teaser", commandId: "quote-teaser", wagerId: "wager-teaser", seasonId: "season-1", riskMicros: "1000000", teaserPoints: 10, rulesetVersion: "SHARE_POOL_2026_V1", legs: teaser.legs.map(({ eventId, canonicalBook, market, selection, canonicalOfferProof, offerVersion }) => ({ eventId, canonicalBook, market, selection, offerId: canonicalOfferProof.offerId, offerVersion })) };
    const teaserSnapshot = { quoteKey: "quote-teaser", seasonId: "season-1", ownerMemberId: "owner", riskMicros: "1000000", acceptedOdds: -120, teaserPoints: 10, rulesetVersion: "SHARE_POOL_2026_V1", commandVersion: "12", legs: teaser.legs };
    expect(() => parseTeaserQuoteSuccess(teaserRequest, { ...teaserSnapshot, legs: [...teaserSnapshot.legs].reverse() })).toThrow();
    // Every request-mirrored teaser scalar and leg identity is rejected before Confirmation can receive it.
    for (const [key, value] of Object.entries({ quoteKey: "other-quote", seasonId: "other-season", riskMicros: "2000000", teaserPoints: 7, rulesetVersion: "other-rules" })) expect(() => parseTeaserQuoteSuccess(teaserRequest, { ...teaserSnapshot, [key]: value })).toThrow();
    for (const [key, value] of Object.entries({ eventId: "wrong", canonicalBook: "OtherBook", market: "total", selection: "away", offerVersion: "8" })) {
      const changed = { ...teaserSnapshot.legs[0]!, [key]: value } as any;
      changed.canonicalOfferProof = { ...changed.canonicalOfferProof, [key]: value, ...(key === "eventId" ? { offerId: "wrong:spread:home" } : key === "market" ? { offerId: "event-1:total:home" } : key === "selection" ? { offerId: "event-1:spread:away" } : {}) };
      expect(() => parseTeaserQuoteSuccess(teaserRequest, { ...teaserSnapshot, legs: [changed, ...teaserSnapshot.legs.slice(1)] })).toThrow();
    }
    teaserSnapshot.legs.forEach((leg, index) => expect(() => parseTeaserQuoteSuccess(teaserRequest, { ...teaserSnapshot, legs: teaserSnapshot.legs.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, canonicalOfferProof: { ...candidate.canonicalOfferProof, offerId: `wrong-${leg.eventId}` } } : candidate) })).toThrow());
  });
});

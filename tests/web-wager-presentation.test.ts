import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Confirmation } from "../src/web/components/Confirmation";
import { WagerDetails } from "../src/web/components/WagerDetails";
import { formatKickoff } from "../src/web/odds-format";
import { displayWagerStartTimes, sortWagersByStartTime, ticketReturns } from "../src/web/wager-presentation";

const wager = (overrides: Record<string, unknown> = {}) => ({ wagerId: "wager", type: "straight", confirmedAt: "2026-09-01T00:00:00.000Z", legs: [{ eventStartsAt: "2026-09-06T20:00:00.000Z" }], ...overrides });

describe("owner ticket presentation", () => {
  it("uses the shared half-even American-odds calculation for possible returns", () => {
    expect(ticketReturns("1000000", 150)).toEqual({ profit: "1.50", total: "2.50" });
    expect(ticketReturns("1000000", -200)).toEqual({ profit: "0.50", total: "1.50" });
  });

  it("preserves canonical micros above Number.MAX_SAFE_INTEGER in the owner display", () => {
    expect(ticketReturns("9007199254740993", 100)).toEqual({ profit: "9007199254.74", total: "18014398509.48" });
  });

  it("shows every local leg start in kickoff order and orders parlays by their earliest leg", () => {
    const late = wager({ wagerId: "late", legs: [{ eventStartsAt: "2026-09-08T20:00:00.000Z" }] });
    const parlay = wager({ wagerId: "parlay", type: "parlay", legs: [{ eventStartsAt: "2026-09-07T20:00:00.000Z" }, { eventStartsAt: "2026-09-06T18:00:00.000Z" }] });
    const early = wager({ wagerId: "early", legs: [{ eventStartsAt: "2026-09-06T20:00:00.000Z" }] });

    expect(displayWagerStartTimes(early)).toEqual([formatKickoff("2026-09-06T20:00:00.000Z")]);
    expect(displayWagerStartTimes(parlay)).toEqual([formatKickoff("2026-09-06T18:00:00.000Z"), formatKickoff("2026-09-07T20:00:00.000Z")]);
    expect(sortWagersByStartTime([late, early, parlay]).map((item) => item.wagerId)).toEqual(["parlay", "early", "late"]);
  });

  it("places unavailable starts last and breaks start-time ties deterministically", () => {
    const tied = wager({ wagerId: "tied", legs: [{ eventStartsAt: "2026-09-06T20:00:00.000Z" }] });
    const tiedLater = wager({ wagerId: "tied-later", confirmedAt: "2026-09-01T00:00:01.000Z", legs: [{ eventStartsAt: "2026-09-06T20:00:00.000Z" }] });
    const hidden = wager({ wagerId: "b", confirmedAt: "2026-09-02T00:00:00.000Z", legs: undefined });
    const malformed = wager({ wagerId: "a", confirmedAt: "2026-09-02T00:00:00.000Z", legs: [{ eventStartsAt: "not-a-date" }] });

    expect(sortWagersByStartTime([hidden, tiedLater, malformed, tied]).map((item) => item.wagerId)).toEqual(["tied", "tied-later", "a", "b"]);
  });

  it("renders parlay confirmation terms and owner settlement details", () => {
    const leg = { eventId: "event", league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2030-01-01T00:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", canonicalOfferProof: { offerId: "event:spread:home", eventId: "event", offerVersion: "v1", canonicalBook: "DraftKings", market: "spread", selection: "home", odds: 100, line: -3 }, market: "spread", selection: "home", originalLine: -3, adjustedLine: -3, originalOdds: 100, eventStartsAt: "2030-01-02T00:00:00.000Z", homeTeam: "Home", awayTeam: "Away" } as const;
    const total = { ...leg, canonicalOfferProof: { ...leg.canonicalOfferProof, offerId: "event:total:over", market: "total" as const, selection: "over" as const, line: 47 }, market: "total" as const, selection: "over" as const, originalLine: 47, adjustedLine: 47 };
    const confirmation = renderToStaticMarkup(createElement(Confirmation, { snapshot: { kind: "parlay", quote: { quoteKey: "q", seasonId: "s", ownerMemberId: "member", riskMicros: "1000000", acceptedOdds: 250, rulesetVersion: "PARLAY_2026_V1", commandVersion: "2", legs: [leg, total] } } }));
    expect(confirmation).toContain("Confirm parlay wager");
    expect(confirmation).toContain("-133");
    const details = renderToStaticMarkup(createElement(WagerDetails, { wager: { wagerId: "p", memberDisplayName: "Member", type: "parlay", status: "won", acceptedOdds: 300, settledOdds: 250, riskMicros: "1000000", returnMicros: "3500000", outcome: "won", legs: [], confirmedAt: "2030-01-01T00:00:00.000Z", settledAt: "2030-01-03T00:00:00.000Z", performanceMicros: "2500000", seasonId: "s", memberId: "member", rulesetVersion: "PARLAY_2026_V1" } as any, ownerOutcome: true }));
    expect(details).toContain("Accepted ticket odds: +300");
    expect(details).toContain("Recorded settlement odds: +250");
  });
});

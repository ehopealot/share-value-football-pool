import { describe, expect, it } from "vitest";
import { auditExportResponse, auditSettlement, OddsBoardResponse, ReadActivity, ReadMyWagers, ReadPoolView, ReadSeasonHistory, ReadStandings } from "../../src/contracts/http";

describe("T11 member read contracts", () => {
  const wager = { wagerId: "w", seasonId: "s", memberId: "member", memberDisplayName: "Member", type: "straight", status: "won", confirmedAt: "2026-01-01T00:00:00.000Z", weekStart: "2025-12-29T00:00:00.000Z", performanceMicros: "0" };
  it("strictly describes truthful odds-board feed observations and offer sources", () => {
    const response = {
      offers: [{ eventId: "event-1", league: "nfl", homeTeam: "Home", awayTeam: "Away", startsAt: "2030-09-01T12:00:00.000Z", market: "spread", canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z", offerVersion: "v1", policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] }],
      feed: { status: "current", message: "Odds are up to date.", lastPolledAt: "2030-09-01T10:01:00.000Z", lastSuccessAt: "2030-09-01T10:01:00.000Z" }
    };
    expect(OddsBoardResponse.parse(response).offers[0]).toMatchObject({ canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z" });
    expect(() => OddsBoardResponse.parse({ ...response, feed: { ...response.feed, lastPolledAt: undefined } })).toThrow();
    expect(() => OddsBoardResponse.parse({ ...response, feed: { ...response.feed, status: "unavailable" } })).toThrow();
    expect(() => OddsBoardResponse.parse({ ...response, offers: [{ ...response.offers[0], canonicalBook: undefined }] })).toThrow();
    expect(() => OddsBoardResponse.parse({ ...response, offers: [{ ...response.offers[0], outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 4 }] }] })).toThrow();
    expect(() => OddsBoardResponse.parse({ ...response, offers: [{ ...response.offers[0], market: "total", outcomes: [{ name: "Over", price: -110, point: 47.5 }, { name: "Under", price: -110, point: 48.5 }] }] })).toThrow();
    expect(() => OddsBoardResponse.parse({ ...response, extra: true })).toThrow();
  });

  it("requires the immutable ruleset version in every pool lifecycle summary", () => {
    const summary = { id: "s", label: "Season", rulesetVersion: "SHARE_POOL_2026_V1", state: "active", createdAt: "2026-01-01T00:00:00.000Z", openedAt: "2026-01-02T00:00:00.000Z", closedAt: null, defaultOrderMode: null, defaultOrderAmountMicros: null, floatMicros: "0", notionalValueMicros: "0" };
    const view = { commandVersion: "1", pool: { poolId: "p", slug: "pool", name: "Pool", commissionerId: "owner", signupsOpen: true, maxSideBetMicros: "800000000", commissionerNotice: null }, activeSeason: summary, nextDraftSeason: null, latestClosedSeason: null, currentMember: { memberId: "owner", role: "commissioner", seasonBalances: [{ seasonId: "s", availableMicros: "0", lockedMicros: "0" }], hasUnreadBoard: false }, members: [{ memberId: "owner", displayName: "Owner", role: "commissioner", status: "active" }], commissioner: { seasonOrders: [] } };
    expect(ReadPoolView.parse(view).activeSeason?.rulesetVersion).toBe("SHARE_POOL_2026_V1");
    expect(() => ReadPoolView.parse({ ...view, activeSeason: { ...summary, rulesetVersion: undefined } })).toThrow();
    expect(ReadPoolView.parse({ ...view, activeSeason: { ...summary, rulesetVersion: "FUTURE_RULES_V9" } }).activeSeason?.rulesetVersion).toBe("FUTURE_RULES_V9");
    expect(() => ReadPoolView.parse({ ...view, activeSeason: { ...summary, unexpected: true } })).toThrow();
  });

  it("accepts canonical standings and rejects noncanonical accounting", () => {
    expect(ReadStandings.parse({ commandVersion: "1", standings: [{ rank: 1, userId: "u", displayName: "Member", availableMicros: "0", lockedMicros: "0", totalMicros: "0", priceMicros: "1000000", notionalValueMicros: "0", gainMicros: "0" }] }).standings).toHaveLength(1);
    expect(() => ReadStandings.parse({ commandVersion: "1", standings: [{ rank: 1, userId: "u", displayName: "Member", availableMicros: "01", lockedMicros: "0", totalMicros: "0", priceMicros: "1000000", notionalValueMicros: "0", gainMicros: "0" }] })).toThrow();
  });
  it("requires member-visible wager identity and immutable history fields", () => {
    expect(ReadActivity.parse({ commandVersion: "1", activity: { orders: [], wagers: [wager] } }).activity.wagers[0]).toEqual(wager);
    for (const field of ["wagerId", "seasonId", "memberId", "memberDisplayName", "type", "status", "confirmedAt", "weekStart", "performanceMicros"] as const) {
      expect(() => ReadActivity.parse({ commandVersion: "1", activity: { orders: [], wagers: [{ ...wager, [field]: undefined }] } })).toThrow();
    }
    const history = ReadSeasonHistory.parse({
      commandVersion: "1",
      season: { seasonId: "s", label: "Closed", rulesetVersion: "SHARE_POOL_2026_V1", state: "closed", openedAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-02-01T00:00:00.000Z", closeReason: "complete", floatMicros: "3", notionalMicros: "5", priceMicros: "1666667" },
      accounts: [{ memberId: "member", memberDisplayName: "Member", availableMicros: "3", lockedMicros: "0", totalMicros: "3", holdingValueMicros: "5", gainMicros: "1" }],
      standings: [{ rank: 1, userId: "member", displayName: "Member", availableMicros: "3", lockedMicros: "0", totalMicros: "3", priceMicros: "1666667", notionalValueMicros: "5", gainMicros: "1" }],
      orders: [{ id: "o", seasonId: "s", memberId: "member", memberDisplayName: "Member", actorId: "commissioner", mode: "shares", requestedMicros: "3", sharesMicros: "3", valueMicros: "4", priceMicros: "1333333", reversalOf: null, reason: "Initial issue", commandId: "order-command", createdAt: "2026-01-01T00:00:00.000Z" }],
      ledger: [{ id: "l", seasonId: "s", memberId: "member", memberDisplayName: "Member", actorId: "commissioner", availableDelta: "3", lockedDelta: "0", floatDelta: "3", notionalDelta: "4", causationId: "o", kind: "share_order", createdAt: "2026-01-01T00:00:00.000Z" }],
      settlements: [], wagerCorrections: [], eventResults: [],
      annotations: [{ annotationId: "a", authorDisplayName: "Commissioner", text: "Done", createdAt: "2026-02-01T00:00:00.000Z" }], wagers: [wager]
    });
    expect(history.annotations).toHaveLength(1);
    expect(history.season.priceMicros).toBe("1666667");
    expect(history.season.rulesetVersion).toBe("SHARE_POOL_2026_V1");
    expect(() => ReadSeasonHistory.parse({ ...history, season: { ...history.season, rulesetVersion: undefined } })).toThrow();
    expect(() => ReadSeasonHistory.parse({ ...history, accounts: [{ ...history.accounts[0], gainMicros: "01" }] })).toThrow();
  });

  it("accepts owner-visible parlay settlement odds and nullable audit settlement odds", () => {
    const parlay = { ...wager, type: "parlay", riskMicros: "1000000", acceptedOdds: 250, rulesetVersion: "PARLAY_2026_V1", outcome: "won", returnMicros: "3500000", profitMicros: "2500000", settledAt: "2026-01-02T00:00:00.000Z", settledOdds: 250 };
    expect(ReadActivity.parse({ commandVersion: "1", activity: { orders: [], wagers: [parlay] } }).activity.wagers[0]).toMatchObject({ type: "parlay", settledOdds: 250 });
    const providerResults = [{ eventId: "event-1", league: "nfl", status: "final", homeScore: 24, awayScore: 17, correctionVersion: "provider-1" }];
    const win = { id: "settlement", wagerId: "w", resultVersion: '[["event-1","provider-1"]]', outcome: "win", returnMicros: "3500000", profitMicros: "2500000", settledOdds: 250, sourceResult: providerResults, reversalOf: null, actorId: "system", reason: null, createdAt: "2026-01-02T00:00:00.000Z" };
    expect(auditSettlement.parse(win).settledOdds).toBe(250);
    expect(auditSettlement.parse({ ...win, settledOdds: null }).settledOdds).toBeNull();
    const refund = { id: "refund", wagerId: "w", resultVersion: '[["event-1","provider-1"]]', outcome: "refund", returnMicros: "1000000", profitMicros: "0", settledOdds: null, sourceResult: providerResults, reversalOf: null, actorId: "system", reason: null, createdAt: "2026-01-02T00:00:00.000Z" };
    expect(auditSettlement.parse(refund).settledOdds).toBeNull();
    expect(() => auditSettlement.parse({ ...refund, settledOdds: undefined })).toThrow();
    expect(() => auditSettlement.parse({ ...refund, settledOdds: 250 })).toThrow();
    const ownerLeg = { eventId: "event-1", league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-01-01T00:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", market: "spread", selection: "home", originalLine: "-3", originalOdds: 100, eventStartsAt: "2026-01-02T00:00:00.000Z" };
    const openOwner = { ...wager, status: "open", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", legs: [ownerLeg] };
    const historicalOwner = { ...openOwner, status: "won", outcome: "won", returnMicros: "2000000", profitMicros: "1000000", settledAt: "2026-01-02T00:00:00.000Z", settledOdds: null };
    expect(ReadMyWagers.parse({ commandVersion: "1", wagers: [openOwner, historicalOwner] }).wagers.map((ticket) => ticket.status)).toEqual(["open", "won"]);
    for (const field of ["riskMicros", "acceptedOdds", "rulesetVersion", "legs"] as const) {
      const { [field]: _missing, ...incomplete } = openOwner;
      expect(() => ReadMyWagers.parse({ commandVersion: "1", wagers: [incomplete] })).toThrow();
    }
    expect(() => ReadMyWagers.parse({ commandVersion: "1", wagers: [{ ...openOwner, riskMicros: "0" }] })).toThrow();
    expect(() => ReadMyWagers.parse({ commandVersion: "1", wagers: [{ ...openOwner, acceptedOdds: 0 }] })).toThrow();
    expect(() => ReadMyWagers.parse({ commandVersion: "1", wagers: [{ ...openOwner, legs: [] }] })).toThrow();
    for (const field of ["outcome", "returnMicros", "profitMicros", "settledAt", "settledOdds"] as const) {
      const { [field]: _missing, ...incomplete } = historicalOwner;
      expect(() => ReadMyWagers.parse({ commandVersion: "1", wagers: [incomplete] })).toThrow();
    }
    expect(() => ReadMyWagers.parse({ commandVersion: "1", wagers: [{ ...historicalOwner, settledOdds: "250" }] })).toThrow();
    const invalidSettledOdds = ReadMyWagers.safeParse({ commandVersion: "1", wagers: [{ ...historicalOwner, settledOdds: 0 }] });
    expect(invalidSettledOdds.success).toBe(false);
    if (!invalidSettledOdds.success) expect(invalidSettledOdds.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["wagers", 0, "settledOdds"], message: "American odds cannot be zero." })]));
    expect(() => ReadMyWagers.parse({ commandVersion: "1", wagers: [], unexpected: true })).toThrow();
  });

  it("exactly validates automatic, manual, open-source, and reversal audit evidence", () => {
    const providerResults = [{ eventId: "event-1", league: "nfl", status: "final", homeScore: 24, awayScore: 17, correctionVersion: "provider-1", eventName: "Week 1", postseason: false }];
    const correctedResults = [{ eventId: "event-1", league: "nfl", status: "final", homeScore: 17, awayScore: 24, correctionVersion: "official-2" }];
    const commissionerEvidence = { source: "commissioner_correction", commandId: "command", correctedResults, derived: { outcome: "loss", odds: null } };
    const exported = {
      format: "share-value-pool-audit-v1", commandVersion: "3", pool: { id: "p", slug: "pool", name: "Pool", commissionerId: "c", signupsOpen: true, commandVersion: "3" },
      seasons: [{ id: "s", label: "Season", rulesetVersion: "SHARE_POOL_2026_V1", state: "closed", openedAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-02-01T00:00:00.000Z", closeReason: "super_bowl_final", floatMicros: "0", notionalMicros: "0", defaultMode: null, defaultAmountMicros: null, commandVersion: "3" }], accounts: [], orders: [], ledger: [],
      seasonProviderResults: [{ seasonId: "s", eventId: "event-1", league: "nfl", correctionVersion: "provider-1", observedAt: "2026-02-01T00:00:00.000Z", appendOrder: "1", result: providerResults[0] }],
      settlements: [
        { id: "settlement", wagerId: "w", resultVersion: '[["event-1","provider-1"]]', outcome: "win", returnMicros: "2000000", profitMicros: "1000000", settledOdds: 100, sourceResult: providerResults, reversalOf: null, actorId: "system", reason: null, createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "reversal", wagerId: "w", resultVersion: '[["event-1","provider-1"]]', outcome: "reversal", returnMicros: "-2000000", profitMicros: "-1000000", settledOdds: null, sourceResult: providerResults, reversalOf: "settlement", actorId: "c", reason: "Official correction", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "manual", wagerId: "w", resultVersion: 'commissioner:command:[["event-1","official-2"]]', outcome: "loss", returnMicros: "0", profitMicros: "0", settledOdds: null, sourceResult: commissionerEvidence, reversalOf: "settlement", actorId: "c", reason: "Official correction", createdAt: "2026-01-01T00:00:00.000Z" }
      ],
      wagerCorrections: [
        { id: "correction", wagerId: "w", actorId: "c", reason: "Official correction", sourceResult: providerResults, replacementResult: commissionerEvidence, commandId: "command", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "open-correction", wagerId: "open-w", actorId: "c", reason: "Settle missing provider result", sourceResult: { status: "open", wagerId: "open-w" }, replacementResult: { ...commissionerEvidence, commandId: "open-command" }, commandId: "open-command", createdAt: "2026-01-01T00:00:00.000Z" }
      ],
      administrationAudit: [], seasonAnnotations: [], wagers: []
    };
    expect(auditExportResponse.parse(exported).settlements.map(({ outcome }) => outcome)).toEqual(["win", "reversal", "loss"]);
    expect(auditExportResponse.parse(exported).seasonProviderResults[0]).toMatchObject({ seasonId: "s", appendOrder: "1", result: providerResults[0] });
    expect(() => auditExportResponse.parse({ ...exported, seasons: [{ ...exported.seasons[0], rulesetVersion: undefined }] })).toThrow();
    expect(() => auditExportResponse.parse({ ...exported, seasonProviderResults: undefined })).toThrow();
    for (const result of [undefined, "raw-json", { ...providerResults[0], homeScore: null }, { ...providerResults[0], extra: true }]) {
      expect(() => auditExportResponse.parse({ ...exported, seasonProviderResults: [{ ...exported.seasonProviderResults[0], result }] })).toThrow();
    }
    expect(() => auditExportResponse.parse({ ...exported, seasonProviderResults: [{ ...exported.seasonProviderResults[0], appendOrder: "01" }] })).toThrow();
    expect(() => auditExportResponse.parse({ ...exported, seasonProviderResults: [{ ...exported.seasonProviderResults[0], eventId: "other-event" }] })).toThrow();
    expect(() => auditExportResponse.parse({ ...exported, seasonProviderResults: [{ ...exported.seasonProviderResults[0], seasonId: "other-season" }] })).toThrow();
    expect(() => auditExportResponse.parse({ ...exported, seasonProviderResults: [
      { ...exported.seasonProviderResults[0], correctionVersion: "provider-2", appendOrder: "2", result: { ...providerResults[0], correctionVersion: "provider-2" } },
      exported.seasonProviderResults[0]
    ] })).toThrow();
    const crossLeagueResults = [providerResults[0], { ...providerResults[0], league: "ncaaf" as const }];
    expect(auditExportResponse.parse({ ...exported, settlements: [{ ...exported.settlements[0], resultVersion: '[["event-1","provider-1"],["event-1","provider-1"]]', sourceResult: crossLeagueResults }] }).settlements[0].sourceResult).toEqual(crossLeagueResults);
    expect(() => auditExportResponse.parse({ ...exported, settlements: [{ ...exported.settlements[0], resultVersion: '[["event-1","provider-1"],["event-1","provider-1"]]', sourceResult: [providerResults[0], providerResults[0]] }] })).toThrow();
    expect(() => auditExportResponse.parse({ ...exported, settlements: [{ ...exported.settlements[0], outcome: "won" }] })).toThrow();
    expect(() => auditExportResponse.parse({ ...exported, settlements: [{ ...exported.settlements[0], returnMicros: "01" }] })).toThrow();
    expect(() => auditExportResponse.parse({ ...exported, settlements: [{ ...exported.settlements[0], resultVersion: "provider-1" }] })).toThrow();
    expect(() => auditExportResponse.parse({ ...exported, settlements: [{ ...exported.settlements[2], outcome: "win" }] })).toThrow();
    expect(() => auditExportResponse.parse({ ...exported, wagerCorrections: [{ ...exported.wagerCorrections[0], reason: "" }] })).toThrow();

    for (const sourceResult of [undefined, null, 1, "result", {}, [{ ...providerResults[0], homeScore: null }], [{ ...providerResults[0], extra: true }]]) {
      expect(() => auditExportResponse.parse({ ...exported, settlements: [{ ...exported.settlements[0], sourceResult }] })).toThrow();
    }
    for (const replacementResult of [undefined, false, {}, { ...commissionerEvidence, commandId: "other-command" }, { ...commissionerEvidence, derived: { outcome: "win", odds: null } }, { source: "commissioner_void", commandId: "command", outcome: "win" }]) {
      expect(() => auditExportResponse.parse({ ...exported, wagerCorrections: [{ ...exported.wagerCorrections[0], replacementResult }] })).toThrow();
    }
    expect(() => auditExportResponse.parse({ ...exported, wagerCorrections: [{ ...exported.wagerCorrections[1], sourceResult: { status: "open", wagerId: "other-wager" } }] })).toThrow();
  });
});

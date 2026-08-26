import { describe, expect, it } from "vitest";
import { auditExportResponse, OddsBoardResponse, ReadActivity, ReadPoolView, ReadSeasonHistory, ReadStandings } from "../../src/contracts/http";

describe("T11 member read contracts", () => {
  const wager = { wagerId: "w", seasonId: "s", memberId: "member", memberDisplayName: "Member", type: "straight", status: "won", confirmedAt: "2026-01-01T00:00:00.000Z" };
  it("strictly describes truthful odds-board feed observations and offer sources", () => {
    const response = {
      offers: [{ eventId: "event-1", league: "nfl", homeTeam: "Home", awayTeam: "Away", startsAt: "2030-09-01T12:00:00.000Z", market: "spread", canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z", offerVersion: "v1", policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] }],
      feed: { status: "current", message: "Canonical offers are current.", lastPolledAt: "2030-09-01T10:01:00.000Z", lastSuccessAt: "2030-09-01T10:01:00.000Z" }
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
    const view = { commandVersion: "1", pool: { poolId: "p", slug: "pool", name: "Pool", commissionerId: "owner", signupsOpen: true }, activeSeason: summary, nextDraftSeason: null, latestClosedSeason: null, currentMember: { memberId: "owner", role: "commissioner", seasonBalances: [{ seasonId: "s", availableMicros: "0", lockedMicros: "0" }] }, members: [{ memberId: "owner", displayName: "Owner", role: "commissioner", status: "active" }], commissioner: { seasonOrders: [] } };
    expect(ReadPoolView.parse(view).activeSeason?.rulesetVersion).toBe("SHARE_POOL_2026_V1");
    expect(() => ReadPoolView.parse({ ...view, activeSeason: { ...summary, rulesetVersion: undefined } })).toThrow();
    expect(ReadPoolView.parse({ ...view, activeSeason: { ...summary, rulesetVersion: "FUTURE_RULES_V9" } }).activeSeason?.rulesetVersion).toBe("FUTURE_RULES_V9");
  });

  it("accepts canonical standings and rejects noncanonical accounting", () => {
    expect(ReadStandings.parse({ commandVersion: "1", standings: [{ rank: 1, userId: "u", displayName: "Member", availableMicros: "0", lockedMicros: "0", totalMicros: "0", priceMicros: "1000000", notionalValueMicros: "0", gainMicros: "0" }] }).standings).toHaveLength(1);
    expect(() => ReadStandings.parse({ commandVersion: "1", standings: [{ rank: 1, userId: "u", displayName: "Member", availableMicros: "01", lockedMicros: "0", totalMicros: "0", priceMicros: "1000000", notionalValueMicros: "0", gainMicros: "0" }] })).toThrow();
  });
  it("requires redacted wager shapes, safe season identity, and immutable history fields", () => {
    expect(ReadActivity.parse({ commandVersion: "1", activity: { orders: [], wagers: [wager] } }).activity.wagers[0]).toMatchObject({ seasonId: "s" });
    expect(ReadActivity.parse({ commandVersion: "1", activity: { orders: [], wagers: [wager] } }).activity.wagers[0]).not.toHaveProperty("riskMicros");
    expect(() => ReadActivity.parse({ commandVersion: "1", activity: { orders: [], wagers: [{ ...wager, seasonId: undefined }] } })).toThrow();
    expect(() => ReadActivity.parse({ commandVersion: "1", activity: { orders: [], wagers: [{ ...wager, memberId: undefined }] } })).toThrow();
    expect(() => ReadActivity.parse({ commandVersion: "1", activity: { orders: [], wagers: [{ ...wager, memberDisplayName: undefined }] } })).toThrow();
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

  it("exactly validates automatic, manual, open-source, and reversal audit evidence", () => {
    const providerResults = [{ eventId: "event-1", league: "nfl", status: "final", homeScore: 24, awayScore: 17, correctionVersion: "provider-1", eventName: "Week 1", postseason: false }];
    const correctedResults = [{ eventId: "event-1", league: "nfl", status: "final", homeScore: 17, awayScore: 24, correctionVersion: "official-2" }];
    const commissionerEvidence = { source: "commissioner_correction", commandId: "command", correctedResults, derived: { outcome: "loss", odds: null } };
    const exported = {
      format: "share-value-pool-audit-v1", commandVersion: "3", pool: { id: "p", slug: "pool", name: "Pool", commissionerId: "c", signupsOpen: true, commandVersion: "3" },
      seasons: [{ id: "s", label: "Season", rulesetVersion: "SHARE_POOL_2026_V1", state: "closed", openedAt: "2026-01-01T00:00:00.000Z", closedAt: "2026-02-01T00:00:00.000Z", closeReason: "super_bowl_final", floatMicros: "0", notionalMicros: "0", defaultMode: null, defaultAmountMicros: null, commandVersion: "3" }], accounts: [], orders: [], ledger: [],
      seasonProviderResults: [{ seasonId: "s", eventId: "event-1", league: "nfl", correctionVersion: "provider-1", observedAt: "2026-02-01T00:00:00.000Z", appendOrder: "1", result: providerResults[0] }],
      settlements: [
        { id: "settlement", wagerId: "w", resultVersion: '[["event-1","provider-1"]]', outcome: "win", returnMicros: "2000000", profitMicros: "1000000", sourceResult: providerResults, reversalOf: null, actorId: "system", reason: null, createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "reversal", wagerId: "w", resultVersion: '[["event-1","provider-1"]]', outcome: "reversal", returnMicros: "-2000000", profitMicros: "-1000000", sourceResult: providerResults, reversalOf: "settlement", actorId: "c", reason: "Official correction", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "manual", wagerId: "w", resultVersion: 'commissioner:command:[["event-1","official-2"]]', outcome: "loss", returnMicros: "0", profitMicros: "0", sourceResult: commissionerEvidence, reversalOf: "settlement", actorId: "c", reason: "Official correction", createdAt: "2026-01-01T00:00:00.000Z" }
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

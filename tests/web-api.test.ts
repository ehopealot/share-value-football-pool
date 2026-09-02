import { describe, expect, it, vi } from "vitest";
import { api, ApiError, commandOutcome, errorMessage, parseAuditExportSuccess, parseOddsBoardSuccess } from "../src/web/api";
import { FrozenAdminCommand } from "../src/web/admin-command";
import { boardEnablesWagerReview } from "../src/web/pages/OddsPage";

describe("wager recovery messages", () => {
  it("rejects malformed odds-board feed observations at the browser boundary", () => {
    const response = { offers: [], feed: { status: "no-offer", message: "No current odds are available.", lastPolledAt: null, lastSuccessAt: null } };
    expect(parseOddsBoardSuccess(response)).toEqual(response);
    expect(() => parseOddsBoardSuccess({ offers: [], feed: { ...response.feed, lastPolledAt: undefined } })).toThrow();
    expect(() => parseOddsBoardSuccess({ offers: [], feed: { ...response.feed, status: "made-up" } })).toThrow();
    expect(() => parseOddsBoardSuccess({ offers: [], feed: { ...response.feed, status: "current" } })).toThrow();
    const offer = { eventId: "event-1", league: "nfl", homeTeam: "Home", awayTeam: "Away", startsAt: "2030-09-01T12:00:00.000Z", market: "spread", canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z", offerVersion: "v1", policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -110, point: -3 }] };
    for (const status of ["stale", "provider-error", "no-offer"] as const) {
      const unavailable = { offers: [offer], feed: { ...response.feed, status } };
      expect(() => parseOddsBoardSuccess(unavailable)).toThrow();
      expect(boardEnablesWagerReview(unavailable)).toBe(false);
    }
    expect(boardEnablesWagerReview({ offers: [offer], feed: { ...response.feed, status: "current" } })).toBe(true);
  });

  it("uses a concise recent-auth error", () => {
    expect(errorMessage(new ApiError("RECENT_AUTH_REQUIRED", 403))).toBe("Sign in again.");
  });
  it("centralizes stale, retryable, and terminal confirmation outcomes", () => {
    for (const code of ["LINE_CHANGED", "ORDER_QUOTE_STALE"]) expect(commandOutcome(new ApiError(code, 400))).toBe("stale");
    for (const error of [new ApiError("POOL_NOT_AVAILABLE", 503), new ApiError("POOL_UNAVAILABLE", 503), new ApiError("RECENT_AUTH_REQUIRED", 403), new ApiError("UNKNOWN", 500), new Error("transport")]) expect(commandOutcome(error)).toBe("retryable");
    expect(commandOutcome(new ApiError("MARKET_LOCKED", 400))).toBe("terminal");
  });

  it("runtime-validates persisted result evidence at the browser audit boundary", () => {
    const providerResults = [{ eventId: "event-1", league: "nfl", status: "final", homeScore: 24, awayScore: 17, correctionVersion: "provider-1" }];
    const replacementResult = { source: "commissioner_correction", commandId: "correction-command", correctedResults: [{ eventId: "event-1", league: "nfl", status: "final", homeScore: 17, awayScore: 24, correctionVersion: "official-2" }], derived: { outcome: "loss", odds: null } };
    const exported = {
      format: "share-value-pool-audit-v1", commandVersion: "3", pool: { id: "p", slug: "pool", name: "Pool", commissionerId: "c", signupsOpen: true, commandVersion: "3" },
      seasons: [], seasonProviderResults: [], accounts: [], orders: [], ledger: [],
      settlements: [
        { id: "automatic", wagerId: "w", resultVersion: '[["event-1","provider-1"]]', outcome: "win", returnMicros: "2000000", profitMicros: "1000000", sourceResult: providerResults, reversalOf: null, actorId: "system", reason: null, createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "reversal", wagerId: "w", resultVersion: '[["event-1","provider-1"]]', outcome: "reversal", returnMicros: "-2000000", profitMicros: "-1000000", sourceResult: providerResults, reversalOf: "automatic", actorId: "c", reason: "Official correction", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "manual", wagerId: "w", resultVersion: 'commissioner:correction-command:[["event-1","official-2"]]', outcome: "loss", returnMicros: "0", profitMicros: "0", sourceResult: replacementResult, reversalOf: "automatic", actorId: "c", reason: "Official correction", createdAt: "2026-01-01T00:00:00.000Z" }
      ],
      wagerCorrections: [{ id: "correction", wagerId: "w", actorId: "c", reason: "Official correction", sourceResult: providerResults, replacementResult, commandId: "correction-command", createdAt: "2026-01-01T00:00:00.000Z" }],
      administrationAudit: [], seasonAnnotations: [], wagers: []
    };
    expect(parseAuditExportSuccess(exported).settlements).toHaveLength(3);
    for (const sourceResult of [undefined, "provider-1", { status: "final" }, [{ ...providerResults[0], awayScore: null }]]) {
      expect(() => parseAuditExportSuccess({ ...exported, settlements: [{ ...exported.settlements[0], sourceResult }] })).toThrow();
    }
    for (const replacement of [undefined, 2, { ...replacementResult, derived: { outcome: "loss", odds: 100 } }]) {
      expect(() => parseAuditExportSuccess({ ...exported, wagerCorrections: [{ ...exported.wagerCorrections[0], replacementResult: replacement }] })).toThrow();
    }
  });

  it("preserves exact owner wager fields while parsing a time-redacted audit export", () => {
    const exported = {
      format: "share-value-pool-audit-v1", commandVersion: "3", pool: { id: "p", slug: "pool", name: "Pool", commissionerId: "c", signupsOpen: true, commandVersion: "3" },
      seasons: [], seasonProviderResults: [], accounts: [], orders: [], ledger: [], settlements: [], wagerCorrections: [], administrationAudit: [], seasonAnnotations: [],
      wagers: [{ wagerId: "w", seasonId: "s", memberId: "member", memberDisplayName: "Member", type: "teaser", status: "open", confirmedAt: "2026-01-01T00:00:00.000Z", weekStart: "2025-12-30T05:00:00.000Z", performanceMicros: "0", riskMicros: "900719925474099312345678", acceptedOdds: -120, rulesetVersion: "SHARE_POOL_2026_V1", legs: [{ eventId: "started-event", league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-01-01T00:00:00.000Z", policyVersion: "policy", offerVersion: "offer", market: "spread", selection: "home", originalOdds: -110, eventStartsAt: "2026-01-02T00:00:00.000Z" }] }]
    };
    expect(parseAuditExportSuccess(exported).wagers[0]).toMatchObject({ riskMicros: "900719925474099312345678", acceptedOdds: -120, rulesetVersion: "SHARE_POOL_2026_V1", legs: [{ eventId: "started-event" }] });
    expect(JSON.stringify(exported)).not.toContain("future-event");
  });

  it("uses a concise regrade-before-start error", () => {
    expect(errorMessage(new ApiError("WAGER_NOT_STARTED", 409))).toBe("Wager has not started.");
  });

  it("uses a concise active-season history error", () => {
    expect(errorMessage(new ApiError("SEASON_NOT_CLOSED", 400))).toBe("Season is not closed.");
  });
});

describe("frozen administration command identity", () => {
  it("sends Super Bowl confirmation through the bounded command transport", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ commandVersion: "2" }), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      await api.confirmSuperBowl("pool", "season/one", "event", "frozen-key");
      expect(fetchMock).toHaveBeenCalledWith("/api/p/pool/admin/seasons/season%2Fone/super-bowl/confirm", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ eventId: "event", idempotencyKey: "frozen-key" }),
        signal: expect.any(AbortSignal)
      }));
    } finally { fetchMock.mockRestore(); }
  });

  it("replays the identical immutable body and key after a lost response, then retires it on success", async () => {
    const command = new FrozenAdminCommand<{ text: string; idempotencyKey: string }>();
    let text = "Original note";
    const received: Array<{ text: string; idempotencyKey: string }> = [];
    await expect(command.run("annotation:s0", () => ({ text, idempotencyKey: "key-1" }), async (body) => { received.push(body); throw new Error("response lost"); })).rejects.toThrow("response lost");
    text = "Changed without retirement";
    await command.run("annotation:s0", () => ({ text, idempotencyKey: "key-2" }), async (body) => { received.push(body); return {}; });
    await command.run("annotation:s0", () => ({ text, idempotencyKey: "key-3" }), async (body) => { received.push(body); return {}; });
    expect(received).toEqual([
      { text: "Original note", idempotencyKey: "key-1" },
      { text: "Original note", idempotencyKey: "key-1" },
      { text: "Changed without retirement", idempotencyKey: "key-3" }
    ]);
  });

  it("suppresses rapid duplicate submission while a command is in flight and retires on semantic edit", async () => {
    const command = new FrozenAdminCommand<{ resultVersion: string; idempotencyKey: string }>();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const received: Array<{ resultVersion: string; idempotencyKey: string }> = [];
    const first = command.run("regrade:w1", () => ({ resultVersion: "result-1", idempotencyKey: "key-1" }), async (body) => { received.push(body); await barrier; throw new Error("response lost"); });
    expect(command.pending).toBe(true);
    await expect(command.run("regrade:w1", () => ({ resultVersion: "result-2", idempotencyKey: "key-2" }), async (body) => { received.push(body); })).resolves.toBeUndefined();
    release();
    await expect(first).rejects.toThrow("response lost");
    command.retire();
    await command.run("regrade:w1", () => ({ resultVersion: "result-3", idempotencyKey: "key-3" }), async (body) => { received.push(body); });
    expect(received).toEqual([
      { resultVersion: "result-1", idempotencyKey: "key-1" },
      { resultVersion: "result-3", idempotencyKey: "key-3" }
    ]);
  });
});

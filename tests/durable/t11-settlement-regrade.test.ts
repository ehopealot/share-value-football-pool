import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import { runSettlementAlarm } from "../../src/durable/alarm";
import type { FinalResultVersion, ResultSource } from "../../src/odds/result-source";

const bindings = env as unknown as { POOL_DO: DurableObjectNamespace; DB: D1Database };
const send = async (slug: string, command: any): Promise<Record<string, unknown>> => {
  const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug));
  const post = async (value: unknown) => (await stub.fetch("https://pool.test/command", { method: "POST", body: JSON.stringify(value) })).json() as Promise<Record<string, unknown>>;
  if (command.type !== "PlaceStraightWager") return post(command);
  const quoteKey = `quote:${command.commandId}`;
  const quote = await quoteWager(slug, { ...command, quoteKey });
  if (quote.code) return quote;
  return post(placementFromQuote(command, quoteKey, quote));
};
const quoteWager = async (slug: string, command: any, quoteKey = command.quoteKey ?? `quote:${command.commandId}`): Promise<Record<string, unknown>> => {
  const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug));
  const post = async (value: unknown) => (await stub.fetch("https://pool.test/command", { method: "POST", body: JSON.stringify(value) })).json() as Promise<Record<string, unknown>>;
  const view = await post({ type: "ReadPoolView", commandId: `version:${quoteKey}`, actorId: command.actorId });
  const normalize = (item: any) => ({ ...item, adjustedLine: item.adjustedLine ?? item.originalLine, homeTeam: item.homeTeam ?? "Home", awayTeam: item.awayTeam ?? "Away" });
  const projection = {
    quoteKey, ownerMemberId: command.actorId, commandVersion: String(view.commandVersion), fingerprint: `fixture:${quoteKey}`,
    wagerId: command.wagerId, actorId: command.actorId, seasonId: command.seasonId, riskMicros: command.riskMicros,
    acceptedOdds: command.acceptedOdds, rulesetVersion: command.rulesetVersion, leg: normalize(command.leg)
  };
  return post({ type: "QuoteStraightWager", commandId: quoteKey, actorId: command.actorId, identity: { actorId: command.actorId, quoteKey, fingerprint: projection.fingerprint }, projection });
};
const placementFromQuote = (command: any, quoteKey: string, quote: any, mutationKey = command.commandId) => ({
  type: command.type, commandId: mutationKey, actorId: command.actorId, wagerId: command.wagerId,
  quoteKey, quotedCommandVersion: String(quote.commandVersion), seasonId: quote.seasonId, riskMicros: quote.riskMicros,
  acceptedOdds: quote.acceptedOdds, rulesetVersion: quote.rulesetVersion, leg: quote.leg
});
const storage = <T>(slug: string, callback: (state: DurableObjectState) => T) => runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), (_instance, state) => callback(state));

/** Three issued shares fund a 3,000,000 float and notional; each test risks one share at +100 (profit 1,000,000). */
async function fundedPool(slug = `regrade-${crypto.randomUUID()}`) {
  await send(slug, { type: "InitializePool", commandId: "init", poolId: slug, slug, poolName: "Regrade", creatorId: "owner", creatorName: "Owner", password: "correct-password" });
  await send(slug, { type: "JoinPool", commandId: "join", actorId: "member", displayName: "Member", password: "correct-password" });
  await send(slug, { type: "CreateSeason", commandId: "draft", actorId: "owner", seasonId: "s1", label: "2026" });
  await send(slug, { type: "OpenSeason", commandId: "open", actorId: "owner", seasonId: "s1" });
  const quote = await send(slug, { type: "QuoteShareOrder", commandId: "quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "3000000" });
  await send(slug, { type: "ExecuteShareOrder", commandId: "fund", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "3000000", quote: { priceMicros: String(quote.priceMicros), commandVersion: String(quote.commandVersion) }, reason: "virtual funding" });
  return slug;
}
const leg = (eventId: string) => ({ eventId, league: "nfl" as const, canonicalBook: "DraftKings", retrievedAt: new Date().toISOString(), policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "offer-v1", canonicalOfferProof: { offerId: `${eventId}:spread:home`, eventId, offerVersion: "offer-v1", canonicalBook: "DraftKings", market: "spread" as const, selection: "home" as const, odds: -110, line: -3 }, market: "spread" as const, selection: "home" as const, originalLine: -3, adjustedLine: -3, originalOdds: -110, eventStartsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), homeTeam: "Home", awayTeam: "Away" });
const final = (eventId: string, homeScore: number, awayScore: number, correctionVersion = "1"): FinalResultVersion => ({ eventId, league: "nfl", status: "final", homeScore, awayScore, correctionVersion });
const advancePastWagerStart = (slug: string, wagerId: string) => runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), (instance, state) => {
  const startsAt = [...state.storage.sql.exec<{ starts_at: string }>("SELECT MAX(event_starts_at) AS starts_at FROM wager_leg WHERE wager_id = ?", wagerId)][0]!.starts_at;
  const currentTime = new Date(startsAt).getTime() + 1;
  (instance as unknown as { authoritativeTime(): Date }).authoritativeTime = () => new Date(currentTime);
  return currentTime;
});
const settle = async (slug: string, wagerId: string, result: FinalResultVersion) => {
  const currentTime = await advancePastWagerStart(slug, wagerId);
  return runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [result] } as ResultSource, currentTime));
};

/** Full durable state for one wager: balances, float/notional, current status, and the ordered immutable settlement chain. */
const wagerState = (slug: string, wagerId: string) => storage(slug, (state) => {
  const settlement = [...state.storage.sql.exec("SELECT id, outcome, return_micros, profit_micros, result_version, reversal_of, actor_id, reason FROM settlement WHERE wager_id = ? ORDER BY rowid", wagerId)]
    .map((row) => ({ id: String(row.id), outcome: String(row.outcome), returnMicros: String(row.return_micros), profitMicros: String(row.profit_micros), resultVersion: String(row.result_version), reversalOf: row.reversal_of === null ? null : String(row.reversal_of), actorId: String(row.actor_id), reason: row.reason === null ? null : String(row.reason) }));
  return {
    wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = ?", wagerId)][0],
    account: [...state.storage.sql.exec("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0],
    season: [...state.storage.sql.exec("SELECT float_micros, notional_micros, state FROM season WHERE id = 's1'")][0],
    settlementLedger: [...state.storage.sql.exec("SELECT kind, available_delta, locked_delta, float_delta FROM ledger_entry WHERE kind IN ('settlement', 'settlement_reversal') ORDER BY rowid")]
      .map((row) => ({ kind: String(row.kind), availableDelta: String(row.available_delta), lockedDelta: String(row.locked_delta), floatDelta: String(row.float_delta) })),
    settlement
  };
});

describe("PoolDO settlement regrade accounting", () => {
  beforeEach(async () => {
    await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]);
  });

  it("regrades a settled win to a loss by reversing its prior float profit through an immutable chain", async () => {
    const slug = await fundedPool();
    await send(slug, { type: "PlaceStraightWager", commandId: "place", actorId: "member", wagerId: "won-then-lost", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("win-loss-event") });
    await settle(slug, "won-then-lost", final("win-loss-event", 24, 17));
    // The win mints its profit into the float: 3,000,000 + 1,000,000, notional unchanged.
    expect(await wagerState(slug, "won-then-lost")).toMatchObject({ wager: { status: "won" }, account: { available_micros: "4000000", locked_micros: "0" }, season: { float_micros: "4000000", notional_micros: "3000000", state: "active" }, settlementLedger: [{ kind: "settlement", availableDelta: "2000000", lockedDelta: "-1000000", floatDelta: "1000000" }], settlement: [expect.objectContaining({ outcome: "win", returnMicros: "2000000", profitMicros: "1000000", resultVersion: '[["win-loss-event","1"]]', reversalOf: null, actorId: "system" })] });
    expect(await send(slug, { type: "RegradeWager", commandId: "regrade", actorId: "owner", wagerId: "won-then-lost", reason: "Official scoring correction", correctedResults: [final("win-loss-event", 10, 17, "official-loss-v2")] })).toMatchObject({ commandVersion: expect.any(String) });
    // The reversal must return the minted profit to the float before the loss destroys the risk: 4,000,000 - 1,000,000 - 1,000,000.
    expect(await wagerState(slug, "won-then-lost")).toEqual({
      wager: { status: "lost" },
      account: { available_micros: "2000000", locked_micros: "0" },
      season: { float_micros: "2000000", notional_micros: "3000000", state: "active" },
      settlementLedger: [
        { kind: "settlement", availableDelta: "2000000", lockedDelta: "-1000000", floatDelta: "1000000" },
        { kind: "settlement_reversal", availableDelta: "-2000000", lockedDelta: "1000000", floatDelta: "-1000000" },
        { kind: "settlement", availableDelta: "0", lockedDelta: "-1000000", floatDelta: "-1000000" }
      ],
      settlement: [
        expect.objectContaining({ outcome: "win", returnMicros: "2000000", profitMicros: "1000000", resultVersion: '[["win-loss-event","1"]]', reversalOf: null, actorId: "system", reason: null }),
        expect.objectContaining({ outcome: "reversal", returnMicros: "-2000000", profitMicros: "-1000000", resultVersion: '[["win-loss-event","1"]]', actorId: "owner", reason: "Official scoring correction" }),
        expect.objectContaining({ outcome: "loss", returnMicros: "0", profitMicros: "0", resultVersion: expect.stringContaining("official-loss-v2"), actorId: "owner", reason: "Official scoring correction" })
      ]
    });
    const chain = (await wagerState(slug, "won-then-lost")).settlement;
    expect(chain[1]!.reversalOf).toBe(chain[0]!.id);
    expect(chain[2]!.reversalOf).toBe(chain[0]!.id);
    // The published member read still maps the internal vocabulary to the current outcome.
    expect(await send(slug, { type: "ReadMyWagers", commandId: "current", actorId: "member" })).toMatchObject({ wagers: [expect.objectContaining({ wagerId: "won-then-lost", outcome: "lost", returnMicros: "0", profitMicros: "0" })] });
  }, 60_000);

  it("regrades a settled loss to a win by reversing its prior destroyed float through an immutable chain", async () => {
    const slug = await fundedPool();
    await send(slug, { type: "PlaceStraightWager", commandId: "place", actorId: "member", wagerId: "lost-then-won", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("loss-win-event") });
    await settle(slug, "lost-then-won", final("loss-win-event", 17, 24));
    // The loss destroys the risk into the float: 3,000,000 - 1,000,000, notional unchanged.
    expect(await wagerState(slug, "lost-then-won")).toMatchObject({ wager: { status: "lost" }, account: { available_micros: "2000000", locked_micros: "0" }, season: { float_micros: "2000000", notional_micros: "3000000", state: "active" }, settlementLedger: [{ kind: "settlement", availableDelta: "0", lockedDelta: "-1000000", floatDelta: "-1000000" }], settlement: [expect.objectContaining({ outcome: "loss", returnMicros: "0", profitMicros: "0", resultVersion: '[["loss-win-event","1"]]', reversalOf: null, actorId: "system" })] });
    expect(await send(slug, { type: "RegradeWager", commandId: "regrade", actorId: "owner", wagerId: "lost-then-won", reason: "Official scoring correction", correctedResults: [final("loss-win-event", 24, 17, "official-win-v2")] })).toMatchObject({ commandVersion: expect.any(String) });
    // The reversal must restore the destroyed risk to the float before the win mints its profit: 2,000,000 + 1,000,000 + 1,000,000.
    expect(await wagerState(slug, "lost-then-won")).toEqual({
      wager: { status: "won" },
      account: { available_micros: "4000000", locked_micros: "0" },
      season: { float_micros: "4000000", notional_micros: "3000000", state: "active" },
      settlementLedger: [
        { kind: "settlement", availableDelta: "0", lockedDelta: "-1000000", floatDelta: "-1000000" },
        { kind: "settlement_reversal", availableDelta: "0", lockedDelta: "1000000", floatDelta: "1000000" },
        { kind: "settlement", availableDelta: "2000000", lockedDelta: "-1000000", floatDelta: "1000000" }
      ],
      settlement: [
        expect.objectContaining({ outcome: "loss", returnMicros: "0", profitMicros: "0", resultVersion: '[["loss-win-event","1"]]', reversalOf: null, actorId: "system", reason: null }),
        expect.objectContaining({ outcome: "reversal", returnMicros: "0", profitMicros: "0", resultVersion: '[["loss-win-event","1"]]', actorId: "owner", reason: "Official scoring correction" }),
        expect.objectContaining({ outcome: "win", returnMicros: "2000000", profitMicros: "1000000", resultVersion: expect.stringContaining("official-win-v2"), actorId: "owner", reason: "Official scoring correction" })
      ]
    });
    const chain = (await wagerState(slug, "lost-then-won")).settlement;
    expect(chain[1]!.reversalOf).toBe(chain[0]!.id);
    expect(chain[2]!.reversalOf).toBe(chain[0]!.id);
    expect(await send(slug, { type: "ReadMyWagers", commandId: "current", actorId: "member" })).toMatchObject({ wagers: [expect.objectContaining({ wagerId: "lost-then-won", outcome: "won", returnMicros: "2000000", profitMicros: "1000000" })] });
  }, 60_000);
});

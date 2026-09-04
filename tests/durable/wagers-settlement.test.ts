import { applyD1Migrations, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import type { PoolCommand } from "../../src/durable/pool-commands";
import { runSettlementAlarm } from "../../src/durable/alarm";
import { settleWagers } from "../../src/durable/settlement";
import type { FinalResultVersion, ResultSource } from "../../src/odds/result-source";

const bindings = env as unknown as { POOL_DO: DurableObjectNamespace; DB: D1Database };
const send = async (slug: string, command: any): Promise<Record<string, unknown>> => {
  const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug));
  const post = async (value: unknown) => (await stub.fetch("https://pool.test/command", { method: "POST", body: JSON.stringify(value) })).json() as Promise<Record<string, unknown>>;
  if (command.type === "RegradeWager") {
    await runInDurableObject(stub, (instance, state) => {
      const startsAt = [...state.storage.sql.exec<{ starts_at: string }>("SELECT MAX(event_starts_at) AS starts_at FROM wager_leg WHERE wager_id = ?", command.wagerId)][0]?.starts_at;
      if (startsAt) (instance as unknown as { authoritativeTime(): Date }).authoritativeTime = () => new Date(new Date(startsAt).getTime() + 1);
    });
  }
  if (command.type !== "PlaceStraightWager" && command.type !== "PlaceTeaserWager" && command.type !== "PlaceParlayWager") return post(command);
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
    acceptedOdds: command.acceptedOdds, rulesetVersion: command.rulesetVersion,
    ...(command.type === "PlaceStraightWager" ? { leg: normalize(command.leg) } : { ...(command.type === "PlaceTeaserWager" ? { teaserPoints: command.teaserPoints } : {}), legs: command.legs.map(normalize) })
  };
  const type = command.type === "PlaceStraightWager" ? "QuoteStraightWager" : command.type === "PlaceTeaserWager" ? "QuoteTeaserWager" : "QuoteParlayWager";
  return post({ type, commandId: quoteKey, actorId: command.actorId, identity: { actorId: command.actorId, quoteKey, fingerprint: projection.fingerprint }, projection });
};
const placementFromQuote = (command: any, quoteKey: string, quote: any, mutationKey = command.commandId) => ({
  type: command.type, commandId: mutationKey, actorId: command.actorId, wagerId: command.wagerId,
  quoteKey, quotedCommandVersion: String(quote.commandVersion), seasonId: quote.seasonId, riskMicros: quote.riskMicros,
  acceptedOdds: quote.acceptedOdds, rulesetVersion: quote.rulesetVersion,
  ...(command.type === "PlaceStraightWager" ? { leg: quote.leg } : { ...(command.type === "PlaceTeaserWager" ? { teaserPoints: quote.teaserPoints } : {}), legs: quote.legs })
});
const direct = async (slug: string, command: unknown) => (await bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)).fetch("https://pool.test/command", { method: "POST", body: JSON.stringify(command) })).json() as Promise<Record<string, unknown>>;
const storage = <T>(slug: string, callback: (state: DurableObjectState) => T) => runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), (_instance, state) => callback(state));
const advancePastWagerStart = (slug: string, wagerId: string) => runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), (instance, state) => {
  const startsAt = [...state.storage.sql.exec<{ starts_at: string }>("SELECT MAX(event_starts_at) AS starts_at FROM wager_leg WHERE wager_id = ?", wagerId)][0]?.starts_at;
  if (startsAt) (instance as unknown as { authoritativeTime(): Date }).authoritativeTime = () => new Date(new Date(startsAt).getTime() + 1);
});

async function fundedPool(slug = `wagers-${crypto.randomUUID()}`) {
  await send(slug, { type: "InitializePool", commandId: "init", poolId: slug, slug, poolName: "Wagers", creatorId: "owner", creatorName: "Owner", password: "correct-password" });
  await send(slug, { type: "JoinPool", commandId: "join", actorId: "member", displayName: "Member", password: "correct-password" });
  await send(slug, { type: "CreateSeason", commandId: "draft", actorId: "owner", seasonId: "s1", label: "2026" });
  await send(slug, { type: "OpenSeason", commandId: "open", actorId: "owner", seasonId: "s1" });
  const quote = await send(slug, { type: "QuoteShareOrder", commandId: "quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "3000000" });
  await send(slug, { type: "ExecuteShareOrder", commandId: "fund", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "3000000", quote: { priceMicros: String(quote.priceMicros), commandVersion: String(quote.commandVersion) }, reason: "virtual funding" });
  return slug;
}
const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const leg = (eventId: string, eventStartsAt = future()) => ({ eventId, league: "nfl" as const, canonicalBook: "DraftKings", retrievedAt: new Date().toISOString(), policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "offer-v1", canonicalOfferProof: { offerId: `${eventId}:spread:home`, eventId, offerVersion: "offer-v1", canonicalBook: "DraftKings", market: "spread" as const, selection: "home" as const, odds: -110, line: -3 }, market: "spread" as const, selection: "home" as const, originalLine: -3, adjustedLine: -3, originalOdds: -110, eventStartsAt, homeTeam: "Home", awayTeam: "Away" });
const parlayLeg = (eventId: string, market: "spread" | "total" = "spread", line = market === "spread" ? -3 : 40, selection: "home" | "over" = market === "spread" ? "home" : "over") => ({ ...leg(eventId), market, selection, originalLine: line, adjustedLine: line, canonicalOfferProof: { ...leg(eventId).canonicalOfferProof, offerId: `${eventId}:${market}:${selection}`, market, selection, line } });
const reconciliation = (slug: string, eventId: string) => storage(slug, (state) => [...state.storage.sql.exec("SELECT phase, attempts, error_attempts, deadline_at, next_attempt_at, last_error FROM event_reconciliation WHERE event_id = ?", eventId)][0]);
const final = (eventId: string, correctionVersion = "1", homeScore = 24, awayScore = 17): FinalResultVersion => ({ eventId, league: "nfl", status: "final", homeScore, awayScore, correctionVersion });
const correctionEvidence = (eventId: string, correctionVersion: string, homeScore = 24, awayScore = 17, status: FinalResultVersion["status"] = "final"): FinalResultVersion => ({ eventId, league: "nfl", status, homeScore: status === "final" ? homeScore : null, awayScore: status === "final" ? awayScore : null, correctionVersion });

describe("PoolDO wagers and settlement", () => {
  beforeEach(async () => {
    await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]);
  });

  it("continues settling and regrading an accepted legacy seven-leg teaser", async () => {
    const slug = await fundedPool();
    await storage(slug, (state) => {
      const sql = state.storage.sql;
      sql.exec("INSERT INTO wager (id,season_id,owner_id,type,risk_micros,accepted_odds,status,ruleset_version,confirmed_at) VALUES ('legacy-seven','s1','member','teaser','1000000',800,'open','SHARE_POOL_2026_V1','2026-01-01T00:00:00.000Z')");
      for (let index = 0; index < 7; index++) sql.exec("INSERT INTO wager_leg (id,wager_id,event_id,league,canonical_book,retrieved_at,policy_version,offer_version,market,selection,original_line,original_odds,teaser_adjustment,adjusted_line,event_starts_at,is_super_bowl) VALUES (?, 'legacy-seven', ?, 'nfl','DraftKings','2026-01-01T00:00:00.000Z','CANONICAL_BOOKS_2026_V1','v1','spread','home','-3',-110,'6','3','2026-01-02T00:00:00.000Z',0)", `legacy-seven:${index}`, `legacy-seven-event-${index}`);
      sql.exec("UPDATE share_account SET available_micros='2000000',locked_micros='1000000' WHERE season_id='s1' AND member_id='member'");
      settleWagers(sql, Array.from({ length: 7 }, (_, index) => final(`legacy-seven-event-${index}`, "v1")));
    });
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT status FROM wager WHERE id='legacy-seven'")][0])).toEqual({ status: "won" });
    expect(await send(slug, { type: "RegradeWager", commandId: "legacy-seven-regrade", actorId: "owner", wagerId: "legacy-seven", reason: "official correction", correctedResults: Array.from({ length: 7 }, (_, index) => correctionEvidence(`legacy-seven-event-${index}`, "v2", index === 0 ? 10 : 24, 17)) })).toMatchObject({ commandVersion: expect.any(String) });
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT status FROM wager WHERE id='legacy-seven'")][0])).toEqual({ status: "lost" });
  }, 90_000);

  it("settles and regrades immutable parlays with effective odds while refunds keep settled odds null", async () => {
    const slug = await fundedPool();
    await send(slug, { type: "PlaceParlayWager", commandId: "parlay-win", actorId: "member", wagerId: "parlay-win", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 250, rulesetVersion: "PARLAY_2026_V1", legs: [parlayLeg("parlay-game", "spread", 0, "home"), parlayLeg("parlay-game", "total", 35, "over")] });
    await send(slug, { type: "PlaceParlayWager", commandId: "parlay-refund", actorId: "member", wagerId: "parlay-refund", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 250, rulesetVersion: "PARLAY_2026_V1", legs: [parlayLeg("refund-game", "spread", 0, "home"), parlayLeg("refund-game", "total", 40, "over")] });
    await storage(slug, (state) => settleWagers(state.storage.sql, [final("parlay-game", "v1", 24, 17), final("refund-game", "v1", 20, 20)]));
    expect(await storage(slug, (state) => ({ wagers: [...state.storage.sql.exec("SELECT id,status FROM wager WHERE type='parlay' ORDER BY id")], settlements: [...state.storage.sql.exec("SELECT wager_id,outcome,settled_odds FROM settlement WHERE outcome <> 'reversal' ORDER BY wager_id,rowid")] }))).toEqual({ wagers: [{ id: "parlay-refund", status: "refunded" }, { id: "parlay-win", status: "won" }], settlements: [{ wager_id: "parlay-refund", outcome: "refund", settled_odds: null }, { wager_id: "parlay-win", outcome: "win", settled_odds: 250 }] });
    await advancePastWagerStart(slug, "parlay-win");
    expect(await send(slug, { type: "RegradeWager", commandId: "parlay-regrade", actorId: "owner", wagerId: "parlay-win", reason: "official tie", correctedResults: [correctionEvidence("parlay-game", "v2", 20, 20)] })).toMatchObject({ commandVersion: expect.any(String) });
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT outcome,settled_odds,profit_micros FROM settlement WHERE wager_id='parlay-win' AND outcome <> 'reversal' ORDER BY rowid DESC LIMIT 1")][0])).toEqual({ outcome: "win", settled_odds: 100, profit_micros: "1000000" });

    await send(slug, { type: "PlaceParlayWager", commandId: "parlay-pending", actorId: "member", wagerId: "parlay-pending", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 300, rulesetVersion: "PARLAY_2026_V1", legs: [parlayLeg("known-loss", "spread", 0, "home"), parlayLeg("missing-result", "spread", 0, "home")] });
    await storage(slug, (state) => settleWagers(state.storage.sql, [final("known-loss", "partial", 10, 17)]));
    expect(await storage(slug, (state) => ({
      wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id='parlay-pending'")][0],
      account: [...state.storage.sql.exec("SELECT locked_micros FROM share_account WHERE season_id='s1' AND member_id='member'")][0],
      legs: [...state.storage.sql.exec("SELECT grade,result_version FROM wager_leg WHERE wager_id='parlay-pending' ORDER BY id")],
      settlement: [...state.storage.sql.exec("SELECT outcome,source_result_json FROM settlement WHERE wager_id='parlay-pending' AND outcome <> 'reversal'")][0]
    }))).toEqual({
      wager: { status: "lost" },
      account: { locked_micros: "0" },
      legs: [{ grade: "loss", result_version: "partial" }, { grade: null, result_version: null }],
      settlement: { outcome: "loss", source_result_json: JSON.stringify([final("known-loss", "partial", 10, 17)]) }
    });
  }, 90_000);

  it("settles a teaser as soon as one final leg loses", async () => {
    const slug = await fundedPool();
    await send(slug, { type: "PlaceTeaserWager", commandId: "teaser-early-loss", actorId: "member", wagerId: "teaser-early-loss", seasonId: "s1", riskMicros: "1000000", acceptedOdds: -120, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: [{ ...leg("teaser-loss"), adjustedLine: 3 }, { ...leg("teaser-pending"), adjustedLine: 3 }] });
    await storage(slug, (state) => settleWagers(state.storage.sql, [final("teaser-loss", "partial", 10, 17)]));
    expect(await storage(slug, (state) => ({
      wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id='teaser-early-loss'")][0],
      account: [...state.storage.sql.exec("SELECT available_micros,locked_micros FROM share_account WHERE season_id='s1' AND member_id='member'")][0],
      legs: [...state.storage.sql.exec("SELECT grade,result_version FROM wager_leg WHERE wager_id='teaser-early-loss' ORDER BY id")]
    }))).toEqual({ wager: { status: "lost" }, account: { available_micros: "2000000", locked_micros: "0" }, legs: [{ grade: "loss", result_version: "partial" }, { grade: null, result_version: null }] });
  }, 90_000);

  it("keeps non-losing partial multi-leg results open", async () => {
    const slug = await fundedPool();
    await send(slug, { type: "PlaceParlayWager", commandId: "parlay-partial-win", actorId: "member", wagerId: "parlay-partial-win", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 300, rulesetVersion: "PARLAY_2026_V1", legs: [parlayLeg("parlay-win"), parlayLeg("parlay-pending")] });
    await send(slug, { type: "PlaceTeaserWager", commandId: "teaser-partial-push", actorId: "member", wagerId: "teaser-partial-push", seasonId: "s1", riskMicros: "1000000", acceptedOdds: -120, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: [{ ...leg("teaser-push"), originalLine: -6, adjustedLine: 0, canonicalOfferProof: { ...leg("teaser-push").canonicalOfferProof, line: -6 } }, { ...leg("teaser-pending"), adjustedLine: 3 }] });
    await storage(slug, (state) => settleWagers(state.storage.sql, [final("parlay-win", "v1", 24, 17), final("teaser-push", "v1", 17, 17)]));
    expect(await storage(slug, (state) => ({ wagers: [...state.storage.sql.exec("SELECT id,status FROM wager WHERE id IN ('parlay-partial-win','teaser-partial-push') ORDER BY id")], account: [...state.storage.sql.exec("SELECT available_micros,locked_micros FROM share_account WHERE season_id='s1' AND member_id='member'")][0], settlements: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM settlement")][0] }))).toEqual({ wagers: [{ id: "parlay-partial-win", status: "open" }, { id: "teaser-partial-push", status: "open" }], account: { available_micros: "1000000", locked_micros: "2000000" }, settlements: { count: 0 } });
  }, 90_000);

  it("reopens an automatic early loss when its only losing result is corrected", async () => {
    const slug = await fundedPool();
    await send(slug, { type: "PlaceParlayWager", commandId: "early-correction", actorId: "member", wagerId: "early-correction", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 300, rulesetVersion: "PARLAY_2026_V1", legs: [parlayLeg("corrected-loss"), parlayLeg("still-pending")] });
    await storage(slug, (state) => settleWagers(state.storage.sql, [final("corrected-loss", "loss-v1", 10, 17)]));
    const afterLoss = await storage(slug, (state) => JSON.stringify({ wager: [...state.storage.sql.exec("SELECT status,settled_result_version FROM wager WHERE id='early-correction'")][0], account: [...state.storage.sql.exec("SELECT available_micros,locked_micros FROM share_account WHERE season_id='s1' AND member_id='member'")][0], season: [...state.storage.sql.exec("SELECT float_micros FROM season WHERE id='s1'")][0], settlements: [...state.storage.sql.exec("SELECT * FROM settlement WHERE wager_id='early-correction' ORDER BY rowid")], ledger: [...state.storage.sql.exec("SELECT * FROM ledger_entry WHERE causation_id LIKE '%early-correction%' OR causation_id LIKE 'reversal:%' ORDER BY rowid")], outbox: [...state.storage.sql.exec("SELECT * FROM outbox WHERE event_type IN ('SettlementApplied','SettlementRegraded') ORDER BY rowid")] }));
    await storage(slug, (state) => settleWagers(state.storage.sql, [final("corrected-loss", "loss-v1", 10, 17)]));
    expect(await storage(slug, (state) => JSON.stringify({ wager: [...state.storage.sql.exec("SELECT status,settled_result_version FROM wager WHERE id='early-correction'")][0], account: [...state.storage.sql.exec("SELECT available_micros,locked_micros FROM share_account WHERE season_id='s1' AND member_id='member'")][0], season: [...state.storage.sql.exec("SELECT float_micros FROM season WHERE id='s1'")][0], settlements: [...state.storage.sql.exec("SELECT * FROM settlement WHERE wager_id='early-correction' ORDER BY rowid")], ledger: [...state.storage.sql.exec("SELECT * FROM ledger_entry WHERE causation_id LIKE '%early-correction%' OR causation_id LIKE 'reversal:%' ORDER BY rowid")], outbox: [...state.storage.sql.exec("SELECT * FROM outbox WHERE event_type IN ('SettlementApplied','SettlementRegraded') ORDER BY rowid")] }))).toBe(afterLoss);

    await storage(slug, (state) => settleWagers(state.storage.sql, [final("corrected-loss", "win-v2", 24, 17)]));
    expect(await storage(slug, (state) => ({
      wager: [...state.storage.sql.exec("SELECT status,settled_result_version FROM wager WHERE id='early-correction'")][0],
      account: [...state.storage.sql.exec("SELECT available_micros,locked_micros FROM share_account WHERE season_id='s1' AND member_id='member'")][0],
      season: [...state.storage.sql.exec("SELECT state,float_micros FROM season WHERE id='s1'")][0],
      legs: [...state.storage.sql.exec("SELECT grade,result_version FROM wager_leg WHERE wager_id='early-correction' ORDER BY id")],
      settlements: [...state.storage.sql.exec("SELECT outcome,reversal_of FROM settlement WHERE wager_id='early-correction' ORDER BY rowid")]
    }))).toEqual({ wager: { status: "open", settled_result_version: null }, account: { available_micros: "2000000", locked_micros: "1000000" }, season: { state: "active", float_micros: "3000000" }, legs: [{ grade: "win", result_version: "win-v2" }, { grade: null, result_version: null }], settlements: [{ outcome: "loss", reversal_of: null }, { outcome: "reversal", reversal_of: expect.any(String) }] });

    await storage(slug, (state) => settleWagers(state.storage.sql, [final("corrected-loss", "win-v2", 24, 17), final("still-pending", "loss-v1", 10, 17)]));
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT status FROM wager WHERE id='early-correction'")][0])).toEqual({ status: "lost" });
  }, 90_000);

  it("does not reopen a commissioner settlement from partial provider evidence", async () => {
    const slug = await fundedPool();
    await send(slug, { type: "PlaceParlayWager", commandId: "manual-parlay", actorId: "member", wagerId: "manual-parlay", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 300, rulesetVersion: "PARLAY_2026_V1", legs: [parlayLeg("manual-loss"), parlayLeg("manual-win")] });
    await advancePastWagerStart(slug, "manual-parlay");
    await send(slug, { type: "RegradeWager", commandId: "manual-loss-grade", actorId: "owner", wagerId: "manual-parlay", reason: "Official complete result", correctedResults: [correctionEvidence("manual-loss", "manual-v1", 10, 17), correctionEvidence("manual-win", "manual-v1", 24, 17)] });
    await storage(slug, (state) => settleWagers(state.storage.sql, [final("manual-loss", "provider-v1", 24, 17)]));
    await storage(slug, (state) => settleWagers(state.storage.sql, [final("manual-loss", "provider-v2", 10, 17)]));
    expect(await storage(slug, (state) => ({ wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id='manual-parlay'")][0], active: [...state.storage.sql.exec("SELECT actor_id,outcome FROM settlement WHERE wager_id='manual-parlay' AND outcome <> 'reversal' ORDER BY rowid DESC LIMIT 1")][0], settlements: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM settlement WHERE wager_id='manual-parlay'")][0] }))).toEqual({ wager: { status: "lost" }, active: { actor_id: "owner", outcome: "loss" }, settlements: { count: 1 } });
  }, 90_000);

  it("defers zero-float closure until every early-lost ticket leg is graded", async () => {
    const slug = await fundedPool();
    await send(slug, { type: "PlaceParlayWager", commandId: "all-float-parlay", actorId: "member", wagerId: "all-float-parlay", seasonId: "s1", riskMicros: "3000000", acceptedOdds: 300, rulesetVersion: "PARLAY_2026_V1", legs: [parlayLeg("all-float-loss"), parlayLeg("all-float-pending")] });
    await storage(slug, (state) => settleWagers(state.storage.sql, [final("all-float-loss", "v1", 10, 17)]));
    expect(await storage(slug, (state) => ({ season: [...state.storage.sql.exec("SELECT state,float_micros FROM season WHERE id='s1'")][0], pool: [...state.storage.sql.exec("SELECT active_season_id FROM pool")][0] }))).toEqual({ season: { state: "active", float_micros: "0" }, pool: { active_season_id: "s1" } });
    await storage(slug, (state) => settleWagers(state.storage.sql, [final("all-float-loss", "v1", 10, 17), final("all-float-pending", "v1", 24, 17)]));
    expect(await storage(slug, (state) => ({ season: [...state.storage.sql.exec("SELECT state,close_reason FROM season WHERE id='s1'")][0], pool: [...state.storage.sql.exec("SELECT active_season_id FROM pool")][0] }))).toEqual({ season: { state: "closed", close_reason: "float_exhausted" }, pool: { active_season_id: null } });
  }, 90_000);

  it("locks whole-share risk, stores immutable accepted snapshots, and replays placement", async () => {
    const slug = await fundedPool();
    const command: any = { type: "PlaceStraightWager", commandId: "place", actorId: "member", wagerId: "w1", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("event-one") };
    expect(await send(slug, command)).toMatchObject({ wagerId: "w1" });
    expect(await send(slug, command)).toMatchObject({ wagerId: "w1" });
    expect(await storage(slug, (state) => ({ account: [...state.storage.sql.exec("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0], ticket: [...state.storage.sql.exec("SELECT canonical_book, policy_version, offer_version, original_line FROM wager_leg")][0], entries: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM ledger_entry WHERE kind = 'wager_lock'")][0] }))).toEqual({ account: { available_micros: "2000000", locked_micros: "1000000" }, ticket: { canonical_book: "DraftKings", policy_version: "CANONICAL_BOOKS_2026_V1", offer_version: "offer-v1", original_line: "-3" }, entries: { count: 1 } });
    expect((await send(slug, { ...command, commandId: "fraction", wagerId: "fraction", riskMicros: "1500000" })).code).toBe("WHOLE_SHARE_RISK_REQUIRED");
    const forged = { ...command, commandId: "forged-book", wagerId: "forged-book" };
    const forgedQuote = await quoteWager(slug, forged);
    expect((await direct(slug, { ...placementFromQuote(forged, "quote:forged-book", forgedQuote), riskMicros: "2000000" })).code).toBe("LINE_CHANGED");
    const moneyline = { ...command, commandId: "moneyline", wagerId: "moneyline", acceptedOdds: 150, leg: { ...command.leg, eventId: "moneyline", market: "moneyline" as const, originalLine: null, adjustedLine: null, originalOdds: 150, canonicalOfferProof: { ...command.leg.canonicalOfferProof, offerId: "moneyline:moneyline:home", eventId: "moneyline", market: "moneyline" as const, odds: 150, line: null } } };
    expect(await send(slug, moneyline)).toMatchObject({ wagerId: "moneyline" });
    expect((await send(slug, { ...moneyline, commandId: "moneyline-forged", wagerId: "moneyline-forged", acceptedOdds: 200 })).code).toBe("INVALID_WAGER_LEG");
  }, 30_000);

  it("caps every ticket's total risk and validates teaser side exposure across open bets", async () => {
    const straightSlug = await fundedPool(`side-limit-straight-${crypto.randomUUID()}`);
    await storage(straightSlug, (state) => state.storage.sql.exec("UPDATE share_account SET available_micros = '5000000000' WHERE season_id = 's1' AND member_id = 'member'"));
    const straight: any = { type: "PlaceStraightWager", commandId: "side-limit-first", actorId: "member", wagerId: "side-limit-first", seasonId: "s1", riskMicros: "800000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("limited-side") };
    expect(await send(straightSlug, straight)).toMatchObject({ wagerId: "side-limit-first" });
    expect((await send(straightSlug, { ...straight, commandId: "side-limit-over", wagerId: "side-limit-over", riskMicros: "1000000" })).code).toBe("SIDE_BET_LIMIT");

    const teaserSlug = await fundedPool(`side-limit-teaser-${crypto.randomUUID()}`);
    await storage(teaserSlug, (state) => state.storage.sql.exec("UPDATE share_account SET available_micros = '7000000000' WHERE season_id = 's1' AND member_id = 'member'"));
    await send(teaserSlug, { type: "UpdatePoolSettings", commandId: "raise-side-limit", actorId: "owner", maxSideBetMicros: "1600000000" });
    const teaser: any = { type: "PlaceTeaserWager", commandId: "side-limit-teaser", actorId: "member", wagerId: "side-limit-teaser", seasonId: "s1", riskMicros: "1600000000", acceptedOdds: -120, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: [{ ...leg("teaser-side-one"), adjustedLine: 3 }, { ...leg("teaser-side-two"), adjustedLine: 3 }] };
    expect(await send(teaserSlug, teaser)).toMatchObject({ wagerId: "side-limit-teaser" });
    expect(await send(teaserSlug, { ...teaser, commandId: "side-limit-teaser-second", wagerId: "side-limit-teaser-second" })).toMatchObject({ wagerId: "side-limit-teaser-second" });
    expect((await send(teaserSlug, { ...teaser, commandId: "side-limit-ticket-over", wagerId: "side-limit-ticket-over", riskMicros: "1601000000", legs: [{ ...leg("ticket-limit-one"), adjustedLine: 3 }, { ...leg("ticket-limit-two"), adjustedLine: 3 }] })).code).toBe("SIDE_BET_LIMIT");
    expect((await send(teaserSlug, { ...teaser, commandId: "side-limit-exposure-over", wagerId: "side-limit-exposure-over", riskMicros: "2000000" })).code).toBe("SIDE_BET_LIMIT");

    const mixedSlug = await fundedPool(`side-limit-parlay-${crypto.randomUUID()}`);
    await storage(mixedSlug, (state) => state.storage.sql.exec("UPDATE share_account SET available_micros='2000000000' WHERE season_id='s1' AND member_id='member'"));
    const shared = { type: "PlaceStraightWager", commandId: "mixed-straight", actorId: "member", wagerId: "mixed-straight", seasonId: "s1", riskMicros: "799000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("mixed-side") };
    expect(await send(mixedSlug, shared)).toMatchObject({ wagerId: "mixed-straight" });
    expect((await send(mixedSlug, { type: "PlaceParlayWager", commandId: "mixed-parlay", actorId: "member", wagerId: "mixed-parlay", seasonId: "s1", riskMicros: "4000000", acceptedOdds: 300, rulesetVersion: "PARLAY_2026_V1", legs: [leg("mixed-side"), leg("mixed-other")] })).code).toBe("SIDE_BET_LIMIT");
  }, 30_000);

  it("applies side exposure per member and returns the rejected side's total exposure", async () => {
    const slug = await fundedPool(`member-side-limit-${crypto.randomUUID()}`);
    await send(slug, { type: "JoinPool", commandId: "join-other", actorId: "other", displayName: "Other", password: "correct-password" });
    await storage(slug, (state) => state.storage.sql.exec("UPDATE share_account SET available_micros = '5000000000' WHERE season_id = 's1'"));
    const sharedLeg = leg("member-limited-side");
    const other: any = { type: "PlaceStraightWager", commandId: "other-limit", actorId: "other", wagerId: "other-limit", seasonId: "s1", riskMicros: "800000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: sharedLeg };
    const member: any = { ...other, commandId: "member-limit", actorId: "member", wagerId: "member-limit" };
    expect(await send(slug, other)).toMatchObject({ wagerId: "other-limit" });
    expect(await send(slug, member)).toMatchObject({ wagerId: "member-limit" });
    expect(await send(slug, { ...member, commandId: "member-limit-over", wagerId: "member-limit-over", riskMicros: "1000000" })).toMatchObject({
      code: "SIDE_BET_LIMIT", maxSideBetMicros: "800000000",
      sideExposures: [{
        eventId: "member-limited-side", market: "spread", selection: "home",
        existingExposure: { numeratorMicros: "800000000", denominator: "1" },
        proposedExposure: { numeratorMicros: "1000000", denominator: "1" },
        resultingExposure: { numeratorMicros: "801000000", denominator: "1" }
      }]
    });
  }, 30_000);

  it("places identical straight, teaser, and parlay quotes after the pool command version advances", async () => {
    const cases = [
      { name: "straight", command: { type: "PlaceStraightWager", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("rebased-straight") } },
      { name: "teaser", command: { type: "PlaceTeaserWager", acceptedOdds: -120, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: [{ ...leg("rebased-teaser-one"), adjustedLine: 3 }, { ...leg("rebased-teaser-two"), adjustedLine: 3 }] } },
      { name: "parlay", command: { type: "PlaceParlayWager", acceptedOdds: 250, rulesetVersion: "PARLAY_2026_V1", legs: [parlayLeg("rebased-parlay", "spread", -3, "home"), parlayLeg("rebased-parlay", "total", 40, "over")] } }
    ];
    for (const testCase of cases) {
      const slug = await fundedPool(`rebase-${testCase.name}-${crypto.randomUUID()}`);
      const command = { ...testCase.command, commandId: `${testCase.name}-place`, actorId: "member", wagerId: `${testCase.name}-wager`, seasonId: "s1", riskMicros: "1000000" };
      const quoteKey = `${testCase.name}-quote`;
      const quote = await quoteWager(slug, command, quoteKey);
      const advanced = await direct(slug, { type: "UpdatePoolSettings", commandId: `${testCase.name}-advance`, actorId: "owner", poolName: `Wagers after ${testCase.name} quote` });
      expect(BigInt(String(advanced.commandVersion))).toBeGreaterThan(BigInt(String(quote.commandVersion)));
      expect(await direct(slug, placementFromQuote(command, quoteKey, quote))).toMatchObject({ wagerId: command.wagerId, commandVersion: expect.any(String) });
    }
  }, 30_000);

  it("rejects altered, forged-version, and malformed placements without any durable mutation", async () => {
    const slug = await fundedPool();
    const snapshot = () => storage(slug, (state) => Object.fromEntries([
      "wager_quote", "share_account", "wager", "wager_leg", "wager_leg_snapshot", "event_reconciliation", "ledger_entry", "outbox", "processed_command", "pool"
    ].map((table) => [table, JSON.stringify([...state.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`)])] )));
    const command: any = { type: "PlaceStraightWager", commandId: "matrix-place", actorId: "member", wagerId: "matrix-wager", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("matrix-event") };

    const alteredQuote = await quoteWager(slug, command, "matrix-altered-quote");
    const altered = { ...placementFromQuote(command, "matrix-altered-quote", alteredQuote, "matrix-altered-mutation"), riskMicros: "2000000" };
    const beforeAltered = await snapshot();
    expect((await direct(slug, altered)).code).toBe("LINE_CHANGED");
    expect(await snapshot()).toEqual(beforeAltered);
    expect(JSON.parse(String((await snapshot()).processed_command))).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "matrix-altered-mutation" })]));

    const versionQuote = await quoteWager(slug, { ...command, wagerId: "matrix-version-wager" }, "matrix-version-quote");
    const forgedVersion = { ...placementFromQuote({ ...command, wagerId: "matrix-version-wager" }, "matrix-version-quote", versionQuote, "matrix-version-mutation"), quotedCommandVersion: (BigInt(String(versionQuote.commandVersion)) + 1n).toString() };
    const beforeVersion = await snapshot();
    expect((await direct(slug, forgedVersion)).code).toBe("ORDER_QUOTE_STALE");
    expect(await snapshot()).toEqual(beforeVersion);
    expect(JSON.parse(String((await snapshot()).processed_command))).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "matrix-version-mutation" })]));

    const malformedQuote = await quoteWager(slug, { ...command, wagerId: "matrix-malformed-wager" }, "matrix-malformed-quote");
    const malformed = { ...placementFromQuote({ ...command, wagerId: "matrix-malformed-wager" }, "matrix-malformed-quote", malformedQuote, "matrix-malformed-mutation"), riskMicros: "01" };
    const beforeMalformed = await snapshot();
    expect((await direct(slug, malformed)).code).toBe("INVALID_COMMAND");
    expect(await snapshot()).toEqual(beforeMalformed);
    expect(JSON.parse(String((await snapshot()).processed_command))).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "matrix-malformed-mutation" })]));
  }, 30_000);

  it("keeps straight wager quotes and projection state unchanged across notice set and clear", async () => {
    const slug = await fundedPool();
    const snapshot = () => storage(slug, async (state) => ({
      pool: [...state.storage.sql.exec("SELECT command_version FROM pool")][0],
      activeSeason: [...state.storage.sql.exec("SELECT command_version FROM season WHERE id = 's1'")][0],
      outbox: [...state.storage.sql.exec("SELECT id, event_type, version, payload_json FROM outbox ORDER BY rowid")],
      alarm: await state.storage.getAlarm()
    }));
    const setCommand: any = { type: "PlaceStraightWager", commandId: "notice-set-place", actorId: "member", wagerId: "notice-set-wager", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("notice-set-event") };
    const setQuote = await quoteWager(slug, setCommand, "notice-set-quote");
    const beforeSet = await snapshot();
    expect(await send(slug, { type: "UpdatePoolSettings", commandId: "notice-set", actorId: "owner", commissionerNotice: "Lines lock at noon." })).toMatchObject({ commandVersion: setQuote.commandVersion });
    expect(await snapshot()).toEqual(beforeSet);
    expect(await direct(slug, placementFromQuote(setCommand, "notice-set-quote", setQuote))).toMatchObject({ wagerId: "notice-set-wager" });

    const clearCommand: any = { ...setCommand, commandId: "notice-clear-place", wagerId: "notice-clear-wager", leg: leg("notice-clear-event") };
    const clearQuote = await quoteWager(slug, clearCommand, "notice-clear-quote");
    const beforeClear = await snapshot();
    expect(await send(slug, { type: "UpdatePoolSettings", commandId: "notice-clear", actorId: "owner", commissionerNotice: null })).toMatchObject({ commandVersion: clearQuote.commandVersion });
    expect(await snapshot()).toEqual(beforeClear);
    expect(await direct(slug, placementFromQuote(clearCommand, "notice-clear-quote", clearQuote))).toMatchObject({ wagerId: "notice-clear-wager" });
  }, 30_000);

  it("serializes concurrent wagers so they cannot overspend the same shares", async () => {
    const slug = await fundedPool();
    const command = (id: string): any => ({ type: "PlaceStraightWager", commandId: `overspend-${id}`, actorId: "member", wagerId: id, seasonId: "s1", riskMicros: "2000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg(`overspend-event-${id}`) });
    // Quote and place serially: the second quote observes the first placement version,
    // so this asserts balance contention rather than a shared-version stale race.
    expect(await send(slug, command("one"))).toMatchObject({ wagerId: "one" });
    expect((await send(slug, command("two"))).code).toBe("INSUFFICIENT_SHARES");
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0])).toEqual({ available_micros: "1000000", locked_micros: "2000000" });
  }, 30_000);

  it("rejects malformed direct teaser quote projections without persistence", async () => {
    const slug = await fundedPool();
    const snapshot = () => storage(slug, (state) => Object.fromEntries(
      ["wager_quote", "share_account", "wager", "wager_leg", "ledger_entry", "outbox"].map((table) => [
        table,
        [...state.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`)]
      ])
    ));
    const first = { ...leg("quote-one"), adjustedLine: 3 };
    const second = { ...leg("quote-two"), adjustedLine: 3 };
    const before = await snapshot();
    const projection = (quoteKey: string, legs: any[], teaserPoints = 6) => ({ quoteKey, ownerMemberId: "member", commandVersion: "5", fingerprint: `malformed:${quoteKey}`, wagerId: `wager:${quoteKey}`, actorId: "member", seasonId: "s1", riskMicros: "1000000", acceptedOdds: teaserPoints === 10 ? -120 : -120, teaserPoints, rulesetVersion: "SHARE_POOL_2026_V1", legs });
    const malformed = [
      ["proof", projection("proof", [{ ...first, canonicalOfferProof: { ...first.canonicalOfferProof, line: -4 } }, second])],
      ["adjustment", projection("adjustment", [{ ...first, adjustedLine: 2 }, second])],
      ["duplicate", projection("duplicate", [first, { ...first }])],
      ["opposing", projection("opposing", [first, { ...first, canonicalOfferProof: { ...first.canonicalOfferProof, offerId: "quote-one:spread:away", selection: "away", line: 3 }, selection: "away", originalLine: 3, adjustedLine: 9 }])],
      ["ten-point", projection("ten-point", [first, second], 10)]
    ] as const;
    for (const [name, invalid] of malformed) {
      expect((await direct(slug, { type: "QuoteTeaserWager", commandId: invalid.quoteKey, actorId: "member", identity: { actorId: "member", quoteKey: invalid.quoteKey, fingerprint: invalid.fingerprint }, projection: invalid })).code, name).toBe("INVALID_COMMAND");
      expect(await snapshot(), name).toEqual(before);
    }
  }, 30_000);

  it("runs the real PoolDO alarm and retains the event-start deadline without row mutation", async () => {
    const slug = await fundedPool();
    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const laterStartsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await send(slug, { type: "PlaceStraightWager", commandId: "alarm-place", actorId: "member", wagerId: "alarm-wager", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("alarm-event", startsAt) });
    await send(slug, { type: "PlaceStraightWager", commandId: "later-alarm-place", actorId: "member", wagerId: "later-alarm-wager", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("later-alarm-event", laterStartsAt) });
    const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const deadline = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(deadline).toBe(new Date(startsAt).getTime());
    expect(await reconciliation(slug, "alarm-event")).toMatchObject({ phase: "open", attempts: 0, next_attempt_at: startsAt });
    expect(await reconciliation(slug, "later-alarm-event")).toMatchObject({ phase: "open", attempts: 0, next_attempt_at: laterStartsAt });
  }, 30_000);

  it("keeps a future event covered from kickoff through its eventual final", async () => {
    const slug = await fundedPool();
    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await send(slug, { type: "PlaceStraightWager", commandId: "future-place", actorId: "member", wagerId: "future-wager", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("future-event", startsAt) });
    const kickoff = new Date(startsAt).getTime();
    expect(await reconciliation(slug, "future-event")).toMatchObject({ phase: "open", attempts: 0, next_attempt_at: startsAt });
    let polls = 0;
    const openSource: ResultSource = { getFinalResults: async () => { polls++; return []; } };
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, openSource, kickoff - 1));
    expect(polls).toBe(0);
    for (let current = kickoff; current < kickoff + 20 * 60 * 1000;) {
      await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, openSource, current));
      const row = await reconciliation(slug, "future-event");
      expect(row).toMatchObject({ phase: "open", next_attempt_at: expect.any(String) });
      current = new Date(String(row.next_attempt_at)).getTime();
    }
    const beforeFinal = await reconciliation(slug, "future-event");
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [final("future-event")] }, new Date(String(beforeFinal.next_attempt_at)).getTime()));
    expect(await storage(slug, (state) => ({ wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = 'future-wager'")][0], reconciliation: [...state.storage.sql.exec("SELECT phase, deadline_at, next_attempt_at FROM event_reconciliation WHERE event_id = 'future-event'")][0] }))).toMatchObject({ wager: { status: "won" }, reconciliation: { phase: "final_15", deadline_at: expect.any(String), next_attempt_at: expect.any(String) } });
  }, 30_000);

  it("bounds provider-error backoff without losing result coverage", async () => {
    const slug = await fundedPool();
    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await send(slug, { type: "PlaceStraightWager", commandId: "outage-place", actorId: "member", wagerId: "outage-wager", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("outage-event", startsAt) });
    let current = new Date(startsAt).getTime();
    const outage: ResultSource = { getFinalResults: async () => { throw new Error("provider unavailable"); } };
    for (let attempt = 0; attempt < 8; attempt++) {
      await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, outage, current));
      const row = await reconciliation(slug, "outage-event");
      expect(row).toMatchObject({ phase: "open", next_attempt_at: expect.any(String) });
      current = new Date(String(row.next_attempt_at)).getTime();
    }
    expect(await reconciliation(slug, "outage-event")).toMatchObject({ error_attempts: 0, last_error: "RESULT_PROVIDER_RETRIES_EXHAUSTED_RECOVERING" });
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [final("outage-event")] }, current));
    expect(await reconciliation(slug, "outage-event")).toMatchObject({ phase: "final_15" });
  }, 30_000);

  it("waits for independently finalized teaser push and void legs before refunding", async () => {
    const slug = await fundedPool();
    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const pushOffer = leg("teaser-push", startsAt);
    const voidOffer = leg("teaser-void", startsAt);
    const pushLeg = { ...pushOffer, originalLine: -6, canonicalOfferProof: { ...pushOffer.canonicalOfferProof, line: -6 } };
    const voidLeg = { ...voidOffer, canonicalOfferProof: { ...voidOffer.canonicalOfferProof, line: -3 } };
    await send(slug, { type: "PlaceTeaserWager", commandId: "teaser-place", actorId: "member", wagerId: "teaser-wager", seasonId: "s1", riskMicros: "1000000", acceptedOdds: -120, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: [{ ...pushLeg, adjustedLine: 0 }, { ...voidLeg, adjustedLine: 3 }] });
    const kickoff = new Date(startsAt).getTime();
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [{ eventId: "teaser-push", league: "nfl", status: "final", homeScore: 17, awayScore: 17, correctionVersion: "1" }] }, kickoff));
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT status FROM wager WHERE id = 'teaser-wager'")][0])).toEqual({ status: "open" });
    const voidDueAt = new Date(String((await reconciliation(slug, "teaser-void")).next_attempt_at)).getTime();
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [{ eventId: "teaser-void", league: "nfl", status: "cancelled", homeScore: null, awayScore: null, correctionVersion: "1" }] }, voidDueAt));
    expect(await storage(slug, (state) => ({ wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = 'teaser-wager'")][0], account: [...state.storage.sql.exec("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0] }))).toEqual({ wager: { status: "refunded" }, account: { available_micros: "3000000", locked_micros: "0" } });
  }, 30_000);

  it("voids open and settled wagers as immutable commissioner corrections and closes zero float", async () => {
    const slug = await fundedPool();
    const open: any = { type: "PlaceStraightWager", commandId: "open-place", actorId: "member", wagerId: "open-void", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("open-void-event") };
    await send(slug, open);
    expect(await send(slug, { type: "VoidWager", commandId: "open-void-command", actorId: "owner", wagerId: "open-void", reason: "Incorrect ticket" })).toMatchObject({ commandVersion: expect.any(String) });
    expect(await storage(slug, (state) => ({ wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = 'open-void'")][0], account: [...state.storage.sql.exec("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0] }))).toEqual({ wager: { status: "refunded" }, account: { available_micros: "3000000", locked_micros: "0" } });

    const settled: any = { ...open, commandId: "settled-place", wagerId: "settled-void", leg: leg("settled-void-event") };
    await send(slug, settled);
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [final("settled-void-event")] }, Date.now() + 2 * 60 * 60 * 1000));
    expect(await send(slug, { type: "ReadMyWagers", commandId: "current-win", actorId: "member" })).toMatchObject({ wagers: expect.arrayContaining([expect.objectContaining({ wagerId: "settled-void", outcome: "won" })]) });
    const correction: any = { type: "RegradeWager", commandId: "correction", actorId: "owner", wagerId: "settled-void", reason: "Official correction", correctedResults: [correctionEvidence("settled-void-event", "official-v2", 10, 17)] };
    expect(await send(slug, correction)).toMatchObject({ commandVersion: expect.any(String) });
    expect(await send(slug, correction)).toMatchObject({ commandVersion: expect.any(String) });
    expect(await send(slug, { type: "ReadMyWagers", commandId: "current-loss", actorId: "member" })).toMatchObject({ wagers: expect.arrayContaining([expect.objectContaining({ wagerId: "settled-void", outcome: "lost", returnMicros: "0", profitMicros: "0" })]) });
    expect((await send(slug, { ...correction, reason: "Different reason" })).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await send(slug, { type: "VoidWager", commandId: "settled-void-command", actorId: "owner", wagerId: "settled-void", reason: "Void official correction" })).toMatchObject({ commandVersion: expect.any(String) });
    expect(await send(slug, { type: "ReadMyWagers", commandId: "current-settlement", actorId: "member" })).toMatchObject({ wagers: expect.arrayContaining([expect.objectContaining({ wagerId: "settled-void", outcome: "refunded", returnMicros: "1000000", profitMicros: "0" })]) });
    expect(await storage(slug, (state) => ({
      wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = 'settled-void'")][0],
      account: [...state.storage.sql.exec("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0],
      correction: [...state.storage.sql.exec("SELECT actor_id, reason, source_result_json, replacement_result_json FROM wager_correction WHERE command_id = 'correction'")][0],
      settlement: [...state.storage.sql.exec("SELECT result_version, actor_id, reason FROM settlement WHERE wager_id = 'settled-void' AND outcome = 'loss' ORDER BY created_at DESC LIMIT 1")][0],
      audit: [...state.storage.sql.exec("SELECT action, subject_id, reason FROM administration_audit WHERE command_id = 'correction'")][0]
    }))).toMatchObject({ wager: { status: "refunded" }, account: { available_micros: "3000000", locked_micros: "0" }, correction: { actor_id: "owner", reason: "Official correction", replacement_result_json: expect.stringContaining("official-v2") }, settlement: { result_version: expect.stringContaining("official-v2"), actor_id: "owner", reason: "Official correction" }, audit: { action: "regrade_wager", subject_id: "settled-void", reason: "Official correction" } });
  }, 90_000);

  it("closes a zero-float season and emits closure outbox after a commissioner regrade", async () => {
    const slug = await fundedPool();
    const eventId = "correction-zero";
    await send(slug, { type: "PlaceStraightWager", commandId: "zero-place", actorId: "member", wagerId: eventId, seasonId: "s1", riskMicros: "3000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg(eventId) });
    // Correcting the all-float open ticket to a loss exhausts the original three-share float.
    expect(await send(slug, { type: "RegradeWager", commandId: "zero-correction", actorId: "owner", wagerId: eventId, reason: "Official loss", correctedResults: [correctionEvidence(eventId, "official-zero", 10, 17)] })).toMatchObject({ commandVersion: expect.any(String) });
    expect(await storage(slug, (state) => ({ season: [...state.storage.sql.exec("SELECT state, close_reason, float_micros FROM season WHERE id = 's1'")][0], closure: [...state.storage.sql.exec("SELECT payload_json FROM outbox WHERE event_type = 'SeasonClosed' ORDER BY created_at DESC LIMIT 1")][0] }))).toEqual({ season: { state: "closed", close_reason: "float_exhausted", float_micros: "0" }, closure: { payload_json: expect.stringContaining("float_exhausted") } });

    const snapshot = () => storage(slug, (state) => ({
      season: [...state.storage.sql.exec("SELECT state, float_micros, command_version FROM season WHERE id = 's1'")][0],
      pool: [...state.storage.sql.exec("SELECT active_season_id, command_version FROM pool")][0],
      account: [...state.storage.sql.exec("SELECT available_micros, locked_micros, row_version FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0],
      settlements: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM settlement WHERE wager_id = ?", eventId)][0],
      corrections: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM wager_correction WHERE wager_id = ?", eventId)][0],
      audits: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM administration_audit")][0],
      outbox: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM outbox")][0]
    }));
    const closedSnapshot = await snapshot();
    expect(await send(slug, { type: "RegradeWager", commandId: "zero-correction", actorId: "owner", wagerId: eventId, reason: "Official loss", correctedResults: [correctionEvidence(eventId, "official-zero", 10, 17)] })).toMatchObject({ commandVersion: closedSnapshot.pool.command_version });
    expect(await snapshot()).toEqual(closedSnapshot);
    expect((await send(slug, { type: "VoidWager", commandId: "closed-void", actorId: "owner", wagerId: eventId, reason: "Too late" })).code).toBe("SEASON_NOT_ACTIVE");
    expect((await send(slug, { type: "RegradeWager", commandId: "closed-regrade", actorId: "owner", wagerId: eventId, reason: "Too late", correctedResults: [correctionEvidence(eventId, "official-closed")] })).code).toBe("SEASON_NOT_ACTIVE");
    expect(await snapshot()).toEqual(closedSnapshot);
  }, 90_000);

  it("keeps manual straight settlement byte-stable through unchanged final reconciliation and accepts a newer provider result", async () => {
    const slug = await fundedPool();
    const eventId = "manual-straight-provider";
    await send(slug, { type: "PlaceStraightWager", commandId: "manual-straight-place", actorId: "member", wagerId: eventId, seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg(eventId) });
    const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug));
    const poll = (result: FinalResultVersion) => runInDurableObject(stub, async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [result] }, new Date(String((await reconciliation(slug, eventId)).next_attempt_at)).getTime()));
    await poll(final(eventId, "provider-1"));
    expect(await send(slug, { type: "RegradeWager", commandId: "manual-straight-loss", actorId: "owner", wagerId: eventId, reason: "Corrected official score", correctedResults: [correctionEvidence(eventId, "official-2", 10, 17)] })).toMatchObject({ commandVersion: expect.any(String) });
    const businessSnapshot = () => storage(slug, (state) => ({
      account: [...state.storage.sql.exec("SELECT available_micros, locked_micros, row_version FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0],
      wager: [...state.storage.sql.exec("SELECT status, settled_result_version FROM wager WHERE id = ?", eventId)][0],
      legs: [...state.storage.sql.exec("SELECT id, grade, result_version FROM wager_leg WHERE wager_id = ? ORDER BY id", eventId)],
      settlements: [...state.storage.sql.exec("SELECT id, result_version, outcome, return_micros, profit_micros, source_result_json, reversal_of, actor_id, reason, created_at FROM settlement WHERE wager_id = ? ORDER BY rowid", eventId)],
      ledger: [...state.storage.sql.exec("SELECT id, available_delta, locked_delta, float_delta, causation_id, kind, actor_id, created_at FROM ledger_entry WHERE member_id = 'member' ORDER BY rowid")],
      versions: { pool: [...state.storage.sql.exec("SELECT command_version FROM pool")][0], season: [...state.storage.sql.exec("SELECT command_version FROM season WHERE id = 's1'")][0] }
    }));
    const corrected = await businessSnapshot();
    await poll(final(eventId, "provider-1"));
    expect(await businessSnapshot()).toEqual(corrected);
    await poll(final(eventId, "provider-1"));
    expect(await businessSnapshot()).toEqual(corrected);

    const newerSlug = await fundedPool();
    const newerEvent = "manual-straight-newer";
    await send(newerSlug, { type: "PlaceStraightWager", commandId: "newer-place", actorId: "member", wagerId: newerEvent, seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg(newerEvent) });
    const newerStub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(newerSlug));
    const newerPoll = (result: FinalResultVersion) => runInDurableObject(newerStub, async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [result] }, new Date(String((await reconciliation(newerSlug, newerEvent)).next_attempt_at)).getTime()));
    await newerPoll(final(newerEvent, "provider-1"));
    await send(newerSlug, { type: "RegradeWager", commandId: "newer-manual", actorId: "owner", wagerId: newerEvent, reason: "Corrected official score", correctedResults: [correctionEvidence(newerEvent, "official-2", 10, 17)] });
    await newerPoll(final(newerEvent, "provider-2", 28, 17));
    expect(await storage(newerSlug, (state) => ({ wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = ?", newerEvent)][0], leg: [...state.storage.sql.exec("SELECT result_version FROM wager_leg WHERE wager_id = ?", newerEvent)][0], settlements: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM settlement WHERE wager_id = ?", newerEvent)][0] }))).toEqual({ wager: { status: "won" }, leg: { result_version: "provider-2" }, settlements: { count: 5 } });
  }, 90_000);

  it("denies pre-kickoff regrade oracle probes without mutation while preserving void and post-start regrade", async () => {
    const slug = await fundedPool();
    const futureEvent = "private-future-event";
    await send(slug, { type: "PlaceStraightWager", commandId: "private-place", actorId: "member", wagerId: "private-wager", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg(futureEvent, new Date(Date.now() + 60 * 60 * 1000).toISOString()) });
    const snapshot = () => storage(slug, (state) => Object.fromEntries(["pool", "season", "processed_command", "wager", "wager_leg", "share_account", "ledger_entry", "settlement", "wager_correction", "administration_audit", "outbox"].map((table) => [table, JSON.stringify([...state.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`)])])));
    const exportBytes = () => direct(slug, { type: "ReadAuditExport", commandId: crypto.randomUUID(), actorId: "member" }).then(JSON.stringify);
    const before = await snapshot();
    const beforeExport = await exportBytes();
    for (const [commandId, evidence] of [
      ["oracle-correct", correctionEvidence(futureEvent, "guessed-correct")],
      ["oracle-wrong", correctionEvidence("guessed-wrong-event", "guessed-wrong")]
    ] as const) {
      expect((await direct(slug, { type: "RegradeWager", commandId, actorId: "owner", wagerId: "private-wager", reason: "Human probe", correctedResults: [evidence] })).code).toBe("WAGER_NOT_STARTED");
      expect(await snapshot()).toEqual(before);
      expect(await exportBytes()).toBe(beforeExport);
    }
    expect(beforeExport).not.toContain(futureEvent);

    const voidSlug = await fundedPool();
    await send(voidSlug, { type: "PlaceStraightWager", commandId: "void-place", actorId: "member", wagerId: "void-before-start", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("void-future", new Date(Date.now() + 60 * 60 * 1000).toISOString()) });
    expect(await send(voidSlug, { type: "VoidWager", commandId: "void-command", actorId: "owner", wagerId: "void-before-start", reason: "Official void" })).toMatchObject({ commandVersion: expect.any(String) });

    const startedSlug = await fundedPool();
    await send(startedSlug, { type: "PlaceStraightWager", commandId: "started-place", actorId: "member", wagerId: "started-wager", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("started-event") });
    expect(await send(startedSlug, { type: "RegradeWager", commandId: "started-regrade", actorId: "owner", wagerId: "started-wager", reason: "Official result", correctedResults: [correctionEvidence("started-event", "official-1")] })).toMatchObject({ commandVersion: expect.any(String) });
  }, 120_000);

  it("persists one canonical result for a valid same-event spread and total teaser", async () => {
    const slug = await fundedPool();
    const eventId = "same-game";
    const spread = { ...leg(eventId), adjustedLine: 3 };
    const total = { ...leg(eventId), market: "total" as const, selection: "over" as const, originalLine: 40, adjustedLine: 34, canonicalOfferProof: { ...spread.canonicalOfferProof, offerId: `${eventId}:total:over`, market: "total" as const, selection: "over" as const, line: 40 } };
    await send(slug, { type: "PlaceTeaserWager", commandId: "same-place", actorId: "member", wagerId: "same-wager", seasonId: "s1", riskMicros: "1000000", acceptedOdds: -120, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: [spread, total] });
    const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug));
    const poll = (result: FinalResultVersion) => runInDurableObject(stub, async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [result] }, new Date(String((await reconciliation(slug, eventId)).next_attempt_at)).getTime()));
    await poll(final(eventId, "provider-1", 24, 17));
    expect(await storage(slug, (state) => ({
      wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = 'same-wager'")][0],
      account: [...state.storage.sql.exec("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0],
      grades: [...state.storage.sql.exec("SELECT grade, result_version FROM wager_leg WHERE wager_id = 'same-wager' ORDER BY id")],
      source: JSON.parse(String([...state.storage.sql.exec("SELECT source_result_json FROM settlement WHERE wager_id = 'same-wager' AND outcome <> 'reversal' ORDER BY rowid DESC LIMIT 1")][0].source_result_json))
    }))).toEqual({ wager: { status: "won" }, account: { available_micros: "3833333", locked_micros: "0" }, grades: [{ grade: "win", result_version: "provider-1" }, { grade: "win", result_version: "provider-1" }], source: [final(eventId, "provider-1", 24, 17)] });

    expect(await send(slug, { type: "RegradeWager", commandId: "same-regrade", actorId: "owner", wagerId: "same-wager", reason: "Official correction", correctedResults: [correctionEvidence(eventId, "official-2", 17, 24)] })).toMatchObject({ commandVersion: expect.any(String) });
    const corrected = await storage(slug, (state) => ({
      wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = 'same-wager'")][0],
      account: [...state.storage.sql.exec("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0],
      replacement: JSON.parse(String([...state.storage.sql.exec("SELECT replacement_result_json FROM wager_correction WHERE command_id = 'same-regrade'")][0].replacement_result_json))
    }));
    expect(corrected).toMatchObject({ wager: { status: "lost" }, account: { available_micros: "2000000", locked_micros: "0" }, replacement: { correctedResults: [correctionEvidence(eventId, "official-2", 17, 24)] } });
    const stable = JSON.stringify(corrected);
    await poll(final(eventId, "provider-1", 24, 17));
    expect(JSON.stringify(await storage(slug, (state) => ({ wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = 'same-wager'")][0], account: [...state.storage.sql.exec("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0], replacement: JSON.parse(String([...state.storage.sql.exec("SELECT replacement_result_json FROM wager_correction WHERE command_id = 'same-regrade'")][0].replacement_result_json)) })))).toBe(stable);
    await poll(final(eventId, "provider-2", 28, 17));
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT status FROM wager WHERE id = 'same-wager'")][0])).toEqual({ status: "won" });
  }, 120_000);

  it("canonically regrades teasers from corrected event evidence", async () => {
    const cases = [
      { name: "push reduction", scores: [[24, 17, "final"], [21, 17, "final"], [14, 17, "final"]] as const, expectedStatus: "won", expectedAvailable: "3833333", expectedProfit: "833333" },
      { name: "void reduction", scores: [[24, 17, "final"], [21, 17, "final"], [0, 0, "cancelled"]] as const, expectedStatus: "won", expectedAvailable: "3833333", expectedProfit: "833333" },
      { name: "below minimum", scores: [[24, 17, "final"], [14, 17, "final"]] as const, expectedStatus: "refunded", expectedAvailable: "3000000", expectedProfit: "0" },
      { name: "loss precedence", scores: [[24, 17, "final"], [0, 0, "cancelled"], [10, 17, "final"]] as const, expectedStatus: "lost", expectedAvailable: "2000000", expectedProfit: "0" }
    ];
    for (const testCase of cases) {
      const slug = await fundedPool();
      const eventIds = testCase.scores.map((_, index) => `${testCase.name}-${index}`);
      const legs = eventIds.map((eventId) => ({ ...leg(eventId), adjustedLine: 3 }));
      const acceptedOdds = legs.length === 3 ? 150 : -120;
      await send(slug, { type: "PlaceTeaserWager", commandId: `place-${testCase.name}`, actorId: "member", wagerId: `wager-${testCase.name}`, seasonId: "s1", riskMicros: "1000000", acceptedOdds, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs });
      const correctedResults = testCase.scores.map(([home, away, status], index) => correctionEvidence(eventIds[index], `manual-${index}`, home, away, status));
      expect(await send(slug, { type: "RegradeWager", commandId: `correct-${testCase.name}`, actorId: "owner", wagerId: `wager-${testCase.name}`, reason: "Corrected event results", correctedResults }), testCase.name).toMatchObject({ commandVersion: expect.any(String) });
      expect(await storage(slug, (state) => ({ wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = ?", `wager-${testCase.name}`)][0], account: [...state.storage.sql.exec("SELECT available_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0], settlement: [...state.storage.sql.exec("SELECT profit_micros FROM settlement WHERE wager_id = ? AND outcome <> 'reversal' ORDER BY rowid DESC LIMIT 1", `wager-${testCase.name}`)][0] })), testCase.name).toEqual({ wager: { status: testCase.expectedStatus }, account: { available_micros: testCase.expectedAvailable }, settlement: { profit_micros: testCase.expectedProfit } });
    }

    const stableSlug = await fundedPool();
    const stableEvents = ["stable-teaser-1", "stable-teaser-2", "stable-teaser-3"];
    await send(stableSlug, { type: "PlaceTeaserWager", commandId: "stable-teaser-place", actorId: "member", wagerId: "stable-teaser", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 150, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: stableEvents.map((eventId) => ({ ...leg(eventId), adjustedLine: 3 })) });
    const stableStub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(stableSlug));
    const providerResults = stableEvents.map((eventId) => final(eventId, "provider-1"));
    const poll = () => runInDurableObject(stableStub, async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => providerResults }, Math.max(...(await Promise.all(stableEvents.map(async (eventId) => new Date(String((await reconciliation(stableSlug, eventId)).next_attempt_at)).getTime()))))));
    await poll();
    await send(stableSlug, { type: "RegradeWager", commandId: "stable-teaser-correction", actorId: "owner", wagerId: "stable-teaser", reason: "Official push correction", correctedResults: [correctionEvidence(stableEvents[0], "official-2"), correctionEvidence(stableEvents[1], "official-2"), correctionEvidence(stableEvents[2], "official-2", 14, 17)] });
    const stableBusiness = () => storage(stableSlug, (state) => JSON.stringify({
      account: [...state.storage.sql.exec("SELECT available_micros, locked_micros, row_version FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0],
      wager: [...state.storage.sql.exec("SELECT status, settled_result_version FROM wager WHERE id = 'stable-teaser'")][0],
      settlements: [...state.storage.sql.exec("SELECT * FROM settlement WHERE wager_id = 'stable-teaser' ORDER BY rowid")],
      ledger: [...state.storage.sql.exec("SELECT * FROM ledger_entry WHERE member_id = 'member' ORDER BY rowid")],
      versions: [...state.storage.sql.exec("SELECT command_version FROM pool")]
    }));
    const stableCorrection = await stableBusiness();
    await poll();
    expect(await stableBusiness()).toBe(stableCorrection);
    await poll();
    expect(await stableBusiness()).toBe(stableCorrection);
  }, 120_000);

  it("rejects malformed or mismatched correction result evidence without mutation", async () => {
    const slug = await fundedPool();
    await send(slug, { type: "PlaceStraightWager", commandId: "evidence-place", actorId: "member", wagerId: "evidence-wager", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("evidence-event") });
    const snapshot = () => storage(slug, (state) => Object.fromEntries(["pool", "season", "share_account", "wager", "wager_leg", "settlement", "wager_correction", "ledger_entry", "administration_audit", "processed_command"].map((table) => [table, JSON.stringify([...state.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`)])])));
    await advancePastWagerStart(slug, "evidence-wager");
    const before = await snapshot();
    expect((await direct(slug, { type: "RegradeWager", commandId: "malformed-evidence", actorId: "owner", wagerId: "evidence-wager", reason: "Bad evidence", correctedResults: [{ eventId: "evidence-event", league: "nfl", status: "final", homeScore: null, awayScore: 17, correctionVersion: "manual-1" }] })).code).toBe("INVALID_COMMAND");
    expect(await snapshot()).toEqual(before);
    expect((await direct(slug, { type: "RegradeWager", commandId: "mismatched-evidence", actorId: "owner", wagerId: "evidence-wager", reason: "Wrong event", correctedResults: [correctionEvidence("another-event", "manual-2")] })).code).toBe("CORRECTION_RESULT_MISMATCH");
    expect(await snapshot()).toEqual(before);
  }, 90_000);

  it("closes a season when losses exhaust its float", async () => {
    await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]);
    const slug = await fundedPool();
    for (const eventId of ["loss-one", "loss-two", "loss-three"]) {
      await send(slug, { type: "PlaceStraightWager", commandId: `place-${eventId}`, actorId: "member", wagerId: eventId, seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg(eventId) });
      await bindings.DB.prepare("INSERT OR REPLACE INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, home_score, away_score, correction_version) VALUES (?, ?, 'nfl', 'Home', 'Away', ?, 'final', '10', '17', '1')").bind(`${eventId}-${slug}`, eventId, new Date().toISOString()).run();
    }
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, undefined, Date.now() + 2 * 60 * 60 * 1000));
    expect(await storage(slug, (state) => ({ season: [...state.storage.sql.exec("SELECT state, close_reason, float_micros, command_version FROM season WHERE id = 's1'")][0], closure: [...state.storage.sql.exec("SELECT version, payload_json FROM outbox WHERE event_type = 'SeasonClosed' ORDER BY created_at DESC LIMIT 1")][0] }))).toEqual({ season: { state: "closed", close_reason: "float_exhausted", float_micros: "0", command_version: expect.any(String) }, closure: { version: expect.any(String), payload_json: expect.stringContaining("float_exhausted") } });
    expect(await storage(slug, (state) => String([...state.storage.sql.exec("SELECT command_version FROM season WHERE id = 's1'")][0].command_version) === String([...state.storage.sql.exec("SELECT version FROM outbox WHERE event_type = 'SeasonClosed' ORDER BY created_at DESC LIMIT 1")][0].version))).toBe(true);
  }, 90_000);

  it("does not apply a newer provider correction after float-exhaustion closure", async () => {
    const slug = await fundedPool();
    const eventIds = ["closed-float-one", "closed-float-two", "closed-float-three"];
    for (const eventId of eventIds) await send(slug, { type: "PlaceStraightWager", commandId: `place-${eventId}`, actorId: "member", wagerId: eventId, seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg(eventId) });
    const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug));
    const firstDue = Math.max(...(await Promise.all(eventIds.map(async (eventId) => new Date(String((await reconciliation(slug, eventId)).next_attempt_at)).getTime()))));
    await runInDurableObject(stub, async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [...eventIds].reverse().map((eventId) => final(eventId, "provider-1", 10, 17)) }, firstDue));
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT state, close_reason FROM season WHERE id = 's1'")][0])).toEqual({ state: "closed", close_reason: "float_exhausted" });
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT event_id, league, correction_version, append_order FROM season_provider_result WHERE season_id = 's1' ORDER BY append_order")])).toEqual([...eventIds].sort().map((eventId, index) => ({ event_id: eventId, league: "nfl", correction_version: "provider-1", append_order: index + 1 })));

    const durableSnapshot = () => storage(slug, (state) => Object.fromEntries([
      "wager", "wager_leg", "share_account", "ledger_entry", "settlement", "wager_correction", "administration_audit", "pool", "season", "processed_command", "outbox", "season_provider_result"
    ].map((table) => [table, JSON.stringify([...state.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`)])])));
    const exportBytes = () => direct(slug, { type: "ReadAuditExport", commandId: "closed-float-export", actorId: "member" }).then(JSON.stringify);
    const historyBytes = () => direct(slug, { type: "ReadSeasonHistory", commandId: crypto.randomUUID(), actorId: "member", seasonId: "s1" }).then((history) => JSON.stringify((({ commandVersion: _version, ...archive }) => archive)(history as any)));
    const before = await durableSnapshot();
    const beforeExport = await exportBytes();
    const beforeHistory = await historyBytes();
    const correctionDue = new Date(String((await reconciliation(slug, eventIds[0])).next_attempt_at)).getTime();
    await runInDurableObject(stub, async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [final(eventIds[0], "provider-2", 24, 17)] }, correctionDue));
    expect(await durableSnapshot()).toEqual(before);
    expect(await exportBytes()).toBe(beforeExport);
    expect(await historyBytes()).toBe(beforeHistory);

    await send(slug, { type: "CreateSeason", commandId: "second-draft", actorId: "owner", seasonId: "s2", label: "2027" });
    await send(slug, { type: "OpenSeason", commandId: "second-open", actorId: "owner", seasonId: "s2" });
    const secondQuote = await send(slug, { type: "QuoteShareOrder", commandId: "second-quote", actorId: "owner", seasonId: "s2", memberId: "member", mode: "shares", amountMicros: "1000000" });
    await send(slug, { type: "ExecuteShareOrder", commandId: "second-fund", actorId: "owner", seasonId: "s2", memberId: "member", mode: "shares", amountMicros: "1000000", quote: { priceMicros: String(secondQuote.priceMicros), commandVersion: String(secondQuote.commandVersion) }, reason: "second season" });
    await send(slug, { type: "PlaceStraightWager", commandId: "second-place", actorId: "member", wagerId: "second-wager", seasonId: "s2", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg(eventIds[0]) });
    const secondDue = new Date(String((await reconciliation(slug, eventIds[0])).next_attempt_at)).getTime();
    await runInDurableObject(stub, async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [final(eventIds[0], "provider-3", 24, 17)] }, secondDue));
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT season_id, correction_version FROM season_provider_result WHERE event_id = ? ORDER BY season_id, append_order", eventIds[0])])).toEqual([
      { season_id: "s1", correction_version: "provider-1" },
      { season_id: "s2", correction_version: "provider-3" }
    ]);
    expect(await historyBytes()).toBe(beforeHistory);
  }, 90_000);

  it("does not apply a newer provider correction after confirmed-Super-Bowl all-wagers-settled closure", async () => {
    const slug = await fundedPool();
    const wagerEvent = "closed-super-wager";
    const wagerStartsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await send(slug, { type: "PlaceStraightWager", commandId: "closed-super-place", actorId: "member", wagerId: wagerEvent, seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg(wagerEvent, wagerStartsAt) });
    const superStartsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    await bindings.DB.prepare("INSERT OR REPLACE INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, home_score, away_score, correction_version, event_name, postseason) VALUES (?, ?, 'nfl', 'AFC', 'NFC', ?, 'scheduled', NULL, NULL, '0', 'Super Bowl LX', 1)").bind(`closed-super-${slug}`, "closed-super-event", superStartsAt).run();
    const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug));
    await runDurableObjectAlarm(stub);
    await send(slug, { type: "ConfirmSuperBowl", commandId: "closed-super-confirm", actorId: "owner", seasonId: "s1", eventId: "closed-super-event" });

    await advancePastWagerStart(slug, wagerEvent);
    const wagerDue = new Date(String((await reconciliation(slug, wagerEvent)).next_attempt_at)).getTime();
    await runInDurableObject(stub, async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [final(wagerEvent, "provider-1", 24, 17)] }, wagerDue));
    await bindings.DB.prepare("UPDATE sports_event SET status = 'final', home_score = '24', away_score = '17', correction_version = '1' WHERE provider_event_id = 'closed-super-event'").run();
    const superDue = new Date(String((await reconciliation(slug, "closed-super-event")).next_attempt_at)).getTime();
    await runInDurableObject(stub, async (_instance, state) => runSettlementAlarm(state, bindings.DB, undefined, superDue));
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT state, close_reason FROM season WHERE id = 's1'")][0])).toEqual({ state: "closed", close_reason: "super_bowl_final" });
    const closedHistory = await direct(slug, { type: "ReadSeasonHistory", commandId: "closed-super-history", actorId: "member", seasonId: "s1" });
    expect((closedHistory.eventResults as any[]).map(({ eventId, result }) => ({ eventId, correctionVersion: result.correctionVersion }))).toEqual([
      { eventId: wagerEvent, correctionVersion: "provider-1" },
      { eventId: "closed-super-event", correctionVersion: "1" }
    ]);

    const durableSnapshot = () => storage(slug, (state) => ({
      business: Object.fromEntries(["wager", "wager_leg", "share_account", "ledger_entry", "settlement", "wager_correction", "administration_audit", "pool", "season", "processed_command", "outbox"].map((table) => [table, JSON.stringify([...state.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`)])])),
      superBowl: JSON.stringify([...state.storage.sql.exec("SELECT * FROM season_super_bowl ORDER BY rowid")]),
      superBowlSnapshot: JSON.stringify([...state.storage.sql.exec("SELECT * FROM event_result_snapshot WHERE event_id = 'closed-super-event' ORDER BY rowid")]),
      superBowlReconciliation: JSON.stringify([...state.storage.sql.exec("SELECT * FROM event_reconciliation WHERE event_id = 'closed-super-event' ORDER BY rowid")])
    }));
    const exportBytes = () => direct(slug, { type: "ReadAuditExport", commandId: "closed-super-export", actorId: "member" }).then(JSON.stringify);
    const historyBytes = () => direct(slug, { type: "ReadSeasonHistory", commandId: crypto.randomUUID(), actorId: "member", seasonId: "s1" }).then((history) => JSON.stringify((({ commandVersion: _version, ...archive }) => archive)(history as any)));
    const before = await durableSnapshot();
    const beforeExport = await exportBytes();
    const beforeHistory = await historyBytes();
    const correctionDue = new Date(String((await reconciliation(slug, wagerEvent)).next_attempt_at)).getTime();
    await runInDurableObject(stub, async (_instance, state) => runSettlementAlarm(state, bindings.DB, { getFinalResults: async () => [final(wagerEvent, "provider-2", 10, 17)] }, correctionDue));
    expect(await durableSnapshot()).toEqual(before);
    expect(await exportBytes()).toBe(beforeExport);
    expect(await historyBytes()).toBe(beforeHistory);
  }, 90_000);

  it("discovers and reconciles the confirmed Super Bowl at season level without a Super Bowl wager", async () => {
    const slug = await fundedPool();
    await send(slug, { type: "PlaceStraightWager", commandId: "place-ordinary", actorId: "member", wagerId: "ordinary", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("ordinary-event") });
    const superStartsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await bindings.DB.prepare("INSERT OR REPLACE INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, home_score, away_score, correction_version, event_name, postseason) VALUES (?, ?, 'nfl', 'AFC', 'NFC', ?, 'scheduled', NULL, NULL, '0', 'Super Bowl LX', 1)").bind(`super-${slug}`, "super-event", superStartsAt).run();

    await runDurableObjectAlarm(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)));
    expect(await storage(slug, (state) => ({
      candidate: [...state.storage.sql.exec("SELECT event_id, provider_event_name, confirmed_at FROM season_super_bowl WHERE season_id = 's1'")][0],
      superWagerLegs: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM wager_leg WHERE event_id = 'super-event'")][0]
    }))).toEqual({ candidate: { event_id: "super-event", provider_event_name: "Super Bowl LX", confirmed_at: null }, superWagerLegs: { count: 0 } });
    expect((await send(slug, { type: "ConfirmSuperBowl", commandId: "wrong-confirm", actorId: "owner", seasonId: "s1", eventId: "forged-event" })).code).toBe("SUPER_BOWL_NOT_CANONICAL");
    expect(await send(slug, { type: "ConfirmSuperBowl", commandId: "confirm", actorId: "owner", seasonId: "s1", eventId: "super-event" })).toMatchObject({ commandVersion: expect.any(String) });
    const confirmedLifecycle = await reconciliation(slug, "super-event");
    expect(new Date(String(confirmedLifecycle.next_attempt_at)).getTime()).toBeLessThanOrEqual(Date.now() + 2_000);

    await bindings.DB.prepare("UPDATE sports_event SET status = 'final', home_score = '24', away_score = '17', correction_version = '1' WHERE provider_event_id = 'super-event'").run();
    const firstFinalAt = new Date(String(confirmedLifecycle.next_attempt_at)).getTime();
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, undefined, firstFinalAt));
    expect(await storage(slug, (state) => ({
      season: [...state.storage.sql.exec("SELECT state FROM season WHERE id = 's1'")][0],
      snapshot: [...state.storage.sql.exec("SELECT correction_version FROM event_result_snapshot WHERE event_id = 'super-event'")][0],
      lifecycle: [...state.storage.sql.exec("SELECT phase, next_attempt_at FROM event_reconciliation WHERE event_id = 'super-event'")][0]
    }))).toMatchObject({ season: { state: "active" }, snapshot: { correction_version: "1" }, lifecycle: { phase: "final_15", next_attempt_at: expect.any(String) } });

    await bindings.DB.prepare("UPDATE sports_event SET home_score = '27', correction_version = '2' WHERE provider_event_id = 'super-event'").run();
    const correctionAt = new Date(String((await reconciliation(slug, "super-event")).next_attempt_at)).getTime();
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, undefined, correctionAt));
    expect(await storage(slug, (state) => ({
      season: [...state.storage.sql.exec("SELECT state FROM season WHERE id = 's1'")][0],
      snapshot: [...state.storage.sql.exec("SELECT correction_version FROM event_result_snapshot WHERE event_id = 'super-event'")][0],
      lifecycle: [...state.storage.sql.exec("SELECT phase FROM event_reconciliation WHERE event_id = 'super-event'")][0]
    }))).toEqual({ season: { state: "active" }, snapshot: { correction_version: "2" }, lifecycle: { phase: "final_24" } });

    expect(await send(slug, { type: "VoidWager", commandId: "void-ordinary", actorId: "owner", wagerId: "ordinary", reason: "Official cancellation" })).toMatchObject({ commandVersion: expect.any(String) });
    expect(await storage(slug, (state) => ({ season: [...state.storage.sql.exec("SELECT state, close_reason FROM season WHERE id = 's1'")][0], closures: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM outbox WHERE event_type = 'SeasonClosed'")][0] }))).toEqual({ season: { state: "closed", close_reason: "super_bowl_final" }, closures: { count: 1 } });
    const noWagerHistory = await direct(slug, { type: "ReadSeasonHistory", commandId: "no-wager-history", actorId: "member", seasonId: "s1" });
    expect((noWagerHistory.eventResults as any[]).map(({ eventId, result }) => ({ eventId, correctionVersion: result.correctionVersion }))).toEqual([{ eventId: "super-event", correctionVersion: "2" }]);

    const final24At = new Date(String((await reconciliation(slug, "super-event")).next_attempt_at)).getTime();
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, undefined, final24At));
    expect(await reconciliation(slug, "super-event")).toMatchObject({ phase: "complete", next_attempt_at: null });
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM outbox WHERE event_type = 'SeasonClosed'")][0])).toEqual({ count: 1 });
  }, 90_000);

  it("keeps scoreless finals pending and durably reconciles two later corrections", async () => {
    await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]);
    const slug = await fundedPool();
    await send(slug, { type: "PlaceStraightWager", commandId: "place", actorId: "member", wagerId: "w1", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg("event-final") });
    await bindings.DB.prepare("INSERT OR REPLACE INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, home_score, away_score, correction_version) VALUES (?, ?, 'nfl', 'Home', 'Away', ?, 'final', NULL, NULL, '0')").bind(`id-${slug}`, "event-final", new Date().toISOString()).run();
    let dueAt = new Date(String((await reconciliation(slug, "event-final")).next_attempt_at)).getTime();
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, undefined, dueAt));
    expect(await storage(slug, (state) => ({ wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = 'w1'")][0], account: [...state.storage.sql.exec("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0], reconciliation: [...state.storage.sql.exec("SELECT phase, attempts, next_attempt_at FROM event_reconciliation WHERE event_id = 'event-final'")][0] }))).toMatchObject({ wager: { status: "open" }, account: { available_micros: "2000000", locked_micros: "1000000" }, reconciliation: { phase: "open", attempts: 1 } });
    await bindings.DB.prepare("UPDATE sports_event SET home_score = '24', away_score = '17', correction_version = '1' WHERE provider_event_id = 'event-final'").run();
    dueAt = new Date(String((await reconciliation(slug, "event-final")).next_attempt_at)).getTime();
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, undefined, dueAt));
    expect(await storage(slug, (state) => ({ wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = 'w1'")][0], reconciliation: [...state.storage.sql.exec("SELECT phase, deadline_at FROM event_reconciliation WHERE event_id = 'event-final'")][0] }))).toMatchObject({ wager: { status: "won" }, reconciliation: { phase: "final_15" } });
    await bindings.DB.prepare("UPDATE sports_event SET home_score = '10', away_score = '17', correction_version = '2' WHERE provider_event_id = 'event-final'").run();
    dueAt = new Date(String((await reconciliation(slug, "event-final")).next_attempt_at)).getTime();
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, undefined, dueAt));
    await bindings.DB.prepare("UPDATE sports_event SET home_score = '24', away_score = '17', correction_version = '3' WHERE provider_event_id = 'event-final'").run();
    dueAt = new Date(String((await reconciliation(slug, "event-final")).next_attempt_at)).getTime();
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), async (_instance, state) => runSettlementAlarm(state, bindings.DB, undefined, dueAt));
    expect(await storage(slug, (state) => ({ wager: [...state.storage.sql.exec("SELECT status FROM wager WHERE id = 'w1'")][0], settlements: [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM settlement WHERE wager_id = 'w1'")][0], account: [...state.storage.sql.exec("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0], reconciliation: [...state.storage.sql.exec("SELECT phase FROM event_reconciliation WHERE event_id = 'event-final'")][0] }))).toEqual({ wager: { status: "won" }, settlements: { count: 5 }, account: { available_micros: "4000000", locked_micros: "0" }, reconciliation: { phase: "complete" } });
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT event_id, correction_version, append_order FROM season_provider_result WHERE season_id = 's1' ORDER BY append_order")])).toEqual([
      { event_id: "event-final", correction_version: "1", append_order: 1 },
      { event_id: "event-final", correction_version: "2", append_order: 2 },
      { event_id: "event-final", correction_version: "3", append_order: 3 }
    ]);
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT event_id, correction_version FROM season_provider_result WHERE season_id = 's1'")])).toHaveLength(3);
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT event_type, payload_json FROM outbox WHERE event_type IN ('SettlementApplied', 'SettlementRegraded')")].map((row) => ({ eventType: String(row.event_type), payload: JSON.parse(String(row.payload_json)) })))).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "SettlementApplied", payload: expect.objectContaining({ wagerId: "w1", resultIdentity: expect.any(Array) }) }), expect.objectContaining({ eventType: "SettlementRegraded", payload: expect.objectContaining({ wagerId: "w1", priorResultVersion: expect.any(String) }) })]));
  }, 90_000);
});

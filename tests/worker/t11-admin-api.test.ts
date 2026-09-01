import { applyD1Migrations, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkerApp } from "../../src/worker/app";
import { runSettlementAlarm } from "../../src/durable/alarm";
import type { FinalResultVersion } from "../../src/odds/result-source";
import { parseAuditExportSuccess, buildTeaserPlacement } from "../../src/web/api";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace; POOL_COMMAND_AUTHENTICATOR_KEY: string };
let migrated = false;
const origin = "https://pool.example.test";
const request = (path: string, body?: unknown, method = "POST") => new Request(`${origin}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json", origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const command = async (poolId: string, value: unknown) => (await bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)).fetch("https://pool.internal/command", { method: "POST", body: JSON.stringify(value) })).json() as Promise<Record<string, any>>;
const storage = async (poolId: string, callback: (state: DurableObjectState) => unknown) => runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)), (_instance, state) => callback(state));
const app = (user: { id: string; name: string } | null, recentlyAuthenticated?: () => Promise<boolean>, poolJoinNotifier?: { notifyPoolJoin(message: unknown): Promise<void>; notifyCommissionerTransfer(message: unknown): Promise<void> }) => createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => user, ...(recentlyAuthenticated ? { recentlyAuthenticated: async () => recentlyAuthenticated() } : {}), ...(poolJoinNotifier ? { poolJoinNotifier } : {}) });
const orderKeys = ["createdAt", "memberDisplayName", "memberId", "orderId", "priceMicros", "reason", "sharesMicros", "valueMicros"];

/** Real D1 discovery row plus a real PoolDO lifecycle: archived s0, active s1. */
async function setupPool(poolId: string, slug: string) {
  await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, slug, poolId, `create-${poolId}`, new Date().toISOString()).run();
  await command(poolId, { type: "InitializePool", commandId: `init-${poolId}`, poolId, slug, creatorId: "owner", creatorName: "Owner", poolName: "API Pool", password: "correct-password" });
  await command(poolId, { type: "JoinPool", commandId: `join-${poolId}`, actorId: "member", displayName: "Member", password: "correct-password" });
  await command(poolId, { type: "CreateSeason", commandId: `draft-s0-${poolId}`, actorId: "owner", seasonId: "s0", label: "2025" });
  await command(poolId, { type: "OpenSeason", commandId: `open-s0-${poolId}`, actorId: "owner", seasonId: "s0" });
  await command(poolId, { type: "CloseSeason", commandId: `close-s0-${poolId}`, actorId: "owner", seasonId: "s0", reason: "archived" });
  await command(poolId, { type: "CreateSeason", commandId: `draft-s1-${poolId}`, actorId: "owner", seasonId: "s1", label: "2026" });
  await command(poolId, { type: "OpenSeason", commandId: `open-s1-${poolId}`, actorId: "owner", seasonId: "s1" });
}

const fund = async (poolId: string, memberId = "member") => {
  const quote = await command(poolId, { type: "QuoteShareOrder", commandId: `fund-quote-${poolId}`, actorId: "owner", seasonId: "s1", memberId, mode: "shares", amountMicros: "2000000" });
  return command(poolId, { type: "ExecuteShareOrder", commandId: `fund-${poolId}`, actorId: "owner", seasonId: "s1", memberId, mode: "shares", amountMicros: "2000000", quote: { priceMicros: String(quote.priceMicros), commandVersion: String(quote.commandVersion) }, reason: "funding" });
};

const leg = (eventId: string, eventStartsAt: string) => ({ eventId, league: "nfl", canonicalBook: "DraftKings", retrievedAt: new Date().toISOString(), policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "offer-v1", canonicalOfferProof: { offerId: `${eventId}:spread:home`, eventId, offerVersion: "offer-v1", canonicalBook: "DraftKings", market: "spread", selection: "home", odds: -110, line: -3 }, market: "spread", selection: "home", originalLine: -3, adjustedLine: -3, originalOdds: -110, eventStartsAt, homeTeam: "Home", awayTeam: "Away" });
const placeWager = async (poolId: string, actorId: string, wagerId: string, eventId = wagerId) => {
  const view = await command(poolId, { type: "ReadPoolView", commandId: `view-${wagerId}-${poolId}`, actorId });
  const quoteKey = `quote:${wagerId}`;
  const projection = { quoteKey, ownerMemberId: actorId, commandVersion: String(view.commandVersion), fingerprint: `fixture:${quoteKey}`, wagerId, actorId, seasonId: "s1", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg(eventId, new Date(Date.now() + 60 * 60 * 1000).toISOString()) };
  const quote = await command(poolId, { type: "QuoteStraightWager", commandId: quoteKey, actorId, identity: { actorId, quoteKey, fingerprint: projection.fingerprint }, projection });
  return command(poolId, { type: "PlaceStraightWager", commandId: wagerId, actorId, wagerId, quoteKey, quotedCommandVersion: String(quote.commandVersion), seasonId: quote.seasonId, riskMicros: quote.riskMicros, acceptedOdds: quote.acceptedOdds, rulesetVersion: quote.rulesetVersion, leg: quote.leg });
};

beforeEach(async () => {
  if (!migrated) { await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
  await bindings.DB.exec("DELETE FROM market_offer; DELETE FROM sports_event; DELETE FROM pool_registry_command_response; DELETE FROM pool_registry; INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'owner-t11@example.test', 1, 0, 0), ('member', 'Member', 'member-t11@example.test', 1, 0, 0), ('stranger', 'Stranger', 'stranger-t11@example.test', 1, 0, 0);");
});

describe("T11 member read boundaries over the Worker API", () => {
  it("returns exact parsed read shapes and enforces member authorization", async () => {
    const poolId = `t11-reads-${crypto.randomUUID()}`; const slug = "t11-reads-pool";
    await setupPool(poolId, slug);
    await fund(poolId);
    await placeWager(poolId, "member", "w1");
    const member = app({ id: "member", name: "Member" });
    const owner = app({ id: "owner", name: "Owner" });

    const standings = await member.fetch(request(`/api/p/${slug}/standings`, undefined, "GET"));
    expect(standings.status).toBe(200);
    expect(await standings.json()).toEqual({
      commandVersion: expect.any(String),
      standings: [
        { rank: 1, userId: "member", displayName: "Member", availableMicros: "1000000", lockedMicros: "1000000", totalMicros: "2000000", priceMicros: "1000000", notionalValueMicros: "2000000", gainMicros: "0" },
        { rank: 2, userId: "owner", displayName: "Owner", availableMicros: "0", lockedMicros: "0", totalMicros: "0", priceMicros: "1000000", notionalValueMicros: "0", gainMicros: "0" }
      ]
    });

    const memberActivity = await member.fetch(request(`/api/p/${slug}/activity`, undefined, "GET"));
    expect(memberActivity.status).toBe(200);
    const memberBody = await memberActivity.json() as any;
    expect(Object.keys(memberBody.activity.orders[0]).sort()).toEqual(orderKeys);
    expect(memberBody.activity.orders[0]).toMatchObject({ memberId: "member", memberDisplayName: "Member", sharesMicros: "2000000", valueMicros: "2000000", priceMicros: "1000000", reason: "funding" });
    expect(memberBody.activity.wagers[0]).toMatchObject({ wagerId: "w1", type: "straight", status: "open", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1" });
    expect(memberBody.activity.wagers[0].legs[0]).toMatchObject({ eventId: "w1", market: "spread", selection: "home" });
    // The commissioner sees the identical redacted shape for another member's unstarted ticket.
    const ownerActivity = await owner.fetch(request(`/api/p/${slug}/activity`, undefined, "GET"));
    const ownerBody = await ownerActivity.json() as any;
    expect(Object.keys(ownerBody.activity.wagers[0]).sort()).toEqual(["confirmedAt", "memberDisplayName", "memberId", "seasonId", "status", "type", "wagerId"]);
    expect(ownerBody.activity.wagers[0]).toEqual({ wagerId: "w1", seasonId: "s1", memberId: "member", memberDisplayName: "Member", type: "straight", status: "open", confirmedAt: memberBody.activity.wagers[0].confirmedAt });

    const history = await member.fetch(request(`/api/p/${slug}/history/s0`, undefined, "GET"));
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual({
      commandVersion: expect.any(String),
      season: { seasonId: "s0", label: "2025", rulesetVersion: "SHARE_POOL_2026_V1", state: "closed", openedAt: expect.any(String), closedAt: expect.any(String), closeReason: "archived", floatMicros: "0", notionalMicros: "0", priceMicros: "1000000" },
      accounts: [
        { memberId: "member", memberDisplayName: "Member", availableMicros: "0", lockedMicros: "0", totalMicros: "0", holdingValueMicros: "0", gainMicros: "0" },
        { memberId: "owner", memberDisplayName: "Owner", availableMicros: "0", lockedMicros: "0", totalMicros: "0", holdingValueMicros: "0", gainMicros: "0" }
      ],
      standings: [
        { rank: 1, userId: "member", displayName: "Member", availableMicros: "0", lockedMicros: "0", totalMicros: "0", priceMicros: "1000000", notionalValueMicros: "0", gainMicros: "0" },
        { rank: 2, userId: "owner", displayName: "Owner", availableMicros: "0", lockedMicros: "0", totalMicros: "0", priceMicros: "1000000", notionalValueMicros: "0", gainMicros: "0" }
      ],
      orders: [], ledger: [], annotations: [], wagers: [], settlements: [], wagerCorrections: [], eventResults: []
    });
    // Season filtering and boundary rejection: s1's wager stays out of s0, and a nonclosed season is rejected.
    const missing = await member.fetch(request(`/api/p/${slug}/history/missing`, undefined, "GET"));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "SEASON_NOT_FOUND" });
    const activeHistory = await member.fetch(request(`/api/p/${slug}/history/s1`, undefined, "GET"));
    expect(activeHistory.status).toBe(400);
    expect(await activeHistory.json()).toEqual({ code: "SEASON_NOT_CLOSED" });
    const wagers = await member.fetch(request(`/api/p/${slug}/wagers`, undefined, "GET"));
    expect(wagers.status).toBe(200);
    expect(((await wagers.json()) as any).wagers[0]).toMatchObject({ wagerId: "w1", status: "open", riskMicros: "1000000" });

    expect((await app(null).fetch(request(`/api/p/${slug}/standings`, undefined, "GET"))).status).toBe(401);
    expect((await app({ id: "stranger", name: "Stranger" }).fetch(request(`/api/p/${slug}/standings`, undefined, "GET"))).status).toBe(403);
  }, 120_000);

  it("carries a binding-valid same-game teaser through Worker quote, settlement, export, manual regrade, and provider correction", async () => {
    const poolId = `t11-same-game-${crypto.randomUUID()}`; const slug = "t11-same-game-pool";
    await setupPool(poolId, slug);
    await fund(poolId);
    const eventId = `same-game-${crypto.randomUUID()}`;
    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const retrievedAt = new Date().toISOString();
    await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES (?, ?, 'nfl', 'Home', 'Away', ?, 'scheduled', 'provider-0')").bind(eventId, eventId, startsAt).run();
    for (const [market, outcomes] of [
      ["spread", [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }]],
      ["total", [{ name: "Over", price: -110, point: 40 }, { name: "Under", price: -110, point: 40 }]]
    ] as const) await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES (?, ?, 'DraftKings', ?, 'offer-v1', ?)").bind(eventId, market, retrievedAt, JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes })).run();
    await bindings.DB.prepare("INSERT INTO odds_ingestion (provider, last_polled_at, last_success_at, last_error) VALUES ('odds', ?, ?, NULL) ON CONFLICT(provider) DO UPDATE SET last_polled_at = excluded.last_polled_at, last_success_at = excluded.last_success_at, last_error = NULL").bind(retrievedAt, retrievedAt).run();

    const member = app({ id: "member", name: "Member" });
    const owner = app({ id: "owner", name: "Owner" }, async () => true);
    const quoteRequest = {
      quoteKey: "same-game-quote", commandId: "same-game-quote", wagerId: "same-game-wager", seasonId: "s1", riskMicros: "1000000", teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1",
      legs: [
        { eventId, canonicalBook: "DraftKings", market: "spread", selection: "home", offerId: `${eventId}:spread:home`, offerVersion: "offer-v1" },
        { eventId, canonicalBook: "DraftKings", market: "total", selection: "over", offerId: `${eventId}:total:over`, offerVersion: "offer-v1" }
      ]
    };
    const quoteResponse = await member.fetch(request(`/api/p/${slug}/wagers/teasers/quote`, quoteRequest));
    expect(quoteResponse.status).toBe(200);
    const quote = await quoteResponse.json() as any;
    expect(quote).toMatchObject({ acceptedOdds: -120, teaserPoints: 6, legs: [{ eventId, market: "spread", adjustedLine: 3 }, { eventId, market: "total", adjustedLine: 34 }] });
    const placement = buildTeaserPlacement(quote, "same-game-wager", "same-game-place");
    const placeResponse = await member.fetch(request(`/api/p/${slug}/wagers/teasers/place`, placement));
    expect(placeResponse.status).toBe(200);

    const stub = bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId));
    const result = (correctionVersion: string, homeScore: number, awayScore: number): FinalResultVersion => ({ eventId, league: "nfl", status: "final", homeScore, awayScore, correctionVersion });
    const poll = async (evidence: FinalResultVersion) => runInDurableObject(stub, async (_instance, state) => {
      const due = [...state.storage.sql.exec<{ next_attempt_at: string }>("SELECT next_attempt_at FROM event_reconciliation WHERE event_id = ?", eventId)][0]!.next_attempt_at;
      return runSettlementAlarm(state, bindings.DB, { getFinalResults: async (eventIds) => { expect(eventIds).toEqual([eventId]); return [evidence]; } }, new Date(due).getTime());
    });
    await poll(result("provider-1", 24, 17));
    await runInDurableObject(stub, (instance) => { (instance as unknown as { authoritativeTime(): Date }).authoritativeTime = () => new Date(new Date(startsAt).getTime() + 1); });

    const authenticatedExport = async (worker: ReturnType<typeof app>) => {
      const response = await worker.fetch(request(`/api/p/${slug}/export`, undefined, "GET"));
      expect(response.status).toBe(200);
      return parseAuditExportSuccess(await response.json());
    };
    const automatic = await authenticatedExport(member);
    expect(automatic).toMatchObject({
      accounts: expect.arrayContaining([{ seasonId: "s1", memberId: "member", availableMicros: "2833333", lockedMicros: "0", rowVersion: expect.any(String) }]),
      settlements: [{ wagerId: "same-game-wager", resultVersion: `[["${eventId}","provider-1"]]`, outcome: "win", returnMicros: "1833333", profitMicros: "833333", sourceResult: [result("provider-1", 24, 17)], reversalOf: null, actorId: "system", reason: null, id: expect.any(String), createdAt: expect.any(String) }],
      wagerCorrections: [], administrationAudit: [],
      wagers: [expect.objectContaining({ wagerId: "same-game-wager", status: "won", riskMicros: "1000000", acceptedOdds: -120, outcome: "won", returnMicros: "1833333", profitMicros: "833333", legs: [expect.objectContaining({ eventId, market: "spread", grade: "win", resultVersion: "provider-1" }), expect.objectContaining({ eventId, market: "total", grade: "win", resultVersion: "provider-1" })] })]
    });
    expect((automatic.settlements[0].sourceResult as unknown[])).toHaveLength(1);
    const commissionerAutomatic = await authenticatedExport(owner);
    const commissionerWager = commissionerAutomatic.wagers[0] as Record<string, unknown>;
    expect(Object.keys(commissionerWager).sort()).toEqual(["confirmedAt", "legs", "memberDisplayName", "memberId", "seasonId", "status", "type", "wagerId"]);
    expect(commissionerWager).toMatchObject({ memberId: "member", memberDisplayName: "Member" });
    expect(JSON.stringify(commissionerWager)).not.toMatch(/riskMicros|acceptedOdds|outcome|returnMicros|profitMicros|canonicalOfferProof|ownerMemberId/);

    const regrade = await owner.fetch(request(`/api/p/${slug}/admin/corrections/same-game-wager/regrade`, { reason: "Official correction", correctedResults: [result("official-2", 17, 24)], idempotencyKey: "same-game-regrade" }));
    expect(regrade.status).toBe(200);
    const manual = await authenticatedExport(member);
    expect(manual.wagers[0]).toMatchObject({ status: "lost", outcome: "lost", returnMicros: "0", profitMicros: "0", legs: [expect.objectContaining({ grade: "loss", resultVersion: "provider-1" }), expect.objectContaining({ grade: "win", resultVersion: "provider-1" })] });
    expect(manual.settlements.map(({ outcome }) => outcome)).toEqual(["win", "reversal", "loss"]);
    expect(manual.wagerCorrections).toEqual([expect.objectContaining({ wagerId: "same-game-wager", actorId: "owner", reason: "Official correction", commandId: "same-game-regrade", sourceResult: [result("provider-1", 24, 17)], replacementResult: expect.objectContaining({ correctedResults: [result("official-2", 17, 24)], derived: { outcome: "loss", odds: null } }) })]);
    expect(manual.administrationAudit).toEqual([expect.objectContaining({ actorId: "owner", action: "regrade_wager", subjectId: "same-game-wager", reason: "Official correction", commandId: "same-game-regrade" })]);

    const stable = JSON.stringify(manual);
    await poll(result("provider-1", 24, 17));
    expect(JSON.stringify(await authenticatedExport(member))).toBe(stable);
    await poll(result("provider-2", 28, 17));
    const corrected = await authenticatedExport(member);
    expect(corrected.wagers[0]).toMatchObject({ status: "won", outcome: "won", returnMicros: "1833333", profitMicros: "833333", legs: [expect.objectContaining({ grade: "win", resultVersion: "provider-2" }), expect.objectContaining({ grade: "win", resultVersion: "provider-2" })] });
    expect(corrected.settlements.map(({ outcome }) => outcome)).toEqual(["win", "reversal", "loss", "reversal", "win"]);
    expect(corrected.wagerCorrections).toHaveLength(1);
    expect(corrected.administrationAudit).toHaveLength(1);
    expect(await storage(poolId, (state) => ({
      account: [...state.storage.sql.exec("SELECT available_micros, locked_micros, row_version FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0],
      season: [...state.storage.sql.exec("SELECT state, float_micros, notional_micros FROM season WHERE id = 's1'")][0],
      wager: [...state.storage.sql.exec("SELECT status, settled_result_version FROM wager WHERE id = 'same-game-wager'")][0],
      legs: [...state.storage.sql.exec("SELECT event_id, league, market, selection, grade, result_version FROM wager_leg WHERE wager_id = 'same-game-wager' ORDER BY id")],
      ledger: [...state.storage.sql.exec("SELECT available_delta, locked_delta, float_delta, kind, causation_id FROM ledger_entry WHERE member_id = 'member' ORDER BY rowid")],
      settlements: [...state.storage.sql.exec("SELECT outcome, return_micros, profit_micros, actor_id, reason FROM settlement WHERE wager_id = 'same-game-wager' ORDER BY rowid")],
      audit: [...state.storage.sql.exec("SELECT action, subject_id, reason, command_id FROM administration_audit ORDER BY rowid")],
      outbox: [...state.storage.sql.exec("SELECT event_type, version, delivered_at FROM outbox ORDER BY rowid")]
    }))).toEqual({
      account: { available_micros: "2833333", locked_micros: "0", row_version: expect.any(String) }, season: { state: "active", float_micros: "2833333", notional_micros: "2000000" },
      wager: { status: "won", settled_result_version: `[["${eventId}","provider-2"]]` },
      legs: [{ event_id: eventId, league: "nfl", market: "spread", selection: "home", grade: "win", result_version: "provider-2" }, { event_id: eventId, league: "nfl", market: "total", selection: "over", grade: "win", result_version: "provider-2" }],
      ledger: [
        { available_delta: "2000000", locked_delta: "0", float_delta: "2000000", kind: "order", causation_id: expect.any(String) },
        { available_delta: "-1000000", locked_delta: "1000000", float_delta: "0", kind: "wager_lock", causation_id: "same-game-wager" },
        { available_delta: "1833333", locked_delta: "-1000000", float_delta: "833333", kind: "settlement", causation_id: "same-game-wager" },
        { available_delta: "-1833333", locked_delta: "1000000", float_delta: "-833333", kind: "settlement_reversal", causation_id: expect.stringMatching(/^reversal:/) },
        { available_delta: "0", locked_delta: "-1000000", float_delta: "-1000000", kind: "settlement", causation_id: "same-game-wager" },
        { available_delta: "0", locked_delta: "1000000", float_delta: "1000000", kind: "settlement_reversal", causation_id: expect.stringMatching(/^reversal:/) },
        { available_delta: "1833333", locked_delta: "-1000000", float_delta: "833333", kind: "settlement", causation_id: "same-game-wager" }
      ], settlements: [{ outcome: "win", return_micros: "1833333", profit_micros: "833333", actor_id: "system", reason: null }, { outcome: "reversal", return_micros: "-1833333", profit_micros: "-833333", actor_id: "owner", reason: "Official correction" }, { outcome: "loss", return_micros: "0", profit_micros: "0", actor_id: "owner", reason: "Official correction" }, { outcome: "reversal", return_micros: "0", profit_micros: "0", actor_id: "system", reason: null }, { outcome: "win", return_micros: "1833333", profit_micros: "833333", actor_id: "system", reason: null }],
      audit: [{ action: "regrade_wager", subject_id: "same-game-wager", reason: "Official correction", command_id: "same-game-regrade" }],
      outbox: [
        ...["1", "2", "3", "4", "5"].map((version) => ({ event_type: "CommandApplied", version, delivered_at: null })),
        { event_type: "SeasonClosed", version: "5", delivered_at: null },
        ...["6", "7", "8", "9"].map((version) => ({ event_type: "CommandApplied", version, delivered_at: null })),
        { event_type: "SettlementApplied", version: "10", delivered_at: null },
        { event_type: "CommandApplied", version: "11", delivered_at: null },
        { event_type: "SettlementRegraded", version: "12", delivered_at: null }
      ]
    });
  }, 120_000);

  it("suspension denies authoritative member reads until restore", async () => {
    const poolId = `t11-suspend-${crypto.randomUUID()}`; const slug = "t11-suspend-pool";
    await setupPool(poolId, slug);
    const commissioner = app({ id: "owner", name: "Owner" }, async () => true);
    const member = app({ id: "member", name: "Member" });
    expect((await member.fetch(request(`/api/p/${slug}/standings`, undefined, "GET"))).status).toBe(200);
    expect((await commissioner.fetch(request(`/api/p/${slug}/admin/members/member/suspend`, { idempotencyKey: "suspend" })))).toMatchObject({ status: 200 });
    for (const path of ["view", "standings", "activity", "history/s0"]) {
      const denied = await member.fetch(request(`/api/p/${slug}/${path}`, undefined, "GET"));
      expect(denied.status, path).toBe(403);
      expect(await denied.json(), path).toEqual({ code: "SUSPENDED" });
    }
    expect((await commissioner.fetch(request(`/api/p/${slug}/admin/members/member/restore`, { idempotencyKey: "restore" })))).toMatchObject({ status: 200 });
    expect((await member.fetch(request(`/api/p/${slug}/standings`, undefined, "GET"))).status).toBe(200);
    expect(await (await commissioner.fetch(request(`/api/p/${slug}/admin/members/owner/suspend`, { idempotencyKey: "self" }))).json()).toEqual({ code: "CANNOT_SUSPEND_COMMISSIONER" });
    expect(await (await commissioner.fetch(request(`/api/p/${slug}/admin/members/ghost/suspend`, { idempotencyKey: "ghost" }))).json()).toEqual({ code: "MEMBER_NOT_FOUND" });
    expect((await member.fetch(request(`/api/p/${slug}/admin/members/owner/suspend`, { idempotencyKey: "member-suspend" })))).toMatchObject({ status: 403 });
  }, 120_000);
});

describe("T11 administration HTTP commands and prohibitions", () => {
  it("transfers commissioner authority only with recent auth, a reason, and an active target", async () => {
    const poolId = `t11-transfer-${crypto.randomUUID()}`; const slug = "t11-transfer-pool";
    await setupPool(poolId, slug);
    const body = { memberId: "member", reason: "Documented handover", idempotencyKey: "transfer" };
    expect((await app({ id: "owner", name: "Owner" }, async () => false).fetch(request(`/api/p/${slug}/admin/transfer`, body)))).toMatchObject({ status: 403 });
    const notifications: any[] = [];
    const notifier = { async notifyPoolJoin(_message: unknown) {}, async notifyCommissionerTransfer(message: unknown) { notifications.push(message); } };
    const owner = app({ id: "owner", name: "Owner" }, async () => true, notifier);
    const member = app({ id: "member", name: "Member" }, async () => true);
    expect((await member.fetch(request(`/api/p/${slug}/admin/transfer`, body)))).toMatchObject({ status: 403 });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/transfer`, { ...body, reason: "" })))).toMatchObject({ status: 400 });
    expect(await (await owner.fetch(request(`/api/p/${slug}/admin/transfer`, { ...body, memberId: "ghost", idempotencyKey: "ghost-transfer" }))).json()).toEqual({ code: "MEMBER_NOT_FOUND" });
    await owner.fetch(request(`/api/p/${slug}/admin/members/member/suspend`, { idempotencyKey: "suspend-target" }));
    const suspended = await owner.fetch(request(`/api/p/${slug}/admin/transfer`, { ...body, idempotencyKey: "suspended-transfer" }));
    expect(suspended.status).toBe(403);
    expect(await suspended.json()).toEqual({ code: "SUSPENDED" });
    await owner.fetch(request(`/api/p/${slug}/admin/members/member/restore`, { idempotencyKey: "restore-target" }));
    expect((await owner.fetch(request(`/api/p/${slug}/admin/transfer`, body)))).toMatchObject({ status: 200 });
    expect(notifications).toEqual([
      expect.objectContaining({ to: "member-t11@example.test", recipient: "new", poolName: "API Pool" }),
      expect.objectContaining({ to: "owner-t11@example.test", recipient: "former", poolName: "API Pool" })
    ]);
    const view = await (await member.fetch(request(`/api/p/${slug}/view`, undefined, "GET"))).json() as any;
    expect(view.pool.commissionerId).toBe("member");
    expect(view.members.filter((entry: any) => entry.role === "commissioner")).toHaveLength(1);
    // Exactly one commissioner remains: the former commissioner loses administration.
    expect((await owner.fetch(request(`/api/p/${slug}/admin/members/member/suspend`, { idempotencyKey: "old-owner" })))).toMatchObject({ status: 403 });
    expect((await member.fetch(request(`/api/p/${slug}/admin/members/owner/suspend`, { idempotencyKey: "new-owner" })))).toMatchObject({ status: 200 });
  }, 120_000);

  it("settings rename and signup toggles skip recent auth while password rotation demands it", async () => {
    const poolId = `t11-settings-${crypto.randomUUID()}`; const slug = "t11-settings-pool";
    await setupPool(poolId, slug);
    expect((await app({ id: "member", name: "Member" }).fetch(request(`/api/p/${slug}/admin/settings`, { poolName: "Nope", idempotencyKey: "member" })))).toMatchObject({ status: 403 });
    const owner = app({ id: "owner", name: "Owner" });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/settings`, { poolName: "Renamed Pool", idempotencyKey: "rename" })))).toMatchObject({ status: 200 });
    const view = await (await app({ id: "member", name: "Member" }).fetch(request(`/api/p/${slug}/view`, undefined, "GET"))).json() as any;
    expect(view.pool.name).toBe("Renamed Pool");
    expect((await owner.fetch(request(`/api/p/${slug}/admin/settings`, { maxSideBet: "900", idempotencyKey: "max-side-bet" })))).toMatchObject({ status: 200 });
    const updatedView = await (await app({ id: "member", name: "Member" }).fetch(request(`/api/p/${slug}/view`, undefined, "GET"))).json() as any;
    expect(updatedView.pool.maxSideBetMicros).toBe("900000000");
    expect((await owner.fetch(request(`/api/p/${slug}/admin/settings`, { signupsOpen: false, idempotencyKey: "close-signups" })))).toMatchObject({ status: 200 });
    expect(((await (await app({ id: "member", name: "Member" }).fetch(request(`/api/p/${slug}/view`, undefined, "GET"))).json()) as any).pool.signupsOpen).toBe(false);
    expect((await owner.fetch(request(`/api/p/${slug}/admin/settings`, { password: "rotated-password", idempotencyKey: "rotate" })))).toMatchObject({ status: 403 });
    expect((await app({ id: "owner", name: "Owner" }, async () => true).fetch(request(`/api/p/${slug}/admin/settings`, { password: "rotated-password", idempotencyKey: "rotate-recent" })))).toMatchObject({ status: 200 });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/settings`, { idempotencyKey: "empty" })))).toMatchObject({ status: 400 });
  }, 120_000);

  it("void and regrade require reason, recent auth, commissioner role, and an active season", async () => {
    const poolId = `t11-corrections-${crypto.randomUUID()}`; const slug = "t11-corrections-pool";
    await setupPool(poolId, slug);
    await fund(poolId);
    await placeWager(poolId, "member", "w1");
    const member = app({ id: "member", name: "Member" }, async () => true);
    const owner = app({ id: "owner", name: "Owner" }, async () => true);
    const stale = app({ id: "owner", name: "Owner" }, async () => false);
    expect((await member.fetch(request(`/api/p/${slug}/admin/corrections/w1/void`, { reason: "Nope", idempotencyKey: "member" })))).toMatchObject({ status: 403 });
    expect((await stale.fetch(request(`/api/p/${slug}/admin/corrections/w1/void`, { reason: "Official void", idempotencyKey: "stale" })))).toMatchObject({ status: 403 });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/corrections/w1/void`, { idempotencyKey: "no-reason" })))).toMatchObject({ status: 400 });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/corrections/w1/void`, { reason: "   ", idempotencyKey: "blank-reason" })))).toMatchObject({ status: 400 });
    expect(await (await owner.fetch(request(`/api/p/${slug}/admin/corrections/ghost/void`, { reason: "Official void", idempotencyKey: "ghost" }))).json()).toEqual({ code: "WAGER_NOT_FOUND" });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/corrections/w1/void`, { reason: "Official void", idempotencyKey: "void" })))).toMatchObject({ status: 200 });
    const voided = await (await member.fetch(request(`/api/p/${slug}/wagers`, undefined, "GET"))).json() as any;
    expect(voided.wagers[0]).toMatchObject({ wagerId: "w1", status: "refunded", outcome: "refunded", returnMicros: "1000000", profitMicros: "0", settledAt: expect.any(String) });
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)), (instance, state) => {
      const startsAt = [...state.storage.sql.exec<{ starts_at: string }>("SELECT MAX(event_starts_at) AS starts_at FROM wager_leg WHERE wager_id = 'w1'")][0]!.starts_at;
      (instance as unknown as { authoritativeTime(): Date }).authoritativeTime = () => new Date(new Date(startsAt).getTime() + 1);
    });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/corrections/w1/regrade`, { reason: "Official regrade", outcome: "won", idempotencyKey: "regrade-missing" })))).toMatchObject({ status: 400 });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/corrections/w1/regrade`, { reason: "Official regrade", correctedResults: [{ eventId: "w1", league: "nfl", status: "final", homeScore: 24, awayScore: 17, correctionVersion: "official-v2" }], idempotencyKey: "regrade" })))).toMatchObject({ status: 200 });
    const regraded = await (await member.fetch(request(`/api/p/${slug}/wagers`, undefined, "GET"))).json() as any;
    expect(regraded.wagers[0]).toMatchObject({ wagerId: "w1", status: "won", outcome: "won", returnMicros: "2000000", profitMicros: "1000000" });
    // Corrected history stays immutable: the void, its reversal, and the regrade all remain on the ledger.
    expect(await storage(poolId, (state) => [...state.storage.sql.exec("SELECT outcome, return_micros FROM settlement WHERE wager_id = 'w1' ORDER BY created_at")].map((row) => ({ outcome: String(row.outcome), returnMicros: String(row.return_micros) })))).toEqual([
      { outcome: "refund", returnMicros: "1000000" },
      { outcome: "reversal", returnMicros: "-1000000" },
      { outcome: "win", returnMicros: "2000000" }
    ]);
    await command(poolId, { type: "CloseSeason", commandId: `close-s1-${poolId}`, actorId: "owner", seasonId: "s1", reason: "archived" });
    const archive = await (await member.fetch(request(`/api/p/${slug}/history/s1`, undefined, "GET"))).json() as any;
    expect(archive.settlements.map((entry: any) => entry.outcome)).toEqual(["refund", "reversal", "win"]);
    expect(archive.wagerCorrections).toEqual([
      expect.objectContaining({ wagerId: "w1", actorId: "owner", reason: "Official void", replacementResult: { source: "commissioner_void", commandId: "void", outcome: "refund" } }),
      expect.objectContaining({ wagerId: "w1", actorId: "owner", reason: "Official regrade", sourceResult: { source: "commissioner_void", commandId: "void", outcome: "refund" }, replacementResult: expect.objectContaining({ source: "commissioner_correction", commandId: "regrade" }) })
    ]);
    expect(archive.ledger.every((entry: any) => entry.seasonId === "s1")).toBe(true);
    expect(archive.orders.every((entry: any) => entry.seasonId === "s1")).toBe(true);
    expect(await (await owner.fetch(request(`/api/p/${slug}/admin/corrections/w1/regrade`, { reason: "Too late", correctedResults: [{ eventId: "w1", league: "nfl", status: "final", homeScore: 10, awayScore: 17, correctionVersion: "official-v3" }], idempotencyKey: "closed" }))).json()).toEqual({ code: "SEASON_NOT_ACTIVE" });
  }, 120_000);

  it("appends commissioner-only annotations to closed history and keeps season lifecycle closed", async () => {
    const poolId = `t11-annotations-${crypto.randomUUID()}`; const slug = "t11-annotations-pool";
    await setupPool(poolId, slug);
    const owner = app({ id: "owner", name: "Owner" });
    const member = app({ id: "member", name: "Member" });
    expect((await member.fetch(request(`/api/p/${slug}/admin/history/s0/annotations`, { text: "Member note", idempotencyKey: "member" })))).toMatchObject({ status: 403 });
    expect(await (await owner.fetch(request(`/api/p/${slug}/admin/history/s1/annotations`, { text: "Active note", idempotencyKey: "active" }))).json()).toEqual({ code: "SEASON_NOT_CLOSED" });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/history/s0/annotations`, { text: "First note", idempotencyKey: "first" })))).toMatchObject({ status: 200 });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/history/s0/annotations`, { text: "Second note", idempotencyKey: "second" })))).toMatchObject({ status: 200 });
    const history = await (await member.fetch(request(`/api/p/${slug}/history/s0`, undefined, "GET"))).json() as any;
    expect(history.annotations).toEqual([
      expect.objectContaining({ authorDisplayName: "Owner", text: "First note" }),
      expect.objectContaining({ authorDisplayName: "Owner", text: "Second note" })
    ]);
    expect(await (await owner.fetch(request(`/api/p/${slug}/admin/history/missing/annotations`, { text: "Nope", idempotencyKey: "missing" }))).json()).toEqual({ code: "SEASON_NOT_FOUND" });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/history/s0/annotations`, { text: "", idempotencyKey: "blank" })))).toMatchObject({ status: 400 });
    // No overlapping seasons while one is active, no reopening a closed season, and no manual close route at all.
    expect(await (await owner.fetch(request(`/api/p/${slug}/admin/seasons`, { seasonId: "s2", label: "2027", idempotencyKey: "overlap" }))).json()).toEqual({ code: "OVERLAPPING_SEASON" });
    expect(await (await owner.fetch(request(`/api/p/${slug}/admin/seasons/s0/open`, { idempotencyKey: "reopen" }))).json()).toEqual({ code: "SEASON_NOT_DRAFT" });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/seasons/s1/close`, { idempotencyKey: "manual", reason: "manual" })))).toMatchObject({ status: 404 });
    await command(poolId, { type: "CloseSeason", commandId: "close-active", actorId: "owner", seasonId: "s1", reason: "archived" });
    await command(poolId, { type: "CreateSeason", commandId: "draft-s2", actorId: "owner", seasonId: "s2", label: "2027" });
    expect(await (await owner.fetch(request(`/api/p/${slug}/admin/history/s2/annotations`, { text: "Draft note", idempotencyKey: "draft" }))).json()).toEqual({ code: "SEASON_NOT_CLOSED" });
  }, 120_000);

  it("confirms only the canonical Super Bowl candidate surfaced by the authoritative read", async () => {
    const poolId = `t11-superbowl-${crypto.randomUUID()}`; const slug = "t11-superbowl-pool";
    await setupPool(poolId, slug);
    await fund(poolId);
    const kickoff = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version, event_name, postseason) VALUES ('sb-lxii', 'sb-lxii', 'nfl', 'AFC', 'NFC', ?, 'scheduled', '1', 'Super Bowl LXII', 1)").bind(kickoff).run();
    expect(await runDurableObjectAlarm(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)))).toBe(true);
    expect(await storage(poolId, (state) => [...state.storage.sql.exec("SELECT COUNT(*) AS count FROM wager_leg WHERE event_id = 'sb-lxii'")][0])).toEqual({ count: 0 });
    const member = app({ id: "member", name: "Member" });
    const owner = app({ id: "owner", name: "Owner" }, async () => true);
    const view = await (await member.fetch(request(`/api/p/${slug}/view`, undefined, "GET"))).json() as any;
    expect(view.activeSeason.superBowlCandidate).toEqual({ eventId: "sb-lxii", providerEventName: "Super Bowl LXII", confirmedAt: null });
    expect((await member.fetch(request(`/api/p/${slug}/admin/seasons/s1/super-bowl/confirm`, { eventId: "sb-lxii", idempotencyKey: "member" })))).toMatchObject({ status: 403 });
    expect(await (await owner.fetch(request(`/api/p/${slug}/admin/seasons/s1/super-bowl/confirm`, { eventId: "wrong-event", idempotencyKey: "wrong" }))).json()).toEqual({ code: "SUPER_BOWL_NOT_CANONICAL" });
    expect((await owner.fetch(request(`/api/p/${slug}/admin/seasons/s1/super-bowl/confirm`, { eventId: "sb-lxii", idempotencyKey: "confirm" })))).toMatchObject({ status: 200 });
    const confirmed = await (await member.fetch(request(`/api/p/${slug}/view`, undefined, "GET"))).json() as any;
    expect(confirmed.activeSeason.superBowlCandidate).toEqual({ eventId: "sb-lxii", providerEventName: "Super Bowl LXII", confirmedAt: expect.any(String) });

    const mutationSnapshot = () => storage(poolId, (state) => Object.fromEntries([
      "pool", "season", "season_super_bowl", "season_super_bowl_reconciliation", "event_result_snapshot", "wager_leg_snapshot", "event_reconciliation", "processed_command", "administration_audit", "season_annotation", "outbox"
    ].map((table) => [table, JSON.stringify([...state.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`)])])));
    await command(poolId, { type: "CloseSeason", commandId: "close-confirmed", actorId: "owner", seasonId: "s1", reason: "archived" });
    const beforeClosed = await mutationSnapshot();
    expect(await (await owner.fetch(request(`/api/p/${slug}/admin/seasons/s1/super-bowl/confirm`, { eventId: "sb-lxii", idempotencyKey: "confirm-closed" }))).json()).toEqual({ code: "SEASON_NOT_ACTIVE" });
    expect(await mutationSnapshot()).toEqual(beforeClosed);

    await command(poolId, { type: "CreateSeason", commandId: "draft-after-confirm", actorId: "owner", seasonId: "s2", label: "2027" });
    await storage(poolId, (state) => state.storage.sql.exec("INSERT INTO season_super_bowl (season_id, event_id, provider_event_name, event_starts_at, confirmed_at) VALUES ('s2', 'sb-lxiii', 'Super Bowl LXIII', ?, NULL)", kickoff));
    const beforeDraft = await mutationSnapshot();
    expect(await (await owner.fetch(request(`/api/p/${slug}/admin/seasons/s2/super-bowl/confirm`, { eventId: "sb-lxiii", idempotencyKey: "confirm-draft" }))).json()).toEqual({ code: "SEASON_NOT_ACTIVE" });
    expect(await mutationSnapshot()).toEqual(beforeDraft);
  }, 120_000);
});

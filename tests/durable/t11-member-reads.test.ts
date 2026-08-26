import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PoolCommand } from "../../src/durable/pool-commands";

const pools = (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO;
const send = async (slug: string, command: PoolCommand) => {
  const response = await pools.get(pools.idFromName(slug)).fetch("https://pool.test/command", { method: "POST", body: JSON.stringify(command) });
  return await response.json() as Record<string, any>;
};
const storage = async (slug: string, callback: (state: DurableObjectState) => unknown) => runInDurableObject(pools.get(pools.idFromName(slug)), (_instance, state) => callback(state));

const initialize = (slug: string, creatorName: string) => send(slug, { type: "InitializePool", commandId: "init", poolId: slug, slug, poolName: "T11", creatorId: "owner", creatorName, password: "correct-password" });
const join = (slug: string, actorId: string, displayName: string) => send(slug, { type: "JoinPool", commandId: `join-${actorId}`, actorId, displayName, password: "correct-password" });
const draftSeason = (slug: string, seasonId: string, label: string) => send(slug, { type: "CreateSeason", commandId: `draft-${seasonId}`, actorId: "owner", seasonId, label }).then(() => send(slug, { type: "OpenSeason", commandId: `open-${seasonId}`, actorId: "owner", seasonId }));
const fund = async (slug: string, commandId: string, memberId: string, seasonId = "s1") => {
  const quote = await send(slug, { type: "QuoteShareOrder", commandId: `${commandId}-quote`, actorId: "owner", seasonId, memberId, mode: "shares", amountMicros: "2000000" });
  return send(slug, { type: "ExecuteShareOrder", commandId, actorId: "owner", seasonId, memberId, mode: "shares", amountMicros: "2000000", quote: { priceMicros: String(quote.priceMicros), commandVersion: String(quote.commandVersion) }, reason: `funding ${memberId}` });
};
const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const leg = (eventId: string, eventStartsAt = future()) => ({ eventId, league: "nfl" as const, canonicalBook: "DraftKings", retrievedAt: new Date().toISOString(), policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "offer-v1", canonicalOfferProof: { offerId: `${eventId}:spread:home`, eventId, offerVersion: "offer-v1", canonicalBook: "DraftKings", market: "spread" as const, selection: "home" as const, odds: -110, line: -3 }, market: "spread" as const, selection: "home" as const, originalLine: -3, adjustedLine: -3, originalOdds: -110, eventStartsAt, homeTeam: "Home", awayTeam: "Away" });
const placeWager = async (slug: string, actorId: string, wagerId: string, seasonId = "s1") => {
  const view = await send(slug, { type: "ReadPoolView", commandId: `version-${wagerId}`, actorId });
  const quoteKey = `quote:${wagerId}`;
  const projection = { quoteKey, ownerMemberId: actorId, commandVersion: String(view.commandVersion), fingerprint: `fixture:${quoteKey}`, wagerId, actorId, seasonId, riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: leg(wagerId) };
  const quote = await send(slug, { type: "QuoteStraightWager", commandId: quoteKey, actorId, identity: { actorId, quoteKey, fingerprint: projection.fingerprint }, projection } as unknown as PoolCommand);
  return send(slug, { type: "PlaceStraightWager", commandId: wagerId, actorId, wagerId, quoteKey, quotedCommandVersion: String(quote.commandVersion), seasonId: quote.seasonId, riskMicros: quote.riskMicros, acceptedOdds: quote.acceptedOdds, rulesetVersion: quote.rulesetVersion, leg: quote.leg } as unknown as PoolCommand);
};
const orderKeys = ["createdAt", "memberDisplayName", "memberId", "orderId", "priceMicros", "reason", "sharesMicros", "valueMicros"];

describe("T11 authoritative member reads", () => {
  it("distinguishes round-half-even from truncation on exact .5 standings divisions", async () => {
    // Price division: 3.000003 micros * 1e6 / 2,000,000 float shares = 1500000.5 exactly.
    // Half-even rounds to even 1500002; truncation would report 1500001.
    const priceSlug = `t11-price-${crypto.randomUUID()}`;
    await initialize(priceSlug, "Owner");
    await join(priceSlug, "a", "Aaa");
    await draftSeason(priceSlug, "s", "S");
    await storage(priceSlug, (state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE season SET float_micros = '2000000', notional_micros = '3000003' WHERE id = 's'");
      sql.exec("UPDATE share_account SET available_micros = '1000000', locked_micros = '0' WHERE season_id = 's' AND member_id = 'a'");
      sql.exec("INSERT INTO ledger_entry (id, season_id, member_id, actor_id, available_delta, locked_delta, float_delta, notional_delta, causation_id, kind, created_at) VALUES ('e-a', 's', 'a', 'owner', '1000000', '0', '0', '0', 'x', 'order', '2026-01-01T00:00:00.000Z')");
    });
    const price = await send(priceSlug, { type: "ReadStandings", commandId: "read-price", actorId: "owner" });
    expect(price.standings[0]).toMatchObject({ userId: "a", totalMicros: "1000000", priceMicros: "1500002", notionalValueMicros: "1500002", gainMicros: "1500002" });
    expect(price.standings[1]).toMatchObject({ userId: "owner", totalMicros: "0", priceMicros: "1500002", notionalValueMicros: "0", gainMicros: "0" });

    // Value division: the exact 1.500000 price makes 1 microshare * 1.5 / 1e6 = 1.5 exactly.
    // Half-even rounds to even 2.000000; truncation would report 1.000000 (and gain likewise).
    const valueSlug = `t11-value-${crypto.randomUUID()}`;
    await initialize(valueSlug, "Owner");
    await join(valueSlug, "a", "Aaa");
    await draftSeason(valueSlug, "s", "S");
    await storage(valueSlug, (state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE season SET float_micros = '2000000', notional_micros = '3000000' WHERE id = 's'");
      sql.exec("UPDATE share_account SET available_micros = '1', locked_micros = '0' WHERE season_id = 's' AND member_id = 'a'");
      sql.exec("INSERT INTO ledger_entry (id, season_id, member_id, actor_id, available_delta, locked_delta, float_delta, notional_delta, causation_id, kind, created_at) VALUES ('e-a', 's', 'a', 'owner', '1', '0', '0', '0', 'x', 'order', '2026-01-01T00:00:00.000Z')");
    });
    const value = await send(valueSlug, { type: "ReadStandings", commandId: "read-value", actorId: "owner" });
    expect(value.standings[0]).toMatchObject({ userId: "a", totalMicros: "1", priceMicros: "1500000", notionalValueMicros: "2", gainMicros: "2" });
  }, 90_000);

  it("uses ledger append order to determine earliest attainment when timestamps tie", async () => {
    const slug = `t11-attainment-rowid-${crypto.randomUUID()}`;
    await initialize(slug, "Owner");
    await join(slug, "a", "Aaa");
    await join(slug, "b", "Bee");
    await draftSeason(slug, "s", "S");
    await storage(slug, (state) => {
      const sql = state.storage.sql;
      for (const memberId of ["a", "b"]) sql.exec("UPDATE share_account SET available_micros = '2' WHERE season_id = 's' AND member_id = ?", memberId);
      const entry = (id: string, memberId: string, delta: string, createdAt: string) => sql.exec("INSERT INTO ledger_entry (id, season_id, member_id, actor_id, available_delta, locked_delta, float_delta, notional_delta, causation_id, kind, created_at) VALUES (?, 's', ?, 'owner', ?, '0', '0', '0', ?, 'order', ?)", id, memberId, delta, id, createdAt);
      // Reverse-lexical UUIDs at the same timestamp: append order reaches 2 before dropping to 1.
      entry("ffffffff-ffff-4fff-8fff-ffffffffffff", "a", "2", "2026-01-01T00:00:00.000Z");
      entry("00000000-0000-4000-8000-000000000000", "a", "-1", "2026-01-01T00:00:00.000Z");
      entry("11111111-1111-4111-8111-111111111111", "b", "2", "2026-01-02T00:00:00.000Z");
      entry("22222222-2222-4222-8222-222222222222", "a", "1", "2026-01-03T00:00:00.000Z");
    });
    const result = await send(slug, { type: "ReadStandings", commandId: "read", actorId: "owner" });
    expect(result.standings.map((row: any) => row.userId)).toEqual(["a", "b", "owner"]);
    expect(result.standings.map((row: any) => row.rank)).toEqual([1, 2, 3]);
    expect(Object.keys(result.standings[0]).sort()).toEqual(["availableMicros", "displayName", "gainMicros", "lockedMicros", "notionalValueMicros", "priceMicros", "rank", "totalMicros", "userId"]);
  }, 90_000);

  it("orders standings by holdings, then earliest attainment, then display name", async () => {
    const slug = `t11-order-${crypto.randomUUID()}`;
    await initialize(slug, "Zed");
    await join(slug, "a", "Aaa");
    await join(slug, "b", "Beta");
    await join(slug, "c", "Alpha");
    await draftSeason(slug, "s", "S");
    await storage(slug, (state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE share_account SET available_micros = '3' WHERE season_id = 's' AND member_id = 'owner'");
      for (const memberId of ["a", "b", "c"]) sql.exec("UPDATE share_account SET available_micros = '2' WHERE season_id = 's' AND member_id = ?", memberId);
      const entry = (id: string, memberId: string, delta: string, createdAt: string) => sql.exec("INSERT INTO ledger_entry (id, season_id, member_id, actor_id, available_delta, locked_delta, float_delta, notional_delta, causation_id, kind, created_at) VALUES (?, 's', ?, 'owner', ?, '0', '0', '0', 'x', 'order', ?)", id, memberId, delta, createdAt);
      // Owner attains earliest overall yet must still rank first only because holdings dominate.
      entry("e-owner", "owner", "3", "2026-01-01T00:00:00.000Z");
      // c and b attain the same instant, so display name must break the tie (Alpha before Beta).
      entry("e-c", "c", "2", "2026-01-02T00:00:00.000Z");
      entry("e-b", "b", "2", "2026-01-02T00:00:00.000Z");
      // a's display name sorts first of the tied group but its attainment is later.
      entry("e-a", "a", "2", "2026-01-03T00:00:00.000Z");
    });
    const result = await send(slug, { type: "ReadStandings", commandId: "read-order", actorId: "owner" });
    expect(result.standings.map((row: any) => row.userId)).toEqual(["owner", "c", "b", "a"]);
    expect(result.standings.map((row: any) => row.rank)).toEqual([1, 2, 3, 4]);
    expect(result.standings.map((row: any) => row.displayName)).toEqual(["Zed", "Alpha", "Beta", "Aaa"]);
    expect(result.standings.map((row: any) => row.totalMicros)).toEqual(["3", "2", "2", "2"]);
  }, 90_000);

  it("uses share-order append order for tied member activity and commissioner season reads", async () => {
    const slug = `t11-share-order-rowid-${crypto.randomUUID()}`;
    await initialize(slug, "Owner");
    await join(slug, "m", "Mem");
    await draftSeason(slug, "s1", "2026");
    await storage(slug, (state) => {
      const sql = state.storage.sql;
      const insert = (id: string, reason: string) => sql.exec("INSERT INTO share_order (id, season_id, member_id, actor_id, mode, requested_micros, shares_micros, value_micros, price_micros, reversal_of, reason, command_id, created_at) VALUES (?, 's1', 'm', 'owner', 'shares', '1', '1', '1', '1000000', NULL, ?, ?, '2026-02-01T00:00:00.000Z')", id, reason, `command:${id}`);
      insert("ffffffff-ffff-4fff-8fff-ffffffffffff", "appended first");
      insert("00000000-0000-4000-8000-000000000000", "appended second");
      const ledger = (id: string, kind: string) => sql.exec("INSERT INTO ledger_entry (id, season_id, member_id, actor_id, available_delta, locked_delta, float_delta, notional_delta, causation_id, kind, created_at) VALUES (?, 's1', 'm', 'owner', '1', '0', '1', '1', ?, ?, '2026-02-01T00:00:00.000Z')", id, id, kind);
      ledger("ffffffff-ffff-4fff-8fff-fffffffffff0", "appended-ledger-first");
      ledger("00000000-0000-4000-8000-000000000001", "appended-ledger-second");
    });
    const activity = await send(slug, { type: "ReadActivity", commandId: "activity", actorId: "m" });
    expect.soft(activity.activity.orders.map((order: any) => order.reason)).toEqual(["appended second", "appended first"]);
    expect(Object.keys(activity.activity.orders[0]).sort()).toEqual(orderKeys);
    const view = await send(slug, { type: "ReadPoolView", commandId: "pool-view", actorId: "owner" });
    expect.soft(view.commissioner.seasonOrders.find((season: any) => season.seasonId === "s1").orders.map((order: any) => order.reason)).toEqual(["appended second", "appended first"]);
    expect(Object.keys(view.commissioner.seasonOrders[0].orders[0]).sort()).toEqual(["createdAt", "memberId", "mode", "orderId", "priceMicros", "reason", "requestedMicros", "reversalOf", "sharesMicros", "valueMicros"]);
    await send(slug, { type: "CloseSeason", commandId: "close-s1", actorId: "owner", seasonId: "s1", reason: "archive" });
    const history = await send(slug, { type: "ReadSeasonHistory", commandId: "history-s1", actorId: "owner", seasonId: "s1" });
    expect(history.orders.map((order: any) => order.reason)).toEqual(["appended first", "appended second"]);
    expect(history.ledger.map((entry: any) => entry.kind)).toEqual(["appended-ledger-first", "appended-ledger-second"]);
  }, 90_000);

  it("returns immutable ordered share orders and redacted wager identity from ReadActivity", async () => {
    const slug = `t11-activity-${crypto.randomUUID()}`;
    await initialize(slug, "Owner");
    await join(slug, "m", "Mem");
    await join(slug, "n", "Nne");
    await draftSeason(slug, "s1", "2026");
    const m1 = await fund(slug, "fund-m", "m");
    const n1 = await fund(slug, "fund-n1", "n");
    const n2 = await fund(slug, "fund-n2", "n");
    const reversal = await send(slug, { type: "ReverseShareOrder", commandId: "reverse-n1", actorId: "owner", orderId: String(n1.orderId), reason: "reversal n1" });
    await placeWager(slug, "m", "w-m");
    await placeWager(slug, "n", "w-n");
    await send(slug, { type: "VoidWager", commandId: "void-n", actorId: "owner", wagerId: "w-n", reason: "commissioner void" });
    // Fixture-arranged immutable timestamps make created_at/confirmed_at ordering deterministic.
    await storage(slug, (state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE share_order SET created_at = '2026-02-01T00:00:00.000Z' WHERE id = ?", String(m1.orderId));
      sql.exec("UPDATE share_order SET created_at = '2026-02-02T00:00:00.000Z' WHERE id = ?", String(n1.orderId));
      sql.exec("UPDATE share_order SET created_at = '2026-02-03T00:00:00.000Z' WHERE id = ?", String(n2.orderId));
      sql.exec("UPDATE share_order SET created_at = '2026-02-04T00:00:00.000Z' WHERE id = ?", String(reversal.orderId));
      sql.exec("UPDATE wager SET confirmed_at = '2026-03-01T00:00:00.000Z' WHERE id = 'w-m'");
      sql.exec("UPDATE wager SET confirmed_at = '2026-03-02T00:00:00.000Z' WHERE id = 'w-n'");
      // Kickoff passes only for w-n's leg: the delayed per-leg reveal boundary.
      sql.exec("UPDATE wager_leg SET event_starts_at = '2026-01-01T00:00:00.000Z' WHERE wager_id = 'w-n'");
    });
    const asNonOwner = await send(slug, { type: "ReadActivity", commandId: "read-n", actorId: "n" });
    expect(asNonOwner.activity.orders.map((order: any) => order.orderId)).toEqual([String(reversal.orderId), String(n2.orderId), String(n1.orderId), String(m1.orderId)]);
    expect(Object.keys(asNonOwner.activity.orders[0]).sort()).toEqual(orderKeys);
    expect(asNonOwner.activity.orders[0]).toEqual({ orderId: String(reversal.orderId), memberId: "n", memberDisplayName: "Nne", sharesMicros: "-2000000", valueMicros: "-2000000", priceMicros: "1000000", reason: "reversal n1", createdAt: "2026-02-04T00:00:00.000Z" });
    expect(asNonOwner.activity.orders[3]).toEqual({ orderId: String(m1.orderId), memberId: "m", memberDisplayName: "Mem", sharesMicros: "2000000", valueMicros: "2000000", priceMicros: "1000000", reason: "funding m", createdAt: "2026-02-01T00:00:00.000Z" });
    expect(asNonOwner.activity.wagers.map((wager: any) => wager.wagerId)).toEqual(["w-m", "w-n"]);
    // Another member's unstarted selection must expose identity only — no risk, terms, or legs.
    const hidden = asNonOwner.activity.wagers[0];
    expect(Object.keys(hidden).sort()).toEqual(["confirmedAt", "memberDisplayName", "memberId", "seasonId", "status", "type", "wagerId"]);
    expect(hidden).toEqual({ wagerId: "w-m", seasonId: "s1", memberId: "m", memberDisplayName: "Mem", type: "straight", status: "open", confirmedAt: "2026-03-01T00:00:00.000Z" });
    const own = asNonOwner.activity.wagers[1];
    expect(own).toMatchObject({ wagerId: "w-n", type: "straight", status: "refunded", confirmedAt: "2026-03-02T00:00:00.000Z", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", outcome: "refunded", returnMicros: "1000000", profitMicros: "0" });
    expect(own.settledAt).toEqual(expect.any(String));
    expect(own.legs[0]).toMatchObject({ eventId: "w-n", market: "spread", selection: "home", eventStartsAt: "2026-01-01T00:00:00.000Z" });

    // Commissioner redaction is byte-identical to nonowner redaction for another member's ticket.
    const asCommissioner = await send(slug, { type: "ReadActivity", commandId: "read-owner", actorId: "owner" });
    expect(asCommissioner.activity.wagers.find((wager: any) => wager.wagerId === "w-m")).toEqual(hidden);
    // The ticket owner alone sees its own unstarted selection and risk.
    const asOwner = await send(slug, { type: "ReadActivity", commandId: "read-m", actorId: "m" });
    const ownUnstarted = asOwner.activity.wagers.find((wager: any) => wager.wagerId === "w-m");
    expect(ownUnstarted).toMatchObject({ wagerId: "w-m", status: "open", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1" });
    expect(ownUnstarted.legs[0]).toMatchObject({ eventId: "w-m", market: "spread", selection: "home" });
  }, 90_000);

  it("uses annotation append order when archived timestamps tie", async () => {
    const slug = `t11-annotation-rowid-${crypto.randomUUID()}`;
    await initialize(slug, "Owner");
    await draftSeason(slug, "closed", "Closed");
    await send(slug, { type: "CloseSeason", commandId: "close", actorId: "owner", seasonId: "closed", reason: "complete" });
    await storage(slug, (state) => {
      const sql = state.storage.sql;
      const insert = (id: string, text: string) => sql.exec("INSERT INTO season_annotation (id, season_id, actor_id, text, created_at) VALUES (?, 'closed', 'owner', ?, '2026-04-01T00:00:00.000Z')", id, text);
      insert("ffffffff-ffff-4fff-8fff-ffffffffffff", "appended first");
      insert("00000000-0000-4000-8000-000000000000", "appended second");
    });
    const history = await send(slug, { type: "ReadSeasonHistory", commandId: "history", actorId: "owner", seasonId: "closed" });
    expect(history.annotations.map((annotation: any) => annotation.text)).toEqual(["appended first", "appended second"]);
    expect(Object.keys(history.annotations[0]).sort()).toEqual(["annotationId", "authorDisplayName", "createdAt", "text"]);
  }, 90_000);

  it("keeps history season-filtered with appended annotations and redacted wagers", async () => {
    const slug = `t11-history-${crypto.randomUUID()}`;
    await initialize(slug, "Owner");
    await join(slug, "m", "Mem");
    await join(slug, "n", "Nonowner");
    await draftSeason(slug, "closed", "Closed");
    await fund(slug, "fund-closed", "m", "closed");
    await placeWager(slug, "m", "w-closed", "closed");
    await send(slug, { type: "CloseSeason", commandId: "close", actorId: "owner", seasonId: "closed", reason: "complete" });
    await send(slug, { type: "CreateSeasonAnnotation", commandId: "annotation-1", actorId: "owner", seasonId: "closed", text: "Immutable note" });
    await send(slug, { type: "CreateSeasonAnnotation", commandId: "annotation-2", actorId: "owner", seasonId: "closed", text: "Second note" });
    const history = await send(slug, { type: "ReadSeasonHistory", commandId: "history", actorId: "owner", seasonId: "closed" });
    expect(history.season).toMatchObject({ seasonId: "closed", label: "Closed", rulesetVersion: "SHARE_POOL_2026_V1", state: "closed", closeReason: "complete", floatMicros: "2000000", notionalMicros: "2000000", priceMicros: "1000000" });
    expect(history.accounts.find((account: any) => account.memberId === "m")).toMatchObject({ memberDisplayName: "Mem", availableMicros: "1000000", lockedMicros: "1000000", totalMicros: "2000000", holdingValueMicros: "2000000", gainMicros: "0" });
    expect(history.standings[0]).toMatchObject({ rank: 1, userId: "m", totalMicros: "2000000", notionalValueMicros: "2000000", gainMicros: "0" });
    expect(history.orders).toHaveLength(1);
    expect(history.orders[0]).toMatchObject({ seasonId: "closed", memberId: "m", memberDisplayName: "Mem" });
    expect(history.ledger.length).toBeGreaterThanOrEqual(2);
    expect(history.ledger.every((entry: any) => entry.seasonId === "closed")).toBe(true);
    expect(history.settlements).toEqual([]);
    expect(history.wagerCorrections).toEqual([]);
    expect(history.eventResults).toEqual([]);
    expect(history.annotations.map((annotation: any) => annotation.text)).toEqual(["Immutable note", "Second note"]);
    expect(history.annotations[0]).toMatchObject({ authorDisplayName: "Owner" });
    // The commissioner is not the ticket owner, so history exposes identity only.
    expect(history.wagers.map((wager: any) => wager.wagerId)).toEqual(["w-closed"]);
    expect(Object.keys(history.wagers[0]).sort()).toEqual(["confirmedAt", "memberDisplayName", "memberId", "seasonId", "status", "type", "wagerId"]);
    expect(history.wagers[0]).toMatchObject({ seasonId: "closed", memberId: "m", memberDisplayName: "Mem" });
    const asNonowner = await send(slug, { type: "ReadSeasonHistory", commandId: "history-n", actorId: "n", seasonId: "closed" });
    expect(asNonowner.wagers[0]).toEqual(history.wagers[0]);
    const asOwner = await send(slug, { type: "ReadSeasonHistory", commandId: "history-m", actorId: "m", seasonId: "closed" });
    expect(asOwner.wagers[0]).toMatchObject({ wagerId: "w-closed", riskMicros: "1000000", acceptedOdds: 100 });
    await send(slug, { type: "CreateSeason", commandId: "draft-next", actorId: "owner", seasonId: "draft", label: "Draft" });
    const lifecycle = await send(slug, { type: "ReadPoolView", commandId: "lifecycle-rulesets", actorId: "owner" });
    expect(lifecycle.nextDraftSeason).toMatchObject({ id: "draft", rulesetVersion: "SHARE_POOL_2026_V1" });
    expect(lifecycle.latestClosedSeason).toMatchObject({ id: "closed", rulesetVersion: "SHARE_POOL_2026_V1" });
    expect(await send(slug, { type: "ReadSeasonHistory", commandId: "history-draft", actorId: "owner", seasonId: "draft" })).toEqual({ code: "SEASON_NOT_CLOSED" });
    expect((await send(slug, { type: "CreateSeasonAnnotation", commandId: "missing", actorId: "owner", seasonId: "missing", text: "no" }))).toMatchObject({ code: "SEASON_NOT_FOUND" });
  }, 90_000);

  it("keeps the production read clock real: no fixture read-time route, table, or shaped reveal", async () => {
    const slug = `t11-read-clock-${crypto.randomUUID()}`;
    await initialize(slug, "Owner");
    await join(slug, "m", "Mem");
    await join(slug, "n", "Nne");
    await draftSeason(slug, "s1", "2026");
    await fund(slug, "fund-m", "m");
    await placeWager(slug, "m", "w-future");
    // The production DO identity accepts no fixture read-clock control on any internal path.
    const control = await pools.get(pools.idFromName(slug)).fetch("https://pool.internal/__local-test/current-time", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentTime: "2999-01-01T00:00:00.000Z" }) });
    expect(control.status).toBe(400);
    expect(await control.json()).toMatchObject({ code: "INVALID_COMMAND" });
    // No local read-time table exists in production storage, and the unstarted leg stays hidden by real time.
    expect(await storage(slug, (state) => [...state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_read_time'")].map((row) => row.name))).toEqual([]);
    const asNonOwner = await send(slug, { type: "ReadActivity", commandId: "read-n", actorId: "n" });
    expect(asNonOwner.activity.wagers.find((wager: any) => wager.wagerId === "w-future")).toEqual({ wagerId: "w-future", seasonId: "s1", memberId: "m", memberDisplayName: "Mem", type: "straight", status: "open", confirmedAt: expect.any(String) });
  }, 90_000);
});

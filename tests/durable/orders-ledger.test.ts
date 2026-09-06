import { env, runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSeason, executeQuotedOrder, quoteOrder } from "../../src/domain/ledger";
import type { SeasonLedger } from "../../src/domain/season";
import type { PoolCommand } from "../../src/durable/pool-commands";

const pools = (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO;
const send = async (slug: string, command: PoolCommand | unknown) => {
  const response = await pools.get(pools.idFromName(slug)).fetch("https://pool.test/command", { method: "POST", body: JSON.stringify(command) });
  return await response.json() as Record<string, unknown>;
};
const storage = <T>(slug: string, callback: (state: DurableObjectState) => T) =>
  runInDurableObject(pools.get(pools.idFromName(slug)), (_instance, state) => callback(state));

async function accountingInvariant(slug: string, expectedOrders: number) {
  const persisted = await storage(slug, (state) => ({
    account: [...state.storage.sql.exec<{ available_micros: string; locked_micros: string }>("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = 'member'")][0],
    season: [...state.storage.sql.exec<{ float_micros: string; notional_micros: string }>("SELECT float_micros, notional_micros FROM season WHERE id = 's1'")][0],
    totals: [...state.storage.sql.exec<{ available: string; locked: string; float: string; notional: string }>("SELECT COALESCE(SUM(CAST(available_delta AS INTEGER)), 0) AS available, COALESCE(SUM(CAST(locked_delta AS INTEGER)), 0) AS locked, COALESCE(SUM(CAST(float_delta AS INTEGER)), 0) AS float, COALESCE(SUM(CAST(notional_delta AS INTEGER)), 0) AS notional FROM ledger_entry WHERE season_id = 's1'")][0],
    orders: [...state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM share_order WHERE season_id = 's1'")][0]
  }));
  expect(persisted.season).toEqual({ float_micros: String(persisted.totals.float), notional_micros: String(persisted.totals.notional) });
  expect(persisted.account.available_micros).toBe(String(persisted.totals.available));
  expect(persisted.account.locked_micros).toBe(String(persisted.totals.locked));
  expect(persisted.orders.count).toBe(expectedOrders);
}

async function activePool(slug = `orders-${crypto.randomUUID()}`) {
  await send(slug, { type: "InitializePool", commandId: "init", poolId: slug, slug, poolName: "Orders", creatorId: "owner", creatorName: "Owner", password: "correct-password" });
  await send(slug, { type: "JoinPool", commandId: "join", actorId: "member", displayName: "Member", password: "correct-password" });
  await send(slug, { type: "CreateSeason", commandId: "draft", actorId: "owner", seasonId: "s1", label: "2026", defaultOrder: { mode: "value", amountMicros: "5000000" } });
  await send(slug, { type: "OpenSeason", commandId: "open", actorId: "owner", seasonId: "s1" });
  return slug;
}

const seedNonUnitAccounting = (slug: string) => storage(slug, (state) => state.storage.sql.exec("UPDATE pool SET command_version = '4'; UPDATE season SET float_micros = '3000000', notional_micros = '10000000', command_version = '4' WHERE id = 's1'; UPDATE share_account SET available_micros = '3000000', row_version = '4' WHERE season_id = 's1' AND member_id = 'member'; INSERT INTO share_order (id, season_id, member_id, actor_id, mode, requested_micros, shares_micros, value_micros, price_micros, reversal_of, reason, command_id, created_at) VALUES ('seed-order', 's1', 'member', 'owner', 'shares', '3000000', '3000000', '10000000', '3333333', NULL, 'valid non-unit seed', 'seed-command', '2026-01-01T00:00:00.000Z'); INSERT INTO ledger_entry (id, season_id, member_id, actor_id, available_delta, locked_delta, float_delta, notional_delta, causation_id, kind, created_at) VALUES ('ledger:seed-order', 's1', 'member', 'owner', '3000000', '0', '3000000', '10000000', 'seed-order', 'order', '2026-01-01T00:00:00.000Z')"));
const seededCompatibilitySeason = (): SeasonLedger => ({
  ...createSeason(),
  floatMicros: 3_000_000n,
  notionalMicros: 10_000_000n,
  commandVersion: 4n,
  accounts: { member: { availableMicros: 3_000_000n, lockedMicros: 0n, attainedAt: 1 } },
  journal: [{ id: "ledger:seed-order", member: "member", availableDelta: 3_000_000n, lockedDelta: 0n, floatDelta: 3_000_000n, notionalDelta: 10_000_000n, kind: "order", causationId: "seed-order" }]
});

describe("PoolDO share orders", () => {
  it("persists account/cache/journal equality through execute, replay, and reversal", async () => {
    const slug = await activePool();
    const quote = await send(slug, { type: "QuoteShareOrder", commandId: "quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "value", amountMicros: "5000000" });
    const execute: PoolCommand = { type: "ExecuteShareOrder", commandId: "order", actorId: "owner", seasonId: "s1", memberId: "member", mode: "value", amountMicros: "5000000", quote: { priceMicros: String(quote.priceMicros), commandVersion: String(quote.commandVersion) }, reason: "initial virtual shares" };
    const executed = await send(slug, execute);
    expect(executed).toMatchObject({ sharesMicros: "5000000", valueMicros: "5000000" });
    expect(executed).not.toHaveProperty("replayed");
    await accountingInvariant(slug, 1);
    expect(await send(slug, execute)).toEqual({ ...executed, replayed: true });
    await accountingInvariant(slug, 1);
    expect(await send(slug, { type: "ReverseShareOrder", commandId: "reverse", actorId: "owner", orderId: String(executed.orderId), reason: "commissioner correction" })).toMatchObject({ sharesMicros: "-5000000", valueMicros: "-5000000" });
    await accountingInvariant(slug, 2);
  }, 30_000);

  it("differentially checks generated active-season orders against the compatibility model", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        member: fc.constantFrom("owner", "member"),
        mode: fc.constantFrom("shares" as const, "value" as const),
        amountMicros: fc.bigInt({ min: 2n, max: 10_000_000n })
      }), { minLength: 1, maxLength: 6 }),
      async (orders) => {
        const slug = await activePool();
        await seedNonUnitAccounting(slug);
        let model = seededCompatibilitySeason();
        for (const [index, order] of orders.entries()) {
          const durableQuote = await send(slug, { type: "QuoteShareOrder", commandId: `generated-quote-${index}`, actorId: "owner", seasonId: "s1", memberId: order.member, mode: order.mode, amountMicros: order.amountMicros.toString() });
          const modelQuote = quoteOrder(model);
          expect(durableQuote.priceMicros).toBe(modelQuote.priceMicros.toString());

          const executed = await send(slug, { type: "ExecuteShareOrder", commandId: `generated-order-${index}`, actorId: "owner", seasonId: "s1", memberId: order.member, mode: order.mode, amountMicros: order.amountMicros.toString(), quote: { priceMicros: String(durableQuote.priceMicros), commandVersion: String(durableQuote.commandVersion) }, reason: "generated differential order" });
          model = executeQuotedOrder(model, order.member, { mode: order.mode, amountMicros: order.amountMicros, quote: modelQuote });
          const modelEntry = model.journal.at(-1)!;
          expect(executed).toMatchObject({ sharesMicros: modelEntry.availableDelta.toString(), valueMicros: modelEntry.notionalDelta.toString(), priceMicros: modelQuote.priceMicros.toString() });

          const persisted = await storage(slug, (state) => ({
            account: [...state.storage.sql.exec<{ available_micros: string; locked_micros: string }>("SELECT available_micros, locked_micros FROM share_account WHERE season_id = 's1' AND member_id = ?", order.member)][0],
            season: [...state.storage.sql.exec<{ float_micros: string; notional_micros: string }>("SELECT float_micros, notional_micros FROM season WHERE id = 's1'")][0]
          }));
          expect(persisted.account).toEqual({ available_micros: model.accounts[order.member]!.availableMicros.toString(), locked_micros: model.accounts[order.member]!.lockedMicros.toString() });
          expect(persisted.season).toEqual({ float_micros: model.floatMicros.toString(), notional_micros: model.notionalMicros.toString() });
        }
      }
    ), { seed: 20260822, path: "0", numRuns: 5 });
  }, 60_000);

  it("uses both forms with non-unit prices and round-half-even persistence", async () => {
    const slug = await activePool();
    await seedNonUnitAccounting(slug);
    await accountingInvariant(slug, 1);
    const valueQuote = await send(slug, { type: "QuoteShareOrder", commandId: "value-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "value", amountMicros: "1000000" });
    expect(valueQuote).toMatchObject({ priceMicros: "3333333" });
    const valueOrder = { type: "ExecuteShareOrder", commandId: "value-order", actorId: "owner", seasonId: "s1", memberId: "member", mode: "value", amountMicros: "1000000", quote: valueQuote, reason: "value rounding" } as PoolCommand;
    expect(await send(slug, valueOrder)).toMatchObject({ sharesMicros: "300000", valueMicros: "1000000" });
    await accountingInvariant(slug, 2);
    expect(await send(slug, valueOrder)).toMatchObject({ sharesMicros: "300000", valueMicros: "1000000" });
    await accountingInvariant(slug, 2);
    const shareQuote = await send(slug, { type: "QuoteShareOrder", commandId: "shares-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "500000" });
    const shareOrder = { type: "ExecuteShareOrder", commandId: "shares-order", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "500000", quote: shareQuote, reason: "share rounding" } as PoolCommand;
    expect(await send(slug, shareOrder)).toMatchObject({ sharesMicros: "500000", valueMicros: "1666666" });
    await accountingInvariant(slug, 3);
    const shareExecuted = await send(slug, shareOrder);
    expect(shareExecuted).toMatchObject({ sharesMicros: "500000", valueMicros: "1666666" });
    await accountingInvariant(slug, 3);
    const oddShareQuote = await send(slug, { type: "QuoteShareOrder", commandId: "odd-shares-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1500000" });
    expect(oddShareQuote).toMatchObject({ priceMicros: "3333333" });
    expect(await send(slug, { type: "ExecuteShareOrder", commandId: "odd-shares-order", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1500000", quote: oddShareQuote, reason: "odd-quotient tie rounding" } as PoolCommand)).toMatchObject({ sharesMicros: "1500000", valueMicros: "5000000" });
    await accountingInvariant(slug, 4);
    expect(await send(slug, shareOrder)).toMatchObject(shareExecuted);
    await accountingInvariant(slug, 4);
    expect(await send(slug, { type: "ReverseShareOrder", commandId: "reverse-share-order", actorId: "owner", orderId: String(shareExecuted.orderId), reason: "rounding correction" })).toMatchObject({ sharesMicros: "-500000", valueMicros: "-1666666" });
    await accountingInvariant(slug, 5);
  }, 30_000);

  it("keeps defaults form-only, rejects noncanonical orders, and serializes concurrent executions from one quote", async () => {
    const slug = `orders-${crypto.randomUUID()}`;
    await send(slug, { type: "InitializePool", commandId: "init", poolId: slug, slug, poolName: "Orders", creatorId: "owner", creatorName: "Owner", password: "correct-password" });
    await send(slug, { type: "CreateSeason", commandId: "draft", actorId: "owner", seasonId: "s1", label: "2026", defaultOrder: { mode: "value", amountMicros: "5000000" } });
    expect(await storage(slug, (state) => ({
      accounts: [...state.storage.sql.exec<{ available_micros: string }>("SELECT available_micros FROM share_account WHERE season_id = 's1'")],
      orders: [...state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM share_order")][0],
      ledger: [...state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM ledger_entry")][0]
    }))).toEqual({ accounts: [{ available_micros: "0" }], orders: { count: 0 }, ledger: { count: 0 } });
    await send(slug, { type: "OpenSeason", commandId: "open", actorId: "owner", seasonId: "s1" });
    for (const amountMicros of ["0", "01", "-0", "1.0"]) {
      expect(await send(slug, { type: "ExecuteShareOrder", commandId: `invalid-${amountMicros}`, actorId: "owner", seasonId: "s1", memberId: "owner", mode: "value", amountMicros, quote: { priceMicros: "1000000", commandVersion: "3" }, reason: "invalid" })).toMatchObject({ code: "INVALID_COMMAND" });
    }
    const quote = await send(slug, { type: "QuoteShareOrder", commandId: "concurrent-quote", actorId: "owner", seasonId: "s1", memberId: "owner", mode: "shares", amountMicros: "1000000" });
    const concurrent = await Promise.all(["a", "b"].map((suffix) => send(slug, { type: "ExecuteShareOrder", commandId: `concurrent-${suffix}`, actorId: "owner", seasonId: "s1", memberId: "owner", mode: "shares", amountMicros: "1000000", quote, reason: "concurrent commissioner order" } as PoolCommand)));
    expect(concurrent.filter((result) => result.sharesMicros === "1000000")).toHaveLength(1);
    const stale = concurrent.find((result) => result.code === "ORDER_QUOTE_STALE");
    expect(stale).toBeDefined();
    const replacement = await send(slug, { type: "QuoteShareOrder", commandId: "replacement-quote", actorId: "owner", seasonId: "s1", memberId: "owner", mode: "shares", amountMicros: "1000000" });
    expect(stale).toMatchObject({ code: "ORDER_QUOTE_STALE", replacement: { seasonId: "s1", memberId: "owner", mode: "shares", amountMicros: "1000000", priceMicros: replacement.priceMicros, commandVersion: replacement.commandVersion, sharesMicros: replacement.sharesMicros, valueMicros: replacement.valueMicros } });

    const valueQuote = await send(slug, { type: "QuoteShareOrder", commandId: "stale-value-quote", actorId: "owner", seasonId: "s1", memberId: "owner", mode: "value", amountMicros: "1234567" });
    await send(slug, { type: "ExecuteShareOrder", commandId: "advance-price", actorId: "owner", seasonId: "s1", memberId: "owner", mode: "shares", amountMicros: "1000000", quote: { priceMicros: String(replacement.priceMicros), commandVersion: String(replacement.commandVersion) }, reason: "advance quote" });
    const staleValue = await send(slug, { type: "ExecuteShareOrder", commandId: "stale-value-order", actorId: "owner", seasonId: "s1", memberId: "owner", mode: "value", amountMicros: "1234567", quote: { priceMicros: String(valueQuote.priceMicros), commandVersion: String(valueQuote.commandVersion) }, reason: "stale value" });
    const valueReplacement = await send(slug, { type: "QuoteShareOrder", commandId: "replacement-value-quote", actorId: "owner", seasonId: "s1", memberId: "owner", mode: "value", amountMicros: "1234567" });
    expect(staleValue).toMatchObject({ code: "ORDER_QUOTE_STALE", replacement: { seasonId: "s1", memberId: "owner", mode: "value", amountMicros: "1234567", priceMicros: valueReplacement.priceMicros, commandVersion: valueReplacement.commandVersion, sharesMicros: valueReplacement.sharesMicros, valueMicros: valueReplacement.valueMicros } });
  }, 30_000);
});

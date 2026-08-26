import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSeason, executeOrder, executeQuotedOrder, holdings, lockRisk, quoteOrder, reverseSettlement, settleWager } from "../../src/domain/ledger";

describe("ledger model invariants", () => {
  it("keeps journal, balances, ranking, and float consistent through recorded randomized commands", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ member: fc.constantFrom("amy", "ben"), shares: fc.bigInt({ min: 1n, max: 10_000_000_000_000_000_000n }) }), { minLength: 1, maxLength: 30 }),
      (orders) => {
        let season = createSeason();
        for (const order of orders) season = executeOrder(season, order.member, order.shares);
        expect(season.floatMicros).toBe(orders.reduce((sum, order) => sum + order.shares, 0n));
        const ranked = Object.entries(season.accounts).map(([member, account]) => ({ member, shares: account.availableMicros + account.lockedMicros, attainedAt: account.attainedAt })).sort((a, b) => a.shares === b.shares ? a.attainedAt === b.attainedAt ? a.member.localeCompare(b.member) : a.attainedAt - b.attainedAt : a.shares > b.shares ? -1 : 1).map(({ member, shares }) => ({ member, shares }));
        expect(holdings(season)).toEqual(ranked);
        expect(season.journal.reduce((sum, entry) => sum + entry.floatDelta, 0n)).toBe(season.floatMicros);
      }
    ), { seed: 20260822, path: "0", numRuns: 50 });
  });

  it("preserves journal/cache totals through randomized locks and outcomes", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ member: fc.constantFrom("amy", "ben"), shares: fc.bigInt({ min: 1_000_000n, max: 1_000_000_000_000n }), outcome: fc.constantFrom("win", "loss", "push", "void") }), { minLength: 1, maxLength: 20 }),
      (commands) => {
        let season = createSeason();
        for (const command of commands) {
          if (season.state === "closed") break;
          season = executeOrder(season, command.member, command.shares);
          season = lockRisk(season, command.member, 1_000_000n, `w-${season.commandVersion}`);
          season = settleWager(season, command.member, `w-${season.commandVersion - 1n}`, command.outcome, command.outcome === "win" ? 1_000_000n : 0n);
          expect(season.journal.reduce((sum, entry) => sum + entry.floatDelta, 0n)).toBe(season.floatMicros);
          expect(new Set(season.journal.map((entry) => entry.id)).size).toBe(season.journal.length);
          for (const account of Object.values(season.accounts)) expect(account.availableMicros + account.lockedMicros).toBeGreaterThanOrEqual(0n);
        }
      }
    ), { seed: 20260822, path: "1", numRuns: 40 });
  });

  it("keeps non-unit-price order rounding within one micro for both order forms", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 2_000_000n, max: 10_000_000n }),
      fc.bigInt({ min: 1_000n, max: 10_000_000n }),
      fc.bigInt({ min: 1n, max: 5_000_000n }),
      fc.bigInt({ min: 1n, max: 5_000_000n }),
      (initialShares, profitMicros, shareOrderMicros, valueOrderMicros) => {
        let season = executeOrder(createSeason(), "amy", initialShares);
        season = lockRisk(season, "amy", 1_000_000n, "non-unit-price");
        season = settleWager(season, "amy", "non-unit-price", "win", profitMicros);
        const sharesQuote = quoteOrder(season);
        expect(sharesQuote.priceMicros).not.toBe(1_000_000n);
        const beforeSharesVersion = sharesQuote.commandVersion;
        season = executeQuotedOrder(season, "ben", { mode: "shares", amountMicros: shareOrderMicros, quote: sharesQuote });
        expect(quoteOrder(season).priceMicros - sharesQuote.priceMicros).toBeGreaterThanOrEqual(-1n);
        expect(quoteOrder(season).priceMicros - sharesQuote.priceMicros).toBeLessThanOrEqual(1n);
        expect(() => executeQuotedOrder(season, "ben", { mode: "shares", amountMicros: 1n, quote: { ...sharesQuote, commandVersion: beforeSharesVersion } })).toThrow(/stale/i);
        const valueQuote = quoteOrder(season);
        season = executeQuotedOrder(season, "ben", { mode: "value", amountMicros: valueOrderMicros, quote: valueQuote });
        expect(quoteOrder(season).priceMicros - valueQuote.priceMicros).toBeGreaterThanOrEqual(-1n);
        expect(quoteOrder(season).priceMicros - valueQuote.priceMicros).toBeLessThanOrEqual(1n);
        expect(() => executeQuotedOrder(season, "ben", { mode: "value", amountMicros: 1n, quote: valueQuote })).toThrow(/stale/i);
        expect(season.journal.reduce((sum, entry) => sum + entry.floatDelta, 0n)).toBe(season.floatMicros);
        expect(season.journal.reduce((sum, entry) => sum + entry.notionalDelta, 0n)).toBe(season.notionalMicros);
        expect(Object.values(season.accounts).reduce((sum, account) => sum + account.availableMicros + account.lockedMicros, 0n)).toBe(season.floatMicros);
        for (const account of Object.values(season.accounts)) {
          expect(account.availableMicros).toBeGreaterThanOrEqual(0n);
          expect(account.lockedMicros).toBeGreaterThanOrEqual(0n);
        }
      }
    ), { seed: 20260822, path: "2", numRuns: 40 });
  });

  it("updates tied-balance attainment after a loss but preserves it when shares are locked", () => {
    let season = executeOrder(createSeason(), "amy", 2_000_000n);
    season = executeOrder(season, "ben", 1_000_000n);
    const initialAmyAttainment = season.accounts.amy.attainedAt;
    season = lockRisk(season, "amy", 1_000_000n, "w-attainment");
    expect(season.accounts.amy.attainedAt).toBe(initialAmyAttainment);
    season = settleWager(season, "amy", "w-attainment", "loss", 0n);
    expect(holdings(season).map((entry) => entry.member)).toEqual(["ben", "amy"]);

    season = reverseSettlement(season, "w-attainment");
    season = settleWager(season, "amy", "w-attainment", "push", 0n);
    expect(new Set(season.journal.map((entry) => entry.id)).size).toBe(season.journal.length);
  });

  it("locks only whole shares, settles once, reverses exactly, and closes zero float", () => {
    let season = executeOrder(createSeason(), "amy", 2_000_000n);
    expect(() => lockRisk(season, "amy", 1_500_000n, "w1")).toThrow(/whole/i);
    season = lockRisk(season, "amy", 2_000_000n, "w1");
    const lost = settleWager(season, "amy", "w1", "loss", 0n);
    expect(lost.closedReason).toBe("float_exhausted");
    expect(() => settleWager(lost, "amy", "w1", "loss", 0n)).toThrow(/settled/i);
    const reversed = reverseSettlement(lost, "w1");
    expect(reversed.floatMicros).toBe(2_000_000n);
    expect(reversed.accounts.amy.availableMicros).toBe(0n);
    expect(reversed.accounts.amy.lockedMicros).toBe(2_000_000n);
  });
});

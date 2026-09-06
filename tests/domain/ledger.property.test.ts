import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSeason, executeOrder, executeQuotedOrder, holdings, lockRisk, quoteOrder, reverseSettlement, settleWager } from "../../src/domain/ledger";

const exactHalfEven = (numerator: bigint, denominator: bigint) => {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n !== 0n) ? quotient + 1n : quotient;
};
const exactPriceMicros = (notionalMicros: bigint, floatMicros: bigint) => exactHalfEven(notionalMicros * 1_000_000n, floatMicros);
const expectCachesToMatchJournal = (season: ReturnType<typeof createSeason>) => {
  for (const [member, account] of Object.entries(season.accounts)) {
    const entries = season.journal.filter((entry) => entry.member === member);
    expect(entries.reduce((sum, entry) => sum + entry.availableDelta, 0n), `${member} available cache`).toBe(account.availableMicros);
    expect(entries.reduce((sum, entry) => sum + entry.lockedDelta, 0n), `${member} locked cache`).toBe(account.lockedMicros);
  }
  expect(Object.values(season.accounts).reduce((sum, account) => sum + account.availableMicros + account.lockedMicros, 0n)).toBe(season.floatMicros);
};

describe("compatibility/reference ledger model invariants", () => {
  it("keeps journal, balances, ranking, and float consistent through recorded randomized commands", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ member: fc.constantFrom("amy", "ben"), shares: fc.bigInt({ min: 1n, max: 10_000_000_000_000_000_000n }) }), { minLength: 1, maxLength: 30 }),
      (orders) => {
        let season = createSeason();
        for (const order of orders) season = executeOrder(season, order.member, order.shares);
        expect(season.floatMicros).toBe(orders.reduce((sum, order) => sum + order.shares, 0n));
        const ranked = holdings(season);
        expect(new Set(ranked.map(({ member }) => member))).toEqual(new Set(Object.keys(season.accounts)));
        for (const [index, entry] of ranked.entries()) {
          expect(entry.shares).toBe(season.accounts[entry.member]!.availableMicros + season.accounts[entry.member]!.lockedMicros);
          const next = ranked[index + 1];
          if (!next) continue;
          if (entry.shares !== next.shares) expect(entry.shares).toBeGreaterThan(next.shares);
        }
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
          expectCachesToMatchJournal(season);
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
        expect(sharesQuote.priceMicros).toBe(exactPriceMicros(season.notionalMicros, season.floatMicros));
        expect(sharesQuote.priceMicros).not.toBe(1_000_000n);
        const beforeSharesVersion = sharesQuote.commandVersion;
        season = executeQuotedOrder(season, "ben", { mode: "shares", amountMicros: shareOrderMicros, quote: sharesQuote });
        const expectedShareOrderValue = exactHalfEven(shareOrderMicros * sharesQuote.priceMicros, 1_000_000n);
        expect(season.journal.at(-1)).toMatchObject({ availableDelta: shareOrderMicros, lockedDelta: 0n, floatDelta: shareOrderMicros, notionalDelta: expectedShareOrderValue });
        expect(quoteOrder(season).priceMicros).toBe(exactPriceMicros(season.notionalMicros, season.floatMicros));
        expect(quoteOrder(season).priceMicros - sharesQuote.priceMicros).toBeGreaterThanOrEqual(-1n);
        expect(quoteOrder(season).priceMicros - sharesQuote.priceMicros).toBeLessThanOrEqual(1n);
        expect(() => executeQuotedOrder(season, "ben", { mode: "shares", amountMicros: 1n, quote: { ...sharesQuote, commandVersion: beforeSharesVersion } })).toThrow(/stale/i);
        const valueQuote = quoteOrder(season);
        expect(valueQuote.priceMicros).toBe(exactPriceMicros(season.notionalMicros, season.floatMicros));
        season = executeQuotedOrder(season, "ben", { mode: "value", amountMicros: valueOrderMicros, quote: valueQuote });
        const expectedValueOrderShares = exactHalfEven(valueOrderMicros * 1_000_000n, valueQuote.priceMicros);
        expect(season.journal.at(-1)).toMatchObject({ availableDelta: expectedValueOrderShares, lockedDelta: 0n, floatDelta: expectedValueOrderShares, notionalDelta: valueOrderMicros });
        expect(quoteOrder(season).priceMicros).toBe(exactPriceMicros(season.notionalMicros, season.floatMicros));
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

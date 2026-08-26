import { divideRoundHalfEven, MICROS_PER_UNIT, WHOLE_SHARE_MICROS } from "./fixed-point";
import type { LedgerEntry, OrderQuote, SeasonLedger, ShareAccount } from "./season";

const emptyAccount = (): ShareAccount => ({ availableMicros: 0n, lockedMicros: 0n, attainedAt: 0 });
const copy = (season: SeasonLedger): SeasonLedger => ({ ...season, accounts: { ...season.accounts }, journal: [...season.journal], settled: { ...season.settled } });
const entryId = (season: SeasonLedger, kind: LedgerEntry["kind"], causationId: string) => `${kind}:${causationId}:${season.journal.length}`;

export function createSeason(): SeasonLedger {
  return { state: "active", closedReason: undefined, floatMicros: 0n, notionalMicros: 0n, commandVersion: 0n, accounts: {}, journal: [], settled: {} };
}

function record(season: SeasonLedger, entry: LedgerEntry): SeasonLedger {
  const next = copy(season);
  const current = next.accounts[entry.member] ?? emptyAccount();
  const previousHoldings = current.availableMicros + current.lockedMicros;
  const availableMicros = current.availableMicros + entry.availableDelta;
  const lockedMicros = current.lockedMicros + entry.lockedDelta;
  if (availableMicros < 0n || lockedMicros < 0n) throw new Error("Ledger action would produce a negative balance.");
  const holdings = availableMicros + lockedMicros;
  next.accounts[entry.member] = { availableMicros, lockedMicros, attainedAt: holdings !== previousHoldings ? next.journal.length + 1 : current.attainedAt };
  next.floatMicros += entry.floatDelta;
  next.notionalMicros += entry.notionalDelta;
  if (next.floatMicros < 0n || next.notionalMicros < 0n) throw new Error("Ledger action would produce a negative total.");
  next.journal.push(entry);
  next.commandVersion += 1n;
  return next;
}

export function quoteOrder(season: SeasonLedger): OrderQuote {
  const priceMicros = season.floatMicros === 0n ? MICROS_PER_UNIT : divideRoundHalfEven(season.notionalMicros * MICROS_PER_UNIT, season.floatMicros);
  return { priceMicros, commandVersion: season.commandVersion.toString() };
}

/** Compatibility share-quantity order; quote/executeQuotedOrder supports both approved forms. */
export function executeOrder(season: SeasonLedger, member: string, sharesMicros: bigint): SeasonLedger {
  return executeQuotedOrder(season, member, { mode: "shares", amountMicros: sharesMicros, quote: quoteOrder(season) });
}

export function executeQuotedOrder(season: SeasonLedger, member: string, input: { mode: "shares" | "value"; amountMicros: bigint; quote: OrderQuote }): SeasonLedger {
  if (season.state === "closed" || input.amountMicros <= 0n) throw new Error("Orders require an open season and a positive quantity.");
  const current = quoteOrder(season);
  if (current.commandVersion !== input.quote.commandVersion || current.priceMicros !== input.quote.priceMicros) throw new Error("Order quote is stale.");
  const sharesMicros = input.mode === "shares" ? input.amountMicros : divideRoundHalfEven(input.amountMicros * MICROS_PER_UNIT, current.priceMicros);
  const valueMicros = input.mode === "value" ? input.amountMicros : divideRoundHalfEven(sharesMicros * current.priceMicros, MICROS_PER_UNIT);
  if (sharesMicros <= 0n || valueMicros <= 0n) throw new Error("Order rounds below one micro.");
  return record(season, { id: entryId(season, "order", `order:${season.commandVersion}`), member, availableDelta: sharesMicros, lockedDelta: 0n, floatDelta: sharesMicros, notionalDelta: valueMicros, kind: "order", causationId: `order:${season.commandVersion}` });
}

export function lockRisk(season: SeasonLedger, member: string, riskMicros: bigint, wagerId: string): SeasonLedger {
  if (riskMicros <= 0n || riskMicros % WHOLE_SHARE_MICROS !== 0n) throw new Error("Wager risk must be positive whole shares.");
  if (season.state !== "active") throw new Error("Season is not active.");
  return record(season, { id: entryId(season, "lock", wagerId), member, availableDelta: -riskMicros, lockedDelta: riskMicros, floatDelta: 0n, notionalDelta: 0n, kind: "lock", causationId: wagerId });
}

export function settleWager(season: SeasonLedger, member: string, wagerId: string, outcome: "win" | "loss" | "push" | "void", profitMicros: bigint): SeasonLedger {
  if (season.settled[wagerId]) throw new Error("Wager is already settled.");
  if (profitMicros < 0n) throw new Error("Profit cannot be negative.");
  const lock = [...season.journal].reverse().find((entry) => entry.kind === "lock" && entry.causationId === wagerId && entry.member === member);
  if (!lock) throw new Error("Wager has no locked risk.");
  const riskMicros = lock.lockedDelta;
  const availableDelta = outcome === "loss" ? 0n : riskMicros + (outcome === "win" ? profitMicros : 0n);
  const floatDelta = outcome === "loss" ? -riskMicros : outcome === "win" ? profitMicros : 0n;
  let next = record(season, { id: entryId(season, "settlement", wagerId), member, availableDelta, lockedDelta: -riskMicros, floatDelta, notionalDelta: 0n, kind: "settlement", causationId: wagerId });
  next = { ...next, settled: { ...next.settled, [wagerId]: { member, riskMicros, outcome, profitMicros } } };
  return next.floatMicros === 0n ? { ...next, state: "closed", closedReason: "float_exhausted" } : next;
}

export function reverseSettlement(season: SeasonLedger, wagerId: string): SeasonLedger {
  const settled = season.settled[wagerId];
  if (!settled) throw new Error("No settlement exists to reverse.");
  const { member, riskMicros, outcome, profitMicros } = settled;
  const availableDelta = outcome === "loss" ? 0n : -(riskMicros + (outcome === "win" ? profitMicros : 0n));
  const floatDelta = outcome === "loss" ? riskMicros : outcome === "win" ? -profitMicros : 0n;
  const next = record({ ...season, state: "active", closedReason: undefined }, { id: entryId(season, "reversal", wagerId), member, availableDelta, lockedDelta: riskMicros, floatDelta, notionalDelta: 0n, kind: "reversal", causationId: wagerId });
  const settledCopy = { ...next.settled }; delete settledCopy[wagerId];
  return { ...next, settled: settledCopy };
}

export function holdings(season: SeasonLedger): Array<{ member: string; shares: bigint }> {
  return Object.entries(season.accounts).map(([member, account]) => ({ member, shares: account.availableMicros + account.lockedMicros, attainedAt: account.attainedAt })).sort((a, b) => a.shares === b.shares ? a.attainedAt === b.attainedAt ? a.member.localeCompare(b.member) : a.attainedAt - b.attainedAt : a.shares > b.shares ? -1 : 1).map(({ member, shares }) => ({ member, shares }));
}

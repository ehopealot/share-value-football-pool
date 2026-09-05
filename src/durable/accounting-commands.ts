import { parseIntegerText } from "../domain/fixed-point";
import { AccountingRepository, calculateShareOrderAmounts, type Sql } from "./accounting-repository";

export type OrderInput = {
  commandId: string; actorId: string; seasonId: string; memberId: string;
  mode: "shares" | "value"; amountMicros: string; quote: { priceMicros: string; commandVersion: string }; reason: string;
};

export function quoteShareOrder(sql: Sql, seasonId: string, memberId: string, mode: "shares" | "value", amountMicros: string) {
  const quote = new AccountingRepository(sql).quote(seasonId);
  const requested = parseIntegerText(amountMicros);
  const { sharesMicros: shares, valueMicros: value } = calculateShareOrderAmounts(mode, requested, quote.priceMicros);
  if (shares <= 0n || value <= 0n) throw new Error("ORDER_ROUNDS_BELOW_ONE_MICRO");
  return { seasonId, memberId, mode, amountMicros, priceMicros: quote.priceMicros.toString(), commandVersion: quote.commandVersion, sharesMicros: shares.toString(), valueMicros: value.toString() };
}

export function executeShareOrder(sql: Sql, input: OrderInput, now = new Date().toISOString()) {
  const result = new AccountingRepository(sql).applyOrder({
    id: crypto.randomUUID(), commandId: input.commandId, seasonId: input.seasonId, memberId: input.memberId,
    actorId: input.actorId, mode: input.mode, requestedMicros: parseIntegerText(input.amountMicros),
    priceMicros: parseIntegerText(input.quote.priceMicros), commandVersion: input.quote.commandVersion,
    reason: input.reason, now
  });
  return { ...result, sharesMicros: result.sharesMicros.toString(), valueMicros: result.valueMicros.toString(), priceMicros: result.priceMicros.toString() };
}

export function reverseShareOrder(sql: Sql, input: { commandId: string; actorId: string; orderId: string; reason: string }, now = new Date().toISOString()) {
  const result = new AccountingRepository(sql).reverseOrder({ id: crypto.randomUUID(), ...input, now });
  return { ...result, sharesMicros: result.sharesMicros.toString(), valueMicros: result.valueMicros.toString(), priceMicros: result.priceMicros.toString() };
}

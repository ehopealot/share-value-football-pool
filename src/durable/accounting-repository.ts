import { divideRoundHalfEven, MICROS_PER_UNIT, parseIntegerText } from "../domain/fixed-point";

export type Sql = { exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> };
export class OrderQuoteStaleError extends Error {
  constructor(
    readonly quote: { priceMicros: bigint; commandVersion: string; sharesMicros: bigint; valueMicros: bigint },
    readonly terms: { seasonId: string; memberId: string; mode: "shares" | "value"; amountMicros: string }
  ) {
    super("ORDER_QUOTE_STALE");
  }
}
const text = (value: bigint) => value.toString();
const one = (sql: Sql, query: string, ...bindings: unknown[]) => [...sql.exec(query, ...bindings)][0];

export const calculateSharePriceMicros = (floatMicros: bigint, notionalMicros: bigint): bigint =>
  floatMicros === 0n ? MICROS_PER_UNIT : divideRoundHalfEven(notionalMicros * MICROS_PER_UNIT, floatMicros);

export const calculateShareOrderAmounts = (mode: "shares" | "value", requestedMicros: bigint, priceMicros: bigint) => {
  const sharesMicros = mode === "shares" ? requestedMicros : divideRoundHalfEven(requestedMicros * MICROS_PER_UNIT, priceMicros);
  const valueMicros = mode === "value" ? requestedMicros : divideRoundHalfEven(sharesMicros * priceMicros, MICROS_PER_UNIT);
  return { sharesMicros, valueMicros };
};

type ApplyOrderInput = {
  id: string; commandId: string; seasonId: string; memberId: string; actorId: string;
  mode: "shares" | "value"; requestedMicros: bigint; priceMicros: bigint;
  commandVersion: string; reason: string; now: string; reversalOf?: string;
};

/** SQL-only accounting helpers; callers execute these in a PoolDO transaction. */
export class AccountingRepository {
  constructor(private readonly sql: Sql) {}

  quote(seasonId: string) {
    const row = one(this.sql, "SELECT float_micros, notional_micros, command_version FROM season WHERE id = ?", seasonId);
    if (!row) throw new Error("SEASON_NOT_FOUND");
    const float = parseIntegerText(String(row.float_micros));
    const notional = parseIntegerText(String(row.notional_micros));
    return { priceMicros: calculateSharePriceMicros(float, notional), commandVersion: String(row.command_version) };
  }

  account(seasonId: string, memberId: string) {
    const row = one(this.sql, "SELECT available_micros, locked_micros FROM share_account WHERE season_id = ? AND member_id = ?", seasonId, memberId);
    if (!row) throw new Error("SHARE_ACCOUNT_NOT_FOUND");
    return { availableMicros: parseIntegerText(String(row.available_micros)), lockedMicros: parseIntegerText(String(row.locked_micros)) };
  }

  applyOrder(input: ApplyOrderInput) {
    const season = one(this.sql, "SELECT state, float_micros, notional_micros, command_version FROM season WHERE id = ?", input.seasonId);
    if (!season) throw new Error("SEASON_NOT_FOUND");
    if (season.state !== "active") throw new Error("SEASON_NOT_ACTIVE");
    const quote = this.quote(input.seasonId);
    if (quote.commandVersion !== input.commandVersion || quote.priceMicros !== input.priceMicros) {
      const { sharesMicros, valueMicros } = calculateShareOrderAmounts(input.mode, input.requestedMicros, quote.priceMicros);
      throw new OrderQuoteStaleError(
        { ...quote, sharesMicros, valueMicros },
        { seasonId: input.seasonId, memberId: input.memberId, mode: input.mode, amountMicros: input.requestedMicros.toString() }
      );
    }
    const { sharesMicros: shares, valueMicros: value } = calculateShareOrderAmounts(input.mode, input.requestedMicros, quote.priceMicros);
    if (shares <= 0n || value <= 0n) throw new Error("ORDER_ROUNDS_BELOW_ONE_MICRO");
    const account = this.account(input.seasonId, input.memberId);
    const nextVersion = (BigInt(quote.commandVersion) + 1n).toString();
    this.sql.exec("UPDATE share_account SET available_micros = ?, row_version = ? WHERE season_id = ? AND member_id = ?", text(account.availableMicros + shares), nextVersion, input.seasonId, input.memberId);
    this.sql.exec("UPDATE season SET float_micros = ?, notional_micros = ?, command_version = ? WHERE id = ?", text(parseIntegerText(String(season.float_micros)) + shares), text(parseIntegerText(String(season.notional_micros)) + value), nextVersion, input.seasonId);
    this.insertOrderAndLedger(input, shares, value, quote.priceMicros, input.reversalOf ? "order_reversal" : "order");
    return { orderId: input.id, sharesMicros: shares, valueMicros: value, priceMicros: quote.priceMicros, commandVersion: nextVersion };
  }

  reverseOrder(input: { id: string; commandId: string; orderId: string; actorId: string; reason: string; now: string }) {
    const original = one(this.sql, "SELECT id, season_id, member_id, shares_micros, value_micros, price_micros FROM share_order WHERE id = ?", input.orderId);
    if (!original) throw new Error("ORDER_NOT_FOUND");
    if (one(this.sql, "SELECT id FROM share_order WHERE reversal_of = ?", input.orderId)) throw new Error("ORDER_ALREADY_REVERSED");
    const seasonId = String(original.season_id);
    const memberId = String(original.member_id);
    const season = one(this.sql, "SELECT state, float_micros, notional_micros, command_version FROM season WHERE id = ?", seasonId);
    if (!season || season.state !== "active") throw new Error("SEASON_NOT_ACTIVE");
    const shares = parseIntegerText(String(original.shares_micros));
    const value = parseIntegerText(String(original.value_micros));
    const account = this.account(seasonId, memberId);
    if (account.availableMicros < shares) throw new Error("ORDER_REVERSAL_INSUFFICIENT_AVAILABLE_SHARES");
    const float = parseIntegerText(String(season.float_micros));
    const notional = parseIntegerText(String(season.notional_micros));
    if (float < shares || notional < value) throw new Error("ORDER_REVERSAL_NEGATIVE_TOTAL");
    const nextVersion = (BigInt(String(season.command_version)) + 1n).toString();
    this.sql.exec("UPDATE share_account SET available_micros = ?, row_version = ? WHERE season_id = ? AND member_id = ?", text(account.availableMicros - shares), nextVersion, seasonId, memberId);
    this.sql.exec("UPDATE season SET float_micros = ?, notional_micros = ?, command_version = ? WHERE id = ?", text(float - shares), text(notional - value), nextVersion, seasonId);
    this.insertOrderAndLedger({ id: input.id, commandId: input.commandId, seasonId, memberId, actorId: input.actorId, mode: "shares", requestedMicros: -shares, priceMicros: parseIntegerText(String(original.price_micros)), commandVersion: String(season.command_version), reason: input.reason, now: input.now, reversalOf: input.orderId }, -shares, -value, parseIntegerText(String(original.price_micros)), "order_reversal");
    return { orderId: input.id, reversedOrderId: input.orderId, sharesMicros: -shares, valueMicros: -value, priceMicros: parseIntegerText(String(original.price_micros)), commandVersion: nextVersion };
  }

  private insertOrderAndLedger(input: ApplyOrderInput, shares: bigint, value: bigint, price: bigint, kind: "order" | "order_reversal") {
    this.sql.exec("INSERT INTO share_order (id, season_id, member_id, actor_id, mode, requested_micros, shares_micros, value_micros, price_micros, reversal_of, reason, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", input.id, input.seasonId, input.memberId, input.actorId, input.mode, text(input.requestedMicros), text(shares), text(value), text(price), input.reversalOf ?? null, input.reason, input.commandId, input.now);
    this.sql.exec("INSERT INTO ledger_entry (id, season_id, member_id, actor_id, available_delta, locked_delta, float_delta, notional_delta, causation_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", `ledger:${input.id}`, input.seasonId, input.memberId, input.actorId, text(shares), "0", text(shares), text(value), input.id, kind, input.now);
  }
}

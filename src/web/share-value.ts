import { divideRoundHalfEven, formatMicros, parseIntegerText } from "../domain/fixed-point";

/** A first issuance prices internally at one dollar, but no issued shares have no member-facing value. */
export const currentShareValueMicros = (floatMicros: string, notionalValueMicros: string): bigint => {
  const float = parseIntegerText(floatMicros);
  return float === 0n ? 0n : divideRoundHalfEven(parseIntegerText(notionalValueMicros) * 1_000_000n, float);
};

export const formatCurrentShareValue = (floatMicros: string, notionalValueMicros: string): string => `$${formatMicros(currentShareValueMicros(floatMicros, notionalValueMicros), 2)}`;

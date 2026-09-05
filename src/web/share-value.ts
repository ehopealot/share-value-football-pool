import { divideRoundHalfEven, formatMicros, MICROS_PER_UNIT, parseIntegerText } from "../domain/fixed-point";

/** A first issuance prices internally at one dollar, but no issued shares have no member-facing value. */
export const currentShareValueMicros = (floatMicros: string, notionalValueMicros: string): bigint => {
  const float = parseIntegerText(floatMicros);
  return float === 0n ? 0n : divideRoundHalfEven(parseIntegerText(notionalValueMicros) * MICROS_PER_UNIT, float);
};

export const formatCurrentShareValue = (floatMicros: string, notionalValueMicros: string): string => `$${formatMicros(currentShareValueMicros(floatMicros, notionalValueMicros), 3)}`;

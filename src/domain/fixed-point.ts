export const MICROS_PER_UNIT = 1_000_000n;
export const WHOLE_SHARE_MICROS = MICROS_PER_UNIT;
export const CANONICAL_INTEGER_TEXT_PATTERN = /^(?:0|-?[1-9]\d*)$/;

export function assertCanonicalIntegerText(value: string): asserts value is string {
  if (!CANONICAL_INTEGER_TEXT_PATTERN.test(value)) throw new Error("Accounting values must be canonical integer text.");
}

export function parseIntegerText(value: string): bigint {
  assertCanonicalIntegerText(value);
  return BigInt(value);
}

/** Divides with bankers rounding; all persisted accounting values remain integer micros. */
export function divideRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Cannot divide by zero.");
  const negative = (numerator < 0n) !== (denominator < 0n);
  const dividend = numerator < 0n ? -numerator : numerator;
  const divisor = denominator < 0n ? -denominator : denominator;
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;
  const doubled = remainder * 2n;
  const rounded = doubled > divisor || (doubled === divisor && quotient % 2n !== 0n) ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export function multiplyDivideRoundHalfEven(value: bigint, multiplier: bigint, divisor: bigint): bigint {
  return divideRoundHalfEven(value * multiplier, divisor);
}

export function microsFromDecimal(value: string): bigint {
  if (!/^-?(?:\d+)(?:\.\d+)?$/.test(value)) throw new Error("Expected a decimal value.");
  const negative = value.startsWith("-");
  const [whole, fractional = ""] = (negative ? value.slice(1) : value).split(".");
  const scaled = BigInt(whole) * MICROS_PER_UNIT + BigInt((fractional + "000000").slice(0, 6));
  const seventh = fractional[6];
  const rest = fractional.slice(7);
  const increment = seventh && (seventh > "5" || (seventh === "5" && (/[1-9]/.test(rest) || scaled % 2n !== 0n))) ? 1n : 0n;
  return negative ? -(scaled + increment) : scaled + increment;
}

export function formatMicros(value: bigint, decimals: 2 | 3 | 4 | 6): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(6 - decimals);
  const rounded = divideRoundHalfEven(absolute, scale);
  const whole = rounded / 10n ** BigInt(decimals);
  const fraction = (rounded % 10n ** BigInt(decimals)).toString().padStart(decimals, "0");
  return `${negative && rounded !== 0n ? "-" : ""}${whole}.${fraction}`;
}

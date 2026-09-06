import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertCanonicalIntegerText, CANONICAL_INTEGER_TEXT_PATTERN, divideRoundHalfEven, formatMicros, microsFromDecimal, multiplyDivideRoundHalfEven, parseIntegerText, WHOLE_SHARE_MICROS, MICROS_PER_UNIT } from "../../src/domain/fixed-point";
import { americanProfitMicros } from "../../src/domain/odds";

describe("fixed-point accounting", () => {
  it("accepts canonical BigInt integer text at and beyond Number safe bounds", () => {
    expect(parseIntegerText("9007199254740993")).toBe(9007199254740993n);
    expect(CANONICAL_INTEGER_TEXT_PATTERN.test("-42")).toBe(true);
    expect(CANONICAL_INTEGER_TEXT_PATTERN.test("01")).toBe(false);
    expect(() => assertCanonicalIntegerText("01")).toThrow();
    expect(() => assertCanonicalIntegerText("+1")).toThrow();
    expect(() => assertCanonicalIntegerText("1.0")).toThrow();
    const schema = z.object({ value: z.string().transform(parseIntegerText) });
    expect(schema.parse({ value: "-42" }).value).toBe(-42n);
  });

  it("rounds signed ties to even at one micro", () => {
    expect(divideRoundHalfEven(5n, 2n)).toBe(2n);
    expect(divideRoundHalfEven(7n, 2n)).toBe(4n);
    expect(divideRoundHalfEven(-5n, 2n)).toBe(-2n);
    expect(multiplyDivideRoundHalfEven(1n, 1n, 2n)).toBe(0n);
  });

  it("converts decimal input and formats two, four, and six decimal details", () => {
    expect(microsFromDecimal("1.2345678")).toBe(1234568n);
    expect(microsFromDecimal("-0.0000005")).toBe(0n);
    expect(microsFromDecimal("0.00000050")).toBe(0n);
    expect(microsFromDecimal("-0.00000150")).toBe(-2n);
    expect(formatMicros(1234567n, 2)).toBe("1.23");
    expect(formatMicros(1234567n, 4)).toBe("1.2346");
    expect(formatMicros(-1234567n, 6)).toBe("-1.234567");
    expect(WHOLE_SHARE_MICROS).toBe(1000000n);
  });

  it("calculates American-odds profit with BigInt rounding", () => {
    expect(americanProfitMicros(1000000n, 100)).toBe(1000000n);
    expect(americanProfitMicros(1200000n, -120)).toBe(1000000n);
    expect(() => americanProfitMicros(1n, 0)).toThrow();
  });
});

describe("share-price display rounding", () => {
  it("uses half-even micros before displaying four decimals", () => {
    expect(formatMicros(divideRoundHalfEven(10000506n * MICROS_PER_UNIT, 10000000n), 4)).toBe("1.0001");
  });
});

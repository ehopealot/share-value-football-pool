import { describe, expect, it } from "vitest";
import { currentShareValueMicros, formatCurrentShareValue } from "../src/web/share-value";

describe("current share value presentation", () => {
  it("reports zero dollars when no shares have been issued", () => {
    expect(currentShareValueMicros("0", "0")).toBe(0n);
    expect(formatCurrentShareValue("0", "0")).toBe("$0.000");
  });

  it("uses the season notional value divided by issued shares", () => {
    expect(currentShareValueMicros("2000000", "3000000")).toBe(1500000n);
    expect(formatCurrentShareValue("2000000", "3000000")).toBe("$1.500");
  });

  it("shows a third decimal place for fractional share values", () => {
    expect(formatCurrentShareValue("3000000", "1000000")).toBe("$0.333");
  });
});

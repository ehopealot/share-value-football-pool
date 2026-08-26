import { multiplyDivideRoundHalfEven } from "./fixed-point";

/** Returns profit only; callers return the separately locked risk on a win. */
export function americanProfitMicros(riskMicros: bigint, odds: number): bigint {
  if (!Number.isInteger(odds) || odds === 0) throw new Error("American odds must be a non-zero integer.");
  if (riskMicros < 0n) throw new Error("Risk cannot be negative.");
  return odds > 0
    ? multiplyDivideRoundHalfEven(riskMicros, BigInt(odds), 100n)
    : multiplyDivideRoundHalfEven(riskMicros, 100n, BigInt(-odds));
}

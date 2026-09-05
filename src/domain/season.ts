/**
 * Compatibility/reference model retained for existing imports and tests.
 * Production accounting authority lives in the durable SQL repositories and commands.
 */
export type SeasonState = "draft" | "active" | "closed";
export type CloseReason = "float_exhausted" | undefined;

export interface ShareAccount { availableMicros: bigint; lockedMicros: bigint; attainedAt: number; }
export interface LedgerEntry {
  id: string;
  member: string;
  availableDelta: bigint;
  lockedDelta: bigint;
  floatDelta: bigint;
  notionalDelta: bigint;
  kind: "order" | "lock" | "settlement" | "reversal";
  causationId: string;
}
export interface OrderQuote { priceMicros: bigint; commandVersion: string; }
export interface SeasonLedger {
  state: SeasonState;
  closedReason: CloseReason;
  floatMicros: bigint;
  notionalMicros: bigint;
  commandVersion: bigint;
  accounts: Record<string, ShareAccount>;
  journal: LedgerEntry[];
  settled: Record<string, { member: string; riskMicros: bigint; outcome: "win" | "loss" | "push" | "void"; profitMicros: bigint }>;
}

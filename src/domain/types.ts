export type Market = "spread" | "total" | "moneyline";
export type Selection = "home" | "away" | "over" | "under";
/** `pending` retains action for an eligible same-event-ID postponement. */
export type LegGrade = "win" | "loss" | "push" | "void" | "pending";

/** Required when assembling a multi-leg ticket; single-leg grading is event-agnostic. */
interface BaseTeaserLeg { eventId?: string; }
export type TeaserLeg =
  | (BaseTeaserLeg & { market: "spread"; selection: "home" | "away"; line: number })
  | (BaseTeaserLeg & { market: "total"; selection: "over" | "under"; line: number })
  | (BaseTeaserLeg & { market: "moneyline"; selection: "home" | "away"; line?: never });

export interface ScoreResult {
  home: number;
  away: number;
  status?: "final" | "cancelled" | "no_contest" | "postponed";
  sameEventId?: boolean;
  hoursDelayed?: number;
}

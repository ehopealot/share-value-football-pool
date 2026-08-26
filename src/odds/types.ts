export type League = "nfl" | "ncaaf";
export type MarketName = "spread" | "total" | "moneyline";
export type EventStatus = "scheduled" | "in_progress" | "final" | "cancelled" | "no_contest" | "postponed";

export interface ProviderOutcome { name: string; price: number; point?: number; }
export interface ProviderMarket { key: MarketName; outcomes: ProviderOutcome[]; }
export interface ProviderBook { key: string; title: string; markets: ProviderMarket[]; }
export interface ProviderEvent {
  id: string; sport: League; commenceTime: string; homeTeam: string; awayTeam: string;
  status?: EventStatus; homeScore?: number; awayScore?: number; postseason?: boolean; eventName?: string;
  bookmakers: ProviderBook[];
}
/** Provider quota observations are documented response-header evidence, not guesses. */
export interface ProviderQuota { remaining?: number; used?: number; }
export interface ProviderPoll { events: ProviderEvent[]; quota?: ProviderQuota; }
export interface OddsProvider { events(league: League): Promise<ProviderPoll>; }

/** Deployment-wide ordered source policy. It is never member or pool configurable. */
export const canonicalBooks = ["DraftKings", "FanDuel", "BetMGM", "Caesars"] as const;
export const CANONICAL_BOOK_POLICY_VERSION = "CANONICAL_BOOKS_2026_V1" as const;
export interface CanonicalOffer {
  eventId: string; market: MarketName; canonicalBook: string; retrievedAt: string;
  offerVersion: string; policyVersion: typeof CANONICAL_BOOK_POLICY_VERSION; payload: ProviderMarket;
}

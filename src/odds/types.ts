import type { z } from "zod";
import type { providerBook, providerEventSnapshot, providerLeague, providerMarket, providerOutcome, providerStatus } from "../contracts/provider";

export type League = z.infer<typeof providerLeague>;
export type MarketName = z.infer<typeof providerMarket>["key"];
export type EventStatus = z.infer<typeof providerStatus>;

export type ProviderOutcome = z.infer<typeof providerOutcome>;
export type ProviderMarket = z.infer<typeof providerMarket>;
export type ProviderBook = z.infer<typeof providerBook>;
export type ProviderEvent = z.infer<typeof providerEventSnapshot>;
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

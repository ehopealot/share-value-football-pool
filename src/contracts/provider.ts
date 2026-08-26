import { z } from "zod";

export const providerLeague = z.enum(["nfl", "ncaaf"]);
export const providerStatus = z.enum(["scheduled", "in_progress", "final", "cancelled", "no_contest", "postponed"]);
export const providerOutcome = z.object({ name: z.string().min(1), price: z.number().int(), point: z.number().finite().optional() }).strict();
export const providerMarket = z.object({ key: z.enum(["spread", "total", "moneyline"]), outcomes: z.array(providerOutcome).min(1) }).strict();
export const providerBook = z.object({ key: z.string().min(1), title: z.string().min(1), markets: z.array(providerMarket) }).strict();
export const providerEvent = z.object({ providerEventId: z.string(), league: providerLeague, startsAt: z.string().datetime() });
export const providerEventSnapshot = z.object({ id: z.string().min(1), sport: providerLeague, commenceTime: z.string().datetime(), homeTeam: z.string().min(1), awayTeam: z.string().min(1), status: providerStatus.optional(), homeScore: z.number().int().optional(), awayScore: z.number().int().optional(), postseason: z.boolean().optional(), eventName: z.string().min(1).optional(), bookmakers: z.array(providerBook) }).strict();

/** Documented The Odds API v4 odds response shape, parsed before normalization. */
export const theOddsApiOutcome = z.object({ name: z.string().min(1), price: z.number().int(), point: z.number().finite().optional() });
export const theOddsApiMarket = z.object({ key: z.enum(["spreads", "totals", "h2h"]), outcomes: z.array(theOddsApiOutcome).min(2) });
export const theOddsApiBook = z.object({ key: z.string().min(1), title: z.string().min(1), markets: z.array(theOddsApiMarket) });
export const theOddsApiEvent = z.object({ id: z.string().min(1), commence_time: z.string().datetime(), home_team: z.string().min(1), away_team: z.string().min(1), bookmakers: z.array(theOddsApiBook).optional(), title: z.string().min(1).optional(), postseason: z.boolean().optional() });
// The documented scores endpoint represents not-yet-reported scores as null; it does not require a synthetic status string.
export const theOddsApiScoreEvent = theOddsApiEvent.extend({ completed: z.boolean().optional(), scores: z.array(z.object({ name: z.string().min(1), score: z.string().nullable() })).nullable().optional() });
export const theOddsApiOddsResponse = z.array(theOddsApiEvent);
export const theOddsApiScoresResponse = z.array(theOddsApiScoreEvent);
export type ProviderEvent = z.infer<typeof providerEvent>;
export type ProviderEventSnapshot = z.infer<typeof providerEventSnapshot>;

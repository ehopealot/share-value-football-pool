import type { z } from "zod";
import type { ReadActivity } from "../contracts/http";
import type { correctedEventResult } from "../contracts/commands";
import { sortWagerLegsByStartTime } from "./wager-presentation";

export type CorrectionWager = ReadActivity["activity"]["wagers"][number];
export type CorrectionEvent = {
  eventId: string;
  league: "nfl" | "ncaaf";
  homeTeam: string;
  awayTeam: string;
  status: "final" | "cancelled" | "no_contest";
  homeScore: string;
  awayScore: string;
};

/** Use Activity's authorized projection only, never audit snapshots to fill hidden legs. */
export function correctionEvents(wager: CorrectionWager, now = Date.now()): CorrectionEvent[] {
  if (!wager.legs?.length || wager.hiddenLegCount || wager.legs.some(leg =>
    !(Date.parse(leg.eventStartsAt) <= now) || (leg.league !== "nfl" && leg.league !== "ncaaf"))) return [];
  const events = new Map<string, CorrectionEvent>();
  for (const leg of sortWagerLegsByStartTime(wager.legs)) {
    const key = JSON.stringify([leg.league, leg.eventId]);
    if (!events.has(key) && (leg.league === "nfl" || leg.league === "ncaaf")) events.set(key, {
      eventId: leg.eventId, league: leg.league, homeTeam: leg.homeTeam || "Home team", awayTeam: leg.awayTeam || "Away team",
      status: "final", homeScore: leg.homeScore?.toString() ?? "", awayScore: leg.awayScore?.toString() ?? ""
    });
  }
  return [...events.values()];
}

function score(value: string, team: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Enter a nonnegative whole-number score for ${team}.`);
  return Number(value);
}

export function correctedResults(events: CorrectionEvent[], commandId: string): z.infer<typeof correctedEventResult>[] {
  return events.map(event => {
    const identity = { eventId: event.eventId, league: event.league, correctionVersion: `commissioner:${commandId}` };
    return event.status === "final"
      ? { ...identity, status: "final", homeScore: score(event.homeScore, event.homeTeam), awayScore: score(event.awayScore, event.awayTeam) }
      : { ...identity, status: event.status, homeScore: null, awayScore: null };
  });
}

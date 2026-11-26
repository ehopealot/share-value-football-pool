import type { ReadActivity } from "../contracts/http";
import { hasActiveActivityGame } from "./activity-presentation";

type Wager = ReadActivity["activity"]["wagers"][number];

/** Scheduled kickoff only selects candidates; provider state confirms actual play. */
export async function loadLiveGameStates(wagers: Wager[], now: number, load: (eventId: string) => Promise<{ state: "pregame" | "live" | "final" }>) {
  const candidates = [...new Set(wagers.filter((wager) => hasActiveActivityGame(wager, now)).flatMap((wager) => (wager.legs ?? []).filter((leg) => !leg.grade && Date.parse(leg.eventStartsAt) <= now).map((leg) => leg.eventId)))];
  const liveEventIds = new Set<string>();
  let failures = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, async () => {
    while (next < candidates.length) {
      const eventId = candidates[next++]!;
      try { if ((await load(eventId)).state === "live") liveEventIds.add(eventId); }
      catch { failures++; }
    }
  }));
  return { liveEventIds, failures };
}

export function hasConfirmedLiveGame(wager: Wager, now: number, liveEventIds: ReadonlySet<string>): boolean {
  return hasActiveActivityGame(wager, now) && (wager.legs ?? []).some((leg) => !leg.grade && Date.parse(leg.eventStartsAt) <= now && liveEventIds.has(leg.eventId));
}

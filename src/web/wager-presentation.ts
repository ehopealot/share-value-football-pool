import { formatMicros } from "../domain/fixed-point";
import { americanProfitMicros } from "../domain/odds";
import { formatKickoff } from "./odds-format";

/** Owner-facing possible returns use the same half-even settlement arithmetic as tickets. */
export const ticketReturns = (riskMicros: string, acceptedOdds: number) => {
  const risk = BigInt(riskMicros);
  const profit = americanProfitMicros(risk, acceptedOdds);
  return { profit: formatMicros(profit, 2), total: formatMicros(risk + profit, 2) };
};

type WagerWithStartTime = { wagerId: string; confirmedAt: string; type: string; legs?: Array<{ eventStartsAt: string; grade?: string | null }> };

const representativeWagerStartTime = (wager: WagerWithStartTime): string | undefined => {
  const validLegs = (wager.legs ?? []).filter((leg) => Number.isFinite(Date.parse(leg.eventStartsAt)));
  const activeOrUpcoming = validLegs.filter((leg) => leg.grade === undefined || leg.grade === null);
  const starts = (activeOrUpcoming.length ? activeOrUpcoming : validLegs).map((leg) => leg.eventStartsAt).sort();
  return activeOrUpcoming.length ? starts[0] : starts.at(-1);
};

/** Returns a chronological display copy while preserving selection order for equal or unavailable kickoffs. */
export const sortWagerLegsByStartTime = <T extends { eventStartsAt: string }>(legs: T[]): T[] => [...legs].sort((left, right) => {
  const leftStart = Date.parse(left.eventStartsAt);
  const rightStart = Date.parse(right.eventStartsAt);
  if (Number.isFinite(leftStart) && Number.isFinite(rightStart)) return leftStart - rightStart;
  if (Number.isFinite(leftStart)) return -1;
  if (Number.isFinite(rightStart)) return 1;
  return 0;
});

/** Each ticket leg retains its own kickoff, so multi-leg tickets can align every start with its wager line. */
export const displayWagerStartTimes = (wager: WagerWithStartTime): string[] => sortWagerLegsByStartTime(wager.legs ?? []).map((leg) => Number.isFinite(Date.parse(leg.eventStartsAt)) ? formatKickoff(leg.eventStartsAt) : "");

const dateLabel = (startsAt: string): string => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date(startsAt));

/** Mobile tables lift repeated dates into one compact ticket ribbon. */
export const displayWagerDateLabel = (wager: WagerWithStartTime): string => {
  const start = representativeWagerStartTime(wager);
  return start ? dateLabel(start) : "Upcoming";
};

export const displayWagerStartTimeOnly = (wager: WagerWithStartTime): string[] => {
  const legs = sortWagerLegsByStartTime(wager.legs ?? []);
  const dates = new Set(legs.filter((leg) => Number.isFinite(Date.parse(leg.eventStartsAt))).map((leg) => new Date(leg.eventStartsAt).toDateString()));
  const anchor = representativeWagerStartTime(wager);
  const anchorDate = anchor ? new Date(anchor).toDateString() : "";
  return legs.map((leg) => {
    if (!Number.isFinite(Date.parse(leg.eventStartsAt))) return "";
    if (dates.size > 1 && new Date(leg.eventStartsAt).toDateString() !== anchorDate) return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(new Date(leg.eventStartsAt));
    return formatKickoff(leg.eventStartsAt).split(" ")[1] ?? "";
  });
};

/** Returns a chronological copy, retaining a deterministic order when kickoff data ties or is unavailable. */
const byKickoffOrder = (key: (wager: WagerWithStartTime) => string | undefined) => (left: WagerWithStartTime, right: WagerWithStartTime) =>
  (key(left) ?? "9999-12-31T23:59:59.999Z").localeCompare(key(right) ?? "9999-12-31T23:59:59.999Z") || left.confirmedAt.localeCompare(right.confirmedAt) || left.wagerId.localeCompare(right.wagerId);

const earliestWagerStartTime = (wager: WagerWithStartTime): string | undefined => (wager.legs ?? []).map((leg) => leg.eventStartsAt).filter((start) => Number.isFinite(Date.parse(start))).sort()[0];

export const sortWagersByStartTime = <T extends WagerWithStartTime>(wagers: T[]): T[] => [...wagers].sort(byKickoffOrder(earliestWagerStartTime));

/** Mobile date ribbons group tickets under their soonest active or upcoming leg, or the last leg day once fully graded. */
export const sortWagersByAnchorTime = <T extends WagerWithStartTime>(wagers: T[]): T[] => [...wagers].sort(byKickoffOrder(representativeWagerStartTime));

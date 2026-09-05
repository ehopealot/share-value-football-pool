import { formatMicros } from "../domain/fixed-point";
import { americanProfitMicros } from "../domain/odds";
import { formatKickoff } from "./odds-format";

/** Owner-facing possible returns use the same half-even settlement arithmetic as tickets. */
export const ticketReturns = (riskMicros: string, acceptedOdds: number) => {
  const risk = BigInt(riskMicros);
  const profit = americanProfitMicros(risk, acceptedOdds);
  return { profit: formatMicros(profit, 2), total: formatMicros(risk + profit, 2) };
};

type WagerWithStartTime = { wagerId: string; confirmedAt: string; type: string; legs?: Array<{ eventStartsAt: string }> };

const earliestWagerStartTime = (wager: WagerWithStartTime): string | undefined => wager.legs
  ?.map((leg) => leg.eventStartsAt)
  .filter((start) => Number.isFinite(Date.parse(start)))
  .sort()[0];

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

/** Returns a chronological copy, retaining a deterministic order when kickoff data ties or is unavailable. */
export const sortWagersByStartTime = <T extends WagerWithStartTime>(wagers: T[]): T[] => [...wagers].sort((left, right) => {
  const startOrder = (earliestWagerStartTime(left) ?? "9999-12-31T23:59:59.999Z").localeCompare(earliestWagerStartTime(right) ?? "9999-12-31T23:59:59.999Z");
  return startOrder || left.confirmedAt.localeCompare(right.confirmedAt) || left.wagerId.localeCompare(right.wagerId);
});

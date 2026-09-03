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

/** Parlays are ordered by their earliest leg but intentionally have no singular displayed start time. */
export const displayWagerStartTime = (wager: WagerWithStartTime): string => {
  const start = wager.type === "straight" ? earliestWagerStartTime(wager) : undefined;
  return start ? formatKickoff(start) : "";
};

/** Returns a chronological copy, retaining a deterministic order when kickoff data ties or is unavailable. */
export const sortWagersByStartTime = <T extends WagerWithStartTime>(wagers: T[]): T[] => [...wagers].sort((left, right) => {
  const startOrder = (earliestWagerStartTime(left) ?? "9999-12-31T23:59:59.999Z").localeCompare(earliestWagerStartTime(right) ?? "9999-12-31T23:59:59.999Z");
  return startOrder || left.confirmedAt.localeCompare(right.confirmedAt) || left.wagerId.localeCompare(right.wagerId);
});

import { formatMicros } from "../domain/fixed-point";
import { americanProfitMicros } from "../domain/odds";

/** Owner-facing possible returns use the same half-even settlement arithmetic as tickets. */
export const ticketReturns = (riskMicros: string, acceptedOdds: number) => {
  const risk = BigInt(riskMicros);
  const profit = americanProfitMicros(risk, acceptedOdds);
  return { profit: formatMicros(profit, 2), total: formatMicros(risk + profit, 2) };
};

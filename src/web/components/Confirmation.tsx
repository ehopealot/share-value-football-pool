import type { z } from "zod";
import { straightWagerQuoteSnapshot, teaserWagerQuoteSnapshot, shareOrderQuoteSnapshot } from "../../contracts/http";
import { formatMicros } from "../../domain/fixed-point";
import { ticketReturns } from "../wager-presentation";

type Snapshot =
  | { kind: "straight"; quote: z.infer<typeof straightWagerQuoteSnapshot> }
  | { kind: "teaser"; quote: z.infer<typeof teaserWagerQuoteSnapshot> }
  | { kind: "order"; quote: z.infer<typeof shareOrderQuoteSnapshot>; memberDisplayName: string };

/** Review-only authority snapshot renderer. It deliberately accepts no editor data or callbacks. */
export function Confirmation({ snapshot }: { snapshot: Snapshot }) {
  if (snapshot.kind === "straight") {
    const q = snapshot.quote; const returns = ticketReturns(q.riskMicros, q.acceptedOdds);
    return <section aria-labelledby="confirmation-title"><h1 id="confirmation-title">Confirm straight wager</h1><div className="confirmation-terms"><p>{q.leg.awayTeam} at {q.leg.homeTeam}; kickoff {new Date(q.leg.eventStartsAt).toLocaleString()}.</p><p>Source {q.leg.canonicalBook}, retrieved {new Date(q.leg.retrievedAt).toLocaleString()}. {q.leg.market} {q.leg.selection} line {q.leg.originalLine ?? "—"}; source price {q.leg.originalOdds > 0 ? "+" : ""}{q.leg.originalOdds}; accepted ticket price {q.acceptedOdds > 0 ? "+" : ""}{q.acceptedOdds}.</p><p>Risk {(BigInt(q.riskMicros) / 1000000n).toString()} whole shares; ruleset {q.rulesetVersion}; possible profit {returns.profit} shares; total return {returns.total} shares.</p></div></section>;
  }
  if (snapshot.kind === "teaser") {
    const q = snapshot.quote; const returns = ticketReturns(q.riskMicros, q.acceptedOdds);
    return <section aria-labelledby="confirmation-title"><h1 id="confirmation-title">Confirm teaser wager</h1><div className="confirmation-terms"><p>{q.legs.length}-leg {q.teaserPoints}-point teaser. Risk {(BigInt(q.riskMicros) / 1000000n).toString()} whole shares; accepted price {q.acceptedOdds > 0 ? "+" : ""}{q.acceptedOdds}; possible profit {returns.profit} shares; total return {returns.total} shares.</p><ul>{q.legs.map(leg => <li key={`${leg.eventId}-${leg.market}-${leg.selection}`}>{leg.awayTeam} at {leg.homeTeam}; kickoff {new Date(leg.eventStartsAt).toLocaleString()}. {leg.market} {leg.selection}: original line {leg.originalLine} adjusted to {leg.adjustedLine}; source price {leg.originalOdds > 0 ? "+" : ""}{leg.originalOdds}; accepted teaser price {q.acceptedOdds > 0 ? "+" : ""}{q.acceptedOdds}.</li>)}</ul></div></section>;
  }
  const q = snapshot.quote;
  return <section aria-labelledby="confirmation-title"><h1 id="confirmation-title">Confirm share order</h1><div className="confirmation-terms"><p>Issue {formatMicros(BigInt(q.sharesMicros), 2)} shares worth {formatMicros(BigInt(q.valueMicros), 2)} virtual value to {snapshot.memberDisplayName}.</p><p>Locked price: {formatMicros(BigInt(q.priceMicros), 4)} per share ({formatMicros(BigInt(q.priceMicros), 6)} exact six-decimal terms); command version {q.commandVersion}.</p></div></section>;
}

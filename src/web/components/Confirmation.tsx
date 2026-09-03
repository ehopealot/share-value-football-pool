import type { z } from "zod";
import { straightWagerQuoteSnapshot, teaserWagerQuoteSnapshot, parlayWagerQuoteSnapshot, shareOrderQuoteSnapshot } from "../../contracts/http";
import { formatMicros } from "../../domain/fixed-point";
import { ticketReturns } from "../wager-presentation";
import { formatAmericanOdds } from "../odds-format";

type Snapshot =
  | { kind: "straight"; quote: z.infer<typeof straightWagerQuoteSnapshot> }
  | { kind: "teaser"; quote: z.infer<typeof teaserWagerQuoteSnapshot> }
  | { kind: "parlay"; quote: z.infer<typeof parlayWagerQuoteSnapshot> }
  | { kind: "order"; quote: z.infer<typeof shareOrderQuoteSnapshot>; memberDisplayName: string };

/** Review-only authority snapshot renderer. It deliberately accepts no editor data or callbacks. */
export function Confirmation({ snapshot }: { snapshot: Snapshot }) {
  if (snapshot.kind === "straight") {
    const q = snapshot.quote; const returns = ticketReturns(q.riskMicros, q.acceptedOdds);
    return <section aria-labelledby="confirmation-title"><h1 id="confirmation-title">Confirm straight wager</h1><div className="confirmation-terms"><p>{q.leg.awayTeam} at {q.leg.homeTeam}; kickoff {new Date(q.leg.eventStartsAt).toLocaleString()}.</p><p>Source {q.leg.canonicalBook}, retrieved {new Date(q.leg.retrievedAt).toLocaleString()}. {q.leg.market} {q.leg.selection} line {q.leg.originalLine ?? "—"}; source price {formatAmericanOdds(q.leg.originalOdds)}; accepted ticket price {formatAmericanOdds(q.acceptedOdds)}.</p><p>Risk {(BigInt(q.riskMicros) / 1000000n).toString()} whole shares; ruleset {q.rulesetVersion}; possible profit {returns.profit} shares; total return {returns.total} shares.</p></div></section>;
  }
  if (snapshot.kind === "teaser") {
    const q = snapshot.quote; const returns = ticketReturns(q.riskMicros, q.acceptedOdds);
    return <section aria-labelledby="confirmation-title"><h1 id="confirmation-title">Confirm teaser wager</h1><div className="confirmation-terms"><p>{q.legs.length}-leg, {q.teaserPoints}-point teaser</p><p><strong>Odds:</strong> {formatAmericanOdds(q.acceptedOdds)} · <strong>Risk:</strong> {(BigInt(q.riskMicros) / 1000000n).toString()} · <strong>Win:</strong> {returns.profit} · <strong>Payout:</strong> {returns.total}</p><ul>{q.legs.map(leg => <li key={`${leg.eventId}-${leg.market}-${leg.selection}`}>{leg.awayTeam} at {leg.homeTeam}: {leg.market} {leg.selection}, line {leg.adjustedLine}</li>)}</ul></div></section>;
  }
  if (snapshot.kind === "parlay") {
    const q = snapshot.quote; const returns = ticketReturns(q.riskMicros, q.acceptedOdds);
    const hasSameGamePair = q.legs.some((leg) => leg.market === "total" && q.legs.some((other) => other.eventId === leg.eventId && (other.market === "spread" || other.market === "moneyline")));
    return <section aria-labelledby="confirmation-title"><h1 id="confirmation-title">Confirm parlay wager</h1><div className="confirmation-terms"><p>{q.legs.length}-leg parlay · ruleset {q.rulesetVersion}</p><p><strong>Odds:</strong> {formatAmericanOdds(q.acceptedOdds)} · <strong>Risk:</strong> {(BigInt(q.riskMicros) / 1000000n).toString()} · <strong>Win:</strong> {returns.profit} · <strong>Payout:</strong> {returns.total}</p><ul>{q.legs.map((leg) => <li key={`${leg.eventId}-${leg.market}-${leg.selection}`}>{leg.awayTeam} at {leg.homeTeam}: {leg.market} {leg.selection}{leg.originalLine === null ? ` (${formatAmericanOdds(leg.originalOdds)})` : `, line ${leg.originalLine}`}</li>)}</ul>{hasSameGamePair && <p>Same-game total adjustment: a total paired with its event’s spread or moneyline is priced at -133.</p>}</div></section>;
  }
  const q = snapshot.quote;
  return <section aria-labelledby="confirmation-title"><h1 id="confirmation-title">Confirm share order</h1><div className="confirmation-terms"><p>Issue <strong>{(BigInt(q.sharesMicros) / 1000000n).toString()}</strong> shares to {snapshot.memberDisplayName}.</p><p>Locked price: <strong>${formatMicros(BigInt(q.priceMicros), 2)}</strong> per share.</p></div></section>;
}

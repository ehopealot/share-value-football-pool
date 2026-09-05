import type { ReadActivity } from "../../contracts/http";
import { formatAmericanOdds } from "../odds-format";
import { sortWagerLegsByStartTime } from "../wager-presentation";

type Wager = ReadActivity["activity"]["wagers"][number];

const acceptedLine = (leg: NonNullable<Wager["legs"]>[number]) => leg.originalLine ?? formatAmericanOdds(leg.originalOdds);

export function WagerDetails({ wager, ownerOutcome = false }: { wager: Wager; ownerOutcome?: boolean }) {
  const outcome = wager.outcome
    ? ownerOutcome ? `Current outcome: ${wager.outcome}` : "Settled"
    : wager.status === "open" ? "Awaiting settlement" : "Settled";
  return <section aria-labelledby={`wager-${wager.wagerId}`}>
    <h3 id={`wager-${wager.wagerId}`}>{wager.memberDisplayName} — {wager.type} wager</h3>
    <p>Status: {wager.status}. {outcome}.</p>
    {ownerOutcome && wager.acceptedOdds !== undefined && <p>Accepted ticket odds: {formatAmericanOdds(wager.acceptedOdds)}. {wager.outcome === "won" ? `Recorded settlement odds: ${typeof wager.settledOdds === "number" ? formatAmericanOdds(wager.settledOdds) : "Not recorded"}.` : "No paid odds."}</p>}
    {wager.legs?.length ? <div className="table-scroll" tabIndex={0}><table>
      <caption>Authorized wager selections</caption>
      <thead><tr><th>Event ID</th><th>League</th><th>Teams</th><th>Market</th><th>Selection</th><th>Accepted line</th><th>Adjusted line</th><th>Source</th><th>Retrieved</th><th>Start time</th><th>Grade</th><th>Result version</th></tr></thead>
      <tbody>{sortWagerLegsByStartTime(wager.legs).map((leg) => <tr key={`${leg.eventId}:${leg.market}:${leg.selection}`}><td>{leg.eventId}</td><td>{leg.league}</td><td>{leg.homeTeam && leg.awayTeam ? `${leg.awayTeam} at ${leg.homeTeam}` : "—"}</td><td>{leg.market}</td><td>{leg.selection}</td><td>{acceptedLine(leg)}</td><td>{leg.adjustedLine ?? "—"}</td><td>{leg.canonicalBook}</td><td>{leg.retrievedAt}</td><td>{leg.eventStartsAt}</td><td>{leg.grade ?? "—"}</td><td>{leg.resultVersion ?? "—"}</td></tr>)}</tbody>
    </table></div> : <p className="state-notice">Selection hidden until start.</p>}
  </section>;
}

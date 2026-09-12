import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { type EspnMatchupResponse } from "../../contracts/http";
import { api } from "../api";
import { Layout } from "../components/Layout";
import { formatKickoff } from "../odds-format";

/** A missing ESPN event and an inactive-week event share this safe, accurate member-facing state. */
export const matchupUnavailableMessage = (_error: unknown) => "Matchup details aren't available for this game.";

/** Side-by-side ESPN facts stay readable when an upstream field is unavailable. */
export function MatchupDetails({ matchup }: { matchup: EspnMatchupResponse }) {
  const teams = [matchup.away, matchup.home] as const;
  return <article className="matchup-details">
    <header className="matchup-details-header"><p className="pool-context">ESPN matchup details</p><h1>{matchup.away.name} at {matchup.home.name}</h1><p><strong>Kickoff:</strong> <time dateTime={matchup.startsAt}>{formatKickoff(matchup.startsAt)}</time>{matchup.venue && <> · {matchup.venue}</>}</p></header>
    <section aria-label="Team records" className="table-ribbon-section"><h2 className="table-ribbon">Team records</h2>
      <div className="matchup-team-records">{teams.map((team) => <div key={team.name} className="matchup-team-record"><h3 className="matchup-team-ribbon"><span>{team.name}</span>{team.logo && <img src={team.logo} alt="" width="24" height="24"/>}</h3><p><strong>Record:</strong> {team.record ?? "Not available"}</p></div>)}</div>
    </section>
    <section aria-label="Season team stats" className="table-ribbon-section"><h2 className="table-ribbon">Season team stats</h2>{matchup.seasonStats.length > 0 ? <div className="table-scroll" tabIndex={0}><table className="matchup-stats"><thead><tr><th scope="col">{matchup.away.name}</th><th scope="col">{matchup.home.name}</th></tr></thead><tbody>{matchup.seasonStats.map((stat) => <tr key={stat.label}><th scope="row">{stat.label}</th><td>{stat.away ?? "—"}</td><td>{stat.home ?? "—"}</td></tr>)}</tbody></table></div> : <p className="state-notice">Season team stats are not available from ESPN yet.</p>}</section>
    <section aria-label="Recent results" className="table-ribbon-section"><h2 className="table-ribbon">Recent results</h2>
      <div className="matchup-recent-results">{teams.map((team) => <section key={team.name} className="matchup-recent-team"><h3 className="matchup-team-ribbon"><span>{team.name}</span></h3>{team.recentResults.length > 0 ? <ul>{team.recentResults.map((result) => <li key={`${result.date}-${result.opponent}`}><time dateTime={result.date}>{formatKickoff(result.date)}</time> · {result.result} vs {result.opponent}</li>)}</ul> : <p>Recent results are not available.</p>}</section>)}</div>
    </section>
  </article>;
}

/** An in-app detail route leaves the odds page's pool-scoped selection tray intact in browser storage. */
export function MatchupDetailsPage() {
  const { slug = "", eventId = "" } = useParams();
  const [matchup, setMatchup] = useState<EspnMatchupResponse>(); const [error, setError] = useState("");
  useEffect(() => {
    let active = true; setMatchup(undefined); setError("");
    void api.matchup(slug, eventId).then((loaded) => { if (active) setMatchup(loaded); }).catch((reason) => { if (active) setError(matchupUnavailableMessage(reason)); });
    return () => { active = false; };
  }, [slug, eventId]);
  const back = <p className="matchup-details-back"><Link to={`/p/${slug}/odds`}>Back to odds board</Link></p>;
  if (error) return <Layout><h1>Matchup details</h1><p role="alert" className="error-summary">{error}</p>{back}</Layout>;
  if (!matchup) return <Layout><h1>Matchup details</h1><p role="status">Loading matchup details…</p>{back}</Layout>;
  return <Layout><MatchupDetails matchup={matchup}/>{back}</Layout>;
}

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { type EspnMatchupResponse } from "../../contracts/http";
import { ApiError, api } from "../api";
import { Layout } from "../components/Layout";
import { formatKickoff } from "../odds-format";

const unavailableMessage = (error: unknown) => error instanceof ApiError && error.code === "MATCHUP_NOT_AVAILABLE"
  ? "Matchup details are available only for games in the current week."
  : "Matchup details are unavailable right now. Please try again later.";

/** Side-by-side ESPN facts stay readable when an upstream field is unavailable. */
export function MatchupDetails({ matchup }: { matchup: EspnMatchupResponse }) {
  const teams = [matchup.away, matchup.home] as const;
  return <article className="matchup-details">
    <header className="matchup-details-header"><p className="pool-context">ESPN matchup details</p><h1>{matchup.away.name} at {matchup.home.name}</h1><p><strong>Kickoff:</strong> <time dateTime={matchup.startsAt}>{formatKickoff(matchup.startsAt)}</time>{matchup.venue && <> · {matchup.venue}</>}</p></header>
    <section aria-label="Team records" className="matchup-team-records">
      {teams.map((team) => <div key={team.name} className="matchup-team-record"><>{team.logo && <img src={team.logo} alt="" width="48" height="48"/>}</><h2>{team.name}</h2><p><strong>Record:</strong> {team.record ?? "Not available"}</p></div>)}
    </section>
    <section><h2>Season team stats</h2>{matchup.seasonStats.length > 0 ? <div className="table-scroll" tabIndex={0}><table className="matchup-stats"><caption>Season team stats</caption><thead><tr><th scope="col">Stat</th><th scope="col">{matchup.away.name}</th><th scope="col">{matchup.home.name}</th></tr></thead><tbody>{matchup.seasonStats.map((stat) => <tr key={stat.label}><th scope="row">{stat.label}</th><td>{stat.away ?? "—"}</td><td>{stat.home ?? "—"}</td></tr>)}</tbody></table></div> : <p className="state-notice">Season team stats are not available from ESPN yet.</p>}</section>
    <section><h2>Recent results</h2><div className="matchup-recent-results">{teams.map((team) => <section key={team.name}><h3>{team.name}</h3>{team.recentResults.length > 0 ? <ul>{team.recentResults.map((result) => <li key={`${result.date}-${result.opponent}`}><time dateTime={result.date}>{formatKickoff(result.date)}</time> · {result.result} vs {result.opponent}</li>)}</ul> : <p>Recent results are not available.</p>}</section>)}</div></section>
  </article>;
}

/** An in-app detail route leaves the odds page's pool-scoped selection tray intact in browser storage. */
export function MatchupDetailsPage() {
  const { slug = "", eventId = "" } = useParams();
  const [matchup, setMatchup] = useState<EspnMatchupResponse>(); const [error, setError] = useState("");
  useEffect(() => {
    let active = true; setMatchup(undefined); setError("");
    void api.matchup(slug, eventId).then((loaded) => { if (active) setMatchup(loaded); }).catch((reason) => { if (active) setError(unavailableMessage(reason)); });
    return () => { active = false; };
  }, [slug, eventId]);
  const back = <p className="matchup-details-back"><Link to={`/p/${slug}/odds`}>Back to odds board</Link></p>;
  if (error) return <Layout><h1>Matchup details</h1><p role="alert" className="error-summary">{error}</p>{back}</Layout>;
  if (!matchup) return <Layout><h1>Matchup details</h1><p role="status">Loading matchup details…</p>{back}</Layout>;
  return <Layout><MatchupDetails matchup={matchup}/>{back}</Layout>;
}

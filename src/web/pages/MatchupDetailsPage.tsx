import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { type EspnMatchupResponse } from "../../contracts/http";
import { EspnBoxScoreResponse as EspnBoxScore, PoolExposureResponse } from "../../contracts/http";
import { api } from "../api";
import { Layout } from "../components/Layout";
import { formatKickoff } from "../odds-format";
import { WagerLines } from "./ActivityPage";
import { groupBoardByEvent, type MarketCell } from "./OddsPage";
import { activityWagerPerformanceClass, formatActivityPerformance, formatActivityStake, formatActivityWagerPerformance } from "../activity-presentation";
import { parseIntegerText } from "../../domain/fixed-point";

/** A missing ESPN event and an inactive-week event share this safe, accurate member-facing state. */
export const matchupUnavailableMessage = (_error: unknown) => "Matchup details aren't available for this game.";

/** Pool-wide bets touching this game; a settled parlay/teaser counts at full wager P&L in every game it touches. */
export function PoolExposure({ wagers, slug }: { wagers: PoolExposureResponse["wagers"]; slug: string }) {
  const netMicros = wagers.reduce((sum, wager) => sum + parseIntegerText(wager.performanceMicros), 0n);
  const members = new Map<string, { name: string; netMicros: bigint; wagers: PoolExposureResponse["wagers"] }>();
  for (const wager of wagers) {
    const entry = members.get(wager.memberId) ?? { name: wager.memberDisplayName, netMicros: 0n, wagers: [] };
    entry.netMicros += parseIntegerText(wager.performanceMicros);
    entry.wagers.push(wager);
    members.set(wager.memberId, entry);
  }
  const ordered = [...members.entries()].map(([memberId, entry]) => ({ memberId, ...entry })).sort((left, right) => left.name.localeCompare(right.name));
  return <section aria-label="Pool exposure" className="table-ribbon-section matchup-exposure">
    <h2 className="table-ribbon">Pool exposure<small>Pool net {formatActivityPerformance(netMicros.toString())}</small></h2>
    {wagers.length === 0 ? <p className="state-notice">No pool bets on this game.</p> : <div className="table-scroll" tabIndex={0}><table className="activity-table"><colgroup><col className="activity-wager-column"/><col className="activity-staked-column"/><col className="activity-pnl-column"/></colgroup><thead><tr><th>Wager</th><th>Staked</th><th>P&L</th></tr></thead>
      {ordered.map((member) => <tbody key={member.memberId}>
        <tr className="activity-day-member-ribbon"><th colSpan={3} scope="rowgroup"><span>{member.name}<small>{formatActivityPerformance(member.netMicros.toString())}</small></span></th></tr>
        {member.wagers.map((wager) => { const stake = formatActivityStake(wager); return <tr key={wager.wagerId}><td><WagerLines wager={wager} slug={slug}/></td><td>{stake ? <span className="activity-staked">{stake.amount} <small className="activity-staked-odds">{stake.odds}</small></span> : "—"}</td><td className={activityWagerPerformanceClass(wager)}>{formatActivityWagerPerformance(wager)}</td></tr>; })}
      </tbody>)}
    </table></div>}
  </section>;
}

/** One chip per market, home-relative: the spread and moneyline from the home side, the total as an O/U number. */
export function MatchupLines({ lines }: { lines?: EspnBoxScore["lines"] }) {
  const game = groupBoardByEvent(lines ?? [])[0];
  if (!game) return null;
  const chips: Array<{ key: string; text: string }> = [];
  const spread = game.markets.spread.home ?? game.markets.spread.away;
  if (spread) chips.push({ key: "spread", text: spread.label });
  const total = game.markets.total.over ?? game.markets.total.under;
  if (total) chips.push({ key: "total", text: `O/U ${total.odds}` });
  const moneyline = game.markets.moneyline.home;
  if (moneyline) chips.push({ key: "moneyline", text: moneyline.label });
  if (!chips.length) return null;
  return <p className="matchup-lines" aria-label="Board lines">{chips.map((chip) => <span key={chip.key} className="matchup-line">{chip.text}</span>)}</p>;
}

/** The live/final view: state banner, quarter breakdown, and team stats. */
export function MatchupBoxScore({ box }: { box: EspnBoxScore }) {
  const live = box.state === "live";
  return <article className="matchup-details matchup-box">
    <header className="matchup-details-header"><p className="pool-context">ESPN box score</p>
      <div className="matchup-box-scoreline">
        <div className="matchup-box-team">{box.possession === "away" && <span className="matchup-box-possession" title="Possession" aria-label="Possession">🏈</span>}<span className="matchup-box-team-name">{box.away.name}</span>{box.away.logo && <img src={box.away.logo} alt="" width="24" height="24"/>}<strong className="matchup-box-points">{box.away.score ?? "—"}</strong></div>
        <div className="matchup-box-team">{box.possession === "home" && <span className="matchup-box-possession" title="Possession" aria-label="Possession">🏈</span>}<span className="matchup-box-team-name">{box.home.name}</span>{box.home.logo && <img src={box.home.logo} alt="" width="24" height="24"/>}<strong className="matchup-box-points">{box.home.score ?? "—"}</strong></div>
      </div>
      <p className="matchup-box-state" role="status">{box.statusDetail}{live && box.downDistance ? ` · ${box.downDistance}` : ""}</p>
    </header>
    {box.quarters.length > 0 && <section aria-label="Scoring by quarter" className="table-ribbon-section"><h2 className="table-ribbon">Scoring by quarter</h2>
      <div className="table-scroll" tabIndex={0}><table className="activity-table matchup-stats matchup-box-quarters"><thead><tr><th scope="col"><span className="visually-hidden">Team</span></th>{box.quarters.map((quarter) => <th key={quarter.label} scope="col">{quarter.label}</th>)}</tr></thead><tbody>
        <tr><th scope="row">{box.away.name}</th>{box.quarters.map((quarter) => <td key={quarter.label}>{quarter.away ?? ""}</td>)}</tr>
        <tr><th scope="row">{box.home.name}</th>{box.quarters.map((quarter) => <td key={quarter.label}>{quarter.home ?? ""}</td>)}</tr>
      </tbody></table></div>
    </section>}
    {box.stats.length > 0 && <section aria-label="Team stats" className="table-ribbon-section"><h2 className="table-ribbon">Team stats</h2>
      <div className="table-scroll" tabIndex={0}><table className="activity-table matchup-stats"><thead><tr><th scope="col"><span className="visually-hidden">Stat</span></th><th scope="col">{box.away.name}</th><th scope="col">{box.home.name}</th></tr></thead><tbody>{box.stats.map((stat) => <tr key={stat.label}><th scope="row">{stat.label}</th><td>{stat.away ?? "—"}</td><td>{stat.home ?? "—"}</td></tr>)}</tbody></table></div>
    </section>}
  </article>;
}

/** Side-by-side ESPN facts stay readable when an upstream field is unavailable. */
export function MatchupDetails({ matchup, lines }: { matchup: EspnMatchupResponse; lines?: EspnBoxScore["lines"] }) {
  const teams = [matchup.away, matchup.home] as const;
  return <article className="matchup-details">
    <header className="matchup-details-header"><p className="pool-context">ESPN matchup details</p><h1>{matchup.away.name} at {matchup.home.name}</h1><p><strong>Kickoff:</strong> <time dateTime={matchup.startsAt}>{formatKickoff(matchup.startsAt)}</time>{matchup.venue && <> · {matchup.venue}</>}</p><MatchupLines lines={lines}/></header>
    <section aria-label="Team records" className="table-ribbon-section"><h2 className="table-ribbon">Team records</h2>
      <div className="matchup-team-records">{teams.map((team) => <div key={team.name} className="matchup-team-record"><h3 className="matchup-team-ribbon"><span>{team.name}</span>{team.logo && <img src={team.logo} alt="" width="24" height="24"/>}</h3><p><strong>Record:</strong> {team.record ?? "Not available"}</p></div>)}</div>
    </section>
    <section aria-label="Season team stats" className="table-ribbon-section"><h2 className="table-ribbon">Season team stats</h2>{matchup.seasonStats.length > 0 ? <div className="table-scroll" tabIndex={0}><table className="activity-table matchup-stats"><thead><tr><th scope="col"><span className="visually-hidden">Stat</span></th><th scope="col">{matchup.away.name}</th><th scope="col">{matchup.home.name}</th></tr></thead><tbody>{matchup.seasonStats.map((stat) => <tr key={stat.label}><th scope="row">{stat.label}</th><td>{stat.away ?? "—"}</td><td>{stat.home ?? "—"}</td></tr>)}</tbody></table></div> : <p className="state-notice">Season team stats are not available from ESPN yet.</p>}</section>
    <section aria-label="Recent results" className="table-ribbon-section"><h2 className="table-ribbon">Recent results</h2>
      <div className="matchup-recent-results">{teams.map((team) => <section key={team.name} className="matchup-recent-team"><h3 className="matchup-team-ribbon"><span>{team.name}</span></h3>{team.recentResults.length > 0 ? <ul>{team.recentResults.map((result) => <li key={`${result.date}-${result.opponent}`}><time dateTime={result.date}>{formatKickoff(result.date)}</time> · {result.result} vs {result.opponent}</li>)}</ul> : <p>Recent results are not available.</p>}</section>)}</div>
    </section>
  </article>;
}

/** A started game always has a view: box state outranks a pregame-details failure. */
export type MatchupPageView = { kind: "box"; box: EspnBoxScore } | { kind: "error" } | { kind: "loading" } | { kind: "details"; matchup: EspnMatchupResponse };
export const matchupPageView = (state: { error: string; box?: EspnBoxScore; matchup?: EspnMatchupResponse }): MatchupPageView => {
  if (state.box && state.box.state !== "pregame") return { kind: "box", box: state.box };
  if (state.error) return { kind: "error" };
  if (!state.matchup) return { kind: "loading" };
  return { kind: "details", matchup: state.matchup };
};

/** An in-app detail route leaves the odds page's pool-scoped selection tray intact in browser storage. */
export function MatchupDetailsPage() {
  const { slug = "", eventId = "" } = useParams();
  const [matchup, setMatchup] = useState<EspnMatchupResponse>(); const [box, setBox] = useState<EspnBoxScore>(); const [exposure, setExposure] = useState<PoolExposureResponse>(); const [error, setError] = useState("");
  useEffect(() => {
    let active = true; setMatchup(undefined); setBox(undefined); setExposure(undefined); setError("");
    void api.matchup(slug, eventId).then((loaded) => { if (active) setMatchup(loaded); }).catch((reason) => { if (active) setError(matchupUnavailableMessage(reason)); });
    void api.matchupBox(slug, eventId).then((loaded) => { if (active) setBox(loaded); }).catch(() => { if (active) setBox(undefined); });
    return () => { active = false; };
  }, [slug, eventId]);
  /** Started games reveal every member's legs, so exposure is complete; live games refresh it on the box cadence. */
  const started = box !== undefined && box.state !== "pregame";
  useEffect(() => {
    let active = true;
    if (!started) return;
    const load = () => { void api.matchupExposure(slug, eventId).then((loaded) => { if (active) setExposure(loaded); }).catch(() => undefined); };
    load();
    if (box?.state !== "live") return () => { active = false; };
    const timer = setInterval(load, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [started, box?.state, slug, eventId]);
  /** Live games refresh at the box cache's one-minute staleness budget; final and pregame states do not poll. */
  useEffect(() => {
    if (box?.state !== "live") return;
    const timer = setInterval(() => { void api.matchupBox(slug, eventId).then(setBox).catch(() => undefined); }, 60_000);
    return () => { clearInterval(timer); };
  }, [box?.state, slug, eventId]);
  const back = <p className="matchup-details-back"><Link to={`/p/${slug}/odds`}>Back to odds board</Link></p>;
  const view = matchupPageView({ error, box, matchup });
  if (view.kind === "error") return <Layout><h1>Matchup details</h1><p role="alert" className="error-summary">{error}</p>{back}</Layout>;
  if (view.kind === "box") return <Layout><MatchupBoxScore box={view.box}/><PoolExposure wagers={exposure?.wagers ?? []} slug={slug}/>{back}</Layout>;
  if (view.kind === "loading") return <Layout><h1>Matchup details</h1><p role="status">Loading matchup details…</p>{back}</Layout>;
  return <Layout><MatchupDetails matchup={view.matchup} lines={box?.lines}/>{back}</Layout>;
}

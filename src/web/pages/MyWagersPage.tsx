import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { formatMicros, parseIntegerText } from "../../domain/fixed-point";
import { activityWagerPerformanceClass, formatActivityLeg, formatActivityStake, formatActivityWagerPerformance } from "../activity-presentation";
import { displayWagerStartTimes, sortWagersByStartTime, ticketReturns } from "../wager-presentation";

type Wager = import("../../contracts/http").ReadMyWagers["wagers"][number];

const shares = (value: string) => formatMicros(parseIntegerText(value), 2);

function WagerLines({ wager }: { wager: Wager }) {
  const legs = wager.legs ?? [];
  return <div className="wager-legs">{legs.map((leg: any) => {
    const line = formatActivityLeg(leg);
    const gradeClass = leg.grade === "loss" ? "activity-leg-loss" : leg.grade === "win" ? "activity-leg-win" : "activity-leg-neutral";
    return <span key={`${leg.eventId}:${leg.market}:${leg.selection}`} className={gradeClass}>{line.segments.map((segment, index) => segment.selected ? <strong key={index}>{segment.text}</strong> : <span key={index}>{segment.text}</span>)}</span>;
  })}</div>;
}

function Staked({ wager }: { wager: Wager }) {
  const stake = formatActivityStake(wager);
  return stake ? <span className="activity-staked">{stake.amount} <small className="activity-staked-odds">{stake.odds}</small></span> : null;
}

function WagerStartTimes({ wager }: { wager: Wager }) {
  return <div className="wager-legs wager-start-times">{displayWagerStartTimes(wager).map((start, index) => <span className="wager-start-time" key={index}>{start}</span>)}</div>;
}

function WagerRows({ wager }: { wager: Wager }) {
  const payout = wager.status === "open" ? ticketReturns(wager.riskMicros, wager.acceptedOdds).total : shares(wager.returnMicros);
  return <tr><td><WagerStartTimes wager={wager}/></td><td><WagerLines wager={wager}/></td><td><Staked wager={wager}/></td><td>{payout}</td><td className={activityWagerPerformanceClass(wager)}>{formatActivityWagerPerformance(wager)}</td></tr>;
}

export function MyWagersPage() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<import("../../contracts/http").ReadMyWagers>();
  const [error, setError] = useState("");
  useEffect(() => { void api.wagers(slug).then(setData).catch((e) => setError(errorMessage(e))); }, [slug]);
  if (error) return <Layout signedIn><p role="alert" tabIndex={-1} className="error-summary">{error}</p><Link to={`/p/${slug}/odds`}>Return to games</Link></Layout>;
  if (!data) return <Layout signedIn><p role="status">Loading bets…</p></Layout>;
  const open = sortWagersByStartTime(data.wagers.filter((w) => w.status === "open"));
  const settled = sortWagersByStartTime(data.wagers.filter((w) => w.status !== "open"));
  const table = (title: string, rows: Wager[]) => <section className="activity-member-section"><h2 className="activity-member-ribbon">{title}</h2>{rows.length ? <div className="table-scroll" tabIndex={0}><table className="activity-table"><colgroup><col className="activity-start-column"/><col className="activity-wager-column"/><col className="activity-staked-column"/><col className="activity-payout-column"/><col className="activity-pnl-column"/></colgroup><thead><tr><th>Start</th><th>Wager</th><th>Staked</th><th>Payout</th><th>P&amp;L</th></tr></thead><tbody>{rows.map((w: any) => <WagerRows key={w.wagerId} wager={w} />)}</tbody></table></div> : <p>No {title.toLowerCase()}.</p>}</section>;
  return <Layout signedIn><div className="my-wagers-page"><h1>My Bets</h1><p>Bets cannot be canceled after placement.</p>{table("Open bets", open)}{table("Settled bets", settled)}<Link to={`/p/${slug}/odds`}>Return to games</Link></div></Layout>;
}

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { formatMicros, parseIntegerText } from "../../domain/fixed-point";
import { activityLegTimingClass, activitySelectedOutcomeClass, activityWagerPerformanceClass, formatActivityLeg, formatActivityStake, formatActivityWagerPerformance } from "../activity-presentation";
import { displayWagerStartTimes, sortWagersByStartTime, ticketReturns } from "../wager-presentation";

type Wager = import("../../contracts/http").ReadMyWagers["wagers"][number];

const shares = (value: string) => formatMicros(parseIntegerText(value), 2);

function WagerLines({ wager }: { wager: Wager }) {
  const legs = wager.legs ?? [];
  return <div className="wager-legs">{legs.map((leg: any) => {
    const line = formatActivityLeg(leg);
    return <span key={`${leg.eventId}:${leg.market}:${leg.selection}`} className={activityLegTimingClass(leg)}>{line.segments.map((segment, index) => segment.selected ? <strong key={index} className={activitySelectedOutcomeClass(wager)}>{segment.text}</strong> : <span key={index}>{segment.text}</span>)}</span>;
  })}</div>;
}

function Staked({ wager }: { wager: Wager }) {
  const stake = formatActivityStake(wager);
  return stake ? <span className="activity-staked">{stake.amount} <small className="activity-staked-odds">{stake.odds}</small></span> : null;
}

function WagerStartTimes({ wager }: { wager: Wager }) {
  return <div className="wager-legs">{displayWagerStartTimes(wager).map((start, index) => <span key={index}>{start}</span>)}</div>;
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
  const table = (title: string, rows: Wager[]) => <section><h2>{title}</h2>{rows.length ? <div className="table-scroll" tabIndex={0}><table><caption>{title}</caption><thead><tr><th>Start</th><th>Wager</th><th>Staked</th><th>Payout</th><th>P&amp;L</th></tr></thead><tbody>{rows.map((w: any) => <WagerRows key={w.wagerId} wager={w} />)}</tbody></table></div> : <p>No {title.toLowerCase()}.</p>}</section>;
  return <Layout signedIn><div className="my-wagers-page"><p>Bets cannot be canceled after placement.</p>{table("Open bets", open)}{table("Settled bets", settled)}<Link to={`/p/${slug}/odds`}>Return to games</Link></div></Layout>;
}

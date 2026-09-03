import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { formatMicros, parseIntegerText } from "../../domain/fixed-point";
import { formatAmericanOdds } from "../odds-format";
import { formatActivityPerformance } from "../activity-presentation";
import { displayWagerStartTime, sortWagersByStartTime, ticketReturns } from "../wager-presentation";

const shares = (value: string) => formatMicros(parseIntegerText(value), 2);
const signed = (value: number) => `${value > 0 ? "+" : ""}${value}`;
const teaserAdjustment = (leg: any) => {
  const original = Number(leg.originalLine);
  const adjusted = Number(leg.adjustedLine);
  return Number.isFinite(original) && Number.isFinite(adjusted) && adjusted !== original ? ` (${signed(adjusted - original)})` : "";
};

function pickLabel(leg: any) {
  const line = leg.adjustedLine ?? leg.originalLine;
  if (leg.market === "total") return `${leg.selection === "over" ? "O" : "U"}${line ?? ""}${teaserAdjustment(leg)}`;
  const team = leg.selection === "away" ? leg.awayTeam : leg.homeTeam;
  return `${team ?? leg.selection}${line !== undefined && line !== null ? ` ${signed(line)}` : ` ${formatAmericanOdds(leg.originalOdds)}`}${teaserAdjustment(leg)}`;
}

export function WagerRows({ wager }: { wager: any }) {
  const payout = wager.status === "open" ? ticketReturns(wager.riskMicros, wager.acceptedOdds).total : shares(wager.returnMicros);
  const legs = wager.legs ?? [];
  return <tr><td>{displayWagerStartTime(wager)}</td><td><div className="wager-legs">{legs.map((leg: any, index: number) => <span key={`${leg.eventId}-${leg.market}-${leg.selection}`}>{leg.awayTeam && leg.homeTeam ? `${leg.awayTeam} at ${leg.homeTeam}` : "—"}{index < legs.length - 1 && <br />}</span>)}</div></td><td><div className="wager-legs">{legs.map((leg: any, index: number) => <span key={`${leg.eventId}-${leg.market}-${leg.selection}`}>{pickLabel(leg)}{index < legs.length - 1 && <br />}</span>)}</div></td><td>{formatActivityPerformance(wager.performanceMicros)}</td><td>{shares(wager.riskMicros)}</td><td>{payout}{wager.outcome && <small><br />{wager.outcome}</small>}</td></tr>;
}

export function MyWagersPage() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<any>();
  const [error, setError] = useState("");
  useEffect(() => { void api.wagers(slug).then(setData).catch((e) => setError(errorMessage(e))); }, [slug]);
  if (error) return <Layout signedIn><h1>My wagers</h1><p role="alert" tabIndex={-1} className="error-summary">{error}</p><Link to={`/p/${slug}/odds`}>Return to games</Link></Layout>;
  if (!data) return <Layout signedIn><h1>My wagers</h1><p role="status">Loading bets…</p></Layout>;
  const open = sortWagersByStartTime(data.wagers.filter((w: any) => w.status === "open"));
  const settled = sortWagersByStartTime(data.wagers.filter((w: any) => w.status !== "open"));
  const table = (title: string, rows: any[]) => <section><h2>{title}</h2>{rows.length ? <div className="table-scroll" tabIndex={0}><table><caption>{title}</caption><thead><tr><th>Start</th><th>Matchup</th><th>Pick</th><th>P&amp;L</th><th>Risk</th><th>Payout</th></tr></thead><tbody>{rows.map((w: any) => <WagerRows key={w.wagerId} wager={w} />)}</tbody></table></div> : <p>No {title.toLowerCase()}.</p>}</section>;
  return <Layout signedIn><div className="my-wagers-page"><h1>My wagers</h1><p>Bets cannot be canceled after placement.</p>{table("Open bets", open)}{table("Settled bets", settled)}<Link to={`/p/${slug}/odds`}>Return to games</Link></div></Layout>;
}

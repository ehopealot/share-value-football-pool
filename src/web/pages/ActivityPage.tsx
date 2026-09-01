import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { formatAmericanOdds } from "../odds-format";
type Wager = import("../../contracts/http").ReadActivity["activity"]["wagers"][number];
const teaserAdjustment = (leg: NonNullable<Wager["legs"]>[number]) => {
  const original = Number(leg.originalLine); const adjusted = Number(leg.adjustedLine);
  return Number.isFinite(original) && Number.isFinite(adjusted) && adjusted !== original ? ` (${adjusted - original > 0 ? "+" : ""}${adjusted - original})` : "";
};

function pick(leg: NonNullable<Wager["legs"]>[number]) {
  const line = leg.adjustedLine ?? leg.originalLine;
  if (leg.market === "total") return `${leg.selection === "over" ? "O" : "U"}${line ?? ""}${teaserAdjustment(leg)}`;
  const team = leg.selection === "away" ? leg.awayTeam : leg.homeTeam;
  if (line !== undefined) return `${team ?? leg.selection} ${line.startsWith("-") ? "" : "+"}${line}${teaserAdjustment(leg)}`;
  return `${team ?? leg.selection} ${formatAmericanOdds(leg.originalOdds)}${teaserAdjustment(leg)}`;
}

function memberWagers(wagers: Wager[]) {
  const groups = new Map<string, { name: string; wagers: Wager[] }>();
  for (const wager of wagers) {
    const group = groups.get(wager.memberId) ?? { name: wager.memberDisplayName, wagers: [] };
    group.wagers.push(wager);
    groups.set(wager.memberId, group);
  }
  return [...groups.entries()];
}

export function ActivityPage() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<import("../../contracts/http").ReadActivity>();
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { void api.activity(slug).then(setData).catch((e) => setError(errorMessage(e))); }, [slug]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  if (error) return <Layout signedIn><h1>Activity</h1><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{error} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
  if (!data) return <Layout><p role="status">Loading activity…</p></Layout>;
  return <Layout signedIn><div className="activity-page"><h1>Activity</h1>
    <section><h2>Bets</h2>{data.activity.wagers.length ? memberWagers(data.activity.wagers).map(([memberId, group]) => <section key={memberId}><h3>{group.name}</h3><div className="table-scroll" tabIndex={0}><table><thead><tr><th>Matchup</th><th>Pick</th><th>Status</th></tr></thead><tbody>{group.wagers.map((wager) => wager.legs?.length ? <tr key={wager.wagerId}><td><div className="wager-legs">{wager.legs.map((leg, index) => <span key={`${leg.eventId}:${leg.market}:${leg.selection}`}>{leg.awayTeam && leg.homeTeam ? `${leg.awayTeam} at ${leg.homeTeam}` : "—"}{index < (wager.legs?.length ?? 0) - 1 && <br />}</span>)}</div></td><td><div className="wager-legs">{wager.legs.map((leg, index) => <span key={`${leg.eventId}:${leg.market}:${leg.selection}`}>{pick(leg)}{index < (wager.legs?.length ?? 0) - 1 && <br />}</span>)}</div></td><td>{wager.outcome ?? (wager.status === "open" ? "Open" : wager.status)}</td></tr> : <tr key={wager.wagerId}><td colSpan={2}>Selection hidden until the game starts.</td><td>{wager.status === "open" ? "Open" : wager.status}</td></tr>)}</tbody></table></div></section>) : <p>No bets yet.</p>}</section>
    <Link to={`/p/${slug}/overview`}>Pool home</Link>
  </div></Layout>;
}

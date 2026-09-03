import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { formatActivityLeg, formatActivityPerformance, formatActivityWagerPerformance, groupActivityMembersForWeek } from "../activity-presentation";
import { weekNumberLabel } from "../../domain/betting-week";
import { displayWagerStartTime } from "../wager-presentation";

type Wager = import("../../contracts/http").ReadActivity["activity"]["wagers"][number];
type Leg = NonNullable<Wager["legs"]>[number];

const wagerResult = (wager: Wager) => wager.outcome ?? (wager.status === "open" ? "Open" : wager.status);

function WagerLines({ legs }: { legs: Leg[] | undefined }) {
  if (!legs?.length) return <>Selection hidden until the game starts.</>;
  return <div className="activity-wager-lines">{legs.map((leg) => {
    const line = formatActivityLeg(leg);
    return <span key={`${leg.eventId}:${leg.market}:${leg.selection}`}>{line.segments.map((segment, index) => segment.selected ? <strong key={index}>{segment.text}</strong> : <span key={index}>{segment.text}</span>)}</span>;
  })}</div>;
}

export function ActivityPage() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<import("../../contracts/http").ReadActivity>();
  const [selectedWeek, setSelectedWeek] = useState("");
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { void api.activity(slug).then(setData).catch((e) => setError(errorMessage(e))); }, [slug]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  if (error) return <Layout signedIn><h1>Activity</h1><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{error} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
  if (!data) return <Layout><p role="status">Loading activity…</p></Layout>;
  const weeks = [...new Set(data.activity.wagers.map((wager) => wager.weekStart))].sort().reverse();
  const week = weeks.includes(selectedWeek) ? selectedWeek : weeks[0];
  const members = week ? groupActivityMembersForWeek(data.activity.wagers, week) : [];
  return <Layout signedIn><div className="activity-page"><h1>Activity</h1>
    <section><h2>Bets</h2>{weeks.length ? <><label>Week <select value={week} onChange={(event) => setSelectedWeek(event.target.value)}>{weeks.map((start) => <option key={start} value={start}>{weekNumberLabel(start)}</option>)}</select></label>
      <div className="table-scroll" tabIndex={0}><table className="activity-table"><thead><tr><th>Member</th><th>Start</th><th>Wager</th><th>Result</th><th>P&amp;L</th></tr></thead><tbody>{members.flatMap((member) => member.wagers.map((wager, index) => <tr key={wager.wagerId}>{index === 0 && <th scope="rowgroup" rowSpan={member.wagers.length}>{member.memberDisplayName}{formatActivityPerformance(member.performanceMicros) && <small>{formatActivityPerformance(member.performanceMicros)}</small>}</th>}<td>{displayWagerStartTime(wager)}</td><td><WagerLines legs={wager.legs}/></td><td>{wagerResult(wager)}</td><td>{formatActivityWagerPerformance(wager)}</td></tr>))}</tbody></table></div></> : <p>No bets yet.</p>}</section>
    <Link to={`/p/${slug}/overview`}>Pool home</Link>
  </div></Layout>;
}

import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { activityWagerPerformanceClass, formatActivityLeg, formatActivityPerformance, formatActivityStake, formatActivityWagerPerformance, groupActivityMembersForWeek } from "../activity-presentation";
import { weekNumberLabel } from "../../domain/betting-week";
import { displayWagerStartTimes } from "../wager-presentation";

type Wager = import("../../contracts/http").ReadActivity["activity"]["wagers"][number];
type Leg = NonNullable<Wager["legs"]>[number];

export function WagerLines({ wager }: { wager: Wager }) {
  if (!wager.legs?.length) return <>Selection hidden until the game starts.</>;
  return <div className="activity-wager-lines">{wager.legs.map((leg) => {
    const line = formatActivityLeg(leg);
    const gradeClass = leg.grade === "loss" ? "activity-leg-loss" : leg.grade === "win" ? "activity-leg-win" : "activity-leg-neutral";
    return <span key={`${leg.eventId}:${leg.market}:${leg.selection}`} className={gradeClass}>{line.segments.map((segment, index) => segment.selected ? <strong key={index}>{segment.text}</strong> : <span key={index}>{segment.text}</span>)}</span>;
  })}</div>;
}

function Staked({ wager }: { wager: Wager }) {
  const stake = formatActivityStake(wager);
  return stake ? <span className="activity-staked">{stake.amount}{stake.odds && <> <small className="activity-staked-odds">{stake.odds}</small></>}</span> : null;
}

function WagerStartTimes({ wager }: { wager: Wager }) {
  return <div className="activity-wager-lines">{displayWagerStartTimes(wager).map((start, index) => <span key={index}>{start}</span>)}</div>;
}

export function MemberActivitySection({ member }: { member: ReturnType<typeof groupActivityMembersForWeek>[number] }) {
  const performance = formatActivityPerformance(member.performanceMicros);
  return <section className="activity-member-section"><h3 className="activity-member-ribbon">{member.memberDisplayName}{performance && <small>{performance}</small>}</h3><div className="table-scroll" tabIndex={0}><table className="activity-table"><thead><tr><th>Start</th><th>Wager</th><th>Staked</th><th>P&amp;L</th></tr></thead><tbody>{member.wagers.map((wager) => <tr key={wager.wagerId}><td><WagerStartTimes wager={wager}/></td><td><WagerLines wager={wager}/></td><td><Staked wager={wager}/></td><td className={activityWagerPerformanceClass(wager)}>{formatActivityWagerPerformance(wager)}</td></tr>)}</tbody></table></div></section>;
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
    <section><h2>Bets</h2>{weeks.length ? <><label>Week <select value={week} onChange={(event) => setSelectedWeek(event.target.value)}>{weeks.map((start) => <option key={start} value={start}>{weekNumberLabel(start)}</option>)}</select></label>{members.map((member) => <MemberActivitySection key={member.memberId} member={member} />)}</> : <p>No bets yet.</p>}</section>
    <Link to={`/p/${slug}/overview`}>Pool home</Link>
  </div></Layout>;
}

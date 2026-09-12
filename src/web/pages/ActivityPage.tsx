import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { activityWagerPerformanceClass, filterActivityDaysForActiveGames, formatActivityPerformance, formatActivityStake, formatActivityWagerPerformance, groupActivityDaysForWeek, groupActivityMembers, groupActivityMembersForWeek, hasActiveActivityGame } from "../activity-presentation";
import { weekNumberLabel, weekStartOf } from "../../domain/betting-week";
import { ALL_WEEKS_VALUE, selectedWeekOrCurrent, wagerWeekOptions } from "../week-picker-presentation";
import { displayWagerDateLabel, displayWagerStartTimeOnly, displayWagerStartTimes, sortWagerLegsByStartTime, sortWagersByAnchorTime, sortWagersByStartTime } from "../wager-presentation";
import { useCompactWagerViewport } from "../mobile-viewport";
import { WagerLine } from "../components/WagerLine";
import { MatchupLegLink } from "../components/MatchupLegLink";

type Wager = import("../../contracts/http").ReadActivity["activity"]["wagers"][number];

export function WagerLines({ wager, slug = "" }: { wager: Wager; slug?: string }) {
  const legs = sortWagerLegsByStartTime(wager.legs ?? []);
  if (!legs.length) return <>Selection hidden until game time.</>;
  return <div className="activity-wager-lines">{legs.map((leg) => <MatchupLegLink key={`${leg.eventId}:${leg.market}:${leg.selection}`} slug={slug} leg={leg}><WagerLine leg={leg}/></MatchupLegLink>)}</div>;
}

function Staked({ wager }: { wager: Wager }) {
  const stake = formatActivityStake(wager);
  return stake ? <span className="activity-staked">{stake.amount}{stake.odds && <> <small className="activity-staked-odds">{stake.odds}</small></>}</span> : null;
}

function WagerRows({ wager, dayAnchorStartsAt, slug = "" }: { wager: Wager; dayAnchorStartsAt?: string; slug?: string }) {
  const legs = sortWagerLegsByStartTime(wager.legs ?? []);
  const hiddenLegCount = wager.hiddenLegCount ?? 0;
  const rowCount = legs.length + (hiddenLegCount > 0 ? 1 : 0);
  const starts = displayWagerStartTimes(wager);
  const mobileStarts = displayWagerStartTimeOnly(wager, dayAnchorStartsAt);
  const legRowClass = (index: number) => [index > 0 && "activity-wager-leg-row", index < rowCount - 1 && "activity-wager-leg-row-leading"].filter(Boolean).join(" ") || undefined;
  if (!legs.length) return <tr><td></td><td><WagerLines wager={wager} slug={slug}/></td><td><Staked wager={wager}/></td><td className={activityWagerPerformanceClass(wager)}>{formatActivityWagerPerformance(wager)}</td></tr>;
  return <>{legs.map((leg, index) => <tr key={`${wager.wagerId}:${leg.eventId}:${leg.market}:${leg.selection}:${index}`} className={legRowClass(index)}><td><span className="wager-start-time">{starts[index]}</span><span className="wager-start-time-mobile">{mobileStarts[index]}</span></td><td><MatchupLegLink slug={slug} leg={leg}><WagerLine leg={leg}/></MatchupLegLink></td>{index === 0 && <><td rowSpan={rowCount}><Staked wager={wager}/></td><td className={activityWagerPerformanceClass(wager)} rowSpan={rowCount}>{formatActivityWagerPerformance(wager)}</td></>}</tr>)}{hiddenLegCount > 0 && <tr className={legRowClass(legs.length)}><td></td><td><span className="activity-leg-neutral">{hiddenLegCount} other selection{hiddenLegCount === 1 ? "" : "s"} hidden until game time.</span></td></tr>}</>;
}

export function MemberActivitySection({ member, title, slug = "" }: { member: ReturnType<typeof groupActivityMembersForWeek>[number]; title?: React.ReactNode; slug?: string }) {
  const compact = useCompactWagerViewport();
  // The mobile branch groups by kickoff-day anchor, so the section never relies on caller ordering.
  const wagers = compact ? sortWagersByAnchorTime(member.wagers) : sortWagersByStartTime(member.wagers);
  const performance = formatActivityPerformance(member.performanceMicros);
  return <section className="activity-member-section"><h3 className="activity-member-ribbon">{title ?? member.memberDisplayName}<small>{performance}</small></h3><div className="table-scroll" tabIndex={0}><table className="activity-table"><colgroup><col className="activity-start-column"/><col className="activity-wager-column"/><col className="activity-staked-column"/><col className="activity-pnl-column"/></colgroup><thead><tr><th>Start</th><th>Wager</th><th>Staked</th><th>P&amp;L</th></tr></thead><tbody>{wagers.flatMap((wager, index) => { const date = displayWagerDateLabel(wager); const showDate = index === 0 || date !== displayWagerDateLabel(wagers[index - 1]!); return [...(showDate ? [<tr className="wager-date-row" key={`${wager.wagerId}:date`}><th colSpan={4}>{date}</th></tr>] : []), <WagerRows key={wager.wagerId} wager={wager} slug={slug}/>]; })}</tbody></table></div></section>;
}

export function DayActivitySection({ day, memberProfilePath, slug = "" }: { day: ReturnType<typeof groupActivityDaysForWeek>[number]; memberProfilePath: (memberId: string) => string; slug?: string }) {
  return <section className="activity-day-section"><h3 className="activity-day-ribbon">{day.label}<small>Pool net {formatActivityPerformance(day.performanceMicros)}</small></h3><div className="table-scroll" tabIndex={0}><table className="activity-table"><colgroup><col className="activity-start-column"/><col className="activity-wager-column"/><col className="activity-staked-column"/><col className="activity-pnl-column"/></colgroup><thead><tr><th>Start</th><th>Wager</th><th>Staked</th><th>P&amp;L</th></tr></thead>{day.members.map((member) => <tbody key={member.memberId}><tr className="activity-day-member-ribbon"><th colSpan={4} scope="rowgroup"><span><Link to={memberProfilePath(member.memberId)}>{member.memberDisplayName}</Link><small>{formatActivityPerformance(member.performanceMicros)}</small></span></th></tr>{sortWagersByStartTime(member.wagers).map((wager) => <WagerRows key={wager.wagerId} wager={wager} dayAnchorStartsAt={day.startsAt} slug={slug}/>)}</tbody>)}</table></div></section>;
}

export function ActivityPage() {
  const { slug = "" } = useParams();
  // Keying the body by slug keeps profile links from ever pairing one pool's rows with another pool's route.
  return <ActivityPageBody key={slug} slug={slug}/>;
}

export function ActivityPageBody({ slug }: { slug: string }) {
  const [data, setData] = useState<import("../../contracts/http").ReadActivity>();
  const [selectedWeek, setSelectedWeek] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [groupByDay, setGroupByDay] = useState(false);
  const [error, setError] = useState("");
  const compact = useCompactWagerViewport();
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { void api.activity(slug).then(setData).catch((e) => setError(errorMessage(e))); }, [slug]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  if (error) return <Layout><h1>Activity</h1><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{error} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
  if (!data) return <Layout><p role="status">Loading activity…</p></Layout>;
  const currentWeek = weekStartOf(new Date()).toISOString();
  const weeks = wagerWeekOptions(data.activity.wagers.map((wager) => wager.weekStart), currentWeek);
  const week = selectedWeekOrCurrent(selectedWeek, weeks, currentWeek);
  const now = Date.now();
  // Group before filtering so ribbons retain the full selected period's member P&L.
  const weeklyMembers = groupActivityMembers(data.activity.wagers, week);
  const members = activeOnly ? weeklyMembers.map((member) => ({ ...member, wagers: member.wagers.filter((wager) => hasActiveActivityGame(wager, now)) })).filter((member) => member.wagers.length > 0) : weeklyMembers;
  // Derive daily P&L before filtering, as with the weekly member ribbons above.
  const weeklyDays = groupActivityDaysForWeek(data.activity.wagers, week, now);
  const days = activeOnly ? filterActivityDaysForActiveGames(weeklyDays, now) : weeklyDays;
  const controls = <><label className="activity-active-toggle"><input type="checkbox" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} /> Active games only</label><label className="activity-group-toggle"><input type="checkbox" checked={groupByDay} onChange={(event) => setGroupByDay(event.target.checked)} /> Group by day</label></>;
  return <Layout><div className="activity-page"><h1 className="visually-hidden">Activity</h1>
    <section><h2>All bets</h2>
      <div className="activity-filters">
        <label>Week <select value={week ?? ALL_WEEKS_VALUE} onChange={(event) => setSelectedWeek(event.target.value)}><option value={ALL_WEEKS_VALUE}>All weeks</option>{weeks.map((start) => <option key={start} value={start}>{weekNumberLabel(start)}</option>)}</select></label>
        {compact ? <details className="activity-options"><summary>Options</summary><div>{controls}</div></details> : controls}
      </div>
      {groupByDay ? days.length ? days.map((day) => <DayActivitySection key={day.key} day={day} memberProfilePath={(memberId) => `/p/${slug}/member/${memberId}`} slug={slug}/>) : <p role="status">There are no bets right now</p> : members.length ? members.map((member) => <MemberActivitySection key={member.memberId} member={member} slug={slug} title={<Link className="activity-member-link" to={`/p/${slug}/member/${member.memberId}`}>{member.memberDisplayName}</Link>} />) : <p role="status">There are no bets right now</p>}
    </section>
    <Link to={`/p/${slug}/overview`}>Pool home</Link>
  </div></Layout>;
}

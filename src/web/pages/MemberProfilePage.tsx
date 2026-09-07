import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { formatWeeklyPerformance } from "../activity-presentation";
import { formatPickRecord, pickRecord, profileWeekOptions, seasonPerformanceMicros, splitProfileWeekWagers } from "../profile-presentation";
import { weekNumberLabel, weekStartOf } from "../../domain/betting-week";
import { parseIntegerText } from "../../domain/fixed-point";
import { MemberActivitySection } from "./ActivityPage";

type Wager = import("../../contracts/http").ReadActivity["activity"]["wagers"][number];
type ActivityMember = Parameters<typeof MemberActivitySection>[0]["member"];

const sectionMember = (memberId: string, memberDisplayName: string, wagers: Wager[]): ActivityMember => ({
  memberId, memberDisplayName, performanceMicros: wagers.reduce((total, wager) => total + parseIntegerText(wager.performanceMicros), 0n).toString(), wagers
});

export function MemberProfilePage() {
  const { slug = "", memberId = "" } = useParams();
  const [activity, setActivity] = useState<import("../../contracts/http").ReadActivity>();
  const [view, setView] = useState<import("../../contracts/http").ReadPoolView>();
  const [selectedWeek, setSelectedWeek] = useState("");
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    void Promise.all([api.activity(slug), api.poolView(slug)]).then(([nextActivity, nextView]) => { setActivity(nextActivity); setView(nextView); }).catch((reason) => setError(errorMessage(reason)));
  }, [slug]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  if (error) return <Layout><h1>Member profile</h1><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{error} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
  if (!activity || !view) return <Layout><p role="status">Loading member profile…</p></Layout>;
  const member = view.members.find((entry) => entry.memberId === memberId);
  if (!member) return <Layout><h1>Member profile</h1><p role="alert" className="error-summary">That member is not part of this pool. <Link to={`/p/${slug}/standings`}>Return to the standings</Link>.</p></Layout>;

  const now = new Date();
  const activeSeason = view.activeSeason;
  const seasonWagers = activeSeason ? activity.activity.wagers.filter((wager) => wager.memberId === memberId && wager.seasonId === activeSeason.id) : [];
  const weeks = profileWeekOptions(seasonWagers.map((wager) => wager.weekStart), now);
  const currentWeek = weekStartOf(now).toISOString();
  const week = weeks.includes(selectedWeek) ? selectedWeek : weeks.includes(currentWeek) ? currentWeek : weeks[0];
  const { inProcess, settled, unstarted } = splitProfileWeekWagers(week ? seasonWagers.filter((wager) => wager.weekStart === week) : [], now);
  const typeRecord = (type: Wager["type"]) => formatPickRecord(pickRecord(seasonWagers.filter((wager) => wager.type === type)));

  return <Layout><div className="member-profile-page">
    <h1>{member.displayName}</h1>
    <p className="pool-context">{activeSeason ? `${activeSeason.label} · ` : ""}{member.role === "commissioner" ? "Commissioner" : "Member"}</p>
    {activeSeason ? <>
      <section className="table-ribbon-section"><h2 className="table-ribbon">Season stats</h2><div className="table-scroll" tabIndex={0}><table><tbody>
        <tr><th scope="row">Season record</th><td>{formatPickRecord(pickRecord(seasonWagers))}</td></tr>
        <tr><th scope="row">Straight</th><td>{typeRecord("straight")}</td></tr>
        <tr><th scope="row">Teaser</th><td>{typeRecord("teaser")}</td></tr>
        <tr><th scope="row">Parlay</th><td>{typeRecord("parlay")}</td></tr>
        <tr><th scope="row">Season P&amp;L</th><td>{formatWeeklyPerformance(seasonPerformanceMicros(seasonWagers))}</td></tr>
      </tbody></table></div><p className="profile-record-note">Each bet counts as one pick. Refunded bets are not counted as wins or losses.</p></section>
      <section><h2>Bets</h2>{weeks.length ? <>
        <label>Week <select value={week} onChange={(event) => setSelectedWeek(event.target.value)}>{weeks.map((start) => <option key={start} value={start}>{weekNumberLabel(start)}</option>)}</select></label>
        {inProcess.length + settled.length > 0 ? <>
          {inProcess.length > 0 && <MemberActivitySection member={sectionMember(memberId, member.displayName, inProcess)} title="In process"/>}
          {settled.length > 0 && <MemberActivitySection member={sectionMember(memberId, member.displayName, settled)} title="Settled"/>}
        </> : unstarted.length > 0 ? <p className="state-notice">Selections not visible yet.</p> : <p className="state-notice">No bets this week.</p>}
      </> : <p className="state-notice">No bets yet this season.</p>}</section>
    </> : <p className="state-notice">No active season. Member profiles cover the active season.</p>}
    <p><Link to={`/p/${slug}/standings`}>Standings</Link> · <Link to={`/p/${slug}/overview`}>Pool home</Link></p>
  </div></Layout>;
}

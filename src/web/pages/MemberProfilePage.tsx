import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { formatWeeklyPerformance } from "../activity-presentation";
import { formatPickRecord, pickRecord, profileWeekOptions, seasonPerformanceMicros, splitProfileWeekWagers } from "../profile-presentation";
import { weekNumberLabel, weekStartOf } from "../../domain/betting-week";
import { parseIntegerText } from "../../domain/fixed-point";
import { ALL_WEEKS_VALUE, selectedWeekOrCurrent } from "../week-picker-presentation";
import { MemberActivitySection } from "./ActivityPage";

type Wager = import("../../contracts/http").ReadActivity["activity"]["wagers"][number];
type ActivityMember = Parameters<typeof MemberActivitySection>[0]["member"];

const sectionMember = (memberId: string, memberDisplayName: string, wagers: Wager[]): ActivityMember => ({
  memberId, memberDisplayName, performanceMicros: wagers.reduce((total, wager) => total + parseIntegerText(wager.performanceMicros), 0n).toString(), wagers
});

export function MemberProfilePage() {
  const { slug = "", memberId = "" } = useParams();
  // Keying the body by route identity gives each pool/member pair fresh state, so a
  // route change can never render one pool's data under another's links.
  return <MemberProfileBody key={`${slug}:${memberId}`} slug={slug} memberId={memberId}/>;
}

function MemberProfileBody({ slug, memberId }: { slug: string; memberId: string }) {
  const [activity, setActivity] = useState<import("../../contracts/http").ReadActivity>();
  const [view, setView] = useState<import("../../contracts/http").ReadPoolView>();
  const [selectedWeek, setSelectedWeek] = useState("");
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    // Route reuse across pool or member changes must not show stale data or keep old errors.
    let active = true;
    setActivity(undefined); setView(undefined); setError(""); setSelectedWeek("");
    void Promise.all([api.activity(slug), api.poolView(slug)]).then(([nextActivity, nextView]) => {
      if (!active) return;
      setActivity(nextActivity); setView(nextView);
    }).catch((reason) => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [slug, memberId]);
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
  // The selector always offers the current week, so stale selections fall back to it.
  const week = selectedWeekOrCurrent(selectedWeek, weeks, currentWeek);
  const selectedWagers = week === undefined ? seasonWagers : seasonWagers.filter((wager) => wager.weekStart === week);
  const { inProcess, settled, unstarted } = splitProfileWeekWagers(selectedWagers, now);
  const recordOf = (types: Wager["type"][]) => formatPickRecord(pickRecord(seasonWagers.filter((wager) => types.includes(wager.type))));

  return <Layout><div className="member-profile-page">
    <h1>{member.displayName}</h1>
    <p className="pool-context">{activeSeason ? `${activeSeason.label} · ` : ""}{member.role === "commissioner" ? "Commissioner" : "Member"}</p>
    {activeSeason ? <>
      <section className="table-ribbon-section"><h2 className="table-ribbon">Season stats</h2><div className="table-scroll" tabIndex={0}><table><tbody>
        <tr><th scope="row">Season record</th><td>{formatPickRecord(pickRecord(seasonWagers))}</td></tr>
        <tr><th scope="row">Straight</th><td>{recordOf(["straight"])}</td></tr>
        <tr><th scope="row">Teasers</th><td>{recordOf(["teaser"])}</td></tr>
        <tr><th scope="row">Parlays</th><td>{recordOf(["parlay"])}</td></tr>
        <tr><th scope="row">Season P&amp;L</th><td>{formatWeeklyPerformance(seasonPerformanceMicros(seasonWagers))}</td></tr>
      </tbody></table></div><p className="profile-record-note">Each bet counts as one pick. Refunded bets don't affect win-loss records.</p></section>
      <section><h2>Bets</h2>
        <label>Week <select value={week ?? ALL_WEEKS_VALUE} onChange={(event) => setSelectedWeek(event.target.value)}><option value={ALL_WEEKS_VALUE}>All weeks</option>{weeks.map((start) => <option key={start} value={start}>{weekNumberLabel(start)}</option>)}</select></label>
        {inProcess.length + settled.length > 0 ? <>
          {inProcess.length > 0 && <MemberActivitySection member={sectionMember(memberId, member.displayName, inProcess)} title="In process"/>}
          {settled.length > 0 && <MemberActivitySection member={sectionMember(memberId, member.displayName, settled)} title="Settled"/>}
        </> : unstarted.length > 0 ? <p className="state-notice">Selections not visible yet.</p> : <p className="state-notice">No bets{week === undefined ? "." : " this week."}</p>}</section>
    </> : <p className="state-notice">No active season. Member profiles cover the active season.</p>}
    <p><Link to={`/p/${slug}/standings`}>Standings</Link> · <Link to={`/p/${slug}/overview`}>Pool home</Link></p>
  </div></Layout>;
}

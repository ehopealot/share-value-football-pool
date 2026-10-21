import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { correctionEvents } from "../correction-results";
import { WagerCorrectionForm } from "../components/WagerCorrectionForm";
import { CorrectionWagerSummary } from "../components/CorrectionWagerSummary";
import { sortWagerLegsByStartTime } from "../wager-presentation";

export function AdminCorrectionsPage() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<import("../../contracts/http").ReadActivity>();
  const [view, setView] = useState<import("../../contracts/http").ReadPoolView>();
  const [audit, setAudit] = useState<import("../../contracts/http").AuditExportResponse>();
  const [selection, setSelection] = useState<{ wagerId: string; action: "void" | "regrade" }>();
  const [success, setSuccess] = useState("");
  const [loadError, setLoadError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const load = () => {
    void api.activity(slug).then(setData).catch((e) => setLoadError(errorMessage(e)));
    void api.poolView(slug).then(setView).catch((e) => setLoadError(errorMessage(e)));
    void api.auditExport(slug).then(setAudit).catch((e) => setLoadError(errorMessage(e)));
  };
  useEffect(load, [slug]);
  useEffect(() => { if (loadError) errorRef.current?.focus(); }, [loadError]);
  useEffect(() => { if (!selection) actionRef.current?.focus(); }, [selection]);
  if (loadError) return <Layout><h1>Wager corrections</h1><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{loadError} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
  if (!data || !view || !audit) return <Layout><p role="status">Loading corrections…</p></Layout>;
  if (view.currentMember.role !== "commissioner") return <Layout><h1>Wager corrections</h1><p role="alert" tabIndex={-1}>Only the commissioner can correct eligible active-season wagers.</p></Layout>;
  const eligibleWagers = view.activeSeason ? data.activity.wagers.filter((wager) => wager.seasonId === view.activeSeason?.id) : [];
  // Both reads are server-authorized. Prefer Activity's current projection, including hidden-leg counts.
  const historyWagers = new Map([...audit.wagers, ...data.activity.wagers].map((wager) => [wager.wagerId, wager]));
  const selectedWager = eligibleWagers.find(wager => wager.wagerId === selection?.wagerId);
  const open = (wagerId: string, action: "void" | "regrade", button: HTMLButtonElement) => {
    actionRef.current = button; setSuccess(""); setSelection({ wagerId, action });
  };
  return <Layout><div className="corrections-page"><h1>Wager corrections</h1><p>Void or regrade eligible active-season wagers with an audit reason. Corrections append immutable history.</p>
    {success && <p role="status">{success}</p>}
    <p>Select a wager below to enter a correction. Regrading is available after every game in the wager has started.</p>
    {eligibleWagers.length ? <section className="table-ribbon-section"><h2 className="table-ribbon">Eligible active-season wagers</h2><div className="table-scroll" tabIndex={0}><table aria-label="Eligible active-season wagers"><thead><tr><th>Owner</th><th>Wager</th><th>Status</th><th>Started event ID</th><th>League</th><th>Actions</th></tr></thead><tbody>{eligibleWagers.map((wager) => { const legs = wager.legs?.length ? sortWagerLegsByStartTime(wager.legs) : [undefined]; return <Fragment key={wager.wagerId}>{legs.map((leg, index) => <tr key={leg ? `${wager.wagerId}:${leg.eventId}:${index}` : wager.wagerId}>{index === 0 && <><th scope="row" rowSpan={legs.length}>{wager.memberDisplayName}</th><td rowSpan={legs.length}><CorrectionWagerSummary wager={wager}/></td><td rowSpan={legs.length}>{wager.status}</td></>}<td>{leg?.eventId ?? "Not started"}</td><td>{leg?.league ?? "—"}</td>{index === 0 && <td rowSpan={legs.length}><button disabled={!!selection} onClick={event => open(wager.wagerId, "void", event.currentTarget)}>Void</button> <button disabled={!!selection || !correctionEvents(wager).length} onClick={event => open(wager.wagerId, "regrade", event.currentTarget)}>Regrade</button></td>}</tr>)}</Fragment>; })}</tbody></table></div></section> : <p>No eligible active-season wagers are available for correction.</p>}
    {selection && selectedWager && <WagerCorrectionForm key={`${slug}:${selection.action}:${selection.wagerId}`} slug={slug} wager={selectedWager} action={selection.action} onCancel={() => setSelection(undefined)} onSuccess={() => {
      setSuccess(selection.action === "regrade" ? "Wager regraded. Correction saved to history." : "Wager voided. Correction saved to history.");
      setSelection(undefined); load();
    }} />}
    <section aria-label="Immutable correction history"><h2>Immutable correction history</h2>
      <section className="table-ribbon-section"><h3 className="table-ribbon">Settlements and reversals</h3>{audit.settlements.length ? <><p>Current wager details are shown for identification. Outcome and result version describe each immutable history entry.</p><div className="table-scroll" tabIndex={0}><table aria-label="Settlements and reversals"><thead><tr><th>Wager</th><th>Outcome</th><th>Result version</th><th>Reversal of</th><th>Reason</th></tr></thead><tbody>{audit.settlements.map((entry) => { const wager = historyWagers.get(entry.wagerId); return <tr key={entry.id}><td>{wager && <CorrectionWagerSummary wager={wager} showOwner/>}<small className="correction-wager-id">Wager ID: {entry.wagerId}</small></td><td>{entry.outcome}</td><td>{entry.resultVersion}</td><td>{entry.reversalOf ?? "—"}</td><td>{entry.reason ?? "Automatic settlement"}</td></tr>; })}</tbody></table></div></> : <p>No settlement history yet.</p>}</section>
      <h3>Correction reasons</h3>{audit.wagerCorrections.length ? <ul>{audit.wagerCorrections.map((entry) => <li key={entry.id}>{entry.wagerId}: {entry.reason}</li>)}</ul> : <p>No corrections yet.</p>}
    </section>
    <Link to={`/p/${slug}/overview`}>Pool home</Link></div></Layout>;
}

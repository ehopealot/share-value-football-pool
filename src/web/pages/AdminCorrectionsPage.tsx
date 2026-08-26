import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { useFrozenAdminCommand } from "../admin-command";

export function AdminCorrectionsPage() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<import("../../contracts/http").ReadActivity>();
  const [view, setView] = useState<import("../../contracts/http").ReadPoolView>();
  const [audit, setAudit] = useState<import("../../contracts/http").AuditExportResponse>();
  const [reason, setReason] = useState("");
  const [correctedResults, setCorrectedResults] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const correction = useFrozenAdminCommand<Record<string, unknown>>();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const load = () => {
    void api.activity(slug).then(setData).catch((e) => setLoadError(errorMessage(e)));
    void api.poolView(slug).then(setView).catch((e) => setLoadError(errorMessage(e)));
    void api.auditExport(slug).then(setAudit).catch((e) => setLoadError(errorMessage(e)));
  };
  useEffect(load, [slug]);
  useEffect(() => { if (error || loadError) errorRef.current?.focus(); }, [error, loadError]);
  if (loadError) return <Layout signedIn><h1>Wager corrections</h1><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{loadError} <Link to={`/p/${slug}/overview`}>Return to the pool overview</Link>.</p></Layout>;
  if (!data || !view || !audit) return <Layout><p role="status">Loading corrections…</p></Layout>;
  if (view.currentMember.role !== "commissioner") return <Layout signedIn><h1>Wager corrections</h1><p role="alert" tabIndex={-1}>Only the commissioner can correct eligible active-season wagers.</p></Layout>;
  const eligibleWagers = view.activeSeason ? data.activity.wagers.filter((wager) => wager.seasonId === view.activeSeason?.id) : [];
  const run = async (id: string, action: "void" | "regrade") => {
    if (!reason.trim()) return setError("Enter a correction reason.");
    setError("");
    try {
      let evidence: unknown;
      if (action === "regrade") {
        try { evidence = JSON.parse(correctedResults); }
        catch { return setError("Enter corrected result evidence as valid JSON."); }
      }
      await correction.run(`${action}:${id}`, () => action === "void"
        ? { reason, idempotencyKey: crypto.randomUUID() }
        : { reason, correctedResults: evidence, idempotencyKey: crypto.randomUUID() },
      (body) => api.command(slug, `/admin/corrections/${id}/${action}`, body));
      load();
    } catch (e) { setError(errorMessage(e)); }
  };
  const edit = () => { correction.retire(); setError(""); };
  return <Layout signedIn><h1>Wager corrections</h1><p>Void or regrade eligible active-season wagers with an audit reason. Corrections append immutable history.</p>
    {error && <p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{error}</p>}
    <label>Reason <input disabled={correction.pending} value={reason} onChange={(e) => { edit(); setReason(e.target.value); }} /></label>
    <label>Corrected event results <textarea disabled={correction.pending} value={correctedResults} onChange={(e) => { edit(); setCorrectedResults(e.target.value); }} placeholder='[{"eventId":"provider-event","league":"nfl","status":"final","homeScore":24,"awayScore":17,"correctionVersion":"official-2"}]' /></label>
    <p>Enter one public final, cancelled, or no-contest result for every wager event. The server applies the wager's immutable hidden terms and teaser rules.</p>
    {eligibleWagers.length ? <div className="table-scroll"><table><caption>Eligible active-season wagers</caption><thead><tr><th>Owner</th><th>Wager</th><th>Status</th><th>Started event ID</th><th>League</th><th>Actions</th></tr></thead><tbody>{eligibleWagers.map((wager) => { const legs = wager.legs?.length ? wager.legs : [undefined]; return <Fragment key={wager.wagerId}>{legs.map((leg, index) => <tr key={leg ? `${wager.wagerId}:${leg.eventId}:${index}` : wager.wagerId}>{index === 0 && <><th scope="row" rowSpan={legs.length}>{wager.memberDisplayName}</th><td rowSpan={legs.length}>{wager.type}</td><td rowSpan={legs.length}>{wager.status}</td></>}<td>{leg?.eventId ?? "Not started"}</td><td>{leg?.league ?? "—"}</td>{index === 0 && <td rowSpan={legs.length}><button disabled={!reason.trim() || correction.pending} onClick={() => void run(wager.wagerId, "void")}>Void with reason</button> <button disabled={!reason.trim() || correction.pending} onClick={() => void run(wager.wagerId, "regrade")}>Regrade with reason</button></td>}</tr>)}</Fragment>; })}</tbody></table></div> : <p>No eligible active-season wagers are available for correction.</p>}
    <section aria-label="Immutable correction history"><h2>Immutable correction history</h2>
      <h3>Settlements and reversals</h3>{audit.settlements.length ? <table><thead><tr><th>Wager</th><th>Outcome</th><th>Result version</th><th>Reversal of</th><th>Reason</th></tr></thead><tbody>{audit.settlements.map((entry) => <tr key={entry.id}><td>{entry.wagerId}</td><td>{entry.outcome}</td><td>{entry.resultVersion}</td><td>{entry.reversalOf ?? "—"}</td><td>{entry.reason ?? "Automatic settlement"}</td></tr>)}</tbody></table> : <p>No settlement history yet.</p>}
      <h3>Correction reasons</h3>{audit.wagerCorrections.length ? <ul>{audit.wagerCorrections.map((entry) => <li key={entry.id}>{entry.wagerId}: {entry.reason}</li>)}</ul> : <p>No corrections yet.</p>}
    </section>
    <Link to={`/p/${slug}/overview`}>Pool overview</Link></Layout>;
}

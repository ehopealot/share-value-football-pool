import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { microsFromDecimal } from "../../domain/fixed-point";
import { useFrozenAdminCommand } from "../admin-command";

type SuperBowlCandidate = NonNullable<NonNullable<import("../../contracts/http").ReadPoolView["activeSeason"]>["superBowlCandidate"]>;

export function SuperBowlClosureAcknowledgment({ candidate, pending, onConfirm }: { candidate: SuperBowlCandidate; pending: boolean; onConfirm: () => void }) {
  if (candidate.confirmedAt) return <p>Super Bowl candidate: {candidate.providerEventName}. Acknowledged: this is the season&apos;s Super Bowl. The season will close automatically once the game is final and all wagers are resolved.</p>;
  return <p>Super Bowl candidate: {candidate.providerEventName}. Selecting this acknowledges this is the season&apos;s Super Bowl, and the season will close automatically once the game is final and all wagers are resolved. <button disabled={pending} onClick={onConfirm}>End season after Super Bowl</button></p>;
}

export function AdminSeasonPage() {
  const { slug = "" } = useParams(); const [view, setView] = useState<import("../../contracts/http").ReadPoolView>();
  const [label, setLabel] = useState(""); const [mode, setMode] = useState<"shares" | "value">("shares"); const [amount, setAmount] = useState(""); const [error, setError] = useState(""); const [loadError, setLoadError] = useState(""); const errorRef = useRef<HTMLParagraphElement>(null);
  const seasonCommand = useFrozenAdminCommand<Record<string, unknown>>();
  const refresh = () => void api.poolView(slug).then(setView).catch((e) => setLoadError(errorMessage(e)));
  useEffect(refresh, [slug]); useEffect(() => { if (error || loadError) errorRef.current?.focus(); }, [error, loadError]);
  if (loadError) return <Layout><h1>Season administration</h1><p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{loadError} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
  if (!view) return <Layout><p role="status">Loading season…</p></Layout>;
  if (view.currentMember.role !== "commissioner") return <Layout><h1>Season administration</h1><p role="alert">Only the commissioner can create or open a season.</p></Layout>;
  const create = async () => { setError(""); try { await seasonCommand.run("create-season", () => ({ seasonId: crypto.randomUUID(), label, ...(amount ? { defaultOrder: { mode, amountMicros: microsFromDecimal(amount).toString() } } : {}), idempotencyKey: crypto.randomUUID() }), (body) => api.command(slug, "/admin/seasons", body)); refresh(); } catch (e) { setError(errorMessage(e)); } };
  const open = async () => { if (!view.nextDraftSeason) return; const id = view.nextDraftSeason.id; setError(""); try { await seasonCommand.run(`open:${id}`, () => ({ idempotencyKey: crypto.randomUUID() }), (body) => api.command(slug, `/admin/seasons/${id}/open`, body)); refresh(); } catch (e) { setError(errorMessage(e)); } };
  const confirm = async (seasonId: string, eventId: string) => { setError(""); try { await seasonCommand.run(`super-bowl:${seasonId}:${eventId}`, () => ({ eventId, idempotencyKey: crypto.randomUUID() }), (body) => api.confirmSuperBowl(slug, seasonId, eventId, String(body.idempotencyKey))); refresh(); } catch (e) { setError(errorMessage(e)); } };
  const edit = () => { seasonCommand.retire(); setError(""); };
  const draft = view.nextDraftSeason;
  return <Layout><h1>Season administration</h1>{error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}
    {view.activeSeason && <><p role="status">Active season: {view.activeSeason.label}. Funded orders and wagers are available.</p>{view.activeSeason.superBowlCandidate && <SuperBowlClosureAcknowledgment candidate={view.activeSeason.superBowlCandidate} pending={seasonCommand.pending} onConfirm={() => void confirm(view.activeSeason!.id, view.activeSeason!.superBowlCandidate!.eventId)} />}</>}
    {view.latestClosedSeason && <p role="status">Closed history: {view.latestClosedSeason.label}. <Link to={`/p/${slug}/history/${view.latestClosedSeason.id}`}>View archive</Link></p>}
    {!view.activeSeason && !draft && <form onSubmit={(e) => { e.preventDefault(); void create(); }}><label>Season label <input disabled={seasonCommand.pending} value={label} onChange={(e) => { edit(); setLabel(e.target.value); }} required /></label><fieldset disabled={seasonCommand.pending}><legend>Optional default order (form convenience only)</legend><label>Mode <select value={mode} onChange={(e) => { edit(); setMode(e.target.value as "shares" | "value"); }}><option value="shares">Shares</option><option value="value">Dollars</option></select></label><label>Default amount <input type="number" min="0.000001" step="0.000001" value={amount} onChange={(e) => { edit(); setAmount(e.target.value); }} /></label></fieldset><button disabled={seasonCommand.pending} className="primary-action">Create season</button></form>}
    {draft && <><p>Draft season {draft.label} is ready to configure and open.</p>{draft.defaultOrderMode && <p>Default order: {draft.defaultOrderMode} {draft.defaultOrderAmountMicros} micros.</p>}<button disabled={seasonCommand.pending} className="primary-action" onClick={() => void open()}>Open season</button></>}
    <p><Link to={`/p/${slug}/overview`}>Pool home</Link></p></Layout>;
}

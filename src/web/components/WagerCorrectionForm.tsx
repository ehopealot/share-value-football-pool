import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { useFrozenAdminCommand } from "../admin-command";
import { correctedResults, correctionEvents, type CorrectionEvent, type CorrectionWager } from "../correction-results";
import { CorrectionWagerSummary } from "./CorrectionWagerSummary";

export function WagerCorrectionForm({ slug, wager, action, onCancel, onSuccess }: {
  slug: string;
  wager: CorrectionWager;
  action: "void" | "regrade";
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState("");
  const [events, setEvents] = useState(() => correctionEvents(wager));
  const [error, setError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const correction = useFrozenAdminCommand<Record<string, unknown>>();
  useEffect(() => { headingRef.current?.focus(); }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const edit = () => { correction.retire(); setError(""); };
  const editEvent = (index: number, change: Partial<CorrectionEvent>) => {
    edit(); setEvents(events.map((event, position) => position === index ? { ...event, ...change } : event));
  };
  const submit = async () => {
    if (correction.pending) return;
    if (!reason.trim()) return setError("Enter a correction reason.");
    if (action === "regrade" && !events.length) return setError("Regrading is available after every game in this wager has started. Reload to check again.");
    setError("");
    try {
      await correction.run(`${action}:${wager.wagerId}`, () => {
        const idempotencyKey = crypto.randomUUID();
        return { reason: reason.trim(), idempotencyKey, ...(action === "regrade" ? { correctedResults: correctedResults(events, idempotencyKey) } : {}) };
      }, body => api.command(slug, `/admin/corrections/${wager.wagerId}/${action}`, body));
      onSuccess();
    } catch (error) { setError(errorMessage(error)); }
  };
  return <form className="correction-form" aria-labelledby="correction-form-title" onSubmit={async event => { event.preventDefault(); await submit(); }}>
    <h2 id="correction-form-title" ref={headingRef} tabIndex={-1}>{action === "regrade" ? "Regrade wager" : "Void wager"}</h2>
    <CorrectionWagerSummary wager={wager} showOwner />
    <small className="correction-wager-id">Wager ID: {wager.wagerId}</small>
    <p>{action === "regrade" ? "Enter the corrected result for each game. The wager will be graded using its accepted terms." : "Void this wager and refund its stake. Any prior settlement will be reversed."} Your reason will be saved in the correction history.</p>
    {action === "regrade" && events.map((event, index) => <fieldset className="correction-event" key={`${event.league}:${event.eventId}`} disabled={correction.pending}>
      <legend>{event.awayTeam} at {event.homeTeam}</legend>
      <div className="correction-event-fields">
        <label>Event ID<input name={`eventId-${index}`} value={event.eventId} readOnly /></label>
        <label>League<input name={`league-${index}`} value={event.league.toUpperCase()} readOnly /></label>
        <label>Result<select name={`status-${index}`} value={event.status} onChange={e => editEvent(index, { status: e.target.value as CorrectionEvent["status"] })}>
          <option value="final">Final</option><option value="cancelled">Cancelled</option><option value="no_contest">No contest</option>
        </select></label>
      </div>
      {event.status === "final" && <div className="correction-score-fields">
        <label>{event.awayTeam} score<input name={`awayScore-${index}`} type="number" inputMode="numeric" min="0" max={Number.MAX_SAFE_INTEGER} step="1" required value={event.awayScore} onChange={e => editEvent(index, { awayScore: e.target.value })} /></label>
        <label>{event.homeTeam} score<input name={`homeScore-${index}`} type="number" inputMode="numeric" min="0" max={Number.MAX_SAFE_INTEGER} step="1" required value={event.homeScore} onChange={e => editEvent(index, { homeScore: e.target.value })} /></label>
      </div>}
    </fieldset>)}
    <label className="correction-reason">Reason<input name="reason" required maxLength={500} disabled={correction.pending} value={reason} onChange={e => { edit(); setReason(e.target.value); }} /></label>
    {error && <p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{error}</p>}
    <div className="correction-actions">
      <button className="primary-action" type="submit" disabled={correction.pending || !reason.trim() || (action === "regrade" && !events.length)}>{correction.pending ? "Submitting…" : action === "regrade" ? "Submit regrade" : "Confirm void"}</button>
      <button type="button" disabled={correction.pending} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

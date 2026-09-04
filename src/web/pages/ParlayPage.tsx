import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { PARLAY_RULESET_ID, parlayOdds } from "../../domain/parlay";
import { api, buildParlayPlacement, commandOutcome, errorMessage } from "../api";
import { Confirmation } from "../components/Confirmation";
import { formatAmericanOdds } from "../odds-format";
import { parlayLegForOutcome, readParlaySlip, writeParlaySlip, type ParlayLeg } from "../parlay-slip";
import { outcomeForSelection } from "../selection-matcher";
import { parlayRiskError } from "../selection-tray";
import { ticketReturns } from "../wager-presentation";
import { Layout } from "../components/Layout";

export type ParlaySemantic = { legs: ParlayLeg[]; risk: string; quoteKey: string; wagerId: string };
type ParlayReview = { tag: "reviewing"; request: ParlaySemantic; quote: any; mutationKey: string };
type ParlayUnresolvedPlacement = { tag: "placement-unknown"; request: ParlaySemantic; quote: any; mutationKey: string };
type ParlaySubmission = { tag: "submitting"; request: ParlaySemantic; quote: any; mutationKey: string };
export type ParlayViewState = { tag: "editing"; editor: ParlaySemantic } | { tag: "quoting"; request: ParlaySemantic } | ParlayReview | ParlayUnresolvedPlacement | ParlaySubmission;
type State = ParlayViewState;
type ParlayPlacementAttempt = ParlayReview | ParlayUnresolvedPlacement;
const fresh = (legs: ParlayLeg[], risk = ""): ParlaySemantic => ({ legs, risk, quoteKey: crypto.randomUUID(), wagerId: crypto.randomUUID() });

export const editParlaySemantic = (editor: ParlaySemantic): ParlaySemantic => fresh(editor.legs, editor.risk);
/** A lost placement response must retain every idempotency term until its exact replay resolves. */
export const parlayUnresolvedPlacementTransition = (attempt: ParlayPlacementAttempt): ParlayUnresolvedPlacement => ({ tag: "placement-unknown", request: attempt.request, quote: attempt.quote, mutationKey: attempt.mutationKey });
/** One focused alert tells the member that only the exact frozen placement may be retried. */
export const parlayUnknownPlacementMessage = "Placement result unknown. Retry this exact placement to check its result.";
/** The lean builder intentionally leaves pricing to its aggregate advisory estimate and review snapshot. */
const parlayLegTableColumns = ["Matchup", "Market", "Pick", "Action"] as const;
/** Every quote and placement attempt clears earlier errors before awaiting a new authority result. */
export const parlayQuoteAttemptTransition = (request: ParlaySemantic) => ({ state: { tag: "quoting" as const, request }, error: "" });
export const parlayPlacementAttemptTransition = (attempt: ParlayPlacementAttempt) => ({ state: { tag: "submitting" as const, request: attempt.request, quote: attempt.quote, mutationKey: attempt.mutationKey }, error: "" });

type ParlayPageTicket = { id: number; slug: string };
/** Fences every async continuation to the page instance that issued it. */
export class ParlayPageGeneration {
  private next = 0;
  private active?: ParlayPageTicket;
  start(slug: string): ParlayPageTicket { const ticket = { id: ++this.next, slug }; this.active = ticket; return ticket; }
  capture(slug: string): ParlayPageTicket | undefined { return this.active?.slug === slug ? this.active : undefined; }
  current(ticket: ParlayPageTicket): boolean { return this.active?.id === ticket.id && this.active.slug === ticket.slug; }
  invalidate(ticket: ParlayPageTicket): void { if (this.current(ticket)) this.active = undefined; }
}

/** Rebuilds each stale selection from the current board, not an error payload. */
export async function recoverParlaySemantic(slug: string, request: ParlaySemantic): Promise<{ tag: "recovered"; editor: ParlaySemantic } | { tag: "unavailable" }> {
  const board = await api.odds(slug);
  const legs: ParlayLeg[] = [];
  for (const leg of request.legs) {
    const offer = board.offers.find((candidate) => candidate.eventId === leg.eventId && candidate.market === leg.market);
    const outcome = offer && outcomeForSelection(offer, leg.selection);
    if (!offer || !outcome) return { tag: "unavailable" };
    legs.push(parlayLegForOutcome(offer, outcome, leg.selection));
  }
  return { tag: "recovered", editor: { legs, risk: request.risk, wagerId: request.wagerId, quoteKey: crypto.randomUUID() } };
}

/** Production stale transition persists only the parlay slip; the board tray stays untouched. */
export const parlayRecoveryTransition = (recovered: Awaited<ReturnType<typeof recoverParlaySemantic>>, request: ParlaySemantic) => recovered.tag === "recovered"
  ? { state: { tag: "editing" as const, editor: recovered.editor }, slip: recovered.editor.legs, error: "The line changed. Review the replacement terms and explicitly confirm again." }
  : { state: { tag: "editing" as const, editor: fresh([], request.risk) }, slip: [], error: "A parlay line changed and one or more legs are no longer available. Choose current legs and review again." };
export const parlayTerminalTransition = (request: ParlaySemantic): Extract<ParlayViewState, { tag: "editing" }> => ({ tag: "editing", editor: fresh(request.legs, request.risk) });

/** This estimate is for editing only; quote/confirmation terms are the sole placement authority. */
export const parlayAdvisoryOdds = (legs: ParlayLeg[]): number | undefined => {
  try { return parlayOdds(legs); } catch { return undefined; }
};
export const parlayQuoteRequest = (request: ParlaySemantic, seasonId: string) => ({
  wagerId: request.wagerId, seasonId, riskMicros: (BigInt(request.risk) * 1000000n).toString(), rulesetVersion: PARLAY_RULESET_ID,
  legs: request.legs.map((leg) => ({ eventId: leg.eventId, canonicalBook: leg.canonicalBook, market: leg.market, selection: leg.selection, offerId: `${leg.eventId}:${leg.market}:${leg.selection}`, offerVersion: leg.offerVersion })), quoteKey: request.quoteKey, commandId: request.quoteKey
});
const marketName = (market: ParlayLeg["market"]) => `${market.slice(0, 1).toUpperCase()}${market.slice(1)}`;
const signed = (line: number) => `${line > 0 ? "+" : ""}${line}`;
const parlayPick = (leg: ParlayLeg) => {
  if (leg.market === "total") return `${leg.selection === "over" ? "Over" : "Under"} ${leg.originalLine ?? "—"}`;
  const team = leg.selection === "away" ? leg.awayTeam : leg.homeTeam;
  return leg.market === "moneyline" ? team ?? leg.selection : `${team ?? leg.selection} ${leg.originalLine === null ? "—" : signed(leg.originalLine)}`;
};

export function ParlayLegTable({ legs, onRemove }: { legs: ParlayLeg[]; onRemove: (index: number) => void }) {
  return <div className="table-scroll" tabIndex={0}><table><caption>Selected parlay legs</caption><thead><tr>{parlayLegTableColumns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{legs.map((leg, index) => <tr key={`${leg.eventId}-${leg.market}-${leg.selection}`}><td>{leg.awayTeam && leg.homeTeam ? `${leg.awayTeam} at ${leg.homeTeam}` : "Game details unavailable"}</td><td>{marketName(leg.market)}</td><td>{parlayPick(leg)}</td><td><button onClick={() => onRemove(index)}>Remove</button></td></tr>)}</tbody></table></div>;
}

export function ParlayPageRoute() {
  const { slug = "" } = useParams();
  // A route-param change remounts the builder, so an old pool cannot retain its editor or callbacks.
  return <ParlayPage key={slug} />;
}

export function ParlayPage() {
  const { slug = "" } = useParams(); const nav = useNavigate(); const [view, setView] = useState<any>(); const [state, setState] = useState<State>(() => ({ tag: "editing", editor: fresh([]) })); const [error, setError] = useState(""); const errorRef = useRef<HTMLParagraphElement>(null); const generations = useRef(new ParlayPageGeneration());
  useEffect(() => {
    const ticket = generations.current.start(slug);
    const legs = readParlaySlip(slug);
    setView(undefined); setError(""); setState({ tag: "editing", editor: fresh(legs) });
    void api.poolView(slug).then((loaded) => { if (generations.current.current(ticket)) setView(loaded); }).catch((e) => { if (generations.current.current(ticket)) setError(errorMessage(e)); });
    return () => generations.current.invalidate(ticket);
  }, [slug]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const editor = state.tag === "editing" ? state.editor : undefined;
  const balance = view?.activeSeason && view.currentMember.seasonBalances.find((item: any) => item.seasonId === view.activeSeason.id);
  const riskError = editor?.risk ? parlayRiskError(editor.risk, { maxSideBetMicros: view?.pool.maxSideBetMicros, availableMicros: balance?.availableMicros }) : "";
  const pending = state.tag === "quoting" || state.tag === "submitting";
  const edit = (next: ParlaySemantic) => { setError(""); setState({ tag: "editing", editor: editParlaySemantic(next) }); };
  const returnToEditor = (request: ParlaySemantic) => setState({ tag: "editing", editor: fresh(request.legs, request.risk) });
  const recover = async (request: ParlaySemantic, ticket: ParlayPageTicket) => {
    const recovered = await recoverParlaySemantic(slug, request);
    if (!generations.current.current(ticket)) return;
    const transition = parlayRecoveryTransition(recovered, request);
    writeParlaySlip(slug, transition.slip);
    setState(transition.state);
    setError(transition.error);
  };
  const review = async () => {
    if (!editor || !view?.activeSeason?.id) return;
    const validation = parlayRiskError(editor.risk, { maxSideBetMicros: view.pool.maxSideBetMicros, availableMicros: balance?.availableMicros });
    if (validation) return setError(validation);
    const ticket = generations.current.capture(slug); if (!ticket) return;
    const request = editor;
    const transition = parlayQuoteAttemptTransition(request); setError(transition.error); setState(transition.state);
    try {
      const quote = await api.quoteParlay(slug, parlayQuoteRequest(request, view.activeSeason.id));
      if (!generations.current.current(ticket)) return;
      setState({ tag: "reviewing", request, quote, mutationKey: crypto.randomUUID() });
    } catch (e) {
      if (!generations.current.current(ticket)) return;
      if (commandOutcome(e) === "stale") {
        try { await recover(request, ticket); }
        catch { if (generations.current.current(ticket)) { setState({ tag: "editing", editor: request }); setError("We could not retrieve current odds. Your quote was not changed; retry this same request."); } }
      } else { setState({ tag: "editing", editor: request }); setError(errorMessage(e)); }
    }
  };
  const reviewed = state.tag === "reviewing" || state.tag === "submitting" || state.tag === "placement-unknown" ? state : undefined;
  const place = async () => {
    const attempt = state.tag === "reviewing" || state.tag === "placement-unknown" ? state : undefined;
    if (!attempt) return;
    const ticket = generations.current.capture(slug); if (!ticket) return;
    const transition = parlayPlacementAttemptTransition(attempt); setError(transition.error); setState(transition.state);
    try {
      await api.placeWager(slug, "/wagers/parlays/place", buildParlayPlacement(attempt.quote, attempt.request.wagerId, attempt.mutationKey));
      if (!generations.current.current(ticket)) return;
      writeParlaySlip(slug, []);
      nav(`/p/${slug}/my-wagers`);
    } catch (e) {
      if (!generations.current.current(ticket)) return;
      if (commandOutcome(e) === "stale") {
        try { await recover(attempt.request, ticket); }
        catch { if (generations.current.current(ticket)) { setState(attempt); setError("Odds unavailable."); } }
      } else if (commandOutcome(e) === "terminal") { setState(parlayTerminalTransition(attempt.request)); setError(errorMessage(e)); }
      else { setState(parlayUnresolvedPlacementTransition(attempt)); setError(parlayUnknownPlacementMessage); }
    }
  };
  if (reviewed) {
    const placementUnknown = reviewed.tag === "placement-unknown";
    return <Layout signedIn><Confirmation snapshot={{ kind: "parlay", quote: reviewed.quote }} /><div className="confirmation-actions"><button className="primary-action" disabled={pending} onClick={() => void place()}>{pending ? "Confirming…" : placementUnknown ? "Retry placement" : "Place parlay"}</button>{!placementUnknown && <button disabled={pending} onClick={() => returnToEditor(reviewed.request)}>Edit terms</button>}</div>{error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}</Layout>;
  }
  if (state.tag === "quoting") return <Layout signedIn><h1>Reviewing parlay wager</h1><p role="status">Getting current odds…</p><p>{state.request.legs.length}-leg parlay · Risk {state.request.risk || "0"}</p></Layout>;
  const odds = editor && parlayAdvisoryOdds(editor.legs);
  const payout = odds !== undefined && editor && /^\d+$/.test(editor.risk) && BigInt(editor.risk) > 0n ? ticketReturns((BigInt(editor.risk) * 1000000n).toString(), odds).total : undefined;
  const invalid = !editor || editor.legs.length < 2 || editor.legs.length > 6 ? "Choose two to six legs." : riskError;
  return <Layout signedIn><h1>Parlay builder</h1><p>Select two to six offers on the <Link to={`/p/${slug}/odds`}>odds board</Link>.</p>{error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}<ParlayLegTable legs={editor!.legs} onRemove={(index) => { const legs = editor!.legs.filter((_, legIndex) => legIndex !== index); writeParlaySlip(slug, legs); edit({ ...editor!, legs }); }} />{invalid && <p role="alert" className="bet-slip-error">{invalid}</p>}{odds !== undefined && <p className="parlay-advisory"><strong>Advisory current-board estimate:</strong> {formatAmericanOdds(odds)} · <strong>Estimated payout:</strong> {payout ?? "Enter a risk"}. Review terms are authoritative.</p>}<div className="parlay-risk-actions"><label htmlFor="parlay-risk">Risk in whole shares <input id="parlay-risk" type="number" min="1" step="1" value={editor!.risk} onChange={(e) => edit({ ...editor!, risk: e.target.value })} /></label><button className="primary-action parlay-review-action" disabled={!!invalid || !editor!.risk || !view?.activeSeason?.id} onClick={() => void review()}>Review parlay wager</button></div></Layout>;
}

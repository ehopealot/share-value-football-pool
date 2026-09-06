import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { Link, useNavigate, useParams } from "react-router";
import { api, buildTeaserPlacement, commandOutcome, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { Confirmation } from "../components/Confirmation";
import { SelectedLegDisplay } from "../components/SelectedLegDisplay";
import { adjustedLine, readTeaserSlip, validateTeaser, writeTeaserSlip, type TeaserLeg } from "../teaser-slip";
import { teaserOdds } from "../../domain/teaser-table";
import { ticketReturns } from "../wager-presentation";
import { outcomeForSelection } from "../selection-matcher";
import { formatAmericanOdds } from "../odds-format";
import { teaserRiskError } from "../selection-tray";
import { PageGeneration } from "../page-generation";
import { displayTeamName } from "../team-display";
import type { teaserPoints } from "../../contracts/commands";
type TeaserPoints = z.infer<typeof teaserPoints>;
const teaserPointOptions = [6, 6.5, 7, 7.5, 10] as const satisfies readonly TeaserPoints[];
export type TeaserSemantic = { legs: TeaserLeg[]; points: TeaserPoints; risk: string; quoteKey: string; wagerId: string };
type TeaserReview = { tag: "reviewing"; request: TeaserSemantic; quote: any; mutationKey: string };
type TeaserUnresolvedPlacement = { tag: "placement-unknown"; request: TeaserSemantic; quote: any; mutationKey: string };
type TeaserSubmission = { tag: "submitting"; request: TeaserSemantic; quote: any; mutationKey: string };
export type TeaserViewState = { tag: "editing"; editor: TeaserSemantic } | { tag: "quoting"; request: TeaserSemantic } | TeaserReview | TeaserUnresolvedPlacement | TeaserSubmission;
type Semantic = TeaserSemantic;
type State = TeaserViewState;
type TeaserPlacementAttempt = TeaserReview | TeaserUnresolvedPlacement;
const fresh = (legs: TeaserLeg[], points: TeaserPoints, risk = ""): Semantic => ({ legs, points, risk, quoteKey: crypto.randomUUID(), wagerId: crypto.randomUUID() });
/** Retry retains the exact semantic authority; an edit explicitly retires it. */
export const retryTeaserSemantic = (request: TeaserSemantic): TeaserSemantic => request;
export const editTeaserSemantic = (editor: TeaserSemantic): TeaserSemantic => fresh(editor.legs, editor.points, editor.risk);
/** A lost placement response can only be retried with the exact preserved placement identity. */
export const teaserUnresolvedPlacementTransition = (attempt: TeaserPlacementAttempt): TeaserUnresolvedPlacement => ({ tag: "placement-unknown", request: attempt.request, quote: attempt.quote, mutationKey: attempt.mutationKey });
/** One focused alert tells the member that only the exact frozen placement may be retried. */
export const teaserUnknownPlacementMessage = "Placement result unknown. Retry this exact placement to check its result.";
export const teaserQuoteAttemptTransition = (request: TeaserSemantic) => ({ state: { tag: "quoting" as const, request }, error: "" });
export const teaserPlacementAttemptTransition = (attempt: TeaserPlacementAttempt) => ({ state: { tag: "submitting" as const, request: attempt.request, quote: attempt.quote, mutationKey: attempt.mutationKey }, error: "" });

/** Rebuilds every teaser leg from the current board, never from LINE_CHANGED details. */
export async function recoverTeaserSemantic(slug: string, request: Semantic): Promise<{ tag: "recovered"; editor: Semantic } | { tag: "unavailable" }> {
  const board = await api.odds(slug);
  const legs: TeaserLeg[] = [];
  for (const leg of request.legs) {
    const offer = board.offers.find((candidate: any) => candidate.eventId === leg.eventId && candidate.market === leg.market);
    const outcome = offer && outcomeForSelection(offer, leg.selection);
    if (!offer || !outcome || typeof outcome.point !== "number") return { tag: "unavailable" };
    legs.push({ eventId: offer.eventId, league: offer.league, canonicalBook: offer.canonicalBook, retrievedAt: offer.retrievedAt, policyVersion: offer.policyVersion, offerVersion: offer.offerVersion, canonicalOfferProof: { offerId: `${offer.eventId}:${offer.market}:${leg.selection}`, eventId: offer.eventId, offerVersion: offer.offerVersion, canonicalBook: offer.canonicalBook, market: offer.market, selection: leg.selection, odds: outcome.price, line: outcome.point }, market: offer.market, selection: leg.selection, originalLine: outcome.point, originalOdds: outcome.price, eventStartsAt: offer.startsAt, homeTeam: offer.homeTeam, awayTeam: offer.awayTeam } as TeaserLeg);
  }
  return { tag: "recovered", editor: { legs, points: request.points, risk: request.risk, wagerId: request.wagerId, quoteKey: crypto.randomUUID() } };
}

/** Production review lifecycle reducer; callers persist only an authoritative recovered slip. */
export const teaserRecoveryTransition = (recovered: Awaited<ReturnType<typeof recoverTeaserSemantic>>, request: Semantic) => recovered.tag === "recovered"
  ? { state: { tag: "editing" as const, editor: recovered.editor }, slip: recovered.editor.legs, error: "The line changed. Review the replacement terms and explicitly confirm again." }
  : { state: { tag: "editing" as const, editor: fresh([], request.points, request.risk) }, slip: [], error: "A teaser line changed and one or more legs are no longer available. Choose current legs and review again." };
export const teaserTerminalTransition = (request: Semantic): TeaserViewState => ({ tag: "editing", editor: fresh(request.legs, request.points, request.risk) });
const signed = (line: number) => `${line > 0 ? "+" : ""}${line}`;
export const pickAtLine = (leg: TeaserLeg, line: number) => {
  if (leg.market === "total") return `${leg.selection === "over" ? "O" : "U"}${line}`;
  const team = leg.selection === "away" ? leg.awayTeam : leg.homeTeam;
  return `${displayTeamName(leg.league, team ?? leg.selection)} ${signed(line)}`;
};
const teaserAdjustment = (leg: TeaserLeg, points: number) => signed(adjustedLine(leg, points) - leg.originalLine);
export const teaserSelectedDetail = (leg: TeaserLeg, points: number) => leg.market === "total" ? `${adjustedLine(leg, points)}` : signed(adjustedLine(leg, points));

export function TeaserPage() {
  const { slug = "" } = useParams(); const nav = useNavigate(); const [view, setView] = useState<any>(); const [state, setState] = useState<State>(() => ({ tag: "editing", editor: fresh([], 6) })); const [error, setError] = useState(""); const errorRef = useRef<HTMLParagraphElement>(null); const generations = useRef(new PageGeneration());
  useEffect(() => {
    const ticket = generations.current.start(slug);
    const legs = readTeaserSlip(slug); setView(undefined); setError(""); setState({ tag: "editing", editor: fresh(legs, 6) });
    void api.poolView(slug).then((loaded) => { if (generations.current.current(ticket)) setView(loaded); }).catch((e) => { if (generations.current.current(ticket)) setError(errorMessage(e)); });
    return () => generations.current.invalidate(ticket);
  }, [slug]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const editor = state.tag === "editing" ? state.editor : undefined;
  const balance = view?.activeSeason && view.currentMember.seasonBalances.find((item: any) => item.seasonId === view.activeSeason.id);
  const riskError = editor?.risk ? teaserRiskError(editor.risk, { maxSideBetMicros: view?.pool.maxSideBetMicros, availableMicros: balance?.availableMicros }) : "";
  const returnToEditor = (request: Semantic) => setState({ tag: "editing", editor: fresh(request.legs, request.points, request.risk) });
  const pending = state.tag === "quoting" || state.tag === "submitting";
  const edit = (next: Semantic) => { setError(""); setState({ tag: "editing", editor: editTeaserSemantic(next) }); };
  const review = async () => {
    if (!editor || !view?.activeSeason?.id) return;
    const ticket = generations.current.capture(slug); if (!ticket) return;
    const validation = teaserRiskError(editor.risk, { maxSideBetMicros: view.pool.maxSideBetMicros, availableMicros: balance?.availableMicros }); if (validation) return setError(validation);
    const request = editor; const attempt = teaserQuoteAttemptTransition(request); setError(attempt.error); setState(attempt.state);
    try {
      const quote = await api.quoteTeaser(slug, { wagerId: request.wagerId, seasonId: view.activeSeason.id, riskMicros: (BigInt(request.risk) * 1000000n).toString(), teaserPoints: request.points, rulesetVersion: "SHARE_POOL_2026_V1", legs: request.legs.map(l => ({ eventId: l.eventId, canonicalBook: l.canonicalBook, market: l.market, selection: l.selection, offerId: `${l.eventId}:${l.market}:${l.selection}`, offerVersion: l.offerVersion })), quoteKey: request.quoteKey, commandId: request.quoteKey });
      if (!generations.current.current(ticket)) return;
      setState({ tag: "reviewing", request, quote, mutationKey: crypto.randomUUID() });
    } catch (e) {
      if (!generations.current.current(ticket)) return;
      if (commandOutcome(e) === "stale") {
        try {
          const recovered = await recoverTeaserSemantic(slug, request);
          if (!generations.current.current(ticket)) return;
          const transition = teaserRecoveryTransition(recovered, request); writeTeaserSlip(slug, transition.slip); setState(transition.state); setError(transition.error);
        } catch { if (generations.current.current(ticket)) { setState({ tag: "editing", editor: request }); setError("We could not retrieve current odds. Your quote was not changed; retry this same request."); } }
      } else { setState({ tag: "editing", editor: retryTeaserSemantic(request) }); setError(errorMessage(e)); }
    }
  };
  const reviewed = state.tag === "reviewing" || state.tag === "submitting" || state.tag === "placement-unknown" ? state : undefined;
  const place = async () => {
    const attempt = state.tag === "reviewing" || state.tag === "placement-unknown" ? state : undefined; if (!attempt) return;
    const ticket = generations.current.capture(slug); if (!ticket) return;
    const transition = teaserPlacementAttemptTransition(attempt); setError(transition.error); setState(transition.state);
    try {
      await api.placeWager(slug, "/wagers/teasers/place", buildTeaserPlacement(attempt.quote, attempt.request.wagerId, attempt.mutationKey));
      if (!generations.current.current(ticket)) return;
      writeTeaserSlip(slug, []); nav(`/p/${slug}/my-wagers`);
    } catch (e) {
      if (!generations.current.current(ticket)) return;
      if (commandOutcome(e) === "stale") {
        try {
          const recovered = await recoverTeaserSemantic(slug, attempt.request);
          if (!generations.current.current(ticket)) return;
          const recoveredTransition = teaserRecoveryTransition(recovered, attempt.request); writeTeaserSlip(slug, recoveredTransition.slip); setState(recoveredTransition.state); setError(recoveredTransition.error);
        } catch { if (generations.current.current(ticket)) { setState(attempt); setError("Odds unavailable."); } }
      } else if (commandOutcome(e) === "terminal") { setState(teaserTerminalTransition(attempt.request)); setError(errorMessage(e)); }
      else { setState(teaserUnresolvedPlacementTransition(attempt)); setError(teaserUnknownPlacementMessage); }
    }
  };
  if (reviewed) {
    const placementUnknown = reviewed.tag === "placement-unknown";
    return <Layout signedIn><Confirmation snapshot={{ kind: "teaser", quote: reviewed.quote }} /><div className="confirmation-actions"><button className="primary-action" disabled={pending} onClick={() => void place()}>{pending ? "Confirming…" : placementUnknown ? "Retry placement" : "Place teaser"}</button>{!placementUnknown && <button disabled={pending} onClick={() => returnToEditor(reviewed.request)}>Edit terms</button>}</div>{error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}</Layout>;
  }
  if (state.tag === "quoting") return <Layout signedIn><h1>Reviewing teaser wager</h1><p role="status">Getting current odds…</p><p>{state.request.legs.length}-leg, {state.request.points}-point teaser · Risk {state.request.risk || "0"}</p></Layout>;
  const invalid = validateTeaser(editor!.legs, editor!.points) || riskError;
  const odds = editor && teaserOdds(editor.legs.length, editor.points as 6 | 6.5 | 7 | 7.5 | 10);
  const payout = odds !== undefined && editor && /^\d+$/.test(editor.risk) && BigInt(editor.risk) > 0n ? ticketReturns((BigInt(editor.risk) * 1000000n).toString(), odds).total : undefined;
  return <Layout signedIn><h1>Teaser builder</h1><p>Select spread or total offers on the <Link to={`/p/${slug}/odds`}>odds board</Link>.</p>{error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}<fieldset disabled={pending}><legend>Point adjustment</legend>{teaserPointOptions.map(points => <label key={points}><input type="radio" checked={editor!.points === points} onChange={() => edit({ ...editor!, points })} />{points} points</label>)}</fieldset><div className="table-scroll" tabIndex={0}><table><thead><tr><th>Matchup</th><th>Original line</th><th>Adjustment</th><th>Action</th></tr></thead><tbody>{editor!.legs.map((leg, i) => <tr key={`${leg.eventId}-${leg.market}-${leg.selection}`}><td>{leg.awayTeam && leg.homeTeam ? <SelectedLegDisplay league={leg.league} awayTeam={leg.awayTeam} homeTeam={leg.homeTeam} market={leg.market} selection={leg.selection} selectedDetail={teaserSelectedDetail(leg, editor!.points)} /> : "Game details unavailable"}</td><td>{pickAtLine(leg, leg.originalLine)}</td><td>{teaserAdjustment(leg, editor!.points)}</td><td><button disabled={pending} onClick={() => { const legs = editor!.legs.filter((_, index) => index !== i); writeTeaserSlip(slug, legs); edit({ ...editor!, legs }); }}>Remove</button></td></tr>)}</tbody></table></div>{invalid && <p role="alert" className="bet-slip-error">{invalid}</p>}{odds !== undefined && <p className="teaser-terms"><strong>Odds:</strong> {formatAmericanOdds(odds)} · <strong>Payout:</strong> {payout ?? "Enter a risk"}</p>}<div className="teaser-risk-actions"><label>Risk <input disabled={pending} type="number" min="1" step="1" value={editor!.risk} onChange={e => edit({ ...editor!, risk: e.target.value })} /></label><button className="primary-action teaser-review-action" disabled={pending || !!invalid || !editor!.risk || !view?.activeSeason?.id} onClick={() => void review()}>{pending ? "Reviewing…" : "Review teaser wager"}</button></div></Layout>;
}

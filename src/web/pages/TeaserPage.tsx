import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, buildTeaserPlacement, commandOutcome, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { Confirmation } from "../components/Confirmation";
import { adjustedLine, readTeaserSlip, validateTeaser, writeTeaserSlip, type TeaserLeg } from "../teaser-slip";
import { teaserOdds } from "../../domain/teaser-table";
import { ticketReturns } from "../wager-presentation";
import { outcomeForSelection } from "../selection-matcher";
import { formatAmericanOdds } from "../odds-format";
export type TeaserSemantic = { legs: TeaserLeg[]; points: number; risk: string; quoteKey: string; wagerId: string };
export type TeaserViewState = { tag: "editing"; editor: TeaserSemantic } | { tag: "quoting"; request: TeaserSemantic } | { tag: "reviewing"; request: TeaserSemantic; quote: any; mutationKey: string } | { tag: "submitting"; request: TeaserSemantic; quote: any; mutationKey: string };
type Semantic = TeaserSemantic;
type State = TeaserViewState;
const fresh = (legs: TeaserLeg[], points: number, risk = ""): Semantic => ({ legs, points, risk, quoteKey: crypto.randomUUID(), wagerId: crypto.randomUUID() });
/** Retry retains the exact semantic authority; an edit explicitly retires it. */
export const retryTeaserSemantic = (request: TeaserSemantic): TeaserSemantic => request;
export const editTeaserSemantic = (editor: TeaserSemantic): TeaserSemantic => fresh(editor.legs, editor.points, editor.risk);

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
const pickAtLine = (leg: TeaserLeg, line: number) => {
  if (leg.market === "total") return `${leg.selection === "over" ? "O" : "U"}${line}`;
  const team = leg.selection === "away" ? leg.awayTeam : leg.homeTeam;
  return `${team ?? leg.selection} ${signed(line)}`;
};
const teaserPick = (leg: TeaserLeg, points: number) => pickAtLine(leg, adjustedLine(leg, points));
const teaserAdjustment = (leg: TeaserLeg, points: number) => signed(adjustedLine(leg, points) - leg.originalLine);

export function TeaserPage() {
  const { slug = "" } = useParams(); const nav = useNavigate(); const [view, setView] = useState<any>(); const [state, setState] = useState<State>(() => ({ tag: "editing", editor: fresh([], 6) })); const [error, setError] = useState(""); const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { const legs = readTeaserSlip(slug); setState({ tag: "editing", editor: fresh(legs, 6) }); void api.poolView(slug).then(setView).catch(e => setError(errorMessage(e))); }, [slug]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const editor = state.tag === "editing" ? state.editor : undefined;
  const returnToEditor = (request: Semantic) => setState({ tag: "editing", editor: fresh(request.legs, request.points, request.risk) });
  const pending = state.tag === "quoting" || state.tag === "submitting";
  const edit = (next: Semantic) => { setError(""); setState({ tag: "editing", editor: editTeaserSemantic(next) }); };
  const review = async () => { if (!editor || !view?.activeSeason?.id) return; if (!/^\d+$/.test(editor.risk) || BigInt(editor.risk) <= 0n) return setError("Whole shares required."); const request = editor; setState({ tag: "quoting", request }); try { const quote = await api.quoteTeaser(slug, { wagerId: request.wagerId, seasonId: view.activeSeason.id, riskMicros: (BigInt(request.risk) * 1000000n).toString(), teaserPoints: request.points, rulesetVersion: "SHARE_POOL_2026_V1", legs: request.legs.map(l => ({ eventId: l.eventId, canonicalBook: l.canonicalBook, market: l.market, selection: l.selection, offerId: `${l.eventId}:${l.market}:${l.selection}`, offerVersion: l.offerVersion })), quoteKey: request.quoteKey, commandId: request.quoteKey }); setState({ tag: "reviewing", request, quote, mutationKey: crypto.randomUUID() }); } catch (e) {
    if (commandOutcome(e) === "stale") {
      try { const recovered = await recoverTeaserSemantic(slug, request); const transition = teaserRecoveryTransition(recovered, request); writeTeaserSlip(slug, transition.slip); setState(transition.state); setError(transition.error); }
      catch { setState({ tag: "editing", editor: request }); setError("We could not retrieve current odds. Your quote was not changed; retry this same request."); }
    } else { setState({ tag: "editing", editor: retryTeaserSemantic(request) }); setError(errorMessage(e)); }
  } };
  const reviewed = state.tag === "reviewing" || state.tag === "submitting" ? state : undefined;
  const place = async () => { if (!reviewed || reviewed.tag !== "reviewing") return; setState({ ...reviewed, tag: "submitting" }); try { await api.placeCommand(slug, "/wagers/teasers/place", buildTeaserPlacement(reviewed.quote, reviewed.request.wagerId, reviewed.mutationKey)); writeTeaserSlip(slug, []); nav(`/p/${slug}/my-wagers`); } catch (e) { if (commandOutcome(e) === "stale") { try { const recovered = await recoverTeaserSemantic(slug, reviewed.request); const transition = teaserRecoveryTransition(recovered, reviewed.request); writeTeaserSlip(slug, transition.slip); setState(transition.state); setError(transition.error); } catch { setState(reviewed); setError("Odds unavailable."); } } else if (commandOutcome(e) === "terminal") setState(teaserTerminalTransition(reviewed.request)); else setState(reviewed); if (commandOutcome(e) !== "stale") setError(errorMessage(e)); } };
  if (reviewed) return <Layout signedIn><Confirmation snapshot={{ kind: "teaser", quote: reviewed.quote }} /><div className="confirmation-actions"><button className="primary-action" disabled={pending} onClick={() => void place()}>{pending ? "Confirming…" : "Place teaser"}</button><button disabled={pending} onClick={() => returnToEditor(reviewed.request)}>Edit terms</button></div>{error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}</Layout>;
  if (state.tag === "quoting") return <Layout signedIn><h1>Reviewing teaser wager</h1><p role="status">Getting current odds…</p><p>{state.request.legs.length}-leg, {state.request.points}-point teaser · Risk {state.request.risk || "0"}</p></Layout>;
  const invalid = editor && validateTeaser(editor.legs, editor.points);
  const odds = editor && teaserOdds(editor.legs.length, editor.points as 6 | 6.5 | 7 | 7.5 | 10);
  const payout = odds !== undefined && editor && /^\d+$/.test(editor.risk) && BigInt(editor.risk) > 0n ? ticketReturns((BigInt(editor.risk) * 1000000n).toString(), odds).total : undefined;
  return <Layout signedIn><h1>Teaser builder</h1><p>Select spread or total offers on the <Link to={`/p/${slug}/odds`}>odds board</Link>.</p>{error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}<fieldset disabled={pending}><legend>Point adjustment</legend>{[6, 6.5, 7, 7.5, 10].map(points => <label key={points}><input type="radio" checked={editor!.points === points} onChange={() => edit({ ...editor!, points })} />{points} points</label>)}</fieldset><div className="table-scroll" tabIndex={0}><table><thead><tr><th>Matchup</th><th>Original line</th><th>Adjustment</th><th>Pick</th><th>Action</th></tr></thead><tbody>{editor!.legs.map((leg, i) => <tr key={`${leg.eventId}-${leg.market}-${leg.selection}`}><td>{leg.awayTeam && leg.homeTeam ? `${leg.awayTeam} at ${leg.homeTeam}` : "Game details unavailable"}</td><td>{pickAtLine(leg, leg.originalLine)}</td><td>{teaserAdjustment(leg, editor!.points)}</td><td>{teaserPick(leg, editor!.points)}</td><td><button disabled={pending} onClick={() => { const legs = editor!.legs.filter((_, index) => index !== i); writeTeaserSlip(slug, legs); edit({ ...editor!, legs }); }}>Remove</button></td></tr>)}</tbody></table></div><p>{invalid || ""}</p>{odds !== undefined && <p className="teaser-terms"><strong>Odds:</strong> {formatAmericanOdds(odds)} · <strong>Payout:</strong> {payout ?? "Enter a risk"}</p>}<div className="teaser-risk-actions"><label>Risk <input disabled={pending} type="number" min="1" step="1" value={editor!.risk} onChange={e => edit({ ...editor!, risk: e.target.value })} /></label><button className="primary-action teaser-review-action" disabled={pending || !!invalid || !editor!.risk || !view?.activeSeason?.id} onClick={() => void review()}>{pending ? "Reviewing…" : "Review teaser wager"}</button></div></Layout>;
}

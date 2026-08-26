import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, buildStraightPlacement, commandOutcome, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { Confirmation } from "../components/Confirmation";
import { outcomeForSelection, selectableOutcomes, selectionForOutcome } from "../selection-matcher";
import { addTeaserLeg, readTeaserSlip, teaserLegForOutcome, writeTeaserSlip } from "../teaser-slip";
type Pick = { offer: any; outcome: any };
export type StraightSemantic = { pick: Pick; risk: string; quoteKey: string; wagerId: string };
export type StraightViewState = { tag: "editing"; editor: StraightSemantic } | { tag: "quoting"; request: StraightSemantic } | { tag: "reviewing"; request: StraightSemantic; quote: any; mutationKey: string } | { tag: "submitting"; request: StraightSemantic; quote: any; mutationKey: string };
type Semantic = StraightSemantic;
type State = StraightViewState;
const fresh = (pick: Pick, risk = ""): Semantic => ({ pick, risk, quoteKey: crypto.randomUUID(), wagerId: crypto.randomUUID() });
const selectionFor = ({ offer, outcome }: Pick) => selectionForOutcome(offer, outcome);
/** Retry retains the exact semantic authority; an edit explicitly retires it. */
export const retryStraightSemantic = (request: StraightSemantic): StraightSemantic => request;
export const editStraightSemantic = (editor: StraightSemantic): StraightSemantic => fresh(editor.pick, editor.risk);
/** Review controls follow the parsed fail-closed board state, never retained editor data. */
export const boardEnablesWagerReview = (board: { offers?: unknown[]; feed?: { status?: string } } | undefined): boolean => board?.feed?.status === "current" && !!board.offers?.length;

/** Fetches the authoritative board and distinguishes an unavailable semantic selection from a failed fetch. */
export async function recoverStraightState(slug: string, request: Semantic): Promise<{ tag: "recovered"; board: any; editor: Semantic } | { tag: "unavailable"; board: any }> {
  const board = await api.odds(slug);
  const selection = selectionFor(request.pick);
  const offer = board.offers.find((candidate: any) => candidate.eventId === request.pick.offer.eventId && candidate.market === request.pick.offer.market);
  const outcome = offer && selection ? outcomeForSelection(offer, selection) : undefined;
  if (!offer || !outcome) return { tag: "unavailable", board };
  return { tag: "recovered", board, editor: { pick: { offer, outcome }, risk: request.risk, wagerId: request.wagerId, quoteKey: crypto.randomUUID() } };
}
/** Replaces stale editor identity from a fresh board; it never trusts a placement error payload. */
export async function recoverStraightSemantic(slug: string, request: Semantic): Promise<Semantic> {
  const result = await recoverStraightState(slug, request);
  if (result.tag === "unavailable") throw new Error("CURRENT_OFFER_UNAVAILABLE");
  return result.editor;
}

/** Production review lifecycle reducer: stale confirmation never remains mounted. */
export const straightRecoveryTransition = (recovered: Awaited<ReturnType<typeof recoverStraightState>>) => recovered.tag === "recovered"
  ? { state: { tag: "editing" as const, editor: recovered.editor }, error: "The line changed. Review the replacement terms and explicitly confirm again." }
  : { state: undefined, error: "The line changed and this offer is no longer available. Select a current offer and review it again." };
export const straightTerminalTransition = (request: Semantic): StraightViewState => ({ tag: "editing", editor: fresh(request.pick, request.risk) });

export function OddsPage() {
  const { slug = "" } = useParams(); const nav = useNavigate(); const [board, setBoard] = useState<any>(); const [view, setView] = useState<any>();
  const [league, setLeague] = useState(""); const [market, setMarket] = useState(""); const [date, setDate] = useState(""); const [state, setState] = useState<State>(); const [error, setError] = useState(""); const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { void api.odds(slug, `?${new URLSearchParams(Object.fromEntries([["league", league], ["market", market], ["date", date]].filter(([, value]) => value)))}`).then(setBoard).catch(e => setError(errorMessage(e))); }, [slug, league, market, date]);
  useEffect(() => { void api.poolView(slug).then(setView).catch(e => setError(errorMessage(e))); }, [slug]);
  const edit = (next: Semantic) => { setError(""); setState({ tag: "editing", editor: editStraightSemantic(next) }); };
  const returnToEditor = (request: Semantic) => setState({ tag: "editing", editor: fresh(request.pick, request.risk) });
  const addSelectionToTeaser = (pick: Pick) => {
    const selection = selectionFor(pick);
    if ((pick.offer.market !== "spread" && pick.offer.market !== "total") || !selection || typeof pick.outcome.point !== "number") return;
    const merged = addTeaserLeg(readTeaserSlip(slug), teaserLegForOutcome(pick.offer, pick.outcome, selection));
    if (merged.error) return setError(merged.error);
    writeTeaserSlip(slug, merged.legs); setError("");
  };
  const requestFor = (s: Semantic) => { const { offer } = s.pick; const selection = selectionFor(s.pick); if (!selection) throw new Error("CURRENT_OFFER_UNAVAILABLE"); return { wagerId: s.wagerId, seasonId: view.activeSeason.id, riskMicros: (BigInt(s.risk) * 1000000n).toString(), rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: offer.eventId, canonicalBook: offer.canonicalBook, market: offer.market, selection, offerId: `${offer.eventId}:${offer.market}:${selection}`, offerVersion: offer.offerVersion }, quoteKey: s.quoteKey, commandId: s.quoteKey }; };
  const review = async () => { if (!state || state.tag !== "editing" || !view?.activeSeason?.id || !boardEnablesWagerReview(board)) return; if (!/^\d+$/.test(state.editor.risk) || BigInt(state.editor.risk) <= 0n) return setError("Wager risk must be a whole number of shares"); const request = state.editor; setState({ tag: "quoting", request }); try { const quote = await api.quoteStraight(slug, requestFor(request)); setState({ tag: "reviewing", request, quote, mutationKey: crypto.randomUUID() }); } catch (e) {
    if (commandOutcome(e) === "stale") {
      try { const recovered = await recoverStraightState(slug, request); setBoard(recovered.board); const transition = straightRecoveryTransition(recovered); setState(transition.state); setError(transition.error); }
      catch { setState({ tag: "editing", editor: request }); setError("We could not retrieve current odds. Your quote was not changed; retry this same request."); }
    } else { setState({ tag: "editing", editor: retryStraightSemantic(request) }); setError(errorMessage(e)); }
  } };
  const place = async () => { if (!state || state.tag !== "reviewing") return; const reviewing = state; setState({ ...reviewing, tag: "submitting" }); try { await api.placeCommand(slug, "/wagers/straight/place", buildStraightPlacement(reviewing.quote, reviewing.request.wagerId, reviewing.mutationKey)); nav(`/p/${slug}/my-wagers`); } catch (e) { if (commandOutcome(e) === "stale") { try { const recovered = await recoverStraightState(slug, reviewing.request); setBoard(recovered.board); const transition = straightRecoveryTransition(recovered); setState(transition.state); setError(transition.error); } catch { setState(reviewing); setError("We could not retrieve current odds. Your confirmed wager was not changed; retry this same confirmation."); } } else if (commandOutcome(e) === "terminal") setState(straightTerminalTransition(reviewing.request)); else setState(reviewing); if (commandOutcome(e) !== "stale") setError(errorMessage(e)); } };
  const pending = state?.tag === "quoting" || state?.tag === "submitting"; const reviewing = state?.tag === "reviewing" || state?.tag === "submitting" ? state : undefined;
  if (reviewing) return <Layout signedIn><Confirmation snapshot={{ kind: "straight", quote: reviewing.quote }} /><button className="primary-action" disabled={pending} onClick={() => void place()}>{pending ? "Confirming…" : "Place wager"}</button><button disabled={pending} onClick={() => returnToEditor(reviewing.request)}>Edit terms</button>{error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}</Layout>;
  const editor = state?.tag === "editing" ? state.editor : undefined;
  return <Layout signedIn><h1>Odds board</h1><p role="status">Feed status: {board?.feed.status ?? "loading"} — {board?.feed.message}</p>{error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}<label>League <select disabled={pending} value={league} onChange={e => setLeague(e.target.value)}><option value="">All football</option><option value="nfl">NFL</option><option value="ncaaf">NCAA football</option></select></label><label>Date <input disabled={pending} type="date" value={date} onChange={e => setDate(e.target.value)} /></label><label>Market <select disabled={pending} value={market} onChange={e => setMarket(e.target.value)}><option value="">All markets</option><option value="spread">Spread</option><option value="total">Total</option><option value="moneyline">Moneyline</option></select></label><div className="table-scroll"><table><caption>Canonical offers</caption><tbody>{board?.offers.map((offer: any) => <tr key={`${offer.eventId}-${offer.market}`}><td>{offer.awayTeam} at {offer.homeTeam}</td><td>{selectableOutcomes(offer).map((outcome: any) => <button disabled={pending} key={outcome.name} onClick={() => setState({ tag: "editing", editor: fresh({ offer, outcome }) })}>Select {outcome.name} {outcome.point ?? outcome.price}</button>)}</td></tr>)}</tbody></table></div>{editor && <section><h2>Build straight wager</h2><p>{editor.pick.offer.awayTeam} at {editor.pick.offer.homeTeam}: {editor.pick.outcome.name}</p><label>Risk in whole shares <input disabled={pending} type="number" min="1" step="1" value={editor.risk} onChange={e => edit({ ...editor, risk: e.target.value })} /></label><button className="primary-action" disabled={pending || !editor.risk || !view?.activeSeason?.id || !boardEnablesWagerReview(board)} onClick={() => void review()}>{pending ? "Reviewing…" : "Review straight wager"}</button>{(editor.pick.offer.market === "spread" || editor.pick.offer.market === "total") && typeof editor.pick.outcome.point === "number" && <button disabled={pending} onClick={() => addSelectionToTeaser(editor.pick)}>Add selection to teaser</button>}</section>}<p><Link to={`/p/${slug}/teaser`}>Build a teaser</Link> · <Link to={`/p/${slug}/overview`}>Pool overview</Link></p></Layout>;
}

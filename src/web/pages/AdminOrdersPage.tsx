import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, buildShareOrderExecution, commandOutcome, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { Confirmation } from "../components/Confirmation";
import { formatMicros, microsFromDecimal } from "../../domain/fixed-point";
import { projectAdminOrders, type ProjectedOrder } from "./admin-orders-lifecycle";
import type { ReadPoolView, shareOrderQuoteSnapshot } from "../../contracts/http";
import type { z } from "zod";

const display = (value: string, decimals: 2 | 4 | 6 = 2) => formatMicros(BigInt(value), decimals);
type Semantic = { seasonId: string; memberId: string; mode: "shares" | "value"; amount: string; quoteKey: string };
type Quote = z.infer<typeof shareOrderQuoteSnapshot>;
type OrderState =
  | { tag: "editing"; editor: Semantic }
  | { tag: "quoting"; request: Semantic }
  | { tag: "reviewing"; request: Semantic; quote: Quote; memberDisplayName: string; mutationKey: string }
  | { tag: "submitting"; request: Semantic; quote: Quote; memberDisplayName: string; mutationKey: string };
type ReversalState = { tag: "idle" } | { tag: "reviewing"; order: ProjectedOrder; reason: string; idempotencyKey: string } | { tag: "submitting"; order: ProjectedOrder; reason: string; idempotencyKey: string };

const newEditor = (view: ReadPoolView): Semantic | undefined => {
  const season = view.activeSeason;
  if (!season) return undefined;
  return { seasonId: season.id, memberId: view.currentMember.memberId, mode: season.defaultOrderMode ?? "shares", amount: season.defaultOrderAmountMicros ? display(season.defaultOrderAmountMicros, 6) : "", quoteKey: crypto.randomUUID() };
};
const freshEditor = (request: Semantic): Semantic => ({ ...request, quoteKey: crypto.randomUUID() });
/** Stale order execution retires both its quote and execution identities; reversal retry keeps its frozen key. */
export const recoverStaleOrderEditor = (request: Semantic): Semantic => freshEditor(request);
export const retryReversalState = <T extends ReversalState>(state: T): T => state;

export function AdminOrdersPage() {
  const { slug = "" } = useParams(); const nav = useNavigate();
  const [view, setView] = useState<ReadPoolView>(); const [state, setState] = useState<OrderState>();
  const [reversal, setReversal] = useState<ReversalState>({ tag: "idle" }); const [error, setError] = useState(""); const errorRef = useRef<HTMLParagraphElement>(null);
  const loadView = async (initialize = false) => { const next = await api.poolView(slug); setView(next); if (initialize) { const editor = newEditor(next); if (editor) setState({ tag: "editing", editor }); } return next; };
  useEffect(() => { void loadView(true).catch(error => setError(errorMessage(error))); }, [slug]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  if (!view) return <Layout><p role="status">Loading orders…</p></Layout>;
  if (view.currentMember.role !== "commissioner") return <Layout signedIn><h1>Share orders</h1><p role="alert">Only the commissioner can issue or reverse virtual share orders.</p></Layout>;
  const projection = projectAdminOrders(view); const pending = state?.tag === "quoting" || state?.tag === "submitting";
  const editor = state?.tag === "editing" ? state.editor : undefined;
  const returnToEditor = (request: Semantic) => setState({ tag: "editing", editor: recoverStaleOrderEditor(request) });
  const edit = (change: Partial<Semantic>) => { if (!editor) return; setError(""); setState({ tag: "editing", editor: freshEditor({ ...editor, ...change }) }); };
  const quoteOrder = async () => {
    if (!editor) return; let amountMicros: string;
    try { amountMicros = microsFromDecimal(editor.amount).toString(); } catch { setError("Enter a positive share or virtual-value amount"); return; }
    if (!/^\d+$/.test(amountMicros) || BigInt(amountMicros) <= 0n) { setError("Enter a positive share or virtual-value amount"); return; }
    const request = editor; setState({ tag: "quoting", request });
    try {
      const quote = await api.quoteOrder(slug, { seasonId: request.seasonId, memberId: request.memberId, mode: request.mode, amountMicros, idempotencyKey: request.quoteKey });
      const memberDisplayName = view.members.find(member => member.memberId === request.memberId)?.displayName;
      if (!memberDisplayName) throw new Error("Selected member is no longer available.");
      setState({ tag: "reviewing", request, quote, memberDisplayName, mutationKey: crypto.randomUUID() });
    } catch (error) { setState({ tag: "editing", editor: request }); setError(errorMessage(error)); }
  };
  const reviewed = state?.tag === "reviewing" || state?.tag === "submitting" ? state : undefined;
  const execute = async () => {
    if (!reviewed || reviewed.tag !== "reviewing") return; setState({ ...reviewed, tag: "submitting" });
    try { await api.placeCommand(slug, "/admin/orders/execute", buildShareOrderExecution(reviewed.quote, reviewed.mutationKey, "Commissioner share issue")); nav(`/p/${slug}/overview`); }
    catch (error) {
      // A stale order response is not a review authority. Retire its keys and require a fresh quote.
      if (commandOutcome(error) === "stale" || commandOutcome(error) === "terminal") returnToEditor(reviewed.request); else setState(reviewed);
      setError(errorMessage(error));
    }
  };
  const reverse = async () => {
    if (reversal.tag !== "reviewing") return;
    if (!reversal.reason.trim()) { setError("Enter a reason for this reversal."); return; }
    const frozen = reversal; setReversal({ ...frozen, tag: "submitting" });
    try { await api.reverseOrder(slug, frozen.order.orderId, { reason: frozen.reason, idempotencyKey: frozen.idempotencyKey }); setReversal({ tag: "idle" }); setError(""); await loadView(false); }
    catch (error) { setReversal(retryReversalState(frozen)); setError(errorMessage(error)); }
  };
  if (reviewed) return <Layout signedIn><Confirmation snapshot={{ kind: "order", quote: reviewed.quote, memberDisplayName: reviewed.memberDisplayName }} /><button className="primary-action" disabled={pending} onClick={() => void execute()}>{pending ? "Confirming…" : "Confirm order"}</button><button disabled={pending} onClick={() => returnToEditor(reviewed.request)}>Edit terms</button>{error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}</Layout>;
  if (reversal.tag !== "idle") return <Layout signedIn><h1>Confirm share-order reversal</h1><p>Reverse the immutable order for {reversal.order.memberDisplayName}: {display(reversal.order.sharesMicros)} shares / {display(reversal.order.valueMicros)} virtual value.</p><label>Reason <input value={reversal.reason} disabled={reversal.tag === "submitting"} onChange={event => setReversal({ ...reversal, reason: event.target.value })} /></label><button className="primary-action" disabled={reversal.tag === "submitting" || !reversal.reason.trim()} onClick={() => void reverse()}>{reversal.tag === "submitting" ? "Confirming…" : "Confirm reversal"}</button><button disabled={reversal.tag === "submitting"} onClick={() => setReversal({ tag: "idle" })}>Cancel</button>{error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}</Layout>;
  return <Layout signedIn><h1>Share orders</h1>{projection.notice && <p role="status">{projection.notice}</p>}{error && <p ref={errorRef} role="alert" tabIndex={-1} className="error-summary">{error}</p>}<label>Member <select disabled={pending || !projection.canOrder} value={editor?.memberId ?? ""} onChange={event => edit({ memberId: event.target.value })}>{view.members.filter(member => member.status === "active").map(member => <option key={member.memberId} value={member.memberId}>{member.displayName}</option>)}</select></label><label>Order form <select disabled={pending || !projection.canOrder} value={editor?.mode ?? "shares"} onChange={event => edit({ mode: event.target.value as "shares" | "value" })}><option value="shares">Shares</option><option value="value">Virtual value</option></select></label><label>Amount <input disabled={pending || !projection.canOrder} value={editor?.amount ?? ""} onChange={event => edit({ amount: event.target.value })} /></label><button className="primary-action" disabled={pending || !editor?.amount || !projection.canOrder} onClick={() => void quoteOrder()}>{pending ? "Quoting…" : "Quote order"}</button><section><h2>Immutable order history</h2>{projection.seasons.length ? projection.seasons.map(season => <section key={season.seasonId}>{season.readOnly && <p>Read-only closed-season record</p>}<table><tbody>{season.orders.map(order => <tr key={order.orderId}><td>{order.memberDisplayName}</td><td>{display(order.sharesMicros)} / {display(order.valueMicros)}</td><td>{display(order.priceMicros, 4)}</td><td>{order.reversalStatus ?? ""}</td><td>{order.reason}</td><td>{order.reversible && <button onClick={() => { setError(""); setReversal({ tag: "reviewing", order, reason: "", idempotencyKey: crypto.randomUUID() }); }}>Reverse with reason</button>}</td></tr>)}</tbody></table></section>) : <p>No share orders have been issued.</p>}</section><p><Link to={`/p/${slug}/overview`}>Pool overview</Link></p></Layout>;
}

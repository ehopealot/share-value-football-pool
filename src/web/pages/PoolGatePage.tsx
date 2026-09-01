import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { acquireTurnstileToken, api, ApiError, TurnstileClientError, type PoolGate } from "../api";
import { Layout } from "../components/Layout";
import { ErrorSummary, StateNotice } from "../components/Status";
const joinErrorMessage = (error: unknown) => {
  if (error instanceof TurnstileClientError || error instanceof ApiError && error.code === "TURNSTILE_REJECTED") return "The anti-abuse check did not complete. Check your connection and try again.";
  if (error instanceof ApiError && error.code === "RATE_LIMITED") return "Too many join attempts were made. Wait before trying again or ask the commissioner for help.";
  if (error instanceof ApiError && (error.code === "POOL_UNAVAILABLE" || error.code === "POOL_NOT_AVAILABLE") || !(error instanceof ApiError)) return "The pool service is temporarily unavailable. Your password was not changed; try again shortly.";
  if (error instanceof ApiError && (error.code === "INVALID_PASSWORD" || error.code === "FORBIDDEN" || error.code === "JOIN_DENIED")) return "The password was not accepted or signup is no longer available. Check with the commissioner and try again.";
  return "We could not join this pool. Keep the entered password and try again.";
};

export function PoolGatePage() {
  const { slug = "" } = useParams(); const nav = useNavigate(); const turnstileTarget = useRef<HTMLDivElement>(null); const [gate, setGate] = useState<PoolGate>(); const [signedIn, setSignedIn] = useState(false); const [error, setError] = useState(""); const [pending, setPending] = useState(false); const commandId = useRef(crypto.randomUUID());
  useEffect(() => { void api.gate(slug).then((result) => { setSignedIn(true); if (result.membership === "member") nav(`/p/${slug}/odds`, { replace: true }); else setGate(result); }).catch((e: ApiError) => { if (e.status === 401) nav(`/login?next=${encodeURIComponent(`/p/${slug}`)}`, { replace: true }); else setError("This private pool is unavailable. Return home and try again."); }); }, [nav, slug]);
  const join = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); setPending(true); setError(""); try { await api.joinPool(slug, String(new FormData(e.currentTarget).get("password")), commandId.current, { turnstileToken: await acquireTurnstileToken(turnstileTarget.current) }); commandId.current = crypto.randomUUID(); nav(`/p/${slug}/odds`); } catch (error) { setError(joinErrorMessage(error)); } finally { setPending(false); } };
  if (!gate && !error) return <Layout signedIn={signedIn}><p role="status">Loading pool entry…</p></Layout>;
  if (gate?.membership === "closed") return <Layout signedIn={signedIn}><h1>Pool entry</h1><StateNotice title="This pool is not accepting members"><p>Ask the commissioner if you need access. No pool information is available here.</p><Link to="/">Return home</Link></StateNotice></Layout>;
  return <Layout signedIn={signedIn}><h1>Join {gate?.membership === "joinable" ? gate.poolName : "this pool"}</h1><ErrorSummary message={error}/>{gate?.membership === "joinable" ? <form onSubmit={join} aria-busy={pending}><p><label>Pool password<br/><input name="password" type="password" minLength={8} required autoComplete="current-password" disabled={pending} onChange={() => { commandId.current = crypto.randomUUID(); }}/></label></p><div ref={turnstileTarget}/><button className="primary-action" disabled={pending}>{pending ? "Joining pool…" : "Join pool"}</button><p>Joining adds no shares. A commissioner issues any starting shares.</p></form> : <StateNotice title="Pool entry unavailable"><Link to="/">Return home</Link></StateNotice>}</Layout>;
}

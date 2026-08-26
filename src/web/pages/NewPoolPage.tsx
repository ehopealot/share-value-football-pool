import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { acquireTurnstileToken, api, ApiError, TurnstileClientError } from "../api";
import { Layout } from "../components/Layout";
import { ErrorSummary, StateNotice } from "../components/Status";

export function NewPoolPage() {
  const nav = useNavigate(); const location = useLocation(); const turnstileTarget = useRef<HTMLDivElement>(null); const [authorized, setAuthorized] = useState<boolean>(); const [error, setError] = useState(""); const [pending, setPending] = useState(false); const commandId = useRef(crypto.randomUUID());
  useEffect(() => { void api.session().then(({ user }) => { if (!user) nav(`/login?next=${encodeURIComponent("/pools/new")}`, { replace: true }); else setAuthorized(true); }).catch(() => setAuthorized(false)); }, [nav]);
  const resetCommand = () => { commandId.current = crypto.randomUUID(); };
  const submit = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); setPending(true); setError(""); const data = new FormData(e.currentTarget); try { const result = await api.createPool({ poolName: String(data.get("poolName")), slug: String(data.get("slug")).toLowerCase(), password: String(data.get("password")), idempotencyKey: commandId.current, turnstileToken: await acquireTurnstileToken(turnstileTarget.current) }); commandId.current = crypto.randomUUID(); nav(`/p/${result.slug}`); } catch (error) { setError(error instanceof TurnstileClientError || error instanceof ApiError && error.code === "TURNSTILE_REJECTED" ? "Pool creation is unavailable until the anti-abuse check succeeds. Check your connection and try again." : "We could not create that pool. Keep the details and try again."); } finally { setPending(false); } };
  if (authorized === undefined) return <Layout><p role="status">Loading account…</p></Layout>;
  if (!authorized) return <Layout><StateNotice title="Account unavailable"><p>Log in to create a pool.</p></StateNotice></Layout>;
  return <Layout signedIn><h1>Create a pool</h1><p>Choose a private name, web address, and join password. Members start with zero shares.</p><ErrorSummary message={error}/><form onSubmit={submit} aria-busy={pending}><p><label>Pool name<br/><input name="poolName" maxLength={100} required disabled={pending} onChange={resetCommand}/></label></p><p><label>Pool web address<br/><input name="slug" pattern="[a-zA-Z0-9-]{3,64}" required aria-describedby="slug-help" disabled={pending} onChange={resetCommand}/></label> <span id="slug-help">Use letters, numbers, and hyphens.</span></p><p><label>Join password<br/><input name="password" type="password" minLength={8} required autoComplete="new-password" disabled={pending} onChange={resetCommand}/></label></p><div ref={turnstileTarget}/><button className="primary-action" disabled={pending}>{pending ? "Creating pool…" : "Create pool"}</button></form></Layout>;
}

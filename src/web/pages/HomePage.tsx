import { Link, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { api, onSessionInvalidated, type Membership } from "../api";
import { Layout } from "../components/Layout";
import { ErrorSummary, StateNotice } from "../components/Status";

type User = { name: string } | null | undefined;
type HomeLoad = { user: User; memberships?: Membership[]; error: string };

/** Fences async reads that began before a session transition. */
export class HomeLoadGeneration {
  private generation = 0;
  start() { return ++this.generation; }
  invalidate(): HomeLoad { ++this.generation; return { user: null, error: "" }; }
  current(generation: number) { return generation === this.generation; }
}

/** Each retry starts a fresh session-first read so stale memberships cannot survive logout. */
export async function loadHome(): Promise<HomeLoad> {
  try {
    const session = await api.session();
    if (!session.user) return { user: null, error: "" };
    try { return { user: session.user, memberships: (await api.memberships()).memberships, error: "" }; }
    catch { return { user: session.user, error: "We could not load your pool list. Try again from Home." }; }
  } catch { return { user: null, error: "We could not load your account. Try again from Home." }; }
}
export function HomePage() {
  const nav = useNavigate(); const [joinSlug, setJoinSlug] = useState("");
  const [user, setUser] = useState<User>(); const [memberships, setMemberships] = useState<Membership[]>(); const [error, setError] = useState(""); const [reload, setReload] = useState(0); const loads = useState(() => new HomeLoadGeneration())[0];
  useEffect(() => onSessionInvalidated(() => {
    // Privacy boundary: remove prior account/pool data in this synchronous event turn.
    const signedOut = loads.invalidate(); setUser(signedOut.user); setMemberships(signedOut.memberships); setError(signedOut.error); setReload((version) => version + 1);
  }), [loads]);
  useEffect(() => {
    const generation = loads.start();
    setUser(undefined); setMemberships(undefined); setError("");
    void loadHome().then((result) => {
      if (!loads.current(generation)) return;
      setUser(result.user);
      setMemberships(result.memberships);
      setError(result.error);
    });
  }, [reload, loads]);
  const retry = () => setReload((version) => version + 1);
  const joinByAddress = (event: import("react").FormEvent<HTMLFormElement>) => { event.preventDefault(); const slug = joinSlug.trim().toLowerCase().replace(/^\/p\//, ""); if (slug) nav(`/p/${encodeURIComponent(slug)}`); };
  if (user === undefined) return <Layout><p role="status">Loading account…</p></Layout>;
  if (!user) return <Layout><h1>Private football pool</h1><ErrorSummary message={error}/><p>Run a private season with virtual shares and clear, locked terms. No payments or cash value are involved.</p><p><Link className="primary-action" to="/sign-up">Create account</Link> <Link className="secondary-action" to="/login">Log in</Link></p></Layout>;
  if (memberships === undefined && !error) return <Layout><h1>Your pools</h1><p role="status">Loading pool memberships…</p></Layout>;
  if (error) return <Layout><h1>Your pools</h1><ErrorSummary message={error}/><StateNotice title="Pool list unavailable"><p>Your account is still signed in. Return to a pool link or try Home again.</p><button type="button" onClick={retry}>Reload Home</button></StateNotice></Layout>;
  return <Layout><h1>Your pools</h1>{memberships!.length ? <><section className="table-ribbon-section"><h2 className="table-ribbon">Your active memberships</h2><table><thead><tr><th scope="col">Pool</th><th scope="col">Role</th></tr></thead><tbody>{memberships!.map((pool) => <tr key={pool.poolId}><td><Link to={`/p/${pool.slug}`}>{pool.poolName}</Link></td><td>{pool.role}</td></tr>)}</tbody></table></section><p><Link className="primary-action" to="/pools/new">Create a pool</Link></p></> : <StateNotice title="No pools yet"><p>Create a pool or join one with its private address.</p><Link className="primary-action" to="/pools/new">Create a pool</Link></StateNotice>}
    <section aria-label="Join a pool"><h2>Join a pool</h2><form onSubmit={joinByAddress} className="join-pool-form"><label htmlFor="pool-name">Pool name</label><div className="join-pool-controls"><input id="pool-name" value={joinSlug} onChange={(event) => setJoinSlug(event.target.value)} placeholder="e.g. sunday-squares" autoComplete="off" required/><button type="submit">Join pool</button></div></form><p>Enter the pool name your commissioner shared. You will enter the pool password on the next screen.</p></section></Layout>;
}

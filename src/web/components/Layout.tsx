import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router";
import { api, invalidateSession, onPoolViewInvalidated, onSessionInvalidated } from "../api";
import type { ReadPoolView } from "../../contracts/http";

/** Prevents superseded pool-view reads from restoring stale navigation state. */
export class PoolViewLoadGeneration {
  private generation = 0;
  start() { return ++this.generation; }
  invalidate() { ++this.generation; }
  current(generation: number) { return generation === this.generation; }
}

/** Navigation is derived from the server session, never from a route's caller. */
export function PoolNavigation({ slug, view }: { slug: string; view: ReadPoolView }) {
  return <><NavLink to={`/p/${slug}/overview`}>{view.pool.name}</NavLink><NavLink to={`/p/${slug}/odds`}>Odds board</NavLink><NavLink to={`/p/${slug}/my-wagers`}>My bets</NavLink><NavLink to={`/p/${slug}/standings`}>Standings</NavLink><NavLink to={`/p/${slug}/activity`}>Activity</NavLink><NavLink to={`/p/${slug}/rules`}>Rules</NavLink><NavLink to={`/p/${slug}/board`}>Message board{view.currentMember.hasUnreadBoard && <><span aria-hidden="true"> </span><span className="nav-new">New</span></>}</NavLink></>;
}

export function Layout({ children }: { children: React.ReactNode; signedIn?: boolean }) {
  const navigate = useNavigate(); const { slug } = useParams();
  const [signedIn, setSignedIn] = useState<boolean>(); const [refresh, setRefresh] = useState(0); const [poolViewRefresh, setPoolViewRefresh] = useState(0);
  const [view, setView] = useState<ReadPoolView>(); const viewLoads = useState(() => new PoolViewLoadGeneration())[0];
  useEffect(() => onSessionInvalidated(() => { viewLoads.invalidate(); setView(undefined); setRefresh((version) => version + 1); }), [viewLoads]);
  useEffect(() => onPoolViewInvalidated(() => { viewLoads.invalidate(); setView(undefined); setPoolViewRefresh((version) => version + 1); }), [viewLoads]);
  useEffect(() => { void api.session().then(({ user }) => setSignedIn(Boolean(user))).catch(() => setSignedIn(false)); }, [refresh]);
  useEffect(() => {
    const generation = viewLoads.start();
    setView(undefined);
    if (!slug) return;
    let active = true;
    void api.poolView(slug).then((nextView) => { if (active && viewLoads.current(generation)) setView(nextView); }).catch(() => {});
    return () => { active = false; };
  }, [slug, refresh, poolViewRefresh, viewLoads]);
  const logout = async () => { await api.signOut(); setSignedIn(false); invalidateSession(); navigate("/"); };
  return <div className="site-shell">
    <header className="masthead"><p className="site-name">Office Pool Reborn</p></header>
    <nav aria-label="Primary navigation" className="nav-bar"><Link to="/">Home</Link>{signedIn === undefined ? null : signedIn ? <button className="nav-button" onClick={logout}>Log out</button> : <><Link to="/login">Log in</Link><Link to="/sign-up">Create account</Link></>}{signedIn && view && slug && <><span aria-hidden="true">•</span><PoolNavigation slug={slug} view={view}/></>}</nav>
    <main className="main-content">{children}</main>
  </div>;
}

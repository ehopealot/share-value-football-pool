import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router";
import { ApiError, api, invalidateSession, onPoolViewInvalidated, onSessionInvalidated } from "../api";
import type { ReadPoolView } from "../../contracts/http";

/** Prevents superseded pool-view reads from restoring stale navigation state. */
export class PoolViewLoadGeneration {
  private generation = 0;
  start() { return ++this.generation; }
  invalidate() { ++this.generation; }
  current(generation: number) { return generation === this.generation; }
}
/** Session responses must never restore a superseded account identity. */
export class SessionLoadGeneration extends PoolViewLoadGeneration {}

/** Survives per-route Layout remounts, but is cleared on session invalidation and refreshed authoritatively. */
export class PoolNavigationCache {
  private readonly views = new Map<string, ReadPoolView>();
  private signedIn: boolean | undefined;
  private userId: string | undefined;
  get(slug: string) { return this.userId ? this.views.get(slug) : undefined; }
  store(slug: string, view: ReadPoolView) { if (this.userId) this.views.set(slug, view); }
  getSignedIn() { return this.signedIn; }
  setSession(user: { id: string } | undefined) {
    const nextUserId = user?.id;
    const changed = this.userId !== nextUserId;
    if (changed) this.views.clear();
    this.userId = nextUserId;
    this.signedIn = Boolean(user);
    return changed;
  }
  markBoardRead(slug: string) {
    const view = this.get(slug);
    if (!view) return undefined;
    const next = { ...view, currentMember: { ...view.currentMember, hasUnreadBoard: false } };
    this.views.set(slug, next);
    return next;
  }
  clearViews() { this.views.clear(); }
  clear() { this.clearViews(); this.signedIn = undefined; this.userId = undefined; }
}
const poolNavigationCache = new PoolNavigationCache();

/** Navigation is derived from the server session, never from a route's caller. */
export function PoolNavigation({ slug, view }: { slug: string; view: ReadPoolView }) {
  return <><NavLink to={`/p/${slug}/overview`}>{view.pool.name}</NavLink><NavLink to={`/p/${slug}/odds`}>Odds board</NavLink><NavLink to={`/p/${slug}/my-wagers`}>My bets</NavLink><NavLink to={`/p/${slug}/standings`}>Standings</NavLink><NavLink to={`/p/${slug}/activity`}>Activity</NavLink><NavLink to={`/p/${slug}/rules`}>Rules</NavLink><NavLink to={`/p/${slug}/board`}>Message board{view.currentMember.hasUnreadBoard && <><span aria-hidden="true"> </span><span className="nav-new">New</span></>}</NavLink></>;
}

/** A member-authorized notice is informative, not an interrupting live alert. */
export function CommissionerNotice({ notice }: { notice: string }) {
  return <aside className="commissioner-notice" aria-label="Commissioner notice"><strong>Commissioner notice</strong><span>{notice}</span></aside>;
}

export function Layout({ children }: { children: React.ReactNode; signedIn?: boolean }) {
  const navigate = useNavigate(); const { slug } = useParams();
  const [signedIn, setSignedIn] = useState<boolean | undefined>(() => poolNavigationCache.getSignedIn()); const [refresh, setRefresh] = useState(0); const [poolViewRefresh, setPoolViewRefresh] = useState(0);
  const [view, setView] = useState<ReadPoolView | undefined>(() => slug ? poolNavigationCache.get(slug) : undefined); const viewLoads = useState(() => new PoolViewLoadGeneration())[0]; const sessionLoads = useState(() => new SessionLoadGeneration())[0];
  useEffect(() => onSessionInvalidated(() => { poolNavigationCache.clear(); viewLoads.invalidate(); sessionLoads.invalidate(); setSignedIn(false); setView(undefined); setRefresh((version) => version + 1); }), [sessionLoads, viewLoads]);
  useEffect(() => onPoolViewInvalidated(() => { viewLoads.invalidate(); const current = slug ? poolNavigationCache.markBoardRead(slug) : undefined; setView(current); setPoolViewRefresh((version) => version + 1); }), [slug, viewLoads]);
  useEffect(() => {
    const generation = sessionLoads.start();
    let active = true;
    const applySession = (user: { id: string } | undefined) => {
      if (!active || !sessionLoads.current(generation)) return;
      const changed = poolNavigationCache.setSession(user);
      setSignedIn(Boolean(user));
      if (changed) { viewLoads.invalidate(); setView(undefined); setPoolViewRefresh((version) => version + 1); }
    };
    void api.session().then(({ user }) => applySession(user)).catch(() => applySession(undefined));
    return () => { active = false; };
  }, [refresh, sessionLoads, viewLoads]);
  useEffect(() => {
    const generation = viewLoads.start();
    const cached = slug ? poolNavigationCache.get(slug) : undefined;
    setView(cached);
    if (!slug) return;
    let active = true;
    void api.poolView(slug).then((nextView) => { if (active && viewLoads.current(generation)) { poolNavigationCache.store(slug, nextView); setView(nextView); } }).catch((error) => {
      if (!active || !viewLoads.current(generation) || !(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) return;
      poolNavigationCache.clearViews();
      if (error.status === 401) { poolNavigationCache.setSession(undefined); setSignedIn(false); }
      setView(undefined);
    });
    return () => { active = false; };
  }, [slug, refresh, poolViewRefresh, viewLoads]);
  const logout = async () => { await api.signOut(); setSignedIn(false); invalidateSession(); navigate("/"); };
  return <div className="site-shell">
    <header className="masthead"><p className="site-name">Office Pool Reborn</p></header>
    {signedIn && view && slug && view.pool.commissionerNotice !== null && <CommissionerNotice notice={view.pool.commissionerNotice}/>}
    <nav aria-label="Primary navigation" className="nav-bar"><Link to="/">Home</Link>{signedIn === undefined ? null : signedIn ? <button className="nav-button" onClick={logout}>Log out</button> : <><Link to="/login">Log in</Link><Link to="/sign-up">Create account</Link></>}{signedIn && view && slug && <><span aria-hidden="true">•</span><PoolNavigation slug={slug} view={view}/></>}</nav>
    <main className="main-content">{children}</main>
  </div>;
}

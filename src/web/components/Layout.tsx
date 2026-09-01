import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router";
import { api, invalidateSession, onSessionInvalidated } from "../api";

/** Navigation is derived from the server session, never from a route's caller. */
export function Layout({ children }: { children: React.ReactNode; signedIn?: boolean }) {
  const navigate = useNavigate(); const { slug } = useParams();
  const [signedIn, setSignedIn] = useState<boolean>(); const [refresh, setRefresh] = useState(0);
  const [pool, setPool] = useState<import("../../contracts/http").ReadPoolView["pool"]>();
  useEffect(() => onSessionInvalidated(() => setRefresh((version) => version + 1)), []);
  useEffect(() => { void api.session().then(({ user }) => setSignedIn(Boolean(user))).catch(() => setSignedIn(false)); }, [refresh]);
  useEffect(() => { setPool(undefined); if (slug) void api.poolView(slug).then((view) => setPool(view.pool)).catch(() => {}); }, [slug, refresh]);
  const logout = async () => { await api.signOut(); setSignedIn(false); invalidateSession(); navigate("/"); };
  return <div className="site-shell">
    <header className="masthead"><p className="site-name">Office Pool Reborn</p></header>
    <nav aria-label="Primary navigation" className="nav-bar"><Link to="/">Home</Link>{signedIn === undefined ? null : signedIn ? <button className="nav-button" onClick={logout}>Log out</button> : <><Link to="/login">Log in</Link><Link to="/sign-up">Create account</Link></>}{signedIn && pool && slug && <><span aria-hidden="true">•</span><NavLink to={`/p/${slug}/overview`}>{pool.name}</NavLink><NavLink to={`/p/${slug}/odds`}>Odds board</NavLink><NavLink to={`/p/${slug}/my-wagers`}>My bets</NavLink><NavLink to={`/p/${slug}/standings`}>Standings</NavLink><NavLink to={`/p/${slug}/activity`}>Activity</NavLink><NavLink to={`/p/${slug}/rules`}>Rules</NavLink></>}</nav>
    <main className="main-content">{children}</main>
  </div>;
}

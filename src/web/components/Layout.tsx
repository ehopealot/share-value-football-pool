import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, invalidateSession, onSessionInvalidated } from "../api";

/** Navigation is derived from the server session, never from a route's caller. */
export function Layout({ children }: { children: React.ReactNode; signedIn?: boolean }) {
  const navigate = useNavigate(); const [signedIn, setSignedIn] = useState<boolean>(); const [refresh, setRefresh] = useState(0);
  useEffect(() => onSessionInvalidated(() => setRefresh((version) => version + 1)), []);
  useEffect(() => { void api.session().then(({ user }) => setSignedIn(Boolean(user))).catch(() => setSignedIn(false)); }, [refresh]);
  const logout = async () => { await api.signOut(); setSignedIn(false); invalidateSession(); navigate("/"); };
  return <div className="site-shell">
    <header className="masthead"><p className="site-name">Office Pool Reborn</p><p className="site-note">Private football paper trading</p></header>
    <nav aria-label="Primary navigation" className="nav-bar"><Link to="/">Home</Link>{signedIn ? <button className="nav-button" onClick={logout}>Log out</button> : <><Link to="/login">Log in</Link><Link to="/sign-up">Create account</Link></>}</nav>
    <main className="main-content">{children}</main>
  </div>;
}

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { useFrozenAdminCommand } from "../admin-command";
import { Layout } from "../components/Layout";

export function AdminSettingsPage() {
  const { slug = "" } = useParams();
  const [view, setView] = useState<import("../../contracts/http").ReadPoolView>();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const settings = useFrozenAdminCommand<Record<string, unknown>>();
  const load = () => void api.poolView(slug).then((value) => { setView(value); setName(value.pool.name); }).catch((e) => setLoadError(errorMessage(e)));
  useEffect(load, [slug]);
  if (loadError) return <Layout signedIn><h1>Pool settings</h1><p role="alert" tabIndex={-1} className="error-summary">{loadError} <Link to={`/p/${slug}/overview`}>Return to the pool overview</Link>.</p></Layout>;
  if (!view) return <Layout><p role="status">Loading settings…</p></Layout>;
  if (view.currentMember.role !== "commissioner") return <Layout signedIn><h1>Pool settings</h1><p role="alert">Only the commissioner can change pool settings.</p></Layout>;
  const save = async (identity: string, createBody: () => Record<string, unknown>) => {
    setError("");
    try { await settings.run(identity, () => ({ ...createBody(), idempotencyKey: crypto.randomUUID() }), (body) => api.command(slug, "/admin/settings", body)); setPassword(""); load(); }
    catch (e) { setError(errorMessage(e)); }
  };
  const edit = () => { settings.retire(); setError(""); };
  const nextSignups = !view.pool.signupsOpen;
  return <Layout signedIn><h1>Pool settings</h1>{error && <p role="alert" className="error-summary">{error}</p>}
    <label>Pool name <input disabled={settings.pending} value={name} onChange={(e) => { edit(); setName(e.target.value); }} /></label><button disabled={settings.pending} onClick={() => void save("rename", () => ({ poolName: name }))}>Rename pool</button>
    <label>New join password <input disabled={settings.pending} type="password" value={password} onChange={(e) => { edit(); setPassword(e.target.value); }} /></label><button disabled={!password || settings.pending} onClick={() => void save("rotate-password", () => ({ password }))}>Rotate password</button>
    <p>Password rotation requires recent authentication.</p><p>Signups are {view.pool.signupsOpen ? "open" : "closed"}.</p><button disabled={settings.pending} onClick={() => void save(`signups:${nextSignups}`, () => ({ signupsOpen: nextSignups }))}>{view.pool.signupsOpen ? "Close signups" : "Open signups"}</button>
    <p><Link to={`/p/${slug}/overview`}>Pool overview</Link></p>
  </Layout>;
}

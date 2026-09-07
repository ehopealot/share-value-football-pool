import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage, invalidatePoolView } from "../api";
import { MICROS_PER_UNIT } from "../../domain/fixed-point";
import { useFrozenAdminCommand } from "../admin-command";
import { Layout } from "../components/Layout";

export function AdminSettingsPage() {
  const { slug = "" } = useParams();
  const [view, setView] = useState<import("../../contracts/http").ReadPoolView>();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [maxSideBet, setMaxSideBet] = useState("");
  const [commissionerNotice, setCommissionerNotice] = useState("");
  const [commissionerRules, setCommissionerRules] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const settings = useFrozenAdminCommand<Record<string, unknown>>();
  type SettingsSection = "name" | "maxSideBet" | "notice" | "rules";
  const allSettingsSections: SettingsSection[] = ["name", "maxSideBet", "notice", "rules"];
  const hydrate = { name: (value: import("../../contracts/http").ReadPoolView) => setName(value.pool.name), maxSideBet: (value: import("../../contracts/http").ReadPoolView) => setMaxSideBet((BigInt(value.pool.maxSideBetMicros) / MICROS_PER_UNIT).toString()), notice: (value: import("../../contracts/http").ReadPoolView) => setCommissionerNotice((value.pool.commissionerNotice ?? "").toUpperCase()), rules: (value: import("../../contracts/http").ReadPoolView) => setCommissionerRules(value.pool.commissionerRules ?? "") };
  // A post-save refresh rehydrates only the saved section so unrelated drafts survive; the
  // initial load hydrates everything.
  const load = (sections: readonly SettingsSection[] = allSettingsSections) => void api.poolView(slug).then((value) => { setView(value); for (const section of sections) hydrate[section](value); }).catch((e) => setLoadError(errorMessage(e)));
  useEffect(() => { load(); }, [slug]);
  if (loadError) return <Layout><h1>Pool settings</h1><p role="alert" tabIndex={-1} className="error-summary">{loadError} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
  if (!view) return <Layout><p role="status">Loading settings…</p></Layout>;
  if (view.currentMember.role !== "commissioner") return <Layout><h1>Pool settings</h1><p role="alert">Only the commissioner can change pool settings.</p></Layout>;
  const save = async (identity: string, createBody: () => Record<string, unknown>, sections: readonly SettingsSection[] = []) => {
    setError("");
    try { await settings.run(identity, () => ({ ...createBody(), idempotencyKey: crypto.randomUUID() }), (body) => api.command(slug, "/admin/settings", body)); setPassword(""); invalidatePoolView(); load(sections); }
    catch (e) { setError(errorMessage(e)); }
  };
  const edit = () => { settings.retire(); setError(""); };
  const nextSignups = !view.pool.signupsOpen;
  return <Layout><div className="pool-settings">
    <h1>Pool settings</h1>{error && <p role="alert" className="error-summary">{error}</p>}
    <section className="pool-settings-section" aria-labelledby="pool-name-settings-heading">
      <h2 id="pool-name-settings-heading">Pool name</h2>
      <div className="share-order-form">
        <input className="pool-settings-control" aria-labelledby="pool-name-settings-heading" disabled={settings.pending} value={name} onChange={(e) => { edit(); setName(e.target.value); }} />
        <button disabled={settings.pending} onClick={() => void save("rename", () => ({ poolName: name }), ["name"])}>Rename pool</button>
      </div>
    </section>
    <section className="pool-settings-section" aria-labelledby="commissioner-notice-settings-heading">
      <h2 id="commissioner-notice-settings-heading">Commissioner notice</h2>
      <div className="share-order-form pool-settings-notice-controls">
        <div className="pool-settings-notice-field">
          <p id="commissioner-notice-help" className="pool-settings-help">This notice displays in a banner above this pool.</p>
          <textarea id="commissioner-notice" className="commissioner-notice-input" aria-labelledby="commissioner-notice-settings-heading" aria-describedby="commissioner-notice-help" disabled={settings.pending} value={commissionerNotice} maxLength={500} onChange={(e) => { edit(); setCommissionerNotice(e.target.value.toUpperCase().slice(0, 500)); }} />
        </div>
        <button disabled={!commissionerNotice.trim() || settings.pending} onClick={() => void save(`notice:${commissionerNotice}`, () => ({ commissionerNotice }), ["notice"])}>Save notice</button>
        {view.pool.commissionerNotice !== null && <button disabled={settings.pending} onClick={() => void save("clear-notice", () => ({ commissionerNotice: null }), ["notice"])}>Clear notice</button>}
      </div>
    </section>
    <section className="pool-settings-section" aria-labelledby="commissioner-rules-settings-heading">
      <h2 id="commissioner-rules-settings-heading">Commissioner rules</h2>
      <div className="share-order-form pool-settings-notice-controls">
        <div className="pool-settings-notice-field">
          <p id="commissioner-rules-help" className="pool-settings-help">Optional pool-specific rules. These appear on the Rules page when filled in.</p>
          <textarea id="commissioner-rules" className="commissioner-rules-input" aria-labelledby="commissioner-rules-settings-heading" aria-describedby="commissioner-rules-help" disabled={settings.pending} value={commissionerRules} maxLength={4000} onChange={(e) => { edit(); setCommissionerRules(e.target.value); }} />
        </div>
        <button disabled={!commissionerRules.trim() || settings.pending} onClick={() => void save(`rules:${commissionerRules}`, () => ({ commissionerRules }), ["rules"])}>Save rules</button>
        {view.pool.commissionerRules !== null && <button disabled={settings.pending} onClick={() => void save("clear-rules", () => ({ commissionerRules: null }), ["rules"])}>Clear rules</button>}
      </div>
    </section>
    <section className="pool-settings-section" aria-labelledby="join-password-settings-heading">
      <h2 id="join-password-settings-heading">Change join password</h2>
      <div className="share-order-form">
        <input className="pool-settings-control" aria-labelledby="join-password-settings-heading" disabled={settings.pending} type="password" value={password} onChange={(e) => { edit(); setPassword(e.target.value); }} />
        <button disabled={!password || settings.pending} onClick={() => void save("rotate-password", () => ({ password }))}>Rotate password</button>
      </div>
      <p className="pool-settings-help">Password changes require a recent sign-in.</p>
    </section>
    <section className="pool-settings-section" aria-labelledby="max-bet-settings-heading">
      <h2 id="max-bet-settings-heading">Max bet per side</h2>
      <div className="share-order-form">
        <input className="pool-settings-control" aria-labelledby="max-bet-settings-heading" disabled={settings.pending} type="number" min="1" step="1" value={maxSideBet} onChange={(e) => { edit(); setMaxSideBet(e.target.value); }} />
        <button disabled={!/^\d+$/.test(maxSideBet) || BigInt(maxSideBet || "0") < 1n || settings.pending} onClick={() => void save(`max-side-bet:${maxSideBet}`, () => ({ maxSideBet }), ["maxSideBet"])}>Save max bet</button>
      </div>
      <p className="pool-settings-help">Teaser and parlay risk is split evenly across their original legs for this limit.</p>
    </section>
    <section className="pool-settings-section" aria-labelledby="signups-settings-heading">
      <h2 id="signups-settings-heading">Signups</h2>
      <div className="share-order-form pool-settings-signups">
        <p>Signups are {view.pool.signupsOpen ? "open" : "closed"}.</p>
        <button disabled={settings.pending} onClick={() => void save(`signups:${nextSignups}`, () => ({ signupsOpen: nextSignups }))}>{view.pool.signupsOpen ? "Close signups" : "Open signups"}</button>
      </div>
    </section>
    <p className="pool-settings-return"><Link to={`/p/${slug}/overview`}>Pool home</Link></p>
  </div></Layout>;
}

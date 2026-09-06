import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { useFrozenAdminCommand } from "../admin-command";
import { Layout } from "../components/Layout";

export function AdminMembersPage() {
  const { slug = "" } = useParams();
  const [view, setView] = useState<import("../../contracts/http").ReadPoolView>();
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const memberCommand = useFrozenAdminCommand<Record<string, unknown>>();
  const load = () => void api.poolView(slug).then(setView).catch((e) => setLoadError(errorMessage(e)));
  useEffect(load, [slug]);
  if (loadError) return <Layout><h1>Member administration</h1><p role="alert" tabIndex={-1} className="error-summary">{loadError} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
  if (!view) return <Layout><p role="status">Loading members…</p></Layout>;
  if (view.currentMember.role !== "commissioner") return <Layout><h1>Member administration</h1><p role="alert">Only the commissioner can manage members.</p></Layout>;
  const command = async (identity: string, path: string, createBody: () => Record<string, unknown>) => {
    setError("");
    try { await memberCommand.run(identity, createBody, (body) => api.command(slug, path, body)); load(); }
    catch (e) { setError(errorMessage(e)); }
  };
  return <Layout><h1>Member administration</h1>{error && <p role="alert" className="error-summary">{error}</p>}
    <section className="table-ribbon-section"><h2 className="table-ribbon">Active and suspended members</h2><table><tbody>{view.members.map((member) => {
      const statusAction = member.status === "active" ? "suspend" : "restore";
      return <tr key={member.memberId}><th scope="row">{member.displayName}</th><td>{member.role}</td><td>{member.status}</td><td>{member.memberId !== view.currentMember.memberId && <button disabled={memberCommand.pending} onClick={() => void command(`${statusAction}:${member.memberId}`, `/admin/members/${member.memberId}/${statusAction}`, () => ({ idempotencyKey: crypto.randomUUID() }))}>{statusAction === "suspend" ? "Suspend" : "Restore"}</button>}</td><td>{member.role !== "commissioner" && member.status === "active" && <button disabled={memberCommand.pending} onClick={() => void command(`transfer:${member.memberId}`, "/admin/transfer", () => ({ memberId: member.memberId, reason: "Commissioner transfer", idempotencyKey: crypto.randomUUID() }))}>Make commissioner</button>}</td></tr>;
    })}</tbody></table></section>
    <p>Changing commissioners requires a recent sign-in.</p><Link to={`/p/${slug}/overview`}>Pool home</Link>
  </Layout>;
}

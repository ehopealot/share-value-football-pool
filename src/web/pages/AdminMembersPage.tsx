import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { useFrozenAdminCommand } from "../admin-command";
import { Layout } from "../components/Layout";
import type { ReadPoolView } from "../../contracts/http";

type Member = ReadPoolView["members"][number];
type MemberConfirmationAction = "suspend" | "transfer";
type MemberConfirmation = { tag: "idle" } | { tag: "reviewing"; member: Member; action: MemberConfirmationAction; idempotencyKey: string } | { tag: "submitting"; member: Member; action: MemberConfirmationAction; idempotencyKey: string };

export function AdminMembersPage() {
  const { slug = "" } = useParams();
  return <AdminMembersPageBody key={slug} slug={slug}/>;
}

export function AdminMembersPageBody({ slug }: { slug: string }) {
  const [view, setView] = useState<ReadPoolView>();
  const [confirmation, setConfirmation] = useState<MemberConfirmation>({ tag: "idle" });
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const memberCommand = useFrozenAdminCommand<Record<string, unknown>>();
  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (confirmation.tag === "reviewing") confirmationHeading.current?.focus(); }, [confirmation.tag]);
  const load = async () => {
    setLoadError("");
    try { setView(await api.poolView(slug)); }
    catch (e) { setLoadError(errorMessage(e)); }
  };
  useEffect(() => { void load(); }, [slug]);
  if (loadError) return <Layout><h1>Member administration</h1><p role="alert" tabIndex={-1} className="error-summary">{loadError} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
  if (!view) return <Layout><p role="status">Loading members…</p></Layout>;
  if (view.currentMember.role !== "commissioner") return <Layout><h1>Member administration</h1><p role="alert">Only the commissioner can manage members.</p></Layout>;
  const command = async (identity: string, path: string, createBody: () => Record<string, unknown>) => {
    if (memberCommand.pending) return;
    setError("");
    try { await memberCommand.run(identity, createBody, (body) => api.command(slug, path, body)); await load(); }
    catch (e) { setError(errorMessage(e)); }
  };
  const beginConfirmation = (member: Member, action: MemberConfirmationAction) => {
    if (memberCommand.pending) return;
    setError("");
    setConfirmation({ tag: "reviewing", member, action, idempotencyKey: crypto.randomUUID() });
  };
  const confirmMemberAction = async () => {
    if (confirmation.tag !== "reviewing" || memberCommand.pending) return;
    const review = confirmation;
    const path = review.action === "transfer" ? "/admin/transfer" : `/admin/members/${review.member.memberId}/suspend`;
    const body = () => review.action === "transfer"
      ? { memberId: review.member.memberId, reason: "Commissioner transfer", idempotencyKey: review.idempotencyKey }
      : { idempotencyKey: review.idempotencyKey };
    setError("");
    setConfirmation({ ...review, tag: "submitting" });
    try {
      await memberCommand.run(`${review.action}:${review.member.memberId}`, body, (request) => api.command(slug, path, request));
      await load();
      setConfirmation({ tag: "idle" });
    } catch (e) {
      setConfirmation(review);
      setError(errorMessage(e));
    }
  };
  const cancelConfirmation = () => {
    if (confirmation.tag === "submitting") return;
    memberCommand.retire();
    setError("");
    setConfirmation({ tag: "idle" });
  };
  if (confirmation.tag !== "idle") {
    const transfer = confirmation.action === "transfer";
    const submitting = confirmation.tag === "submitting";
    return <Layout><h1 ref={confirmationHeading} tabIndex={-1}>{transfer ? "Confirm commissioner transfer" : "Confirm member suspension"}</h1><p>{transfer ? <>Make {confirmation.member.displayName} the commissioner?</> : <>Suspend {confirmation.member.displayName}?</>}</p>{transfer ? <p>You will lose commissioner access after this transfer.</p> : <p>Suspending this member prevents them from accessing this pool.</p>}{transfer && <p>Changing commissioners requires a recent sign-in.</p>}<div className="confirmation-actions"><button className="primary-action" disabled={submitting} onClick={() => void confirmMemberAction()}>{submitting ? "Confirming…" : transfer ? "Confirm transfer" : "Confirm suspension"}</button><button disabled={submitting} onClick={cancelConfirmation}>Cancel</button></div>{error && <p role="alert" className="error-summary">{error}</p>}</Layout>;
  }
  const actionDisabled = memberCommand.pending;
  return <Layout><h1>Member administration</h1>{error && <p role="alert" className="error-summary">{error}</p>}
    <section className="table-ribbon-section"><h2 className="table-ribbon">Active and suspended members</h2><div className="table-scroll" tabIndex={0}><table className="admin-members-table"><thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="colgroup" colSpan={2}>Actions</th></tr></thead><tbody>{view.members.map((member) => {
      const statusAction = member.status === "active" ? "suspend" : "restore";
      return <tr key={member.memberId}><th scope="row">{member.displayName}</th><td className="admin-member-email">{member.email ?? "—"}</td><td>{member.role}</td><td>{member.status}</td><td>{member.memberId !== view.currentMember.memberId && (statusAction === "suspend" ? <button className="admin-member-action" disabled={actionDisabled} onClick={() => beginConfirmation(member, "suspend")}>Suspend</button> : <button className="admin-member-action" disabled={actionDisabled} onClick={() => void command(`restore:${member.memberId}`, `/admin/members/${member.memberId}/restore`, () => ({ idempotencyKey: crypto.randomUUID() }))}>Restore</button>)}</td><td>{member.role !== "commissioner" && member.status === "active" && <button className="admin-member-action" disabled={actionDisabled} onClick={() => beginConfirmation(member, "transfer")}>Make commissioner</button>}</td></tr>;
    })}</tbody></table></div></section>
    <p>Changing commissioners requires a recent sign-in.</p><Link to={`/p/${slug}/overview`}>Pool home</Link>
  </Layout>;
}

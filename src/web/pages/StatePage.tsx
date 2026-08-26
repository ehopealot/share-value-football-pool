import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api";
import { Layout } from "../components/Layout";
import { StateNotice } from "../components/Status";

/** The temporary overview is still a member-only entry point, never client-asserted membership. */
export function PoolOverviewPlaceholder() {
  const { slug = "" } = useParams(); const nav = useNavigate(); const [allowed, setAllowed] = useState<boolean>();
  useEffect(() => { void api.gate(slug).then((gate) => {
    if (gate.membership === "member") setAllowed(true); else nav(`/p/${slug}`, { replace: true });
  }).catch((error: ApiError) => {
    if (error.status === 401) nav(`/login?next=${encodeURIComponent(`/p/${slug}/overview`)}`, { replace: true }); else setAllowed(false);
  }); }, [nav, slug]);
  if (allowed === undefined) return <Layout><p role="status">Checking pool access…</p></Layout>;
  if (!allowed) return <Layout><StateNotice title="Pool access unavailable"><p>Return to your pool list or ask the commissioner for access.</p><Link to="/">Your pools</Link></StateNotice></Layout>;
  return <Layout signedIn><h1>Pool entry confirmed</h1><StateNotice title="Pool pages are being prepared"><p>Your membership is confirmed. Return to the home page while this pool's season and odds pages are available.</p><Link to="/">Your pools</Link></StateNotice></Layout>;
}
export function NotFoundPage() { return <Layout><h1>Page not found</h1><p>The address may be incomplete.</p><Link to="/">Return home</Link></Layout>; }

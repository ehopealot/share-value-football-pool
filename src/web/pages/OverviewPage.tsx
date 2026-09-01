import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { divideRoundHalfEven, formatMicros, parseIntegerText } from "../../domain/fixed-point";

const shares = (value: string) => formatMicros(parseIntegerText(value), 2);

export function OverviewPage() {
  const { slug = "" } = useParams();
  const nav = useNavigate();
  const [view, setView] = useState<import("../../contracts/http").ReadPoolView>();
  const [error, setError] = useState("");
  const [nickname, setNickname] = useState("");
  const [nicknameNotice, setNicknameNotice] = useState("");
  const [nicknameError, setNicknameError] = useState("");
  const [nicknamePending, setNicknamePending] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const load = async () => {
    const fresh = await api.poolView(slug);
    setView(fresh);
    setNickname(fresh.members.find((member) => member.memberId === fresh.currentMember.memberId)?.displayName ?? "");
  };

  useEffect(() => {
    void load().catch((reason: ApiError) => {
      if (reason.status === 401) nav(`/login?next=${encodeURIComponent(`/p/${slug}/overview`)}`);
      else setError(errorMessage(reason));
    });
  }, [slug, nav]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const saveNickname = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const displayName = nickname.trim();
    if (!displayName) return setNicknameError("A pool nickname is required.");
    setNicknamePending(true); setNicknameError(""); setNicknameNotice("");
    try {
      await api.updateNickname(slug, displayName, crypto.randomUUID());
      await load();
      setNicknameNotice("Pool nickname saved.");
    } catch (reason) {
      setNicknameError(errorMessage(reason));
    } finally {
      setNicknamePending(false);
    }
  };

  if (error) return <Layout signedIn><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{error} <Link to="/">Return home</Link>.</p></Layout>;
  if (!view) return <Layout><p role="status">Loading pool…</p></Layout>;

  const commissioner = view.currentMember.role === "commissioner";
  const season = view.activeSeason ?? view.nextDraftSeason;
  const balance = view.currentMember.seasonBalances.find((item) => item.seasonId === season?.id) ?? { availableMicros: "0", lockedMicros: "0" };
  const price = season && BigInt(season.floatMicros) !== 0n ? formatMicros(divideRoundHalfEven(parseIntegerText(season.notionalValueMicros) * 1000000n, parseIntegerText(season.floatMicros)), 4) : "1.0000";

  return <Layout signedIn><h1>{view.pool.name}</h1>
    {season && <p className="pool-context">{view.pool.name} · {season.label} ({season.state})</p>}
    {commissioner && <nav className="pool-nav" aria-label="Commissioner navigation"><Link to={`/p/${slug}/admin/season`}>Season</Link><Link to={`/p/${slug}/admin/orders`}>Share orders</Link><Link to={`/p/${slug}/admin/members`}>Members</Link><Link to={`/p/${slug}/admin/corrections`}>Corrections</Link><Link to={`/p/${slug}/admin/settings`}>Settings</Link></nav>}
    <table><caption>Current account</caption><tbody><tr><th scope="row">Available shares</th><td>{shares(balance.availableMicros)}</td></tr><tr><th scope="row">Locked shares</th><td>{shares(balance.lockedMicros)}</td></tr><tr><th scope="row">Season</th><td>{season ? `${season.label} (${season.state})` : "No active season"}</td></tr>{season && <><tr><th scope="row">Season float</th><td>{shares(season.floatMicros)} shares</td></tr><tr><th scope="row">Notional value</th><td>{shares(season.notionalValueMicros)}</td></tr><tr><th scope="row">Share price</th><td>{price} per share</td></tr></>}</tbody></table>
    <section className="pool-nickname" aria-labelledby="pool-nickname-heading"><h2 id="pool-nickname-heading">Pool nickname</h2><p>This name appears to the other members of this pool.</p><form onSubmit={(event) => void saveNickname(event)} aria-busy={nicknamePending}><label>Nickname <input value={nickname} maxLength={100} disabled={nicknamePending} onChange={(event) => setNickname(event.target.value)} /></label><button className="primary-action" disabled={nicknamePending}>{nicknamePending ? "Saving…" : "Save nickname"}</button></form>{nicknameNotice && <p role="status">{nicknameNotice}</p>}{nicknameError && <p role="alert" className="error-summary">{nicknameError}</p>}</section>
    {!season && <p>No active season. {commissioner ? <Link to={`/p/${slug}/admin/season`}>Create a season</Link> : "Wait for the commissioner to open one."}</p>}
    {view.nextDraftSeason && <p role="status">Draft {view.nextDraftSeason.label} is ready to configure and open.</p>}
    {view.latestClosedSeason && <p role="status">Latest closed season: <Link to={`/p/${slug}/history/${view.latestClosedSeason.id}`}>{view.latestClosedSeason.label}</Link></p>}
    <Link className="primary-action" to={`/p/${slug}/odds`}>View odds board</Link>
  </Layout>;
}

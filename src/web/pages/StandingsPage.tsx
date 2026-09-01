import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { formatMicros, parseIntegerText } from "../../domain/fixed-point";
const shares = (v: string, d: 2 | 4 = 2) => formatMicros(parseIntegerText(v), d);
export function StandingsPage() { const { slug = "" } = useParams(); const [data, setData] = useState<import("../../contracts/http").ReadStandings>(); const [error, setError] = useState(""); const errorRef = useRef<HTMLParagraphElement>(null);
 useEffect(() => { void api.standings(slug).then(setData).catch((e) => setError(errorMessage(e))); }, [slug]); useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
 if (error) return <Layout signedIn><h1>Standings</h1><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{error} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
 if (!data) return <Layout><p role="status">Loading standings…</p></Layout>; return <Layout signedIn><div className="standings-page"><h1>Standings</h1>{data.standings.length ? <div className="table-scroll" tabIndex={0}><table><caption>Active season holdings</caption><thead><tr><th>Rank</th><th>Member</th><th>Available</th><th>Locked</th><th>Total</th><th>Notional value</th><th>Gain</th></tr></thead><tbody>{data.standings.map((row) => <tr key={row.userId}><td>{row.rank}</td><th scope="row">{row.displayName}</th><td>{shares(row.availableMicros)}</td><td>{shares(row.lockedMicros)}</td><td>{shares(row.totalMicros)}</td><td>{shares(row.notionalValueMicros)}</td><td>{shares(row.gainMicros)}</td></tr>)}</tbody></table></div> : <p className="state-notice">No active season standings yet. The commissioner can open a season before holdings appear.</p>}<Link to={`/p/${slug}/overview`}>Pool home</Link></div></Layout>; }

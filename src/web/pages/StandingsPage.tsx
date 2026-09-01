import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { formatMicros, parseIntegerText } from "../../domain/fixed-point";
import { formatCurrentShareValue } from "../share-value";

const shares = (value: string, decimals: 2 | 4 = 2) => formatMicros(parseIntegerText(value), decimals);

export function StandingsPage() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<import("../../contracts/http").ReadStandings>();
  const [view, setView] = useState<import("../../contracts/http").ReadPoolView>();
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    void Promise.all([api.standings(slug), api.poolView(slug)]).then(([standings, poolView]) => { setData(standings); setView(poolView); }).catch((reason) => setError(errorMessage(reason)));
  }, [slug]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  if (error) return <Layout signedIn><h1>Standings</h1><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{error} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
  if (!data || !view) return <Layout><p role="status">Loading standings…</p></Layout>;

  const shareValue = view.activeSeason ? formatCurrentShareValue(view.activeSeason.floatMicros, view.activeSeason.notionalValueMicros) : "$0.00";
  const noIssuedShares = !view.activeSeason || parseIntegerText(view.activeSeason.floatMicros) === 0n;
  return <Layout signedIn><div className="standings-page"><h1>Standings</h1><p className="pool-context">Current share value: <strong>{shareValue}</strong>{noIssuedShares && <> · No shares issued yet; first order price is $1.00 per share.</>}</p>
    {data.standings.length ? <div className="table-scroll" tabIndex={0}><table><caption>Active season holdings</caption><thead><tr><th>Rank</th><th>Member</th><th>Available</th><th>Locked</th><th>Total</th><th>Notional value</th><th>Gain</th></tr></thead><tbody>{data.standings.map((row) => <tr key={row.userId}><td>{row.rank}</td><th scope="row">{row.displayName}</th><td>{shares(row.availableMicros)}</td><td>{shares(row.lockedMicros)}</td><td>{shares(row.totalMicros)}</td><td>{shares(row.notionalValueMicros)}</td><td>{shares(row.gainMicros)}</td></tr>)}</tbody></table></div> : <p className="state-notice">No active season standings yet. The commissioner can open a season before holdings appear.</p>}
    <Link to={`/p/${slug}/overview`}>Pool home</Link>
  </div></Layout>;
}

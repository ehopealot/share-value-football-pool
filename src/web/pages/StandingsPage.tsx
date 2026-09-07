import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { formatMicros, parseIntegerText } from "../../domain/fixed-point";
import { formatCurrentShareValue } from "../share-value";

const shares = (value: string, decimals: 2 | 4 = 2) => formatMicros(parseIntegerText(value), decimals);
type Standings = import("../../contracts/http").ReadStandings["standings"];

export type StandingsSortKey = "rank" | "displayName" | "lockedMicros" | "totalMicros" | "notionalValueMicros" | "gainMicros" | "riskedMicros";
export type StandingsSort = { key: StandingsSortKey; ascending: boolean };
/** Rank order is the server's authoritative gain-ranked order and the table's default. */
export const defaultStandingsSort: StandingsSort = { key: "rank", ascending: true };

/** Text columns start ascending on first click; numeric holdings default to biggest-first. */
export function toggleStandingsSort(current: StandingsSort, key: StandingsSortKey): StandingsSort {
  return current.key !== key ? { key, ascending: key === "rank" || key === "displayName" } : { key, ascending: !current.ascending };
}

export function sortStandings(standings: Standings, sort: StandingsSort): Standings {
  const value = (row: Standings[number]): string | bigint => sort.key === "displayName" ? row.displayName : sort.key === "rank" ? BigInt(row.rank) : parseIntegerText(row[sort.key]);
  return standings.slice().sort((left, right) => {
    const first = value(left); const second = value(right);
    const compared = typeof first === "string" ? first.localeCompare(String(second)) : first === second ? 0 : first > (second as bigint) ? 1 : -1;
    // Rank breaks every tie (localeCompare returns numeric 0) so every ordering stays deterministic.
    return compared === 0 ? left.rank - right.rank : sort.ascending ? compared : -compared;
  });
}

const standingsHeaders: Array<[StandingsSortKey, string]> = [["rank", "Rank"], ["displayName", "Member"], ["lockedMicros", "Locked"], ["totalMicros", "Total"], ["notionalValueMicros", "Notional value"], ["gainMicros", "SVG"], ["riskedMicros", "Risked"]];

export function StandingsTable({ standings, memberProfilePath }: { standings: Standings; memberProfilePath?: (userId: string) => string }) {
  const [sort, setSort] = useState(defaultStandingsSort);
  return <section className="table-ribbon-section"><h2 className="table-ribbon">Active season holdings</h2><div className="table-scroll" tabIndex={0}><table><thead><tr>{standingsHeaders.map(([key, label]) => <th key={key} aria-sort={sort.key === key ? sort.ascending ? "ascending" : "descending" : "none"}><button type="button" className="standings-sort" onClick={() => setSort(toggleStandingsSort(sort, key))}>{label}{sort.key === key ? (sort.ascending ? " ▲" : " ▼") : ""}</button></th>)}</tr></thead><tbody>{sortStandings(standings, sort).map((row) => <tr key={row.userId}><td>{row.rank}</td><th scope="row">{memberProfilePath ? <Link to={memberProfilePath(row.userId)}>{row.displayName}</Link> : row.displayName}</th><td>{shares(row.lockedMicros)}</td><td>{shares(row.totalMicros)}</td><td>{shares(row.notionalValueMicros)}</td><td>{shares(row.gainMicros)}</td><td>{shares(row.riskedMicros)}</td></tr>)}</tbody></table></div></section>;
}

export function StandingsPage() {
  const { slug = "" } = useParams();
  // Keying the body by slug keeps profile links from ever pairing one pool's rows with another pool's route.
  return <StandingsPageBody key={slug} slug={slug}/>;
}

function StandingsPageBody({ slug }: { slug: string }) {
  const [data, setData] = useState<import("../../contracts/http").ReadStandings>();
  const [view, setView] = useState<import("../../contracts/http").ReadPoolView>();
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    void Promise.all([api.standings(slug), api.poolView(slug)]).then(([standings, poolView]) => { setData(standings); setView(poolView); }).catch((reason) => setError(errorMessage(reason)));
  }, [slug]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  if (error) return <Layout><h1>Standings</h1><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{error} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
  if (!data || !view) return <Layout><p role="status">Loading standings…</p></Layout>;

  const shareValue = view.activeSeason ? formatCurrentShareValue(view.activeSeason.floatMicros, view.activeSeason.notionalValueMicros) : "$0.000";
  const noIssuedShares = !view.activeSeason || parseIntegerText(view.activeSeason.floatMicros) === 0n;
  return <Layout><div className="standings-page"><h1>Standings</h1><p className="pool-context">Current share value: <strong>{shareValue}</strong>{noIssuedShares && <> · No shares issued yet; first order price is $1.00 per share.</>}</p>
    {data.standings.length ? <StandingsTable standings={data.standings} memberProfilePath={(userId) => `/p/${slug}/member/${userId}`} /> : <p className="state-notice">No active season standings yet. The commissioner can open a season before holdings appear.</p>}
    <Link to={`/p/${slug}/overview`}>Pool home</Link>
  </div></Layout>;
}

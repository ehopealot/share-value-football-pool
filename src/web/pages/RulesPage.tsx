import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type { OddsBoardResponse, ReadPoolView } from "../../contracts/http";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { PARLAY_RULESET_ID } from "../../domain/parlay";
import { TEASER_LEG_COUNTS, TEASER_PAYOUT_MATRIX, TEASER_POINT_OPTIONS, TEASER_RULESET_ID } from "../../domain/teaser-table";

const formatTeaserOdds = (odds: number | undefined) => odds === undefined ? "—" : `${odds > 0 ? "+" : ""}${odds}`;

export function RulesContent({ slug, view, board }: { slug: string; view: ReadPoolView; board: OddsBoardResponse }) {
  const season = view.activeSeason ?? view.latestClosedSeason;
  const selectedRuleset = season?.rulesetVersion ?? TEASER_RULESET_ID;
  const supported = selectedRuleset === TEASER_RULESET_ID;
  return <>
    <h1>Pool rules</h1>
    <section className="table-ribbon-section" aria-labelledby="season-rules-heading">
      <h2 className="table-ribbon" id="season-rules-heading">Applicable season</h2>
      {season
        ? <table><tbody><tr><th scope="row">Season</th><td>{season.label}</td></tr><tr><th scope="row">State</th><td>{season.state}</td></tr><tr><th scope="row">Ruleset</th><td>{selectedRuleset}</td></tr></tbody></table>
        : <p className="state-notice">No active or closed season is available. The fixed system rules are shown below.</p>}
      {!supported && <p role="alert" className="error-summary">Unsupported ruleset: {selectedRuleset}. No matching immutable rules table is available.</p>}
    </section>
    {supported && <section className="table-ribbon-section" aria-labelledby="teaser-rules-heading">
      <h2 className="table-ribbon" id="teaser-rules-heading">Teaser payouts: {selectedRuleset}</h2>
      <div className="table-scroll" tabIndex={0}><table><thead><tr><th scope="col">Legs</th>{TEASER_POINT_OPTIONS.map((points) => <th key={points} scope="col">{points} points</th>)}</tr></thead><tbody>{TEASER_LEG_COUNTS.map((legs) => <tr key={legs}><th scope="row">{legs === 7 ? "7 (legacy only)" : legs}</th>{TEASER_POINT_OPTIONS.map((points) => <td key={points}>{formatTeaserOdds(TEASER_PAYOUT_MATRIX[legs]?.[points])}</td>)}</tr>)}</tbody></table></div>
      <p>Regular teasers allow 2–6 legs. New teaser tickets are capped at six legs. 10-point teasers require exactly 3 legs. Moneylines are ineligible. NFL and NCAA sides and totals may be mixed.</p>
      <p>The seven-leg row applies only to previously accepted legacy tickets.</p>
      <p>A teaser settles as soon as any final leg loses. Wins and refunds wait until all legs are final; pushed or void legs are then removed and the remaining valid leg count is repriced from this table. If every leg pushes or voids, or too few winning legs remain, the risk is refunded.</p>
    </section>}
    <section aria-labelledby="parlay-rules-heading">
      <h2 id="parlay-rules-heading">Parlays: {PARLAY_RULESET_ID}</h2>
      <p>Parlays allow 2–6 legs from NFL or NCAA spreads, totals, and moneylines. Each event may include one spread or moneyline, optionally paired with one total; spread-plus-moneyline and duplicate or opposing selections are not allowed.</p>
      <p>A total paired with its event’s spread or moneyline is priced at -133. All other spread and total legs use +100, while moneylines use their accepted vig-free price.</p>
      <p>A parlay settles as soon as any final leg loses. Wins and refunds wait until all legs are final. Pushes and voids are removed and surviving legs are repriced from their immutable accepted terms; if no legs survive, the risk is refunded.</p>
    </section>
    <section aria-labelledby="source-policy-heading">
      <h2 id="source-policy-heading">Odds sources</h2>
      <p>DraftKings, then FanDuel, then BetMGM, then Caesars. The service uses the first source supplying a complete market; members cannot select a provider and the service does not selection-shop.</p>
      <section className="table-ribbon-section"><h3 className="table-ribbon">Feed status</h3>
      <table><tbody><tr><th scope="row">State</th><td>{board.feed.status}</td></tr><tr><th scope="row">Detail</th><td>{board.feed.message}</td></tr><tr><th scope="row">Last polled</th><td>{board.feed.lastPolledAt ?? "No provider poll recorded"}</td></tr><tr><th scope="row">Last successful poll</th><td>{board.feed.lastSuccessAt ?? "No successful provider poll recorded"}</td></tr></tbody></table></section>
    </section>
    <p><Link to={`/p/${slug}/overview`}>Pool home</Link></p>
  </>;
}

export function RulesPage() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<{ view: ReadPoolView; board: OddsBoardResponse }>();
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([api.poolView(slug), api.odds(slug)])
      .then(([view, board]) => { if (active) setData({ view, board }); })
      .catch((reason) => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [slug]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  if (error) return <Layout signedIn><h1>Pool rules</h1><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">Rules, season, and feed status are unavailable. {error}</p><Link to={`/p/${slug}/overview`}>Pool home</Link></Layout>;
  if (!data) return <Layout signedIn><h1>Pool rules</h1><p role="status">Loading rules, season, and feed status…</p></Layout>;
  return <Layout signedIn><RulesContent slug={slug} view={data.view} board={data.board} /></Layout>;
}

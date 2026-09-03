import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type { OddsBoardResponse, ReadPoolView } from "../../contracts/http";
import { api, errorMessage } from "../api";
import { Layout } from "../components/Layout";
import { PARLAY_RULESET_ID } from "../../domain/parlay";
import { TEASER_RULESET_ID } from "../../domain/teaser-table";
const teaserRows = [[2, "-120", "-130", "-140", "-160", "—"], [3, "+150", "+135", "+120", "+105", "-120"], [4, "+235", "+215", "+200", "+140", "—"], [5, "+350", "+320", "+300", "+235", "—"], [6, "+550", "+500", "+475", "+325", "—"], [7, "+800", "+700", "+600", "+445", "—"]] as const;

export function RulesContent({ slug, view, board }: { slug: string; view: ReadPoolView; board: OddsBoardResponse }) {
  const season = view.activeSeason ?? view.latestClosedSeason;
  const selectedRuleset = season?.rulesetVersion ?? TEASER_RULESET_ID;
  const supported = selectedRuleset === TEASER_RULESET_ID;
  return <>
    <h1>Pool rules</h1>
    <section aria-labelledby="season-rules-heading">
      <h2 id="season-rules-heading">Applicable season</h2>
      {season
        ? <table><tbody><tr><th scope="row">Season</th><td>{season.label}</td></tr><tr><th scope="row">State</th><td>{season.state}</td></tr><tr><th scope="row">Ruleset</th><td>{selectedRuleset}</td></tr></tbody></table>
        : <p className="state-notice">No active or closed season is available. The fixed system rules are shown below.</p>}
      {!supported && <p role="alert" className="error-summary">Unsupported ruleset: {selectedRuleset}. No matching immutable rules table is available.</p>}
    </section>
    {supported && <section aria-labelledby="teaser-rules-heading">
      <h2 id="teaser-rules-heading">Teaser payouts: {selectedRuleset}</h2>
      <div className="table-scroll" tabIndex={0}><table><caption>Fixed system teaser prices (American odds)</caption><thead><tr><th scope="col">Legs</th><th scope="col">6 points</th><th scope="col">6.5 points</th><th scope="col">7 points</th><th scope="col">7.5 points</th><th scope="col">10 points</th></tr></thead><tbody>{teaserRows.map((row) => <tr key={row[0]}>{row.map((cell, index) => index === 0 ? <th key={index} scope="row">{cell}</th> : <td key={index}>{cell}</td>)}</tr>)}</tbody></table></div>
      <p>Regular teasers allow 2–6 legs. 10-point teasers require exactly 3 legs. Moneylines are ineligible. NFL and NCAA sides and totals may be mixed.</p>
      <p>If any leg loses, the teaser loses. Otherwise pushed or void legs are removed and the remaining valid leg count is repriced from this table. If every leg pushes or voids, or too few winning legs remain, the risk is refunded.</p>
    </section>}
    <section aria-labelledby="parlay-rules-heading">
      <h2 id="parlay-rules-heading">Parlays: {PARLAY_RULESET_ID}</h2>
      <p>Parlays allow 2–6 legs from NFL or NCAA spreads, totals, and moneylines. Each event may include one spread or moneyline, optionally paired with one total; spread-plus-moneyline and duplicate or opposing selections are not allowed.</p>
      <p>A total paired with its event’s spread or moneyline is priced at -133. All other spread and total legs use +100, while moneylines use their accepted vig-free price.</p>
      <p>Settlement waits until all legs are final. Any loss then loses the parlay. Pushes and voids are removed and surviving legs are repriced from their immutable accepted terms; if no legs survive, the risk is refunded.</p>
    </section>
    <section aria-labelledby="source-policy-heading">
      <h2 id="source-policy-heading">Odds sources</h2>
      <p>DraftKings, then FanDuel, then BetMGM, then Caesars. The service uses the first source supplying a complete market; members cannot select a provider and the service does not selection-shop.</p>
      <h3>Feed status</h3>
      <table><tbody><tr><th scope="row">State</th><td>{board.feed.status}</td></tr><tr><th scope="row">Detail</th><td>{board.feed.message}</td></tr><tr><th scope="row">Last polled</th><td>{board.feed.lastPolledAt ?? "No provider poll recorded"}</td></tr><tr><th scope="row">Last successful poll</th><td>{board.feed.lastSuccessAt ?? "No successful provider poll recorded"}</td></tr></tbody></table>
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

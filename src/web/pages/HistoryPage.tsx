import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { useFrozenAdminCommand } from "../admin-command";
import { Layout } from "../components/Layout";
import { WagerDetails } from "../components/WagerDetails";
import { formatMicros, parseIntegerText } from "../../domain/fixed-point";
import { PARLAY_RULESET_ID } from "../../domain/parlay";
import { TEASER_RULESET_ID } from "../../domain/teaser-table";
import type { ReadSeasonHistory } from "../../contracts/http";

const amount = (value: string, decimals: 2 | 4 = 2) => formatMicros(parseIntegerText(value), decimals);
const evidence = (value: unknown) => JSON.stringify(value);

export function ArchivedRulesetGuidance({ slug, rulesetVersion }: { slug: string; rulesetVersion: string }) {
  if (rulesetVersion !== TEASER_RULESET_ID) return <p role="alert" className="error-summary">Unsupported archived ruleset: {rulesetVersion}. No matching immutable rules table is available; do not use the current Rules page payout table for this season.</p>;
  return <p>Review the <Link to={`/p/${slug}/rules#teaser-rules-heading`}>matching immutable {rulesetVersion} payout table</Link>. This archived version remains authoritative if the Rules page selects another season.</p>;
}

export function WagerRulesetGuidance({ slug, wager }: { slug: string; wager: { wagerId: string; type: string; rulesetVersion?: string } }) {
  if (!wager.rulesetVersion) return null;
  if (wager.type === "parlay") {
    if (wager.rulesetVersion === PARLAY_RULESET_ID) return <p>Parlay ticket rules: <Link to={`/p/${slug}/rules#parlay-rules-heading`}>matching immutable {PARLAY_RULESET_ID} terms</Link>. This parlay is governed independently of the season teaser ruleset.</p>;
    return <p role="alert" className="error-summary">Unsupported parlay ruleset: {wager.rulesetVersion}. No matching immutable parlay rules are available.</p>;
  }
  if (wager.type === "teaser" && wager.rulesetVersion === TEASER_RULESET_ID) return <p>Teaser ticket rules: <Link to={`/p/${slug}/rules#teaser-rules-heading`}>matching immutable {TEASER_RULESET_ID} payout table</Link>.</p>;
  return null;
}

export function EventResultsTable({ results }: { results: ReadSeasonHistory["eventResults"] }) {
  return results.length ? <div className="table-scroll" tabIndex={0}><table><caption>Results used by archived wagers</caption><thead><tr><th>Observed</th><th>Event</th><th>League</th><th>Correction version</th><th>Status</th><th>Result</th></tr></thead><tbody>{results.map((result) => <tr key={`${result.eventId}:${result.result.league}:${result.result.correctionVersion}`}><td>{result.observedAt}</td><td>{result.eventId}</td><td>{result.result.league}</td><td>{result.result.correctionVersion}</td><td>{result.result.status}</td><td>{evidence(result.result)}</td></tr>)}</tbody></table></div> : <p className="state-notice">No event result snapshots were recorded.</p>;
}

export function HistoryPage() {
  const { slug = "", season = "" } = useParams();
  const [data, setData] = useState<import("../../contracts/http").ReadSeasonHistory>();
  const [view, setView] = useState<import("../../contracts/http").ReadPoolView>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const annotation = useFrozenAdminCommand<{ text: string; idempotencyKey: string }>();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const load = () => {
    void api.history(slug, season).then(setData).catch((e) => setLoadError(errorMessage(e)));
    void api.poolView(slug).then(setView).catch((e) => setLoadError(errorMessage(e)));
  };
  useEffect(load, [slug, season]);
  useEffect(() => { if (error || loadError) errorRef.current?.focus(); }, [error, loadError]);
  if (loadError) return <Layout signedIn><h1>Archived season</h1><p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{loadError} <Link to={`/p/${slug}/overview`}>Return to the pool home</Link>.</p></Layout>;
  if (!data || !view) return <Layout><p role="status">Loading archived season…</p></Layout>;
  const commissioner = view.currentMember.role === "commissioner";
  const annotate = async () => {
    if (!text.trim()) return setError("Enter an annotation.");
    setError("");
    try {
      await annotation.run(`annotation:${season}`, () => ({ text, idempotencyKey: crypto.randomUUID() }), (body) => api.command(slug, `/admin/history/${season}/annotations`, body));
      setText("");
      load();
    } catch (e) { setError(errorMessage(e)); }
  };
  return <Layout signedIn><h1>Archived season: {data.season.label}</h1><p>Read-only {data.season.state} season. {data.season.closeReason ? `Closed: ${data.season.closeReason}.` : ""}</p>
    <div className="table-scroll" tabIndex={0}><table><caption>Final season accounting</caption><tbody><tr><th scope="row">Ruleset version</th><td>{data.season.rulesetVersion}</td></tr><tr><th scope="row">Final share float</th><td>{amount(data.season.floatMicros)} shares</td></tr><tr><th scope="row">Final notional value</th><td>{amount(data.season.notionalMicros)}</td></tr><tr><th scope="row">Final share price</th><td>{amount(data.season.priceMicros, 4)}</td></tr></tbody></table></div>
    <ArchivedRulesetGuidance slug={slug} rulesetVersion={data.season.rulesetVersion} />
    <h2>Final accounts</h2>{data.accounts.length ? <div className="table-scroll" tabIndex={0}><table><caption>Every season account</caption><thead><tr><th>Member</th><th>Available</th><th>Locked</th><th>Total shares</th><th>Holding value</th><th>Gain</th></tr></thead><tbody>{data.accounts.map((account) => <tr key={account.memberId}><td>{account.memberDisplayName}</td><td>{amount(account.availableMicros)}</td><td>{amount(account.lockedMicros)}</td><td>{amount(account.totalMicros)}</td><td>{amount(account.holdingValueMicros)}</td><td>{amount(account.gainMicros)}</td></tr>)}</tbody></table></div> : <p className="state-notice">No season accounts were recorded.</p>}
    <h2>Final standings</h2>{data.standings.length ? <div className="table-scroll" tabIndex={0}><table><caption>Final rank by share holdings</caption><thead><tr><th>Rank</th><th>Member</th><th>Total shares</th><th>Holding value</th><th>Gain</th></tr></thead><tbody>{data.standings.map((standing) => <tr key={standing.userId}><td>{standing.rank}</td><td>{standing.displayName}</td><td>{amount(standing.totalMicros)}</td><td>{amount(standing.notionalValueMicros)}</td><td>{amount(standing.gainMicros)}</td></tr>)}</tbody></table></div> : <p className="state-notice">No final standings were recorded.</p>}
    <h2>Season share orders</h2>{data.orders.length ? <div className="table-scroll" tabIndex={0}><table><caption>Append-only share orders</caption><thead><tr><th>Time</th><th>Member</th><th>Mode</th><th>Requested</th><th>Shares</th><th>Value</th><th>Price</th><th>Reason</th><th>Reversal of</th></tr></thead><tbody>{data.orders.map((order) => <tr key={order.id}><td>{order.createdAt}</td><td>{order.memberDisplayName}</td><td>{order.mode}</td><td>{amount(order.requestedMicros)}</td><td>{amount(order.sharesMicros)}</td><td>{amount(order.valueMicros)}</td><td>{amount(order.priceMicros, 4)}</td><td>{order.reason}</td><td>{order.reversalOf ?? "—"}</td></tr>)}</tbody></table></div> : <p className="state-notice">No share orders were recorded.</p>}
    <h2>Immutable wagers</h2>{data.wagers.length ? data.wagers.map((wager) => <div key={wager.wagerId}><WagerRulesetGuidance slug={slug} wager={wager} /><WagerDetails wager={wager} ownerOutcome={Boolean(wager.outcome)} /></div>) : <p className="state-notice">No archived wagers were recorded.</p>}
    <h2>Share ledger</h2>{data.ledger.length ? <div className="table-scroll" tabIndex={0}><table><caption>Append-only accounting ledger</caption><thead><tr><th>Time</th><th>Member</th><th>Kind</th><th>Available Δ</th><th>Locked Δ</th><th>Float Δ</th><th>Notional Δ</th><th>Cause</th></tr></thead><tbody>{data.ledger.map((entry) => <tr key={entry.id}><td>{entry.createdAt}</td><td>{entry.memberDisplayName}</td><td>{entry.kind}</td><td>{amount(entry.availableDelta)}</td><td>{amount(entry.lockedDelta)}</td><td>{amount(entry.floatDelta)}</td><td>{amount(entry.notionalDelta)}</td><td>{entry.causationId}</td></tr>)}</tbody></table></div> : <p className="state-notice">No ledger entries were recorded.</p>}
    <h2>Settlement and reversal history</h2>{data.settlements.length ? <div className="table-scroll" tabIndex={0}><table><caption>Append-only wager settlements</caption><thead><tr><th>Time</th><th>Wager</th><th>Outcome</th><th>Return</th><th>Profit</th><th>Reason</th><th>Reversal of</th><th>Result evidence</th></tr></thead><tbody>{data.settlements.map((settlement) => <tr key={settlement.id}><td>{settlement.createdAt}</td><td>{settlement.wagerId}</td><td>{settlement.outcome}</td><td>{amount(settlement.returnMicros)}</td><td>{amount(settlement.profitMicros)}</td><td>{settlement.reason ?? "—"}</td><td>{settlement.reversalOf ?? "—"}</td><td>{evidence(settlement.sourceResult)}</td></tr>)}</tbody></table></div> : <p className="state-notice">No settlements or reversals were recorded.</p>}
    <h2>Commissioner corrections</h2>{data.wagerCorrections.length ? <div className="table-scroll" tabIndex={0}><table><caption>Immutable commissioner correction evidence</caption><thead><tr><th>Time</th><th>Wager</th><th>Reason</th><th>Prior evidence</th><th>Replacement evidence</th></tr></thead><tbody>{data.wagerCorrections.map((correction) => <tr key={correction.id}><td>{correction.createdAt}</td><td>{correction.wagerId}</td><td>{correction.reason}</td><td>{evidence(correction.sourceResult)}</td><td>{evidence(correction.replacementResult)}</td></tr>)}</tbody></table></div> : <p className="state-notice">No commissioner corrections were recorded.</p>}
    <h2>Event results</h2><EventResultsTable results={data.eventResults} />
    <h2>Commissioner annotations</h2>{data.annotations.length ? <ul>{data.annotations.map((a) => <li key={a.annotationId}>{a.text} — {a.authorDisplayName}</li>)}</ul> : <p>No annotations yet.</p>}
    {commissioner && <><label>Add annotation <input disabled={annotation.pending} value={text} onChange={(e) => { annotation.retire(); setError(""); setText(e.target.value); }} /></label><button disabled={!text.trim() || annotation.pending} onClick={() => void annotate()}>Add annotation</button></>}
    {error && <p ref={errorRef} tabIndex={-1} role="alert" className="error-summary">{error}</p>}<p><Link to={`/p/${slug}/overview`}>Pool home</Link></p>
  </Layout>;
}

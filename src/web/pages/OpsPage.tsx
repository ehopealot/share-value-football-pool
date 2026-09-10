import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type OpsSummary, type PoolInspection } from "../api";
import { Layout } from "../components/Layout";
import { formatOpsTime, jobSignal, scheduleSignal, type OpsSignal } from "../ops-presentation";

function Badge({ tone, label }: OpsSignal) {
  return <span className={`ops-badge ops-badge--${tone}`}>{label}</span>;
}

function OpsTime({ value, reference, empty = "Unknown" }: { value: string | null; reference: number; empty?: string }) {
  const time = formatOpsTime(value, reference);
  return time ? <time className="ops-time" dateTime={time.dateTime}><span>{time.relative}</span><small>{time.exact}</small></time> : <span>{value === null ? empty : "Unknown"}</span>;
}

const jobNames = new Map([["odds", "Odds updates"], ["backup", "Backup exports"]]);
const outcomeNames = new Map([["success", "Work completed"], ["not_due", "No work due"], ["failed", "Work failed"], ["unknown", "Outcome unknown"], ["superseded", "Attempt superseded; outcome unknown"]]);
const categoryDescriptions = new Map([
  ["provider_published", "Odds update published."],
  ["provider_not_due", "No odds update was due."],
  ["provider_superseded", "Another attempt took precedence; this does not confirm completed work."],
  ["provider_failed", "The odds update failed."],
  ["no_ready_pools", "No ready pools were available to export."],
  ["backup_page_stored", "A page of backup exports was stored; this is not a full recovery check."],
  ["backup_partial_failure", "Some backup exports failed."],
  ["backup_run_failed", "The backup run failed."],
  ["unreadable_evidence", "The recorded evidence could not be read reliably."]
]);
const freshnessNames = { current: "Within 4 minutes", stale: "Older than 4 minutes", unknown: "Freshness unknown" };

function InspectionDetails({ value, receivedAt }: { value: PoolInspection; receivedAt: number }) {
  const sampledAt = Date.parse(value.sampledAt);
  const readable = value.initialized && value.status === "observed";
  const schedules = [
    ["Next pool wake-up", "The alarm that asks this pool to run scheduled work.", value.alarmAt],
    ["Event/result check retry", "Reconciliation checks event results and updates settlement when needed.", value.reconciliationRetryAt],
    ["Championship discovery retry", "Looks for the season’s championship event.", value.discoveryRetryAt],
    ["Queued delivery retry", "Outbox delivery sends recorded pool events to the processing queue.", value.outboxRetryAt]
  ];
  return <>
    <p><Badge tone="neutral" label={readable ? "Snapshot collected" : "Unknown"}/> This is an observation, not a whole-pool health check.</p>
    <p>Inspection sampled <OpsTime value={value.sampledAt} reference={receivedAt}/></p>
    {!readable ? <p className="state-notice">Scheduling evidence is unknown. The pool is not initialized or its scheduling records could not be read reliably.</p> : <>
      <p className="ops-note">Times and statuses are frozen at this snapshot. Scheduling times below are relative to the inspection sample; inspect again for current evidence. A passed time deserves a closer look but does not prove work is stuck.</p>
      <dl className="ops-details">{schedules.map(([label, description, at]) => <div key={label}>
        <dt>{label}<small>{description}</small></dt>
        <dd><Badge {...scheduleSignal(at, sampledAt)}/>{at !== null && <OpsTime value={at} reference={sampledAt}/>}</dd>
      </div>)}
        <div><dt>Event/result checks<small>Pending reconciliation and championship discovery work.</small></dt><dd><Badge tone="neutral" label={`${value.pendingReconciliationCount} waiting`}/></dd></div>
        <div><dt>Queued deliveries<small>Recorded pool events still waiting to be sent (outbox).</small></dt><dd><Badge tone="neutral" label={`${value.pendingOutboxCount} waiting`}/></dd></div>
        <div><dt>Deliveries needing attention<small>Automatic delivery attempts have stopped for these events.</small></dt><dd><Badge tone={value.exhaustedOutboxCount > 0 ? "bad" : "neutral"} label={value.exhaustedOutboxCount > 0 ? `${value.exhaustedOutboxCount} retries exhausted` : "None observed"}/>
          {value.exhaustedOutboxCount > 0 && value.exhaustedOutboxCategories.map((category) => <small key={category}>{category === "invalid_delivery" ? "Invalid delivery data" : category === "delivery_failed" ? "Delivery failed" : "Unknown delivery problem"} <code>({category})</code></small>)}
        </dd></div>
      </dl>
      <p className="ops-note">Pending work alone is not a failure. No pending work does not establish overall pool health.</p>
    </>}
  </>;
}

export function OpsPage() {
  const [summary, setSummary] = useState<OpsSummary>();
  const [poolId, setPoolId] = useState("");
  const [inspection, setInspection] = useState<{ poolId: string; value: PoolInspection; receivedAt: number }>();
  const [error, setError] = useState("");
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [summaryLoadedAt, setSummaryLoadedAt] = useState(Date.now());
  const inspectionRequest = useRef(0);
  useEffect(() => { void api.opsSummary().then((value) => { setSummary(value); setSummaryLoadedAt(Date.now()); }).catch((value) => setError(errorMessage(value))); }, []);
  const inspect = async () => {
    const requestedPoolId = poolId.trim();
    const request = ++inspectionRequest.current;
    setError("");
    setInspection(undefined);
    setInspectionLoading(true);
    try {
      const value = await api.inspectPool(requestedPoolId);
      if (request === inspectionRequest.current) setInspection({ poolId: requestedPoolId, value, receivedAt: Date.now() });
    } catch (value) {
      if (request === inspectionRequest.current) setError(errorMessage(value));
    } finally {
      if (request === inspectionRequest.current) setInspectionLoading(false);
    }
  };
  return <Layout><main className="ops-page">
    <p className="eyebrow">Restricted operator visibility</p><h1>Operations</h1>
    <p>This page reports observations only. It does not continuously monitor every pool, send operational alerts, or repair scheduling.</p>
    <p className="ops-note">Exact dates use your browser’s local timezone, shown beside each time.</p>
    {error && <p role="alert" className="error-summary">{error}</p>}
    {!summary ? <p role="status">Loading job evidence…</p> : <>
      <section><h2>Configuration</h2><p className="ops-note">Configuration is not a health check.</p><ul className="ops-configuration">
        <li><span>Operator access</span><Badge tone="neutral" label={summary.readiness.operatorAllowlist ? "Configured" : "Unavailable"}/></li>
        <li><span>Pool inspection</span><Badge tone={summary.readiness.poolInspection ? "neutral" : "attention"} label={summary.readiness.poolInspection ? "Available" : "Needs attention"}/>{!summary.readiness.poolInspection && <small>Inspection is not configured.</small>}</li>
        <li><span>Odds job</span><Badge tone="neutral" label={summary.readiness.oddsJob ? "Configured" : "Disabled"}/></li>
        <li><span>Backup job</span><Badge tone="neutral" label={summary.readiness.backupJob ? "Configured" : "Disabled"}/></li>
        <li><span>External monitor</span><Badge tone="neutral" label="Not verified"/><small>The application cannot verify external monitoring.</small></li>
      </ul></section>
      <section><h2>Latest job evidence</h2>
        <p>Snapshot loaded <OpsTime value={new Date(summaryLoadedAt).toISOString()} reference={summaryLoadedAt}/></p>
        <p className="ops-note" id="ops-job-snapshot-note">Times and statuses are frozen at this snapshot. Reload the page for current evidence. “Recent check OK” describes the last check only; “No work due” is not completed work.</p>
        {summary.jobs.length ? <div className="table-scroll" role="region" aria-label="Latest job evidence" tabIndex={0}><table aria-describedby="ops-job-snapshot-note"><thead><tr><th scope="col">Job</th><th scope="col">Status at snapshot</th><th scope="col">Observed outcome</th><th scope="col">Last observed</th><th scope="col">Last successful work</th></tr></thead><tbody>{summary.jobs.map((job) => <tr key={job.job_kind}>
          <th scope="row">{jobNames.get(job.job_kind) ?? job.job_kind}</th>
          <td><Badge {...jobSignal(job.status, job.freshness)}/><small>{freshnessNames[job.freshness]}</small></td>
          <td>{outcomeNames.get(job.status) ?? "Outcome unknown"}<small>{categoryDescriptions.get(job.safe_category) ?? "No description available for this recorded category."}</small><code>{job.safe_category}</code></td>
          <td><OpsTime value={job.observed_at} reference={summaryLoadedAt}/></td><td><OpsTime value={job.successful_at} reference={summaryLoadedAt}/></td>
        </tr>)}</tbody></table></div> : <p><Badge tone="neutral" label="Unknown"/> No job evidence recorded.</p>}
      </section>
    </>}
    <section><h2>Inspect one ready pool</h2><p>Read a single pool’s scheduling records without changing or repairing them.</p>
      <div className="ops-inspect-controls"><label htmlFor="ops-pool-id">Pool ID<input id="ops-pool-id" value={poolId} maxLength={200} onChange={(event) => { inspectionRequest.current++; setPoolId(event.target.value); setInspection(undefined); setInspectionLoading(false); }}/></label><button disabled={!poolId.trim() || inspectionLoading} onClick={() => void inspect()}>Inspect current scheduling</button></div>
      {inspectionLoading && <p role="status">Inspecting {poolId.trim()}…</p>}
      {inspection && <><h3>Inspection target: {inspection.poolId}</h3><InspectionDetails value={inspection.value} receivedAt={inspection.receivedAt}/></>}
    </section>
  </main></Layout>;
}

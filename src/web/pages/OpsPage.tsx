import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type OpsSummary, type PoolInspection } from "../api";
import { Layout } from "../components/Layout";

export function OpsPage() {
  const [summary, setSummary] = useState<OpsSummary>();
  const [poolId, setPoolId] = useState("");
  const [inspection, setInspection] = useState<{ poolId: string; value: PoolInspection }>();
  const [error, setError] = useState("");
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const inspectionRequest = useRef(0);
  useEffect(() => { void api.opsSummary().then(setSummary).catch((value) => setError(errorMessage(value))); }, []);
  const inspect = async () => {
    const requestedPoolId = poolId.trim();
    const request = ++inspectionRequest.current;
    setError("");
    setInspection(undefined);
    setInspectionLoading(true);
    try {
      const value = await api.inspectPool(requestedPoolId);
      if (request === inspectionRequest.current) setInspection({ poolId: requestedPoolId, value });
    } catch (value) {
      if (request === inspectionRequest.current) setError(errorMessage(value));
    } finally {
      if (request === inspectionRequest.current) setInspectionLoading(false);
    }
  };
  return <Layout><main className="ops-page">
    <p className="eyebrow">Restricted operator visibility</p><h1>Operations</h1>
    <p>This page reports observations only. It does not continuously monitor every pool, send operational alerts, or repair scheduling.</p>
    {error && <p role="alert" className="error-summary">{error}</p>}
    {!summary ? <p role="status">Loading job evidence…</p> : <>
      <section><h2>Configuration</h2><ul>
        <li>Operator allowlist: ready</li><li>Pool inspection: {summary.readiness.poolInspection ? "ready" : "unavailable"}</li>
        <li>Odds job: {summary.readiness.oddsJob ? "configured" : "disabled"}</li><li>Backup job: {summary.readiness.backupJob ? "configured" : "disabled"}</li><li>External monitor: not verified by the application</li>
      </ul></section>
      <section><h2>Latest job evidence</h2>{summary.jobs.length ? <table><thead><tr><th>Job</th><th>Freshness</th><th>Observed outcome</th><th>Observed at</th><th>Last successful work</th></tr></thead><tbody>{summary.jobs.map((job) => <tr key={job.job_kind}><th scope="row">{job.job_kind}</th><td>{job.freshness}</td><td>{job.status}: {job.safe_category}</td><td>{job.observed_at ?? "Unknown"}</td><td>{job.successful_at ?? "Unknown"}</td></tr>)}</tbody></table> : <p>No job evidence recorded; current status is unknown.</p>}</section>
    </>}
    <section><h2>Inspect one ready pool</h2><label htmlFor="ops-pool-id">Pool ID</label><input id="ops-pool-id" value={poolId} maxLength={200} onChange={(event) => { inspectionRequest.current++; setPoolId(event.target.value); setInspection(undefined); setInspectionLoading(false); }}/><button disabled={!poolId.trim() || inspectionLoading} onClick={() => void inspect()}>Inspect current scheduling</button>
      {inspectionLoading && <p role="status">Inspecting {poolId.trim()}…</p>}
      {inspection && <><h3>Inspection target: {inspection.poolId}</h3><dl><dt>Observation</dt><dd>{inspection.value.status} at {inspection.value.sampledAt}</dd><dt>Alarm</dt><dd>{inspection.value.alarmAt ?? "None observed"}</dd><dt>Reconciliation retry</dt><dd>{inspection.value.reconciliationRetryAt ?? "None observed"}</dd><dt>Discovery retry</dt><dd>{inspection.value.discoveryRetryAt ?? "None observed"}</dd><dt>Outbox retry</dt><dd>{inspection.value.outboxRetryAt ?? "None observed"}</dd><dt>Pending reconciliation</dt><dd>{inspection.value.pendingReconciliationCount}</dd><dt>Pending outbox</dt><dd>{inspection.value.pendingOutboxCount}</dd><dt>Exhausted outbox</dt><dd>{inspection.value.exhaustedOutboxCount}</dd></dl></>}
    </section>
  </main></Layout>;
}

export const jobStatuses = ["success", "not_due", "failed", "unknown", "superseded"] as const;
export type JobStatus = typeof jobStatuses[number];

export type JobStatusInput = {
  jobKind: "odds" | "backup";
  attemptKey: string;
  status: JobStatus;
  safeCategory: string;
  observedAt: string;
  successfulAt?: string;
};

/** One latest row per job. Attempt identity, not completion order, prevents stale completion overwrite. */
export async function recordJobStatus(db: D1Database, input: JobStatusInput): Promise<boolean> {
  const result = await db.prepare(`
    INSERT INTO ops_job_status(job_kind,attempt_key,status,safe_category,observed_at,successful_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(job_kind) DO UPDATE SET
      attempt_key=excluded.attempt_key,
      status=excluded.status,
      safe_category=excluded.safe_category,
      observed_at=excluded.observed_at,
      successful_at=CASE
        WHEN excluded.successful_at IS NULL THEN ops_job_status.successful_at
        WHEN ops_job_status.successful_at IS NULL OR excluded.successful_at > ops_job_status.successful_at THEN excluded.successful_at
        ELSE ops_job_status.successful_at
      END
    WHERE excluded.attempt_key > ops_job_status.attempt_key
  `).bind(input.jobKind, input.attemptKey, input.status, input.safeCategory, input.observedAt, input.successfulAt ?? null).run();
  return result.meta.changes === 1;
}

export const parseOperationalTimestamp = (value: string, capturedNow: number): number | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= capturedNow && new Date(parsed).toISOString() === value ? parsed : null;
};

export const isJobStatus = (value: string): value is JobStatus => (jobStatuses as readonly string[]).includes(value);

export const jobAttemptKey = (startedAt: Date, runId = crypto.randomUUID()): string => `${startedAt.toISOString()}/${runId}`;

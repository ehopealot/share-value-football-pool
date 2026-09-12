-- Reduced-scope operational visibility. These rows are observations only and never authorize pool work.
CREATE TABLE IF NOT EXISTS ops_job_status (
  job_kind TEXT PRIMARY KEY CHECK(job_kind IN ('odds','backup')),
  attempt_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','not_due','failed','unknown','superseded')),
  safe_category TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  successful_at TEXT
);

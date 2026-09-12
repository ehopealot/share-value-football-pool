type Row = Record<string, SqlStorageValue>;
const MAX_OUTBOX_ATTEMPTS = 5;
const first = (sql: SqlStorage, query: string): Row | undefined => [...sql.exec<Row>(query)][0];

type RetrySummary = { count: number; invalid: boolean; retryAt: string | null };
const summarize = (sql: SqlStorage, fromAndWhere: string): RetrySummary => {
  const row = first(sql, `SELECT COUNT(*) AS count, MIN(next_attempt_at) AS retry_at, SUM(CASE WHEN next_attempt_at IS NULL OR julianday(next_attempt_at) IS NULL THEN 1 ELSE 0 END) AS invalid FROM ${fromAndWhere}`)!;
  const retry = row.retry_at === null ? null : Date.parse(String(row.retry_at));
  const retryAt = typeof retry === "number" && Number.isFinite(retry) ? new Date(retry).toISOString() : null;
  return {
    count: Number(row.count),
    invalid: Number(row.invalid ?? 0) > 0 || (row.retry_at !== null && retryAt === null),
    retryAt
  };
};

/** Fixed, bounded, query-only summary. It never reads wager/member/payload data. */
export function schedulingInspection(sql: SqlStorage) {
  const reconciliation = summarize(sql, "event_reconciliation WHERE phase<>'complete'");
  const discovery = summarize(sql, "season_super_bowl_reconciliation r JOIN season s ON s.id=r.season_id AND s.state='active' LEFT JOIN season_super_bowl sb ON sb.season_id=r.season_id WHERE sb.season_id IS NULL");
  const pendingOutbox = summarize(sql, `outbox WHERE delivered_at IS NULL AND attempts < ${MAX_OUTBOX_ATTEMPTS}`);
  const exhausted = [...sql.exec<{ category: string }>(`
    SELECT CASE WHEN last_error LIKE 'INVALID_OUTBOX%' THEN 'invalid_delivery' ELSE 'delivery_failed' END AS category
    FROM outbox WHERE delivered_at IS NULL AND attempts >= ${MAX_OUTBOX_ATTEMPTS}
    GROUP BY category LIMIT 2
  `)];
  const exhaustedCount = first(sql, `SELECT COUNT(*) AS count FROM outbox WHERE delivered_at IS NULL AND attempts >= ${MAX_OUTBOX_ATTEMPTS}`)!;
  return {
    initialized: first(sql, "SELECT id FROM pool LIMIT 1") !== undefined,
    corrupt: reconciliation.invalid || discovery.invalid || pendingOutbox.invalid,
    reconciliationRetryAt: reconciliation.retryAt,
    discoveryRetryAt: discovery.retryAt,
    outboxRetryAt: pendingOutbox.retryAt,
    pendingReconciliationCount: reconciliation.count + discovery.count,
    pendingOutboxCount: pendingOutbox.count,
    exhaustedOutboxCount: Number(exhaustedCount.count),
    exhaustedOutboxCategories: exhausted.map((row) => row.category).sort()
  };
}

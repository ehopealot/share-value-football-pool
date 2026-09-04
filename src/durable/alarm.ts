import { D1ResultSource, type FinalResultObservation, type FinalResultVersion, type ResultSource } from "../odds/result-source";
import { settleWagers } from "./settlement";
type Row = Record<string, SqlStorageValue>;
const FINAL_15_MINUTES = 15 * 60 * 1000;
const FINAL_2_HOURS = 2 * 60 * 60 * 1000;
const FINAL_24_HOURS = 24 * 60 * 60 * 1000;
const REFRESH_RETRY_DELAY = 2 * 60 * 1000;
const MAX_PROVIDER_ERROR_ATTEMPTS = 8;
const retryDelay = (attempts: number) => Math.min(60 * 60 * 1000, 2 * 60 * 1000 * 2 ** Math.min(attempts, 5));
const at = (ms: number) => new Date(ms).toISOString();
const terminal = (r: FinalResultVersion | undefined) => r !== undefined && (r.status === "cancelled" || r.status === "no_contest" || (r.status === "final" && r.homeScore !== null && r.awayScore !== null));
const checkpointDelay = (phase: string) => phase === "final_15" ? 5 * 60 * 1000 : phase === "final_2h" ? FINAL_2_HOURS : phase === "final_24" ? FINAL_24_HOURS : 0;
const providerRefreshReady = (phase: string, result: FinalResultObservation): boolean => {
  if (!result.providerRefresh) return true; // Explicit/custom result sources supply already-current evidence.
  const finalizedAt = new Date(result.providerRefresh.finalizedAt ?? "").getTime();
  const lastPolledAt = new Date(result.providerRefresh.lastPolledAt ?? "").getTime();
  return Number.isFinite(finalizedAt) && Number.isFinite(lastPolledAt) && lastPolledAt >= finalizedAt + checkpointDelay(phase);
};
const snapshotResult = ({ providerRefresh: _refresh, ...result }: FinalResultObservation): FinalResultVersion => result;

/** Uses the provider's proximity schedule after kickoff; ordinary open/incomplete results never consume error retries. */
const normalPollDelay = (eventStartsAt: SqlStorageValue, now: number) => {
  const untilStart = new Date(String(eventStartsAt)).getTime() - now;
  if (untilStart > 24 * 60 * 60 * 1000) return 6 * 60 * 60 * 1000;
  if (untilStart > 60 * 60 * 1000) return 30 * 60 * 1000;
  if (untilStart > 0) return 5 * 60 * 1000;
  return 2 * 60 * 1000;
};

/** Reconciles due event lifecycles and retains terminal snapshots for multi-leg tickets. */
export async function runSettlementAlarm(state: DurableObjectState, db: D1Database, source: ResultSource = new D1ResultSource(db), now = Date.now()): Promise<number | null> {
  // Cloudflare may invoke an alarm handler with implementation metadata; never let that turn a lifecycle alarm into an invalid timestamp.
  now = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const discoveryDue = [...state.storage.sql.exec<Row>("SELECT r.season_id, r.attempts, r.error_attempts FROM season_super_bowl_reconciliation r JOIN season s ON s.id = r.season_id AND s.state = 'active' LEFT JOIN season_super_bowl sb ON sb.season_id = r.season_id WHERE sb.season_id IS NULL AND r.next_attempt_at <= ? ORDER BY r.next_attempt_at", at(now))];
  if (discoveryDue.length) try {
    const candidate = (await source.getScheduledSuperBowls?.() ?? [])[0];
    await state.storage.transaction(async () => {
      for (const lifecycle of discoveryDue) {
        if (candidate) {
          state.storage.sql.exec("INSERT OR IGNORE INTO season_super_bowl (season_id, event_id, provider_event_name, event_starts_at) VALUES (?, ?, ?, ?)", lifecycle.season_id, candidate.eventId, candidate.eventName, candidate.startsAt);
          state.storage.sql.exec("UPDATE season_super_bowl_reconciliation SET attempts = ?, error_attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE season_id = ?", Number(lifecycle.attempts) + 1, lifecycle.season_id);
        } else state.storage.sql.exec("UPDATE season_super_bowl_reconciliation SET attempts = ?, error_attempts = 0, next_attempt_at = ?, last_error = 'SUPER_BOWL_NOT_SCHEDULED' WHERE season_id = ?", Number(lifecycle.attempts) + 1, at(now + 6 * 60 * 60 * 1000), lifecycle.season_id);
      }
    });
  } catch (error) {
    await state.storage.transaction(async () => {
      for (const lifecycle of discoveryDue) {
        const errors = Number(lifecycle.error_attempts) + 1;
        const exhausted = errors >= MAX_PROVIDER_ERROR_ATTEMPTS;
        state.storage.sql.exec("UPDATE season_super_bowl_reconciliation SET error_attempts = ?, next_attempt_at = ?, last_error = ? WHERE season_id = ?", exhausted ? 0 : errors, at(now + (exhausted ? 6 * 60 * 60 * 1000 : retryDelay(errors))), exhausted ? "SUPER_BOWL_PROVIDER_RETRIES_EXHAUSTED_RECOVERING" : error instanceof Error ? error.message.slice(0, 200) : "RESULT_SOURCE_FAILED", lifecycle.season_id);
      }
    });
  }

  const due = [...state.storage.sql.exec<Row>("SELECT event_id, event_starts_at, phase, attempts, error_attempts, final_observed_at FROM event_reconciliation WHERE phase <> 'complete' AND next_attempt_at <= ? ORDER BY next_attempt_at", at(now))];
  if (due.length) try {
    const dueIds = due.map((r) => String(r.event_id));
    const observations = await source.getFinalResults(dueIds);
    const byEvent = new Map(observations.map((result) => [result.eventId, result]));
    const results = observations.map(snapshotResult);
    await state.storage.transaction(async () => {
      for (const result of results) if (terminal(result)) state.storage.sql.exec("INSERT OR REPLACE INTO event_result_snapshot (event_id, result_json, correction_version, observed_at) VALUES (?, ?, ?, ?)", result.eventId, JSON.stringify(result), result.correctionVersion, at(now));
      const snapshotRows = [...state.storage.sql.exec<Row>("SELECT result_json, observed_at FROM event_result_snapshot")];
      const snapshots = snapshotRows.map((r) => JSON.parse(String(r.result_json)) as FinalResultVersion);
      const observedAt = new Map(snapshotRows.map((row) => {
        const result = JSON.parse(String(row.result_json)) as FinalResultVersion;
        return [`${result.eventId}\u0000${result.league}\u0000${result.correctionVersion}`, String(row.observed_at)];
      }));
      settleWagers(state.storage.sql, snapshots, observedAt);
      for (const lifecycle of due) {
        const result = byEvent.get(String(lifecycle.event_id));
        if (!terminal(result)) {
          state.storage.sql.exec("UPDATE event_reconciliation SET attempts = ?, error_attempts = 0, next_attempt_at = ?, last_error = ? WHERE event_id = ?", Number(lifecycle.attempts) + 1, at(now + normalPollDelay(lifecycle.event_starts_at, now)), result?.status === "final" ? "FINAL_SCORES_INCOMPLETE" : "RESULT_NOT_TERMINAL", lifecycle.event_id);
          continue;
        }
        const phase = String(lifecycle.phase);
        if (phase !== "open" && !providerRefreshReady(phase, result)) {
          state.storage.sql.exec("UPDATE event_reconciliation SET attempts = ?, error_attempts = 0, next_attempt_at = ?, last_error = 'RESULT_REFRESH_PENDING' WHERE event_id = ?", Number(lifecycle.attempts) + 1, at(now + REFRESH_RETRY_DELAY), lifecycle.event_id);
          continue;
        }
        const observed = lifecycle.final_observed_at ? new Date(String(lifecycle.final_observed_at)).getTime() : now;
        if (phase === "open") state.storage.sql.exec("UPDATE event_reconciliation SET phase = 'final_15', attempts = 0, error_attempts = 0, final_observed_at = ?, deadline_at = ?, next_attempt_at = ?, last_error = NULL WHERE event_id = ?", at(observed), at(observed + FINAL_15_MINUTES), at(observed + FINAL_15_MINUTES), lifecycle.event_id);
        else if (phase === "final_15") state.storage.sql.exec("UPDATE event_reconciliation SET phase = 'final_2h', attempts = 0, error_attempts = 0, deadline_at = ?, next_attempt_at = ?, last_error = NULL WHERE event_id = ?", at(observed + FINAL_2_HOURS), at(observed + FINAL_2_HOURS), lifecycle.event_id);
        else if (phase === "final_2h") state.storage.sql.exec("UPDATE event_reconciliation SET phase = 'final_24', attempts = 0, error_attempts = 0, deadline_at = ?, next_attempt_at = ?, last_error = NULL WHERE event_id = ?", at(observed + FINAL_24_HOURS), at(observed + FINAL_24_HOURS), lifecycle.event_id);
        else state.storage.sql.exec("UPDATE event_reconciliation SET phase = 'complete', next_attempt_at = NULL, last_error = NULL WHERE event_id = ?", lifecycle.event_id);
      }
    });
  } catch (error) {
    await state.storage.transaction(async () => {
      for (const lifecycle of due) {
        const errors = Number(lifecycle.error_attempts) + 1;
        const exhausted = errors >= MAX_PROVIDER_ERROR_ATTEMPTS;
        // A provider outage may back off only a bounded number of times; it cannot abandon an accepted event.
        state.storage.sql.exec("UPDATE event_reconciliation SET error_attempts = ?, next_attempt_at = ?, last_error = ? WHERE event_id = ?", exhausted ? 0 : errors, at(now + (exhausted ? normalPollDelay(lifecycle.event_starts_at, now) : retryDelay(errors))), exhausted ? "RESULT_PROVIDER_RETRIES_EXHAUSTED_RECOVERING" : error instanceof Error ? error.message.slice(0, 200) : "RESULT_SOURCE_FAILED", lifecycle.event_id);
      }
    });
  }
  return nextSettlementAlarm(state.storage.sql);
}

/** Returns the earliest persisted settlement/discovery deadline for the DO's single alarm. */
export function nextSettlementAlarm(sql: SqlStorage): number | null {
  const next = [...sql.exec<Row>("SELECT next_attempt_at FROM (SELECT next_attempt_at FROM event_reconciliation WHERE phase <> 'complete' AND next_attempt_at IS NOT NULL UNION ALL SELECT r.next_attempt_at FROM season_super_bowl_reconciliation r JOIN season s ON s.id = r.season_id AND s.state = 'active' LEFT JOIN season_super_bowl sb ON sb.season_id = r.season_id WHERE sb.season_id IS NULL AND r.next_attempt_at IS NOT NULL) ORDER BY next_attempt_at LIMIT 1")][0];
  if (!next) return null;
  const deadline = new Date(String(next.next_attempt_at)).getTime();
  return Number.isFinite(deadline) ? deadline : null;
}

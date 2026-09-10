import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

type Row = Record<string, SqlStorageValue>;

const DAY = 24 * 60 * 60 * 1000;
const ELIGIBILITY_WINDOW_MS = 7 * DAY;
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const ATTEMPT_LEASE_MS = 10 * 60 * 1000;
const RETRY_DELAY_MS = 15 * 60 * 1000;
const first = (sql: SqlStorage, query: string, ...params: SqlStorageValue[]): Row | undefined => [...sql.exec<Row>(query, ...params)][0];
const iso = (at: number) => new Date(at).toISOString();
const reminderIdempotencyKey = (poolId: SqlStorageValue, seasonId: SqlStorageValue) => `season-closure/${bytesToHex(sha256(new TextEncoder().encode(`${String(poolId)}\u0000${String(seasonId)}`)))}`;

export const seasonClosureReminderDdl = `CREATE TABLE IF NOT EXISTS season_closure_reminder (
  season_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  event_starts_at TEXT NOT NULL,
  commissioner_id TEXT NOT NULL,
  recipient_email TEXT,
  pool_name TEXT NOT NULL,
  pool_slug TEXT NOT NULL,
  season_label TEXT NOT NULL,
  provider_event_name TEXT NOT NULL,
  provider_idempotency_key TEXT NOT NULL,
  first_attempt_at TEXT,
  retry_deadline_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  attempt_token TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  last_outcome TEXT NOT NULL,
  delivered_at TEXT,
  terminal_at TEXT,
  terminal_reason TEXT
)`;

type Authority = {
  pool_id: SqlStorageValue; pool_name: SqlStorageValue; pool_slug: SqlStorageValue; commissioner_id: SqlStorageValue;
  season_id: SqlStorageValue; season_label: SqlStorageValue; event_id: SqlStorageValue | null; provider_event_name: SqlStorageValue | null;
  event_starts_at: SqlStorageValue | null; confirmed_at: SqlStorageValue | null;
};

const authority = (sql: SqlStorage): Authority | undefined => first(sql, `
  SELECT p.id AS pool_id, p.name AS pool_name, p.slug AS pool_slug, p.commissioner_id,
         s.id AS season_id, s.label AS season_label, sb.event_id, sb.provider_event_name, sb.event_starts_at, sb.confirmed_at
  FROM pool p JOIN season s ON s.id = p.active_season_id AND s.state = 'active'
  LEFT JOIN season_super_bowl sb ON sb.season_id = s.id LIMIT 1
`) as Authority | undefined;

const terminate = (sql: SqlStorage, seasonId: SqlStorageValue, now: number, reason: string) => {
  sql.exec("UPDATE season_closure_reminder SET terminal_at = COALESCE(terminal_at, ?), terminal_reason = COALESCE(terminal_reason, ?), attempt_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL WHERE season_id = ? AND delivered_at IS NULL", iso(now), reason, seasonId);
};

type ValidAuthority = Authority & { event_id: SqlStorageValue; event_starts_at: SqlStorageValue; provider_event_name: SqlStorageValue };
const validAuthority = (current: Authority | undefined): current is ValidAuthority => Boolean(current && current.event_id !== null && current.event_starts_at !== null && current.provider_event_name !== null);

export type PreparedSeasonClosureReminder = {
  status: "prepared"; attemptToken: string; commissionerId: string;
};
export type ClaimedSeasonClosureReminder = {
  status: "claimed"; attemptToken: string; commissionerId: string; recipientEmail: string; poolName: string; poolSlug: string;
  seasonLabel: string; gameName: string; kickoff: string; idempotencyKey: string;
};

/** Reserves one due attempt while retaining all send authority inside this pool DO. */
export function prepareSeasonClosureReminder(sql: SqlStorage, now: number): PreparedSeasonClosureReminder | { status: "none" } {
  const current = authority(sql);
  if (!validAuthority(current)) {
    const pending = first(sql, "SELECT season_id FROM season_closure_reminder WHERE delivered_at IS NULL AND terminal_at IS NULL ORDER BY rowid LIMIT 1");
    if (pending) terminate(sql, pending.season_id, now, current ? "candidate_unavailable" : "season_inactive");
    return { status: "none" };
  }
  const kickoff = Date.parse(String(current.event_starts_at));
  if (!Number.isFinite(kickoff)) return { status: "none" };
  const existing = first(sql, "SELECT * FROM season_closure_reminder WHERE season_id = ?", current.season_id);
  if (current.confirmed_at !== null) {
    if (existing) terminate(sql, current.season_id, now, "acknowledged");
    return { status: "none" };
  }
  if (now >= kickoff) {
    if (existing) terminate(sql, current.season_id, now, "kickoff_reached");
    return { status: "none" };
  }
  if (now < kickoff - ELIGIBILITY_WINDOW_MS) return { status: "none" };

  if (existing) {
    if (existing.delivered_at !== null || existing.terminal_at !== null) return { status: "none" };
    const firstAttemptAt = existing.first_attempt_at === null ? null : Date.parse(String(existing.first_attempt_at));
    if (String(existing.event_id) !== String(current.event_id) || String(existing.event_starts_at) !== String(current.event_starts_at)) {
      terminate(sql, current.season_id, now, "candidate_changed");
      return { status: "none" };
    }
    if (String(existing.commissioner_id) !== String(current.commissioner_id)) {
      if (firstAttemptAt !== null) {
        terminate(sql, current.season_id, now, "commissioner_changed");
        return { status: "none" };
      }
      sql.exec("UPDATE season_closure_reminder SET commissioner_id = ?, recipient_email = NULL WHERE season_id = ?", current.commissioner_id, current.season_id);
    }
    const deadline = existing.retry_deadline_at === null ? null : Date.parse(String(existing.retry_deadline_at));
    if (deadline !== null && now >= deadline) {
      terminate(sql, current.season_id, now, "retry_window_elapsed");
      return { status: "none" };
    }
    const nextAttempt = existing.next_attempt_at === null ? null : Date.parse(String(existing.next_attempt_at));
    if (nextAttempt !== null && now < nextAttempt) return { status: "none" };
    const lease = existing.lease_expires_at === null ? null : Date.parse(String(existing.lease_expires_at));
    if (lease !== null && now < lease) return { status: "none" };
  } else {
    sql.exec(`INSERT INTO season_closure_reminder (
      season_id, event_id, event_starts_at, commissioner_id, pool_name, pool_slug, season_label, provider_event_name,
      provider_idempotency_key, last_outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`, current.season_id, current.event_id, current.event_starts_at, current.commissioner_id,
      current.pool_name, current.pool_slug, current.season_label, current.provider_event_name, reminderIdempotencyKey(current.pool_id, current.season_id));
  }

  const attemptToken = crypto.randomUUID();
  sql.exec("UPDATE season_closure_reminder SET attempt_token = ?, lease_expires_at = ?, next_attempt_at = NULL, last_outcome = 'reserved' WHERE season_id = ?", attemptToken, iso(now + ATTEMPT_LEASE_MS), current.season_id);
  return { status: "prepared", attemptToken, commissionerId: String(current.commissioner_id) };
}

/** Freezes and returns the exact payload only after a final authority/recipient check. */
export function claimSeasonClosureReminder(sql: SqlStorage, input: { now: number; attemptToken: string; commissionerId: string; recipientEmail: string }): ClaimedSeasonClosureReminder | { status: "none" } {
  const current = authority(sql);
  if (!validAuthority(current)) {
    const pending = first(sql, "SELECT season_id FROM season_closure_reminder WHERE attempt_token = ? AND delivered_at IS NULL AND terminal_at IS NULL", input.attemptToken);
    if (pending) terminate(sql, pending.season_id, input.now, current ? "candidate_unavailable" : "season_inactive");
    return { status: "none" };
  }
  const row = first(sql, "SELECT * FROM season_closure_reminder WHERE season_id = ?", current.season_id);
  const kickoff = Date.parse(String(current.event_starts_at));
  if (!row || row.delivered_at !== null || row.terminal_at !== null || row.attempt_token !== input.attemptToken || !Number.isFinite(kickoff)) return { status: "none" };
  const lease = row.lease_expires_at === null ? Number.NaN : Date.parse(String(row.lease_expires_at));
  if (row.last_outcome !== "reserved" || !Number.isFinite(lease) || input.now >= lease) return { status: "none" };
  if (current.confirmed_at !== null || input.now >= kickoff || String(current.event_id) !== String(row.event_id) || String(current.event_starts_at) !== String(row.event_starts_at)) {
    terminate(sql, current.season_id, input.now, current.confirmed_at !== null ? "acknowledged" : "kickoff_or_candidate_changed");
    return { status: "none" };
  }
  if (String(current.commissioner_id) !== input.commissionerId || String(row.commissioner_id) !== input.commissionerId) {
    if (row.first_attempt_at !== null) terminate(sql, current.season_id, input.now, "commissioner_changed");
    else sql.exec("UPDATE season_closure_reminder SET attempt_token = NULL, lease_expires_at = NULL, next_attempt_at = ?, last_outcome = 'authority_changed' WHERE season_id = ?", iso(input.now), current.season_id);
    return { status: "none" };
  }
  const recipientEmail = input.recipientEmail.trim();
  if (!recipientEmail || (row.recipient_email !== null && row.recipient_email !== recipientEmail)) {
    if (row.first_attempt_at !== null) terminate(sql, current.season_id, input.now, "recipient_changed");
    return { status: "none" };
  }
  const deadline = row.retry_deadline_at === null ? Math.min(kickoff, input.now + RETRY_WINDOW_MS) : Date.parse(String(row.retry_deadline_at));
  if (!Number.isFinite(deadline) || input.now >= deadline) {
    terminate(sql, current.season_id, input.now, "retry_window_elapsed");
    return { status: "none" };
  }
  sql.exec(`UPDATE season_closure_reminder SET recipient_email = COALESCE(recipient_email, ?), first_attempt_at = COALESCE(first_attempt_at, ?),
    retry_deadline_at = COALESCE(retry_deadline_at, ?), attempts = attempts + 1, last_attempt_at = ?, lease_expires_at = ?, last_outcome = 'attempting' WHERE season_id = ?`,
    recipientEmail, iso(input.now), iso(deadline), iso(input.now), iso(input.now + ATTEMPT_LEASE_MS), current.season_id);
  const frozen = first(sql, "SELECT * FROM season_closure_reminder WHERE season_id = ?", current.season_id)!;
  return {
    status: "claimed", attemptToken: input.attemptToken, commissionerId: input.commissionerId, recipientEmail,
    poolName: String(frozen.pool_name), poolSlug: String(frozen.pool_slug), seasonLabel: String(frozen.season_label),
    gameName: String(frozen.provider_event_name), kickoff: String(frozen.event_starts_at), idempotencyKey: String(frozen.provider_idempotency_key)
  };
}

/** Records provider acceptance or an ambiguous provider failure; failures never set delivered_at. */
export function finishSeasonClosureReminder(sql: SqlStorage, input: { now: number; attemptToken: string; outcome: "accepted" | "provider_failed" }): { status: "recorded" | "none" } {
  const row = first(sql, "SELECT season_id, event_starts_at, retry_deadline_at, attempt_token, last_outcome, delivered_at FROM season_closure_reminder WHERE attempt_token = ?", input.attemptToken);
  if (!row || row.attempt_token !== input.attemptToken || row.last_outcome !== "attempting" || row.delivered_at !== null) return { status: "none" };
  if (input.outcome === "accepted") {
    sql.exec("UPDATE season_closure_reminder SET delivered_at = ?, last_outcome = 'accepted', attempt_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL WHERE season_id = ?", iso(input.now), row.season_id);
  } else {
    const deadline = Math.min(Date.parse(String(row.event_starts_at)), Date.parse(String(row.retry_deadline_at)));
    const next = input.now + RETRY_DELAY_MS;
    sql.exec("UPDATE season_closure_reminder SET last_outcome = 'provider_failed', attempt_token = NULL, lease_expires_at = NULL, next_attempt_at = ? WHERE season_id = ?", next < deadline ? iso(next) : null, row.season_id);
    if (next >= deadline) terminate(sql, row.season_id, input.now, "retry_window_elapsed");
  }
  return { status: "recorded" };
}

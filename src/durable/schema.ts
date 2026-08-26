import { TEASER_RULESET_ID } from "../domain/teaser-table";

/** PoolDO-local authority schema. Accounting amounts are canonical integer TEXT, never REAL. */
export const poolSchema = [
  `CREATE TABLE IF NOT EXISTS pool (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, commissioner_id TEXT NOT NULL, password_hash TEXT NOT NULL, password_version INTEGER NOT NULL, signups_open INTEGER NOT NULL, active_season_id TEXT, command_version TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS member (user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('commissioner','member')), status TEXT NOT NULL CHECK(status IN ('active','suspended')), joined_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS season (id TEXT PRIMARY KEY, label TEXT NOT NULL, ruleset_version TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','active','closed')), created_at TEXT NOT NULL, opened_at TEXT, closed_at TEXT, close_reason TEXT, float_micros TEXT NOT NULL, notional_micros TEXT NOT NULL, default_mode TEXT, default_amount_micros TEXT, command_version TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS share_account (season_id TEXT NOT NULL, member_id TEXT NOT NULL, available_micros TEXT NOT NULL, locked_micros TEXT NOT NULL, row_version TEXT NOT NULL, PRIMARY KEY(season_id, member_id))`,
  `CREATE TABLE IF NOT EXISTS share_order (id TEXT PRIMARY KEY, season_id TEXT NOT NULL, member_id TEXT NOT NULL, actor_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('shares','value')), requested_micros TEXT NOT NULL, shares_micros TEXT NOT NULL, value_micros TEXT NOT NULL, price_micros TEXT NOT NULL, reversal_of TEXT, reason TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ledger_entry (id TEXT PRIMARY KEY, season_id TEXT NOT NULL, member_id TEXT NOT NULL, actor_id TEXT NOT NULL, available_delta TEXT NOT NULL, locked_delta TEXT NOT NULL, float_delta TEXT NOT NULL, notional_delta TEXT NOT NULL, causation_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wager (id TEXT PRIMARY KEY, season_id TEXT NOT NULL, owner_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('straight','teaser')), risk_micros TEXT NOT NULL, accepted_odds INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','won','lost','refunded')), ruleset_version TEXT NOT NULL, settled_result_version TEXT, confirmed_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wager_leg (id TEXT PRIMARY KEY, wager_id TEXT NOT NULL, event_id TEXT NOT NULL, league TEXT NOT NULL, canonical_book TEXT NOT NULL, retrieved_at TEXT NOT NULL, policy_version TEXT NOT NULL, offer_version TEXT NOT NULL, canonical_offer_id TEXT, canonical_proof_json TEXT, market TEXT NOT NULL, selection TEXT NOT NULL, original_line TEXT, original_odds INTEGER NOT NULL, teaser_adjustment TEXT, adjusted_line TEXT, event_starts_at TEXT NOT NULL, is_super_bowl INTEGER NOT NULL DEFAULT 0, grade TEXT, result_version TEXT)`,
  `CREATE TABLE IF NOT EXISTS wager_leg_snapshot (wager_leg_id TEXT PRIMARY KEY, home_team TEXT NOT NULL, away_team TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settlement (id TEXT PRIMARY KEY, wager_id TEXT NOT NULL, result_version TEXT NOT NULL, outcome TEXT NOT NULL, return_micros TEXT NOT NULL, profit_micros TEXT NOT NULL, source_result_json TEXT NOT NULL, reversal_of TEXT, actor_id TEXT NOT NULL DEFAULT 'system', reason TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wager_correction (id TEXT PRIMARY KEY, wager_id TEXT NOT NULL, actor_id TEXT NOT NULL, reason TEXT NOT NULL, source_result_json TEXT NOT NULL, replacement_result_json TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS administration_audit (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, subject_id TEXT NOT NULL, reason TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`,
  /** One durable polling lifecycle per referenced event: normal polls never exhaust; provider failures use bounded backoff before coverage resumes. */
  `CREATE TABLE IF NOT EXISTS event_reconciliation (event_id TEXT PRIMARY KEY, event_starts_at TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('open','final_15','final_24','complete')), attempts INTEGER NOT NULL DEFAULT 0, error_attempts INTEGER NOT NULL DEFAULT 0, deadline_at TEXT, next_attempt_at TEXT, final_observed_at TEXT, last_error TEXT)`,
  `CREATE TABLE IF NOT EXISTS event_result_snapshot (event_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, correction_version TEXT NOT NULL, observed_at TEXT NOT NULL)`,
  /** Frozen provider evidence actually applied to one season. Rows are append-only and ordered within that season. */
  `CREATE TABLE IF NOT EXISTS season_provider_result (season_id TEXT NOT NULL, event_id TEXT NOT NULL, league TEXT NOT NULL, correction_version TEXT NOT NULL, result_json TEXT NOT NULL, observed_at TEXT NOT NULL, append_order INTEGER NOT NULL, PRIMARY KEY(season_id, event_id, league, correction_version), UNIQUE(season_id, append_order))`,

  /** Provider-derived Super Bowl identity is immutable; only a commissioner can confirm it for closure. */
  `CREATE TABLE IF NOT EXISTS season_super_bowl (season_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, provider_event_name TEXT NOT NULL, event_starts_at TEXT, confirmed_at TEXT)`,
  /** Active seasons independently and durably discover their provider-derived Super Bowl candidate. */
  `CREATE TABLE IF NOT EXISTS season_super_bowl_reconciliation (season_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, error_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT)`,
  `CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, version TEXT NOT NULL, payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS season_annotation (id TEXT PRIMARY KEY, season_id TEXT NOT NULL, actor_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS processed_command (id TEXT PRIMARY KEY, type TEXT NOT NULL, actor_id TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT NOT NULL, expires_at TEXT NOT NULL)`,
  /** Authoritative quote bindings survive D1 changes and are compared before any placement mutation. */
  `CREATE TABLE IF NOT EXISTS wager_quote (actor_id TEXT NOT NULL, quote_key TEXT NOT NULL, fingerprint TEXT NOT NULL, wager_id TEXT NOT NULL, kind TEXT NOT NULL, terms_json TEXT NOT NULL, command_version TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(actor_id, quote_key))`
] as const;

/** Idempotently upgrades existing PoolDO SQLite files without depending on wall-clock time. */
export const migrateSeasonCreatedAt = (sql: SqlStorage): void => {
  const columns = [...sql.exec<{ name: string }>("PRAGMA table_info(season)")];
  if (!columns.some((column) => column.name === "created_at")) sql.exec("ALTER TABLE season ADD COLUMN created_at TEXT");
  // Historical draft rows have no lifecycle timestamp. The fixed epoch makes their backfill stable across restarts.
  sql.exec("UPDATE season SET created_at = COALESCE(NULLIF(created_at, ''), opened_at, closed_at, '1970-01-01T00:00:00.000Z') WHERE created_at IS NULL OR created_at = ''");
  if (!columns.some((column) => column.name === "ruleset_version")) sql.exec("ALTER TABLE season ADD COLUMN ruleset_version TEXT");
  // Seasons created before ruleset snapshots all used the sole fixed table available at that time.
  sql.exec("UPDATE season SET ruleset_version = ? WHERE ruleset_version IS NULL OR ruleset_version = ''", TEASER_RULESET_ID);
  const superBowlColumns = [...sql.exec<{ name: string }>("PRAGMA table_info(season_super_bowl)")];
  if (!superBowlColumns.some((column) => column.name === "event_starts_at")) sql.exec("ALTER TABLE season_super_bowl ADD COLUMN event_starts_at TEXT");
};

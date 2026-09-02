import { shapeAuditExportWagers } from "../durable/views";

type Row = Record<string, SqlStorageValue>;
const rows = (sql: SqlStorage, statement: string, ...params: SqlStorageValue[]) => [...sql.exec<Row>(statement, ...params)];
const text = (value: SqlStorageValue | undefined | null) => value === null || value === undefined ? null : String(value);

/** Immutable, exact-value audit representation; values remain canonical database text. */
export function memberAuditExport(sql: SqlStorage, memberId: string, currentTime = new Date()): Record<string, unknown> {
  const pool = rows(sql, "SELECT id, slug, name, commissioner_id, signups_open, command_version FROM pool LIMIT 1")[0];
  if (!pool) throw new Error("POOL_NOT_INITIALIZED");
  return {
    format: "share-value-pool-audit-v1",
    pool: { id: String(pool.id), slug: String(pool.slug), name: String(pool.name), commissionerId: String(pool.commissioner_id), signupsOpen: Boolean(pool.signups_open), commandVersion: String(pool.command_version) },
    seasons: rows(sql, "SELECT id, label, ruleset_version, state, opened_at, closed_at, close_reason, float_micros, notional_micros, default_mode, default_amount_micros, command_version FROM season ORDER BY id").map((row) => ({ id: String(row.id), label: String(row.label), rulesetVersion: String(row.ruleset_version), state: String(row.state), openedAt: text(row.opened_at), closedAt: text(row.closed_at), closeReason: text(row.close_reason), floatMicros: String(row.float_micros), notionalMicros: String(row.notional_micros), defaultMode: text(row.default_mode), defaultAmountMicros: text(row.default_amount_micros), commandVersion: String(row.command_version) })),
    seasonProviderResults: rows(sql, "SELECT season_id, event_id, league, correction_version, result_json, observed_at, CAST(append_order AS TEXT) AS append_order_text FROM season_provider_result ORDER BY season_id, append_order").map((row) => ({ seasonId: String(row.season_id), eventId: String(row.event_id), league: String(row.league), correctionVersion: String(row.correction_version), observedAt: String(row.observed_at), appendOrder: String(row.append_order_text), result: JSON.parse(String(row.result_json)) })),
    accounts: rows(sql, "SELECT season_id, member_id, available_micros, locked_micros, row_version FROM share_account ORDER BY season_id, member_id").map((row) => ({ seasonId: String(row.season_id), memberId: String(row.member_id), availableMicros: String(row.available_micros), lockedMicros: String(row.locked_micros), rowVersion: String(row.row_version) })),
    orders: rows(sql, "SELECT id, season_id, member_id, actor_id, mode, requested_micros, shares_micros, value_micros, price_micros, reversal_of, reason, command_id, created_at FROM share_order ORDER BY created_at, rowid").map((row) => ({ id: String(row.id), seasonId: String(row.season_id), memberId: String(row.member_id), actorId: String(row.actor_id), mode: String(row.mode), requestedMicros: String(row.requested_micros), sharesMicros: String(row.shares_micros), valueMicros: String(row.value_micros), priceMicros: String(row.price_micros), reversalOf: text(row.reversal_of), reason: String(row.reason), commandId: String(row.command_id), createdAt: String(row.created_at) })),
    ledger: rows(sql, "SELECT id, season_id, member_id, actor_id, available_delta, locked_delta, float_delta, notional_delta, causation_id, kind, created_at FROM ledger_entry ORDER BY created_at, rowid").map((row) => ({ id: String(row.id), seasonId: String(row.season_id), memberId: String(row.member_id), actorId: String(row.actor_id), availableDelta: String(row.available_delta), lockedDelta: String(row.locked_delta), floatDelta: String(row.float_delta), notionalDelta: String(row.notional_delta), causationId: String(row.causation_id), kind: String(row.kind), createdAt: String(row.created_at) })),
    settlements: rows(sql, "SELECT id, wager_id, result_version, outcome, return_micros, profit_micros, source_result_json, reversal_of, actor_id, reason, created_at FROM settlement ORDER BY created_at, rowid").map((row) => ({ id: String(row.id), wagerId: String(row.wager_id), resultVersion: String(row.result_version), outcome: String(row.outcome), returnMicros: String(row.return_micros), profitMicros: String(row.profit_micros), sourceResult: JSON.parse(String(row.source_result_json)), reversalOf: text(row.reversal_of), actorId: String(row.actor_id), reason: text(row.reason), createdAt: String(row.created_at) })),
    wagerCorrections: rows(sql, "SELECT id, wager_id, actor_id, reason, source_result_json, replacement_result_json, command_id, created_at FROM wager_correction ORDER BY created_at, rowid").map((row) => ({ id: String(row.id), wagerId: String(row.wager_id), actorId: String(row.actor_id), reason: String(row.reason), sourceResult: JSON.parse(String(row.source_result_json)), replacementResult: JSON.parse(String(row.replacement_result_json)), commandId: String(row.command_id), createdAt: String(row.created_at) })),
    administrationAudit: rows(sql, "SELECT id, actor_id, action, subject_id, reason, command_id, created_at FROM administration_audit ORDER BY created_at, rowid").map((row) => ({ id: String(row.id), actorId: String(row.actor_id), action: String(row.action), subjectId: String(row.subject_id), reason: String(row.reason), commandId: String(row.command_id), createdAt: String(row.created_at) })),
    seasonAnnotations: rows(sql, "SELECT id, season_id, actor_id, text, created_at FROM season_annotation ORDER BY created_at, rowid").map((row) => ({ id: String(row.id), seasonId: String(row.season_id), actorId: String(row.actor_id), text: String(row.text), createdAt: String(row.created_at) })),
    // Portable exports retain requester-owned exact values, but no requester receives future event identity.
    ...shapeAuditExportWagers(sql, memberId, currentTime)
  };
}

/** Infrastructure-only backup source. It intentionally includes immutable raw wager/audit rows. */
export function infrastructureAuditExport(sql: SqlStorage): Record<string, unknown> {
  const orphanSnapshot = rows(sql, "SELECT wager_leg_snapshot.wager_leg_id FROM wager_leg_snapshot LEFT JOIN wager_leg ON wager_leg.id = wager_leg_snapshot.wager_leg_id WHERE wager_leg.id IS NULL LIMIT 1")[0];
  if (orphanSnapshot) throw new Error(`WAGER_LEG_SNAPSHOT_ORPHAN:${String(orphanSnapshot.wager_leg_id)}`);
  const missingSnapshot = rows(sql, "SELECT wager_leg.id FROM wager_leg LEFT JOIN wager_leg_snapshot ON wager_leg_snapshot.wager_leg_id = wager_leg.id WHERE wager_leg_snapshot.wager_leg_id IS NULL LIMIT 1")[0];
  if (missingSnapshot) throw new Error(`WAGER_LEG_SNAPSHOT_MISSING:${String(missingSnapshot.id)}`);
  const base = memberAuditExport(sql, "__backup_infrastructure__");
  return {
    ...base,
    wagers: rows(sql, "SELECT id, season_id, owner_id, type, risk_micros, accepted_odds, status, ruleset_version, settled_result_version, confirmed_at FROM wager ORDER BY confirmed_at, rowid"),
    wagerLegs: rows(sql, "SELECT id, wager_id, event_id, league, canonical_book, retrieved_at, policy_version, offer_version, canonical_offer_id, canonical_proof_json, market, selection, original_line, original_odds, teaser_adjustment, adjusted_line, event_starts_at, is_super_bowl, grade, result_version FROM wager_leg ORDER BY wager_id, id"),
    wagerLegSnapshots: rows(sql, "SELECT wager_leg_snapshot.wager_leg_id, wager_leg_snapshot.home_team, wager_leg_snapshot.away_team FROM wager_leg JOIN wager_leg_snapshot ON wager_leg_snapshot.wager_leg_id = wager_leg.id ORDER BY wager_leg.wager_id, wager_leg.id").map((row) => ({ wagerLegId: String(row.wager_leg_id), homeTeam: String(row.home_team), awayTeam: String(row.away_team) })),
    messageBoardEntries: rows(sql, "SELECT id, parent_post_id, author_id, text, created_at, activity_at, is_announcement FROM message_board_entry ORDER BY created_at, rowid"),
    messageBoardReadStates: rows(sql, "SELECT member_id, last_read_at FROM message_board_read ORDER BY member_id")
  };
}

type Row = Record<string, SqlStorageValue>;

/** Removes undefined branches recursively so redacted JSON cannot retain a hidden nested field. */
export function redactRecursively(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRecursively);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => nested === undefined ? [] : [[key, redactRecursively(nested)]]));
  return value;
}

type LegRevealPolicy = "owner-or-started" | "started-only";

/** Commissioner status is deliberately irrelevant: only a ticket owner sees an unstarted selection. */
export function shapeWagers(sql: SqlStorage, viewerId: string, now = new Date(), ownerOnly = false, seasonId?: string): { wagers: unknown[] } {
  return shapeWagersWithPolicy(sql, viewerId, now, ownerOnly, seasonId, "owner-or-started");
}

/** Member exports keep owner financial fields but reveal every ticket's legs only as each leg starts. */
export function shapeAuditExportWagers(sql: SqlStorage, requesterId: string, now = new Date()): { wagers: unknown[] } {
  return shapeWagersWithPolicy(sql, requesterId, now, false, undefined, "started-only");
}

function shapeWagersWithPolicy(sql: SqlStorage, viewerId: string, now: Date, ownerOnly: boolean, seasonId: string | undefined, legRevealPolicy: LegRevealPolicy): { wagers: unknown[] } {
  // This read powers My Wagers: unlike the member-visible activity ledger it never returns another member's ticket.
  const conditions = [ownerOnly ? "owner_id = ?" : undefined, seasonId ? "season_id = ?" : undefined].filter((condition): condition is string => Boolean(condition));
  const query = `SELECT wager.id, wager.season_id, wager.owner_id, member.display_name AS owner_display_name, wager.type, wager.risk_micros, wager.accepted_odds, wager.status, wager.ruleset_version, wager.confirmed_at FROM wager JOIN member ON member.user_id = wager.owner_id${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY wager.confirmed_at, wager.rowid`;
  const wagers = [...sql.exec<Row>(query, ...(ownerOnly ? [viewerId] : []), ...(seasonId ? [seasonId] : []))].map((wager) => {
    const ownsTicket = String(wager.owner_id) === viewerId;
    const revealed = [...sql.exec<Row>("SELECT event_id, league, canonical_book, retrieved_at, policy_version, offer_version, market, selection, original_line, original_odds, teaser_adjustment, adjusted_line, event_starts_at, wager_leg_snapshot.home_team AS home_team, wager_leg_snapshot.away_team AS away_team, grade, result_version FROM wager_leg LEFT JOIN wager_leg_snapshot ON wager_leg_snapshot.wager_leg_id = wager_leg.id WHERE wager_id = ? ORDER BY id", wager.id)]
      .filter((leg) => (ownsTicket && legRevealPolicy === "owner-or-started") || new Date(String(leg.event_starts_at)).getTime() <= now.getTime())
      .map((leg) => ({ eventId: String(leg.event_id), league: String(leg.league), canonicalBook: String(leg.canonical_book), retrievedAt: String(leg.retrieved_at), policyVersion: String(leg.policy_version), offerVersion: String(leg.offer_version), market: String(leg.market), selection: String(leg.selection), originalLine: leg.original_line === null ? undefined : String(leg.original_line), originalOdds: Number(leg.original_odds), teaserAdjustment: leg.teaser_adjustment === null ? undefined : String(leg.teaser_adjustment), adjustedLine: leg.adjusted_line === null ? undefined : String(leg.adjusted_line), eventStartsAt: String(leg.event_starts_at), ...(leg.home_team === null ? {} : { homeTeam: String(leg.home_team), awayTeam: String(leg.away_team) }), grade: leg.grade === null ? undefined : String(leg.grade), resultVersion: leg.result_version === null ? undefined : String(leg.result_version) }));
    const settlement = firstSettlement(sql, String(wager.id));
    return redactRecursively({ wagerId: String(wager.id), seasonId: String(wager.season_id), memberId: String(wager.owner_id), memberDisplayName: String(wager.owner_display_name), type: String(wager.type), status: String(wager.status), confirmedAt: String(wager.confirmed_at), ...(ownsTicket ? { riskMicros: String(wager.risk_micros), acceptedOdds: Number(wager.accepted_odds), rulesetVersion: String(wager.ruleset_version), ...(settlement ?? {}) } : {}), ...(revealed.length ? { legs: revealed } : {}) });
  });
  return { wagers };
}

function firstSettlement(sql: SqlStorage, wagerId: string) {
  const row = [...sql.exec<Row>("SELECT s.outcome, s.return_micros, s.profit_micros, s.created_at FROM settlement s WHERE s.wager_id = ? AND s.outcome <> 'reversal' AND NOT EXISTS (SELECT 1 FROM settlement reversal WHERE reversal.reversal_of = s.id) ORDER BY s.created_at DESC LIMIT 1", wagerId)][0];
  // Settlement rows keep the internal win/loss/refund vocabulary; member reads publish won/lost/refunded.
  const outcome = { win: "won", loss: "lost", refund: "refunded" }[String(row?.outcome)] as "won" | "lost" | "refunded";
  return row ? { outcome, returnMicros: String(row.return_micros), profitMicros: String(row.profit_micros), settledAt: String(row.created_at) } : undefined;
}

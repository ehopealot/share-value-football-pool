const GRACE_MS = 20 * 60 * 1000;

/** PoolDO owns wager state; D1 supplies first-observed terminal times, never scheduled kickoff estimates. */
export async function countOverdueWagers(sql: SqlStorage, db: D1Database, now = Date.now()): Promise<number> {
  const legs = [...sql.exec<{ wager_id: string; event_id: string }>("SELECT l.wager_id,l.event_id FROM wager w JOIN wager_leg l ON l.wager_id=w.id WHERE w.status='open'")];
  const ids = [...new Set(legs.map(leg => leg.event_id))];
  if (!ids.length) return 0;
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    statements.push(db.prepare(`SELECT provider_event_id,status,finalized_at FROM sports_event WHERE provider_event_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk));
  }
  const results = await db.batch<{ provider_event_id: string; status: string; finalized_at: string | null }>(statements);
  const terminalTimes = new Map(results.flatMap(result => result.results).filter(row => ["final", "cancelled", "no_contest"].includes(row.status) && row.finalized_at !== null).map(row => [row.provider_event_id, Date.parse(row.finalized_at!)]));
  const latest = new Map<string, number>();
  for (const leg of legs) {
    // Missing or malformed final evidence cannot establish a post-game deadline.
    const finalAt = terminalTimes.get(leg.event_id);
    latest.set(leg.wager_id, Math.max(latest.get(leg.wager_id) ?? 0, finalAt !== undefined && Number.isFinite(finalAt) ? finalAt : Infinity));
  }
  // Settlement may have completed during the D1 read. Never alert from an old open-status snapshot.
  const stillOpen = [...sql.exec<{ id: string }>("SELECT id FROM wager WHERE status='open'")];
  return stillOpen.filter(wager => latest.has(wager.id) && latest.get(wager.id)! <= now - GRACE_MS).length;
}

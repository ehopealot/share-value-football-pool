import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { drainOutbox, nextOutboxAttempt, type PoolOutboxMessage } from "../../src/durable/outbox";
import { poolSchema } from "../../src/durable/schema";

const pools = (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO;
const at = "2026-01-03T00:00:00.000Z";

function measureSql(sql: SqlStorage) {
  const queries: Array<{ statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }> = [];
  const measured = { exec: (statement: string, ...params: SqlStorageValue[]) => {
    const cursor = sql.exec(statement, ...params);
    queries.push({ statement, cursor });
    return cursor;
  } } as SqlStorage;
  // Read counters after the caller has consumed the real SQLite cursors.
  return { sql: measured, queries, rowsRead: () => queries.reduce((sum, query) => sum + query.cursor.rowsRead, 0) };
}

describe("PoolDO billed row-read efficiency", () => {
  it("reads standings history once per season rather than once per member", async () => {
    const stub = pools.get(pools.idFromName(`standings-reads-${crypto.randomUUID()}`));
    await runInDurableObject(stub, (instance, state) => {
      const sql = state.storage.sql;
      const huge = 9007199254740993n;
      for (const seasonId of ["active", "archived"]) {
        sql.exec("INSERT INTO season (id, label, ruleset_version, state, created_at, float_micros, notional_micros, command_version) VALUES (?, ?, 'SHARE_POOL_2026_V1', ?, ?, '0', '0', '1')", seasonId, seasonId, seasonId === "active" ? "active" : "closed", at);
      }
      for (let i = 0; i < 12; i++) {
        const member = `member-${i}`;
        sql.exec("INSERT INTO member VALUES (?, ?, 'member', ?, ?)", member, member, i === 0 ? "suspended" : "active", at);
        sql.exec("INSERT INTO share_account VALUES ('active', ?, ?, '1', '1')", member, (huge + BigInt(i) - 1n).toString());
        for (const seasonId of ["active", "archived"]) {
          for (const [suffix, value] of [["issue", huge], ["reverse", -(huge - 2n)]] as const) {
            const id = `${seasonId}-${member}-${suffix}`;
            sql.exec("INSERT INTO share_order VALUES (?, ?, ?, 'owner', 'value', ?, '1', ?, '1000000', NULL, 'fixture', ?, ?)", id, seasonId, member, value.toString(), value.toString(), id, at);
          }
        }
      }
      // Interleave members and seasons, including reaching, leaving, and regaining holdings.
      for (let entry = 0; entry < 40; entry++) for (let i = 0; i < 12; i++) for (const seasonId of ["active", "archived"]) {
        const delta = entry === 0 ? huge + BigInt(i) : entry === 1 ? -1n : entry === 2 ? 1n : 0n;
        sql.exec("INSERT INTO ledger_entry VALUES (?, ?, ?, 'owner', ?, '0', '0', '0', 'fixture', 'order', ?)", `${seasonId}-${i}-${entry}`, seasonId, `member-${i}`, delta.toString(), at);
      }
      sql.exec("INSERT INTO member VALUES ('empty', 'Empty', 'member', 'active', ?)", at);
      sql.exec("INSERT INTO share_account VALUES ('active', 'empty', '0', '0', '1')");

      // Baseline the former per-member history scans on the same database and data.
      const legacy = measureSql(sql);
      for (const member of sql.exec<{ member_id: string }>("SELECT member_id FROM share_account WHERE season_id = 'active'")) {
        legacy.sql.exec("SELECT value_micros FROM share_order WHERE season_id = ? AND member_id = ? ORDER BY created_at, rowid", "active", member.member_id).toArray();
        legacy.sql.exec("SELECT available_delta, locked_delta, created_at FROM ledger_entry WHERE season_id = ? AND member_id = ? ORDER BY created_at, rowid", "active", member.member_id).toArray();
      }
      // Invoke the production calculation with a measuring SQL adapter; endpoint behavior is
      // independently covered by t11-member-reads (including closed history and tie breaks).
      const reader = instance as unknown as { standings(sql: SqlStorage, seasonId: string | undefined): Array<Record<string, unknown>> };
      const measured = measureSql(sql);
      expect(reader.standings(measured.sql, undefined)).toEqual([]);
      expect(measured.queries).toHaveLength(0);
      const standings = reader.standings(measured.sql, "active");
      const expected = Array.from({ length: 12 }, (_, rank) => {
        const i = 11 - rank;
        return { rank: rank + 1, userId: `member-${i}`, displayName: `member-${i}`, availableMicros: (huge + BigInt(i) - 1n).toString(), lockedMicros: "1", totalMicros: (huge + BigInt(i)).toString(), priceMicros: "1000000", notionalValueMicros: (huge + BigInt(i)).toString(), gainMicros: (huge + BigInt(i) - 2n).toString(), riskedMicros: "0" };
      });
      expect(standings).toEqual([...expected, { rank: 13, userId: "empty", displayName: "Empty", availableMicros: "0", lockedMicros: "0", totalMicros: "0", priceMicros: "1000000", notionalValueMicros: "0", gainMicros: "0", riskedMicros: "0" }]);
      const historyReads = measured.queries.filter(({ statement }) => /FROM (ledger_entry|share_order)\b/.test(statement));
      const rowsRead = historyReads.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0);
      expect(rowsRead).toBeLessThan(legacy.rowsRead() / 4);
      expect(historyReads).toHaveLength(2);
    });
  });

  it("indexes pending outbox reads on existing data and preserves drain boundaries and retries", async () => {
    const stub = pools.get(pools.idFromName(`outbox-reads-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      // Simulate upgrading an existing object's populated outbox.
      sql.exec("DROP INDEX IF EXISTS outbox_pending_retry_idx");
      sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
        INSERT INTO outbox (id, event_type, version, payload_json, attempts, next_attempt_at, delivered_at, created_at)
        SELECT 'history-' || i, 'CommandApplied', '1', '{}', CASE WHEN i % 2 = 0 THEN 5 ELSE 1 END,
          '2026-01-01T00:00:00.000Z', CASE WHEN i % 2 = 0 THEN NULL ELSE '2026-01-02T00:00:00.000Z' END, '2026-01-01T00:00:00.000Z' FROM n`);
      for (let i = 0; i < 26; i++) {
        // Equal created_at must retain append order even when retry order differs.
        sql.exec("INSERT INTO outbox (id, event_type, version, payload_json, attempts, next_attempt_at, created_at) VALUES (?, 'CommandApplied', '1', ?, 4, ?, ?)", `due-${i}`,
          JSON.stringify({ poolId: "pool", actorId: "owner", commandId: `due-${i}`, commandType: "JoinPool", memberId: "member" }), i % 2 ? "2026-01-02T00:00:00.000Z" : at, at);
      }
      sql.exec("INSERT INTO outbox (id, event_type, version, payload_json, attempts, next_attempt_at, created_at) VALUES ('future', 'CommandApplied', '1', '{}', 0, '2099-01-01T00:00:00.000Z', ?)", at);
      for (let pass = 0; pass < 2; pass++) for (const statement of poolSchema) sql.exec(statement);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM outbox").one().count).toBe(2027);

      const measured = measureSql(sql);
      const measuredState = { storage: { sql: measured.sql, transaction: state.storage.transaction.bind(state.storage) } } as unknown as DurableObjectState;
      const sent: string[] = [];
      const queue = { send: async (message: PoolOutboxMessage) => { sent.push(message.eventId); } } as unknown as Queue<PoolOutboxMessage>;
      expect(nextOutboxAttempt(measuredState)).toBe(Date.parse("2026-01-02T00:00:00.000Z"));
      expect(await drainOutbox(measuredState, queue, new Date(at))).toEqual({ pending: true });
      expect(sent).toEqual(Array.from({ length: 25 }, (_, i) => `due-${i}`));
      const reads = measured.queries.filter(({ statement }) => statement.startsWith("SELECT"));
      expect(reads).toHaveLength(3); // next retry, due batch, pending existence
      const indexedRowsRead = reads.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0);
      expect(indexedRowsRead).toBeLessThan(200);
      for (const { statement } of reads) {
        const params = statement.includes("?") ? [at] : [];
        const plan = sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement}`, ...params).toArray();
        expect(plan.some(({ detail }) => detail.includes("outbox_pending_retry_idx"))).toBe(true);
      }

      // A failed fifth attempt becomes exhausted, not pending; future retry is still scheduled.
      const failing = { send: async () => { throw new Error("offline"); } } as unknown as Queue<PoolOutboxMessage>;
      expect(await drainOutbox(measuredState, failing, new Date(at))).toEqual({ pending: true });
      expect(sql.exec("SELECT attempts, delivered_at FROM outbox WHERE id = 'due-25'").one()).toEqual({ attempts: 5, delivered_at: null });
      expect(nextOutboxAttempt(measuredState)).toBe(Date.parse("2099-01-01T00:00:00.000Z"));
      sql.exec("UPDATE outbox SET delivered_at = ? WHERE id = 'future'", at);
      measured.queries.length = 0;
      expect(await drainOutbox(measuredState, queue, new Date(at))).toEqual({ pending: false });
      expect(nextOutboxAttempt(measuredState)).toBeNull();
      expect(measured.rowsRead()).toBeLessThan(10);
    });
  });
});

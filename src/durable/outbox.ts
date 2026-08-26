import { poolOutboxMessage, type PoolOutboxMessage as ContractPoolOutboxMessage } from "../contracts/commands";
import { recordQueuedProjection } from "../services/projections";
export type PoolOutboxMessage = ContractPoolOutboxMessage;
type Row = Record<string, SqlStorageValue>;
const timestamp = () => new Date().toISOString();

/** Called inside the command transaction: Queue delivery is deliberately never part of command success. */
export function enqueueOutbox(sql: SqlStorage, event: PoolOutboxMessage): void {
  const createdAt = timestamp();
  sql.exec("INSERT INTO outbox (id, event_type, version, payload_json, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)", event.eventId, event.eventType, event.version, JSON.stringify(event.payload), createdAt, createdAt);
}

/** Drains committed rows after the command transaction. Failed sends remain recoverable pending rows. */
export async function drainOutbox(state: DurableObjectState, queue?: Queue<PoolOutboxMessage>, now = new Date(), db?: D1Database): Promise<{ pending: boolean }> {
  const rows = [...state.storage.sql.exec<Row>("SELECT id, event_type, version, payload_json, attempts FROM outbox WHERE delivered_at IS NULL AND attempts < 5 AND next_attempt_at <= ? ORDER BY created_at LIMIT 25", now.toISOString())];
  if (!queue) return { pending: rows.length > 0 };
  for (const row of rows) {
    let payload: unknown;
    try { payload = JSON.parse(String(row.payload_json)); } catch { payload = undefined; }
    const parsed = poolOutboxMessage.safeParse({ eventId: String(row.id), eventType: String(row.event_type), version: String(row.version), payload });
    // Preserve invalid committed rows for audit/repair while stopping unsafe delivery.
    if (!parsed.success) { state.storage.sql.exec("UPDATE outbox SET attempts = 5, last_error = 'INVALID_OUTBOX_EVENT' WHERE id = ?", row.id); continue; }
    const message: PoolOutboxMessage = parsed.data;
    try {
      // Persist the producer boundary before send so pre-consumer Queue lag is observable.
      if (db) await recordQueuedProjection(db, message);
      // Sending occurs after durable commit. An interrupted process leaves delivered_at NULL for recovery.
      await queue.send(message);
      await state.storage.transaction(async () => {
        state.storage.sql.exec("UPDATE outbox SET attempts = attempts + 1, delivered_at = ?, last_error = NULL WHERE id = ? AND delivered_at IS NULL", timestamp(), row.id);
      });
    } catch (error) {
      const attempts = Number(row.attempts) + 1;
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
      await state.storage.transaction(async () => {
        state.storage.sql.exec("UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ? AND delivered_at IS NULL", attempts, new Date(Date.now() + delayMs).toISOString(), error instanceof Error ? error.message.slice(0, 200) : "QUEUE_SEND_FAILED", row.id);
      });
    }
  }
  const pending = [...state.storage.sql.exec<Row>("SELECT 1 FROM outbox WHERE delivered_at IS NULL AND attempts < 5 LIMIT 1")].length > 0;
  return { pending };
}

/** Earliest recoverable Queue retry; callers must combine it with settlement coverage. */
export function nextOutboxAttempt(state: DurableObjectState): number | null {
  const row = [...state.storage.sql.exec<Row>("SELECT next_attempt_at FROM outbox WHERE delivered_at IS NULL AND attempts < 5 ORDER BY next_attempt_at LIMIT 1")][0];
  return row ? new Date(String(row.next_attempt_at)).getTime() : null;
}

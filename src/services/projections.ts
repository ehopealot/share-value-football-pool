import { poolOutboxMessage, type PoolOutboxMessage } from "../contracts/commands";

export type ProjectionSnapshot = {
  poolId: string;
  commandVersion: string;
  poolName: string;
  members: Array<{ userId: string; displayName: string; role: string; status: string }>;
  seasons: Array<{ seasonId: string; label: string; state: string; openedAt: string | null; closedAt: string | null }>;
};
export type ProjectionSnapshotReader = (message: PoolOutboxMessage) => Promise<ProjectionSnapshot>;
const now = () => new Date().toISOString();

/** Records the producer boundary once so end-to-end projection delivery age, including producer send/retry time, is observable. */
export async function recordQueuedProjection(db: D1Database, message: PoolOutboxMessage, queuedAt = now()): Promise<void> {
  await db.prepare("INSERT INTO projection_delivery (event_id, projection_version, attempts, queued_at, updated_at, last_error) VALUES (?, ?, 0, ?, ?, NULL) ON CONFLICT(event_id) DO NOTHING").bind(message.eventId, message.version, queuedAt, queuedAt).run();
}

const newer = "length(excluded.projection_version) > length(projection_state.projection_version) OR (length(excluded.projection_version) = length(projection_state.projection_version) AND excluded.projection_version > projection_state.projection_version)";

/** D1 directory data is disposable: accepted newer Queue messages rehydrate it from the authoritative PoolDO. */
export class ProjectionConsumer {
  constructor(private readonly db: D1Database, private readonly readSnapshot: ProjectionSnapshotReader) {}

  async consume(input: unknown): Promise<void> {
    const message = poolOutboxMessage.parse(input);
    await this.recordAttempt(message.eventId);
    const known = await this.db.prepare("SELECT delivered_at FROM projection_delivery WHERE event_id = ?").bind(message.eventId).first<{ delivered_at: string | null }>();
    if (known?.delivered_at) return;
    const state = await this.db.prepare("SELECT projection_version FROM projection_state WHERE scope = ?").bind(`pool:${message.payload.poolId}`).first<{ projection_version: string }>();
    if (state && BigInt(message.version) <= BigInt(state.projection_version)) {
      await this.db.prepare("UPDATE projection_delivery SET projection_version = ?, delivered_at = ?, updated_at = ?, last_error = NULL WHERE event_id = ?").bind(message.version, now(), now(), message.eventId).run();
      return;
    }
    try {
      const snapshot = await this.readSnapshot(message);
      if (snapshot.poolId !== message.payload.poolId || !/^(?:0|[1-9]\d*)$/.test(snapshot.commandVersion) || BigInt(snapshot.commandVersion) < BigInt(message.version)) throw new Error("INVALID_PROJECTION_SNAPSHOT");
      await this.persist(snapshot, message.eventId);
    } catch (error) {
      await this.db.prepare("UPDATE projection_delivery SET last_error = ?, updated_at = ? WHERE event_id = ? AND delivered_at IS NULL").bind(error instanceof Error ? error.message.slice(0, 200) : "PROJECTION_FAILED", now(), message.eventId).run();
      throw error;
    }
  }

  private async recordAttempt(eventId: string): Promise<void> {
    // Consumer recovery never replaces the producer timestamp measuring end-to-end projection delivery age, including producer send/retry time.
    await this.db.prepare("INSERT INTO projection_delivery (event_id, projection_version, attempts, queued_at, attempted_at, updated_at, last_error) VALUES (?, '0', 1, ?, ?, ?, NULL) ON CONFLICT(event_id) DO UPDATE SET attempts = projection_delivery.attempts + 1, attempted_at = excluded.attempted_at, updated_at = excluded.updated_at, last_error = NULL WHERE projection_delivery.delivered_at IS NULL").bind(eventId, now(), now(), now()).run();
  }

  private async persist(snapshot: ProjectionSnapshot, eventId: string): Promise<void> {
    const scope = `pool:${snapshot.poolId}`;
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`INSERT INTO projection_state (scope, projection_version) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET projection_version = excluded.projection_version WHERE ${newer}`).bind(scope, snapshot.commandVersion),
      this.db.prepare("DELETE FROM membership_projection WHERE pool_id = ? AND (SELECT projection_version FROM projection_state WHERE scope = ?) = ?").bind(snapshot.poolId, scope, snapshot.commandVersion),
      this.db.prepare("DELETE FROM season_projection WHERE pool_id = ? AND (SELECT projection_version FROM projection_state WHERE scope = ?) = ?").bind(snapshot.poolId, scope, snapshot.commandVersion)
    ];
    for (const member of snapshot.members) statements.push(this.db.prepare("INSERT INTO membership_projection (pool_id, user_id, pool_name, role, status, projection_version) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT projection_version FROM projection_state WHERE scope = ?) = ?").bind(snapshot.poolId, member.userId, snapshot.poolName, member.role, member.status, snapshot.commandVersion, scope, snapshot.commandVersion));
    for (const season of snapshot.seasons) statements.push(this.db.prepare("INSERT INTO season_projection (pool_id, season_id, label, state, opened_at, closed_at, projection_version) SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT projection_version FROM projection_state WHERE scope = ?) = ?").bind(snapshot.poolId, season.seasonId, season.label, season.state, season.openedAt, season.closedAt, snapshot.commandVersion, scope, snapshot.commandVersion));
    statements.push(this.db.prepare("UPDATE projection_delivery SET projection_version = ?, delivered_at = ?, updated_at = ?, last_error = NULL WHERE event_id = ?").bind(snapshot.commandVersion, now(), now(), eventId));
    await this.db.batch(statements);
  }
}

/** Token-authenticated DO reader for service-side projection consumers; it never forwards browser input. */
export function durableProjectionSnapshotReader(pools: DurableObjectNamespace, token?: string): ProjectionSnapshotReader {
  return async (message) => {
    if (!token) throw new Error("PROJECTION_SERVICE_UNAVAILABLE");
    const response = await pools.get(pools.idFromName(message.payload.poolId)).fetch("https://pool.internal/internal/projection", { headers: { "x-projection-service-token": token } });
    if (!response.ok) throw new Error("PROJECTION_SOURCE_UNAVAILABLE");
    return await response.json() as ProjectionSnapshot;
  };
}

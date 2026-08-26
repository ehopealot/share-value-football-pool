import { PoolDO as ProductionPoolDO } from "./pool-do";

type Row = Record<string, SqlStorageValue>;
const first = (sql: SqlStorage, query: string, ...params: SqlStorageValue[]): Row | undefined => [...sql.exec<Row>(query, ...params)][0];

/** Local-only DO identity: fixture requests are handled here; every command delegates unchanged. */
export class PoolDO extends ProductionPoolDO {
  constructor(state: DurableObjectState, env: ConstructorParameters<typeof ProductionPoolDO>[1]) {
    super(state, env);
    // The fixture read clock lives only in this identity's storage; the production schema never creates it.
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS local_read_time (id INTEGER PRIMARY KEY CHECK (id = 1), read_time TEXT NOT NULL)");
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__local-test/current-time") {
      if (request.method !== "POST") return new Response("Not found", { status: 404 });
      const body = await request.json().catch(() => null) as { currentTime?: unknown } | null;
      const currentTime = body?.currentTime;
      if (currentTime === null) {
        this.state.storage.sql.exec("DELETE FROM local_read_time");
        return Response.json({ ok: true, currentTime: null });
      }
      const at = typeof currentTime === "string" ? new Date(currentTime).getTime() : Number.NaN;
      if (!Number.isFinite(at)) return Response.json({ code: "INVALID_LOCAL_CONTROL" }, { status: 400 });
      this.state.storage.sql.exec("INSERT OR REPLACE INTO local_read_time (id, read_time) VALUES (1, ?)", currentTime);
      return Response.json({ ok: true, currentTime });
    }
    if (url.pathname === "/__local-test/alarm") {
      const at = new Date(url.searchParams.get("currentTime") ?? "").getTime();
      if (request.method !== "POST" || !Number.isFinite(at)) return new Response("Not found", { status: 404 });
      await this.alarm(at);
      const messages = [...this.state.storage.sql.exec<Row>("SELECT id, event_type, version, payload_json FROM outbox WHERE delivered_at IS NOT NULL")].map((row) => ({
        eventId: String(row.id), eventType: String(row.event_type), version: String(row.version), payload: JSON.parse(String(row.payload_json))
      }));
      return Response.json({ ok: true, messages });
    }
    if (url.pathname === "/__local-test/close-season") {
      if (request.method !== "POST") return new Response("Not found", { status: 404 });
      const sql = this.state.storage.sql;
      const season = first(sql, "SELECT id FROM season WHERE state = 'active'");
      const pool = first(sql, "SELECT commissioner_id FROM pool LIMIT 1");
      if (!season || !pool) return new Response("Not found", { status: 404 });
      await this.state.storage.transaction(async () => this.execute({ type: "CloseSeason", commandId: crypto.randomUUID(), actorId: String(pool.commissioner_id), seasonId: String(season.id), reason: "Local lifecycle test transition" }));
      return Response.json({ closed: true });
    }
    return super.fetch(request);
  }

  /** The stored fixture clock exercises the same human privacy boundaries without touching accepted wager snapshots. */
  protected override authoritativeTime(): Date {
    const stored = first(this.state.storage.sql, "SELECT read_time FROM local_read_time WHERE id = 1");
    return stored === undefined ? super.authoritativeTime() : new Date(String(stored.read_time));
  }
}

import { applyD1Migrations, env } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import pollGenerationMigration from "../../src/db/migrations/0002_odds_poll_generation.sql?raw";
import { describe, expect, it } from "vitest";
import { createProductionWorker, type Env } from "../../src/index";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace };
let migrated = false;
const secret = "provider-key-fixture";
const ensureMigrations = async () => {
  if (migrated) return;
  await applyD1Migrations(bindings.DB, [
    { name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) },
    { name: "0002_odds_poll_generation.sql", queries: pollGenerationMigration.split(";\n").filter(Boolean) }
  ]);
  migrated = true;
};

const context = () => {
  const pending: Promise<unknown>[] = [];
  return { pending, execution: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext };
};

describe("production scheduled Sentry composition", () => {
  it("keeps an unconfigured scheduled invocation a no-op", () => {
    const { pending, execution } = context();
    createProductionWorker().scheduled!({ scheduledTime: Date.now(), cron: "* * * * *", noRetry() {} } as ScheduledEvent, {} as Env, execution);
    expect(pending).toEqual([]);
  });

  it("captures a sanitized provider failure while preserving last-good polling state and rejection", async () => {
    await ensureMigrations();
    await bindings.DB.exec("DELETE FROM market_offer; DELETE FROM sports_event; DELETE FROM odds_ingestion; DELETE FROM odds_league_poll;");
    await bindings.DB.prepare("INSERT INTO odds_ingestion (provider, last_polled_at, last_success_at, last_error, canonical_book_availability_json) VALUES ('odds', ?, ?, NULL, '{}')").bind("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z").run();
    await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version, last_polled_at) VALUES ('event', 'event', 'nfl', 'Home', 'Away', '2099-01-01T00:00:00.000Z', 'scheduled', '1', '2000-01-01T00:00:00.000Z')").run();
    await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES ('event', 'spread', 'DraftKings', ?, 'v1', ?)").bind("2000-01-01T00:00:00.000Z", JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [] })).run();
    const envelopes: unknown[] = [];
    const transport = () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true });
    const worker = createProductionWorker({ oddsProvider: () => ({ events: async () => { throw new Error(secret); } }) });
    const { pending, execution } = context();
    const configured = { ...bindings, ODDS_API_KEY: secret, SENTRY_DSN: "https://public@sentry.invalid/1", SENTRY_TEST_TRANSPORT: transport } as unknown as Env;
    worker.scheduled!({ scheduledTime: Date.now(), cron: "* * * * *", noRetry() {} } as ScheduledEvent, configured, execution);
    await expect(Promise.all(pending)).rejects.toThrow(secret);
    expect((await bindings.DB.prepare("SELECT payload_json FROM market_offer WHERE event_id = 'event'").first())?.payload_json).toContain("CANONICAL_BOOKS_2026_V1");
    expect((await bindings.DB.prepare("SELECT last_error FROM odds_ingestion WHERE provider = 'odds'").first<{ last_error: string }>())?.last_error).toContain(secret);
    expect(envelopes.length).toBeGreaterThan(0);
    expect(JSON.stringify(envelopes)).not.toContain(secret);
  });

  it("coalesces mixed backup failures by category after the production scheduled run preserves its cursor", async () => {
    await ensureMigrations();
    await bindings.DB.exec("DELETE FROM backup_cursor; DELETE FROM pool_registry; INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'backup-owner@example.test', 1, 0, 0);");
    const ids = Array.from({ length: 100 }, (_, index) => `private-backup-${String(index).padStart(3, "0")}`);
    for (const poolId of ids) {
      await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, poolId, poolId, `create-${poolId}`, new Date().toISOString()).run();
    }
    const attempted: string[] = [];
    const pools = {
      idFromName: (name: string) => name,
      get: (id: string) => ({ fetch: async () => {
        attempted.push(id);
        if (Number(id.slice(-3)) % 2 === 0) return new Response("private export failure", { status: 500 });
        throw new Error("private backup item failure");
      } })
    } as unknown as DurableObjectNamespace;
    const writes: string[] = [];
    const bucket = { put: async (key: string) => { writes.push(key); } } as unknown as R2Bucket;
    const envelopes: unknown[] = [];
    const transport = () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true });
    const { pending, execution } = context();
    const configured = {
      ...bindings,
      POOL_DO: pools,
      BACKUPS: bucket,
      BACKUP_ENCRYPTION_KEY: btoa("x".repeat(32)),
      POOL_BACKUP_SERVICE_TOKEN: "private-backup-token",
      SENTRY_DSN: "https://public@sentry.invalid/1",
      SENTRY_TEST_TRANSPORT: transport
    } as unknown as Env;
    const cronError = console.error;
    console.error = () => undefined;
    try {
      await createProductionWorker().scheduled!({ scheduledTime: Date.now(), cron: "0 0 * * *", noRetry() {} } as ScheduledEvent, configured, execution);
      for (let offset = 0; offset < pending.length;) {
        const current = pending.slice(offset);
        offset = pending.length;
        await Promise.all(current);
      }
    } finally {
      console.error = cronError;
    }

    expect(attempted).toEqual(ids);
    expect(writes).toEqual([]);
    expect(await bindings.DB.prepare("SELECT last_pool_id FROM backup_cursor WHERE name = 'scheduled'").first()).toEqual({ last_pool_id: "private-backup-099" });
    expect(envelopes).toHaveLength(2);
    const events = envelopes.map((envelope) => (envelope as [unknown, Array<[unknown, { tags: Record<string, string>; fingerprint: string[] }]>])[1][0][1]);
    expect(events.map((event) => event.tags.sentry_category).sort()).toEqual(["backup-export-non-ok", "backup-item-exception"]);
    expect(events.map((event) => event.fingerprint).sort()).toEqual([
      ["sentry", "worker", "backup-export-non-ok"],
      ["sentry", "worker", "backup-item-exception"]
    ]);
    expect(JSON.stringify(envelopes)).not.toMatch(/private-backup|private export failure|private backup item failure/);
  }, 90_000);
});

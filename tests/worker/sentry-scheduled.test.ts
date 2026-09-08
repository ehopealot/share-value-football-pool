import { applyD1Migrations, env } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import pollGenerationMigration from "../../src/db/migrations/0002_odds_poll_generation.sql?raw";
import { describe, expect, it } from "vitest";
import { createProductionWorker, type Env } from "../../src/index";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace };
let migrated = false;
const secret = "provider-key-fixture";

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
    if (!migrated) {
      await applyD1Migrations(bindings.DB, [
        { name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) },
        { name: "0002_odds_poll_generation.sql", queries: pollGenerationMigration.split(";\n").filter(Boolean) }
      ]);
      migrated = true;
    }
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
});

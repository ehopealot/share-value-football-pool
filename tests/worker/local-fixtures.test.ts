import { applyD1Migrations, env } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import oddsPollGeneration from "../../src/db/migrations/0002_odds_poll_generation.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import { localFixtureControls, refreshLocalFixtures } from "../../src/worker/test-controls";
import { offerIsStale } from "../../src/odds/ingestion";

const bindings = env as unknown as { DB: D1Database };
let migrated = false;
const fixtureIds = ["local-nfl-completed", "local-nfl-super-bowl", "local-nfl-upcoming"];

const controls = () => localFixtureControls(bindings.DB, {} as DurableObjectNamespace);

beforeEach(async () => {
  if (!migrated) {
    await applyD1Migrations(bindings.DB, [
      { name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) },
      { name: "0002_odds_poll_generation.sql", queries: oddsPollGeneration.split(";\n").filter(Boolean) }
    ]);
    migrated = true;
  }
  await bindings.DB.exec("DELETE FROM market_offer; DELETE FROM sports_event; DELETE FROM odds_ingestion;");
});

describe("local fixture lifecycle", () => {
  it("replaces stale non-fixture odds rows when deterministic local fixtures are seeded", async () => {
    await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES ('old-live-event', 'old-live-event', 'nfl', 'Old Home', 'Old Away', '2000-01-01T00:00:00.000Z', 'scheduled', 'old')").run();
    await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES ('old-live-event', 'spread', 'DraftKings', '2000-01-01T00:00:00.000Z', 'old', '{}')").run();

    await controls().seed();

    expect((await bindings.DB.prepare("SELECT id FROM sports_event ORDER BY id").all<{ id: string }>()).results.map((row) => row.id)).toEqual(fixtureIds);
    expect((await bindings.DB.prepare("SELECT cursor FROM odds_ingestion WHERE provider = 'local-fixture-mode'").first<{ cursor: string }>())?.cursor).toBe("auto");
    expect((await bindings.DB.prepare("SELECT last_error FROM odds_ingestion WHERE provider = 'odds'").first<{ last_error: string | null }>())?.last_error).toBeNull();
  });

  it("renews automatic scheduled fixture rows before they can expire", async () => {
    await controls().seed();
    await bindings.DB.exec("UPDATE sports_event SET starts_at = '2000-01-01T00:00:00.000Z' WHERE provider_event_id IN ('local-nfl-upcoming', 'local-nfl-super-bowl'); UPDATE market_offer SET retrieved_at = '2000-01-01T00:00:00.000Z';");
    const now = new Date("2031-04-05T12:00:00.000Z");

    await refreshLocalFixtures(bindings.DB, now);

    const scheduled = await bindings.DB.prepare("SELECT provider_event_id, starts_at FROM sports_event WHERE status = 'scheduled' ORDER BY provider_event_id").all<{ provider_event_id: string; starts_at: string }>();
    expect(scheduled.results).toEqual([
      { provider_event_id: "local-nfl-super-bowl", starts_at: "2031-04-06T12:06:00.000Z" },
      { provider_event_id: "local-nfl-upcoming", starts_at: "2031-04-06T12:05:00.000Z" }
    ]);
    expect((await bindings.DB.prepare("SELECT MIN(retrieved_at) AS oldest FROM market_offer").first<{ oldest: string }>())?.oldest).toBe(now.toISOString());
  });

  it("does not overwrite an explicit local stale-offer state", async () => {
    const fixture = controls();
    await fixture.seed();
    await fixture.setOfferState!({ eventId: "local-nfl-upcoming", market: "spread", state: "stale" });

    await refreshLocalFixtures(bindings.DB, new Date("2031-04-05T12:00:00.000Z"));

    expect((await bindings.DB.prepare("SELECT cursor FROM odds_ingestion WHERE provider = 'local-fixture-mode'").first<{ cursor: string }>())?.cursor).toBe("manual");
    expect((await bindings.DB.prepare("SELECT retrieved_at FROM market_offer WHERE event_id = 'local-nfl-upcoming' AND market = 'spread'").first<{ retrieved_at: string }>())?.retrieved_at).toMatch(/^20\d\d-/);
    const retrievedAt = (await bindings.DB.prepare("SELECT retrieved_at FROM market_offer WHERE event_id = 'local-nfl-upcoming' AND market = 'spread'").first<{ retrieved_at: string }>())!.retrieved_at;
    expect(offerIsStale(retrievedAt, new Date())).toBe(true);
  });
});

import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createWorkerApp } from "../../src/worker/app";
import { installLocalTestControls } from "../../src/worker/test-controls";
import { LOCAL_FIXTURE_EVENTS } from "../../src/odds/fixtures/runtime";

describe("deterministic local smoke support", () => {
  it("ships completed and placeable canonical Super Bowl fixtures without disturbing upcoming order", () => {
    expect(LOCAL_FIXTURE_EVENTS).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "local-nfl-completed", completed: true })
    ]));
    const upcomingIndex = LOCAL_FIXTURE_EVENTS.findIndex((event) => event.id === "local-nfl-upcoming");
    const superBowlIndex = LOCAL_FIXTURE_EVENTS.findIndex((event) => event.id === "local-nfl-super-bowl");
    expect(upcomingIndex).toBeGreaterThanOrEqual(0);
    expect(superBowlIndex).toBeGreaterThan(upcomingIndex);
    expect(LOCAL_FIXTURE_EVENTS[superBowlIndex]).toMatchObject({ completed: false, status: "scheduled", sport: "nfl", postseason: true, eventName: "T11 Local Super Bowl LXI", homeTeam: "T11 Super Home", awayTeam: "T11 Super Away" });
  });

  it("does not install test controls unless explicit local/test configuration enables them", async () => {
    const production = createWorkerApp({
      db: {} as D1Database,
      pools: {} as DurableObjectNamespace,
      currentUser: async () => null
    });
    expect((await production.fetch(new Request("https://pool.example.test/__local-test/seed", { method: "POST" }))).status).toBe(404);
    expect((await production.fetch(new Request("https://pool.example.test/__local-test/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: "local-nfl-super-bowl", homeScore: 27, awayScore: 24 }) }))).status).toBe(404);

    const local = new Hono();
    installLocalTestControls(local, { enabled: true, seed: async () => ({ seeded: true }), setCurrentTime: async () => ({ currentTime: null }), finalizeResult: async ({ eventId }) => ({ finalized: true, eventId }), triggerAlarm: async () => ({ settled: true }) });
    expect((await local.fetch(new Request("https://pool.example.test/__local-test/seed", { method: "POST" }))).status).toBe(200);
  });

  it("installs bounded local fixture transitions only behind explicit controls", async () => {
    const calls: Array<[string, unknown]> = [];
    const local = new Hono();
    installLocalTestControls(local, {
      enabled: true,
      seed: async () => ({ seeded: true }),
      setCurrentTime: async (input) => { calls.push(["time", input]); return { currentTime: input.currentTime }; },
      finalizeResult: async (input) => { calls.push(["result", input]); return { finalized: true, eventId: input.eventId }; },
      triggerAlarm: async (input) => { calls.push(["alarm", input]); return { settled: true }; }
    });
    const post = (path: string, body: unknown) => local.fetch(new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(await (await post("/__local-test/current-time", { poolSlug: "local-smoke", currentTime: "2030-01-01T00:00:00.000Z" })).json()).toEqual({ currentTime: "2030-01-01T00:00:00.000Z" });
    expect(await (await post("/__local-test/current-time", { poolSlug: "local-smoke", currentTime: null })).json()).toEqual({ currentTime: null });
    // A pool-scoped read clock is meaningless without its explicit pool, and an unparseable instant is rejected.
    expect((await post("/__local-test/current-time", { currentTime: "2030-01-01T00:00:00.000Z" })).status).toBe(400);
    expect((await post("/__local-test/current-time", { poolSlug: "local-smoke", currentTime: "not-a-time" })).status).toBe(400);
    expect(await (await post("/__local-test/result", { eventId: "local-nfl-upcoming", homeScore: 24, awayScore: 17 })).json()).toEqual({ finalized: true, eventId: "local-nfl-upcoming" });
    expect(await (await post("/__local-test/result", { eventId: "local-nfl-super-bowl", homeScore: 27, awayScore: 24 })).json()).toEqual({ finalized: true, eventId: "local-nfl-super-bowl" });
    expect((await post("/__local-test/result", { eventId: "not-a-fixture", homeScore: 1, awayScore: 0 })).status).toBe(400);
    expect(await (await post("/__local-test/alarm", { poolSlug: "local-smoke", currentTime: "2030-01-01T00:00:00.000Z" })).json()).toEqual({ settled: true });
    expect(calls).toEqual([
      ["time", { poolSlug: "local-smoke", currentTime: "2030-01-01T00:00:00.000Z" }],
      ["time", { poolSlug: "local-smoke", currentTime: null }],
      ["result", { eventId: "local-nfl-upcoming", homeScore: 24, awayScore: 17 }],
      ["result", { eventId: "local-nfl-super-bowl", homeScore: 27, awayScore: 24 }],
      ["alarm", { poolSlug: "local-smoke", currentTime: "2030-01-01T00:00:00.000Z" }]
    ]);
  });

  it("uses one isolated Wrangler persistence directory for migrations and the worker", async () => {
    const source = await readFile(new URL("../../scripts/local-smoke.ts", import.meta.url), "utf8");
    expect(source).toMatch(/--persist-to/);
  });

  it("keeps the local Worker fixture-only instead of polling a configured remote odds provider", async () => {
    const source = await readFile(new URL("../../src/index.local.ts", import.meta.url), "utf8");
    expect(source).toContain("beforeOddsRead: () => refreshLocalFixtures(env.DB)");
    expect(source).not.toContain("TheOddsApiProvider");
    expect(source).not.toContain("runOddsCron");
  });
});

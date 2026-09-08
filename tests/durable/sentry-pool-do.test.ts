import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { PoolDO } from "../../src/durable/pool-do";
import { useOpenBettingClock } from "../fixtures/open-betting-clock";

useOpenBettingClock();

const pools = (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO;
const dsn = "https://public@sentry.invalid/1";

describe("enabled production PoolDO safe-fault reporting", () => {
  it("captures an unknown uppercase command fault without trace-link storage", async () => {
    const stub = pools.get(pools.idFromName(`sentry-pool-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown>; execute: () => unknown };
      runtime.env.SENTRY_DSN = dsn;
      runtime.env.SENTRY_TEST_TRANSPORT = () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true });
      runtime.execute = () => { throw new Error("OUTBOX_IDENTITY_MISSING"); };
      const response = await (instance as unknown as { fetch(request: Request): Promise<Response> }).fetch(new Request("https://pool.test/command", { method: "POST", body: JSON.stringify({ type: "InitializePool", commandId: "init", poolId: "pool", slug: "pool", poolName: "Pool", creatorId: "owner", creatorName: "Owner", password: "correct-password" }) }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "OUTBOX_IDENTITY_MISSING" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(envelopes).toHaveLength(1);
      expect(JSON.stringify(envelopes)).not.toContain("OUTBOX_IDENTITY_MISSING");
      const keys = await state.storage.list();
      expect([...keys.keys()].some((key) => String(key).includes("__SENTRY_TRACE_LINK__"))).toBe(false);
    });
  });

  it("reports an unexpected placement rollback once without retaining partial financial state", async () => {
    const stub = pools.get(pools.idFromName(`sentry-placement-rollback-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    const flushes: Promise<unknown>[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown> };
      const pool = new PoolDO(state, {
        ...runtime.env,
        SENTRY_DSN: dsn,
        SENTRY_TEST_TRANSPORT: () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true }),
        SENTRY_TEST_FLUSHES: flushes
      });
      const post = async (command: Record<string, unknown>) => {
        const response = await pool.fetch(new Request("https://pool.test/command", { method: "POST", body: JSON.stringify(command) }));
        return { response, body: await response.json() as Record<string, unknown> };
      };
      await post({ type: "InitializePool", commandId: "init", poolId: "private-pool", slug: "private-pool", poolName: "Private Pool", creatorId: "owner", creatorName: "Owner", password: "correct-password" });
      await post({ type: "JoinPool", commandId: "join", actorId: "member", displayName: "Sensitive Member", password: "correct-password" });
      await post({ type: "CreateSeason", commandId: "season", actorId: "owner", seasonId: "private-season", label: "Private Season" });
      await post({ type: "OpenSeason", commandId: "open", actorId: "owner", seasonId: "private-season" });
      const fundingQuote = (await post({ type: "QuoteShareOrder", commandId: "fund-quote", actorId: "owner", seasonId: "private-season", memberId: "member", mode: "shares", amountMicros: "1000000" })).body;
      await post({ type: "ExecuteShareOrder", commandId: "fund", actorId: "owner", seasonId: "private-season", memberId: "member", mode: "shares", amountMicros: "1000000", quote: { priceMicros: fundingQuote.priceMicros, commandVersion: fundingQuote.commandVersion }, reason: "private funding" });
      const view = (await post({ type: "ReadPoolView", commandId: "view", actorId: "member" })).body;
      const quoteKey = "private-quote";
      const sensitiveLeg = {
        eventId: "private-event", league: "nfl", canonicalBook: "DraftKings", retrievedAt: new Date().toISOString(), policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "private-offer",
        canonicalOfferProof: { offerId: "private-event:spread:home", eventId: "private-event", offerVersion: "private-offer", canonicalBook: "DraftKings", market: "spread", selection: "home", odds: -110, line: -3 },
        market: "spread", selection: "home", originalLine: -3, adjustedLine: -3, originalOdds: -110, eventStartsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), homeTeam: "Private Home", awayTeam: "Private Away"
      };
      const projection = { quoteKey, ownerMemberId: "member", commandVersion: String(view.commandVersion), fingerprint: "private-fingerprint", wagerId: "private-wager", actorId: "member", seasonId: "private-season", riskMicros: "1000000", acceptedOdds: 100, rulesetVersion: "SHARE_POOL_2026_V1", leg: sensitiveLeg };
      const quote = (await post({ type: "QuoteStraightWager", commandId: quoteKey, actorId: "member", identity: { actorId: "member", quoteKey, fingerprint: projection.fingerprint }, projection })).body;
      state.storage.sql.exec("CREATE TRIGGER fail_placement_leg BEFORE INSERT ON wager_leg BEGIN SELECT RAISE(FAIL, 'FORCED_PLACEMENT_ROLLBACK'); END");
      const snapshot = () => Object.fromEntries(["pool", "processed_command", "wager", "wager_leg", "wager_leg_snapshot", "share_account", "ledger_entry", "event_reconciliation", "outbox"].map((table) => [table, JSON.stringify([...state.storage.sql.exec(`SELECT * FROM ${table} ORDER BY rowid`)])]));
      const before = snapshot();

      const placement = await post({ type: "PlaceStraightWager", commandId: "private-placement", actorId: "member", wagerId: "private-wager", quoteKey, quotedCommandVersion: quote.commandVersion, seasonId: quote.seasonId, riskMicros: quote.riskMicros, acceptedOdds: quote.acceptedOdds, rulesetVersion: quote.rulesetVersion, leg: quote.leg });

      expect(placement.response.status).toBe(400);
      expect(placement.body).toEqual({ code: "FORCED_PLACEMENT_ROLLBACK: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)" });
      expect(snapshot()).toEqual(before);
      await Promise.all(flushes);
      expect(envelopes).toHaveLength(1);
      const event = (envelopes[0] as [unknown, Array<[unknown, { tags: Record<string, string>; fingerprint: string[] }]>])[1][0][1];
      expect(event.tags.sentry_category).toBe("pool-command-unexpected");
      expect(event.fingerprint).toEqual(["sentry", "durable-object", "pool-command-unexpected"]);
      expect(JSON.stringify(envelopes)).not.toMatch(/private-(?:pool|season|event|offer|wager|quote|placement|fingerprint)|Sensitive Member|Private Home|Private Away|FORCED_PLACEMENT_ROLLBACK/);
    });
  });

  it("reports post-commit alarm failure once while preserving the initialized replay", async () => {
    const stub = pools.get(pools.idFromName(`sentry-postcommit-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown>; fetch(request: Request): Promise<Response> };
      runtime.env.SENTRY_DSN = dsn;
      runtime.env.SENTRY_TEST_TRANSPORT = () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true });
      const alarm = vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(new Error("alarm scheduling failed"));
      const command = { type: "InitializePool", commandId: "init", poolId: "pool", slug: "pool", poolName: "Pool", creatorId: "owner", creatorName: "Owner", password: "correct-password" };
      const first = await runtime.fetch(new Request("https://pool.test/command", { method: "POST", body: JSON.stringify(command) }));
      expect(first.status).toBe(400);
      expect(await first.json()).toEqual({ code: "alarm scheduling failed" });
      expect([...state.storage.sql.exec("SELECT id FROM pool")]).toHaveLength(1);
      alarm.mockRestore();
      const replay = await runtime.fetch(new Request("https://pool.test/command", { method: "POST", body: JSON.stringify(command) }));
      expect(replay.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(envelopes).toHaveLength(1);
      expect(JSON.stringify(envelopes)).not.toContain("alarm scheduling failed");
    });
  });

  it("runs caught alarm provider retry once while enabled transport failure stays fail-open", async () => {
    const stub = pools.get(pools.idFromName(`sentry-alarm-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown>; fetch(request: Request): Promise<Response> };
      runtime.env.SENTRY_DSN = dsn;
      runtime.env.SENTRY_TEST_TRANSPORT = () => ({ send: async () => { throw new Error("transport rejected"); }, flush: async () => true });
      runtime.env.DB = { prepare: () => { throw new Error("provider failure"); } };
      state.storage.sql.exec("INSERT INTO event_reconciliation (event_id, event_starts_at, phase, attempts, error_attempts, next_attempt_at) VALUES ('event', '2026-01-01T00:00:00.000Z', 'open', 0, 0, '1970-01-01T00:00:00.000Z')");
      const response = await runtime.fetch(new Request("https://pool.test/internal/settle", { method: "POST", headers: { "x-settlement-service-token": String(runtime.env.SETTLEMENT_SERVICE_TOKEN) } }));
      expect(response.status).toBe(200);
      expect([...state.storage.sql.exec("SELECT error_attempts, next_attempt_at FROM event_reconciliation WHERE event_id = 'event'")][0]).toMatchObject({ error_attempts: 1, next_attempt_at: expect.any(String) });
      expect([...await state.storage.list()].some(([key]) => String(key).includes("__SENTRY_TRACE_LINK__"))).toBe(false);
    });
  });

  it("preserves mixed source retry counters and reports first and exhausted cadence through the production alarm boundary", async () => {
    const stub = pools.get(pools.idFromName(`sentry-mixed-source-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    const flushes: Promise<unknown>[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown> };
      const sourceFailure = new Error("private mixed provider failure");
      const failingDb = { prepare: () => { throw sourceFailure; } } as unknown as D1Database;
      const pool = new PoolDO(state, {
        ...runtime.env,
        DB: failingDb,
        SENTRY_DSN: dsn,
        SENTRY_TEST_TRANSPORT: () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true }),
        SENTRY_TEST_FLUSHES: flushes
      });
      state.storage.sql.exec("INSERT INTO event_reconciliation (event_id, event_starts_at, phase, attempts, error_attempts, next_attempt_at) VALUES ('private-first', '2099-01-01T00:00:00.000Z', 'open', 2, 0, '1970-01-01T00:00:00.000Z'), ('private-terminal', '2099-01-02T00:00:00.000Z', 'open', 4, 6, '1970-01-01T00:00:00.000Z')");
      const request = () => new Request("https://pool.test/internal/settle", { method: "POST", headers: { "x-settlement-service-token": String(runtime.env.SETTLEMENT_SERVICE_TOKEN) } });

      expect((await pool.fetch(request())).status).toBe(200);
      expect([...state.storage.sql.exec("SELECT event_id, attempts, error_attempts FROM event_reconciliation ORDER BY event_id")]).toEqual([
        { event_id: "private-first", attempts: 2, error_attempts: 1 },
        { event_id: "private-terminal", attempts: 4, error_attempts: 7 }
      ]);
      state.storage.sql.exec("UPDATE event_reconciliation SET next_attempt_at = '1970-01-01T00:00:00.000Z'");
      expect((await pool.fetch(request())).status).toBe(200);
      expect([...state.storage.sql.exec("SELECT event_id, attempts, error_attempts, last_error FROM event_reconciliation ORDER BY event_id")]).toEqual([
        { event_id: "private-first", attempts: 2, error_attempts: 2, last_error: "private mixed provider failure" },
        { event_id: "private-terminal", attempts: 4, error_attempts: 0, last_error: "RESULT_PROVIDER_RETRIES_EXHAUSTED_RECOVERING" }
      ]);
      await Promise.all(flushes);
      expect(envelopes).toHaveLength(2);
      for (const envelope of envelopes) {
        const event = (envelope as [unknown, Array<[unknown, { tags: Record<string, string>; fingerprint: string[] }]>])[1][0][1];
        expect(event.tags).toMatchObject({ sentry_category: "settlement-provider-source-failure", sentry_stage: "result-source-read" });
        expect(event.fingerprint).toEqual(["sentry", "durable-object", "settlement-provider-source-failure", "result-source-read"]);
      }
      expect(JSON.stringify(envelopes)).not.toMatch(/private-(?:first|terminal)|private mixed provider failure/);
    });
  });

  it("coalesces repeated internal settlement faults per stage while preserving each retry counter", async () => {
    const stub = pools.get(pools.idFromName(`sentry-internal-coalescing-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    const flushes: Promise<unknown>[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown> };
      const emptyDb = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) } as unknown as D1Database;
      const pool = new PoolDO(state, {
        ...runtime.env,
        DB: emptyDb,
        SENTRY_DSN: dsn,
        SENTRY_TEST_TRANSPORT: () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true }),
        SENTRY_TEST_FLUSHES: flushes
      });
      state.storage.sql.exec("INSERT INTO event_reconciliation (event_id, event_starts_at, phase, attempts, error_attempts, next_attempt_at) VALUES ('private-internal-a', '2099-01-01T00:00:00.000Z', 'open', 1, 2, '1970-01-01T00:00:00.000Z'), ('private-internal-b', '2099-01-02T00:00:00.000Z', 'open', 3, 5, '1970-01-01T00:00:00.000Z'); INSERT INTO event_result_snapshot (event_id, result_json, correction_version, observed_at) VALUES ('private-invalid-snapshot', '{', 'secret-version', '1970-01-01T00:00:00.000Z')");
      const response = await pool.fetch(new Request("https://pool.test/internal/settle", { method: "POST", headers: { "x-settlement-service-token": String(runtime.env.SETTLEMENT_SERVICE_TOKEN) } }));

      expect(response.status).toBe(200);
      expect([...state.storage.sql.exec("SELECT event_id, attempts, error_attempts FROM event_reconciliation ORDER BY event_id")]).toEqual([
        { event_id: "private-internal-a", attempts: 1, error_attempts: 3 },
        { event_id: "private-internal-b", attempts: 3, error_attempts: 6 }
      ]);
      await Promise.all(flushes);
      expect(envelopes).toHaveLength(1);
      const event = (envelopes[0] as [unknown, Array<[unknown, { tags: Record<string, string>; fingerprint: string[] }]>])[1][0][1];
      expect(event.tags).toMatchObject({ sentry_category: "settlement-internal-state-or-invariant-failure", sentry_stage: "result-snapshot-parse" });
      expect(event.fingerprint).toEqual(["sentry", "durable-object", "settlement-internal-state-or-invariant-failure", "result-snapshot-parse"]);
      expect(JSON.stringify(envelopes)).not.toMatch(/private-internal|private-invalid-snapshot|secret-version/);
    });
  });

  it("keeps alarm retry business state when reporter option initialization throws", async () => {
    const stub = pools.get(pools.idFromName(`sentry-alarm-init-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown>; fetch(request: Request): Promise<Response> };
      runtime.env.SENTRY_DSN = dsn;
      runtime.env.SENTRY_TEST_TRANSPORT = () => { throw new Error("init transport failure"); };
      runtime.env.DB = { prepare: () => { throw new Error("provider failure"); } };
      state.storage.sql.exec("INSERT INTO event_reconciliation (event_id, event_starts_at, phase, attempts, error_attempts, next_attempt_at) VALUES ('event', '2026-01-01T00:00:00.000Z', 'open', 0, 0, '1970-01-01T00:00:00.000Z')");
      const response = await runtime.fetch(new Request("https://pool.test/internal/settle", { method: "POST", headers: { "x-settlement-service-token": String(runtime.env.SETTLEMENT_SERVICE_TOKEN) } }));
      expect(response.status).toBe(200);
      expect([...state.storage.sql.exec("SELECT error_attempts FROM event_reconciliation WHERE event_id = 'event'")][0]).toEqual({ error_attempts: 1 });
    });
  });

  it("captures actual outbox producer failure after persisted retry without changing alarm response", async () => {
    const stub = pools.get(pools.idFromName(`sentry-outbox-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    const flushes: Promise<unknown>[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown> };
      const pool = new PoolDO(state, { ...runtime.env, SENTRY_DSN: dsn, SENTRY_TEST_TRANSPORT: () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true }), SENTRY_TEST_FLUSHES: flushes, POOL_EVENTS: { send: async () => { throw new Error("queue unavailable"); } } as unknown as Queue });
      state.storage.sql.exec("INSERT INTO outbox (id, event_type, version, payload_json, attempts, next_attempt_at, created_at) VALUES ('event', 'CommandApplied', '1', ?, 0, ?, ?)", JSON.stringify({ poolId: "pool", actorId: "owner", commandId: "command", commandType: "JoinPool", memberId: "member" }), new Date(0).toISOString(), new Date(0).toISOString());
      const response = await pool.fetch(new Request("https://pool.test/internal/settle", { method: "POST", headers: { "x-settlement-service-token": String(runtime.env.SETTLEMENT_SERVICE_TOKEN) } }));
      expect(response.status).toBe(200);
      expect([...state.storage.sql.exec("SELECT attempts, delivered_at FROM outbox WHERE id = 'event'")][0]).toEqual({ attempts: 1, delivered_at: null });
      await Promise.all(flushes);
      expect(envelopes).toHaveLength(1);
    });
  });

  it("captures and rethrows the identical final alarm scheduling error", async () => {
    const stub = pools.get(pools.idFromName(`sentry-alarm-final-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    const flushes: Promise<unknown>[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { env: Record<string, unknown> };
      const error = new Error("final alarm scheduling failure");
      const pool = new PoolDO(state, { ...runtime.env, SENTRY_DSN: dsn, SENTRY_TEST_TRANSPORT: () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true }), SENTRY_TEST_FLUSHES: flushes, POOL_EVENTS: { send: async () => undefined } as unknown as Queue });
      state.storage.sql.exec("INSERT INTO outbox (id, event_type, version, payload_json, attempts, next_attempt_at, created_at) VALUES ('future', 'CommandApplied', '1', ?, 0, ?, ?)", JSON.stringify({ poolId: "pool", actorId: "owner", commandId: "command", commandType: "JoinPool", memberId: "member" }), new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
      const alarm = vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(error);
      const request = new Request("https://pool.test/internal/settle", { method: "POST", headers: { "x-settlement-service-token": String(runtime.env.SETTLEMENT_SERVICE_TOKEN) } });
      await expect(pool.fetch(request)).rejects.toBe(error);
      alarm.mockRestore();
      await Promise.all(flushes);
      expect(envelopes).toHaveLength(1);
      expect(JSON.stringify(envelopes)).not.toContain("final alarm scheduling failure");
      const envelope = envelopes[0] as [unknown, Array<[unknown, { tags: Record<string, string>; fingerprint: string[] }]>];
      expect(envelope[1][0][1].tags.sentry_category).toBe("durable-alarm-escaping-failure");
      expect(envelope[1][0][1].fingerprint).toEqual(["sentry", "durable-object", "durable-alarm-escaping-failure"]);
    });
  });

  it("keeps expected command rejection quiet with enabled reporting", async () => {
    const stub = pools.get(pools.idFromName(`sentry-expected-${crypto.randomUUID()}`));
    const envelopes: unknown[] = [];
    await runInDurableObject(stub, async (instance) => {
      const runtime = instance as unknown as { env: Record<string, unknown>; fetch(request: Request): Promise<Response> };
      runtime.env.SENTRY_DSN = dsn;
      runtime.env.SENTRY_TEST_TRANSPORT = () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true });
      const response = await runtime.fetch(new Request("https://pool.test/command", { method: "POST", body: "{}" }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "INVALID_COMMAND" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(envelopes).toEqual([]);
    });
  });
});

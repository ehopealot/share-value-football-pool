import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrateAdditivePoolStorage } from "../../src/durable/schema";

const bindings = env as unknown as { POOL_DO: DurableObjectNamespace };
const token = "test-only-settlement-token";
const DAY = 24 * 60 * 60 * 1000;

const command = async (slug: string, body: unknown) => (await bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)).fetch("https://pool.test/command", { method: "POST", body: JSON.stringify(body) })).json<Record<string, unknown>>();
const internal = async (slug: string, body: unknown, serviceToken = token) => bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)).fetch("https://pool.internal/internal/season-closure-reminder", { method: "POST", headers: { "x-settlement-service-token": serviceToken }, body: JSON.stringify(body) });
const storage = <T>(slug: string, callback: (state: DurableObjectState) => T) => runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)), (_instance, state) => callback(state));

async function activePool(kickoff: number, options: { candidate?: boolean; confirmed?: boolean } = {}) {
  const slug = `closure-reminder-${crypto.randomUUID()}`;
  await command(slug, { type: "InitializePool", commandId: "init", poolId: slug, slug, poolName: "Sunday & Pool", creatorId: "owner", creatorName: "Owner", password: "correct-password" });
  await command(slug, { type: "CreateSeason", commandId: "season", actorId: "owner", seasonId: "s1", label: "2030 Season" });
  await command(slug, { type: "OpenSeason", commandId: "open", actorId: "owner", seasonId: "s1" });
  if (options.candidate !== false) await storage(slug, (state) => state.storage.sql.exec("INSERT INTO season_super_bowl (season_id, event_id, provider_event_name, event_starts_at, confirmed_at) VALUES ('s1', 'sb-1', 'Super Bowl LX', ?, ?)", new Date(kickoff).toISOString(), options.confirmed ? new Date(kickoff - 8 * DAY).toISOString() : null));
  return slug;
}

const json = async (response: Response) => response.json<any>();

describe("DO-owned season closure reminder", () => {
  it("uses the inclusive seven-day boundary, catches up inside the window, and never starts at or after kickoff", async () => {
    const kickoff = Date.parse("2030-02-10T23:00:00.000Z");
    for (const [offset, expected] of [[-7 * DAY - 1, "none"], [-7 * DAY, "prepared"], [-2 * DAY, "prepared"], [0, "none"], [1, "none"]] as const) {
      const slug = await activePool(kickoff);
      expect((await json(await internal(slug, { action: "prepare", now: new Date(kickoff + offset).toISOString() }))).status).toBe(expected);
    }
  }, 60_000);

  it("suppresses missing candidates, acknowledged candidates, and inactive seasons", async () => {
    const kickoff = Date.parse("2030-02-10T23:00:00.000Z");
    const now = new Date(kickoff - DAY).toISOString();
    expect(await json(await internal(await activePool(kickoff, { candidate: false }), { action: "prepare", now }))).toEqual({ status: "none" });
    expect(await json(await internal(await activePool(kickoff, { confirmed: true }), { action: "prepare", now }))).toEqual({ status: "none" });
    const closed = await activePool(kickoff);
    const prepared = await json(await internal(closed, { action: "prepare", now }));
    await internal(closed, { action: "claim", now, attemptToken: prepared.attemptToken, commissionerId: "owner", recipientEmail: "owner@example.test" });
    await internal(closed, { action: "fail", now, attemptToken: prepared.attemptToken });
    await command(closed, { type: "CloseSeason", commandId: "close", actorId: "owner", seasonId: "s1", reason: "closed" });
    expect(await json(await internal(closed, { action: "prepare", now: new Date(kickoff - DAY + 15 * 60 * 1000).toISOString() }))).toEqual({ status: "none" });
    expect(await storage(closed, (state) => [...state.storage.sql.exec("SELECT terminal_reason FROM season_closure_reminder")][0])).toEqual({ terminal_reason: "season_inactive" });
  }, 60_000);

  it("leases overlapping cron attempts and records one successful delivery", async () => {
    const kickoff = Date.parse("2030-02-10T23:00:00.000Z");
    const now = new Date(kickoff - DAY).toISOString();
    const slug = await activePool(kickoff);
    const results = await Promise.all([internal(slug, { action: "prepare", now }).then(json), internal(slug, { action: "prepare", now }).then(json)]);
    expect(results.map((result) => result.status).sort()).toEqual(["none", "prepared"]);
    const prepared = results.find((result) => result.status === "prepared")!;
    const claim = await json(await internal(slug, { action: "claim", now, attemptToken: prepared.attemptToken, commissionerId: "owner", recipientEmail: "owner@example.test" }));
    expect(claim).toMatchObject({ status: "claimed", commissionerId: "owner", poolName: "Sunday & Pool", seasonLabel: "2030 Season", gameName: "Super Bowl LX", kickoff: new Date(kickoff).toISOString(), idempotencyKey: expect.stringMatching(/^season-closure\/[0-9a-f]{64}$/) });
    expect(await json(await internal(slug, { action: "complete", now, attemptToken: prepared.attemptToken }))).toEqual({ status: "recorded" });
    expect(await json(await internal(slug, { action: "prepare", now: new Date(kickoff - DAY + 20 * 60 * 1000).toISOString() }))).toEqual({ status: "none" });
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT attempts, last_outcome, delivered_at, terminal_at FROM season_closure_reminder")][0])).toEqual({ attempts: 1, last_outcome: "accepted", delivered_at: now, terminal_at: null });
  }, 60_000);

  it("records failed/ambiguous attempts without success and retries the unchanged payload only inside 23 hours", async () => {
    const firstAt = Date.parse("2030-02-05T00:00:00.000Z");
    const kickoff = firstAt + 6 * DAY;
    const slug = await activePool(kickoff);
    const first = await json(await internal(slug, { action: "prepare", now: new Date(firstAt).toISOString() }));
    const firstClaim = await json(await internal(slug, { action: "claim", now: new Date(firstAt).toISOString(), attemptToken: first.attemptToken, commissionerId: "owner", recipientEmail: "owner@example.test" }));
    expect(await json(await internal(slug, { action: "fail", now: new Date(firstAt).toISOString(), attemptToken: first.attemptToken }))).toEqual({ status: "recorded" });
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT attempts, last_outcome, delivered_at FROM season_closure_reminder")][0])).toEqual({ attempts: 1, last_outcome: "provider_failed", delivered_at: null });
    expect(await json(await internal(slug, { action: "prepare", now: new Date(firstAt + 14 * 60 * 1000).toISOString() }))).toEqual({ status: "none" });
    const retryAt = firstAt + 15 * 60 * 1000;
    const retry = await json(await internal(slug, { action: "prepare", now: new Date(retryAt).toISOString() }));
    const retryClaim = await json(await internal(slug, { action: "claim", now: new Date(retryAt).toISOString(), attemptToken: retry.attemptToken, commissionerId: "owner", recipientEmail: "owner@example.test" }));
    expect(retryClaim).toEqual({ ...firstClaim, attemptToken: retry.attemptToken });
    await internal(slug, { action: "fail", now: new Date(retryAt).toISOString(), attemptToken: retry.attemptToken });
    expect(await json(await internal(slug, { action: "prepare", now: new Date(firstAt + 23 * 60 * 60 * 1000).toISOString() }))).toEqual({ status: "none" });
  }, 60_000);

  it("recovers an ambiguous attempt after its lease with unchanged content, then stops after acknowledgment", async () => {
    const firstAt = Date.parse("2030-02-05T00:00:00.000Z");
    const kickoff = firstAt + 6 * DAY;
    const slug = await activePool(kickoff);
    const first = await json(await internal(slug, { action: "prepare", now: new Date(firstAt).toISOString() }));
    const firstClaim = await json(await internal(slug, { action: "claim", now: new Date(firstAt).toISOString(), attemptToken: first.attemptToken, commissionerId: "owner", recipientEmail: "owner@example.test" }));
    expect(await json(await internal(slug, { action: "prepare", now: new Date(firstAt + 9 * 60 * 1000).toISOString() }))).toEqual({ status: "none" });
    const retryAt = firstAt + 10 * 60 * 1000;
    const retry = await json(await internal(slug, { action: "prepare", now: new Date(retryAt).toISOString() }));
    const retryClaim = await json(await internal(slug, { action: "claim", now: new Date(retryAt).toISOString(), attemptToken: retry.attemptToken, commissionerId: "owner", recipientEmail: "owner@example.test" }));
    expect(retryClaim).toEqual({ ...firstClaim, attemptToken: retry.attemptToken });
    await command(slug, { type: "ConfirmSuperBowl", commandId: "confirm", actorId: "owner", seasonId: "s1", eventId: "sb-1" });
    expect(await json(await internal(slug, { action: "prepare", now: new Date(retryAt + 10 * 60 * 1000).toISOString() }))).toEqual({ status: "none" });
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT terminal_reason, delivered_at FROM season_closure_reminder")][0])).toEqual({ terminal_reason: "acknowledged", delivered_at: null });
  }, 60_000);

  it("terminates a retry rather than disclosing a frozen message after commissioner or recipient changes", async () => {
    const firstAt = Date.parse("2030-02-05T00:00:00.000Z");
    const slug = await activePool(firstAt + 6 * DAY);
    await command(slug, { type: "JoinPool", commandId: "join", actorId: "next", displayName: "Next", password: "correct-password" });
    const prepared = await json(await internal(slug, { action: "prepare", now: new Date(firstAt).toISOString() }));
    await internal(slug, { action: "claim", now: new Date(firstAt).toISOString(), attemptToken: prepared.attemptToken, commissionerId: "owner", recipientEmail: "owner@example.test" });
    await internal(slug, { action: "fail", now: new Date(firstAt).toISOString(), attemptToken: prepared.attemptToken });
    await command(slug, { type: "TransferCommissioner", commandId: "transfer", actorId: "owner", memberId: "next", reason: "handoff" });
    expect(await json(await internal(slug, { action: "prepare", now: new Date(firstAt + 15 * 60 * 1000).toISOString() }))).toEqual({ status: "none" });
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT terminal_reason, delivered_at FROM season_closure_reminder")][0])).toEqual({ terminal_reason: "commissioner_changed", delivered_at: null });

    const emailChange = await activePool(firstAt + 6 * DAY);
    const emailPrepared = await json(await internal(emailChange, { action: "prepare", now: new Date(firstAt).toISOString() }));
    await internal(emailChange, { action: "claim", now: new Date(firstAt).toISOString(), attemptToken: emailPrepared.attemptToken, commissionerId: "owner", recipientEmail: "owner@example.test" });
    await internal(emailChange, { action: "fail", now: new Date(firstAt).toISOString(), attemptToken: emailPrepared.attemptToken });
    const emailRetry = await json(await internal(emailChange, { action: "prepare", now: new Date(firstAt + 15 * 60 * 1000).toISOString() }));
    expect(await json(await internal(emailChange, { action: "claim", now: new Date(firstAt + 15 * 60 * 1000).toISOString(), attemptToken: emailRetry.attemptToken, commissionerId: "owner", recipientEmail: "new-owner@example.test" }))).toEqual({ status: "none" });
    expect(await storage(emailChange, (state) => [...state.storage.sql.exec("SELECT terminal_reason FROM season_closure_reminder")][0])).toEqual({ terminal_reason: "recipient_changed" });
  }, 60_000);

  it.each(["expired", "already_claimed", "kickoff_changed"] as const)("rejects a %s reservation at claim time", async (scenario) => {
    const at = Date.parse("2030-02-05T00:00:00.000Z");
    const slug = await activePool(at + DAY);
    const prepared = await json(await internal(slug, { action: "prepare", now: new Date(at).toISOString() }));
    const claim = { action: "claim", now: new Date(at).toISOString(), attemptToken: prepared.attemptToken, commissionerId: "owner", recipientEmail: "owner@example.test" };
    if (scenario === "already_claimed") expect((await json(await internal(slug, claim))).status).toBe("claimed");
    if (scenario === "expired") claim.now = new Date(at + 10 * 60 * 1000).toISOString();
    if (scenario === "kickoff_changed") await storage(slug, (state) => state.storage.sql.exec("UPDATE season_super_bowl SET event_starts_at = ?", new Date(at + 9 * DAY).toISOString()));
    expect(await json(await internal(slug, claim))).toEqual({ status: "none" });
  }, 60_000);

  it("starts the send lease at claim rather than the earlier reservation", async () => {
    const at = Date.parse("2030-02-05T00:00:00.000Z");
    const slug = await activePool(at + DAY);
    const prepared = await json(await internal(slug, { action: "prepare", now: new Date(at).toISOString() }));
    await internal(slug, { action: "claim", now: new Date(at + 9 * 60 * 1000).toISOString(), attemptToken: prepared.attemptToken, commissionerId: "owner", recipientEmail: "owner@example.test" });
    expect(await json(await internal(slug, { action: "prepare", now: new Date(at + 10 * 60 * 1000).toISOString() }))).toEqual({ status: "none" });
  }, 60_000);

  it("requires the settlement lifecycle credential and creates the reminder table for cold and existing schemas", async () => {
    const kickoff = Date.parse("2030-02-10T23:00:00.000Z");
    const slug = await activePool(kickoff);
    expect((await internal(slug, { action: "prepare", now: new Date(kickoff - DAY).toISOString() }, "test-only-ops-token")).status).toBe(404);
    expect((await bindings.POOL_DO.get(bindings.POOL_DO.idFromName(slug)).fetch("https://pool.internal/internal/season-closure-reminder", { method: "GET", headers: { "x-settlement-service-token": token } })).status).toBe(404);
    expect(await storage(slug, (state) => [...state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='season_closure_reminder'")])).toEqual([{ name: "season_closure_reminder" }]);
    expect(await storage(slug, (state) => {
      state.storage.sql.exec("DROP TABLE season_closure_reminder");
      migrateAdditivePoolStorage(state.storage.sql);
      return [...state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='season_closure_reminder'")];
    })).toEqual([{ name: "season_closure_reminder" }]);
  }, 60_000);
});

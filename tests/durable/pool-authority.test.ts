import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PoolCommand } from "../../src/durable/pool-commands";
import { migrateSeasonCreatedAt } from "../../src/durable/schema";

const pools = (env as unknown as { POOL_DO: DurableObjectNamespace }).POOL_DO;
const send = async (slug: string, command: PoolCommand) => {
  const response = await pools.get(pools.idFromName(slug)).fetch("https://pool.test/command", { method: "POST", body: JSON.stringify(command) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

describe("PoolDO authority", () => {
  it("repairs historical created_at values deterministically across legacy and current schemas", async () => {
    const slug = `created-at-${crypto.randomUUID()}`;
    const initialize: PoolCommand = { type: "InitializePool", commandId: "init", poolId: slug, slug, poolName: "Created at Pool", creatorId: "owner", creatorName: "Owner", password: "correct-password" };
    await send(slug, initialize);

    const legacyRows = await runInDurableObject(pools.get(pools.idFromName(slug)), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE season");
      sql.exec("CREATE TABLE season (id TEXT PRIMARY KEY, label TEXT NOT NULL, state TEXT NOT NULL, opened_at TEXT, closed_at TEXT, close_reason TEXT, float_micros TEXT NOT NULL, notional_micros TEXT NOT NULL, default_mode TEXT, default_amount_micros TEXT, command_version TEXT NOT NULL)");
      sql.exec("INSERT INTO season (id, label, state, opened_at, closed_at, float_micros, notional_micros, command_version) VALUES ('draft', 'Draft', 'draft', NULL, NULL, '0', '0', '0'), ('active', 'Active', 'active', '2026-01-02T00:00:00.000Z', NULL, '0', '0', '0'), ('closed-b', 'Closed B', 'closed', NULL, '2026-02-01T00:00:00.000Z', '0', '0', '0'), ('closed-a', 'Closed A', 'closed', NULL, '2026-02-01T00:00:00.000Z', '0', '0', '0')");
      sql.exec("UPDATE pool SET active_season_id = 'active'");
      migrateSeasonCreatedAt(sql);
      const firstPass = [...sql.exec<{ id: string; created_at: string; ruleset_version: string }>("SELECT id, created_at, ruleset_version FROM season ORDER BY id")];
      migrateSeasonCreatedAt(sql);
      return { columns: [...sql.exec<{ name: string }>("PRAGMA table_info(season)")], firstPass, secondPass: [...sql.exec<{ id: string; created_at: string; ruleset_version: string }>("SELECT id, created_at, ruleset_version FROM season ORDER BY id")] };
    });
    expect(legacyRows.columns).toContainEqual(expect.objectContaining({ name: "created_at" }));
    expect(legacyRows.columns).toContainEqual(expect.objectContaining({ name: "ruleset_version" }));
    expect(legacyRows.firstPass).toEqual([
      { id: "active", created_at: "2026-01-02T00:00:00.000Z", ruleset_version: "SHARE_POOL_2026_V1" },
      { id: "closed-a", created_at: "2026-02-01T00:00:00.000Z", ruleset_version: "SHARE_POOL_2026_V1" },
      { id: "closed-b", created_at: "2026-02-01T00:00:00.000Z", ruleset_version: "SHARE_POOL_2026_V1" },
      { id: "draft", created_at: "1970-01-01T00:00:00.000Z", ruleset_version: "SHARE_POOL_2026_V1" }
    ]);
    expect(legacyRows.secondPass).toEqual(legacyRows.firstPass);

    const repairedRows = await runInDurableObject(pools.get(pools.idFromName(slug)), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE season SET created_at = NULL WHERE id = 'active'; UPDATE season SET created_at = '' WHERE id = 'draft'");
      migrateSeasonCreatedAt(sql);
      const firstPass = [...sql.exec<{ id: string; created_at: string }>("SELECT id, created_at FROM season WHERE id IN ('active', 'draft') ORDER BY id")];
      migrateSeasonCreatedAt(sql);
      return { firstPass, secondPass: [...sql.exec<{ id: string; created_at: string }>("SELECT id, created_at FROM season WHERE id IN ('active', 'draft') ORDER BY id")] };
    });
    expect(repairedRows.firstPass).toEqual([
      { id: "active", created_at: "2026-01-02T00:00:00.000Z" },
      { id: "draft", created_at: "1970-01-01T00:00:00.000Z" }
    ]);
    expect(repairedRows.secondPass).toEqual(repairedRows.firstPass);

    const view = (await send(slug, { type: "ReadPoolView", commandId: "ordered-read", actorId: "owner" })).body;
    expect(view).toMatchObject({
      activeSeason: { id: "active", createdAt: "2026-01-02T00:00:00.000Z", rulesetVersion: "SHARE_POOL_2026_V1" },
      nextDraftSeason: { id: "draft", createdAt: "1970-01-01T00:00:00.000Z", rulesetVersion: "SHARE_POOL_2026_V1" },
      latestClosedSeason: { id: "closed-a", createdAt: "2026-02-01T00:00:00.000Z", rulesetVersion: "SHARE_POOL_2026_V1" }
    });

    const coldSlug = `created-at-cold-${crypto.randomUUID()}`;
    await send(coldSlug, { ...initialize, commandId: "cold-init", poolId: coldSlug, slug: coldSlug });
    await send(coldSlug, { type: "CreateSeason", commandId: "new-season", actorId: "owner", seasonId: "new", label: "New" });
    const coldRows = await runInDurableObject(pools.get(pools.idFromName(coldSlug)), (_instance, state) => [...state.storage.sql.exec<{ id: string; created_at: string; ruleset_version: string }>("SELECT id, created_at, ruleset_version FROM season WHERE id = 'new'")]);
    expect(coldRows).toEqual([{ id: "new", created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), ruleset_version: "SHARE_POOL_2026_V1" }]);
  }, 90_000);

  it("upgrades legacy message-board rows with a false announcement marker", async () => {
    const slug = `board-announcement-schema-${crypto.randomUUID()}`;
    const initialize: PoolCommand = { type: "InitializePool", commandId: "init", poolId: slug, slug, poolName: "Board schema", creatorId: "owner", creatorName: "Owner", password: "correct-password" };
    await send(slug, initialize);
    const migrated = await runInDurableObject(pools.get(pools.idFromName(slug)), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE message_board_entry");
      sql.exec("CREATE TABLE message_board_entry (id TEXT PRIMARY KEY, parent_post_id TEXT, author_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, activity_at TEXT NOT NULL)");
      sql.exec("INSERT INTO message_board_entry VALUES ('legacy-post', NULL, 'owner', 'Legacy post', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
      migrateSeasonCreatedAt(sql);
      const firstPass = [...sql.exec<{ id: string; is_announcement: number }>("SELECT id, is_announcement FROM message_board_entry")];
      migrateSeasonCreatedAt(sql);
      return { columns: [...sql.exec<{ name: string }>("PRAGMA table_info(message_board_entry)")], firstPass, secondPass: [...sql.exec<{ id: string; is_announcement: number }>("SELECT id, is_announcement FROM message_board_entry")] };
    });
    expect(migrated.columns).toContainEqual(expect.objectContaining({ name: "is_announcement" }));
    expect(migrated.firstPass).toEqual([{ id: "legacy-post", is_announcement: 0 }]);
    expect(migrated.secondPass).toEqual(migrated.firstPass);
  }, 90_000);

  it("serializes membership, seasons, idempotency, and suspension authorization", async () => {
    const slug = `pool-${crypto.randomUUID()}`;
    const initialize: PoolCommand = { type: "InitializePool", commandId: "init", poolId: slug, slug, poolName: "Friday Pool", creatorId: "owner", creatorName: "Owner", password: "correct-password" };
    expect((await send(slug, initialize)).body).toMatchObject({ commandVersion: "1", status: "ready" });
    expect((await send(slug, initialize)).body).toMatchObject({ commandVersion: "1", status: "ready" });
    expect((await send(slug, { ...initialize, poolName: "Changed" })).body).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    await expect(send(slug, { type: "JoinPool", commandId: "join-bad", actorId: "member", displayName: "Member", password: "wrong-password" })).resolves.toMatchObject({ body: { code: "JOIN_DENIED" } });
    expect((await send(slug, { type: "JoinPool", commandId: "join", actorId: "member", displayName: "Member", password: "correct-password" })).body).toMatchObject({ commandVersion: "2" });
    expect((await send(slug, { type: "UpdatePoolSettings", commandId: "rotate", actorId: "owner", password: "new-password" })).body).toMatchObject({ commandVersion: "3" });
    expect((await send(slug, { type: "JoinPool", commandId: "old-password", actorId: "member-two", displayName: "Member Two", password: "correct-password" })).body).toMatchObject({ code: "JOIN_DENIED" });
    expect((await send(slug, { type: "JoinPool", commandId: "new-password", actorId: "member-two", displayName: "Member Two", password: "new-password" })).body).toMatchObject({ commandVersion: "4" });
    expect((await send(slug, { type: "CreateSeason", commandId: "draft", actorId: "owner", seasonId: "s1", label: "2026" })).body).toMatchObject({ commandVersion: "5" });
    const ownerView = (await send(slug, { type: "ReadPoolView", commandId: "read-owner", actorId: "owner" })).body;
    expect(ownerView.activeSeason).toBeNull();
    expect(ownerView.nextDraftSeason).toMatchObject({ id: "s1", state: "draft", rulesetVersion: "SHARE_POOL_2026_V1" });
    expect(ownerView.latestClosedSeason).toBeNull();
    expect(ownerView.currentMember).toMatchObject({ seasonBalances: [expect.objectContaining({ seasonId: "s1", availableMicros: "0", lockedMicros: "0" })] });
    expect(ownerView.members).toEqual(expect.arrayContaining([expect.objectContaining({ memberId: "member", status: "active" })]));
    expect(ownerView.commissioner).toMatchObject({ seasonOrders: [expect.objectContaining({ seasonId: "s1" })] });
    expect((await send(slug, { type: "CreateSeason", commandId: "overlap", actorId: "owner", seasonId: "s2", label: "2027" })).body).toMatchObject({ code: "OVERLAPPING_SEASON" });
    expect((await send(slug, { type: "OpenSeason", commandId: "open", actorId: "owner", seasonId: "s1" })).body).toMatchObject({ commandVersion: "6" });
    expect((await send(slug, { type: "ReadPoolView", commandId: "read-active", actorId: "owner" })).body).toMatchObject({ activeSeason: { id: "s1", state: "active", rulesetVersion: "SHARE_POOL_2026_V1" } });
    expect((await send(slug, { type: "CloseSeason", commandId: "close", actorId: "owner", seasonId: "s1", reason: "completed" })).body).toMatchObject({ commandVersion: "7" });
    expect((await send(slug, { type: "OpenSeason", commandId: "reopen", actorId: "owner", seasonId: "s1" })).body).toMatchObject({ code: "SEASON_NOT_DRAFT" });

    expect((await send(slug, { type: "SuspendMember", commandId: "self-suspend", actorId: "owner", memberId: "owner" })).body).toMatchObject({ code: "CANNOT_SUSPEND_COMMISSIONER" });
    expect((await send(slug, { type: "SuspendMember", commandId: "suspend", actorId: "owner", memberId: "member" })).body).toMatchObject({ commandVersion: "8" });
    expect((await send(slug, { type: "ReadPoolView", commandId: "read-suspended", actorId: "member" })).body).toMatchObject({ code: "SUSPENDED" });
    expect((await send(slug, { type: "RestoreMember", commandId: "restore", actorId: "owner", memberId: "member" })).body).toMatchObject({ commandVersion: "9" });
    const memberView = (await send(slug, { type: "ReadPoolView", commandId: "read-member", actorId: "member" })).body;
    expect(memberView.latestClosedSeason).toMatchObject({ id: "s1", state: "closed", rulesetVersion: "SHARE_POOL_2026_V1" });
    expect((memberView.currentMember as { seasonBalances: unknown[] }).seasonBalances).toEqual(expect.arrayContaining([expect.objectContaining({ seasonId: "s1" })]));
    expect(memberView.members).toEqual(expect.arrayContaining([expect.objectContaining({ memberId: "member", status: "active" })]));
    expect(memberView.commissioner).toBeNull();
    expect((await send(slug, { type: "UnknownCommand", commandId: "unknown", actorId: "owner", memberId: "member" } as unknown as PoolCommand)).body).toMatchObject({ code: "INVALID_COMMAND" });

    const stored = await runInDurableObject(pools.get(pools.idFromName(slug)), (_instance, state) => ({
      command: [...state.storage.sql.exec<{ request_json: string }>("SELECT request_json FROM processed_command WHERE id = 'init'")][0],
      pool: [...state.storage.sql.exec<{ password_hash: string }>("SELECT password_hash FROM pool")][0]
    }));
    expect(stored.command.request_json).not.toContain("correct-password");
    expect(stored.command.request_json).not.toContain("scrypt-v1");
    expect(stored.pool.password_hash).toMatch(/^scrypt-v1\$/);
  }, 90_000);
});

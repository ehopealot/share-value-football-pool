import { applyD1Migrations, env } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import { createPoolResponse } from "../../src/contracts/http";
import { PoolRegistry } from "../../src/services/pool-registry";
import type { InitializePoolInput, PoolCommandClient } from "../../src/services/pool-command-client";

class FakeCommands implements PoolCommandClient {
  calls: InitializePoolInput[] = [];
  fail = false;
  pending: Promise<void> | undefined;
  async initializePool(input: InitializePoolInput) {
    this.calls.push(input);
    await this.pending;
    if (this.fail) throw new Error("DO unavailable");
    return { commandVersion: "1" };
  }
}

const db = (env as unknown as { DB: D1Database }).DB;
const material = { creatorName: "U1", poolName: "Friday Pool", password: "test-command-password" };
let migrated = false;
beforeEach(async () => {
  if (!migrated) { await applyD1Migrations(db, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
  await db.exec("DELETE FROM pool_registry_command_response; DELETE FROM pool_registry; INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'U1', 'u1@example.test', 1, 0, 0), ('u2', 'U2', 'u2@example.test', 1, 0, 0);");
});

describe("pool registry reservation saga", () => {
  it("persists case-insensitive reservations and replays the original response/version", async () => {
    const commands = new FakeCommands();
    const registry = new PoolRegistry(db, commands, "test-command-authenticator-key");
    const created = await registry.create({ slug: "Friday-Football", creatorId: "u1", idempotencyKey: "k1", ...material });
    expect(created).toMatchObject({ slug: "friday-football", status: "ready", commandVersion: "1" });
    expect(createPoolResponse.parse(created)).toMatchObject({ poolId: created.poolId, slug: created.slug, status: created.status, commandVersion: created.commandVersion });
    expect(commands.calls).toEqual([expect.objectContaining({ commandId: "k1", ...material })]);
    expect(await registry.create({ slug: "friday-football", creatorId: "u1", idempotencyKey: "k1", ...material })).toEqual(created);
    await expect(registry.create({ slug: "friday-football", creatorId: "u2", idempotencyKey: "k2", ...material })).rejects.toThrow("Pool slug is already reserved");
    await expect(registry.create({ slug: "another-pool", creatorId: "u1", idempotencyKey: "k1", ...material })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    for (const changed of [
      { slug: "different-pool" }, { creatorId: "u2" }, { creatorName: "Different creator" }, { poolName: "Different pool" }, { password: "different-command-password" }
    ]) {
      await expect(registry.create({ slug: "friday-football", creatorId: "u1", idempotencyKey: "k1", ...material, ...changed })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    }
  });

  it("rejects incomplete initialization before reserving a slug", async () => {
    const registry = new PoolRegistry(db, new FakeCommands(), "test-command-authenticator-key");
    for (const missing of [{ creatorName: undefined }, { poolName: undefined }, { password: undefined }]) {
      await expect(registry.create({ slug: "unreserved", creatorId: "u1", idempotencyKey: `missing-${Object.keys(missing)[0]}`, ...material, ...missing })).rejects.toThrow("INITIALIZATION_MATERIAL_REQUIRED");
    }
    expect(await registry.getBySlug("unreserved")).toBeUndefined();
  });

  it("durably returns the reserved initializing response while initialization is in flight", async () => {
    let release!: () => void;
    const commands = new FakeCommands();
    commands.pending = new Promise<void>((resolve) => { release = resolve; });
    const registry = new PoolRegistry(db, commands, "test-command-authenticator-key");
    const first = registry.create({ slug: "in-flight", creatorId: "u1", idempotencyKey: "k-flight", ...material });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replay = await registry.create({ slug: "in-flight", creatorId: "u1", idempotencyKey: "k-flight", ...material });
    expect(replay.status).toBe("initializing");
    expect(commands.calls).toEqual([expect.objectContaining({ commandId: "k-flight", ...material })]);
    release();
    expect((await first).status).toBe("ready");
  });

  it("persists failed repair state and can repair it", async () => {
    const commands = new FakeCommands(); commands.fail = true;
    const registry = new PoolRegistry(db, commands, "test-command-authenticator-key");
    const result = await registry.create({ slug: "repairable", creatorId: "u1", idempotencyKey: "k1", ...material });
    expect(result.status).toBe("failed");
    expect((await registry.getBySlug("REPAIRABLE"))?.lastError).toBe("DO unavailable");
    commands.fail = false;
    expect(await registry.repair("repairable")).toMatchObject({ status: "failed", lastError: "INITIALIZATION_MATERIAL_UNAVAILABLE" });
    expect((await registry.repair("repairable", { slug: "repairable", creatorId: "u1", idempotencyKey: "k1", ...material })).status).toBe("ready");
    expect((await registry.create({ slug: "repairable", creatorId: "u1", idempotencyKey: "k1", ...material })).status).toBe("failed");
  });
});

import { applyD1Migrations, env } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import { DurablePoolCommandClient } from "../../src/services/pool-command-client";
import { PoolRegistry } from "../../src/services/pool-registry";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace; POOL_COMMAND_AUTHENTICATOR_KEY: string };
let migrated = false;
beforeEach(async () => {
  if (!migrated) {
    await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]);
    migrated = true;
  }
  await bindings.DB.exec("DELETE FROM pool_registry_command_response; DELETE FROM pool_registry; INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'owner@example.test', 1, 0, 0);");
});

describe("real D1-to-PoolDO creation saga", () => {
  it("initializes exactly once and repairs an initializing reservation with the same DO command", async () => {
    const registry = new PoolRegistry(bindings.DB, new DurablePoolCommandClient(bindings.POOL_DO), bindings.POOL_COMMAND_AUTHENTICATOR_KEY);
    const input = { slug: `saga-${crypto.randomUUID()}`, creatorId: "owner", creatorName: "Owner", poolName: "Saga Pool", password: "correct-password", idempotencyKey: "create" };
    const created = await registry.create(input);
    expect(created).toMatchObject({ status: "ready", commandVersion: "1" });
    expect(await registry.create(input)).toEqual(created);

    await bindings.DB.prepare("UPDATE pool_registry SET status='initializing' WHERE pool_id=?").bind(created.poolId).run();
    const repaired = await registry.repair(created.slug, input);
    expect(repaired).toMatchObject({ poolId: created.poolId, status: "ready", commandVersion: "1" });

    const incompleteId = crypto.randomUUID();
    await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, 'missing-material', ?, 'owner', 'initializing', 'missing-command', ?)").bind(incompleteId, incompleteId, new Date().toISOString()).run();
    expect(await registry.repair("missing-material")).toMatchObject({ status: "failed", lastError: "INITIALIZATION_MATERIAL_UNAVAILABLE" });
  }, 30_000);
});

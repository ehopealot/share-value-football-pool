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
  it("initializes exactly once and replays the same reservation", async () => {
    const registry = new PoolRegistry(bindings.DB, new DurablePoolCommandClient(bindings.POOL_DO), bindings.POOL_COMMAND_AUTHENTICATOR_KEY);
    const input = { slug: `saga-${crypto.randomUUID()}`, creatorId: "owner", creatorName: "Owner", poolName: "Saga Pool", password: "correct-password", idempotencyKey: "create" };
    const created = await registry.create(input);
    expect(created).toMatchObject({ status: "ready", commandVersion: "1" });
    expect(await registry.create(input)).toEqual(created);
  }, 30_000);

  it.each([
    [new Response(JSON.stringify({ code: "POOL_ALREADY_INITIALIZED" }), { status: 400 }), "POOL_ALREADY_INITIALIZED"],
    [new Response("null", { status: 400 }), "Cannot read properties of null (reading 'code')"],
    [new Response(JSON.stringify({ code: 42 }), { status: 400 }), "42"],
    [new Response(JSON.stringify({}), { status: 200 }), "POOL_INITIALIZATION_FAILED"]
  ])("preserves failed creation response for authority and malformed-success provenance", async (response, expectedError) => {
    const pools = { idFromName: (name: string) => name, get: () => ({ fetch: async () => response.clone() }) } as unknown as DurableObjectNamespace;
    const registry = new PoolRegistry(bindings.DB, new DurablePoolCommandClient(pools), bindings.POOL_COMMAND_AUTHENTICATOR_KEY);
    const input = { slug: `failed-saga-${crypto.randomUUID()}`, creatorId: "owner", creatorName: "Owner", poolName: "Saga Pool", password: "correct-password", idempotencyKey: crypto.randomUUID() };
    const failed = await registry.create(input);
    expect(failed).toMatchObject({ status: "failed", lastError: expectedError });
    expect(await registry.create(input)).toEqual(failed);
  }, 30_000);
});

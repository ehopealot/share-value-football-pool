import { applyD1Migrations, env } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkerApp } from "../../src/worker/app";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace; POOL_COMMAND_AUTHENTICATOR_KEY: string };
let migrated = false;
const app = (user: { id: string; name: string } | null) => createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => user, allowInsecureLocalAuth: true });
const request = (path: string, body?: unknown) => new Request(`http://127.0.0.1${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "http://127.0.0.1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
beforeEach(async () => { if (!migrated) { await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; } await bindings.DB.exec("DELETE FROM membership_projection; DELETE FROM pool_registry_command_response; DELETE FROM pool_registry; DELETE FROM user;"); await bindings.DB.exec("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('owner','Owner','owner@example.test',1,0,0),('visitor','Visitor','visitor@example.test',1,0,0)"); });

describe("account entry reads", () => {
  it("lists projected memberships and exposes only the approved nonmember gate fields", async () => {
    const owner = app({ id: "owner", name: "Owner" });
    expect((await owner.fetch(request("/api/pools", { slug: "entry-pool", poolName: "Entry Pool", password: "correct-password", idempotencyKey: "create" }))).status).toBe(201);
    await bindings.DB.prepare("INSERT INTO membership_projection (pool_id,user_id,pool_name,role,status,projection_version) SELECT pool_id, 'owner', 'Entry Pool', 'commissioner', 'active', '1' FROM pool_registry WHERE normalized_slug = 'entry-pool'").run();
    expect(await (await owner.fetch(request("/api/pools"))).json()).toEqual({ memberships: [expect.objectContaining({ slug: "entry-pool", poolName: "Entry Pool" })] });
    expect(await (await app({ id: "visitor", name: "Visitor" }).fetch(request("/api/p/entry-pool/gate"))).json()).toEqual({ membership: "joinable", poolName: "Entry Pool", signupsOpen: true });
    await owner.fetch(request("/api/p/entry-pool/admin/settings", { signupsOpen: false, idempotencyKey: "close" }));
    expect(await (await app({ id: "visitor", name: "Visitor" }).fetch(request("/api/p/entry-pool/gate"))).json()).toEqual({ membership: "closed", signupsOpen: false });
  }, 90_000);
});

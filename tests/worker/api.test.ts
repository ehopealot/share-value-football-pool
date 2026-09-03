import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import migration from "../../src/db/migrations/0001_initial.sql?raw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerApp } from "../../src/worker/app";
import { selectionForOutcome } from "../../src/web/selection-matcher";
import { poolCommandSchema } from "../../src/durable/pool-commands";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace; POOL_COMMAND_AUTHENTICATOR_KEY: string };
let migrated = false;
const origin = "https://pool.example.test";
const request = (path: string, body?: unknown, method = "POST") => new Request(`${origin}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json", origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function send(poolId: string, command: unknown) {
  return bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)).fetch("https://pool.internal/command", { method: "POST", body: JSON.stringify(command) });
}

async function setupPool(poolId: string, slug: string) {
  await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, slug, poolId, `create-${poolId}`, new Date().toISOString()).run();
  await send(poolId, { type: "InitializePool", commandId: `init-${poolId}`, poolId, slug, creatorId: "owner", creatorName: "Owner", poolName: "API Pool", password: "correct-password" });
  await send(poolId, { type: "JoinPool", commandId: `join-${poolId}`, actorId: "member", displayName: "Member", password: "correct-password" });
  await send(poolId, { type: "CreateSeason", commandId: `season-${poolId}`, actorId: "owner", seasonId: "s1", label: "2026" });
  await send(poolId, { type: "OpenSeason", commandId: `open-${poolId}`, actorId: "owner", seasonId: "s1" });
}

beforeEach(async () => {
  if (!migrated) { await applyD1Migrations(bindings.DB, [{ name: "0001_initial.sql", queries: migration.split(";\n").filter(Boolean) }]); migrated = true; }
  await bindings.DB.exec("DELETE FROM market_offer; DELETE FROM sports_event; DELETE FROM odds_ingestion; DELETE FROM pool_registry_command_response; DELETE FROM pool_registry; INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'owner-api@example.test', 1, 0, 0), ('member', 'Member', 'member-api@example.test', 1, 0, 0); INSERT INTO odds_ingestion (provider, last_polled_at, last_success_at, last_error) VALUES ('odds', '2100-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z', NULL);");
});

describe("later wager and member HTTP API", () => {
  it("reserves API and internal roots from SPA fallback", async () => {
    const assets = { fetch: vi.fn(async () => new Response("SPA")) };
    const app = createWorkerApp({
      db: bindings.DB,
      pools: bindings.POOL_DO,
      currentUser: async () => null,
      spaAssets: assets as unknown as Fetcher
    });

    for (const path of ["/api", "/api/unknown", "/internal", "/internal/unknown"]) {
      const response = await app.fetch(new Request(`${origin}${path}`));
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({ code: "NOT_FOUND" });
    }
    expect(assets.fetch).not.toHaveBeenCalled();

    const deepRoute = await app.fetch(new Request(`${origin}/pool/example/standings`));
    expect(deepRoute.status).toBe(200);
    expect(await deepRoute.text()).toBe("SPA");
    expect(assets.fetch).toHaveBeenCalledTimes(1);
  });

  it("exposes the approved administration routes and no manual close route", async () => {
    const poolId = `api-admin-${crypto.randomUUID()}`;
    await setupPool(poolId, "api-admin-pool");
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "owner", name: "Owner" }), recentlyAuthenticated: async () => true });
    const body = { idempotencyKey: "admin-command", reason: "Documented correction" };
    expect((await app.fetch(request("/api/p/api-admin-pool/admin/orders/order-does-not-exist/reverse", body))).status).toBe(400);
    expect((await app.fetch(request("/api/p/api-admin-pool/admin/seasons/s1/close", body))).status).toBe(404);
  }, 90_000);
  it("lets an active member set a pool-scoped nickname", async () => {
    const poolId = `api-nickname-${crypto.randomUUID()}`;
    const slug = `api-nickname-${crypto.randomUUID()}`;
    await setupPool(poolId, slug);
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Account name" }) });
    const updated = await app.fetch(request(`/api/p/${slug}/nickname`, { displayName: "Sunday Shark", idempotencyKey: "nickname-1" }));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ displayName: "Sunday Shark", commandVersion: expect.any(String) });
    const view = await app.fetch(request(`/api/p/${slug}/view`, undefined, "GET"));
    expect((await view.json() as any).members).toContainEqual(expect.objectContaining({ memberId: "member", displayName: "Sunday Shark" }));
  }, 90_000);

  it("protects state-changing board reads and exposes strict member-only board POST routes", async () => {
    const poolId = `api-board-${crypto.randomUUID()}`;
    const slug = `api-board-${crypto.randomUUID()}`;
    await setupPool(poolId, slug);
    await send(poolId, { type: "CreateMessageBoardPost", commandId: "owner-board-post", actorId: "owner", text: "Unread for Member" });
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const readPath = `/api/p/${slug}/board/read`;
    const view = async () => await (await send(poolId, { type: "ReadPoolView", commandId: crypto.randomUUID(), actorId: "member" })).json() as any;

    const ownerBoard = await (await send(poolId, { type: "ReadMessageBoard", commandId: "owner-board-read", actorId: "owner" })).json() as any;
    const ownerPostId = ownerBoard.threads[0].postId;
    const routes = [
      { path: readPath, body: {} },
      { path: `/api/p/${slug}/board/posts`, body: { text: "Blocked post", idempotencyKey: "blocked-post" } },
      { path: `/api/p/${slug}/board/posts/${ownerPostId}/replies`, body: { text: "Blocked reply", idempotencyKey: "blocked-reply" } }
    ];
    const entryCount = async () => {
      const snapshot = await (await send(poolId, { type: "ReadMessageBoard", commandId: crypto.randomUUID(), actorId: "owner" })).json() as any;
      return snapshot.threads.reduce((count: number, thread: any) => count + 1 + thread.replies.length, 0);
    };

    expect((await view()).currentMember.hasUnreadBoard).toBe(true);
    for (const blockedOrigin of [undefined, "https://attacker.example", "null", "not a valid origin", `${origin}/not-an-origin`, `${origin}?not-an-origin`, "https://user@pool.example.test"]) {
      for (const route of routes) {
        const headers = { "content-type": "application/json", ...(blockedOrigin === undefined ? {} : { origin: blockedOrigin }) };
        const response = await app.fetch(new Request(`${origin}${route.path}`, { method: "POST", headers, body: JSON.stringify(route.body) }));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ code: "CSRF_REJECTED" });
      }
      expect(await entryCount()).toBe(1);
      expect((await view()).currentMember.hasUnreadBoard).toBe(true);
    }
    expect((await app.fetch(request(readPath, {}))).status).toBe(200);
    expect((await view()).currentMember.hasUnreadBoard).toBe(false);
    expect((await app.fetch(request(`/api/p/${slug}/board`, undefined, "GET"))).status).toBe(404);
    expect((await app.fetch(request(readPath, { unexpected: true }))).status).toBe(400);

    const create = await app.fetch(request(`/api/p/${slug}/board/posts`, { text: "Member thread", idempotencyKey: "member-thread" }));
    expect(create.status).toBe(200);
    expect(await create.json()).toMatchObject({ commandVersion: expect.any(String), postId: expect.any(String), isAnnouncement: false, replayed: false });
    const board = await app.fetch(request(readPath, {}));
    expect(board.status).toBe(200);
    const memberThread = (await board.json() as any).threads.find((thread: any) => thread.text === "Member thread");
    expect(memberThread).toMatchObject({ authorDisplayName: "Member", replies: [] });
    const reply = await app.fetch(request(`/api/p/${slug}/board/posts/${memberThread.postId}/replies`, { text: "One reply", idempotencyKey: "member-reply" }));
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ commandVersion: expect.any(String) });
    const afterReply = await (await app.fetch(request(readPath, {}))).json() as any;
    const replyId = afterReply.threads.find((thread: any) => thread.postId === memberThread.postId).replies[0].replyId;
    expect((await app.fetch(request(`/api/p/${slug}/board/posts/${replyId}/replies`, { text: "No nesting", idempotencyKey: "nested-reply" }))).status).toBe(400);

    for (const body of [{ text: " ", idempotencyKey: "blank" }, { text: "x".repeat(1001), idempotencyKey: "long" }, { text: "Missing key" }, { text: "Extra", idempotencyKey: "extra", unexpected: true }]) {
      expect((await app.fetch(request(`/api/p/${slug}/board/posts`, body))).status).toBe(400);
    }
    const anonymous = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => null });
    for (const route of routes) expect((await anonymous.fetch(request(route.path, route.body))).status).toBe(401);
    const outsider = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "outsider", name: "Outsider" }) });
    for (const route of routes) expect((await outsider.fetch(request(route.path, route.body))).status).toBe(403);
    await send(poolId, { type: "SuspendMember", commandId: "suspend-board-member", actorId: "owner", memberId: "member" });
    for (const route of routes) expect((await app.fetch(request(route.path, route.body))).status).toBe(403);
  }, 90_000);

  it("starts a best-effort commissioner announcement blast only once after the post commits", async () => {
    const poolId = `api-announcement-${crypto.randomUUID()}`;
    const slug = `api-announcement-${crypto.randomUUID()}`;
    await bindings.DB.prepare("INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('suspended', 'Suspended', 'suspended-api@example.test', 1, 0, 0)").run();
    await setupPool(poolId, slug);
    await send(poolId, { type: "JoinPool", commandId: `join-suspended-${poolId}`, actorId: "suspended", displayName: "Suspended", password: "correct-password" });
    await send(poolId, { type: "SuspendMember", commandId: `suspend-${poolId}`, actorId: "owner", memberId: "suspended" });
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    const notifyCommissionerAnnouncement = vi.fn(async () => await deferred);
    const app = createWorkerApp({
      db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY,
      currentUser: async () => ({ id: "owner", name: "Owner" }),
      poolJoinNotifier: { notifyPoolJoin: async () => {}, notifyCommissionerTransfer: async () => {}, notifyShareOrderFulfilled: async () => {}, notifyCommissionerAnnouncement }
    });
    const pending: Promise<unknown>[] = [];
    const executionContext = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
    const path = `/api/p/${slug}/board/posts`;
    const body = { text: "Draft starts at noon.", idempotencyKey: "announcement-post", announcement: true };

    const first = await app.fetch(request(path, body), {}, executionContext);
    expect(first.status).toBe(200);
    const result = await first.json() as { postId: string; replayed: boolean; isAnnouncement: boolean };
    expect(result).toMatchObject({ postId: expect.any(String), isAnnouncement: true, replayed: false });
    expect(pending).toHaveLength(1);
    await expect.poll(() => notifyCommissionerAnnouncement).toHaveBeenCalledOnce();
    expect(notifyCommissionerAnnouncement).toHaveBeenCalledWith({
      to: "member-api@example.test", poolName: "API Pool", authorName: "Owner", text: "Draft starts at noon.",
      boardUrl: `https://pool.example.test/p/${encodeURIComponent(slug)}/board#post-${encodeURIComponent(result.postId)}`,
      idempotencyKey: `announcement/${result.postId}/member`
    });
    let settled = false;
    void pending[0]!.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await pending[0];

    expect((await app.fetch(request(path, body), {}, executionContext)).status).toBe(200);
    expect(pending).toHaveLength(1);
    const member = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }), poolJoinNotifier: { notifyPoolJoin: async () => {}, notifyCommissionerTransfer: async () => {}, notifyShareOrderFulfilled: async () => {}, notifyCommissionerAnnouncement } });
    const memberPending: Promise<unknown>[] = [];
    const memberContext = { waitUntil: (promise: Promise<unknown>) => { memberPending.push(promise); } } as ExecutionContext;
    const rejected = await member.fetch(request(path, { text: "Forged blast", idempotencyKey: "member-announcement", announcement: true }), {}, memberContext);
    expect(rejected.status).toBe(403);
    expect(memberPending).toEqual([]);
  }, 90_000);

  it("accepts a legacy ordinary post replay without scheduling an announcement blast", async () => {
    const poolId = `api-legacy-board-${crypto.randomUUID()}`;
    const slug = `api-legacy-board-${crypto.randomUUID()}`;
    await setupPool(poolId, slug);
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)), (_instance, state) => state.storage.sql.exec(
      "INSERT INTO processed_command (id, type, actor_id, request_json, response_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      "legacy-post", "CreateMessageBoardPost", "owner",
      JSON.stringify({ type: "CreateMessageBoardPost", commandId: "legacy-post", actorId: "owner", text: "Legacy ordinary post" }),
      JSON.stringify({ commandVersion: "5" }), "2099-01-01T00:00:00.000Z"
    ));
    const notifyCommissionerAnnouncement = vi.fn(async () => {});
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "owner", name: "Owner" }), poolJoinNotifier: { notifyPoolJoin: async () => {}, notifyCommissionerTransfer: async () => {}, notifyShareOrderFulfilled: async () => {}, notifyCommissionerAnnouncement } });
    const pending: Promise<unknown>[] = [];
    const executionContext = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as ExecutionContext;
    const response = await app.fetch(request(`/api/p/${slug}/board/posts`, { text: "Legacy ordinary post", idempotencyKey: "legacy-post" }), {}, executionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ commandVersion: "5", isAnnouncement: false, replayed: true });
    expect(notifyCommissionerAnnouncement).not.toHaveBeenCalled();
    expect(pending).toEqual([]);
  }, 90_000);

  it("rejects malformed board Durable Object responses at the Worker boundary", async () => {
    const poolId = `api-board-contract-${crypto.randomUUID()}`;
    const slug = `api-board-contract-${crypto.randomUUID()}`;
    await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, slug, poolId, `create-${poolId}`, new Date().toISOString()).run();
    const commands: Array<{ type: string }> = [];
    const malformedPools = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const command = JSON.parse(String(init?.body)) as { type: string };
        commands.push(command);
        if (command.type === "ReadMessageBoard") return Response.json({ commandVersion: "7" });
        if (command.type === "CreateMessageBoardPost") return new Response("not-json", { headers: { "content-type": "application/json" } });
        return Response.json({});
      } })
    } as unknown as DurableObjectNamespace;
    const app = createWorkerApp({ db: bindings.DB, pools: malformedPools, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "owner", name: "Owner" }) });

    for (const route of [
      { path: `/api/p/${slug}/board/read`, body: {} },
      { path: `/api/p/${slug}/board/posts`, body: { text: "Post", idempotencyKey: "post" } },
      { path: `/api/p/${slug}/board/posts/post/replies`, body: { text: "Reply", idempotencyKey: "reply" } }
    ]) {
      const response = await app.fetch(request(route.path, route.body));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "POOL_UNAVAILABLE" });
    }
    expect(commands.map((command) => command.type)).toEqual(["ReadMessageBoard", "CreateMessageBoardPost", "ReplyToMessageBoardPost"]);
  }, 90_000);

  it("normalizes structured board authority failures as retryable availability errors", async () => {
    const poolId = `api-board-upstream-${crypto.randomUUID()}`;
    const slug = `api-board-upstream-${crypto.randomUUID()}`;
    await bindings.DB.prepare("INSERT INTO pool_registry (pool_id, normalized_slug, do_name, creator_id, status, command_id, created_at) VALUES (?, ?, ?, 'owner', 'ready', ?, ?)").bind(poolId, slug, poolId, `create-${poolId}`, new Date().toISOString()).run();
    const upstreamFailures = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const command = JSON.parse(String(init?.body)) as { type: string };
        return command.type === "CreateMessageBoardPost"
          ? Response.json({ code: "COMMAND_FAILED" }, { status: 503 })
          : Response.json({ code: 123 }, { status: 400 });
      } })
    } as unknown as DurableObjectNamespace;
    const app = createWorkerApp({ db: bindings.DB, pools: upstreamFailures, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "owner", name: "Owner" }) });
    for (const route of [
      { path: `/api/p/${slug}/board/posts`, body: { text: "Post", idempotencyKey: "post" } },
      { path: `/api/p/${slug}/board/posts/post/replies`, body: { text: "Reply", idempotencyKey: "reply" } }
    ]) {
      const response = await app.fetch(request(route.path, route.body));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "POOL_UNAVAILABLE" });
    }
  });

  it("notifies the funded member once after a new share order is fulfilled", async () => {
    const poolId = `api-order-email-${crypto.randomUUID()}`;
    const slug = `api-order-email-${crypto.randomUUID()}`;
    await setupPool(poolId, slug);
    const quote = await (await send(poolId, { type: "QuoteShareOrder", commandId: "email-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "2500000" })).json() as { priceMicros: string; commandVersion: string };
    const notifyShareOrderFulfilled = vi.fn(async () => {});
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "owner", name: "Owner" }), poolJoinNotifier: { notifyPoolJoin: async () => {}, notifyCommissionerTransfer: async () => {}, notifyShareOrderFulfilled, notifyCommissionerAnnouncement: async () => {} } });
    const body = { seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "2500000", quote, reason: "Funding received", idempotencyKey: "email-order" };
    expect((await app.fetch(request(`/api/p/${slug}/admin/orders/execute`, body))).status).toBe(200);
    expect((await app.fetch(request(`/api/p/${slug}/admin/orders/execute`, body))).status).toBe(200);
    expect(notifyShareOrderFulfilled).toHaveBeenCalledOnce();
    expect(notifyShareOrderFulfilled).toHaveBeenCalledWith({ to: "member-api@example.test", poolName: "API Pool", sharesMicros: "2500000", valueMicros: "2500000" });
  }, 90_000);

  it("keeps fulfilled funding successful when notification work fails", async () => {
    const poolId = `api-order-email-failure-${crypto.randomUUID()}`;
    const slug = `api-order-email-failure-${crypto.randomUUID()}`;
    await setupPool(poolId, slug);
    const quote = await (await send(poolId, { type: "QuoteShareOrder", commandId: "email-failure-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000" })).json() as { priceMicros: string; commandVersion: string };
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "owner", name: "Owner" }), poolJoinNotifier: { notifyPoolJoin: async () => {}, notifyCommissionerTransfer: async () => {}, notifyShareOrderFulfilled: async () => { throw new Error("EMAIL_DELIVERY_FAILED"); }, notifyCommissionerAnnouncement: async () => {} } });
    const response = await app.fetch(request(`/api/p/${slug}/admin/orders/execute`, { seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000", quote, reason: "Funding received", idempotencyKey: "email-failure-order" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sharesMicros: "1000000", valueMicros: "1000000" });
  }, 90_000);

  it("preserves complete stale order replacement terms through the Worker boundary", async () => {
    const poolId = `api-order-stale-${crypto.randomUUID()}`;
    await setupPool(poolId, "api-order-stale-pool");
    const quote = await (await send(poolId, { type: "QuoteShareOrder", commandId: "stale-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "value", amountMicros: "1234567" })).json() as { priceMicros: string; commandVersion: string };
    const advanceQuote = await (await send(poolId, { type: "QuoteShareOrder", commandId: "advance-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000" })).json() as { priceMicros: string; commandVersion: string };
    await send(poolId, { type: "ExecuteShareOrder", commandId: "advance-order", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000", quote: advanceQuote, reason: "advance price" });
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "owner", name: "Owner" }) });
    const response = await app.fetch(request("/api/p/api-order-stale-pool/admin/orders/execute", { seasonId: "s1", memberId: "member", mode: "value", amountMicros: "1234567", quote, reason: "stale value", idempotencyKey: "stale-order" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "ORDER_QUOTE_STALE", reconfirmationRequired: true, replacement: { seasonId: "s1", memberId: "member", mode: "value", amountMicros: "1234567", priceMicros: expect.any(String), commandVersion: expect.any(String), sharesMicros: expect.any(String), valueMicros: expect.any(String) } });
  }, 90_000);

  it("requires commissioner, recent auth, and a bounded correction reason", async () => {
    const poolId = `api-correction-${crypto.randomUUID()}`;
    await setupPool(poolId, "api-correction-pool");
    const path = "/api/p/api-correction-pool/admin/corrections/missing/void";
    const body = { idempotencyKey: "correction", reason: "Official void" };
    const stale = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "owner", name: "Owner" }), recentlyAuthenticated: async () => false });
    expect((await stale.fetch(request(path, body))).status).toBe(403);
    const member = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }), recentlyAuthenticated: async () => true });
    expect((await member.fetch(request(path, body))).status).toBe(403);
    const owner = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "owner", name: "Owner" }), recentlyAuthenticated: async () => true });
    expect((await owner.fetch(request(path, { idempotencyKey: "empty-reason", reason: "" }))).status).toBe(400);
  }, 90_000);

  it("exposes only authenticated member reads, preserves redaction, and rejects browser settlement", async () => {
    const poolId = `api-${crypto.randomUUID()}`;
    await setupPool(poolId, "api-pool");
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });

    for (const path of ["view", "standings", "activity", "wagers", "export"]) {
      const response = await app.fetch(request(`/api/p/api-pool/${path}`, undefined, "GET"));
      expect(response.status, path).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.commandVersion, path).toEqual(expect.any(String));
      expect(JSON.stringify(body), path).not.toContain("canonicalOfferProof");
    }
    const activeHistory = await app.fetch(request("/api/p/api-pool/history/s1", undefined, "GET"));
    expect(activeHistory.status).toBe(400);
    expect(await activeHistory.json()).toMatchObject({ code: "SEASON_NOT_CLOSED" });
    expect((await app.fetch(request("/internal/pools/api-pool/settle", {}))).status).toBe(404);

    const anonymous = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, currentUser: async () => null });
    expect((await anonymous.fetch(request("/api/p/api-pool/wagers", undefined, "GET"))).status).toBe(401);
    await send(poolId, { type: "SuspendMember", commandId: `suspend-${poolId}`, actorId: "owner", memberId: "member" });
    expect((await app.fetch(request("/api/p/api-pool/view", undefined, "GET"))).status).toBe(403);
  }, 90_000);

  it("returns exact stored feed observations and current canonical source timestamps for every feed state", async () => {
    const poolId = `api-feed-${crypto.randomUUID()}`;
    const slug = `api-feed-${crypto.randomUUID()}`;
    await setupPool(poolId, slug);
    await bindings.DB.exec("DELETE FROM odds_ingestion");
    const startsAt = new Date(Date.now() + 5 * 60_000).toISOString();
    await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES ('feed-one', 'feed-one', 'nfl', 'Home', 'Away', ?, 'scheduled', '1'), ('feed-two', 'feed-two', 'ncaaf', 'College Home', 'College Away', ?, 'scheduled', '1')").bind(startsAt, startsAt).run();
    await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES ('feed-one', 'spread', 'DraftKings', '2030-09-01T10:00:00.000Z', 'v1', ?), ('feed-two', 'total', 'FanDuel', '2030-09-01T10:02:00.000Z', 'v2', ?)").bind(JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] }), JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Over", price: -110, point: 45 }, { name: "Under", price: -110, point: 45 }] })).run();
    await bindings.DB.prepare("INSERT INTO odds_ingestion (provider, last_polled_at, last_success_at, last_error) VALUES ('odds', '2030-09-01T10:03:00.000Z', '2030-09-01T10:03:00.000Z', NULL)").run();
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const odds = async () => (await (await app.fetch(request(`/api/p/${slug}/odds`, undefined, "GET"))).json()) as any;

    expect(await odds()).toEqual({
      offers: [
        expect.objectContaining({ eventId: "feed-one", canonicalBook: "DraftKings", retrievedAt: "2030-09-01T10:00:00.000Z" }),
        expect.objectContaining({ eventId: "feed-two", canonicalBook: "FanDuel", retrievedAt: "2030-09-01T10:02:00.000Z" })
      ],
      feed: { status: "current", message: "Odds are up to date.", lastPolledAt: "2030-09-01T10:03:00.000Z", lastSuccessAt: "2030-09-01T10:03:00.000Z" }
    });

    await bindings.DB.prepare("UPDATE market_offer SET retrieved_at = ?").bind(new Date(Date.now() - 29 * 60 * 1000).toISOString()).run();
    expect((await odds()).feed.status).toBe("current");
    await bindings.DB.prepare("UPDATE market_offer SET retrieved_at = ?").bind(new Date(Date.now() - 30 * 60 * 1000 - 1).toISOString()).run();
    expect((await odds()).feed).toEqual({ status: "stale", message: "Current odds are stale; new bets are disabled.", lastPolledAt: "2030-09-01T10:03:00.000Z", lastSuccessAt: "2030-09-01T10:03:00.000Z" });
    await bindings.DB.prepare("UPDATE odds_ingestion SET last_polled_at = '2030-09-01T10:04:00.000Z', last_error = 'upstream failed'").run();
    expect((await odds()).feed).toEqual({ status: "provider-error", message: "Odds provider error; accepted bets remain intact.", lastPolledAt: "2030-09-01T10:04:00.000Z", lastSuccessAt: "2030-09-01T10:03:00.000Z" });
    await bindings.DB.exec("DELETE FROM market_offer; UPDATE odds_ingestion SET last_polled_at = '2030-09-01T10:05:00.000Z', last_error = NULL");
    expect(await odds()).toEqual({ offers: [], feed: { status: "no-offer", message: "No current odds are available.", lastPolledAt: "2030-09-01T10:05:00.000Z", lastSuccessAt: "2030-09-01T10:03:00.000Z" } });
  }, 90_000);

  it("fails the whole odds board closed when stored offers lack strict payload or successful-ingestion provenance", async () => {
    const poolId = `api-attested-${crypto.randomUUID()}`;
    const slug = `api-attested-${crypto.randomUUID()}`;
    await setupPool(poolId, slug);
    const startsAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const retrievedAt = new Date().toISOString();
    await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES ('attested-one', 'attested-one', 'nfl', 'Home', 'Away', ?, 'scheduled', '1'), ('attested-two', 'attested-two', 'nfl', 'Home 2', 'Away 2', ?, 'scheduled', '1')").bind(startsAt, startsAt).run();
    const valid = JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] });
    await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES ('attested-one', 'spread', 'DraftKings', ?, 'v1', ?), ('attested-two', 'spread', 'DraftKings', ?, 'v1', ?)").bind(retrievedAt, valid, retrievedAt, valid).run();
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const odds = async () => (await (await app.fetch(request(`/api/p/${slug}/odds`, undefined, "GET"))).json()) as any;
    const expectUnavailable = async (status: "no-offer" | "stale" | "provider-error") => expect(await odds()).toMatchObject({ offers: [], feed: { status } });

    await bindings.DB.exec("DELETE FROM odds_ingestion");
    await expectUnavailable("no-offer");
    const unverifiedQuote = await app.fetch(request(`/api/p/${slug}/wagers/straight/quote`, { quoteKey: "unverified-quote", commandId: "unverified-quote", wagerId: "unverified-wager", seasonId: "s1", riskMicros: "1000000", rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: "attested-one", canonicalBook: "DraftKings", market: "spread", selection: "home", offerId: "attested-one:spread:home", offerVersion: "v1" } }));
    expect(unverifiedQuote.status).toBe(400);
    expect(await unverifiedQuote.json()).toMatchObject({ code: "MARKET_UNAVAILABLE" });
    await bindings.DB.prepare("INSERT INTO odds_ingestion (provider, last_polled_at, last_success_at, last_error) VALUES ('odds', ?, NULL, NULL)").bind(retrievedAt).run();
    await expectUnavailable("no-offer");
    await bindings.DB.prepare("UPDATE odds_ingestion SET last_success_at = '2000-01-01T00:00:00.000Z'").run();
    await expectUnavailable("no-offer");
    await bindings.DB.prepare("UPDATE odds_ingestion SET last_success_at = ?, last_error = NULL").bind(retrievedAt).run();
    await bindings.DB.prepare("UPDATE market_offer SET payload_json = ? WHERE event_id = 'attested-one'").bind(JSON.stringify({ outcomes: [{ name: "Home", price: -110, point: -3 }] })).run();
    await expectUnavailable("no-offer");
    await bindings.DB.prepare("UPDATE market_offer SET payload_json = ? WHERE event_id = 'attested-one'").bind(valid).run();
    await bindings.DB.prepare("UPDATE market_offer SET payload_json = ? WHERE event_id = 'attested-two'").bind(JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: "-110", point: -3 }] })).run();
    await expectUnavailable("no-offer");
    await bindings.DB.prepare("UPDATE market_offer SET payload_json = ? WHERE event_id = 'attested-two'").bind(valid).run();
    await bindings.DB.prepare("UPDATE market_offer SET retrieved_at = '2000-01-01T00:00:00.000Z'").run();
    await expectUnavailable("stale");
    await bindings.DB.prepare("UPDATE odds_ingestion SET last_polled_at = ?, last_error = 'upstream failed'").bind(new Date(Date.now() + 1000).toISOString()).run();
    await expectUnavailable("provider-error");
  }, 90_000);

  it("carries a punctuation-distinct board click through the real Worker quote boundary", async () => {
    const poolId = `api-punctuation-${crypto.randomUUID()}`; const slug = `api-punctuation-${crypto.randomUUID()}`;
    await setupPool(poolId, slug);
    const startsAt = "2099-09-10T20:00:00.000Z"; const retrievedAt = new Date().toISOString();
    await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES ('punctuation-event', 'punctuation-event', 'nfl', 'A-B', 'AB', ?, 'scheduled', '1')").bind(startsAt).run();
    await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES ('punctuation-event', 'spread', 'DraftKings', ?, 'punctuation-v1', ?)").bind(retrievedAt, JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "A-B", price: -105, point: -2 }, { name: "AB", price: -115, point: 2 }] })).run();
    await bindings.DB.prepare("UPDATE odds_ingestion SET last_polled_at=?, last_success_at=?").bind(retrievedAt, retrievedAt).run();
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const board = await (await app.fetch(request(`/api/p/${slug}/odds`, undefined, "GET"))).json() as any;
    const offer = board.offers[0]; const clicked = offer.outcomes.find((outcome: any) => outcome.name === "AB");
    const selection = selectionForOutcome(offer, clicked);
    expect(selection).toBe("away");
    const quoteKey = `punctuation-${crypto.randomUUID()}`;
    const response = await app.fetch(request(`/api/p/${slug}/wagers/straight/quote`, { quoteKey, commandId: quoteKey, wagerId: "punctuation-wager", seasonId: "s1", riskMicros: "1000000", rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: offer.eventId, canonicalBook: offer.canonicalBook, market: offer.market, selection, offerId: `${offer.eventId}:${offer.market}:${selection}`, offerVersion: offer.offerVersion } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ leg: { selection: "away", originalOdds: -115, originalLine: 2, canonicalOfferProof: { offerId: "punctuation-event:spread:away" } } });
  }, 90_000);

  it("filters the authenticated odds board by the approved date query", async () => {
    const poolId = `api-date-${crypto.randomUUID()}`;
    await setupPool(poolId, "api-date-pool");
    const retrievedAt = new Date().toISOString();
    for (const [id, startsAt] of [["date-one", "2099-09-10T20:00:00.000Z"], ["date-two", "2099-09-11T20:00:00.000Z"]]) {
      await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES (?, ?, 'nfl', 'Home', 'Away', ?, 'scheduled', '1')").bind(id, id, startsAt).run();
      await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES (?, 'spread', 'DraftKings', ?, 'v1', ?)").bind(id, retrievedAt, JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] })).run();
    }
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const response = await app.fetch(request("/api/p/api-date-pool/odds?league=nfl&market=spread&date=2099-09-11", undefined, "GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ offers: [{ eventId: "date-two", startsAt: "2099-09-11T20:00:00.000Z" }] });
  }, 90_000);

  async function quoteAndPlace(app: ReturnType<typeof createWorkerApp>, slug: string, kind: "straight" | "teasers" | "parlays", input: any, mutationKey: string) {
    const legs = kind === "straight" ? [input.leg] : input.legs;
    const semanticLeg = (leg: any) => ({ eventId: leg.eventId, canonicalBook: leg.canonicalBook, market: leg.market, selection: leg.selection, offerId: leg.canonicalOfferProof.offerId, offerVersion: leg.offerVersion });
    const quoteKey = `quote:${mutationKey}`;
    const quoteInput = kind === "straight"
      ? { quoteKey, commandId: quoteKey, wagerId: input.wagerId, seasonId: input.seasonId, riskMicros: input.riskMicros, rulesetVersion: input.rulesetVersion, leg: semanticLeg(legs[0]) }
      : { quoteKey, commandId: quoteKey, wagerId: input.wagerId, seasonId: input.seasonId, riskMicros: input.riskMicros, ...(kind === "teasers" ? { teaserPoints: input.teaserPoints } : {}), rulesetVersion: input.rulesetVersion, legs: legs.map(semanticLeg) };
    const quotedResponse = await app.fetch(request(`/api/p/${slug}/wagers/${kind}/quote`, quoteInput));
    expect(quotedResponse.status).toBe(200);
    const quote = await quotedResponse.json() as Record<string, any>;
    const { ownerMemberId: _ownerMemberId, commandVersion, ...terms } = quote;
    const placement = { ...terms, wagerId: input.wagerId, commandId: mutationKey, mutationKey, quotedCommandVersion: commandVersion };
    return { quote, placement, place: () => app.fetch(request(`/api/p/${slug}/wagers/${kind}/place`, placement)) };
  }

  it("uses the same strict stored-offer semantics for board, quote, and placement revalidation", async () => {
    const poolId = `api-market-trust-${crypto.randomUUID()}`; const slug = "api-market-trust";
    await setupPool(poolId, slug);
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const startsAt = "2099-09-10T20:00:00.000Z"; const retrievedAt = new Date().toISOString();
    const spread = [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }];
    const cases: Array<{ name: string; market?: "spread" | "total" | "moneyline"; selection?: "home" | "over"; book?: string; home?: string; away?: string; invalid: string; valid?: string }> = [
      { name: "policy", invalid: JSON.stringify({ policyVersion: "other", outcomes: spread }) },
      { name: "book", book: "UntrustedBook", invalid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: spread }) },
      { name: "counterpart", invalid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: spread.slice(0, 1) }) },
      { name: "duplicate", invalid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [spread[0], { name: "home", price: -105, point: -3 }, spread[1]] }) },
      { name: "ambiguous", home: "away", away: "Visitor", invalid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "home", price: -110, point: -3 }, { name: "away", price: -110, point: 3 }] }), valid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "home", price: -110, point: -3 }, { name: "Visitor", price: -110, point: 3 }] }) },
      { name: "unrecognized", invalid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [spread[0], { name: "Visitor", price: -110, point: 3 }] }) },
      { name: "point", invalid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -110 }, spread[1]] }) },
      { name: "spread-counterpart-line", invalid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ ...spread[0], point: -3 }, { ...spread[1], point: 4 }] }) },
      { name: "total-counterpart-line", market: "total", selection: "over", invalid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Over", price: -110, point: 47.5 }, { name: "Under", price: -110, point: 48.5 }] }), valid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Over", price: -110, point: 47.5 }, { name: "Under", price: -110, point: 47.5 }] }) },
      { name: "moneyline-point", market: "moneyline", invalid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -135, point: 0 }, { name: "Away", price: 115 }] }), valid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -135 }, { name: "Away", price: 115 }] }) },
      { name: "price", invalid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ ...spread[0], price: 0 }, spread[1]] }) },
      { name: "fields", invalid: JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ ...spread[0], asserted: true }, spread[1]] }) }
    ];
    for (const [index, fixture] of cases.entries()) {
      const eventId = `market-trust-${index}`; const market = fixture.market ?? "spread"; const book = fixture.book ?? "DraftKings";
      const home = fixture.home ?? "Home"; const away = fixture.away ?? "Away";
      const valid = fixture.valid ?? JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: spread });
      await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES (?, ?, 'nfl', ?, ?, ?, 'scheduled', '1')").bind(eventId, eventId, home, away, startsAt).run();
      await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES (?, ?, ?, ?, 'v1', ?)").bind(eventId, market, book, retrievedAt, fixture.invalid).run();
      const board = await (await app.fetch(request(`/api/p/${slug}/odds?market=${market}`, undefined, "GET"))).json() as any;
      expect(board.offers, `${fixture.name} board`).toEqual([]);
      const selection = fixture.selection ?? "home";
      const semantic = { eventId, canonicalBook: book, market, selection, offerId: `${eventId}:${market}:${selection}`, offerVersion: "v1" };
      const badQuote = { quoteKey: `bad-${index}`, commandId: `bad-${index}`, wagerId: `bad-${index}`, seasonId: "s1", riskMicros: "1000000", rulesetVersion: "SHARE_POOL_2026_V1", leg: semantic };
      const quoteResponse = await app.fetch(request(`/api/p/${slug}/wagers/straight/quote`, badQuote));
      expect(quoteResponse.status, `${fixture.name} quote`).toBe(400);
      expect(await quoteResponse.json()).toMatchObject({ code: "MARKET_UNAVAILABLE" });
      const fingerprint = JSON.stringify({ wagerId: badQuote.wagerId, seasonId: badQuote.seasonId, riskMicros: badQuote.riskMicros, rulesetVersion: badQuote.rulesetVersion, leg: badQuote.leg, actorId: "member" });
      const replay = await send(poolId, { type: "ReplayWagerQuote", commandId: badQuote.quoteKey, actorId: "member", identity: { actorId: "member", quoteKey: badQuote.quoteKey, fingerprint } });
      expect(await replay.json(), `${fixture.name} durable quote`).toEqual({ code: "QUOTE_NOT_FOUND" });

      await bindings.DB.prepare("UPDATE market_offer SET canonical_book='DraftKings', payload_json=? WHERE event_id=?").bind(valid, eventId).run();
      const input = { wagerId: `place-${index}`, seasonId: "s1", riskMicros: "1000000", rulesetVersion: "SHARE_POOL_2026_V1", leg: { ...semantic, canonicalBook: "DraftKings", canonicalOfferProof: { offerId: semantic.offerId } } };
      const quoted = await quoteAndPlace(app, slug, "straight", input, `place-${index}`);
      await bindings.DB.prepare("UPDATE market_offer SET canonical_book=?, payload_json=? WHERE event_id=?").bind(book, fixture.invalid, eventId).run();
      const rejected = await quoted.place();
      expect(rejected.status, `${fixture.name} revalidation`).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: "LINE_CHANGED", reconfirmationRequired: true });
      const wagers = await (await app.fetch(request(`/api/p/${slug}/wagers`, undefined, "GET"))).text();
      expect(wagers, `${fixture.name} PoolDO mutation`).not.toContain(`place-${index}`);
      await bindings.DB.prepare("DELETE FROM market_offer WHERE event_id=?").bind(eventId).run();
    }
  }, 180_000);

  it("uses quote-first HTTP teaser D1 revalidation for every adjustment direction", async () => {
    const poolId = `api-teaser-directions-${crypto.randomUUID()}`;
    const slug = "api-teaser-directions";
    await setupPool(poolId, slug);
    const fundingQuote = await (await send(poolId, { type: "QuoteShareOrder", commandId: "fund-directions-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "8000000" })).json() as { priceMicros: string; commandVersion: string };
    await send(poolId, { type: "ExecuteShareOrder", commandId: "fund-directions", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "8000000", quote: fundingQuote, reason: "direction fixtures" });
    const startsAt = "2099-09-10T20:00:00.000Z"; const retrievedAt = new Date().toISOString();
    const cases = [
      ["favorite", "spread", "home", -3, -5, 3, 1],
      ["underdog", "spread", "away", 3, 5, 9, 11],
      ["over", "total", "over", 45, 47, 39, 41],
      ["under", "total", "under", 45, 43, 51, 49]
    ] as const;
    for (const [id, market, selection, initial, changed] of cases) {
      const outcomes = market === "spread" ? [{ name: "Home", price: -110, point: selection === "home" ? initial : -initial }, { name: "Away", price: -110, point: selection === "away" ? initial : -initial }] : [{ name: "Over", price: -110, point: initial }, { name: "Under", price: -110, point: initial }];
      for (const eventId of [id, `${id}-partner`]) {
        await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES (?, ?, 'nfl', 'Home', 'Away', ?, 'scheduled', '1')").bind(eventId, eventId, startsAt).run();
        await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES (?, ?, 'DraftKings', ?, 'v1', ?)").bind(eventId, market, retrievedAt, JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes })).run();
      }
    }
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    for (const [id, market, selection, initial, changed, adjusted, adjustedChanged] of cases) {
      const other = `${id}-partner`;
      const otherLine = initial;
      const leg = (eventId: string, line: number, pick: string) => ({ eventId, league: "nfl", canonicalBook: "DraftKings", market, selection: pick, offerVersion: "v1", canonicalOfferProof: { offerId: `${eventId}:${market}:${pick}`, eventId, offerVersion: "v1", canonicalBook: "DraftKings", market, selection: pick, odds: -110, line } });
      const input = { wagerId: `unchanged-${id}`, seasonId: "s1", riskMicros: "1000000", teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: [leg(id, initial, selection), leg(other, otherLine, selection)] };
      const unchanged = await quoteAndPlace(app, slug, "teasers", input, `unchanged-${id}`);
      expect((await unchanged.place()).status).toBe(200);
      const altered = await quoteAndPlace(app, slug, "teasers", { ...input, wagerId: `changed-${id}` }, `changed-${id}`);
      const outcomes = market === "spread" ? [{ name: "Home", price: -110, point: selection === "home" ? changed : -changed }, { name: "Away", price: -110, point: selection === "away" ? changed : -changed }] : [{ name: "Over", price: -110, point: changed }, { name: "Under", price: -110, point: changed }];
      await bindings.DB.prepare("UPDATE market_offer SET offer_version = 'v2', payload_json = ? WHERE event_id = ? AND market = ?").bind(JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes }), id, market).run();
      const rejected = await altered.place(); expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: "LINE_CHANGED", replacement: { legs: expect.arrayContaining([expect.objectContaining({ originalLine: changed, adjustedLine: adjustedChanged })]) } });
    }
  }, 90_000);

  it("rejects quote-time canonical turnover without persisting a stale quote", async () => {
    const poolId = `api-quote-turnover-${crypto.randomUUID()}`; const slug = "api-quote-turnover";
    await setupPool(poolId, slug);
    const startsAt = "2099-09-10T20:00:00.000Z"; const retrievedAt = new Date().toISOString();
    await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES ('quote-turnover', 'quote-turnover', 'nfl', 'Home', 'Away', ?, 'scheduled', '1')").bind(startsAt).run();
    await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES ('quote-turnover', 'spread', 'DraftKings', ?, 'v2', ?)").bind(retrievedAt, JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -105, point: -2.5 }, { name: "Away", price: -115, point: 2.5 }] })).run();
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const staleRequest = { quoteKey: "turnover-quote", commandId: "turnover-quote", wagerId: "turnover-wager", seasonId: "s1", riskMicros: "1000000", rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: "quote-turnover", canonicalBook: "DraftKings", market: "spread", selection: "home", offerId: "quote-turnover:spread:home", offerVersion: "v1" } };
    const response = await app.fetch(request(`/api/p/${slug}/wagers/straight/quote`, staleRequest));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "LINE_CHANGED", reconfirmationRequired: true });
    const quoteRows = await bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)).fetch("https://pool.internal/command", { method: "POST", body: JSON.stringify({ type: "ReadAuditExport", commandId: "audit-turnover", actorId: "member" }) });
    expect(await quoteRows.json()).not.toHaveProperty("wagerQuotes");
    // The direct storage assertion ensures the stale key cannot be replayed as a mismatched durable snapshot.
    const count = await bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)).fetch("https://pool.internal/command", { method: "POST", body: JSON.stringify({ type: "ReplayWagerQuote", commandId: "turnover-quote", actorId: "member", identity: { actorId: "member", quoteKey: "turnover-quote", fingerprint: JSON.stringify({ wagerId: staleRequest.wagerId, seasonId: staleRequest.seasonId, riskMicros: staleRequest.riskMicros, rulesetVersion: staleRequest.rulesetVersion, leg: staleRequest.leg, actorId: "member" }) } }) });
    expect(await count.json()).toEqual({ code: "QUOTE_NOT_FOUND" });
  }, 90_000);

  it("rejects teaser quote-time canonical turnover without storing a replacement snapshot", async () => {
    const poolId = `api-teaser-quote-turnover-${crypto.randomUUID()}`; const slug = "api-teaser-quote-turnover";
    await setupPool(poolId, slug);
    const startsAt = "2099-09-10T20:00:00.000Z"; const retrievedAt = new Date().toISOString();
    for (const eventId of ["teaser-turnover-one", "teaser-turnover-two"]) {
      await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES (?, ?, 'nfl', 'Home', 'Away', ?, 'scheduled', '1')").bind(eventId, eventId, startsAt).run();
      await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES (?, 'spread', 'DraftKings', ?, ?, ?)").bind(eventId, retrievedAt, eventId.endsWith("one") ? "v2" : "v1", JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -110, point: eventId.endsWith("one") ? -2.5 : -3 }, { name: "Away", price: -110, point: eventId.endsWith("one") ? 2.5 : 3 }] })).run();
    }
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const leg = (eventId: string, offerVersion: string) => ({ eventId, canonicalBook: "DraftKings", market: "spread", selection: "home", offerId: `${eventId}:spread:home`, offerVersion });
    const staleRequest = { quoteKey: "teaser-turnover-quote", commandId: "teaser-turnover-quote", wagerId: "teaser-turnover-wager", seasonId: "s1", riskMicros: "1000000", teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: [leg("teaser-turnover-one", "v1"), leg("teaser-turnover-two", "v1")] };
    const response = await app.fetch(request(`/api/p/${slug}/wagers/teasers/quote`, staleRequest));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "LINE_CHANGED", reconfirmationRequired: true });
    const replay = await bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)).fetch("https://pool.internal/command", { method: "POST", body: JSON.stringify({ type: "ReplayWagerQuote", commandId: staleRequest.quoteKey, actorId: "member", identity: { actorId: "member", quoteKey: staleRequest.quoteKey, fingerprint: JSON.stringify({ wagerId: staleRequest.wagerId, seasonId: staleRequest.seasonId, riskMicros: staleRequest.riskMicros, teaserPoints: staleRequest.teaserPoints, rulesetVersion: staleRequest.rulesetVersion, legs: staleRequest.legs, actorId: "member" }) } }) });
    expect(await replay.json()).toEqual({ code: "QUOTE_NOT_FOUND" });
  }, 90_000);

  it("quotes and places authoritative parlays with exact same-game and vig-free moneyline terms", async () => {
    const poolId = `api-parlay-${crypto.randomUUID()}`; const slug = `api-parlay-${crypto.randomUUID()}`;
    await setupPool(poolId, slug);
    const fundingQuote = await (await send(poolId, { type: "QuoteShareOrder", commandId: "parlay-fund-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "2000000" })).json() as { priceMicros: string; commandVersion: string };
    await send(poolId, { type: "ExecuteShareOrder", commandId: "parlay-fund", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "2000000", quote: fundingQuote, reason: "parlay tests" });
    const retrievedAt = new Date().toISOString(); const startsAt = "2099-09-10T20:00:00.000Z";
    for (const [eventId, markets] of [["same", ["spread", "total"]], ["money", ["moneyline", "total"]]] as const) {
      await bindings.DB.prepare("INSERT INTO sports_event (id,provider_event_id,league,home_team,away_team,starts_at,status,correction_version) VALUES (?,?, 'nfl','Home','Away',?,'scheduled','1')").bind(eventId, eventId, startsAt).run();
      for (const market of markets) {
        const outcomes = market === "spread" ? [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }]
          : market === "total" ? [{ name: "Over", price: -110, point: 47 }, { name: "Under", price: -110, point: 47 }]
          : [{ name: "Home", price: -135 }, { name: "Away", price: 115 }];
        await bindings.DB.prepare("INSERT INTO market_offer (event_id,market,canonical_book,retrieved_at,offer_version,payload_json) VALUES (?,?,'DraftKings',?,'v1',?)").bind(eventId, market, retrievedAt, JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes })).run();
      }
    }
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const semantic = (eventId: string, market: string, selection: string) => ({ eventId, canonicalBook: "DraftKings", market, selection, offerVersion: "v1", canonicalOfferProof: { offerId: `${eventId}:${market}:${selection}` } });
    const same = await quoteAndPlace(app, slug, "parlays", { wagerId: "same-parlay", seasonId: "s1", riskMicros: "1000000", rulesetVersion: "PARLAY_2026_V1", legs: [semantic("same", "spread", "home"), semantic("same", "total", "over")] }, "place-same-parlay");
    expect(same.quote).toMatchObject({ acceptedOdds: 250, rulesetVersion: "PARLAY_2026_V1" });
    let placementBatches = 0;
    const countingDb = {
      prepare: bindings.DB.prepare.bind(bindings.DB),
      batch: async (statements: D1PreparedStatement[]) => { placementBatches++; return bindings.DB.batch(statements); }
    } as unknown as D1Database;
    const placementApp = createWorkerApp({ db: countingDb, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    expect((await placementApp.fetch(request(`/api/p/${slug}/wagers/parlays/place`, same.placement))).status).toBe(200);
    expect(placementBatches).toBe(1);
    expect(await (await same.place()).json()).toMatchObject({ wagerId: "same-parlay" });
    const money = await quoteAndPlace(app, slug, "parlays", { wagerId: "money-parlay", seasonId: "s1", riskMicros: "1000000", rulesetVersion: "PARLAY_2026_V1", legs: [semantic("money", "moneyline", "home"), semantic("money", "total", "over")] }, "place-money-parlay");
    expect(money.quote).toMatchObject({ acceptedOdds: 216, legs: [{ originalOdds: -124, canonicalOfferProof: { odds: -135 } }, { originalOdds: -110 }] });
    expect((await money.place()).status).toBe(200);
    const durable = await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)), (_instance, state) => ({ wagers: [...state.storage.sql.exec("SELECT id,type,accepted_odds,ruleset_version FROM wager WHERE type='parlay' ORDER BY id")], account: [...state.storage.sql.exec("SELECT available_micros,locked_micros FROM share_account WHERE season_id='s1' AND member_id='member'")][0] }));
    expect(durable).toEqual({ wagers: [{ id: "money-parlay", type: "parlay", accepted_odds: 216, ruleset_version: "PARLAY_2026_V1" }, { id: "same-parlay", type: "parlay", accepted_odds: 250, ruleset_version: "PARLAY_2026_V1" }], account: { available_micros: "0", locked_micros: "2000000" } });
  }, 90_000);

  it("normalizes registry lookup failures as retryable pool availability", async () => {
    const failedRegistry = {
      prepare: () => { throw new Error("registry offline"); }
    } as unknown as D1Database;
    const app = createWorkerApp({ db: failedRegistry, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const quote = await app.fetch(request("/api/p/registry-offline/wagers/parlays/quote", { quoteKey: "registry", commandId: "registry", wagerId: "registry", seasonId: "s1", riskMicros: "1000000", rulesetVersion: "PARLAY_2026_V1", legs: [{ eventId: "one", canonicalBook: "DraftKings", market: "spread", selection: "home", offerId: "one:spread:home", offerVersion: "v1" }, { eventId: "two", canonicalBook: "DraftKings", market: "spread", selection: "home", offerId: "two:spread:home", offerVersion: "v1" }] }));
    expect(quote.status).toBe(503);
    expect(await quote.json()).toEqual({ code: "POOL_UNAVAILABLE" });
  });

  it("replays stored seven-leg teaser bytes before offer reads and rejects fresh seven-leg keys without mutation", async () => {
    const poolId = `legacy-seven-${crypto.randomUUID()}`; const slug = `legacy-seven-${crypto.randomUUID()}`;
    await setupPool(poolId, slug);
    const teaserLeg = (index: number) => ({ eventId: `legacy-${index}`, league: "nfl", canonicalBook: "DraftKings", retrievedAt: "2026-01-01T00:00:00.000Z", policyVersion: "CANONICAL_BOOKS_2026_V1", offerVersion: "v1", canonicalOfferProof: { offerId: `legacy-${index}:spread:home`, eventId: `legacy-${index}`, offerVersion: "v1", canonicalBook: "DraftKings", market: "spread", selection: "home", odds: -110, line: -3 }, market: "spread", selection: "home", originalLine: -3, adjustedLine: 3, originalOdds: -110, eventStartsAt: "2099-01-01T00:00:00.000Z", homeTeam: "Home", awayTeam: "Away" });
    const legs = Array.from({ length: 7 }, (_, index) => teaserLeg(index));
    const semanticLegs = legs.map((leg) => ({ eventId: leg.eventId, canonicalBook: leg.canonicalBook, market: leg.market, selection: leg.selection, offerId: leg.canonicalOfferProof.offerId, offerVersion: leg.offerVersion }));
    const quoteBody = { quoteKey: "legacy-seven-quote", commandId: "legacy-seven-quote", wagerId: "legacy-seven", seasonId: "s1", riskMicros: "1000000", teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs: semanticLegs };
    const fingerprint = JSON.stringify({ wagerId: quoteBody.wagerId, seasonId: quoteBody.seasonId, riskMicros: quoteBody.riskMicros, teaserPoints: quoteBody.teaserPoints, rulesetVersion: quoteBody.rulesetVersion, legs: quoteBody.legs, actorId: "member" });
    const snapshot = { quoteKey: quoteBody.quoteKey, seasonId: "s1", ownerMemberId: "member", riskMicros: "1000000", acceptedOdds: 700, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs, commandVersion: "5" };
    const placementBody = { wagerId: "legacy-seven", quoteKey: quoteBody.quoteKey, quotedCommandVersion: "5", mutationKey: "legacy-seven-place", commandId: "legacy-seven-place", seasonId: "s1", riskMicros: "1000000", acceptedOdds: 700, teaserPoints: 6, rulesetVersion: "SHARE_POOL_2026_V1", legs };
    const placementCommand = { type: "PlaceTeaserWager", commandId: placementBody.commandId, actorId: "member", wagerId: placementBody.wagerId, quoteKey: placementBody.quoteKey, quotedCommandVersion: placementBody.quotedCommandVersion, seasonId: placementBody.seasonId, riskMicros: placementBody.riskMicros, acceptedOdds: placementBody.acceptedOdds, teaserPoints: placementBody.teaserPoints, rulesetVersion: placementBody.rulesetVersion, legs: placementBody.legs };
    const placementResponse = { wagerId: "legacy-seven", commandVersion: "6" };
    await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)), (_instance, state) => {
      state.storage.sql.exec("INSERT INTO wager_quote (actor_id,quote_key,fingerprint,wager_id,kind,terms_json,command_version,snapshot_json,created_at) VALUES ('member',?,?,?,?,?,?,?,'2026-01-01T00:00:00.000Z')", quoteBody.quoteKey, fingerprint, quoteBody.wagerId, "teaser", "{}", "5", JSON.stringify(snapshot));
      state.storage.sql.exec("INSERT INTO processed_command (id,type,actor_id,request_json,response_json,expires_at) VALUES (?,?,?,?,?,'2099-01-01T00:00:00.000Z')", placementBody.commandId, "PlaceTeaserWager", "member", JSON.stringify(poolCommandSchema.parse(placementCommand)), JSON.stringify(placementResponse));
    });
    await bindings.DB.exec("DELETE FROM odds_ingestion; DELETE FROM market_offer; DELETE FROM sports_event;");
    const replayCommands: string[] = [];
    const replayPools = {
      idFromName: (name: string) => bindings.POOL_DO.idFromName(name),
      get: (id: DurableObjectId) => {
        const stub = bindings.POOL_DO.get(id);
        return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.body) replayCommands.push((JSON.parse(String(init.body)) as { type: string }).type);
          return stub.fetch(input, init);
        } };
      }
    } as unknown as DurableObjectNamespace;
    const replayDb = {
      prepare: bindings.DB.prepare.bind(bindings.DB),
      batch: async () => { throw new Error("MUTABLE_OFFER_QUERY_ATTEMPTED"); }
    } as unknown as D1Database;
    const app = createWorkerApp({ db: replayDb, pools: replayPools, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    expect(await (await app.fetch(request(`/api/p/${slug}/wagers/teasers/quote`, quoteBody))).text()).toBe(JSON.stringify(snapshot));
    expect(await (await app.fetch(request(`/api/p/${slug}/wagers/teasers/place`, placementBody))).text()).toBe(JSON.stringify(placementResponse));
    expect(replayCommands).toEqual(["ReplayWagerQuote", "ProbePlacementReplay"]);
    const durableSnapshot = () => runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)), (_instance, state) => JSON.stringify({ quote: [...state.storage.sql.exec("SELECT * FROM wager_quote ORDER BY rowid")], commands: [...state.storage.sql.exec("SELECT * FROM processed_command ORDER BY rowid")], wagers: [...state.storage.sql.exec("SELECT * FROM wager ORDER BY rowid")], ledger: [...state.storage.sql.exec("SELECT * FROM ledger_entry ORDER BY rowid")], accounts: [...state.storage.sql.exec("SELECT * FROM share_account ORDER BY rowid")] }));
    const before = await durableSnapshot();
    expect((await app.fetch(request(`/api/p/${slug}/wagers/teasers/quote`, { ...quoteBody, quoteKey: "fresh-seven", commandId: "fresh-seven" }))).status).toBe(400);
    expect((await app.fetch(request(`/api/p/${slug}/wagers/teasers/place`, { ...placementBody, quoteKey: "fresh-seven", commandId: "fresh-seven-place", mutationKey: "fresh-seven-place" }))).status).toBe(400);
    expect(await durableSnapshot()).toBe(before);
  }, 90_000);

  it("rejects six safe moneyline legs whose combined parlay odds overflow without durable mutation", async () => {
    const poolId = `overflow-${crypto.randomUUID()}`; const slug = `overflow-${crypto.randomUUID()}`;
    await setupPool(poolId, slug);
    const retrievedAt = new Date().toISOString(); const startsAt = "2099-09-10T20:00:00.000Z";
    for (let index = 0; index < 6; index++) {
      const eventId = `overflow-${index}`;
      await bindings.DB.prepare("INSERT INTO sports_event (id,provider_event_id,league,home_team,away_team,starts_at,status,correction_version) VALUES (?,?, 'nfl','Home','Away',?,'scheduled','1')").bind(eventId, eventId, startsAt).run();
      await bindings.DB.prepare("INSERT INTO market_offer (event_id,market,canonical_book,retrieved_at,offer_version,payload_json) VALUES (?,'moneyline','DraftKings',?,'v1',?)").bind(eventId, retrievedAt, JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: Number.MAX_SAFE_INTEGER }, { name: "Away", price: -100 }] })).run();
    }
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const body = { quoteKey: "overflow-quote", commandId: "overflow-quote", wagerId: "overflow-wager", seasonId: "s1", riskMicros: "1000000", rulesetVersion: "PARLAY_2026_V1", legs: Array.from({ length: 6 }, (_, index) => ({ eventId: `overflow-${index}`, canonicalBook: "DraftKings", market: "moneyline", selection: "home", offerId: `overflow-${index}:moneyline:home`, offerVersion: "v1" })) };
    const before = await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)), (_instance, state) => JSON.stringify({ quote: [...state.storage.sql.exec("SELECT * FROM wager_quote")], command: [...state.storage.sql.exec("SELECT * FROM processed_command")], wager: [...state.storage.sql.exec("SELECT * FROM wager")], account: [...state.storage.sql.exec("SELECT * FROM share_account ORDER BY rowid")], ledger: [...state.storage.sql.exec("SELECT * FROM ledger_entry ORDER BY rowid")] }));
    const response = await app.fetch(request(`/api/p/${slug}/wagers/parlays/quote`, body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "PARLAY_ODDS_OUT_OF_RANGE" });
    const after = await runInDurableObject(bindings.POOL_DO.get(bindings.POOL_DO.idFromName(poolId)), (_instance, state) => JSON.stringify({ quote: [...state.storage.sql.exec("SELECT * FROM wager_quote")], command: [...state.storage.sql.exec("SELECT * FROM processed_command")], wager: [...state.storage.sql.exec("SELECT * FROM wager")], account: [...state.storage.sql.exec("SELECT * FROM share_account ORDER BY rowid")], ledger: [...state.storage.sql.exec("SELECT * FROM ledger_entry ORDER BY rowid")] }));
    expect(after).toBe(before);
  }, 90_000);

  it("replays an exact quote-first placement before later D1 locking", async () => {
    const poolId = `api-replay-${crypto.randomUUID()}`; const slug = "api-replay";
    await setupPool(poolId, slug);
    const orderQuote = await (await send(poolId, { type: "QuoteShareOrder", commandId: "fund-replay-quote", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000" })).json() as { priceMicros: string; commandVersion: string };
    await send(poolId, { type: "ExecuteShareOrder", commandId: "fund-replay", actorId: "owner", seasonId: "s1", memberId: "member", mode: "shares", amountMicros: "1000000", quote: orderQuote, reason: "replay" });
    const startsAt = "2099-09-10T20:00:00.000Z"; const retrievedAt = new Date().toISOString();
    await bindings.DB.prepare("INSERT INTO sports_event (id, provider_event_id, league, home_team, away_team, starts_at, status, correction_version) VALUES ('replay', 'replay', 'nfl', 'Home', 'Away', ?, 'scheduled', '1')").bind(startsAt).run();
    await bindings.DB.prepare("INSERT INTO market_offer (event_id, market, canonical_book, retrieved_at, offer_version, payload_json) VALUES ('replay', 'spread', 'DraftKings', ?, 'v1', ?)").bind(retrievedAt, JSON.stringify({ policyVersion: "CANONICAL_BOOKS_2026_V1", outcomes: [{ name: "Home", price: -110, point: -3 }, { name: "Away", price: -110, point: 3 }] })).run();
    const app = createWorkerApp({ db: bindings.DB, pools: bindings.POOL_DO, commandAuthenticatorKey: bindings.POOL_COMMAND_AUTHENTICATOR_KEY, currentUser: async () => ({ id: "member", name: "Member" }) });
    const input = { wagerId: "replay", seasonId: "s1", riskMicros: "1000000", rulesetVersion: "SHARE_POOL_2026_V1", leg: { eventId: "replay", canonicalBook: "DraftKings", market: "spread", selection: "home", offerVersion: "v1", canonicalOfferProof: { offerId: "replay:spread:home" } } };
    const fixture = await quoteAndPlace(app, slug, "straight", input, "replay-mutation");
    const first = await fixture.place(); expect(first.status).toBe(200); const body = await first.json();
    await bindings.DB.prepare("UPDATE sports_event SET status = 'final' WHERE id = 'replay'").run();
    expect(await (await fixture.place()).json()).toEqual(body);
  }, 90_000);
});

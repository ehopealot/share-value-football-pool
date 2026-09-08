import { describe, expect, it } from "vitest";
import { hasSentryDsn, withOptionalSentry } from "../../src/observability/sentry-server";

type TestEnv = { SENTRY_DSN?: string; SENTRY_TEST_TRANSPORT?: import("@sentry/cloudflare").CloudflareOptions["transport"] };

const request = new Request("https://pool.example.test/health/app") as unknown as Request<unknown, IncomingRequestCfProperties<unknown>>;
const context = { waitUntil: () => undefined } as unknown as ExecutionContext;

describe("optional Sentry Worker lifecycle", () => {
  it.each([undefined, "", "   ", "not-a-sentry-dsn"])("bypasses SDK for absent or malformed DSN %#", async (SENTRY_DSN) => {
    let calls = 0;
    const raw: ExportedHandler<TestEnv> = {
      async fetch() { calls++; return new Response("raw"); }
    };

    expect(hasSentryDsn({ SENTRY_DSN })).toBe(false);
    const response = await withOptionalSentry(raw).fetch!(request, { SENTRY_DSN }, context);
    expect(await response.text()).toBe("raw");
    expect(calls).toBe(1);
  });

  it("falls back before business execution when enabled SDK option setup throws", async () => {
    let calls = 0;
    const raw: ExportedHandler<TestEnv> = { async fetch() { calls++; return new Response("raw"); } };
    const response = await withOptionalSentry(raw).fetch!(request, { SENTRY_DSN: "https://public@sentry.invalid/1", SENTRY_TEST_TRANSPORT: () => { throw new Error("init transport failure"); } }, context);
    expect(await response.text()).toBe("raw");
    expect(calls).toBe(1);
  });

  it("awaits asynchronous scheduled initialization fallback exactly once", async () => {
    let calls = 0;
    const raw: ExportedHandler<TestEnv> = { scheduled() { calls++; } };
    const result = withOptionalSentry(raw).scheduled!({ scheduledTime: Date.now(), cron: "* * * * *", noRetry() {} } as ScheduledEvent, { SENTRY_DSN: "https://public@sentry.invalid/1", SENTRY_TEST_TRANSPORT: () => { throw new Error("init transport failure"); } }, context) as unknown as Promise<void>;
    await result;
    expect(calls).toBe(1);
  });

  it("preserves an asynchronous scheduled business error when SDK transport rejects", async () => {
    const business = new Error("scheduled business failure");
    const raw: ExportedHandler<TestEnv> = { scheduled: async () => { throw business; } };
    const result = withOptionalSentry(raw).scheduled!({ scheduledTime: Date.now(), cron: "* * * * *", noRetry() {} } as ScheduledEvent, { SENTRY_DSN: "https://public@sentry.invalid/1", SENTRY_TEST_TRANSPORT: () => ({ send: async () => { throw new Error("capture failure"); }, flush: async () => true }) }, context) as unknown as Promise<void>;
    await expect(result).rejects.toBe(business);
  });

  it("preserves an asynchronous queue business error when SDK transport rejects", async () => {
    const business = new Error("queue business failure");
    const raw: ExportedHandler<TestEnv, unknown> = { queue: async () => { throw business; } };
    const batch = { messages: [] } as unknown as MessageBatch<unknown>;
    const result = withOptionalSentry(raw).queue!(batch, { SENTRY_DSN: "https://public@sentry.invalid/1", SENTRY_TEST_TRANSPORT: () => ({ send: async () => { throw new Error("capture failure"); }, flush: async () => true }) }, context) as unknown as Promise<void>;
    await expect(result).rejects.toBe(business);
  });

  it("passes original binding headers without sentry trace propagation", async () => {
    let headers: Headers | undefined;
    type BindingEnv = TestEnv & { SERVICE: Fetcher };
    const raw: ExportedHandler<BindingEnv> = { async fetch(_request, env) { return env.SERVICE.fetch(new Request("https://service.internal/check")); } };
    const service = { fetch: async (request: Request) => { headers = request.headers; return new Response("ok"); } } as Fetcher;
    const response = await withOptionalSentry(raw).fetch!(request, { SENTRY_DSN: "https://public@sentry.invalid/1", SENTRY_TEST_TRANSPORT: () => ({ send: async () => ({}), flush: async () => true }), SERVICE: service }, context);
    expect(await response.text()).toBe("ok");
    expect(headers?.has("sentry-trace")).toBe(false);
    expect(headers?.has("baggage")).toBe(false);
  });
});

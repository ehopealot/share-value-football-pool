import { describe, expect, it, vi } from "vitest";
import { createSentryReporter, hasSentryDsn, withOptionalSentry } from "../../src/observability/sentry-server";

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

  it("uses the production transport to defer flushing and cancel the response body", async () => {
    let releaseFetch!: () => void;
    let markRequested!: () => void;
    const requested = new Promise<void>((resolve) => { markRequested = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    let bodyCancellations = 0;
    let requestSignal: AbortSignal | null | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestSignal = init?.signal;
      markRequested();
      await gate;
      const body = new ReadableStream({ cancel() { bodyCancellations++; } });
      return new Response(body, { status: 200 });
    });
    try {
      const flushes: Promise<unknown>[] = [];
      const deferred: Promise<unknown>[] = [];
      const reporter = createSentryReporter({ SENTRY_DSN: "https://public@sentry.invalid/1", SENTRY_TEST_FLUSHES: flushes }, (promise) => deferred.push(promise));

      expect(reporter("pool-command-unexpected", "durable-object")).toBeUndefined();
      expect(flushes).toHaveLength(1);
      expect(deferred).toEqual(flushes);
      await requested;
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(requestSignal).toBeInstanceOf(AbortSignal);
      expect(requestSignal?.aborted).toBe(false);
      let completed = false;
      deferred[0].then(() => { completed = true; });
      await Promise.resolve();
      expect(completed).toBe(false);

      releaseFetch();
      await Promise.all(deferred);
      expect(completed).toBe(true);
      expect(bodyCancellations).toBe(1);
    } finally {
      releaseFetch();
      fetchSpy.mockRestore();
    }
  });

  it("aborts a stalled production transport request without awaiting it on the reporting path", async () => {
    let requestSignal: AbortSignal | null | undefined;
    let markAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => { markAborted(); reject(requestSignal?.reason); };
        if (requestSignal?.aborted) onAbort();
        else requestSignal?.addEventListener("abort", onAbort, { once: true });
      });
    });
    try {
      const deferred: Promise<unknown>[] = [];
      const reporter = createSentryReporter({ SENTRY_DSN: "https://public@sentry.invalid/1" }, (promise) => deferred.push(promise));
      expect(reporter("pool-command-unexpected", "durable-object")).toBeUndefined();
      expect(deferred).toHaveLength(1);
      await aborted;
      await Promise.all(deferred);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(requestSignal?.aborted).toBe(true);
      expect(requestSignal?.reason.name).toBe("TimeoutError");
    } finally {
      fetchSpy.mockRestore();
    }
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

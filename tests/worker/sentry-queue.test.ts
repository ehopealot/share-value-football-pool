import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createProductionWorker, type Env } from "../../src/index";

const bindings = env as unknown as { DB: D1Database; POOL_DO: DurableObjectNamespace };

describe("enabled Queue reporting", () => {
  it("retries malformed message and captures once without body data", async () => {
    const envelopes: unknown[] = [];
    let retried: QueueRetryOptions | undefined;
    const pending: Promise<unknown>[] = [];
    const worker = createProductionWorker();
    const batch = { messages: [{ id: "queue-id", timestamp: Date.now(), attempts: 1, body: { secret: "queue-body-secret" }, ack() {}, retry(options?: QueueRetryOptions) { retried = options; } }] } as unknown as Parameters<NonNullable<typeof worker.queue>>[0];
    const runtime = { ...bindings, SENTRY_DSN: "https://public@sentry.invalid/1", SENTRY_TEST_TRANSPORT: () => ({ send: async (envelope: unknown) => { envelopes.push(envelope); return {}; }, flush: async () => true }) } as unknown as Env;
    worker.queue!(batch, runtime, { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext);
    await Promise.all(pending);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(retried).toEqual({ delaySeconds: 30 });
    expect(envelopes).toHaveLength(1);
    expect(JSON.stringify(envelopes)).not.toContain("queue-body-secret");
  });
});

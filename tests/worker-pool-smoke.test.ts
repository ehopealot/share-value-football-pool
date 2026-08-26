import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const bindings = env as unknown as { POOL_DO: DurableObjectNamespace };

describe("Workers test pool", () => {
  it("provides the configured SQLite Durable Object binding", () => {
    expect(bindings.POOL_DO).toBeDefined();
    expect(bindings.POOL_DO.idFromName("pool-smoke")).toBeDefined();
  });
});

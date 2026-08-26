import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const bindings = env as unknown as { POOL_DO: DurableObjectNamespace };

describe("Durable Object Workers-pool routing", () => {
  it("provides cloudflare:test and the configured PoolDO binding", async () => {
    const id = bindings.POOL_DO.idFromName("durable-routing");
    const response = await bindings.POOL_DO.get(id).fetch("https://pool.test/");

    expect(bindings.POOL_DO).toBeDefined();
    expect(response.status).toBe(404);
  });
});

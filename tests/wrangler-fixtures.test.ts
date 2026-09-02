import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8")) as Record<string, any>;

/**
 * The vitest Worker fixture intentionally diverges from the e2e/production-shaped
 * fixture (tests/fixtures/wrangler.test.jsonc) in exactly four ways: a slim main,
 * the two test-only compile-time defines, and no queue consumers or cron
 * triggers. Everything the PoolDO runtime depends on must stay identical, or
 * worker tests would exercise a different runtime than production.
 */
describe("wrangler fixture parity", () => {
  const e2e = read("tests/fixtures/wrangler.test.jsonc");
  const vitest = read("tests/fixtures/wrangler.vitest.jsonc");

  it("keeps every PoolDO-runtime field identical between the fixtures", () => {
    for (const key of ["compatibility_date", "compatibility_flags", "durable_objects", "migrations", "d1_databases", "r2_buckets", "assets"]) {
      expect(vitest[key], key).toEqual(e2e[key]);
    }
    expect(vitest.queues?.producers).toEqual(e2e.queues?.producers);
  });

  it("diverges only in the documented, test-only ways", () => {
    expect(vitest.main).toBe("./main-vitest.ts");
    expect(e2e.main).toBe("../../src/index.ts");
    expect(vitest.define).toMatchObject({ "globalThis.POOL_PASSWORD_SCRYPT_LOG_N": "10", "globalThis.POOL_OUTBOX_DRAIN_GRACE_MS": "3600000" });
    expect(e2e.define).toBeUndefined();
    expect(vitest.queues?.consumers).toBeUndefined();
    expect(e2e.queues?.consumers).toBeDefined();
    expect(vitest.triggers).toBeUndefined();
    expect(e2e.triggers).toBeDefined();
  });
});

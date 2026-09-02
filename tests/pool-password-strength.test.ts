import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hashPoolPassword, verifyPoolPassword } from "../src/security/pool-password";

const root = resolve(import.meta.dirname, "..");

/**
 * Pins the production scrypt work factor. Worker integration tests compile the
 * PoolDO with a cheaper log2N (see tests/fixtures/wrangler.vitest.jsonc) for
 * speed, so nothing else in the suite would notice if the production default
 * weakened or a deployment config picked the override up.
 */
describe("pool password production strength", () => {
  it("hashes with the production scrypt parameters N=2^15", () => {
    const salt = new Uint8Array(16).fill(7);
    expect(hashPoolPassword("correct-password", salt)).toBe(
      `scrypt-v1$07070707070707070707070707070707$e6a22cec93a8f3169b523d98123be280e478de1617936f85c3c1369020d15361`
    );
  });

  it("verifies a stored production hash and rejects a wrong password", () => {
    const encoded = hashPoolPassword("correct-password", new Uint8Array(16).fill(7));
    expect(verifyPoolPassword("correct-password", encoded)).toBe(true);
    expect(verifyPoolPassword("wrong-password", encoded)).toBe(false);
    expect(verifyPoolPassword("correct-password", "scrypt-v2$deadbeef$cafebabe")).toBe(false);
  });

  it("keeps the scrypt override out of every production-facing wrangler config", () => {
    for (const configPath of ["wrangler.jsonc", "wrangler.local.jsonc", "tests/fixtures/wrangler.test.jsonc"]) {
      expect(readFileSync(resolve(root, configPath), "utf8"), configPath).not.toContain("POOL_PASSWORD_SCRYPT_LOG_N");
      expect(readFileSync(resolve(root, configPath), "utf8"), configPath).not.toContain("POOL_OUTBOX_DRAIN_GRACE_MS");
    }
  });

  it("keeps the vitest Worker on the intended test-only defines", () => {
    const vitestConfig = JSON.parse(readFileSync(resolve(root, "tests/fixtures/wrangler.vitest.jsonc"), "utf8")) as { define?: Record<string, string> };
    expect(vitestConfig.define).toMatchObject({ "globalThis.POOL_PASSWORD_SCRYPT_LOG_N": "10", "globalThis.POOL_OUTBOX_DRAIN_GRACE_MS": "3600000" });
  });
});

import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const workers = { wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { POOL_COMMAND_AUTHENTICATOR_KEY: "test-only-command-authenticator-key", SETTLEMENT_SERVICE_TOKEN: "test-only-settlement-token", POOL_PROJECTION_SERVICE_TOKEN: "test-only-projection-token", POOL_BACKUP_SERVICE_TOKEN: "test-only-backup-token" } } };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/worker-pool-smoke.test.ts", "tests/durable/**/*.test.ts", "tests/odds/**/*.test.ts", "tests/auth/better-auth.test.ts", "tests/worker/registry.test.ts", "tests/worker/create-pool-saga.integration.test.ts", "tests/worker/security.test.ts", "tests/worker/queue-health.test.ts", "tests/worker/exports.test.ts", "tests/worker/api.test.ts", "tests/worker/deterministic-reader-snapshot.test.ts", "tests/worker/t11-admin-api.test.ts", "tests/worker/entry-read.test.ts", "tests/durable/wagers-settlement.test.ts", "tests/durable/privacy-outbox.test.ts"],
          setupFiles: ["tests/setup.ts"]
        }
      },
      {
        plugins: [cloudflareTest(workers)],
        test: {
          name: "workers",
          include: ["tests/worker-pool-smoke.test.ts", "tests/durable/**/*.test.ts", "tests/odds/**/*.test.ts", "tests/auth/better-auth.test.ts", "tests/worker/registry.test.ts", "tests/worker/create-pool-saga.integration.test.ts", "tests/worker/security.test.ts", "tests/worker/queue-health.test.ts", "tests/worker/exports.test.ts", "tests/worker/api.test.ts", "tests/worker/deterministic-reader-snapshot.test.ts", "tests/worker/t11-admin-api.test.ts", "tests/worker/entry-read.test.ts", "tests/durable/wagers-settlement.test.ts", "tests/durable/privacy-outbox.test.ts"],
          pool: cloudflarePool(workers),
          setupFiles: ["tests/setup.ts"]
        }
      }
    ]
  }
});

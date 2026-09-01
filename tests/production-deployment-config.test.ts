import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type ProductionConfig = {
  compatibility_date: string;
  workers_dev?: boolean;
  routes?: Array<{ pattern: string; custom_domain: boolean }>;
  observability?: { enabled: boolean; logs?: { invocation_logs?: boolean } };
  d1_databases?: Array<{ binding: string; database_name: string; database_id: string }>;
};

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8")) as ProductionConfig;

describe("production deployment configuration", () => {
  it("owns only the canonical apex and does not retain auth-token URLs in invocation logs", () => {
    expect(config.workers_dev).toBe(false);
    expect(config.routes).toEqual([{ pattern: "officepool.football", custom_domain: true }]);
    expect(config.observability).toEqual({ enabled: true, logs: { invocation_logs: false } });
  });

  it("pins the newest runtime date supported by the repository test and deploy runtimes and a provisioned production D1 database", () => {
    expect(config.compatibility_date).toBe("2026-08-22");
    expect(config.d1_databases).toContainEqual(expect.objectContaining({
      binding: "DB",
      database_name: "office-pool-reborn"
    }));
    expect(config.d1_databases?.find((database) => database.binding === "DB")?.database_id).not.toBe("local-development-database");
  });
});

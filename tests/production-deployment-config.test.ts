import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type ProductionConfig = {
  compatibility_date: string;
  workers_dev?: boolean;
  routes?: Array<{ pattern: string; custom_domain: boolean }>;
  logpush?: boolean;
  upload_source_maps?: boolean;
  observability?: {
    enabled: boolean;
    head_sampling_rate?: number;
    logs?: { enabled?: boolean; head_sampling_rate?: number; invocation_logs?: boolean; persist?: boolean };
    traces?: { enabled?: boolean; head_sampling_rate?: number; persist?: boolean };
  };
  d1_databases?: Array<{ binding: string; database_name: string; database_id: string }>;
};

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8")) as ProductionConfig;

describe("production deployment configuration", () => {
  it("enables the full native production diagnostic set at 100% sampling", () => {
    expect(config.workers_dev).toBe(false);
    expect(config.routes).toEqual([{ pattern: "officepool.football", custom_domain: true }]);
    expect(config.upload_source_maps).toBe(true);
    expect(config.logpush).toBe(true);
    expect(config.observability).toEqual({
      enabled: true,
      head_sampling_rate: 1,
      logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true, persist: true },
      traces: { enabled: true, head_sampling_rate: 1, persist: true }
    });
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

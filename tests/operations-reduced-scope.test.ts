import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("reduced operational visibility scope", () => {
  it("contains no custom incident, notification, scheduling-repair, or leased sweep implementation", () => {
    expect(existsSync(resolve(root, "src/worker/operations-incidents.ts"))).toBe(false);
    expect(existsSync(resolve(root, "src/worker/operations-cron.ts"))).toBe(false);
    const migration = source("src/db/migrations/0003_operations.sql");
    expect(migration).toContain("ops_job_status");
    expect(migration).not.toMatch(/incident|notification|repair|lease|cursor/i);
    expect(source("src/worker/ops-routes.ts")).not.toMatch(/app\.(post|put|patch|delete)\(/);
  });

  it("wires local visibility to fixture/local resources without operational mail", () => {
    const local = source("src/index.local.ts");
    expect(local).toContain("opsOperatorUserIds: env.OPS_OPERATOR_USER_IDS");
    expect(local).toContain("recordJobStatus");
    expect(local).toContain("oddsConfigured: false");
    expect(local).not.toContain("oddsConfigured: true");
    expect(local).not.toMatch(/ResendOperational|OPS_ALERT|repair-scheduling/);
  });
});

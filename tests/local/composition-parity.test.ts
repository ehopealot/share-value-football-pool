import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { probeProductionRoutes } from "../../scripts/production-route-probe";

const root = resolve(import.meta.dirname, "../..");

describe("production/local composition", () => {
  it("probes GET, POST, and OPTIONS against the live generated production Worker", () => {
    expect(() => execFileSync("npm", ["run", "verify:production-route-probe"], { cwd: root, stdio: "pipe", timeout: 60_000 })).not.toThrow();
  }, 60_000);

  it("rejects forbidden production tokens and identical normalized artifact graphs", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "composition-artifacts-"));
    const production = join(artifacts, "production"); const local = join(artifacts, "local");
    try {
      await mkdir(production); await mkdir(local);
      await writeFile(join(production, "wrangler.json"), "{}"); await writeFile(join(production, "worker.js"), "const ok = true;");
      await writeFile(join(local, "wrangler.json"), "{}"); await writeFile(join(local, "worker.js"), "const ok = true;");
      const run = () => execFileSync(process.execPath, ["scripts/verify-production-artifact.mjs"], { cwd: root, env: { ...process.env, PRODUCTION_ARTIFACT_DIR: production, LOCAL_ARTIFACT_DIR: local }, stdio: "pipe" });
      expect(run).toThrow(/identical/);
      await writeFile(join(local, "worker.js"), "const local = true;"); await writeFile(join(production, "worker.js"), "const forbidden = 'DevelopmentMailbox';");
      expect(run).toThrow(/forbidden/);
    } finally { await rm(artifacts, { recursive: true, force: true }); }
  });

  it("preserves injected readiness and route failures after attempting probe cleanup diagnostics", async () => {
    for (const primary of [new Error("readiness primary"), new Error("route primary")]) {
      let stops = 0; let removals = 0;
      const result = probeProductionRoutes({
        spawn: (() => ({ pid: 12345 })) as never,
        ready: primary.message === "readiness primary" ? async () => { throw primary; } : async () => {},
        fetch: primary.message === "route primary" ? (async () => { throw primary; }) as typeof fetch : undefined,
        stop: async () => { stops++; throw new Error("stop failed"); },
        remove: async () => { removals++; throw new Error("removal failed"); },
      });
      await expect(result).rejects.toBe(primary);
      expect(stops).toBe(1); expect(removals).toBe(1);
      expect((primary as Error & { cleanupDiagnostics?: Error }).cleanupDiagnostics?.message).toContain("stop failed");
      expect((primary as Error & { cleanupDiagnostics?: Error }).cleanupDiagnostics?.message).toContain("removal failed");
    }
    await Promise.all((await readdir(tmpdir())).filter((entry) => entry.startsWith("share-value-pool-owned-production-probe-")).map((entry) => rm(join(tmpdir(), entry), { recursive: true, force: true })));
  });

  it("uses the local Worker barrier only after real commands and proves delay, drop, replay, one-shot, and unarmed delegation", () => {
    expect(() => execFileSync("npm", ["run", "test:local-response-barrier"], { cwd: root, stdio: "pipe", timeout: 120_000 })).not.toThrow();
  }, 120_000);
});

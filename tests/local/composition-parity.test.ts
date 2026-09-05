import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runOwnedProcess } from "../../scripts/owned-process";
import { probeProductionRoutes } from "../../scripts/production-route-probe";

const root = resolve(import.meta.dirname, "../..");
const CLEANUP_ALLOWANCE_MS = 15_000;

describe("production/local composition", () => {
  it("probes GET, POST, and OPTIONS against the live generated production Worker", async () => {
    await expect(runOwnedProcess("npm", ["run", "verify:production-route-probe"], 60_000, "ignore")).resolves.toBeUndefined();
  }, 60_000 + CLEANUP_ALLOWANCE_MS);

  it("passes isolated test-only auth and Resend bindings to the generated production Worker", async () => {
    let workerArgs: string[] = [];
    let workerOptions: { env?: NodeJS.ProcessEnv } | undefined;
    await probeProductionRoutes({
      spawn: ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => { workerArgs = args; workerOptions = options; return { pid: 12345 }; }) as never,
      preflight: async () => {},
      ready: async () => {},
      fetch: async () => new Response(null, { status: 404 }),
      stop: async () => {}
    });

    const bindings = [
      "BETTER_AUTH_SECRET:production-probe-auth-secret-with-32-characters",
      "RESEND_API_KEY:production-probe-resend-key"
    ];
    expect(workerArgs.filter((argument) => argument === "--var")).toHaveLength(bindings.length);
    for (const binding of bindings) {
      const positions = workerArgs.flatMap((argument, index) => argument === binding ? [index] : []);
      expect(positions, binding).toHaveLength(1);
      expect(workerArgs[positions[0]! - 1], binding).toBe("--var");
    }
    expect(workerArgs.filter((argument) => argument === "--env-file")).toHaveLength(1);
    expect(workerArgs[workerArgs.indexOf("--env-file") + 1]).toBe("/dev/null");
    expect(workerOptions?.env?.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV).toBe("false");
  });

  it("rejects an occupied production-probe port before spawning a Worker", async () => {
    let spawns = 0;
    await expect(probeProductionRoutes({
      spawn: (() => { spawns++; return { pid: 12345 }; }) as never,
      fetch: async () => new Response("already serving", { status: 200 })
    })).rejects.toThrow(/already serving/);
    expect(spawns).toBe(0);
  });

  it("treats a preflight timeout as indeterminate without spawning a Worker", async () => {
    let spawns = 0;
    await expect(probeProductionRoutes({
      spawn: (() => { spawns++; return { pid: 12345 }; }) as never,
      fetch: async () => { throw new DOMException("The operation timed out", "TimeoutError"); }
    })).rejects.toThrow(/availability could not be confirmed/);
    expect(spawns).toBe(0);
  });

  it("rejects an owned Worker that exits during readiness", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null });
    await expect(probeProductionRoutes({
      spawn: (() => child) as never,
      preflight: async () => {},
      ready: async (_baseURL, _fetch, assertChildLive) => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
        assertChildLive?.();
      },
      stop: async () => {}
    })).rejects.toThrow(/exited 1/);
  });

  it("rejects forbidden production tokens and identical normalized artifact graphs", async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "composition-artifacts-"));
    const production = join(artifacts, "production"); const local = join(artifacts, "local"); const client = join(artifacts, "client");
    try {
      await mkdir(production); await mkdir(local); await mkdir(client);
      await writeFile(join(production, "wrangler.json"), '{"assets":{"directory":"../client"}}'); await writeFile(join(production, "worker.js"), "const ok = true;"); await writeFile(join(client, "index.html"), '<meta name="turnstile-site-key" content="test-public-site-key">');
      await writeFile(join(local, "wrangler.json"), '{"assets":{"directory":"../client"}}'); await writeFile(join(local, "worker.js"), "const ok = true;");
      const run = () => execFileSync(process.execPath, ["scripts/verify-production-artifact.mjs"], { cwd: root, env: { ...process.env, PRODUCTION_ARTIFACT_DIR: production, LOCAL_ARTIFACT_DIR: local }, stdio: "pipe" });
      expect(run).toThrow(/identical/);
      await writeFile(join(local, "worker.js"), "const local = true;"); await writeFile(join(production, "worker.js"), "const forbidden = 'DevelopmentMailbox';");
      expect(run).toThrow(/forbidden/);
      await writeFile(join(production, "worker.js"), "const production = true;"); await writeFile(join(production, ".dev.vars"), "safe-fixture-value");
      expect(run).toThrow(/\.dev\.vars/);
      await rm(join(production, ".dev.vars")); await writeFile(join(client, "index.html"), '<meta name="turnstile-site-key" content="%VITE_TURNSTILE_SITE_KEY%">');
      expect(run).toThrow(/VITE_TURNSTILE_SITE_KEY/);
    } finally { await rm(artifacts, { recursive: true, force: true }); }
  });

  it("preserves injected readiness and route failures after attempting probe cleanup diagnostics", async () => {
    for (const primary of [new Error("readiness primary"), new Error("route primary")]) {
      let stops = 0; let removals = 0; let failedRemovalPath: string | undefined;
      try {
        const result = probeProductionRoutes({
          spawn: (() => ({ pid: 12345 })) as never,
          preflight: async () => {},
          ready: primary.message === "readiness primary" ? async () => { throw primary; } : async () => {},
          fetch: primary.message === "route primary" ? (async () => { throw primary; }) as typeof fetch : undefined,
          stop: async () => { stops++; throw new Error("stop failed"); },
          remove: async (path) => { removals++; failedRemovalPath = path; throw new Error("removal failed"); },
        });
        await expect(result).rejects.toBe(primary);
        expect(stops).toBe(1); expect(removals).toBe(1);
        expect((primary as Error & { cleanupDiagnostics?: Error }).cleanupDiagnostics?.message).toContain("stop failed");
        expect((primary as Error & { cleanupDiagnostics?: Error }).cleanupDiagnostics?.message).toContain("removal failed");
      } finally {
        if (failedRemovalPath) await rm(failedRemovalPath, { recursive: true, force: true });
      }
    }
  });

  it("uses the local Worker barrier only after real commands and proves delay, drop, replay, one-shot, and unarmed delegation", async () => {
    await expect(runOwnedProcess("npm", ["run", "test:local-response-barrier"], 120_000, "ignore")).resolves.toBeUndefined();
  }, 120_000 + CLEANUP_ALLOWANCE_MS);
});

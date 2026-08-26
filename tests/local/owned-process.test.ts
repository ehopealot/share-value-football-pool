import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { cleanupOwnedResources, installOwnedSignalCleanup, runOwnedProcess, stopOwnedProcess, waitForProcessGroupExit } from "../../scripts/owned-process";

const root = resolve(import.meta.dirname, "../..");
const OWNER_TIMEOUT_MS = 90_000;
const deadline = async <T>(label: string, operation: Promise<T>, timeoutMs = OWNER_TIMEOUT_MS): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
};
const waitFor = async (path: string, timeoutMs = OWNER_TIMEOUT_MS) => deadline(`wait for ${path}`, (async () => {
  while (true) { try { await access(path); return; } catch { await delay(10); } }
})(), timeoutMs);
type ControlRecord = { state: string; pid: number; pgid: number; persistence: string };
const controlRecord = async (directory: string, id: string, state: string, timeoutMs = OWNER_TIMEOUT_MS) => deadline(`${id} ${state}`, (async () => {
  const path = state === "RESOURCE_CREATED" ? join(directory, `${id}.resource.json`) : join(directory, `${id}.json`);
  while (true) {
    try { const record = JSON.parse(await readFile(path, "utf8")) as ControlRecord; if (record.state === state) return record; } catch { /* owner is starting */ }
    await delay(10);
  }
})(), timeoutMs);
const waitForExit = (child: ChildProcess, label: string) => deadline(label, new Promise<number | null>((resolveExit) => {
  if (child.exitCode !== null || child.signalCode !== null) resolveExit(child.exitCode);
  else child.once("exit", resolveExit);
}));
const absent = (path: string, label: string) => deadline(label, (async () => {
  while (true) { try { await access(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } await delay(10); }
})());
const groupIsLive = (pgid: number) => {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
};

const owners = [
  ["fixture", "e2e/fixtures/local-worker.ts", { OWNED_PROCESS_FIXTURE_HARNESS: "1" }],
  ["smoke", "scripts/local-smoke.ts", {}],
  ["barrier", "scripts/local-response-barrier.ts", {}],
  ["probe", "scripts/production-route-probe.ts", {}],
] as const;

describe("owned local process protocol", () => {
  it("absorbs repeated signals until the single cleanup settles, then exits nonzero", async () => {
    const signals = new EventEmitter(); let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolveGate) => { releaseCleanup = resolveGate; }); let cleanupCalls = 0; const exits: number[] = [];
    const owner = installOwnedSignalCleanup({ cleanup: async () => { cleanupCalls++; await cleanupGate; }, signalSource: signals, exit: (code) => { exits.push(code); } });
    signals.emit("SIGINT"); signals.emit("SIGTERM"); await Promise.resolve();
    expect(cleanupCalls).toBe(1); expect(exits).toEqual([]); expect(signals.listenerCount("SIGINT")).toBe(1); expect(signals.listenerCount("SIGTERM")).toBe(1);
    releaseCleanup(); await owner.settled(); expect(exits).toEqual([1]); expect(signals.listenerCount("SIGINT")).toBe(0); expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("owns prerequisite builds and all real owner cleanup and pre-ready failures within deadlines", async () => {
    const controls = await mkdtemp(join(tmpdir(), "share-value-pool-owner-control-"));
    const tsx = join(resolve(root, "node_modules/tsx"), "dist/cli.mjs");
    const fallbackOwners: ChildProcess[] = [];
    const heldOwners: Array<{ id: string; owner: ChildProcess }> = [];
    const cleanupErrors: unknown[] = [];
    const preReadyFallbackActions: string[] = [];
    let injectedFallbackFailure = false;
    const cleanupFallback = async (id: string, owner: ChildProcess | undefined, record: ControlRecord | undefined, release: boolean, trackPreReadyActions = false) => {
      const attempt = async (action: string, operation: () => Promise<void> | void) => {
        if (trackPreReadyActions) preReadyFallbackActions.push(`${id}:${action}`);
        try { await deadline(`${id} fallback ${action}`, Promise.resolve().then(operation), 10_000); } catch (error) { cleanupErrors.push(new Error(`${id} ${action}: ${String(error)}`)); }
      };
      if (release) await attempt("release", () => writeFile(join(controls, `${id}.release`), ""));
      await attempt("owner TERM/KILL", async () => {
        if (owner?.pid) { try { process.kill(-owner.pid, "SIGTERM"); } catch {} await delay(50); try { process.kill(-owner.pid, "SIGKILL"); } catch {} }
        // The reporting failure is injected only after the real owner-group termination attempt.
        if (trackPreReadyActions && !injectedFallbackFailure) { injectedFallbackFailure = true; throw new Error("injected fallback owner TERM/KILL failure"); }
      });
      await attempt("owner group absence", async () => { if (owner?.pid && !await waitForProcessGroupExit(owner.pid, 30, 50, { cleanupTimeoutMs: 10_000 })) throw new Error("owner group remains"); });
      await attempt("reported child TERM/KILL", async () => { if (record) { try { process.kill(-record.pgid, "SIGTERM"); } catch {} await delay(50); try { process.kill(-record.pgid, "SIGKILL"); } catch {} } });
      await attempt("reported child absence", async () => { if (record && !await waitForProcessGroupExit(record.pgid, 30, 50, { cleanupTimeoutMs: 10_000 })) throw new Error("reported child group remains"); });
      await attempt("tagged persistence removal", async () => { if (record) await rm(record.persistence, { recursive: true, force: true }); });
      await attempt("tagged persistence absence", async () => { if (record) await absent(record.persistence, `${id} fallback persistence absence`); });
    };
    // This outer finally exists before any prerequisite resource is created.
    try {
      for (const args of [["run", "build"], ["run", "build:local"]]) {
        await deadline(`owner prerequisite npm ${args.join(" ")}`, runOwnedProcess("npm", args, OWNER_TIMEOUT_MS, "ignore"), OWNER_TIMEOUT_MS + 5_000);
      }
      for (const [id, entry, extra] of owners) {
        let owner: ChildProcess | undefined;
        let record: ControlRecord | undefined;
        try {
          owner = spawn(process.execPath, [tsx, entry], { cwd: root, detached: true, stdio: "ignore", env: { ...process.env, ...extra, OWNED_PROCESS_CONTROL_DIR: controls, OWNED_PROCESS_CONTROL_ID: id, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } });
          // Establish fallback ownership immediately: a record may never be published.
          if (!owner.pid) throw new Error(`${id} did not provide an owner PID`);
          fallbackOwners.push(owner);
          record = await controlRecord(controls, id, "RESOURCE_CREATED");
          expect(record.pid).toBeGreaterThan(0); expect(record.pgid).toBeGreaterThan(0); await expect(access(record.persistence)).resolves.toBeUndefined();
          await controlRecord(controls, id, "READY");
          process.kill(record.pid, "SIGINT"); await controlRecord(controls, id, "CLEANUP_ENTERED"); process.kill(record.pid, "SIGTERM");
          await deadline(`${id} cleanup held`, delay(100)); expect(owner.exitCode).toBeNull();
          await writeFile(join(controls, `${id}.release`), ""); await controlRecord(controls, id, "SETTLED");
          const code = await waitForExit(owner, `${id} owner exit`); expect(code).not.toBe(0);
          await expect(deadline(`${id} child group exit`, waitForProcessGroupExit(record.pgid, 30, 50, { cleanupTimeoutMs: 10_000 }))).resolves.toBe(true);
          await absent(record.persistence, `${id} persistence absence`);
        } finally {
          await cleanupFallback(id, owner, record, true);
        }
      }
      // A RESOURCE_CREATED record is sufficient: fail-before-ready must not rely on READY or release.
      for (const [id, entry, extra] of owners) {
        const failureId = `${id}-before-ready`;
        let owner: ChildProcess | undefined;
        let record: ControlRecord | undefined;
        let fallbackCalled = false;
        try {
          owner = spawn(process.execPath, [tsx, entry], { cwd: root, detached: true, stdio: "ignore", env: { ...process.env, ...extra, OWNED_PROCESS_CONTROL_DIR: controls, OWNED_PROCESS_CONTROL_ID: failureId, OWNED_PROCESS_FAIL_BEFORE_READY: "1", OWNED_PROCESS_HOLD_CLEANUP: "1", OWNED_PROCESS_CLEANUP_HOLD_TIMEOUT_MS: "30000", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } });
          if (!owner.pid) throw new Error(`${failureId} did not provide an owner PID`);
          fallbackOwners.push(owner); heldOwners.push({ id: failureId, owner });
          record = await controlRecord(controls, failureId, "RESOURCE_CREATED");
          await controlRecord(controls, failureId, "CLEANUP_ENTERED");
          // The actual owner cleanup is held here: fallback, not normal owner exit, removes these live resources.
          expect(groupIsLive(owner.pid)).toBe(true);
          expect(groupIsLive(record.pgid)).toBe(true);
          await expect(access(record.persistence)).resolves.toBeUndefined();
          await cleanupFallback(failureId, owner, record, true, true); fallbackCalled = true;
          expect(groupIsLive(owner.pid)).toBe(false);
          expect(groupIsLive(record.pgid)).toBe(false);
          await absent(record.persistence, `${failureId} fallback persistence absence`);
        } finally {
          if (!fallbackCalled) await cleanupFallback(failureId, owner, record, true, true);
        }
      }
      expect(injectedFallbackFailure).toBe(true);
      expect(preReadyFallbackActions).toContain("fixture-before-ready:release");
      expect(preReadyFallbackActions).toContain("smoke-before-ready:release");
      expect(preReadyFallbackActions).toContain("barrier-before-ready:release");
      expect(preReadyFallbackActions).toContain("probe-before-ready:release");
      expect(preReadyFallbackActions).toContain("fixture-before-ready:reported child absence");
      expect(preReadyFallbackActions).toContain("fixture-before-ready:tagged persistence absence");
      expect(cleanupErrors.some((error) => String(error).includes("injected fallback owner TERM/KILL failure"))).toBe(true);
    } finally {
      // Release any still-held cleanup before the unconditional TERM/KILL aggregate fallback.
      for (const { id } of heldOwners) {
        try { await writeFile(join(controls, `${id}.cleanup-release`), ""); } catch (error) { cleanupErrors.push(error); }
      }
      // A missing control record still has a fallback owner PID. Aggregate only after all attempts.
      for (const owner of fallbackOwners) {
        if (!owner.pid) continue;
        try { process.kill(-owner.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupErrors.push(error); }
        try { process.kill(-owner.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupErrors.push(error); }
        try { if (!await deadline("outer fallback owner absence", waitForProcessGroupExit(owner.pid, 30, 50, { cleanupTimeoutMs: 10_000 }))) throw new Error("outer fallback owner group remains"); } catch (error) { cleanupErrors.push(error); }
      }
      await rm(controls, { recursive: true, force: true });
      if (cleanupErrors.some((error) => !String(error).includes("injected fallback owner TERM/KILL failure"))) throw new AggregateError(cleanupErrors, "owner harness fallback cleanup failed");
    }
  }, 600_000);

  it("reports a real self-signaled child as SIGTERM after its group is absent", async () => {
    const pidFile = join(await mkdtemp(join(tmpdir(), "share-value-pool-owned-signaled-")), "pid");
    const source = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.kill(process.pid,'SIGTERM');`;
    try {
      await expect(runOwnedProcess(process.execPath, ["-e", source], 5_000, "ignore")).rejects.toThrow(/exited SIGTERM/);
      const pgid = Number(await readFile(pidFile, "utf8"));
      expect(pgid).toBeGreaterThan(0);
      await expect(waitForProcessGroupExit(pgid, 20, 50)).resolves.toBe(true);
    } finally { await rm(resolve(pidFile, ".."), { recursive: true, force: true }); }
  });

  it("keeps timeout primary over its SIGTERM cleanup and waits for complete group absence", async () => {
    const pidFile = join(await mkdtemp(join(tmpdir(), "share-value-pool-owned-timeout-")), "pid");
    const source = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
    try {
      await expect(runOwnedProcess(process.execPath, ["-e", source], 100, "ignore")).rejects.toThrow(/timed out/);
      const pgid = Number(await readFile(pidFile, "utf8"));
      expect(pgid).toBeGreaterThan(0);
      await expect(waitForProcessGroupExit(pgid, 20, 50)).resolves.toBe(true);
    } finally { await rm(resolve(pidFile, ".."), { recursive: true, force: true }); }
  });

  it("waits for TERM-resistant parent and descendant readiness, then SIGKILL-escalates the whole group", async () => {
    const ready = join(await mkdtemp(join(tmpdir(), "share-value-pool-owned-ready-")), "ready");
    const source = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},'descendant-ready');setInterval(()=>{},1000)`)}],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(ready + '.parent')},'parent-ready'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", source], { cwd: root, detached: true, stdio: "ignore" }); const pgid = child.pid!;
    try { await Promise.all([waitFor(ready), waitFor(`${ready}.parent`)]); await stopOwnedProcess(child, { cleanupTimeoutMs: 1_000 }); await expect(waitForProcessGroupExit(pgid, 5, 10)).resolves.toBe(true); } finally { await rm(resolve(ready, ".."), { recursive: true, force: true }); }
  });

  it("fails closed when the direct group probe fails", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: root, detached: true, stdio: "ignore" });
    await expect(stopOwnedProcess(child, { cleanupTimeoutMs: 100, groupProbe: async () => { throw new Error("probe failed"); } })).rejects.toThrow(/verification failed/);
    await expect(waitForProcessGroupExit(child.pid!, 5, 10)).resolves.toBe(true);
  });

  it("attempts stop and failing tagged removal, exits descendants, and preserves generated primary failure diagnostics", async () => {
    const persistence = await mkdtemp(join(tmpdir(), "share-value-pool-owned-test-"));
    const child = spawn(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"], { cwd: root, detached: true, stdio: "ignore" });
    const pgid = child.pid!; const primary = new Error("primary failure from owner use path"); let stopAttempts = 0; let removalAttempts = 0;
    await cleanupOwnedResources({ child, primary, label: "test owner", stop: async (owned) => { stopAttempts++; await stopOwnedProcess(owned); }, remove: async () => { removalAttempts++; throw new Error(`tagged persistence removal failed ${"x".repeat(3_000)}`); } });
    expect(stopAttempts).toBe(1); expect(removalAttempts).toBe(1); await expect(waitForProcessGroupExit(pgid, 5, 10)).resolves.toBe(true);
    expect((primary as Error & { cleanupDiagnostics?: Error }).cleanupDiagnostics?.message).toContain("tagged persistence removal failed"); await rm(persistence, { recursive: true, force: true });
  });
});

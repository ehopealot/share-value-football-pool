import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  T10_SERIAL_GATE_STAGES,
  runSerialGate,
} from "../../scripts/run-t10-serial-gate.mjs";
import { waitForProcessGroupExit } from "../../scripts/owned-process";

type SerialGateStage = { label: string; command: string; args: string[] };

const expectedStages: Array<[string, string, string[]]> = [
  ["orders-and-wagers browser", "npm", ["run", "test:e2e", "--", "--workers=1", "e2e/orders-and-wagers.spec.ts"]],
  ["auth-and-orders browser", "npm", ["run", "test:e2e", "--", "--workers=1", "e2e/auth-and-join.spec.ts", "e2e/orders-and-wagers.spec.ts"]],
  ["Vitest", "npm", ["test", "--", "--maxWorkers=1"]],
  ["local smoke", "npm", ["run", "test:local-smoke"]],
  ["typecheck", "npm", ["run", "typecheck"]],
  ["production build", "npm", ["run", "build"]],
  ["local build", "npm", ["run", "build:local"]],
  ["production route probe", "npm", ["run", "start:production-probe"]],
  ["direction contract", "npm", ["run", "verify:direction-contract"]],
  ["Wrangler parity", "npm", ["run", "verify:wrangler-parity"]],
  ["production artifact", "npm", ["run", "verify:production-artifact"]],
  ["production route absence", "npm", ["run", "verify:production-route-probe"]],
  ["owned-resource cleanup", "npm", ["run", "verify:owned-resource-cleanup"]],
  ["diff whitespace", "git", ["diff", "--check"]],
  ["staged files", "git", ["diff", "--cached", "--quiet"]],
  ["final owned-resource cleanup", "npm", ["run", "verify:owned-resource-cleanup"]],
];

const temporary = async (prefix: string) => mkdtemp(join(tmpdir(), prefix));
const forceProcessGroupExit = async (pgid: number, label: string) => {
  const errors: unknown[] = [];
  try { process.kill(-pgid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(error); }
  let exited = false;
  try { exited = await waitForProcessGroupExit(pgid, 2, 25, { cleanupTimeoutMs: 1_000 }); }
  catch (error) { errors.push(error); }
  if (!exited) {
    try { process.kill(-pgid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(error); }
    try { exited = await waitForProcessGroupExit(pgid, 30, 50, { cleanupTimeoutMs: 10_000 }); }
    catch (error) { errors.push(error); }
  }
  if (!exited) errors.push(new Error(`${label} process group remains`));
  if (errors.length) throw new AggregateError(errors, `${label} fallback cleanup failed`);
};
const noOpStages: SerialGateStage[] = [
  { label: "only", command: process.execPath, args: ["-e", ""] },
  { label: "final owned-resource cleanup", command: process.execPath, args: ["-e", ""] },
];

describe("T10 serial gate", () => {
  it("uses the exact approved serial command order and bounded stage configuration", async () => {
    expect(T10_SERIAL_GATE_STAGES.map((stage) => [stage.label, stage.command, stage.args])).toEqual(expectedStages);
    const root = await temporary("share-value-pool-serial-gate-order-");
    const seen: string[] = [];
    try {
      await runSerialGate({
        cwd: root,
        lockPath: join(root, "gate.lock"),
        stages: T10_SERIAL_GATE_STAGES,
        timeoutMs: 123,
        executeStage: async (stage, context) => {
          seen.push(stage.label);
          expect(context.timeoutMs).toBe(123);
        },
      });
      expect(seen).toEqual(expectedStages.map(([label]) => label));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("holds an exclusive checkout lock, rejects a concurrent gate, and releases it after success", async () => {
    const root = await temporary("share-value-pool-serial-gate-lock-");
    const lockPath = join(root, "gate.lock");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const first = runSerialGate({
      cwd: root,
      lockPath,
      stages: noOpStages,
      executeStage: async () => { markEntered(); await held; },
    });
    try {
      await entered;
      await expect.poll(async () => {
        try {
          await runSerialGate({ cwd: root, lockPath, stages: noOpStages, executeStage: async () => {} });
          return "accepted";
        } catch (error) {
          return String(error);
        }
      }).toMatch(/already running/);
      release();
      await expect(first).resolves.toBeUndefined();
      await expect(runSerialGate({ cwd: root, lockPath, stages: noOpStages, executeStage: async () => {} })).resolves.toBeUndefined();
    } finally {
      release?.();
      await first.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails fast, preserves the primary failure with cleanup diagnostics, and releases the lock on failure", async () => {
    const root = await temporary("share-value-pool-serial-gate-failure-");
    const lockPath = join(root, "gate.lock");
    const stages: SerialGateStage[] = [
      { label: "first", command: process.execPath, args: ["-e", ""] },
      { label: "fails", command: process.execPath, args: ["-e", ""] },
      { label: "must-not-run", command: process.execPath, args: ["-e", ""] },
    ];
    const seen: string[] = [];
    try {
      await expect(runSerialGate({
        cwd: root,
        lockPath,
        stages,
        executeStage: async (stage) => {
          seen.push(stage.label);
          if (stage.label === "fails") throw new Error("primary stage failure");
        },
        cleanup: async () => { throw new Error("cleanup diagnostic"); },
        finalCleanup: async () => {},
      })).rejects.toMatchObject({ message: "primary stage failure", cleanupDiagnostics: expect.objectContaining({ message: expect.stringContaining("cleanup diagnostic") }) });
      expect(seen).toEqual(["first", "fails"]);
      await expect(runSerialGate({ cwd: root, lockPath, stages: noOpStages, executeStage: async () => {} })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("kills a timed-out owned process group and verifies cleanup before returning", async () => {
    const root = await temporary("share-value-pool-serial-gate-timeout-");
    const marker = join(root, "descendant-ready");
    const pgidMarker = join(root, "group-pgid");
    const source = `const {spawn}=require('node:child_process');const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pgidMarker)},String(process.pid));process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`) }],{stdio:'ignore'});setInterval(()=>{},1000);`;
    let pgid: number | undefined;
    let groupVerifiedAbsent = false;
    try {
      await expect(runSerialGate({
        cwd: root,
        lockPath: join(root, "gate.lock"),
        timeoutMs: 1_000,
        stages: [{ label: "timeout", command: process.execPath, args: ["-e", source] }],
      })).rejects.toThrow(/timed out/);
      await expect(access(marker)).resolves.toBeUndefined();
      pgid = Number(await readFile(pgidMarker, "utf8"));
      expect(pgid).toBeGreaterThan(0);
      await expect(waitForProcessGroupExit(pgid, 20, 50, { cleanupTimeoutMs: 5_000 })).resolves.toBe(true);
      groupVerifiedAbsent = true;
    } finally {
      try {
        if (!pgid) {
          try { pgid = Number(await readFile(pgidMarker, "utf8")); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            // Process never published ownership.
          }
        }
        if (pgid && !groupVerifiedAbsent) await forceProcessGroupExit(pgid, "timed-out serial stage");
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }, 20_000);

  it("preserves the original interruption when owned-stage cleanup fails", async () => {
    const root = await temporary("share-value-pool-serial-gate-stop-failure-");
    const marker = join(root, "stop-failure-ready");
    const pgidMarker = join(root, "group-pgid");
    const controller = new AbortController();
    const source = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pgidMarker)},String(process.pid));fs.writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);`;
    let running: Promise<void> | undefined;
    let pgid: number | undefined;
    let groupVerifiedAbsent = false;
    try {
      running = runSerialGate({
        cwd: root, lockPath: join(root, "gate.lock"), signal: controller.signal,
        stages: [{ label: "stop failure", command: process.execPath, args: ["-e", source] }],
        stop: async (child) => { if (child?.pid) { pgid = child.pid; process.kill(-child.pid, "SIGKILL"); } throw new Error("injected stop cleanup failure"); },
        finalCleanup: async () => {},
      });
      await expect.poll(async () => {
        try { await access(marker); return true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return false;
        }
      }).toBe(true);
      controller.abort();
      const error = await running.catch((value) => value as Error & { cleanupDiagnostics?: Error });
      if (!error) throw new Error("expected interrupted gate failure");
      expect(error.message).toBe("T10 serial gate interrupted during stop failure");
      expect(error.cleanupDiagnostics?.message).toContain("injected stop cleanup failure");
    } finally {
      controller.abort();
      await running?.catch(() => undefined);
      try {
        if (!pgid) {
          try { pgid = Number(await readFile(pgidMarker, "utf8")); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            // Process never published ownership.
          }
        }
        if (pgid) {
          try { groupVerifiedAbsent = await waitForProcessGroupExit(pgid, 20, 50, { cleanupTimeoutMs: 5_000 }); } catch { /* fallback verifies cleanup below */ }
          if (!groupVerifiedAbsent) await forceProcessGroupExit(pgid, "stop-failure serial stage");
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });

  it("runs the default production residue verifier and retains the child-stage failure", async () => {
    const residue = await temporary("share-value-pool-owned-serial-gate-residue-");
    const lockRoot = await temporary("share-value-pool-serial-gate-real-residue-");
    try {
      const error = await runSerialGate({
        cwd: process.cwd(), lockPath: join(lockRoot, "gate.lock"),
        stages: [{ label: "real child failure", command: process.execPath, args: ["-e", "process.exit(7)"] }],
      }).catch((value) => value as Error & { cleanupDiagnostics?: Error });
      if (!error) throw new Error("expected real child-stage failure");
      expect(error.message).toContain("real child failure exited 7");
      expect(error.cleanupDiagnostics?.message).toContain("owned resources remain");
      expect(error.cleanupDiagnostics?.message).toContain(residue.split("/").at(-1)!);
    } finally {
      await rm(residue, { recursive: true, force: true });
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it("interrupts a TERM-resistant production child group, preserves the interruption, and releases its lock", async () => {
    const root = await temporary("share-value-pool-serial-gate-abort-");
    const marker = join(root, "abort-descendant-ready");
    const pgidMarker = join(root, "group-pgid");
    const controller = new AbortController();
    const source = `const {spawn}=require('node:child_process');const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pgidMarker)},String(process.pid));process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`) }],{stdio:'ignore'});setInterval(()=>{},1000);`;
    const waitForMarker = async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        try { await access(marker); return; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      throw new Error("TERM-resistant descendant did not become ready");
    };
    let running: Promise<void> | undefined;
    let pgid: number | undefined;
    let groupVerifiedAbsent = false;
    try {
      running = runSerialGate({ cwd: process.cwd(), lockPath: join(root, "gate.lock"), timeoutMs: 30_000, signal: controller.signal, stages: [{ label: "interruptible", command: process.execPath, args: ["-e", source] }] });
      await waitForMarker();
      pgid = Number(await readFile(pgidMarker, "utf8"));
      expect(pgid).toBeGreaterThan(0);
      controller.abort();
      await expect(running).rejects.toThrow(/interrupted during interruptible/);
      await expect(waitForProcessGroupExit(pgid, 20, 50, { cleanupTimeoutMs: 5_000 })).resolves.toBe(true);
      groupVerifiedAbsent = true;
      await expect(runSerialGate({ cwd: root, lockPath: join(root, "gate.lock"), stages: noOpStages, executeStage: async () => {} })).resolves.toBeUndefined();
    } finally {
      controller.abort();
      await running?.catch(() => undefined);
      try {
        if (!pgid) {
          try { pgid = Number(await readFile(pgidMarker, "utf8")); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            // Process never published ownership.
          }
        }
        if (pgid && !groupVerifiedAbsent) await forceProcessGroupExit(pgid, "interrupted serial stage");
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }, 20_000);

  it("does not allow diff whitespace errors", async () => {
    const root = await temporary("share-value-pool-serial-gate-diff-");
    const stage: SerialGateStage = { label: "diff whitespace", command: "git", args: ["diff", "--check"] };
    const execute = async (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { cwd: root, stdio: "ignore" });
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
    });
    try {
      await execute("git", ["init"]); await execute("git", ["config", "user.email", "test@example.test"]); await execute("git", ["config", "user.name", "Test"]);
      await writeFile(join(root, "tracked.txt"), "clean\n"); await execute("git", ["add", "tracked.txt"]); await execute("git", ["commit", "-m", "base"]);
      await writeFile(join(root, "tracked.txt"), "trailing space \n");
      await expect(runSerialGate({ cwd: root, lockPath: join(root, "gate.lock"), stages: [stage], finalCleanup: async () => {} })).rejects.toThrow(/exited/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not allow staged files", async () => {
    const root = await temporary("share-value-pool-serial-gate-staged-");
    const stage: SerialGateStage = { label: "staged files", command: "git", args: ["diff", "--cached", "--quiet"] };
    const execute = async (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { cwd: root, stdio: "ignore" });
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
    });
    try {
      await execute("git", ["init"]);
      await execute("git", ["config", "user.email", "test@example.test"]);
      await execute("git", ["config", "user.name", "Test"]);
      await writeFile(join(root, "staged.txt"), "staged\n");
      await execute("git", ["add", "staged.txt"]);
      await expect(runSerialGate({ cwd: root, lockPath: join(root, "gate.lock"), stages: [stage], finalCleanup: async () => {} })).rejects.toThrow(/exited/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

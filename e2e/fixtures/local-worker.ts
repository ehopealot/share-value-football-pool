import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { localE2eClientBuildEnvironment } from "../../scripts/e2e-client-build";
import { cleanupOwnedResources, createOwnerControl, installOwnedSignalCleanup, runOwnedProcess, stopOwnedProcess } from "../../scripts/owned-process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";

type LocalWorker = { baseURL: string; mailbox: () => Promise<Array<{ kind: "verification" | "password-reset"; to: string; token: string }>>; resetAuthLimiter: () => Promise<void>; triggerAlarm: (poolSlug: string) => Promise<void> };
const COMMAND_TIMEOUT_MS = 90_000;
const READINESS_TIMEOUT_MS = 60_000;
const require = createRequire(import.meta.url);
const resolveWrangler = () => require.resolve("wrangler");
const ringBuffer = (stream: NodeJS.ReadableStream | null, limit = 64 * 1024) => { let output = ""; let truncated = false; stream?.on("data", (chunk: Buffer | string) => { output += String(chunk); if (output.length > limit) { output = output.slice(-limit); truncated = true; } }); return () => `${truncated ? "[truncated]\n" : ""}${output}`; };
const run = (command: string, args: string[], environment: NodeJS.ProcessEnv = process.env) => runOwnedProcess(command, args, COMMAND_TIMEOUT_MS, "inherit", {}, environment);
export const stop = stopOwnedProcess;

/** The Playwright fixture and opt-in owner harness intentionally share this lifecycle. */
export async function runLocalWorkerOwner(use: (worker: LocalWorker) => Promise<void>) {
  const persistence = await mkdtemp(join(tmpdir(), "share-value-pool-owned-e2e-"));
  const port = 31000 + Math.floor(Math.random() * 4000);
  const control = createOwnerControl();
  const e2eEnvironment = localE2eClientBuildEnvironment(process.env);
  let child: ChildProcess | undefined;
  let primary: unknown;
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    if (control.enabled) { await control.cleanupEntered(); if (control.holdCleanup) await control.waitForCleanupHold(); if (!control.failBeforeReady) await control.waitForRelease(); }
    await cleanupOwnedResources({ child, primary, label: "local Worker", stop, remove: () => rm(persistence, { recursive: true, force: true }) });
    if (control.enabled) await control.settled();
  })();
  const signalCleanup = installOwnedSignalCleanup({ cleanup });
  try {
    await run(process.execPath, [resolveWrangler(), "d1", "migrations", "apply", "DB", "--local", "--persist-to", persistence, "--config", "wrangler.local.jsonc", "--env-file", "/dev/null"], e2eEnvironment);
    child = spawn(process.execPath, [resolveWrangler(), "dev", "--local", "--env-file", "/dev/null", `--port=${port}`, "--persist-to", persistence, "--config", "wrangler.local.jsonc", "--var", "BETTER_AUTH_SECRET:local-e2e-auth-secret-with-32-characters", "--var", "POOL_COMMAND_AUTHENTICATOR_KEY:local-e2e-command-authenticator", "--var", "POOL_PROJECTION_SERVICE_TOKEN:local-e2e-projection-token"], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: e2eEnvironment });
    const stdout = ringBuffer(child.stdout); const stderr = ringBuffer(child.stderr); const baseURL = `http://127.0.0.1:${port}`;
    if (!child.pid) throw new Error("local Worker did not provide a child PID before owner publication");
    let childError: Error | undefined;
    let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.once("error", (error) => { childError = error; });
    child.once("exit", (code, signal) => { childExit = { code, signal }; });
    await control.resourceCreated({ pid: process.pid, pgid: child.pid, persistence });
    control.throwIfFailBeforeReady();
    const deadline = Date.now() + READINESS_TIMEOUT_MS; let ready = false; let status = "starting";
    while (Date.now() < deadline && !ready) {
      if (childError) throw new Error(`local Worker readiness failed: child error ${childError.message}; baseURL=${baseURL}; deadline=${new Date(deadline).toISOString()}; status=${status}\nstdout:\n${stdout()}\nstderr:\n${stderr()}`);
      if (childExit) throw new Error(`local Worker readiness failed: child exited ${childExit.code ?? childExit.signal ?? "unknown"}; baseURL=${baseURL}; deadline=${new Date(deadline).toISOString()}; status=${status}\nstdout:\n${stdout()}\nstderr:\n${stderr()}`);
      try { const response = await fetch(`${baseURL}/health/app`, { signal: AbortSignal.timeout(1_000) }); status = `HTTP ${response.status}`; ready = response.ok; }
      catch (error) { status = `fetch ${error instanceof Error ? error.name : "failed"}`; }
      if (childError) throw new Error(`local Worker readiness failed: child error ${childError.message}; baseURL=${baseURL}; deadline=${new Date(deadline).toISOString()}; status=${status}\nstdout:\n${stdout()}\nstderr:\n${stderr()}`);
      if (childExit) throw new Error(`local Worker readiness failed: child exited ${childExit.code ?? childExit.signal ?? "unknown"}; baseURL=${baseURL}; deadline=${new Date(deadline).toISOString()}; status=${status}\nstdout:\n${stdout()}\nstderr:\n${stderr()}`);
      if (!ready) await delay(100);
    }
    if (!ready) throw new Error(`local Worker did not become ready; baseURL=${baseURL}; deadline=${new Date(deadline).toISOString()}; status=${status}\nstdout:\n${stdout()}\nstderr:\n${stderr()}`);
    const seed = await fetch(`${baseURL}/__local-test/seed`, { method: "POST" }); if (!seed.ok) throw new Error("local Worker fixture seed failed");
    await control.ready({ pid: process.pid, pgid: child.pid!, persistence });
    if (control.enabled) await control.waitForCleanup();
    await use({ baseURL, mailbox: async () => (await (await fetch(`${baseURL}/__local-test/mailbox`)).json() as { messages: Array<{ kind: "verification" | "password-reset"; to: string; token: string }> }).messages, resetAuthLimiter: async () => { const response = await fetch(`${baseURL}/__local-test/reset-auth-limiter`, { method: "POST" }); if (!response.ok) throw new Error("local auth limiter reset failed"); }, triggerAlarm: async (poolSlug) => { const response = await fetch(`${baseURL}/__local-test/alarm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poolSlug, currentTime: new Date().toISOString() }) }); if (!response.ok) throw new Error("local projection alarm failed"); } });
  } catch (error) { primary = error; throw error; } finally { await signalCleanup.settled(); }
}

export const test = base.extend<{ build: void; worker: LocalWorker }>({
  build: [async ({}, use) => { const e2eEnvironment = localE2eClientBuildEnvironment(process.env); await run("npm", ["run", "build"], e2eEnvironment); await run("npm", ["run", "build:local", "--", "--env-file", "/dev/null"], e2eEnvironment); await use(); }, { scope: "worker" }],
  worker: async ({ build: _build }, use) => runLocalWorkerOwner(use),
});
export { expect };

if (process.env.OWNED_PROCESS_FIXTURE_HARNESS === "1") await runLocalWorkerOwner(async () => { await new Promise<void>(() => {}); });

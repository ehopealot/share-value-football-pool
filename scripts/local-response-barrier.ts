import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cleanupOwnedResources, createOwnerControl, installOwnedSignalCleanup, runOwnedProcess, stopOwnedProcess } from "./owned-process";
import { assertProductionPortAvailable } from "./production-route-probe";

type Fetch = typeof fetch;

export async function startLocalResponseBarrierWorker<T>(baseURL: string, spawnWorker: () => T, request: Fetch = fetch): Promise<T> {
  await assertProductionPortAvailable(baseURL, request, "local response barrier Worker");
  return spawnWorker();
}

async function runLocalResponseBarrier() {
const require = createRequire(import.meta.url); const persistence = await mkdtemp(join(tmpdir(), "share-value-pool-owned-barrier-"));
const port = 35000 + Math.floor(Math.random() * 1000); const base = `http://127.0.0.1:${port}`; let child: ChildProcess | undefined; let childFailure: Error | undefined; let primary: unknown; let removeChildObservers = () => {}; const control = createOwnerControl();
const run = (command: string, args: string[]) => runOwnedProcess(command, args, 30_000);
const request = async (path: string, body?: unknown, signal?: AbortSignal) => fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { origin: base, "content-type": "application/json", "x-local-test-user": "local-owner" }, body: body ? JSON.stringify(body) : undefined, signal });
let cleanupPromise: Promise<void> | undefined;
const cleanup = () => cleanupPromise ??= (async () => {
  if (control.enabled) { await control.cleanupEntered(); if (control.holdCleanup) await control.waitForCleanupHold(); if (!control.failBeforeReady) await control.waitForRelease(); }
  await cleanupOwnedResources({ child, primary, label: "local response barrier", remove: () => rm(persistence, { recursive: true, force: true }) });
  if (control.enabled) await control.settled();
})();
const signalCleanup = installOwnedSignalCleanup({ cleanup });
try {
  await run("npm", ["run", "build:local"]);
  const wrangler = require.resolve("wrangler");
  await run(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persistence, "--config", "wrangler.local.jsonc"]);
  child = await startLocalResponseBarrierWorker(base, () => spawn(process.execPath, [wrangler, "dev", "--local", "--env-file", "/dev/null", `--port=${port}`, "--persist-to", persistence, "--config", "wrangler.local.jsonc", "--var", "BETTER_AUTH_SECRET:local-barrier-auth-secret-with-32-characters", "--var", "POOL_COMMAND_AUTHENTICATOR_KEY:local-barrier-command-authenticator", "--var", "POOL_PROJECTION_SERVICE_TOKEN:local-barrier-projection-token", "--var", "POOL_BACKUP_SERVICE_TOKEN:local-barrier-backup-token"], { detached: true, stdio: "ignore", env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } }), fetch);
  if (!child.pid) throw new Error("barrier Worker did not provide a process-group leader PID");
  const onChildError = (error: Error) => { childFailure ??= new Error(`barrier Worker spawn failed: ${error.message}`, { cause: error }); };
  const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => { childFailure ??= new Error(`barrier Worker exited ${code ?? signal ?? "unknown"} before readiness`); };
  const assertChildLive = () => {
    if (childFailure) throw childFailure;
    if (child?.exitCode != null || child?.signalCode != null) throw new Error(`barrier Worker exited ${child.exitCode ?? child.signalCode ?? "unknown"} before readiness`);
  };
  child.once("error", onChildError); child.once("exit", onChildExit);
  removeChildObservers = () => { child?.removeListener("error", onChildError); child?.removeListener("exit", onChildExit); };
  assertChildLive();
  await control.resourceCreated({ pid: process.pid, pgid: child.pid, persistence });
  control.throwIfFailBeforeReady();
  for (let i = 0; i < 120; i++) {
    assertChildLive();
    try {
      const response = await fetch(`${base}/health/app`, { signal: AbortSignal.timeout(1_000) });
      assertChildLive();
      if (response.ok) break;
    } catch { assertChildLive(); }
    await delay(100);
    if (i === 119) throw new Error("barrier worker did not become ready");
  }
  const seeded = await request("/__local-test/seed", {}); if (!seeded.ok) throw new Error("barrier fixture seed failed");
  await control.ready({ pid: process.pid, pgid: child.pid!, persistence });
  if (control.enabled) await control.waitForCleanup();
  const command = (slug: string) => ({ slug, poolName: slug, password: "local-password", idempotencyKey: `create-${slug}` });
  const arm = async (mode: "delay" | "drop", delayMs?: number, pathname?: string) => { const response = await request("/__local-test/response-barrier", { mode, delayMs, pathname }); if (!response.ok) throw new Error("barrier did not arm"); };
  const exactJson = async (response: Response, message: string) => { if (!response.ok) throw new Error(`${message} (${response.status})`); return JSON.stringify(await response.json()); };
  await arm("delay", 40); const delayedAt = Date.now(); const delayed = await exactJson(await request("/api/pools", command("barrier-delay")), "delayed real command did not complete after barrier"); if (Date.now() - delayedAt < 30) throw new Error("delayed response was released before the configured delay");
  const delayedReplay = await exactJson(await request("/api/pools", command("barrier-delay")), "delayed command exact replay failed"); if (delayedReplay !== delayed) throw new Error("delayed command replay changed the completed semantic result");
  await arm("drop"); let droppedRejected = false; try { await request("/api/pools", command("barrier-drop"), AbortSignal.timeout(100)); } catch { droppedRejected = true; } if (!droppedRejected) throw new Error("dropped completed response was released normally"); await delay(100);
  const droppedReplay = await exactJson(await request("/api/pools", command("barrier-drop")), "dropped completed command exact replay failed");
  const droppedReplayAgain = await exactJson(await request("/api/pools", command("barrier-drop")), "dropped command second exact replay failed"); if (droppedReplayAgain !== droppedReplay) throw new Error("dropped command replay changed the completed semantic result");
  await arm("delay", 40, "/api/p/barrier-delay/view"); await exactJson(await request("/api/p/barrier-drop/view"), "exact-path barrier blocked an unrelated completed response"); const exactAt = Date.now(); await exactJson(await request("/api/p/barrier-delay/view"), "exact-path delayed real response did not complete"); if (Date.now() - exactAt < 30) throw new Error("exact-path barrier did not delay its selected completed response");
  const unarmed = await exactJson(await request("/api/p/barrier-delay/view"), "unarmed normal command did not delegate normally"); if (!unarmed.includes("barrier-delay")) throw new Error("unarmed response did not contain the delegated command result");
  console.log("verified delayed, dropped, replayed, exact-path one-shot, and unarmed delegated local responses");
} catch (error) { primary = error; throw error; } finally {
  try { await signalCleanup.settled(); }
  finally { removeChildObservers(); }
}
}

if (import.meta.url === `file://${process.argv[1]}`) await runLocalResponseBarrier();

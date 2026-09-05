import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cleanupOwnedResources, createOwnerControl, installOwnedSignalCleanup, stopOwnedProcess } from "./owned-process";

const require = createRequire(import.meta.url);
const timeoutMs = 30_000;
const productionConfig = process.env.PRODUCTION_PROBE_CONFIG ?? "dist/office_pool_reborn/wrangler.json";
const productionBuild = process.env.PRODUCTION_PROBE_BUILD ?? "dist/office_pool_reborn";
const port = Number(process.env.PRODUCTION_PROBE_PORT ?? 25173);
type Fetch = typeof fetch;
type AssertChildLive = () => void;

const isConnectionRefused = (error: unknown) => {
  let current = error;
  while (current && typeof current === "object") {
    if ((current as NodeJS.ErrnoException).code === "ECONNREFUSED") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

export async function assertProductionPortAvailable(baseURL: string, request: Fetch = fetch, owner = "production probe") {
  try {
    await request(`${baseURL}/health/app`, { signal: AbortSignal.timeout(500) });
  } catch (error) {
    if (isConnectionRefused(error)) return;
    throw new Error(`${owner} port availability could not be confirmed at ${baseURL}`, { cause: error });
  }
  throw new Error(`${owner} port is already serving at ${baseURL}`);
}

export async function waitForProductionReadiness(baseURL: string, request: Fetch = fetch, assertChildLive: AssertChildLive = () => {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertChildLive();
    try {
      const response = await request(`${baseURL}/health/app`, { signal: AbortSignal.timeout(1_000) });
      assertChildLive();
      if (response.ok) return;
    } catch { assertChildLive(); }
    await delay(100);
  }
  assertChildLive();
  throw new Error("production Worker did not become ready");
}
export type ProductionProbeOptions = { spawn?: typeof spawn; port?: number; preflight?: typeof assertProductionPortAvailable; ready?: typeof waitForProductionReadiness; fetch?: Fetch; stop?: (child: ChildProcess | undefined) => Promise<void>; remove?: (path: string, options: { recursive: true; force: true }) => Promise<void> };

export async function probeProductionRoutes(options: ProductionProbeOptions = {}) {
  const config = resolve(productionConfig); const build = resolve(productionBuild);
  if (!config.startsWith(build)) throw new Error("production probe config must be generated inside the production build");
  const baseURL = `http://127.0.0.1:${options.port ?? port}`;
  const request = options.fetch ?? fetch;
  await (options.preflight ?? assertProductionPortAvailable)(baseURL, request);
  const persistence = await mkdtemp(join(tmpdir(), "share-value-pool-owned-production-probe-"));
  let child: ChildProcess | undefined;
  let childFailure: Error | undefined;
  let primary: unknown;
  let removeChildObservers = () => {};
  const control = createOwnerControl();
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    if (control.enabled) { await control.cleanupEntered(); if (control.holdCleanup) await control.waitForCleanupHold(); if (!control.failBeforeReady) await control.waitForRelease(); }
    await cleanupOwnedResources({ child, primary, label: "production probe", stop: options.stop, remove: () => (options.remove ?? rm)(persistence, { recursive: true, force: true }) });
    if (control.enabled) await control.settled();
  })();
  const signalCleanup = installOwnedSignalCleanup({ cleanup });
  try {
    child = (options.spawn ?? spawn)(process.execPath, [require.resolve("wrangler"), "dev", "--local", "--env-file", "/dev/null", `--port=${options.port ?? port}`, "--persist-to", persistence, "--config", config, "--var", "BETTER_AUTH_SECRET:production-probe-auth-secret-with-32-characters", "--var", "RESEND_API_KEY:production-probe-resend-key"], { detached: true, stdio: "ignore", env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" } });
    if (!child.pid) throw new Error("production Worker did not provide a process-group leader PID");
    const onChildError = (error: Error) => { childFailure ??= new Error(`production Worker spawn failed: ${error.message}`, { cause: error }); };
    const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => { childFailure ??= new Error(`production Worker exited ${code ?? signal ?? "unknown"} before probe completion`); };
    if (typeof child.once === "function" && typeof child.removeListener === "function") {
      child.once("error", onChildError);
      child.once("exit", onChildExit);
      removeChildObservers = () => { child?.removeListener("error", onChildError); child?.removeListener("exit", onChildExit); };
    }
    const assertChildLive = () => {
      if (childFailure) throw childFailure;
      if (child?.exitCode != null || child?.signalCode != null) throw new Error(`production Worker exited ${child.exitCode ?? child.signalCode ?? "unknown"} before probe completion`);
    };
    assertChildLive();
    await control.resourceCreated({ pid: process.pid, pgid: child.pid, persistence });
    control.throwIfFailBeforeReady();
    await (options.ready ?? waitForProductionReadiness)(baseURL, request, assertChildLive);
    assertChildLive();
    await control.ready({ pid: process.pid, pgid: child.pid, persistence });
    if (control.enabled) await control.waitForCleanup();
    for (const method of ["GET", "POST", "OPTIONS"]) {
      assertChildLive();
      const response = await request(`${baseURL}/__local-test/probe`, { method, signal: AbortSignal.timeout(5_000) });
      assertChildLive();
      if (response.status !== 404) throw new Error(`${method} /__local-test/probe returned ${response.status}, expected 404`);
    }
    console.log("GET/POST/OPTIONS production local-test routes returned 404 from live generated production Worker");
  } catch (error) { primary = error; throw error; }
  finally {
    try { await signalCleanup.settled(); }
    finally { removeChildObservers(); }
  }
}
if (import.meta.url === `file://${process.argv[1]}`) await probeProductionRoutes();

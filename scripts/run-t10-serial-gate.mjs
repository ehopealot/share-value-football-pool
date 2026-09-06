import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nonPublishingCloudflareEnvironment } from "./cloudflare-credentials.mjs";
import { stopOwnedProcess, waitForProcessGroupExit } from "./owned-process.ts";

const DEFAULT_STAGE_TIMEOUT_MS = 15 * 60_000;

/** The approved T10 checks, deliberately including the final post-diff residue check. */
export const T10_SERIAL_GATE_STAGES = [
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
].map(([label, command, args]) => ({ label, command, args }));

const errorFrom = (value) => value instanceof Error ? value : new Error(String(value));
const processStartIdentity = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(") ");
    const fields = commandEnd < 0 ? [] : stat.slice(commandEnd + 2).trim().split(/\s+/);
    if (!fields[19]) throw new Error(`cannot read process start identity for PID ${pid}`);
    return fields[19];
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return undefined;
    throw error;
  }
};
const checkoutLockPath = (cwd) => {
  const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 24);
  return `/tmp/share-value-pool-t10-serial-gate-${key}.lock`;
};

async function acquireLock(lockPath, cwd, writeOwner = writeFile, renameLock = rename, removePending = rm) {
  const token = randomUUID();
  const pendingLockPath = await mkdtemp(`${lockPath}.pending-`);
  const removePreparedLock = async (primary) => {
    try { await removePending(pendingLockPath, { recursive: true, force: false }); }
    catch (cleanupError) {
      const diagnostic = new Error(`T10 serial gate lock preparation cleanup failed: ${String(cleanupError).slice(0, 2_000)}`);
      const existing = primary.cleanupDiagnostics;
      Object.defineProperty(primary, "cleanupDiagnostics", { value: existing ? new Error(`${existing.message}; ${diagnostic.message}`) : diagnostic, enumerable: true, configurable: true });
    }
  };
  try {
    const identity = await processStartIdentity(process.pid);
    if (!identity) throw new Error(`cannot establish T10 serial gate owner identity for PID ${process.pid}`);
    await writeOwner(`${pendingLockPath}/owner.json`, JSON.stringify({ token, pid: process.pid, processStartIdentity: identity, cwd: resolve(cwd), startedAt: new Date().toISOString() }), "utf8");
  } catch (error) {
    const primary = errorFrom(error);
    await removePreparedLock(primary);
    throw primary;
  }
  // mkdir is the exclusive acquisition point: unlike rename, it cannot replace
  // an empty existing lock. Never reclaim automatically; a stale observation
  // cannot safely authorize removing a path another contender may now own.
  try {
    await mkdir(lockPath);
  } catch (error) {
    const primary = error?.code === "EEXIST"
      ? new Error(`T10 serial gate already running or existing lock requires manual recovery (${lockPath}); verify all gate owners and stage process groups have exited before removing it.`, { cause: errorFrom(error) })
      : errorFrom(error);
    await removePreparedLock(primary);
    throw primary;
  }
  try {
    await renameLock(pendingLockPath, lockPath);
  } catch (error) {
    const primary = errorFrom(error);
    // Only remove our empty reservation, never recursively delete an unexpected
    // owner. Other gate invocations reject this path even before metadata exists.
    try { await rmdir(lockPath); }
    catch (cleanupError) {
      Object.defineProperty(primary, "cleanupDiagnostics", { value: new Error(`T10 serial gate reservation cleanup failed: ${String(cleanupError).slice(0, 2_000)}`), enumerable: true, configurable: true });
    }
    await removePreparedLock(primary);
    throw primary;
  }
  const updateActiveStage = async (activeStage) => {
    const owner = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8"));
    if (owner.token !== token) throw new Error(`T10 serial gate lock ownership changed (${lockPath})`);
    const nextOwner = { ...owner };
    if (activeStage) nextOwner.activeStage = activeStage;
    else delete nextOwner.activeStage;
    const pendingOwnerPath = `${lockPath}/owner.pending-${randomUUID()}.json`;
    try {
      await writeFile(pendingOwnerPath, JSON.stringify(nextOwner), "utf8");
      await rename(pendingOwnerPath, `${lockPath}/owner.json`);
    } finally {
      await rm(pendingOwnerPath, { force: true });
    }
  };
  const release = async () => {
    // Never remove a lock another invocation replaced after an operator intervention.
    try {
      const owner = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8"));
      if (owner.token !== token) throw new Error(`T10 serial gate lock ownership changed (${lockPath})`);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await rm(lockPath, { recursive: true, force: false });
  };
  return { release, updateActiveStage };
}

export function forwardSerialGateOutput(source, destination, chunk) {
  if (!destination.write(chunk)) {
    source.pause();
    destination.once("drain", () => source.resume());
  }
}

async function runBoundedStage(stage, { cwd, timeoutMs, signal, stop = stopOwnedProcess, updateActiveStage }) {
  if (signal?.aborted) throw new Error(`T10 serial gate interrupted before ${stage.label}`);
  const child = spawn(stage.command, stage.args, { cwd, env: nonPublishingCloudflareEnvironment(process.env), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const spawned = new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  let stageRegistered = false;
  try {
    await spawned;
    const identity = await processStartIdentity(child.pid);
    await updateActiveStage?.(identity
      ? { pid: child.pid, processStartIdentity: identity }
      : { pid: child.pid, processStartIdentity: null, leaderExitedBeforeRegistration: true });
    stageRegistered = true;
  } catch (error) {
    const primary = errorFrom(error);
    try { await stop(child); }
    catch (cleanupError) { Object.defineProperty(primary, "cleanupDiagnostics", { value: errorFrom(cleanupError), enumerable: true, configurable: true }); }
    throw primary;
  }
  let output = "";
  const capture = (chunk, source, destination) => { output = `${output}${String(chunk)}`.slice(-8_192); forwardSerialGateOutput(source, destination, chunk); };
  if (child.stdout) child.stdout.on("data", (chunk) => capture(chunk, child.stdout, process.stdout));
  if (child.stderr) child.stderr.on("data", (chunk) => capture(chunk, child.stderr, process.stderr));
  let primary;
  try {
    await new Promise((resolveStage, rejectStage) => {
      let settled = false;
      let terminating = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", interrupted);
        if (error) rejectStage(error); else resolveStage();
      };
      const terminate = (reason) => {
        if (terminating || settled) return;
        terminating = true;
        void stop(child).then(
          () => finish(reason),
          (cleanupError) => {
            const diagnostic = new Error(`stage cleanup failed: ${String(cleanupError).slice(0, 2_000)}`);
            Object.defineProperty(reason, "cleanupDiagnostics", { value: diagnostic, enumerable: true, configurable: true });
            finish(reason);
          },
        );
      };
      const timer = setTimeout(() => terminate(new Error(`${stage.label} timed out after ${timeoutMs}ms`)), timeoutMs);
      const interrupted = () => terminate(new Error(`T10 serial gate interrupted during ${stage.label}`));
      const exited = (code, signalName) => {
        if (terminating) return;
        void waitForProcessGroupExit(child.pid, 20, 100).then(
          (clean) => {
            if (code === 0 && clean) finish();
            else terminate(new Error(`${stage.label} exited ${code ?? signalName ?? "unknown"}${clean ? "" : " and left descendants"}${output ? `\noutput:\n${output}` : ""}`));
          },
          (error) => terminate(errorFrom(error)),
        );
      };
      signal?.addEventListener("abort", interrupted, { once: true });
      child.once("error", (error) => terminate(error));
      child.once("exit", exited);
      if (signal?.aborted) interrupted();
      else if (child.exitCode !== null || child.signalCode !== null) exited(child.exitCode, child.signalCode);
    });
  } catch (error) {
    primary = errorFrom(error);
    throw primary;
  } finally {
    if (stageRegistered) {
      try { await updateActiveStage?.(); }
      catch (error) {
        if (!primary) throw error;
        const existing = primary.cleanupDiagnostics;
        const diagnostic = new Error(`stage ownership cleanup failed: ${String(error).slice(0, 2_000)}`);
        Object.defineProperty(primary, "cleanupDiagnostics", { value: existing ? new Error(`${existing.message}; ${diagnostic.message}`) : diagnostic, enumerable: true, configurable: true });
      }
    }
  }
}

/**
 * Executes one stage at a time under a checkout-scoped ownership lock.
 * Injection points exist solely so the local behavioral test can exercise lock/failure paths.
 */
export async function runSerialGate({
  cwd = process.cwd(),
  lockPath = checkoutLockPath(cwd),
  stages = T10_SERIAL_GATE_STAGES,
  timeoutMs = DEFAULT_STAGE_TIMEOUT_MS,
  executeStage = runBoundedStage,
  cleanup,
  finalCleanup,
  signal,
  stop,
  writeOwner,
  renameLock,
  removePending,
} = {}) {
  const { release: releaseLock, updateActiveStage } = await acquireLock(lockPath, cwd, writeOwner, renameLock, removePending);
  const runFinalCleanup = finalCleanup ?? (({ cwd: cleanupCwd, timeoutMs: cleanupTimeoutMs }) => runBoundedStage(
    T10_SERIAL_GATE_STAGES.at(-1),
    { cwd: cleanupCwd, timeoutMs: cleanupTimeoutMs, updateActiveStage },
  ));
  let primary;
  let normalFinalCleanupReached = false;
  const cleanupErrors = [];
  try {
    for (const [index, stage] of stages.entries()) {
      console.log(`T10 serial gate: ${stage.label}: ${stage.command} ${stage.args.join(" ")}`);
      await executeStage(stage, { cwd, timeoutMs, signal, stop, updateActiveStage });
      if (index === stages.length - 1 && stage.label === "final owned-resource cleanup") normalFinalCleanupReached = true;
    }
  } catch (error) {
    primary = errorFrom(error);
    throw primary;
  } finally {
    // A stage failure or signal must not bypass tagged-resource confirmation.
    // This is intentionally a verifier, not a deletion routine, so it cannot touch unrelated resources.
    if (!normalFinalCleanupReached) {
      try { await runFinalCleanup({ cwd, timeoutMs }); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanup) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    try { await releaseLock(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      const diagnostic = new Error(`T10 serial gate cleanup failed: ${cleanupErrors.map(String).join("; ").slice(0, 2_000)}`);
      if (primary) {
        const stageDiagnostic = primary.cleanupDiagnostics;
        const composed = stageDiagnostic ? new Error(`${stageDiagnostic.message}; ${diagnostic.message}`) : diagnostic;
        Object.defineProperty(primary, "cleanupDiagnostics", { value: composed, enumerable: true, configurable: true });
      }
      else throw diagnostic;
    }
  }
}

async function main() {
  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await runSerialGate({ signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}

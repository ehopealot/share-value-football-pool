import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const checkoutLockPath = (cwd) => {
  const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 24);
  return `/tmp/share-value-pool-t10-serial-gate-${key}.lock`;
};

async function acquireLock(lockPath) {
  const token = randomUUID();
  try {
    await mkdir(lockPath, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`T10 serial gate already running for this checkout (${lockPath})`);
    throw error;
  }
  await writeFile(`${lockPath}/owner.json`, JSON.stringify({ token, pid: process.pid, cwd: process.cwd(), startedAt: new Date().toISOString() }), "utf8");
  return async () => {
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
}

async function runBoundedStage(stage, { cwd, timeoutMs, signal, stop = stopOwnedProcess }) {
  if (signal?.aborted) throw new Error(`T10 serial gate interrupted before ${stage.label}`);
  const child = spawn(stage.command, stage.args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const capture = (chunk, stream) => { const text = String(chunk); output = `${output}${text}`.slice(-8_192); stream.write(text); };
  child.stdout?.on("data", (chunk) => capture(chunk, process.stdout));
  child.stderr?.on("data", (chunk) => capture(chunk, process.stderr));
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
    signal?.addEventListener("abort", interrupted, { once: true });
    child.once("error", (error) => terminate(error));
    child.once("exit", (code, signalName) => {
      if (terminating) return;
      void waitForProcessGroupExit(child.pid, 20, 100).then(
        (clean) => {
          if (code === 0 && clean) finish();
          else terminate(new Error(`${stage.label} exited ${code ?? signalName ?? "unknown"}${clean ? "" : " and left descendants"}${output ? `\noutput:\n${output}` : ""}`));
        },
        (error) => terminate(errorFrom(error)),
      );
    });
  });
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
  finalCleanup = ({ cwd: cleanupCwd, timeoutMs: cleanupTimeoutMs }) => runBoundedStage(T10_SERIAL_GATE_STAGES.at(-1), { cwd: cleanupCwd, timeoutMs: cleanupTimeoutMs }),
  signal,
  stop,
} = {}) {
  const releaseLock = await acquireLock(lockPath);
  let primary;
  let normalFinalCleanupReached = false;
  const cleanupErrors = [];
  try {
    for (const stage of stages) {
      console.log(`T10 serial gate: ${stage.label}: ${stage.command} ${stage.args.join(" ")}`);
      await executeStage(stage, { cwd, timeoutMs, signal, stop });
      if (stage.label === "final owned-resource cleanup") normalFinalCleanupReached = true;
    }
  } catch (error) {
    primary = errorFrom(error);
    throw primary;
  } finally {
    // A stage failure or signal must not bypass tagged-resource confirmation.
    // This is intentionally a verifier, not a deletion routine, so it cannot touch unrelated resources.
    if (!normalFinalCleanupReached) {
      try { await finalCleanup({ cwd, timeoutMs }); } catch (error) { cleanupErrors.push(error); }
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

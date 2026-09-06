import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDirectExecution } from "./direct-entry.mjs";
import { nonPublishingCloudflareEnvironment } from "./cloudflare-credentials.mjs";
import { parseDetectorOutput } from "./detector-findings.mjs";
import { stopOwnedProcess, waitForProcessGroupExit } from "./owned-process.ts";

const require = createRequire(import.meta.url);
const DEFAULT_STAGE_TIMEOUT_MS = 15 * 60_000;
const MAX_DETECTOR_OUTPUT_BYTES = 10 * 1024 * 1024;
const errorFrom = (value) => value instanceof Error ? value : new Error(String(value));

export const finishDryRunEnvironment = (environment = process.env) => nonPublishingCloudflareEnvironment(environment);

export const finishCommandStdio = (captureStdout) => captureStdout
  ? ["ignore", "pipe", "inherit"]
  : ["ignore", "inherit", "inherit"];

export function runFinishCommand(command, args, {
  allowFailure = false,
  env = process.env,
  cwd = process.cwd(),
  timeoutMs = DEFAULT_STAGE_TIMEOUT_MS,
  signal,
  captureStdout = false,
  stop = stopOwnedProcess,
} = {}) {
  if (signal?.aborted) return Promise.reject(new Error(`finish review interrupted before ${command}`));
  const child = spawn(command, args, { cwd, env, detached: true, stdio: finishCommandStdio(captureStdout) });
  return new Promise((resolveRun, rejectRun) => {
    let settled = false; let terminating = false; const stdoutChunks = []; let capturedBytes = 0;
    const finish = (error, status = 1) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", interrupted);
      if (error) rejectRun(error); else resolveRun({ status, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: "" });
    };
    const terminate = (primary) => {
      if (terminating || settled) return;
      terminating = true;
      void stop(child).then(
        () => finish(primary),
        (cleanupError) => {
          Object.defineProperty(primary, "cleanupDiagnostics", { value: new Error(`finish review cleanup failed: ${String(cleanupError).slice(0, 2_000)}`), enumerable: false });
          finish(primary);
        },
      );
    };
    const capture = (chunk) => {
      if (!captureStdout || terminating || settled) return;
      process.stdout.write(chunk);
      const bytes = Buffer.from(chunk);
      capturedBytes += bytes.length;
      if (capturedBytes > MAX_DETECTOR_OUTPUT_BYTES) {
        terminate(new Error(`detector output exceeded ${MAX_DETECTOR_OUTPUT_BYTES} bytes`));
        return;
      }
      stdoutChunks.push(bytes);
    };
    const interrupted = () => terminate(new Error(`finish review interrupted during ${command}`));
    const timer = setTimeout(() => terminate(new Error(`${command} timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener("abort", interrupted, { once: true });
    child.stdout?.on("data", capture);
    child.once("error", (error) => terminate(errorFrom(error)));
    child.once("close", (status, signalName) => {
      if (terminating || settled) return;
      const pid = child.pid;
      if (!pid) return terminate(new Error(`${command} did not provide a process-group leader PID`));
      void waitForProcessGroupExit(pid, 20, 100).then(
        (clean) => {
          if (!clean) return terminate(new Error(`${command} exited ${status ?? signalName ?? "unknown"} and left descendants`));
          const resultStatus = status ?? 1;
          if (!allowFailure && resultStatus !== 0) finish(new Error(`${command} ${args.join(" ")} exited ${resultStatus}.`), resultStatus);
          else finish(undefined, resultStatus);
        },
        (error) => terminate(new Error("finish review process-group verification failed", { cause: error })),
      );
    });
  });
}

const ordinaryChecks = (phase, environment) => [
  ["npm", ["run", "typecheck"]],
  ["npm", ["test"]],
  ["npm", ["run", "test:e2e", "--", "e2e/responsive-a11y.spec.ts"]],
  ["npm", ["run", "build"]],
  ["npm", ["run", "verify:direction-contract"]],
  [process.execPath, [require.resolve("wrangler"), "deploy", "--dry-run", "--config", "wrangler.jsonc"], { env: finishDryRunEnvironment(environment) }],
  ["npm", ["run", `screenshots:${phase}`]],
];
const detectorCommand = (environment) => {
  const home = environment.HOME ?? "";
  const legacy = resolve(home, ".pi/agent/skills/impeccable/scripts/detect.mjs");
  const installed = resolve(home, ".pi/agent/npm/node_modules/impeccable/cli/bin/cli.js");
  if (existsSync(legacy)) return [process.execPath, [legacy, "--json", "index.html", "src/web"]];
  if (existsSync(installed)) return [process.execPath, [installed, "detect", "--json", "index.html", "src/web"]];
  throw new Error("The Impeccable detector is not installed.");
};
const requirePhaseCReview = (detectorResult, environment) => {
  if (detectorResult.status === 0 || environment.FINISH_REVIEW_PHASE_C_COMPLETE === "1") return;
  throw new Error("Detector findings are recorded. Inspect screenshots, apply at most one reviewed material fix batch if needed, then resume with FINISH_REVIEW_RESUME=1.");
};
const atomicWrite = (path, content) => {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
};
const validateDetectorArtifacts = (root) => {
  const detectorPath = resolve(root, "artifacts/detector.json");
  const exitPath = resolve(root, "artifacts/detector.exit");
  if (!existsSync(detectorPath) || !existsSync(exitPath)) throw new Error("Cannot resume Phase D before Phase B detector artifacts exist.");
  parseDetectorOutput(readFileSync(detectorPath, "utf8"));
  if (!/^(0|2)$/.test(readFileSync(exitPath, "utf8").trim())) throw new Error("Cannot resume Phase D with an invalid detector exit marker.");
};

export async function runFinishReview({ root = process.cwd(), environment = process.env, signal, run = runFinishCommand } = {}) {
  const reviewRoot = resolve(root);
  const reviewEnvironment = { ...finishDryRunEnvironment(environment), FINISH_REVIEW_ROOT: reviewRoot };
  const invoke = (command, args, options = {}) => run(command, args, { cwd: reviewRoot, signal, ...options });
  const runOrdinaryChecks = async (phase) => {
    for (const [command, args, options] of ordinaryChecks(phase, reviewEnvironment)) await invoke(command, args, { env: reviewEnvironment, ...options });
  };
  const detector = async () => {
    const artifacts = resolve(reviewRoot, "artifacts");
    const detectorPath = resolve(artifacts, "detector.json");
    const exitPath = resolve(artifacts, "detector.exit");
    mkdirSync(artifacts, { recursive: true });
    rmSync(exitPath, { force: true });
    const [command, args] = detectorCommand(reviewEnvironment);
    const result = await invoke(command, args, { allowFailure: true, env: finishDryRunEnvironment(reviewEnvironment), captureStdout: true });
    if (![0, 2].includes(result.status)) throw new Error(`Detector did not complete normally (status ${result.status}).`);
    parseDetectorOutput(result.stdout);
    atomicWrite(detectorPath, result.stdout);
    atomicWrite(exitPath, `${result.status}\n`);
    return result;
  };

  const resume = reviewEnvironment.FINISH_REVIEW_RESUME === "1";
  if (!resume) {
    await runOrdinaryChecks("initial");
    const result = await detector();
    requirePhaseCReview(result, reviewEnvironment);
  } else {
    validateDetectorArtifacts(reviewRoot);
  }
  await runOrdinaryChecks("final");
  await invoke("npm", ["run", "verify:finish-artifacts"], { env: reviewEnvironment });
  console.log("Finish review completed.");
}

async function main() {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  try { await runFinishReview({ signal: controller.signal }); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
  finally { process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal); }
}

if (isDirectExecution(import.meta.url)) await main();

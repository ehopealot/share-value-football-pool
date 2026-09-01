import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);
const dryRunEnv = { ...process.env }; delete dryRunEnv.CLOUDFLARE_API_TOKEN;
const run = (command, args, { allowFailure = false, env } = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { cwd: root, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); process.stderr.write(chunk); });
  child.once("error", reject);
  child.once("close", (status) => {
    const result = { status: status ?? 1, stdout, stderr };
    if (!allowFailure && result.status !== 0) reject(new Error(`${command} ${args.join(" ")} exited ${result.status}.`)); else resolveRun(result);
  });
});
const ordinaryChecks = (phase) => [
  ["npm", ["run", "typecheck"]],
  ["npm", ["test"]],
  ["npm", ["run", "test:e2e", "--", "e2e/responsive-a11y.spec.ts"]],
  ["npm", ["run", "build"]],
  ["npm", ["run", "verify:direction-contract"]],
  [process.execPath, [require.resolve("wrangler"), "deploy", "--dry-run", "--config", "wrangler.jsonc"], { env: dryRunEnv }],
  ["npm", ["run", `screenshots:${phase}`]]
];
const detectorCommand = () => {
  const home = process.env.HOME ?? "";
  const legacy = resolve(home, ".pi/agent/skills/impeccable/scripts/detect.mjs");
  const installed = resolve(home, ".pi/agent/npm/node_modules/impeccable/cli/bin/cli.js");
  if (existsSync(legacy)) return [process.execPath, [legacy, "--json", "index.html", "src/web"]];
  if (existsSync(installed)) return [process.execPath, [installed, "detect", "--json", "index.html", "src/web"]];
  throw new Error("The Impeccable detector is not installed.");
};
const runOrdinaryChecks = async (phase) => {
  for (const [command, args, options] of ordinaryChecks(phase)) await run(command, args, options);
};
const detector = async () => {
  mkdirSync(resolve(root, "artifacts"), { recursive: true });
  const [command, args] = detectorCommand();
  // This is intentionally the only detector invocation in the finish workflow.
  const result = await run(command, args, { allowFailure: true });
  writeFileSync(resolve(root, "artifacts/detector.json"), result.stdout || "[]\n");
  writeFileSync(resolve(root, "artifacts/detector.exit"), `${result.status}\n`);
  if (![0, 2].includes(result.status)) throw new Error(`Detector did not complete normally (status ${result.status}).`);
  return result;
};
const requirePhaseCReview = (detectorResult) => {
  if (detectorResult.status === 0 || process.env.FINISH_REVIEW_PHASE_C_COMPLETE === "1") return;
  throw new Error("Detector findings are recorded. Inspect screenshots, apply at most one reviewed material fix batch if needed, then resume with FINISH_REVIEW_RESUME=1.");
};

const resume = process.env.FINISH_REVIEW_RESUME === "1";
try {
  if (!resume) {
    await runOrdinaryChecks("initial");
    const result = await detector();
    requirePhaseCReview(result);
  } else if (!existsSync(resolve(root, "artifacts/detector.json")) || !existsSync(resolve(root, "artifacts/detector.exit"))) {
    throw new Error("Cannot resume Phase D before Phase B detector artifacts exist.");
  }
  await runOrdinaryChecks("final");
  await run("npm", ["run", "verify:finish-artifacts"]);
  console.log("Finish review completed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

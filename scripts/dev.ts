import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertSharedDevPlatform, sharedDevLockPath, sharedDevStatePath } from "./dev-state";

const lockConflictExitCode = 75;
const projectDirectory = process.cwd();
const stateDirectory = sharedDevStatePath(projectDirectory);
const lockPath = sharedDevLockPath(projectDirectory);
const runner = resolve(projectDirectory, "scripts", "run-dev-with-lock.sh");
const waitForExit = (child: ChildProcess) => new Promise<number>((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code ?? 1));
});

assertSharedDevPlatform();
await mkdir(dirname(lockPath), { recursive: true });
console.log(`Using shared local dev state: ${stateDirectory}`);

let child: ChildProcess | undefined;
let requestedSignal: NodeJS.Signals | undefined;
const forwardSignal = (signal: NodeJS.Signals) => {
  requestedSignal ??= signal;
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch { /* process group already exited */ }
};
const onSigint = () => forwardSignal("SIGINT");
const onSigterm = () => forwardSignal("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
try {
  child = spawn("flock", ["--nonblock", "--no-fork", "--conflict-exit-code=75", lockPath, runner, stateDirectory, ...process.argv.slice(2)], {
    cwd: projectDirectory,
    detached: true,
    env: { ...process.env, OFFICE_POOL_REBORN_SHARED_DEV_LAUNCHER: "true" },
    stdio: "inherit"
  });
  if (requestedSignal) forwardSignal(requestedSignal);
  const code = await waitForExit(child);
  if (code === lockConflictExitCode) console.error("Shared dev database is already in use by another npm run dev process.");
  process.exitCode = requestedSignal ? 1 : code === lockConflictExitCode ? 1 : code;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Shared local development requires the flock command.", { cause: error });
  throw error;
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
}

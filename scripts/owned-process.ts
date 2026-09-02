import { spawn, type ChildProcess } from "node:child_process";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const EXIT_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 1_000;

type GroupProbe = (pgid: number) => Promise<boolean>;
export type CleanupOptions = {
  cleanupTimeoutMs?: number;
  probeTimeoutMs?: number;
  groupProbe?: GroupProbe;
};

export type OwnedCleanupOptions = {
  child: ChildProcess | undefined;
  primary: unknown;
  label: string;
  stop?: (child: ChildProcess | undefined) => Promise<void>;
  remove: () => Promise<void>;
};

type SignalSource = {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
};

export type OwnedSignalCleanupOptions = {
  /** The owner's memoized cleanup function; it must be safe to await repeatedly. */
  cleanup: () => Promise<void>;
  signalSource?: SignalSource;
  exit?: (code: number) => void;
};

/** Local-test-only cooperative control channel for exercising a real owner process. */
export type OwnerControl = {
  enabled: boolean;
  failBeforeReady: boolean;
  holdCleanup: boolean;
  resourceCreated: (details: { pid: number; pgid: number; persistence: string }) => Promise<void>;
  ready: (details: { pid: number; pgid: number; persistence: string }) => Promise<void>;
  cleanupEntered: () => Promise<void>;
  settled: () => Promise<void>;
  waitForCleanup: () => Promise<void>;
  waitForRelease: () => Promise<void>;
  /** Test-only bounded hold, used after CLEANUP_ENTERED to exercise external fallback cleanup. */
  waitForCleanupHold: () => Promise<void>;
  throwIfFailBeforeReady: () => void;
};

export function createOwnerControl(env = process.env): OwnerControl {
  const directory = env.OWNED_PROCESS_CONTROL_DIR;
  const id = env.OWNED_PROCESS_CONTROL_ID;
  const enabled = Boolean(directory && id);
  // The failure hook is deliberately inert unless the complete test-only control channel is enabled.
  const failBeforeReady = enabled && env.OWNED_PROCESS_FAIL_BEFORE_READY === "1";
  const holdCleanup = enabled && env.OWNED_PROCESS_HOLD_CLEANUP === "1";
  const requestedHoldMs = Number(env.OWNED_PROCESS_CLEANUP_HOLD_TIMEOUT_MS ?? 15_000);
  const cleanupHoldMs = Number.isFinite(requestedHoldMs) ? Math.max(1, Math.min(requestedHoldMs, 30_000)) : 15_000;
  const record = async (state: string, details: Record<string, unknown> = {}) => {
    if (!enabled) return;
    await mkdir(directory!, { recursive: true });
    const payload = JSON.stringify({ state, ...details });
    await writeFile(join(directory!, `${id}.json`), payload, "utf8");
    // Keep the resource record available after rapid failure cleanup advances the live state.
    if (state === "RESOURCE_CREATED") await writeFile(join(directory!, `${id}.resource.json`), payload, "utf8");
    await appendFile(join(directory!, `${id}.events`), `${state}\n`, "utf8");
  };
  const waitFor = async (name: string, timeoutMs?: number) => {
    if (!enabled) return;
    const path = join(directory!, `${id}.${name}`);
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    while (true) {
      try { await access(path); return; } catch { /* wait for the explicit test control */ }
      if (deadline !== undefined && Date.now() >= deadline) return;
      await delay(10);
    }
  };
  return {
    enabled,
    failBeforeReady,
    holdCleanup,
    resourceCreated: (details) => record("RESOURCE_CREATED", details),
    ready: (details) => record("READY", details),
    cleanupEntered: () => record("CLEANUP_ENTERED"),
    settled: () => record("SETTLED"),
    waitForCleanup: () => waitFor("cleanup"),
    waitForRelease: () => waitFor("release"),
    waitForCleanupHold: () => waitFor("cleanup-release", cleanupHoldMs),
    throwIfFailBeforeReady: () => { if (failBeforeReady) throw new Error("injected owner failure before readiness"); },
  };
}

/**
 * Installs persistent SIGINT/SIGTERM listeners around one owner cleanup.
 * A first signal starts cleanup; later signals are deliberately absorbed until it settles.
 */
export function installOwnedSignalCleanup({ cleanup, signalSource = process, exit = (code) => process.exit(code) }: OwnedSignalCleanupOptions) {
  let settled: Promise<void> | undefined;
  let signalExitScheduled = false;
  const remove = () => {
    signalSource.removeListener("SIGINT", onSignal);
    signalSource.removeListener("SIGTERM", onSignal);
  };
  const settle = () => settled ??= Promise.resolve().then(cleanup).finally(remove);
  const onSignal = () => {
    if (signalExitScheduled) return;
    signalExitScheduled = true;
    void settle().then(
      () => exit(1),
      () => exit(1),
    );
  };
  signalSource.on("SIGINT", onSignal);
  signalSource.on("SIGTERM", onSignal);
  return { settled: settle };
}

/** Retains the setup/use failure while making every cleanup failure inspectable. */
export function preservePrimaryFailure(primary: unknown, cleanupErrors: readonly unknown[], label: string): Error | undefined {
  if (!cleanupErrors.length) return primary instanceof Error ? primary : undefined;
  const diagnostics = new Error(`${label} cleanup failed: ${cleanupErrors.map(String).join("; ").slice(0, 2_000)}`);
  if (primary instanceof Error) {
    Object.defineProperty(primary, "cleanupDiagnostics", { value: diagnostics, enumerable: false });
    return primary;
  }
  return diagnostics;
}

/** Always attempts process shutdown and tagged persistence removal, preserving use/setup failure identity. */
export async function cleanupOwnedResources({ child, primary, label, stop = stopOwnedProcess, remove }: OwnedCleanupOptions): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try { await stop(child); } catch (error) { cleanupErrors.push(error); }
  try { await remove(); } catch (error) { cleanupErrors.push(error); }
  const failure = preservePrimaryFailure(primary, cleanupErrors, label);
  if (failure && failure !== primary) throw failure;
}

const waitForExit = (child: ChildProcess, timeout = EXIT_TIMEOUT_MS) => child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve(true)
  : Promise.race([new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))), delay(timeout).then(() => false)]);

const groupHasMembers = async (pgid: number, _timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> => {
  // Signal zero is a direct kernel process-group existence probe: no helper process or pipe can leak.
  try { process.kill(-pgid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const withDeadline = async <T>(operation: Promise<T>, timeoutMs: number) => Promise.race([
  operation,
  delay(timeoutMs).then(() => { throw new Error("process-group verification timed out"); })
]);

export const waitForProcessGroupExit = async (pgid: number, attempts = 20, intervalMs = 100, options: CleanupOptions = {}) => {
  const deadline = Date.now() + (options.cleanupTimeoutMs ?? attempts * intervalMs + PROBE_TIMEOUT_MS);
  const probe = options.groupProbe ?? ((id: number) => groupHasMembers(id, options.probeTimeoutMs));
  for (let attempt = 0; attempt < attempts && Date.now() < deadline; attempt++) {
    const remaining = deadline - Date.now();
    const hasMembers = await withDeadline(probe(pgid), Math.max(1, remaining));
    if (!hasMembers) return true;
    if (attempt + 1 < attempts) await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return false;
};

export async function stopOwnedProcess(child: ChildProcess | undefined, options: CleanupOptions = {}) {
  if (!child?.pid) return;
  const pgid = child.pid;
  const signal = (value: NodeJS.Signals) => { try { process.kill(-pgid, value); } catch { /* group already exited */ } };
  const cleanupTimeout = options.cleanupTimeoutMs ?? EXIT_TIMEOUT_MS;
  signal("SIGTERM"); child.kill("SIGTERM");
  let exited = await waitForExit(child, cleanupTimeout);
  let groupExited = false;
  let verificationError: unknown;
  try { groupExited = await waitForProcessGroupExit(pgid, 20, 100, options); }
  catch (error) { verificationError = error; }

  // A probe failure is itself fail-closed: it never authorizes leaving a live group behind.
  if (verificationError || !exited || !groupExited) {
    signal("SIGKILL"); child.kill("SIGKILL");
    exited = await waitForExit(child, cleanupTimeout);
    try { groupExited = await waitForProcessGroupExit(pgid, 20, 100, options); }
    catch (error) { verificationError ??= error; }
  }
  child.stdout?.destroy(); child.stderr?.destroy();
  if (verificationError) throw new Error("process-group verification failed", { cause: verificationError });
  if (!exited || !groupExited) throw new Error("owned command process group did not exit");
}

/** Runs a detached owned stage and never resolves before its complete process group exits. */
export async function runOwnedProcess(command: string, args: string[], timeoutMs: number, stdio: "inherit" | "pipe" | "ignore" = "inherit", options: CleanupOptions = {}, environment: NodeJS.ProcessEnv = process.env) {
  const child = spawn(command, args, { detached: true, stdio, env: environment });
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let terminating = false;
    const attachCleanupDiagnostic = (primary: Error, cleanupError: unknown) => {
      const diagnostic = new Error(`owned command cleanup failed: ${String(cleanupError).slice(0, 2_000)}`);
      Object.defineProperty(primary, "cleanupDiagnostics", { value: diagnostic, enumerable: false });
      return primary;
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const terminate = (primary: Error) => {
      if (terminating || settled) return;
      // Record the cause before SIGTERM: its resulting exit event must not replace timeout/error identity.
      terminating = true;
      void stopOwnedProcess(child, options).then(
        () => finish(primary),
        (cleanupError) => finish(attachCleanupDiagnostic(primary, cleanupError)),
      );
    };
    const timer = setTimeout(() => terminate(new Error(`${command} timed out`)), timeoutMs);
    child.once("error", (error) => terminate(error));
    child.once("exit", (code, signalName) => {
      if (terminating || settled) return;
      void waitForProcessGroupExit(child.pid!, 20, 100, options).then(
        (clean) => {
          if (code === 0 && clean) return finish();
          const primary = new Error(code === 0
            ? `${command} left descendants`
            : `${command} exited ${code ?? signalName ?? "unknown"}`);
          terminate(primary);
        },
        (error) => terminate(new Error("process-group verification failed", { cause: error })),
      );
    });
  });
}

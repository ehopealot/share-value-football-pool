import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assertRequiredSharedDevVars, assertSharedDevPlatform, ensureSharedDevVars, sharedDevLockPathFor, sharedDevRootPathFor, sharedDevStatePathFor, sharedDevVarsBackupPathFor, worktreeDevConfigPath } from "../scripts/dev-state";
import { assertSharedDevLauncher, persistenceStateFor, workerConfigPathFor } from "../vite.config";

const waitForExit = (child: ChildProcess) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveExit, reject) => {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("exit", (code) => resolveExit({ code, stdout, stderr }));
});

const waitForFile = async (path: string, text: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await readFile(path, "utf8")).includes(text)) return; } catch { /* process has not written it yet */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${text} in ${path}`);
};

const writeExecutable = async (path: string, contents: string) => {
  await writeFile(path, contents);
  await chmod(path, 0o755);
};

describe("Vite Worker configuration", () => {
  it("uses the worktree Worker config while serving development previews", () => {
    expect(workerConfigPathFor({ command: "serve" })).toBe("wrangler.local.jsonc");
  });

  it("uses the explicit isolated production Worker config while building production assets", () => {
    expect(workerConfigPathFor({ command: "build", productionWorkerConfig: "/tmp/isolated/wrangler.jsonc" })).toBe("/tmp/isolated/wrangler.jsonc");
  });

  it("uses the Git-common checkout state for both main and linked worktrees", () => {
    expect(sharedDevStatePathFor("/repo", ".git")).toBe("/repo/.wrangler/state");
    expect(sharedDevStatePathFor("/repo/.worktrees/parlays", "/repo/.git")).toBe("/repo/.wrangler/state");
  });

  it("resolves root-owned state, lock, and secret-backup paths", () => {
    expect(sharedDevRootPathFor("/repo/.worktrees/parlays", "/repo/.git")).toBe("/repo");
    expect(sharedDevLockPathFor("/repo/.worktrees/parlays", "/repo/.git")).toBe("/repo/.wrangler/dev-server.lock");
    expect(sharedDevVarsBackupPathFor("/repo/.worktrees/parlays", "/repo/.dev.vars")).toMatch(/^\/repo\/\.wrangler\/dev-vars-backups\/[a-f0-9]{64}\/\.dev\.vars$/);
    expect(worktreeDevConfigPath("/repo/.worktrees/parlays")).toBe("/repo/.worktrees/parlays/wrangler.local.jsonc");
    expect(() => assertRequiredSharedDevVars({})).toThrow("BETTER_AUTH_SECRET");
    expect(() => assertRequiredSharedDevVars({ BETTER_AUTH_SECRET: "local-secret", POOL_COMMAND_AUTHENTICATOR_KEY: "local-command-key" })).not.toThrow();
  });

  it("launches the root-owned lock, reports a conflict, and forwards termination signals", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "office-pool-dev-launcher-"));
    const fakeBin = join(sandbox, "bin");
    const logPath = join(sandbox, "flock.log");
    const lockDirectory = join(sandbox, "lock");
    const intLogPath = join(sandbox, "flock-int.log");
    const root = resolve(import.meta.dirname, "..");
    const launcher = resolve(root, "node_modules/.bin/tsx");
    try {
      await mkdir(fakeBin, { recursive: true });
      await writeExecutable(join(fakeBin, "flock"), `#!/bin/sh
printf '%s\\n' "$@" >> "$FAKE_FLOCK_LOG"
printf 'pid:%s\\n' "$$" >> "$FAKE_FLOCK_LOG"
if [ "$FAKE_FLOCK_MODE" = "hold" ]; then
  if ! mkdir "$FAKE_FLOCK_LOCK" 2>/dev/null; then exit 75; fi
  printf 'ready\\n' >> "$FAKE_FLOCK_LOG"
  trap 'printf "SIGINT\\n" >> "$FAKE_FLOCK_LOG"; rmdir "$FAKE_FLOCK_LOCK"; exit 0' INT
  trap 'printf "SIGTERM\\n" >> "$FAKE_FLOCK_LOG"; rmdir "$FAKE_FLOCK_LOCK"; exit 0' TERM
  while true; do sleep 1; done
fi
exit 0
`);
      const environment = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_FLOCK_LOG: logPath, FAKE_FLOCK_LOCK: lockDirectory };
      const argvRun = spawn(launcher, ["scripts/dev.ts", "--port", "5178"], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
      await expect(waitForExit(argvRun)).resolves.toMatchObject({ code: 0 });
      const argv = (await readFile(logPath, "utf8")).trim().split("\n").slice(0, 8);
      expect(argv.slice(0, 3)).toEqual(["--nonblock", "--no-fork", "--conflict-exit-code=75"]);
      expect(argv[3]).toMatch(/\.wrangler\/dev-server\.lock$/);
      expect(argv[4]).toBe(resolve(root, "scripts/run-dev-with-lock.sh"));
      expect(argv[5]).toMatch(/\.wrangler\/state$/);
      expect(argv.slice(6)).toEqual(["--port", "5178"]);

      const holding = spawn(launcher, ["scripts/dev.ts"], { cwd: root, env: { ...environment, FAKE_FLOCK_MODE: "hold" }, stdio: ["ignore", "pipe", "pipe"] });
      await waitForFile(logPath, "ready");
      const conflicting = spawn(launcher, ["scripts/dev.ts"], { cwd: root, env: { ...environment, FAKE_FLOCK_MODE: "hold" }, stdio: ["ignore", "pipe", "pipe"] });
      await expect(waitForExit(conflicting)).resolves.toMatchObject({ code: 1, stderr: expect.stringContaining("already in use") });
      process.kill(holding.pid!, "SIGTERM");
      await expect(waitForExit(holding)).resolves.toMatchObject({ code: 1 });
      await waitForFile(logPath, "SIGTERM");

      const interrupted = spawn(launcher, ["scripts/dev.ts"], { cwd: root, env: { ...environment, FAKE_FLOCK_MODE: "hold", FAKE_FLOCK_LOG: intLogPath, FAKE_FLOCK_LOCK: join(sandbox, "int-lock") }, stdio: ["ignore", "pipe", "pipe"] });
      await waitForFile(intLogPath, "ready");
      process.kill(interrupted.pid!, "SIGINT");
      await expect(waitForExit(interrupted)).resolves.toMatchObject({ code: 1 });
      await waitForFile(intLogPath, "SIGINT");
    } finally {
      for (const path of [logPath, intLogPath]) {
        try {
          for (const line of (await readFile(path, "utf8")).split("\n")) {
            const pid = Number(line.slice("pid:".length));
            if (line.startsWith("pid:") && Number.isInteger(pid)) {
              try { process.kill(-pid, "SIGTERM"); } catch { /* process already exited */ }
            }
          }
        } catch { /* no fake flock process was launched */ }
      }
      await rm(sandbox, { recursive: true, force: true });
    }
  }, 20_000);

  it("uses the canonical state root only while serving", () => {
    expect(persistenceStateFor("serve", "/repo/.wrangler/state")).toEqual({ path: "/repo/.wrangler/state" });
    expect(persistenceStateFor("build", "/repo/.wrangler/state")).toBeUndefined();
  });

  it("rejects direct development Vite servers that would bypass the shared lock", () => {
    expect(() => assertSharedDevLauncher({ command: "serve", environment: {} })).toThrow("npm run dev");
    expect(() => assertSharedDevLauncher({ command: "serve", environment: { OFFICE_POOL_REBORN_SHARED_DEV_LAUNCHER: "true" } })).not.toThrow();
    expect(() => assertSharedDevLauncher({ command: "serve", environment: { VITEST: "true" } })).not.toThrow();
    expect(() => assertSharedDevLauncher({ command: "build", environment: {} })).not.toThrow();
  });

  it("links each worktree to the canonical local secret file without discarding its prior file", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "office-pool-dev-vars-"));
    const root = join(sandbox, "root");
    const worktree = join(root, ".worktrees", "parlays");
    const canonicalDevVarsPath = join(root, ".dev.vars");
    const worktreeDevVarsPath = join(worktree, ".dev.vars");
    try {
      await mkdir(worktree, { recursive: true });
      await writeFile(canonicalDevVarsPath, "BETTER_AUTH_SECRET=canonical\n");
      await writeFile(worktreeDevVarsPath, "BETTER_AUTH_SECRET=worktree\n");
      expect(await ensureSharedDevVars(worktree, canonicalDevVarsPath)).toBe(sharedDevVarsBackupPathFor(worktree, canonicalDevVarsPath));
      expect((await lstat(worktreeDevVarsPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(worktreeDevVarsPath)).toBe(canonicalDevVarsPath);
      expect(await readFile(sharedDevVarsBackupPathFor(worktree, canonicalDevVarsPath), "utf8")).toBe("BETTER_AUTH_SECRET=worktree\n");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("does not create a link cycle when canonical secrets already resolve to a worktree file", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "office-pool-dev-vars-"));
    const root = join(sandbox, "root");
    const worktree = join(root, ".worktrees", "parlays");
    const canonicalDevVarsPath = join(root, ".dev.vars");
    const worktreeDevVarsPath = join(worktree, ".dev.vars");
    try {
      await mkdir(worktree, { recursive: true });
      await writeFile(worktreeDevVarsPath, "BETTER_AUTH_SECRET=worktree\n");
      await symlink(worktreeDevVarsPath, canonicalDevVarsPath);
      expect(await ensureSharedDevVars(worktree, canonicalDevVarsPath)).toBeUndefined();
      expect(await readlink(canonicalDevVarsPath)).toBe(worktreeDevVarsPath);
      expect(await readFile(worktreeDevVarsPath, "utf8")).toBe("BETTER_AUTH_SECRET=worktree\n");
      expect(existsSync(sharedDevVarsBackupPathFor(worktree, canonicalDevVarsPath))).toBe(false);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("repairs a broken worktree secret symlink while preserving its original target", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "office-pool-dev-vars-"));
    const root = join(sandbox, "root");
    const worktree = join(root, ".worktrees", "parlays");
    const canonicalDevVarsPath = join(root, ".dev.vars");
    const worktreeDevVarsPath = join(worktree, ".dev.vars");
    const missingTarget = join(sandbox, "missing-dev-vars");
    try {
      await mkdir(worktree, { recursive: true });
      await writeFile(canonicalDevVarsPath, "BETTER_AUTH_SECRET=canonical\n");
      await symlink(missingTarget, worktreeDevVarsPath);
      expect(await ensureSharedDevVars(worktree, canonicalDevVarsPath)).toBe(sharedDevVarsBackupPathFor(worktree, canonicalDevVarsPath));
      expect(await readlink(worktreeDevVarsPath)).toBe(canonicalDevVarsPath);
      expect((await lstat(sharedDevVarsBackupPathFor(worktree, canonicalDevVarsPath))).isSymbolicLink()).toBe(true);
      expect(await readlink(sharedDevVarsBackupPathFor(worktree, canonicalDevVarsPath))).toBe(missingTarget);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite either local secret file when a backup already exists", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "office-pool-dev-vars-"));
    const root = join(sandbox, "root");
    const worktree = join(root, ".worktrees", "parlays");
    const canonicalDevVarsPath = join(root, ".dev.vars");
    const worktreeDevVarsPath = join(worktree, ".dev.vars");
    try {
      await mkdir(worktree, { recursive: true });
      await writeFile(canonicalDevVarsPath, "BETTER_AUTH_SECRET=canonical\n");
      await writeFile(worktreeDevVarsPath, "BETTER_AUTH_SECRET=current\n");
      const backupPath = sharedDevVarsBackupPathFor(worktree, canonicalDevVarsPath);
      await mkdir(dirname(backupPath), { recursive: true });
      await writeFile(backupPath, "BETTER_AUTH_SECRET=backup\n");
      await expect(ensureSharedDevVars(worktree, canonicalDevVarsPath)).rejects.toThrow("preserved local config already exists");
      expect(await readFile(worktreeDevVarsPath, "utf8")).toBe("BETTER_AUTH_SECRET=current\n");
      expect(await readFile(backupPath, "utf8")).toBe("BETTER_AUTH_SECRET=backup\n");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });


  it("rejects non-Linux shared-dev launches", () => {
    expect(() => assertSharedDevPlatform("darwin")).toThrow("Linux");
    expect(() => assertSharedDevPlatform("linux")).not.toThrow();
  });


  it("runs preparation and shared-state migrations before Vite", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "office-pool-dev-runner-"));
    const stateDirectory = join(sandbox, "state");
    const logPath = join(sandbox, "runner.log");
    const root = resolve(import.meta.dirname, "..");
    const runner = join(sandbox, "scripts/run-dev-with-lock.sh");
    const fakeExecutable = (name: string) => `#!/bin/sh
printf '${name}' >> "$FAKE_RUNNER_LOG"
for argument in "$@"; do printf '|%s' "$argument" >> "$FAKE_RUNNER_LOG"; done
printf '\\n' >> "$FAKE_RUNNER_LOG"
`;
    try {
      await mkdir(join(sandbox, "scripts"), { recursive: true });
      await mkdir(join(sandbox, "node_modules/.bin"), { recursive: true });
      await writeFile(runner, await readFile(resolve(root, "scripts/run-dev-with-lock.sh"), "utf8"));
      await chmod(runner, 0o755);
      await writeExecutable(join(sandbox, "node_modules/.bin/tsx"), fakeExecutable("tsx"));
      await writeExecutable(join(sandbox, "node_modules/.bin/wrangler"), fakeExecutable("wrangler"));
      await writeExecutable(join(sandbox, "node_modules/.bin/vite"), fakeExecutable("vite"));
      const run = spawn("bash", [runner, stateDirectory, "--host", "127.0.0.1"], { cwd: sandbox, env: { ...process.env, FAKE_RUNNER_LOG: logPath }, stdio: ["ignore", "pipe", "pipe"] });
      await expect(waitForExit(run)).resolves.toMatchObject({ code: 0 });
      expect((await readFile(logPath, "utf8")).trim().split("\n")).toEqual([
        `tsx|${join(sandbox, "scripts/prepare-dev.ts")}`,
        `wrangler|d1|migrations|apply|DB|--config|${join(sandbox, "wrangler.local.jsonc")}|--local|--persist-to|${stateDirectory}`,
        "vite|--host|127.0.0.1"
      ]);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("uses the dev launcher instead of a worktree-local predev migration", () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.dev).toBe("tsx scripts/dev.ts");
    expect(packageJson.scripts.predev).toBeUndefined();
  });
});

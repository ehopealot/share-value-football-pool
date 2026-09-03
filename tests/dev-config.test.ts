import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import * as devState from "../scripts/dev-state";
import { sharedDevStatePathFor } from "../scripts/dev-state";
import * as viteConfiguration from "../vite.config";
import { persistenceStateFor, workerConfigPathFor } from "../vite.config";

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
    const helpers = devState as { sharedDevRootPathFor?: (cwd: string, commonGitDirectory: string) => string; sharedDevLockPathFor?: (cwd: string, commonGitDirectory: string) => string; sharedDevVarsBackupPathFor?: (worktreeDirectory: string, canonicalDevVarsPath: string) => string; worktreeDevConfigPath?: (cwd: string) => string; assertRequiredSharedDevVars?: (vars: Record<string, string | undefined>) => void };
    const rootPathFor = helpers.sharedDevRootPathFor;
    const lockPathFor = helpers.sharedDevLockPathFor;
    const backupPathFor = helpers.sharedDevVarsBackupPathFor;
    const worktreeConfigPath = helpers.worktreeDevConfigPath;
    const assertRequiredVars = helpers.assertRequiredSharedDevVars;
    expect(rootPathFor).toBeTypeOf("function");
    expect(lockPathFor).toBeTypeOf("function");
    expect(backupPathFor).toBeTypeOf("function");
    expect(worktreeConfigPath).toBeTypeOf("function");
    expect(assertRequiredVars).toBeTypeOf("function");
    if (!rootPathFor || !lockPathFor || !backupPathFor || !worktreeConfigPath || !assertRequiredVars) return;
    expect(rootPathFor("/repo/.worktrees/parlays", "/repo/.git")).toBe("/repo");
    expect(lockPathFor("/repo/.worktrees/parlays", "/repo/.git")).toBe("/repo/.wrangler/dev-server.lock");
    expect(backupPathFor("/repo/.worktrees/parlays", "/repo/.dev.vars")).toMatch(/^\/repo\/\.wrangler\/dev-vars-backups\/[a-f0-9]{64}\/\.dev\.vars$/);
    expect(worktreeConfigPath("/repo/.worktrees/parlays")).toBe("/repo/.worktrees/parlays/wrangler.local.jsonc");
    expect(() => assertRequiredVars({})).toThrow("BETTER_AUTH_SECRET");
    expect(() => assertRequiredVars({ BETTER_AUTH_SECRET: "local-secret", POOL_COMMAND_AUTHENTICATOR_KEY: "local-command-key" })).not.toThrow();
  });

  it("keeps a root-owned shared lock with Vite and forwards repeated termination signals", () => {
    const launcher = resolve(import.meta.dirname, "../scripts/dev.ts");
    const runner = resolve(import.meta.dirname, "../scripts/run-dev-with-lock.sh");
    const prepare = resolve(import.meta.dirname, "../scripts/prepare-dev.ts");
    expect(existsSync(launcher)).toBe(true);
    expect(existsSync(runner)).toBe(true);
    expect(existsSync(prepare)).toBe(true);
    if (!existsSync(launcher) || !existsSync(runner) || !existsSync(prepare)) return;
    const launcherSource = readFileSync(launcher, "utf8");
    const runnerSource = readFileSync(runner, "utf8");
    expect(launcherSource).toContain('spawn("flock"');
    expect(launcherSource).toContain('"--no-fork"');
    expect(launcherSource).toContain('"--conflict-exit-code=75"');
    expect(launcherSource).toContain("sharedDevLockPath");
    expect(launcherSource).toContain("detached: true");
    expect(launcherSource).toContain("process.kill(-child.pid, signal)");
    expect(launcherSource).toContain('process.on("SIGINT", onSigint)');
    expect(launcherSource).toContain('process.on("SIGTERM", onSigterm)');
    expect(runnerSource).toContain('scripts/prepare-dev.ts');
    expect(runnerSource.indexOf('scripts/prepare-dev.ts')).toBeLessThan(runnerSource.indexOf('d1 migrations apply DB'));
    expect(runnerSource).toContain('exec "$project_directory/node_modules/.bin/vite" "$@"');
  });

  it("uses the canonical state root only while serving", () => {
    expect(persistenceStateFor("serve", "/repo/.wrangler/state")).toEqual({ path: "/repo/.wrangler/state" });
    expect(persistenceStateFor("build", "/repo/.wrangler/state")).toBeUndefined();
  });

  it("rejects direct development Vite servers that would bypass the shared lock", () => {
    const assertSharedDevLauncher = (viteConfiguration as { assertSharedDevLauncher?: (input: { command: string; mode: string; environment: Record<string, string | undefined> }) => void }).assertSharedDevLauncher;
    expect(assertSharedDevLauncher).toBeTypeOf("function");
    if (!assertSharedDevLauncher) return;
    expect(() => assertSharedDevLauncher({ command: "serve", mode: "development", environment: {} })).toThrow("npm run dev");
    expect(() => assertSharedDevLauncher({ command: "serve", mode: "development", environment: { OFFICE_POOL_REBORN_SHARED_DEV_LAUNCHER: "true" } })).not.toThrow();
    expect(() => assertSharedDevLauncher({ command: "serve", mode: "test", environment: {} })).toThrow("npm run dev");
    expect(() => assertSharedDevLauncher({ command: "serve", mode: "test", environment: { VITEST: "true" } })).not.toThrow();
    expect(() => assertSharedDevLauncher({ command: "build", mode: "production", environment: {} })).not.toThrow();
  });

  it("links each worktree to the canonical local secret file without discarding its prior file", async () => {
    const helpers = devState as { ensureSharedDevVars?: (worktreeDirectory: string, canonicalDevVarsPath: string) => Promise<string | undefined>; sharedDevVarsBackupPathFor?: (worktreeDirectory: string, canonicalDevVarsPath: string) => string };
    const ensureSharedDevVars = helpers.ensureSharedDevVars;
    const backupPathFor = helpers.sharedDevVarsBackupPathFor;
    expect(ensureSharedDevVars).toBeTypeOf("function");
    expect(backupPathFor).toBeTypeOf("function");
    if (!ensureSharedDevVars || !backupPathFor) return;
    const sandbox = await mkdtemp(join(tmpdir(), "office-pool-dev-vars-"));
    const root = join(sandbox, "root");
    const worktree = join(root, ".worktrees", "parlays");
    const canonicalDevVarsPath = join(root, ".dev.vars");
    const worktreeDevVarsPath = join(worktree, ".dev.vars");
    try {
      await mkdir(worktree, { recursive: true });
      await writeFile(canonicalDevVarsPath, "BETTER_AUTH_SECRET=canonical\n");
      await writeFile(worktreeDevVarsPath, "BETTER_AUTH_SECRET=worktree\n");
      expect(await ensureSharedDevVars(worktree, canonicalDevVarsPath)).toBe(backupPathFor(worktree, canonicalDevVarsPath));
      expect((await lstat(worktreeDevVarsPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(worktreeDevVarsPath)).toBe(canonicalDevVarsPath);
      expect(await readFile(backupPathFor(worktree, canonicalDevVarsPath), "utf8")).toBe("BETTER_AUTH_SECRET=worktree\n");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("does not create a link cycle when canonical secrets already resolve to a worktree file", async () => {
    const helpers = devState as { ensureSharedDevVars?: (worktreeDirectory: string, canonicalDevVarsPath: string) => Promise<string | undefined>; sharedDevVarsBackupPathFor?: (worktreeDirectory: string, canonicalDevVarsPath: string) => string };
    const ensureSharedDevVars = helpers.ensureSharedDevVars;
    const backupPathFor = helpers.sharedDevVarsBackupPathFor;
    expect(ensureSharedDevVars).toBeTypeOf("function");
    expect(backupPathFor).toBeTypeOf("function");
    if (!ensureSharedDevVars || !backupPathFor) return;
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
      expect(existsSync(backupPathFor(worktree, canonicalDevVarsPath))).toBe(false);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("repairs a broken worktree secret symlink while preserving its original target", async () => {
    const helpers = devState as { ensureSharedDevVars?: (worktreeDirectory: string, canonicalDevVarsPath: string) => Promise<string | undefined>; sharedDevVarsBackupPathFor?: (worktreeDirectory: string, canonicalDevVarsPath: string) => string };
    const ensureSharedDevVars = helpers.ensureSharedDevVars;
    const backupPathFor = helpers.sharedDevVarsBackupPathFor;
    expect(ensureSharedDevVars).toBeTypeOf("function");
    expect(backupPathFor).toBeTypeOf("function");
    if (!ensureSharedDevVars || !backupPathFor) return;
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
      expect(await ensureSharedDevVars(worktree, canonicalDevVarsPath)).toBe(backupPathFor(worktree, canonicalDevVarsPath));
      expect(await readlink(worktreeDevVarsPath)).toBe(canonicalDevVarsPath);
      expect((await lstat(backupPathFor(worktree, canonicalDevVarsPath))).isSymbolicLink()).toBe(true);
      expect(await readlink(backupPathFor(worktree, canonicalDevVarsPath))).toBe(missingTarget);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite either local secret file when a backup already exists", async () => {
    const helpers = devState as { ensureSharedDevVars?: (worktreeDirectory: string, canonicalDevVarsPath: string) => Promise<string | undefined>; sharedDevVarsBackupPathFor?: (worktreeDirectory: string, canonicalDevVarsPath: string) => string };
    const ensureSharedDevVars = helpers.ensureSharedDevVars;
    const backupPathFor = helpers.sharedDevVarsBackupPathFor;
    expect(ensureSharedDevVars).toBeTypeOf("function");
    expect(backupPathFor).toBeTypeOf("function");
    if (!ensureSharedDevVars || !backupPathFor) return;
    const sandbox = await mkdtemp(join(tmpdir(), "office-pool-dev-vars-"));
    const root = join(sandbox, "root");
    const worktree = join(root, ".worktrees", "parlays");
    const canonicalDevVarsPath = join(root, ".dev.vars");
    const worktreeDevVarsPath = join(worktree, ".dev.vars");
    try {
      await mkdir(worktree, { recursive: true });
      await writeFile(canonicalDevVarsPath, "BETTER_AUTH_SECRET=canonical\n");
      await writeFile(worktreeDevVarsPath, "BETTER_AUTH_SECRET=current\n");
      const backupPath = backupPathFor(worktree, canonicalDevVarsPath);
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
    const assertSharedDevPlatform = (devState as { assertSharedDevPlatform?: (platform: NodeJS.Platform) => void }).assertSharedDevPlatform;
    expect(assertSharedDevPlatform).toBeTypeOf("function");
    if (!assertSharedDevPlatform) return;
    expect(() => assertSharedDevPlatform("darwin")).toThrow("Linux");
    expect(() => assertSharedDevPlatform("linux")).not.toThrow();
  });

  it("keeps the Vite config compatible with its native loader", () => {
    const configSource = readFileSync(resolve(import.meta.dirname, "../vite.config.ts"), "utf8");
    const tsconfig = JSON.parse(readFileSync(resolve(import.meta.dirname, "../tsconfig.json"), "utf8")) as { compilerOptions: Record<string, unknown> };
    expect(configSource).toContain('from "./scripts/dev-state.ts"');
    expect(tsconfig.compilerOptions.allowImportingTsExtensions).toBe(true);
  });

  it("runs migrations against the shared state before starting Vite", () => {
    const launcher = resolve(import.meta.dirname, "../scripts/dev.ts");
    const runner = resolve(import.meta.dirname, "../scripts/run-dev-with-lock.sh");
    const prepare = resolve(import.meta.dirname, "../scripts/prepare-dev.ts");
    expect(existsSync(launcher)).toBe(true);
    expect(existsSync(runner)).toBe(true);
    expect(existsSync(prepare)).toBe(true);
    if (!existsSync(launcher) || !existsSync(runner) || !existsSync(prepare)) return;
    const launcherSource = readFileSync(launcher, "utf8");
    const runnerSource = readFileSync(runner, "utf8");
    const prepareSource = readFileSync(prepare, "utf8");
    expect(launcherSource).toContain("sharedDevStatePath");
    expect(launcherSource).toContain("run-dev-with-lock.sh");
    expect(runnerSource).toContain('"$project_directory/node_modules/.bin/tsx" "$project_directory/scripts/prepare-dev.ts"');
    expect(runnerSource).toContain('"$project_directory/node_modules/.bin/wrangler" d1 migrations apply DB --config "$project_directory/wrangler.local.jsonc" --local --persist-to "$state_directory"');
    expect(prepareSource).toContain("ensureSharedDevVars");
    expect(prepareSource).toContain("worktreeDevConfigPath");
  });

  it("uses the dev launcher instead of a worktree-local predev migration", () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.dev).toBe("tsx scripts/dev.ts");
    expect(packageJson.scripts.predev).toBeUndefined();
  });
});

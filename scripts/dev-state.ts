import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const REQUIRED_SHARED_DEV_VARS = ["BETTER_AUTH_SECRET", "POOL_COMMAND_AUTHENTICATOR_KEY"] as const;

export const sharedDevRootPathFor = (cwd: string, commonGitDirectory: string) =>
  resolve(cwd, commonGitDirectory, "..");

export const sharedDevStatePathFor = (cwd: string, commonGitDirectory: string) =>
  join(sharedDevRootPathFor(cwd, commonGitDirectory), ".wrangler", "state");

export const sharedDevLockPathFor = (cwd: string, commonGitDirectory: string) =>
  join(sharedDevRootPathFor(cwd, commonGitDirectory), ".wrangler", "dev-server.lock");

const commonGitDirectoryFor = (cwd: string) =>
  execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();

export const sharedDevRootPath = (cwd = process.cwd()) =>
  sharedDevRootPathFor(cwd, commonGitDirectoryFor(cwd));

export const sharedDevStatePath = (cwd = process.cwd()) =>
  join(sharedDevRootPath(cwd), ".wrangler", "state");

export const sharedDevLockPath = (cwd = process.cwd()) =>
  join(sharedDevRootPath(cwd), ".wrangler", "dev-server.lock");

export const sharedDevVarsPath = (cwd = process.cwd()) =>
  join(sharedDevRootPath(cwd), ".dev.vars");

export const worktreeDevConfigPath = (cwd = process.cwd()) =>
  resolve(cwd, "wrangler.local.jsonc");

export const sharedDevVarsBackupPathFor = (worktreeDirectory: string, canonicalDevVarsPath: string) => {
  const worktreeId = createHash("sha256").update(resolve(worktreeDirectory)).digest("hex");
  return join(dirname(resolve(canonicalDevVarsPath)), ".wrangler", "dev-vars-backups", worktreeId, ".dev.vars");
};

const entryFor = async (path: string) => {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export const ensureSharedDevVars = async (worktreeDirectory: string, canonicalDevVarsPath: string): Promise<string | undefined> => {
  const worktreeDevVarsPath = join(worktreeDirectory, ".dev.vars");
  const canonicalPath = resolve(canonicalDevVarsPath);
  let canonicalTarget: string;
  try { canonicalTarget = await realpath(canonicalPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Canonical local config is missing: ${canonicalPath}`);
    throw error;
  }
  if (resolve(worktreeDevVarsPath) === canonicalPath) return undefined;

  const current = await entryFor(worktreeDevVarsPath);
  let brokenLinkTarget: string | undefined;
  if (current) {
    try {
      if (await realpath(worktreeDevVarsPath) === canonicalTarget) return undefined;
    } catch (error) {
      if (!current.isSymbolicLink() || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      brokenLinkTarget = await readlink(worktreeDevVarsPath);
    }
  }
  if (!current) {
    await symlink(canonicalPath, worktreeDevVarsPath);
    return undefined;
  }

  const backupPath = sharedDevVarsBackupPathFor(worktreeDirectory, canonicalPath);
  await mkdir(dirname(backupPath), { recursive: true });
  if (brokenLinkTarget) {
    try {
      await symlink(brokenLinkTarget, backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Cannot replace ${worktreeDevVarsPath}: preserved local config already exists at ${backupPath}.`);
      throw error;
    }
    try {
      await unlink(worktreeDevVarsPath);
    } catch (error) {
      await unlink(backupPath).catch(() => undefined);
      throw error;
    }
    try {
      await symlink(canonicalPath, worktreeDevVarsPath);
    } catch (error) {
      try {
        await symlink(brokenLinkTarget, worktreeDevVarsPath);
      } catch (restoreError) {
        throw new Error(`Failed to link ${worktreeDevVarsPath} to canonical local config and could not restore it.`, { cause: restoreError });
      }
      throw error;
    }
    return backupPath;
  }

  try {
    await copyFile(worktreeDevVarsPath, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Cannot replace ${worktreeDevVarsPath}: preserved local config already exists at ${backupPath}.`);
    throw error;
  }
  try {
    await unlink(worktreeDevVarsPath);
  } catch (error) {
    await unlink(backupPath).catch(() => undefined);
    throw error;
  }
  try {
    await symlink(canonicalPath, worktreeDevVarsPath);
  } catch (error) {
    try {
      await copyFile(backupPath, worktreeDevVarsPath, constants.COPYFILE_EXCL);
    } catch (restoreError) {
      throw new Error(`Failed to link ${worktreeDevVarsPath} to canonical local config and could not restore it.`, { cause: restoreError });
    }
    throw error;
  }
  return backupPath;
};

export const assertRequiredSharedDevVars = (vars: Record<string, string | undefined>) => {
  const missing = REQUIRED_SHARED_DEV_VARS.filter((name) => !vars[name]?.trim());
  if (missing.length) throw new Error(`Shared local config is missing ${missing.join(", ")}. Add them to the canonical .dev.vars file.`);
};

export const assertSharedDevPlatform = (platform: NodeJS.Platform = process.platform) => {
  if (platform !== "linux") throw new Error("Shared local development requires Linux and the util-linux flock command.");
};

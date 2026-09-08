import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { cloudflareCredentialNames, workerSecretNames } from "../scripts/cloudflare-credentials.mjs";

const root = resolve(import.meta.dirname, "..");
type ProductionBuildEnvironment = (environment: NodeJS.ProcessEnv, workerConfigPath?: string) => NodeJS.ProcessEnv;
type SpawnSync = (...args: unknown[]) => { status: number; error?: Error };
type IsolatedWorkerConfig = { configPath: string; dispose(): void };
const buildModule = await import(pathToFileURL(resolve(root, "scripts/build-production.mjs")).href);
const viteModule = await import(pathToFileURL(resolve(root, "vite.config.ts")).href);
const viteConfig = viteModule.default;
const viteEnvDir = (viteModule as { viteEnvDir?: (e2eBuild: boolean, productionBuild: boolean) => string | false | undefined }).viteEnvDir;
const productionBuildEnvironment = (buildModule as { productionBuildEnvironment?: ProductionBuildEnvironment }).productionBuildEnvironment;
const createIsolatedProductionWorkerConfig = (buildModule as { createIsolatedProductionWorkerConfig?: (projectRoot: string) => IsolatedWorkerConfig }).createIsolatedProductionWorkerConfig;
const buildProduction = (buildModule as { buildProduction?: (options: { environment: NodeJS.ProcessEnv; spawnSync: SpawnSync }) => void }).buildProduction;
const localProductionBuildEnvironment = (buildModule as { localProductionBuildEnvironment?: (cwd: string, environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv }).localProductionBuildEnvironment;

describe("isolated production build", () => {
  it("requires the public Turnstile key and excludes Worker secrets from the build environment", () => {
    expect(productionBuildEnvironment).toEqual(expect.any(Function));
    expect(() => productionBuildEnvironment!({})).toThrow("VITE_TURNSTILE_SITE_KEY is required");
    for (const invalid of ["not-a-turnstile-key", "0xtoo short", "0x4AAAAAAEjUfp2Ub4CBu-E_'", "%VITE_TURNSTILE_SITE_KEY%"])
      expect(() => productionBuildEnvironment!({ VITE_TURNSTILE_SITE_KEY: invalid })).toThrow("VITE_TURNSTILE_SITE_KEY is invalid");

    const sensitiveNames = [...workerSecretNames, ...cloudflareCredentialNames];
    const environment = productionBuildEnvironment!({
      PATH: process.env.PATH,
      VITE_TURNSTILE_SITE_KEY: " 0x4AAAAAAEjUfp2Ub4CBu-E_ ",
      VITE_SENTRY_DSN: "https://public@sentry.invalid/1",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
      ...Object.fromEntries(sensitiveNames.map((name) => [name, `test-only-${name}`]))
    });

    expect(environment).toMatchObject({
      VITE_TURNSTILE_SITE_KEY: "0x4AAAAAAEjUfp2Ub4CBu-E_",
      VITE_SENTRY_DSN: "https://public@sentry.invalid/1",
      OFFICE_POOL_REBORN_PRODUCTION_BUILD: "true",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false"
    });
    for (const name of sensitiveNames) expect(environment[name], name).toBeUndefined();
  });

  it("loads only the public Turnstile key from ignored .env.production.local when the shell has none", () => {
    expect(localProductionBuildEnvironment).toEqual(expect.any(Function));
    const cwd = mkdtempSync(resolve(tmpdir(), "office-pool-production-env-"));
    try {
      writeFileSync(resolve(cwd, ".env.production.local"), "IGNORED_VALUE=nope\nVITE_TURNSTILE_SITE_KEY='0x4AAAAAAEjUfp2Ub4CBu-E_'\n");
      const fileEnvironment = localProductionBuildEnvironment!(cwd, { PATH: "test" });
      expect(fileEnvironment).toMatchObject({ PATH: "test", VITE_TURNSTILE_SITE_KEY: "0x4AAAAAAEjUfp2Ub4CBu-E_" });
      expect(fileEnvironment.IGNORED_VALUE).toBeUndefined();
      expect(localProductionBuildEnvironment!(cwd, { VITE_TURNSTILE_SITE_KEY: "0x4AAAAAAEjUfp2Ub4CBu-E_" })).toMatchObject({ VITE_TURNSTILE_SITE_KEY: "0x4AAAAAAEjUfp2Ub4CBu-E_" });
      writeFileSync(resolve(cwd, ".env.production.local"), "VITE_TURNSTILE_SITE_KEY=invalid-file-value\n");
      expect(() => productionBuildEnvironment!(localProductionBuildEnvironment!(cwd, {}))).toThrow("VITE_TURNSTILE_SITE_KEY is invalid");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("uses a clean temporary Worker config instead of the repository-local development environment", () => {
    expect(createIsolatedProductionWorkerConfig).toEqual(expect.any(Function));
    const isolated = createIsolatedProductionWorkerConfig!(root);
    try {
      expect(isolated.configPath.startsWith(root)).toBe(false);
      expect(existsSync(resolve(isolated.configPath, "..", ".dev.vars"))).toBe(false);
      const config = JSON.parse(readFileSync(isolated.configPath, "utf8")) as { main: string; assets: { directory: string }; d1_databases: Array<{ migrations_dir: string }>; version_metadata?: { binding: string } };
      expect(config.main).toBe(resolve(root, "src/index.ts"));
      expect(config.assets.directory).toBe(resolve(root, "dist/client"));
      expect(config.d1_databases[0]?.migrations_dir).toBe(resolve(root, "src/db/migrations"));
      expect(config.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
      const environment = productionBuildEnvironment!({ VITE_TURNSTILE_SITE_KEY: "0x4AAAAAAEjUfp2Ub4CBu-E_", VITE_UNRELATED_SECRET: "must-not-reach-vite" }, isolated.configPath);
      expect(environment.OFFICE_POOL_REBORN_WORKER_CONFIG).toBe(isolated.configPath);
      expect(environment.VITE_UNRELATED_SECRET).toBeUndefined();
    } finally {
      isolated.dispose();
    }
  });

  it("rejects symbolic links instead of omitting them from production artifact verification", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "office-pool-production-artifact-link-"));
    const production = resolve(fixture, "production");
    try {
      mkdirSync(production);
      const target = resolve(fixture, "operator.env");
      writeFileSync(target, "SECRET=must-not-be-skipped\n");
      symlinkSync(target, resolve(production, ".env.production"));
      const result = spawnSync(process.execPath, [resolve(root, "scripts/verify-production-artifact.mjs")], {
        cwd: root,
        env: { ...process.env, PRODUCTION_ARTIFACT_DIR: production, LOCAL_ARTIFACT_DIR: resolve(fixture, "local") },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unsupported symbolic link");
      expect(result.stderr).toContain(".env.production");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("emits source maps for native Workers diagnostic symbolication", () => {
    const config = viteConfig({ command: "build", mode: "production", isSsrBuild: false, isPreview: false });
    expect(config.build).toMatchObject({ minify: false, sourcemap: true });
  });

  it("disables root dotenv discovery for guarded production and E2E builds", () => {
    expect(viteEnvDir).toEqual(expect.any(Function));
    expect(viteEnvDir!(false, true)).toBe(false);
    expect(viteEnvDir!(true, false)).toBe(false);
    expect(viteEnvDir!(false, false)).toBeUndefined();
  });

  it("launches the Vite package bin through its installed filesystem path", () => {
    expect(buildProduction).toEqual(expect.any(Function));
    const spawnSync: SpawnSync = vi.fn(() => ({ status: 0 }));

    expect(() => buildProduction!({ environment: { VITE_TURNSTILE_SITE_KEY: "0x4AAAAAAEjUfp2Ub4CBu-E_" }, spawnSync })).not.toThrow();
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/node_modules[/\\]vite[/\\]bin[/\\]vite\.js$/), "build"],
      expect.objectContaining({ stdio: "inherit", env: expect.objectContaining({ VITE_TURNSTILE_SITE_KEY: "0x4AAAAAAEjUfp2Ub4CBu-E_" }) })
    );
  });
});

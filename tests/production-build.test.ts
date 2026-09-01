import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const root = resolve(import.meta.dirname, "..");
type ProductionBuildEnvironment = (environment: NodeJS.ProcessEnv, workerConfigPath?: string) => NodeJS.ProcessEnv;
type SpawnSync = (...args: unknown[]) => { status: number; error?: Error };
type IsolatedWorkerConfig = { configPath: string; dispose(): void };
const buildModule = await import(pathToFileURL(resolve(root, "scripts/build-production.mjs")).href).catch(() => ({}));
const viteConfig = (await import(pathToFileURL(resolve(root, "vite.config.ts")).href)).default;
const productionBuildEnvironment = (buildModule as { productionBuildEnvironment?: ProductionBuildEnvironment }).productionBuildEnvironment;
const createIsolatedProductionWorkerConfig = (buildModule as { createIsolatedProductionWorkerConfig?: (projectRoot: string) => IsolatedWorkerConfig }).createIsolatedProductionWorkerConfig;
const buildProduction = (buildModule as { buildProduction?: (options: { environment: NodeJS.ProcessEnv; spawnSync: SpawnSync }) => void }).buildProduction;

describe("isolated production build", () => {
  it("requires the public Turnstile key and excludes Worker secrets from the build environment", () => {
    expect(productionBuildEnvironment).toEqual(expect.any(Function));
    expect(() => productionBuildEnvironment!({})).toThrow("VITE_TURNSTILE_SITE_KEY is required");

    const environment = productionBuildEnvironment!({
      PATH: process.env.PATH,
      VITE_TURNSTILE_SITE_KEY: " public-turnstile-site-key ",
      BETTER_AUTH_SECRET: "test-only-auth-secret",
      RESEND_API_KEY: "test-only-resend-key"
    });

    expect(environment).toMatchObject({
      VITE_TURNSTILE_SITE_KEY: "public-turnstile-site-key",
      OFFICE_POOL_REBORN_PRODUCTION_BUILD: "true",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false"
    });
    expect(environment.BETTER_AUTH_SECRET).toBeUndefined();
    expect(environment.RESEND_API_KEY).toBeUndefined();
  });

  it("uses a clean temporary Worker config instead of the repository-local development environment", () => {
    expect(createIsolatedProductionWorkerConfig).toEqual(expect.any(Function));
    const isolated = createIsolatedProductionWorkerConfig!(root);
    try {
      expect(isolated.configPath.startsWith(root)).toBe(false);
      expect(existsSync(resolve(isolated.configPath, "..", ".dev.vars"))).toBe(false);
      const config = JSON.parse(readFileSync(isolated.configPath, "utf8")) as { main: string; assets: { directory: string }; d1_databases: Array<{ migrations_dir: string }> };
      expect(config.main).toBe(resolve(root, "src/index.ts"));
      expect(config.assets.directory).toBe(resolve(root, "dist/client"));
      expect(config.d1_databases[0]?.migrations_dir).toBe(resolve(root, "src/db/migrations"));
      const environment = productionBuildEnvironment!({ VITE_TURNSTILE_SITE_KEY: "public-turnstile-site-key", VITE_UNRELATED_SECRET: "must-not-reach-vite" }, isolated.configPath);
      expect(environment.OFFICE_POOL_REBORN_WORKER_CONFIG).toBe(isolated.configPath);
      expect(environment.VITE_UNRELATED_SECRET).toBeUndefined();
    } finally {
      isolated.dispose();
    }
  });

  it("emits source maps for native Workers diagnostic symbolication", () => {
    const config = viteConfig({ command: "build", mode: "production", isSsrBuild: false, isPreview: false });
    expect(config.build).toMatchObject({ minify: false, sourcemap: true });
  });

  it("launches the Vite package bin through its installed filesystem path", () => {
    expect(buildProduction).toEqual(expect.any(Function));
    const spawnSync: SpawnSync = vi.fn(() => ({ status: 0 }));

    expect(() => buildProduction!({ environment: { VITE_TURNSTILE_SITE_KEY: "public-turnstile-site-key" }, spawnSync })).not.toThrow();
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/node_modules[/\\]vite[/\\]bin[/\\]vite\.js$/), "build"],
      expect.objectContaining({ stdio: "inherit", env: expect.objectContaining({ VITE_TURNSTILE_SITE_KEY: "public-turnstile-site-key" }) })
    );
  });
});

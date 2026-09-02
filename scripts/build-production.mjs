import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const turnstileSiteKey = /^0x[A-Za-z0-9_-]{20,128}$/;
const workerSecretNames = [
  "BACKUP_ENCRYPTION_KEY",
  "BETTER_AUTH_SECRET",
  "ODDS_API_KEY",
  "POOL_BACKUP_SERVICE_TOKEN",
  "POOL_COMMAND_AUTHENTICATOR_KEY",
  "POOL_PROJECTION_SERVICE_TOKEN",
  "RESEND_API_KEY",
  "SETTLEMENT_SERVICE_TOKEN",
  "TURNSTILE_SECRET_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY"
];

/** Produces a config with no adjacent local environment file for the production Vite Worker build. */
export function createIsolatedProductionWorkerConfig(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  const directory = mkdtempSync(join(tmpdir(), "office-pool-reborn-production-worker-config-"));
  config.$schema = join(root, "node_modules/wrangler/config-schema.json");
  config.main = resolve(root, config.main);
  if (config.assets?.directory) config.assets.directory = resolve(root, config.assets.directory);
  for (const database of config.d1_databases ?? []) if (database.migrations_dir) database.migrations_dir = resolve(root, database.migrations_dir);
  const configPath = join(directory, "wrangler.jsonc");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return { configPath, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Reads only the public browser key from an ignored operator-local production env file. */
export function localProductionBuildEnvironment(cwd = process.cwd(), environment = process.env) {
  if (environment.VITE_TURNSTILE_SITE_KEY?.trim()) return environment;
  const path = join(cwd, ".env.production.local");
  if (!existsSync(path)) return environment;
  const entry = readFileSync(path, "utf8").match(/^\s*VITE_TURNSTILE_SITE_KEY\s*=\s*(.*?)\s*$/m)?.[1];
  const siteKey = entry?.replace(/^(['"])(.*)\1$/, "$2").trim();
  return siteKey ? { ...environment, VITE_TURNSTILE_SITE_KEY: siteKey } : environment;
}

/** Prepares a Vite environment that contains only the public browser key. */
export function productionBuildEnvironment(environment = process.env, workerConfigPath) {
  const siteKey = environment.VITE_TURNSTILE_SITE_KEY?.trim();
  if (!siteKey) throw new Error("VITE_TURNSTILE_SITE_KEY is required for a production build");
  if (!turnstileSiteKey.test(siteKey)) throw new Error("VITE_TURNSTILE_SITE_KEY is invalid for a production build");
  const result = {
    ...environment,
    VITE_TURNSTILE_SITE_KEY: siteKey,
    OFFICE_POOL_REBORN_PRODUCTION_BUILD: "true",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    ...(workerConfigPath ? { OFFICE_POOL_REBORN_WORKER_CONFIG: workerConfigPath } : {})
  };
  for (const name of Object.keys(result)) if (name.startsWith("VITE_") && name !== "VITE_TURNSTILE_SITE_KEY") delete result[name];
  for (const name of workerSecretNames) delete result[name];
  return result;
}

export function buildProduction(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const environment = localProductionBuildEnvironment(cwd, options.environment ?? process.env);
  const isolated = createIsolatedProductionWorkerConfig(cwd);
  try {
    const viteBin = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
    const result = (options.spawnSync ?? spawnSync)(process.execPath, [viteBin, "build"], {
      cwd,
      env: productionBuildEnvironment(environment, isolated.configPath),
      stdio: "inherit"
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`production build exited ${result.status ?? "unknown"}`);
  } finally {
    isolated.dispose();
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) buildProduction();

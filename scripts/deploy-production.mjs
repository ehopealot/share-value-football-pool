import { spawnSync as nativeSpawnSync } from "node:child_process";
import { resolve } from "node:path";
import { buildProduction as nativeBuildProduction } from "./build-production.mjs";
import { nonPublishingCloudflareEnvironment, withoutCloudflareCredentials, withoutWorkerSecrets } from "./cloudflare-credentials.mjs";
import { isDirectExecution } from "./direct-entry.mjs";

const run = (spawnSync, command, args, options) => {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? "unknown"}`);
};

/** The only supported production deployment path: build, verify, then publish. */
export function deployProduction(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  const spawnSync = options.spawnSync ?? nativeSpawnSync;
  const buildProduction = options.buildProduction ?? nativeBuildProduction;
  const wrangler = resolve(cwd, "node_modules", ".bin", "wrangler");

  const buildEnvironment = nonPublishingCloudflareEnvironment(environment);
  const deployEnvironment = {
    ...withoutWorkerSecrets(withoutCloudflareCredentials(environment, environment.CI === "true")),
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  };

  buildProduction({ cwd, environment: buildEnvironment });
  run(spawnSync, wrangler, ["deploy", "--dry-run", "--outdir", "dist-local", "--config", "wrangler.local.jsonc"], { cwd, env: buildEnvironment });
  run(spawnSync, process.execPath, [resolve(cwd, "scripts", "verify-production-artifact.mjs")], { cwd, env: buildEnvironment });
  run(spawnSync, wrangler, ["deploy", "--keep-vars", "--config", "dist/office_pool_reborn/wrangler.json"], { cwd, env: deployEnvironment });
}

if (isDirectExecution(import.meta.url)) deployProduction();

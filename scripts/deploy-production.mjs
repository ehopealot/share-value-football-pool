import { spawnSync as nativeSpawnSync } from "node:child_process";
import { resolve } from "node:path";
import { buildProduction as nativeBuildProduction } from "./build-production.mjs";

const cloudflareCredentialNames = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "CLOUDFLARE_EMAIL", "CF_EMAIL", "CLOUDFLARE_API_USER_SERVICE_KEY"];
const ciWranglerCredentialNames = new Set(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);

const cloudflareCredentialEnvironment = (environment, preserveCiWranglerCredentials = false) => {
  const clean = { ...environment };
  for (const name of cloudflareCredentialNames) if (!preserveCiWranglerCredentials || !ciWranglerCredentialNames.has(name)) delete clean[name];
  return clean;
};

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

  const buildEnvironment = cloudflareCredentialEnvironment(environment);
  const deployEnvironment = cloudflareCredentialEnvironment(environment, environment.CI === "true");

  buildProduction({ cwd, environment: buildEnvironment });
  run(spawnSync, wrangler, ["deploy", "--dry-run", "--outdir", "dist-local", "--config", "wrangler.local.jsonc"], { cwd, env: buildEnvironment });
  run(spawnSync, process.execPath, [resolve(cwd, "scripts", "verify-production-artifact.mjs")], { cwd, env: buildEnvironment });
  run(spawnSync, wrangler, ["deploy", "--keep-vars", "--config", "dist/office_pool_reborn/wrangler.json"], { cwd, env: deployEnvironment });
}

if (process.argv[1] === new URL(import.meta.url).pathname) deployProduction();

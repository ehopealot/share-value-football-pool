import { resolve } from "node:path";

const workerSecretNames = [
  "BACKUP_ENCRYPTION_KEY", "BETTER_AUTH_SECRET", "ODDS_API_KEY", "POOL_BACKUP_SERVICE_TOKEN",
  "POOL_COMMAND_AUTHENTICATOR_KEY", "POOL_PROJECTION_SERVICE_TOKEN", "RESEND_API_KEY",
  "SETTLEMENT_SERVICE_TOKEN", "TURNSTILE_SECRET_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY"
];

/** Produces a loopback-safe child environment without dotenv or unrelated browser inputs. */
export const localE2eClientBuildEnvironment = (environment: NodeJS.ProcessEnv, cwd = process.cwd()): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {
    ...environment,
    VITE_TURNSTILE_SITE_KEY: "%VITE_TURNSTILE_SITE_KEY%",
    OFFICE_POOL_REBORN_E2E_BUILD: "true",
    OFFICE_POOL_REBORN_WORKER_CONFIG: resolve(cwd, "tests/fixtures/wrangler.test.jsonc"),
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false"
  };
  for (const name of Object.keys(result)) if (name.startsWith("VITE_") && name !== "VITE_TURNSTILE_SITE_KEY") delete result[name];
  for (const name of workerSecretNames) delete result[name];
  return result;
};

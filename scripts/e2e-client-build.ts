import { resolve } from "node:path";
import { nonPublishingCloudflareEnvironment } from "./cloudflare-credentials.mjs";

/** Produces a loopback-safe child environment without dotenv or unrelated browser inputs. */
export const localE2eClientBuildEnvironment = (environment: NodeJS.ProcessEnv, cwd = process.cwd()): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {
    ...nonPublishingCloudflareEnvironment(environment),
    VITE_TURNSTILE_SITE_KEY: "%VITE_TURNSTILE_SITE_KEY%",
    OFFICE_POOL_REBORN_E2E_BUILD: "true",
    OFFICE_POOL_REBORN_WORKER_CONFIG: resolve(cwd, "tests/fixtures/wrangler.test.jsonc"),
  };
  for (const name of Object.keys(result)) if (name.startsWith("VITE_") && name !== "VITE_TURNSTILE_SITE_KEY") delete result[name];
  return result;
};

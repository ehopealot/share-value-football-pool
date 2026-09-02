import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Guarded deploy and loopback test builds receive all public inputs explicitly. */
export const viteEnvDir = (e2eBuild: boolean, productionBuild: boolean): string | false | undefined => e2eBuild || productionBuild ? false : undefined;

export function workerConfigPathFor(input: { command: string; productionWorkerConfig?: string }): string | undefined {
  return input.productionWorkerConfig ?? (input.command === "serve" ? "wrangler.local.jsonc" : undefined);
}

export default defineConfig(({ command }) => {
  const e2eBuild = process.env.OFFICE_POOL_REBORN_E2E_BUILD === "true";
  const productionBuild = process.env.OFFICE_POOL_REBORN_PRODUCTION_BUILD === "true";
  const productionWorkerConfig = process.env.OFFICE_POOL_REBORN_WORKER_CONFIG;
  if (productionBuild && !productionWorkerConfig) throw new Error("OFFICE_POOL_REBORN_WORKER_CONFIG is required for a production build");
  const workerConfigPath = workerConfigPathFor({ command, productionWorkerConfig });
  return {
    // E2E builds use an explicit loopback-safe process environment rather than root dotenv files.
    envDir: viteEnvDir(e2eBuild, productionBuild),
    // Build output is deployable, so never serialize ignored local Worker secrets into it.
    plugins: [react(), cloudflare({ ...(workerConfigPath ? { configPath: workerConfigPath } : {}), ...(command === "build" ? { config: { secrets: { required: [] } } } : {}) })],
    build: {
      minify: false,
      sourcemap: true
    }
  };
});

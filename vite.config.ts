import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export function workerConfigPathFor(input: { command: string; productionWorkerConfig?: string }): string | undefined {
  return input.productionWorkerConfig ?? (input.command === "serve" ? "wrangler.local.jsonc" : undefined);
}

export default defineConfig(({ command }) => {
  const productionWorkerConfig = process.env.OFFICE_POOL_REBORN_WORKER_CONFIG;
  if (process.env.OFFICE_POOL_REBORN_PRODUCTION_BUILD === "true" && !productionWorkerConfig) throw new Error("OFFICE_POOL_REBORN_WORKER_CONFIG is required for a production build");
  const workerConfigPath = workerConfigPathFor({ command, productionWorkerConfig });
  return {
    // Build output is deployable, so never serialize ignored local Worker secrets into it.
    plugins: [react(), cloudflare({ ...(workerConfigPath ? { configPath: workerConfigPath } : {}), ...(command === "build" ? { config: { secrets: { required: [] } } } : {}) })],
    build: {
      minify: false,
      sourcemap: true
    }
  };
});

import { readFileSync } from "node:fs";
const production = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
const local = JSON.parse(readFileSync("wrangler.local.jsonc", "utf8"));
const normalizedAssets = (config) => ({ ...config.assets, run_worker_first: Array.isArray(config.assets.run_worker_first) ? config.assets.run_worker_first.filter((route) => route !== "/__local-test/*") : config.assets.run_worker_first });
const normalizedD1Databases = (config) => config.d1_databases?.map(({ database_id, ...database }) => database);
for (const key of ["compatibility_date", "compatibility_flags", "durable_objects", "migrations", "r2_buckets", "queues", "triggers"]) {
  if (JSON.stringify(production[key]) !== JSON.stringify(local[key])) throw new Error(`Wrangler parity mismatch: ${key}`);
}
if (JSON.stringify(normalizedD1Databases(production)) !== JSON.stringify(normalizedD1Databases(local))) throw new Error("Wrangler parity mismatch: d1_databases");
if (JSON.stringify(normalizedAssets(production)) !== JSON.stringify(normalizedAssets(local))) throw new Error("Wrangler parity mismatch: assets");
if (production.main === local.main || !local.main.endsWith("index.local.ts")) throw new Error("local entry is not independently selected");
console.log("Wrangler production/local parity verified");

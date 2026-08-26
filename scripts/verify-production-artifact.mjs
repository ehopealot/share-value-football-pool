import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const productionRoot = process.env.PRODUCTION_ARTIFACT_DIR ?? "dist/share_value_football_pool";
const localRoot = process.env.LOCAL_ARTIFACT_DIR ?? "dist-local";
const forbidden = ["DevelopmentMailbox", "development-mailbox", "test-controls", "LOCAL_TEST_CONTROLS", "__local-test", "x-local-test-user", "local-pool-do", "local-app", "ALLOW_INSECURE_LOCAL_AUTH"];

function requireFiles(root) {
  if (!existsSync(root)) throw new Error(`required artifact directory is missing: ${root}`);
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...requireFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
function graph(root) {
  return requireFiles(root).map((file) => {
    const normalizedPath = relative(root, file).replaceAll("\\", "/");
    return `${normalizedPath}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  }).sort();
}
const productionFiles = requireFiles(productionRoot);
const localFiles = requireFiles(localRoot);
if (!productionFiles.some((file) => file.endsWith("wrangler.json")) || !productionFiles.some((file) => file.endsWith(".js"))) throw new Error("production Worker manifest/bundle is missing");
if (!localFiles.some((file) => file.endsWith(".js"))) throw new Error("local Worker bundle is missing");
for (const file of productionFiles) {
  if (!/\.(?:js|json|map|html)$/.test(file) || statSync(file).size > 10 * 1024 * 1024) continue;
  const text = readFileSync(file, "utf8");
  for (const token of forbidden) if (text.includes(token)) throw new Error(`production artifact contains forbidden ${token}: ${file}`);
}
const productionGraph = graph(productionRoot);
const localGraph = graph(localRoot);
if (productionGraph.length === localGraph.length && productionGraph.every((entry, index) => entry === localGraph[index])) throw new Error("production and local generated artifact graphs are identical");
console.log(`Verified production Worker manifest and normalized path/content-hash graph (${productionGraph.length} production, ${localGraph.length} local files)`);

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const mapsBelow = (root) => {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`source-map tree contains symbolic link: ${path}`);
    if (entry.isDirectory()) return mapsBelow(path);
    return entry.isFile() && path.endsWith(".map") ? [realpathSync(path)] : [];
  });
};

const generatedRoots = (manifestPath) => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest.assets?.directory !== "string") throw new Error("generated Worker manifest is missing assets.directory");
  const artifactRoot = realpathSync(dirname(manifestPath));
  const configuredClientRoot = resolve(artifactRoot, manifest.assets.directory);
  const configuredRootStat = lstatSync(configuredClientRoot);
  const permittedClientPath = resolve(artifactRoot, "../client");
  if (configuredRootStat.isSymbolicLink() || lstatSync(permittedClientPath).isSymbolicLink()) throw new Error("generated Worker manifest client output root must not be a symbolic link");
  const clientRoot = realpathSync(configuredClientRoot);
  const permittedClientRoot = realpathSync(permittedClientPath);
  if (clientRoot !== permittedClientRoot) throw new Error("generated Worker manifest assets.directory is outside permitted client output");
  if (clientRoot === artifactRoot || relative(artifactRoot, clientRoot).split("/").every((part) => part && part !== "..")) throw new Error("generated Worker manifest overlaps Worker and client output");
  return { artifactRoot, clientRoot };
};

/** Returns only maps beneath the generated public client output, never the Worker artifact. */
export function browserSourceMaps(manifestPath) {
  const { clientRoot } = generatedRoots(manifestPath);
  return mapsBelow(clientRoot);
}

/** Browser maps are not deployable assets; Worker maps remain for Wrangler upload_source_maps. */
export function removeBrowserSourceMaps(manifestPath) {
  for (const path of browserSourceMaps(manifestPath)) rmSync(path, { force: true });
}

export function workerSourceMaps(artifactRoot, manifestPath) {
  const roots = generatedRoots(manifestPath);
  if (realpathSync(artifactRoot) !== roots.artifactRoot) throw new Error("artifact root does not match generated Worker manifest");
  const clientMaps = new Set(browserSourceMaps(manifestPath));
  return mapsBelow(roots.artifactRoot).filter((path) => !clientMaps.has(path));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  removeBrowserSourceMaps(process.argv[2] ?? "dist/office_pool_reborn/wrangler.json");
}

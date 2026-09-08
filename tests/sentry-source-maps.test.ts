import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browserSourceMaps, removeBrowserSourceMaps, workerSourceMaps } from "../scripts/sentry-source-maps.mjs";

describe("Sentry browser source-map cleanup", () => {
  it("removes only generated public client maps and preserves Worker maps", () => {
    const root = mkdtempSync(join(tmpdir(), "sentry-maps-"));
    try {
      const artifact = join(root, "artifact");
      const client = join(root, "client", "assets");
      mkdirSync(artifact, { recursive: true });
      mkdirSync(client, { recursive: true });
      const manifest = join(artifact, "wrangler.json");
      const clientMap = join(client, "index.js.map");
      const workerMap = join(artifact, "index.js.map");
      writeFileSync(manifest, JSON.stringify({ assets: { directory: "../client" }, upload_source_maps: true, version_metadata: { binding: "CF_VERSION_METADATA" } }));
      writeFileSync(clientMap, "client");
      writeFileSync(workerMap, "worker");

      expect(browserSourceMaps(manifest)).toEqual([clientMap]);
      expect(workerSourceMaps(artifact, manifest)).toEqual([workerMap]);
      removeBrowserSourceMaps(manifest);
      expect(existsSync(clientMap)).toBe(false);
      expect(existsSync(workerMap)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked client root before following it", () => {
    const root = mkdtempSync(join(tmpdir(), "sentry-maps-symlink-"));
    try {
      const artifact = join(root, "artifact"); const outside = join(root, "outside");
      mkdirSync(artifact, { recursive: true }); mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "outside.js.map"), "outside");
      symlinkSync(outside, join(root, "client"));
      const manifest = join(artifact, "wrangler.json");
      writeFileSync(manifest, JSON.stringify({ assets: { directory: "../client" } }));
      expect(() => browserSourceMaps(manifest)).toThrow(/symbolic link/);
      expect(existsSync(join(outside, "outside.js.map"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

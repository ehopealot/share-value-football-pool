import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe("package version pins", () => {
  it("uses exact versions for every direct dependency", () => {
    const entries = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies });

    expect(entries).not.toHaveLength(0);
    for (const [name, version] of entries) {
      expect(version, `${name} must use an exact version, not a range`).toMatch(exactVersion);
    }
  });
});

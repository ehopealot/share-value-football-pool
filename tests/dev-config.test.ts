import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { workerConfigPathFor } from "../vite.config";

describe("Vite Worker configuration", () => {
  it("uses the local Worker entrypoint while serving development previews", () => {
    expect(workerConfigPathFor({ command: "serve" })).toBe("wrangler.local.jsonc");
  });

  it("uses the explicit isolated production Worker config while building production assets", () => {
    expect(workerConfigPathFor({ command: "build", productionWorkerConfig: "/tmp/isolated/wrangler.jsonc" })).toBe("/tmp/isolated/wrangler.jsonc");
  });

  it("applies pending local D1 migrations before starting the dev server", () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.predev).toBe("wrangler d1 migrations apply DB --local --config wrangler.local.jsonc");
  });
});
